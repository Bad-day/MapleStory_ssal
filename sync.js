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

  /* 공유 링크 처리: https://.../index.html#e=<암호화된 값>
     링크에는 토큰이 암호화되어 들어 있고, 암호는 링크와 따로 전달받아 처음 한 번만 입력한다.
     풀린 닉네임/토큰은 이 브라우저에만 저장하고 주소창에서는 지운 뒤 새로 고친다. */
  function b64uToBytes(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    return Uint8Array.from(atob(str), function (c) { return c.charCodeAt(0); });
  }
  async function decryptLink(blob, pass) {
    var raw = b64uToBytes(blob);
    var salt = raw.slice(0, 16), iv = raw.slice(16, 28), data = raw.slice(28);
    var base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
    var key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt, iterations: 200000, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    var plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, data);
    return JSON.parse(new TextDecoder().decode(plain));
  }
  (function applyLink() {
    var blob;
    try { blob = new URLSearchParams(location.hash.replace(/^#/, "")).get("e"); } catch (e) {}
    if (!blob) return;
    var pass = prompt("공유 링크의 암호를 입력해주세요.");
    if (!pass) return;
    decryptLink(blob, pass).then(function (v) {
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
      alert("암호가 틀렸거나 링크가 올바르지 않습니다. 링크를 다시 열어 암호를 확인해주세요.");
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
  };
  window.SsalSync = SsalSync;
})();
