"""Exercise the real HTTP runtime and action capture using an explicitly mock model."""

from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def main() -> None:
    root = Path(__file__).resolve().parents[3]
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    token = secrets.token_urlsafe(32)
    env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "SYSTEMROOT") if key in os.environ}
    env.update(
        ELIZA_BENCH_DISABLE_DOTENV="1",
        ELIZA_BENCH_SKIP_CORE_PLUGINS="true",
        ELIZA_BENCH_MOCK="true",
        ELIZA_BENCH_SKIP_EMBEDDING="1",
        ELIZA_BENCH_ALLOW_STUB_EMBEDDING="1",
        ELIZA_BENCH_TOKEN=token,
        ELIZA_BENCH_PORT=str(port),
        ELIZA_BENCH_HOST="127.0.0.1",
        PGLITE_DATA_DIR="memory://",
        LOG_LEVEL="warn",
    )

    def request(path: str, payload: dict | None = None, authenticated: bool = True) -> dict:
        headers = {"Content-Type": "application/json"}
        if authenticated:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/benchmark/{path}",
            data=json.dumps(payload).encode() if payload is not None else None,
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=90) as response:
            return json.load(response)

    with tempfile.TemporaryFile(mode="w+") as log:
        server = subprocess.Popen(
            ["bun", "--conditions=eliza-source", "--conditions=development",
             "packages/benchmarks/suites/lifeops-bench/runner/src/server.ts"],
            cwd=root, env=env, stdout=log, stderr=log,
        )
        try:
            deadline = time.monotonic() + 90
            while True:
                if server.poll() is not None:
                    raise RuntimeError("Benchmark HTTP server exited before readiness")
                try:
                    health = request("health")
                    break
                except urllib.error.URLError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Benchmark HTTP server did not become ready")
                    time.sleep(0.25)
            assert health["mock"] and health["standIn"] and not health["releaseEvidence"]
            payload = {"text": "Execute CLICK(10,10).", "context": {
                "benchmark": "framework", "task_id": "offline-http-smoke",
            }}
            try:
                request("message", payload, authenticated=False)
            except urllib.error.HTTPError as error:
                assert error.code == 401
            else:
                raise AssertionError("Unauthenticated benchmark mutation was accepted")
            response = request("message", payload)
            assert any(action.get("command") == "CLICK(10,10)" for action in response["captured_actions"]), response
            assert response["metadata"]["native_runtime_api"] == "messageService.handleMessage"
            assert response["metadata"]["direct_model_bypass"] is False
            assert response["metadata"]["release_evidence"] is False
            print("Runtime HTTP smoke passed: authenticated native action captured; mock evidence labeled.")
        except BaseException:
            log.seek(0)
            print(log.read())
            raise
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == "__main__":
    main()
