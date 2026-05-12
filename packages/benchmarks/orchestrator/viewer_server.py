from __future__ import annotations

import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from .db import connect_database, initialize_database
from .viewer_data import build_viewer_dataset


CANONICAL_TRAJECTORY_FILENAME = "trajectory.canonical.jsonl"


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


def _read_jsonl_lines(path: Path) -> list[dict[str, object]]:
    """Read a canonical JSONL file and return a list of parsed objects."""
    out: list[dict[str, object]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                out.append(obj)
    return out


def _load_trajectories(
    workspace_root: Path,
    *,
    run_group_id: str,
    benchmark_id: str,
    task_id: str,
) -> dict[str, object]:
    """Resolve canonical trajectory files for one ``(run_group_id, benchmark, task_id)``.

    ``task_id`` doubles as the ``run_id`` segment in the on-disk path
    — the trajectory normalizer hook passes the run id through as the
    task identifier. The endpoint scans the run group directory for
    every harness that has a canonical JSONL, plus the latest
    ``random_v1`` baseline for the same benchmark (which has its own
    run group), and returns each as a list of canonical entries.
    """
    benchmark_root = workspace_root / "benchmarks" / "benchmark_results"
    run_group_root = benchmark_root / run_group_id

    by_harness: dict[str, list[dict[str, object]]] = {}
    paths: dict[str, str] = {}

    if run_group_root.exists():
        for canonical_path in run_group_root.rglob(CANONICAL_TRAJECTORY_FILENAME):
            try:
                entries = _read_jsonl_lines(canonical_path)
            except OSError:
                continue
            if not entries:
                continue
            # Match the requested benchmark + task_id (== run_id).
            matched = [
                e for e in entries
                if e.get("benchmark_id") == benchmark_id and e.get("task_id") == task_id
            ]
            if not matched:
                continue
            agent_id = str(matched[0].get("agent_id") or "")
            if not agent_id:
                continue
            by_harness[agent_id] = matched
            paths[agent_id] = str(canonical_path)

    # Augment with the latest random_v1 baseline for the benchmark
    # (independent of run_group_id, since baselines are typically
    # produced separately).
    if "random_v1" not in by_harness:
        latest_random = _latest_random_v1_trajectory(benchmark_root, benchmark_id=benchmark_id)
        if latest_random is not None:
            random_path, random_entries = latest_random
            by_harness["random_v1"] = random_entries
            paths["random_v1"] = str(random_path)

    return {
        "run_group_id": run_group_id,
        "benchmark_id": benchmark_id,
        "task_id": task_id,
        "harnesses": by_harness,
        "paths": paths,
    }


def _latest_random_v1_trajectory(
    benchmark_root: Path,
    *,
    benchmark_id: str,
) -> tuple[Path, list[dict[str, object]]] | None:
    """Find the most recent random_v1 canonical trajectory file for ``benchmark_id``.

    Walks every run-group directory under ``benchmark_results/`` and
    returns the file whose modified-time is newest among those whose
    first entry has ``agent_id == "random_v1"`` and matching
    ``benchmark_id``. Returns ``None`` when no such file exists.
    """
    if not benchmark_root.exists():
        return None
    best: tuple[float, Path, list[dict[str, object]]] | None = None
    for canonical_path in benchmark_root.rglob(CANONICAL_TRAJECTORY_FILENAME):
        try:
            entries = _read_jsonl_lines(canonical_path)
        except OSError:
            continue
        if not entries:
            continue
        first = entries[0]
        if first.get("agent_id") != "random_v1":
            continue
        if first.get("benchmark_id") != benchmark_id:
            continue
        try:
            mtime = canonical_path.stat().st_mtime
        except OSError:
            continue
        if best is None or mtime > best[0]:
            best = (mtime, canonical_path, entries)
    if best is None:
        return None
    return best[1], best[2]


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

        if parsed.path.startswith("/api/trajectories/"):
            parts = [p for p in parsed.path.split("/") if p]
            # /api/trajectories/<run_group_id>/<benchmark>/<task_id>
            if len(parts) >= 5 and parts[0] == "api" and parts[1] == "trajectories":
                run_group_id = parts[2]
                benchmark_id = parts[3]
                task_id = "/".join(parts[4:])
                payload = _load_trajectories(
                    self.workspace_root,
                    run_group_id=run_group_id,
                    benchmark_id=benchmark_id,
                    task_id=task_id,
                )
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
