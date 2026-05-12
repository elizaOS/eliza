"""Vast.ai budget enforcement + cost surfacing.

Computes a running cost snapshot for a provisioned Vast instance and
enforces the soft/hard cap policy defined by ``ELIZA_VAST_MAX_USD``:

  * **soft cap** = ``ELIZA_VAST_MAX_USD`` (USD). Crossing it emits a
    warn event but the run continues.
  * **hard cap** = 1.5 × soft cap. Crossing it triggers an auto-teardown
    decision (the watcher script destroys the instance).

The instance hourly rate is fetched via ``vastai show instance --raw``
(``dph_total`` field, USD/hr). Uptime is the wall-clock delta since the
instance's ``start_date``. ``total_so_far_usd`` = ``dph_total *
uptime_hours``.

The module also exposes the pipeline name and GPU SKU so ``train_vast.sh
status`` can render a single readable line:

  pipeline=qwen3.5-9b-apollo gpu=B200x2 runtime=2:14:08 $/hr=$3.51 total=$7.83

Use::

    python -m scripts.lib.vast_budget snapshot <instance_id>
    python -m scripts.lib.vast_budget enforce  <instance_id>

The ``enforce`` subcommand returns:

  * exit 0 — under soft cap (or no cap configured)
  * exit 10 — over soft cap (warning event written)
  * exit 11 — over hard cap (auto-teardown signaled by writing
    ``ELIZA_STATE_DIR/vast-budget/<instance_id>.teardown`` sentinel)

The watcher (``scripts/vast-watcher.sh``) polls ``enforce`` and acts on
the exit code.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import asdict, dataclass

from scripts.lib import vast as _vast_cli


SOFT_CAP_ENV = "ELIZA_VAST_MAX_USD"
HARD_CAP_MULTIPLIER = 1.5

# Exit codes used by the ``enforce`` subcommand to communicate budget
# state to the watcher. Anything outside this set means an unexpected
# error and the watcher logs but does not auto-teardown.
EXIT_OK = 0
EXIT_OVER_SOFT = 10
EXIT_OVER_HARD = 11
EXIT_BACKEND_ERROR = 2


def _state_dir() -> str:
    return os.environ.get("ELIZA_STATE_DIR") or os.environ.get(
        "ELIZA_STATE_DIR"
    ) or os.path.join(os.path.expanduser("~"), ".eliza")


def budget_dir() -> str:
    """Directory where teardown sentinels + budget event logs are written."""
    path = os.path.join(_state_dir(), "vast-budget")
    os.makedirs(path, exist_ok=True)
    return path


def teardown_sentinel(instance_id: int | str) -> str:
    return os.path.join(budget_dir(), f"{instance_id}.teardown")


def events_log(instance_id: int | str) -> str:
    return os.path.join(budget_dir(), f"{instance_id}.events.jsonl")


@dataclass(frozen=True)
class CostSnapshot:
    """One immutable view of an instance's billing state.

    All fields are scalar — the snapshot is meant to be serialized
    directly to JSON for ``train_vast.sh status`` and the training UI.
    """

    instance_id: int
    pipeline: str
    run_name: str
    gpu_name: str
    num_gpus: int
    gpu_sku: str  # human "B200x2" / "RTX_PRO_6000_Sx1"
    state: str
    uptime_seconds: float
    uptime_pretty: str
    dph_total: float  # USD/hr from vastai
    total_so_far_usd: float
    soft_cap_usd: float | None
    hard_cap_usd: float | None
    over_soft: bool
    over_hard: bool
    fetched_at: float  # unix seconds


def _pretty_uptime(seconds: float) -> str:
    if seconds <= 0:
        return "0:00:00"
    s = int(seconds)
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}"


def _read_soft_cap() -> float | None:
    raw = os.environ.get(SOFT_CAP_ENV)
    if not raw or not raw.strip():
        return None
    try:
        v = float(raw)
    except ValueError as e:
        raise SystemExit(
            f"{SOFT_CAP_ENV} must be a number in USD; got {raw!r}: {e}"
        )
    if v <= 0:
        raise SystemExit(
            f"{SOFT_CAP_ENV} must be > 0 USD when set; got {v}"
        )
    return v


def fetch_snapshot(
    instance_id: int,
    *,
    pipeline: str,
    run_name: str,
    show_fn=None,
    now_fn=None,
) -> CostSnapshot:
    """Build a ``CostSnapshot`` for ``instance_id``.

    ``show_fn`` / ``now_fn`` are seams for tests so unit coverage can
    inject a deterministic ``vastai show instance`` payload and a frozen
    clock without touching the network.
    """
    show = show_fn or _vast_cli.show_instance
    now = now_fn or time.time
    try:
        info = show(instance_id)
    except subprocess.CalledProcessError as e:
        raise SystemExit(
            f"vastai show instance {instance_id} failed: "
            f"{e.stderr or e.stdout or e}"
        ) from e

    if not info:
        raise SystemExit(
            f"vastai show instance {instance_id} returned empty payload"
        )

    raw_state = (
        info.get("actual_status")
        or info.get("cur_state")
        or info.get("intended_status")
        or ""
    )
    gpu_name = str(info.get("gpu_name", "?"))
    try:
        num_gpus = int(info.get("num_gpus", 0) or 0)
    except (TypeError, ValueError):
        num_gpus = 0
    gpu_sku = f"{gpu_name}x{num_gpus}" if num_gpus else gpu_name

    try:
        dph_total = float(info.get("dph_total", 0.0) or 0.0)
    except (TypeError, ValueError):
        dph_total = 0.0

    try:
        start = float(info.get("start_date") or 0.0)
    except (TypeError, ValueError):
        start = 0.0
    uptime_seconds = max(0.0, now() - start) if start else 0.0
    uptime_hours = uptime_seconds / 3600.0
    total_so_far_usd = dph_total * uptime_hours

    soft = _read_soft_cap()
    hard = soft * HARD_CAP_MULTIPLIER if soft is not None else None

    return CostSnapshot(
        instance_id=int(instance_id),
        pipeline=pipeline,
        run_name=run_name,
        gpu_name=gpu_name,
        num_gpus=num_gpus,
        gpu_sku=gpu_sku,
        state=str(raw_state) or "unknown",
        uptime_seconds=uptime_seconds,
        uptime_pretty=_pretty_uptime(uptime_seconds),
        dph_total=dph_total,
        total_so_far_usd=total_so_far_usd,
        soft_cap_usd=soft,
        hard_cap_usd=hard,
        over_soft=bool(soft is not None and total_so_far_usd > soft),
        over_hard=bool(hard is not None and total_so_far_usd > hard),
        fetched_at=now(),
    )


def _emit_event(instance_id: int | str, kind: str, snapshot: CostSnapshot) -> None:
    """Append one budget event to ``<state_dir>/vast-budget/<id>.events.jsonl``.

    Events are durable so the UI panel and the watcher's incident log
    have the same forensic record after a restart.
    """
    record = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kind": kind,
        "instance_id": int(instance_id),
        "snapshot": asdict(snapshot),
    }
    path = events_log(instance_id)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")


def enforce(
    instance_id: int,
    *,
    pipeline: str,
    run_name: str,
    show_fn=None,
    now_fn=None,
) -> tuple[CostSnapshot, int]:
    """Compute snapshot, write event + sentinel as required, return exit code.

    Hard-cap behavior is **dry**: this function only writes the sentinel
    file. The watcher reads that sentinel and runs the actual
    ``vastai destroy instance`` call. Keeping the destructive call out
    of this module makes unit tests safe (no chance of a mocked test
    nuking a real instance).
    """
    snap = fetch_snapshot(
        instance_id,
        pipeline=pipeline,
        run_name=run_name,
        show_fn=show_fn,
        now_fn=now_fn,
    )

    if snap.over_hard:
        _emit_event(instance_id, "hard_cap_breach", snap)
        sentinel = teardown_sentinel(instance_id)
        # idempotent — repeated breaches don't rewrite the file
        if not os.path.exists(sentinel):
            with open(sentinel, "w", encoding="utf-8") as fh:
                fh.write(
                    json.dumps(
                        {
                            "instance_id": snap.instance_id,
                            "total_so_far_usd": snap.total_so_far_usd,
                            "hard_cap_usd": snap.hard_cap_usd,
                            "reason": "hard_cap_breach",
                            "at": snap.fetched_at,
                        }
                    )
                )
        return snap, EXIT_OVER_HARD

    if snap.over_soft:
        _emit_event(instance_id, "soft_cap_breach", snap)
        return snap, EXIT_OVER_SOFT

    return snap, EXIT_OK


def _print_human(snap: CostSnapshot) -> None:
    """One-line human summary for ``train_vast.sh status``."""
    parts = [
        f"pipeline={snap.pipeline}",
        f"run={snap.run_name}",
        f"gpu={snap.gpu_sku}",
        f"runtime={snap.uptime_pretty}",
        f"$/hr=${snap.dph_total:.2f}",
        f"total=${snap.total_so_far_usd:.2f}",
    ]
    if snap.soft_cap_usd is not None:
        parts.append(f"soft_cap=${snap.soft_cap_usd:.2f}")
    if snap.hard_cap_usd is not None:
        parts.append(f"hard_cap=${snap.hard_cap_usd:.2f}")
    if snap.over_hard:
        parts.append("STATE=OVER_HARD_CAP")
    elif snap.over_soft:
        parts.append("STATE=OVER_SOFT_CAP")
    print(" ".join(parts))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="scripts.lib.vast_budget")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_snap = sub.add_parser(
        "snapshot",
        help="print one-line cost summary (or --json for the full record)",
    )
    p_snap.add_argument("instance_id", type=int)
    p_snap.add_argument(
        "--pipeline",
        default=os.environ.get("REGISTRY_KEY", "unknown"),
        help="pipeline name (defaults to $REGISTRY_KEY)",
    )
    p_snap.add_argument(
        "--run-name",
        default=os.environ.get("RUN_NAME", ""),
        help="run name (defaults to $RUN_NAME)",
    )
    p_snap.add_argument("--json", action="store_true")

    p_enf = sub.add_parser(
        "enforce",
        help="check budget, write events/sentinel, exit 0/10/11",
    )
    p_enf.add_argument("instance_id", type=int)
    p_enf.add_argument(
        "--pipeline",
        default=os.environ.get("REGISTRY_KEY", "unknown"),
    )
    p_enf.add_argument(
        "--run-name",
        default=os.environ.get("RUN_NAME", ""),
    )

    args = parser.parse_args(argv)

    if args.cmd == "snapshot":
        try:
            snap = fetch_snapshot(
                args.instance_id,
                pipeline=args.pipeline,
                run_name=args.run_name,
            )
        except SystemExit as e:
            print(f"[vast_budget] error: {e}", file=sys.stderr)
            return EXIT_BACKEND_ERROR
        if args.json:
            print(json.dumps(asdict(snap)))
        else:
            _print_human(snap)
        return EXIT_OK

    if args.cmd == "enforce":
        try:
            snap, rc = enforce(
                args.instance_id,
                pipeline=args.pipeline,
                run_name=args.run_name,
            )
        except SystemExit as e:
            print(f"[vast_budget] error: {e}", file=sys.stderr)
            return EXIT_BACKEND_ERROR
        _print_human(snap)
        return rc

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
