#!/usr/bin/env python3
"""
Trajectory Visualization Server for LOCA-bench.

Serves trajectory data from LOCA-bench evaluation outputs and provides
a web UI for interactive trajectory replay.

Usage:
    python vis_traj/server.py --traj_path /path/to/all_trajectories.json --port 8000
"""

import argparse
import json
import os
import sys
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import unquote

TRAJECTORY_CACHE = {}
FILE_LIST = []


def load_trajectories(traj_path: str):
    """Load all trajectories from a single all_trajectories.json file."""
    global TRAJECTORY_CACHE, FILE_LIST

    with open(traj_path, "r") as f:
        all_data = json.load(f)

    for task_name in sorted(all_data.keys()):
        states = all_data[task_name]
        for state_name in sorted(states.keys()):
            traj_data = states[state_name]

            cache_key = f"{task_name}/{state_name}"
            TRAJECTORY_CACHE[cache_key] = traj_data

            metrics = traj_data.get("metrics", {})
            FILE_LIST.append(
                {
                    "key": cache_key,
                    "task_name": task_name,
                    "state_name": state_name,
                    "accuracy": metrics.get("accuracy", None),
                    "total_steps": metrics.get("total_steps", None),
                    "completed": metrics.get("completed", None),
                }
            )

    print(f"Loaded {len(TRAJECTORY_CACHE)} trajectories")


class TrajectoryHandler(SimpleHTTPRequestHandler):
    """HTTP request handler for trajectory visualization."""

    def __init__(self, *args, static_dir=None, **kwargs):
        self.static_dir = static_dir
        super().__init__(*args, directory=static_dir, **kwargs)

    def do_GET(self):
        path = unquote(self.path)

        if path == "/api/files":
            self.send_json_response(FILE_LIST)
        elif path.startswith("/api/trajectory/"):
            key = path[len("/api/trajectory/"):]
            if key in TRAJECTORY_CACHE:
                self.send_json_response(TRAJECTORY_CACHE[key])
            else:
                self.send_error_response(404, f"Trajectory not found: {key}")
        else:
            # Serve static files
            super().do_GET()

    def send_json_response(self, data):
        response = json.dumps(data)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response.encode("utf-8"))))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(response.encode("utf-8"))

    def send_error_response(self, code, message):
        response = json.dumps({"error": message})
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response.encode("utf-8"))))
        self.end_headers()
        self.wfile.write(response.encode("utf-8"))

    def log_message(self, format, *args):
        # Suppress request logging for cleaner output
        pass


def main():
    # Ensure unbuffered output
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)

    parser = argparse.ArgumentParser(description="LOCA Trajectory Visualization Server")
    parser.add_argument(
        "--traj_path",
        type=str,
        required=True,
        help="Path to all_trajectories.json file",
    )
    parser.add_argument("--port", type=int, default=8000, help="Server port (default: 8000)")
    args = parser.parse_args()

    traj_path = os.path.abspath(args.traj_path)
    if not os.path.isfile(traj_path):
        print(f"Error: {traj_path} is not a file")
        return

    print(f"Loading trajectories from: {traj_path}")
    load_trajectories(traj_path)

    if not TRAJECTORY_CACHE:
        print("Warning: no trajectories found")

    static_dir = os.path.dirname(os.path.abspath(__file__))
    handler = partial(TrajectoryHandler, static_dir=static_dir)

    server = HTTPServer(("", args.port), handler)
    print(f"Server running at http://localhost:{args.port}")
    print(f"Serving {len(TRAJECTORY_CACHE)} trajectories")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        server.shutdown()


if __name__ == "__main__":
    main()
