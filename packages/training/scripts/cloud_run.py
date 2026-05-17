#!/usr/bin/env python3
"""Cross-backend cloud orchestration CLI.

Read-only verification harness for the ``BackendAdapter`` Protocol.
Dispatches by ``--backend`` through ``BACKEND_REGISTRY``; new backends
become available the moment they call ``@register_backend(...)``.

Subcommands (no provisioning yet — that lands in a follow-up):

    cloud_run.py search   --backend vast --gpu-target b200-2x
    cloud_run.py status   --backend vast --instance-id 12345678
    cloud_run.py teardown --backend vast --instance-id 12345678 --yes

Existing entry points (``scripts/train_vast.sh``) are unaffected.
"""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import sys
import time
from pathlib import Path
from typing import cast

# Make ``scripts.lib.backends.*`` importable when this file is run as a
# script (``python3 scripts/cloud_run.py ...``) — the repo root must be
# on sys.path. When invoked as ``python3 -m scripts.cloud_run`` this is
# already true, so the insert is a harmless no-op.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from scripts.lib.backends.base import (  # noqa: E402  (after sys.path tweak)
    BACKEND_REGISTRY,
    BackendAdapter,
    BackendError,
    InstanceHandle,
    NoOffersError,
    OfferConstraints,
)


# Importing each backend module triggers its ``@register_backend`` side
# effect. Add new backends here as they land.
_BACKEND_MODULES = (
    "scripts.lib.backends.vast",
)


def _load_backend(name: str) -> BackendAdapter:
    for mod in _BACKEND_MODULES:
        importlib.import_module(mod)
    if name not in BACKEND_REGISTRY:
        raise SystemExit(
            f"unknown backend {name!r}; registered: {sorted(BACKEND_REGISTRY)}"
        )
    cls = BACKEND_REGISTRY[name]
    return cast(BackendAdapter, cls())


def _cmd_search(args: argparse.Namespace) -> int:
    backend = _load_backend(args.backend)
    constraints = OfferConstraints(
        gpu_target=args.gpu_target,
        min_disk_gb=args.min_disk_gb,
        min_inet_down_mbps=args.min_inet_down_mbps,
        min_reliability=args.min_reliability,
        min_duration_days=args.min_duration_days,
        max_dph=args.max_dph,
    )
    try:
        offers = backend.search_offers(constraints)
    except NoOffersError as e:
        # No offers is a normal "empty result" — exit 0 with a message,
        # not 1, so shell pipelines can grep without tripping `set -e`.
        print(f"[cloud_run] no offers: {e}", file=sys.stderr)
        if args.json:
            print("[]")
        return 0
    except BackendError as e:
        print(f"[cloud_run] backend error: {e}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(
            [
                {
                    "backend": o.backend,
                    "id": o.id,
                    "gpu_name": o.gpu_name,
                    "num_gpus": o.num_gpus,
                    "gpu_total_ram_gb": o.gpu_total_ram_gb,
                    "dph": o.dph,
                    "reliability": o.reliability,
                    "inet_down_mbps": o.inet_down_mbps,
                    "disk_space_gb": o.disk_space_gb,
                    "geolocation": o.geolocation,
                }
                for o in offers[: args.limit]
            ],
            indent=2,
        ))
        return 0

    header = (
        f"{'id':>10}  {'gpu':<22}  x  {'$/hr':>6}  "
        f"{'rel':>5}  {'down Mb':>8}  {'disk GB':>8}  geolocation"
    )
    print(f"[cloud_run] backend={backend.name} target={args.gpu_target} "
          f"top {min(args.limit, len(offers))} of {len(offers)} offers:")
    print(header)
    print("-" * len(header))
    for o in offers[: args.limit]:
        print(
            f"{o.id:>10}  {o.gpu_name:<22}  "
            f"{o.num_gpus:<1}  ${o.dph:>5.2f}  "
            f"{o.reliability:>5.3f}  {o.inet_down_mbps:>8.0f}  "
            f"{o.disk_space_gb:>8.0f}  {o.geolocation}"
        )
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    backend = _load_backend(args.backend)
    handle = InstanceHandle(
        backend=backend.name,
        instance_id=args.instance_id,
        label=args.label or "",
        created_at=time.time(),
    )
    try:
        st = backend.status(handle)
    except BackendError as e:
        print(f"[cloud_run] backend error: {e}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps({
            "backend": handle.backend,
            "instance_id": handle.instance_id,
            "state": st.state,
            "gpu_name": st.gpu_name,
            "num_gpus": st.num_gpus,
            "uptime_s": st.uptime_s,
            "public_endpoint": st.public_endpoint,
        }, indent=2))
        return 0

    print(
        f"[cloud_run] {backend.name}/{handle.instance_id}: "
        f"state={st.state} gpu={st.gpu_name}x{st.num_gpus} "
        f"uptime={int(st.uptime_s) if st.uptime_s is not None else '?'}s "
        f"endpoint={st.public_endpoint or '<none>'}"
    )
    return 0


def _cmd_teardown(args: argparse.Namespace) -> int:
    if not args.yes:
        print(
            "[cloud_run] teardown refuses to run without --yes "
            "(this is destructive and bills accrue until destruction).",
            file=sys.stderr,
        )
        return 2
    backend = _load_backend(args.backend)
    handle = InstanceHandle(
        backend=backend.name,
        instance_id=args.instance_id,
        label=args.label or "",
        created_at=time.time(),
    )
    try:
        backend.teardown(handle, force=args.force)
    except BackendError as e:
        print(f"[cloud_run] backend error: {e}", file=sys.stderr)
        return 1
    print(f"[cloud_run] {backend.name}/{handle.instance_id}: destroyed")
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="[cloud_run] %(message)s",
    )
    parser = argparse.ArgumentParser(prog="cloud_run.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_search = sub.add_parser("search", help="list matching offers")
    p_search.add_argument("--backend", required=True)
    p_search.add_argument("--gpu-target", required=True)
    p_search.add_argument("--min-disk-gb", type=int, default=500)
    p_search.add_argument("--min-inet-down-mbps", type=int, default=500)
    p_search.add_argument("--min-reliability", type=float, default=0.97)
    p_search.add_argument("--min-duration-days", type=float, default=3.0)
    p_search.add_argument("--max-dph", type=float, default=None)
    p_search.add_argument("--limit", type=int, default=12)
    p_search.add_argument("--json", action="store_true")

    p_status = sub.add_parser("status", help="show one instance's status")
    p_status.add_argument("--backend", required=True)
    p_status.add_argument("--instance-id", required=True)
    p_status.add_argument("--label", default=None)
    p_status.add_argument("--json", action="store_true")

    p_td = sub.add_parser("teardown", help="destroy an instance")
    p_td.add_argument("--backend", required=True)
    p_td.add_argument("--instance-id", required=True)
    p_td.add_argument("--label", default=None)
    p_td.add_argument("--yes", action="store_true",
                      help="confirm destruction (required)")
    p_td.add_argument("--force", action="store_true")

    args = parser.parse_args(argv)
    if args.cmd == "search":
        return _cmd_search(args)
    if args.cmd == "status":
        return _cmd_status(args)
    if args.cmd == "teardown":
        return _cmd_teardown(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
