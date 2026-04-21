from __future__ import annotations

import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from .db import connect_database, initialize_database
from .viewer_data import build_viewer_dataset


def _empty_dataset() -> dict[str, object]:
    return {
        "generated_at": None,
        "runs": [],
        "run_groups": [],
        "latest_scores": [],
        "benchmark_summary": [],
        "model_summary": [],
        "agent_summary": [],
    }


def _load_dataset(workspace_root: Path) -> dict[str, object]:
    benchmark_root = workspace_root / "benchmarks"
    db_path = benchmark_root / "benchmark_results" / "orchestrator.sqlite"
    json_path = benchmark_root / "benchmark_results" / "viewer_data.json"

    if db_path.exists():
        conn = connect_database(db_path)
        initialize_database(conn)
        data = build_viewer_dataset(conn)
        conn.close()
        return data

    if json_path.exists():
        return json.loads(json_path.read_text(encoding="utf-8"))

    return _empty_dataset()


class ViewerRequestHandler(SimpleHTTPRequestHandler):
    workspace_root: Path

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/viewer-data":
            payload = _load_dataset(self.workspace_root)
            body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path == "/health":
            body = b"ok\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path in {"", "/"}:
            self.path = "/index.html"
        super().do_GET()


def serve_viewer(*, workspace_root: Path, host: str, port: int) -> None:
    viewer_root = workspace_root / "benchmarks" / "viewer"
    if not viewer_root.exists():
        raise FileNotFoundError(f"Viewer directory not found: {viewer_root}")

    handler_class = type(
        "BoundViewerRequestHandler",
        (ViewerRequestHandler,),
        {"workspace_root": workspace_root},
    )
    handler = partial(handler_class, directory=str(viewer_root))

    server = ThreadingHTTPServer((host, port), handler)
    print(f"Viewer available at http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
