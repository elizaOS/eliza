"""Local openpi server launch helper (placeholder).

This is a CLI wrapper that prints the docker command needed to spin up a
Physical Intelligence openpi inference server locally. We do not exec
docker for the user — the image distribution model is still in flux (no
public PyPI/registry image at the time of writing). See
``packages/robot/docs/openpi.md`` for the canonical runbook and for image
acquisition once Physical Intelligence publishes one.
"""

from __future__ import annotations

import argparse
import shlex


# TODO(openpi-image): replace with the official image reference once
# Physical Intelligence publishes a registry-hosted openpi server image.
# Until then, build locally from https://github.com/Physical-Intelligence/openpi
# per the doc pointer above.
_DEFAULT_IMAGE = "physical-intelligence/openpi-server:latest"
_DEFAULT_PORT = 9200
_DEFAULT_POLICY = "pi0_ainex"


def build_command(
    image: str = _DEFAULT_IMAGE,
    port: int = _DEFAULT_PORT,
    policy: str = _DEFAULT_POLICY,
    gpu: bool = True,
) -> list[str]:
    """Return the ``docker run`` argv that would launch the openpi server."""
    argv = ["docker", "run", "--rm", "-it"]
    if gpu:
        argv += ["--gpus", "all"]
    argv += ["-p", f"{port}:{port}", image, "--policy", policy]
    return argv


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Print the docker command to launch a local Physical Intelligence "
            "openpi inference server. Run the printed command manually after "
            "verifying you have the image (see packages/robot/docs/openpi.md)."
        ),
    )
    parser.add_argument("--image", default=_DEFAULT_IMAGE, help="Container image reference.")
    parser.add_argument("--port", type=int, default=_DEFAULT_PORT, help="Host port to expose.")
    parser.add_argument("--policy", default=_DEFAULT_POLICY, help="Policy name to serve.")
    parser.add_argument(
        "--no-gpu", action="store_true",
        help="Drop --gpus all (CPU-only inference; expect higher latency).",
    )
    args = parser.parse_args()

    argv = build_command(
        image=args.image, port=args.port, policy=args.policy, gpu=not args.no_gpu,
    )
    print(" ".join(shlex.quote(a) for a in argv))


if __name__ == "__main__":
    main()
