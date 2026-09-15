#!/usr/bin/env python3
"""메소 알러지 쌀숭이 로컬 서버.

정적 파일을 서빙하면서 /nexon/ 으로 들어온 요청을 넥슨 Open API 로 대신 보낸다.
브라우저가 직접 open.api.nexon.com 을 부르면 사전 요청에서 막히기 때문에
같은 출처인 이 서버가 중계한다.

    python3 serve.py           # 8000 포트
    python3 serve.py 5500      # 포트 지정
"""
import http.server
import socketserver
import sys
import urllib.error
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
UPSTREAM = "https://open.api.nexon.com"
PREFIX = "/nexon"


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith(PREFIX + "/"):
            return self.proxy()
        return super().do_GET()

    def end_headers(self):
        # 파일을 바꿔도 브라우저가 옛 버전을 계속 보여주는 일을 막는다
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "x-nxopen-api-key, content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")

    def proxy(self):
        url = UPSTREAM + self.path[len(PREFIX):]
        key = self.headers.get("x-nxopen-api-key", "")
        req = urllib.request.Request(url, headers={
            "x-nxopen-api-key": key,
            "Accept": "application/json",
            "User-Agent": "ssalsungi-local/1.0",
        })
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                body, status = r.read(), r.status
        except urllib.error.HTTPError as e:
            body, status = e.read(), e.code
        except Exception as e:
            body = ('{"error":{"name":"PROXY_ERROR","message":"%s"}}'
                    % str(e).replace('"', "'")).encode()
            status = 502
        masked = (key[:8] + "…") if key else "없음"
        print(f"  프록시 {status}  {url}  키:{masked}")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("", PORT), Handler) as httpd:
        print(f"메소 알러지 쌀숭이 실행 중")
        print(f"  http://localhost:{PORT}/meso-allergy-ssalsungi.html")
        print(f"  넥슨 API 중계: /nexon/... -> {UPSTREAM}/...")
        print("  종료하려면 Ctrl+C")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n종료했습니다.")
