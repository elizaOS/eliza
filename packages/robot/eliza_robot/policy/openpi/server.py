"""Local openpi server launcher.

The CLI builds a Docker command for a Physical Intelligence openpi inference
server, prints it by default, and can execute it with ``--execute`` after
checking that Docker is available. The container image is configurable so teams
can use a locally built image, an internal registry mirror, or an upstream image
without changing this package.
"""

from __future__ import annotations

import argparse
import shlex
import shutil
import subprocess
import sys
from collections.abc import Sequence

_DEFAULT_IMAGE = "physical-intelligence/openpi-server:latest"
_DEFAULT_PORT = 9200
_DEFAULT_POLICY = "pi0_ainex"


def quote_command(argv: Sequence[str]) -> str:
    """Return a shell-safe rendering of an argv vector."""

    return " ".join(shlex.quote(part) for part in argv)


def build_command(
    image: str = _DEFAULT_IMAGE,
    port: int = _DEFAULT_PORT,
    policy: str = _DEFAULT_POLICY,
    gpu: bool = True,
    detach: bool = False,
    name: str | None = None,
    env: Sequence[str] = (),
    volume: Sequence[str] = (),
) -> list[str]:
    """Return the ``docker run`` argv that would launch the openpi server."""

    if port <= 0 or port > 65535:
        raise ValueError(f"port must be in 1..65535, got {port}")
    if not image:
        raise ValueError("image must be non-empty")
    if not policy:
        raise ValueError("policy must be non-empty")

    argv = ["docker", "run", "--rm"]
    if detach:
        argv.append("-d")
    else:
        argv.append("-it")
    if name:
        argv += ["--name", name]
    if gpu:
        argv += ["--gpus", "all"]
    for item in env:
        argv += ["-e", item]
    for item in volume:
        argv += ["-v", item]
    argv += ["-p", f"{port}:{port}", image, "--policy", policy]
    return argv


def run_command(argv: Sequence[str]) -> int:
    """Execute Docker and return its process exit code."""

    docker = shutil.which(argv[0])
    if docker is None:
        print(
            "Docker executable not found on PATH. Install Docker or run without --execute "
            "to print the command.",
            file=sys.stderr,
        )
        return 127
    completed = subprocess.run([docker, *argv[1:]], check=False)
    return int(completed.returncode)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Launch or print a Docker command for a local Physical Intelligence "
            "openpi inference server. Use --execute only after verifying the "
            "image reference is present locally or reachable from your registry."
        ),
    )
    parser.add_argument("--image", default=_DEFAULT_IMAGE, help="Container image reference.")
    parser.add_argument("--port", type=int, default=_DEFAULT_PORT, help="Host port to expose.")
    parser.add_argument("--policy", default=_DEFAULT_POLICY, help="Policy name to serve.")
    parser.add_argument("--name", default=None, help="Optional Docker container name.")
    parser.add_argument(
        "-e",
        "--env",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="Environment variable to pass to docker run; repeatable.",
    )
    parser.add_argument(
        "-v",
        "--volume",
        action="append",
        default=[],
        metavar="HOST:CONTAINER[:MODE]",
        help="Volume mount to pass to docker run; repeatable.",
    )
    parser.add_argument(
        "--no-gpu", action="store_true",
        help="Drop --gpus all (CPU-only inference; expect higher latency).",
    )
    parser.add_argument("--detach", action="store_true", help="Run the container in detached mode.")
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Execute docker run instead of printing the shell command.",
    )
    args = parser.parse_args(argv)

    command = build_command(
        image=args.image,
        port=args.port,
        policy=args.policy,
        gpu=not args.no_gpu,
        detach=args.detach,
        name=args.name,
        env=args.env,
        volume=args.volume,
    )
    if not args.execute:
        print(quote_command(command))
        return 0
    print(f"Executing: {quote_command(command)}")
    return run_command(command)


if __name__ == "__main__":
    raise SystemExit(main())
