"""One process owns the vLLM metrics writer and optional heartbeat thread.

The advisory lock is held for the process lifetime. Repeated onstart invocations
reuse that owner; a crash releases the lock without stale-PID cleanup. Metrics
are appended so a restart never erases an earlier observation.
"""

import argparse
import fcntl
import http.client
import importlib
import json
import logging
import math
import signal
import threading
import time
import urllib.request
from pathlib import Path


def positive_seconds(value: str) -> float:
    seconds = float(value)
    if not math.isfinite(seconds) or seconds <= 0:
        raise argparse.ArgumentTypeError("interval must be finite and positive")
    return seconds


def sample_metrics(url: str) -> dict:
    sample = {
        "ts": time.time(),
        "tokens_per_sec": None,
        "kv_bytes_per_token": None,
        "gpu_mem_used_bytes": None,
    }
    names = {
        "vllm:avg_generation_throughput_toks_per_s": "tokens_per_sec",
        "vllm:gpu_cache_usage_perc": "gpu_cache_usage_perc",
        "vllm:num_requests_running": "requests_running",
    }
    try:
        request = urllib.request.Request(url, headers={"Accept": "text/plain"})
        with urllib.request.urlopen(request, timeout=2) as response:
            body = response.read().decode("utf-8", "replace")
        for line in body.splitlines():
            for metric, field in names.items():
                if line.startswith(metric):
                    try:
                        sample[field] = float(line.rsplit(" ", 1)[-1])
                    except ValueError:
                        pass
    except (OSError, ValueError, http.client.HTTPException) as error:
        sample["error"] = str(error)
    return sample


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stats-path", type=Path, required=True)
    parser.add_argument("--metrics-url", required=True)
    parser.add_argument("--interval", type=positive_seconds, default=60)
    parser.add_argument("--heartbeat", action="store_true")
    parser.add_argument("--heartbeat-out", default="/workspace/inference-stats.jsonl")
    parser.add_argument("--heartbeat-label", default="vast-unknown")
    parser.add_argument("--heartbeat-interval", type=positive_seconds, default=60)
    parser.add_argument(
        "--heartbeat-log", type=Path, default=Path("/var/log/heartbeat.log")
    )
    args = parser.parse_args()

    args.stats_path.parent.mkdir(parents=True, exist_ok=True)
    # Never unlink the lock file: another caller may already hold its inode.
    with Path(str(args.stats_path) + ".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(
                "[observability] reusing the active metrics/heartbeat owner", flush=True
            )
            return

        stopped = threading.Event()
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda _signal, _frame: stopped.set())
        heartbeat = None
        heartbeat_log = None
        try:
            if args.heartbeat:
                args.heartbeat_log.parent.mkdir(parents=True, exist_ok=True)
                module = importlib.import_module("scripts.inference.heartbeat")
                heartbeat_log = logging.FileHandler(args.heartbeat_log, mode="a")
                heartbeat_log.setFormatter(
                    logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
                )
                module.log.addHandler(heartbeat_log)
                module.log.propagate = False
                heartbeat = threading.Thread(
                    target=module.main,
                    args=(
                        [
                            "--vllm-metrics-url",
                            args.metrics_url,
                            "--out",
                            args.heartbeat_out,
                            "--interval-seconds",
                            str(args.heartbeat_interval),
                            "--label",
                            args.heartbeat_label,
                        ],
                    ),
                    kwargs={"stop_event": stopped},
                    name="vllm-heartbeat",
                    daemon=True,
                )
                heartbeat.start()
            with args.stats_path.open("a") as output:
                while not stopped.is_set():
                    output.write(json.dumps(sample_metrics(args.metrics_url)) + "\n")
                    output.flush()
                    stopped.wait(args.interval)
        finally:
            stopped.set()
            if heartbeat is not None:
                # Never release ownership while a thread can still append.
                heartbeat.join()
            if heartbeat_log is not None:
                module.log.removeHandler(heartbeat_log)
                heartbeat_log.close()


if __name__ == "__main__":
    main()
