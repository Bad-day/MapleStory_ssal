/* 기록 동기화
   일자별 기록(snapshots)과 경험치 기록(exp)을 GitHub 데이터 저장소의 data/<닉네임>.json 에 보관한다.
   - 읽기: 토큰 없이도 가능 (공개 저장소)
   - 쓰기: 설정에 넣은 GitHub 토큰이 있을 때만 (이 기기에만 저장)
   토큰이나 닉네임이 없으면 아무 일도 하지 않고 기존처럼 이 기기에만 저장된다. */
(function () {
  var REPO = "Bad-day/MapleStory_ssal_data";
  var BRANCH = "main";
  var K_SNAP = "ssalsungi:snapshots";
  var K_EXP = "ssalsungi:exp";
  var K_SET = "ssalsungi:settings";
  var K_TOKEN = "ssalsungi:ghtoken";
  var PUSH_DELAY = 1500;

  var pullPromise = null;
  var pushTimer = null;
  var pushing = Promise.resolve();

  function ls(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) {}
  }
  function parse(k) {
    try { return JSON.parse(ls(k)) || []; } catch (e) { return []; }
  }
  function name() {
    try { return String((JSON.parse(ls(K_SET)) || {}).charName || "").trim(); } catch (e) { return ""; }
  }
  function token() { return (ls(K_TOKEN) || "").trim(); }
  function syncedKey(n) { return "ssalsungi:synced:" + n; }

  function status(msg, bad) {
    SsalSync.lastStatus = msg;
    var el = document.getElementById("gh-st");
    if (el) { el.textContent = msg; el.style.color = bad ? "#c0392b" : ""; }
  }

  function api(path, opts) {
    opts = opts || {};
    var h = { Accept: "application/vnd.github+json" };
    var t = token();
    if (t) h.Authorization = "Bearer " + t;
    if (opts.body) h["Content-Type"] = "application/json";
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 10000);
    return fetch("https://api.github.com/repos/" + REPO + "/contents/" + path, {
      method: opts.method || "GET", headers: h, body: opts.body, signal: ctl.signal,
    }).finally(function () { clearTimeout(timer); });
  }

  function filePath(n) { return "data/" + encodeURIComponent(n) + ".json"; }

  function decode(b64) {
    var bin = atob(b64.replace(/\s/g, ""));
    var bytes = Uint8Array.from(bin, function (c) { return c.charCodeAt(0); });
    return new TextDecoder().decode(bytes);
  }
  function encode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = "";
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  /* 원격 파일을 읽어 {data, sha} 로 돌려준다. 파일이 없으면 data=null */
  async function fetchRemote(n) {
    var res = await api(filePath(n) + "?ref=" + BRANCH + "&t=" + Date.now());
    if (res.status === 404) return { data: null, sha: null };
    if (!res.ok) throw new Error("GitHub 읽기 실패 (" + res.status + ")");
    var j = await res.json();
    return { data: JSON.parse(decode(j.content)), sha: j.sha };
  }

  /* 같은 날짜는 나중에 저장한 쪽(ts)이 이긴다 */
  function unionByDate(a, b) {
    var map = {};
    (a || []).concat(b || []).forEach(function (r) {
      var cur = map[r.date];
      if (!cur || (r.ts || 0) >= (cur.ts || 0)) map[r.date] = r;
    });
    return Object.keys(map).sort().map(function (d) { return map[d]; });
  }

  async function doPull() {
    var n = name();
    if (!n) return;
    try {
      status("기록 불러오는 중…");
      var r = await fetchRemote(n);
      if (!r.data) { status("저장된 기록이 없습니다. 저장하면 새로 만들어집니다."); return; }
      var firstTime = ls(syncedKey(n)) !== "1";
      var snaps = firstTime ? unionByDate(parse(K_SNAP), r.data.snapshots) : (r.data.snapshots || []);
      var exp = firstTime ? unionByDate(parse(K_EXP), r.data.exp) : (r.data.exp || []);
      lsSet(K_SNAP, JSON.stringify(snaps));
      lsSet(K_EXP, JSON.stringify(exp));
      lsSet(syncedKey(n), "1");
      status("불러옴 · 일자 " + snaps.length + "건 / 경험치 " + exp.length + "건");
      if (firstTime && token()) schedulePush();
    } catch (e) {
      status("불러오기 실패: " + e.message + " (이 기기의 기록을 사용합니다)", true);
    }
  }

  async function doPush() {
    var n = name();
    if (!n || !token()) return;
    try {
      status("저장 중…");
      var body = JSON.stringify({
        v: 1, name: n, updated: new Date().toISOString(),
        snapshots: parse(K_SNAP), exp: parse(K_EXP),
      }, null, 1);
      for (var attempt = 0; attempt < 2; attempt++) {
        var cur = await fetchRemote(n);
        var res = await api(filePath(n), {
          method: "PUT",
          body: JSON.stringify({
            message: "기록 갱신: " + n, content: encode(body), branch: BRANCH,
            sha: cur.sha || undefined,
          }),
        });
        if (res.ok) { lsSet(syncedKey(n), "1"); status("저장됨 · " + new Date().toLocaleTimeString()); return; }
        if (res.status !== 409 && res.status !== 422) {
          if (res.status === 401 || res.status === 403 || res.status === 404)
            throw new Error("토큰이 없거나 권한이 부족합니다 (" + res.status + ")");
          throw new Error("GitHub 쓰기 실패 (" + res.status + ")");
        }
      }
      throw new Error("다른 기기와 동시에 저장해 충돌했습니다. 다시 시도해주세요.");
    } catch (e) {
      status("저장 실패: " + e.message, true);
    }
  }

  function schedulePush() {
    if (!name() || !token()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      pushing = pushing.then(doPush);
    }, PUSH_DELAY);
  }

  /* 공유 링크: https://.../index.html#k=<압축 후 암호화한 값>
     {n:닉네임, t:토큰} 을 deflate 로 압축하고 AES-GCM 으로 암호화해 붙인다.
     암호 입력은 없다. 키가 이 파일 안에 있어 링크가 눈에 안 읽히게 가릴 뿐,
     코드를 보는 사람까지 막는 보안은 아니므로 링크를 받은 사람만 보도록 전달해야 한다. */
  var LINK_SECRET = "ssalsungi-share-link-v1";

  function bytesToB64u(u8) {
    var bin = "";
    u8.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64uToBytes(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    return Uint8Array.from(atob(str), function (c) { return c.charCodeAt(0); });
  }
  async function linkKey(usage) {
    var h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(LINK_SECRET));
    return crypto.subtle.importKey("raw", h, "AES-GCM", false, [usage]);
  }
  async function pipe(bytes, stream) {
    var out = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(out).arrayBuffer());
  }
  async function encodeLink(obj) {
    var packed = await pipe(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream("deflate-raw"));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var enc = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, await linkKey("encrypt"), packed));
    var all = new Uint8Array(12 + enc.length);
    all.set(iv, 0); all.set(enc, 12);
    return bytesToB64u(all);
  }
  async function decodeLink(blob) {
    var raw = b64uToBytes(blob);
    var plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.slice(0, 12) }, await linkKey("decrypt"), raw.slice(12)));
    var json = await pipe(plain, new DecompressionStream("deflate-raw"));
    return JSON.parse(new TextDecoder().decode(json));
  }
  (function applyLink() {
    var blob;
    try { blob = new URLSearchParams(location.hash.replace(/^#/, "")).get("k"); } catch (e) {}
    if (!blob) return;
    decodeLink(blob).then(function (v) {
      if (v.t) lsSet(K_TOKEN, String(v.t).trim());
      if (v.n) {
        var cur = {};
        try { cur = JSON.parse(ls(K_SET)) || {}; } catch (e) {}
        cur.charName = String(v.n).trim();
        lsSet(K_SET, JSON.stringify(cur));
      }
      history.replaceState(null, "", location.pathname + location.search);
      location.reload();
    }).catch(function () {
      alert("공유 링크가 올바르지 않습니다. 링크가 잘렸는지 확인해주세요.");
    });
  })();

  var SsalSync = {
    lastStatus: "",
    /* 첫 호출 때 한 번만 원격에서 당겨온다 */
    pull: function () {
      if (!pullPromise) pullPromise = doPull();
      return pullPromise;
    },
    /* 기록이 바뀌었을 때 호출 */
    changed: function () { schedulePush(); },
    /* 설정의 '기록 불러오기' 버튼: 다시 당겨온 뒤 화면을 새로 읽는다 */
    reload: async function () {
      pullPromise = null;
      await SsalSync.pull();
      location.reload();
    },
    setToken: function (t) { lsSet(K_TOKEN, String(t || "").trim()); },
    getToken: token,
    repo: REPO,
    encodeLink: encodeLink,
  };
  window.SsalSync = SsalSync;
})();
