"""Vast.ai helper — pick the best offer for a training target, look up an
instance's SSH endpoint, and stamp instance status.

The bash launcher (``scripts/train_vast.sh``) shells out to this module for
the JSON-heavy bits because parsing nested ``vastai`` output with ``jq``
stops being legible past two levels of structure.

GPU targets, mirroring the launcher's ``VAST_GPU_TARGET`` env var:

  Single-GPU targets (cheapest fit for active 0.8B / 2B / 4B SFT):
  * ``blackwell6000-1x`` — 1 × RTX PRO 6000 Blackwell (96 GB). Default
    pick for qwen3.5-0.8b / qwen3.5-2b / qwen3.5-4b. ~$1.07/hr at write time.
  * ``h100-1x`` — 1 × H100 SXM (80 GB). Faster bf16 throughput than
    Blackwell at higher $/hr; pick for time-pressured 4B work.
  * ``h200-1x`` — 1 × H200 SXM (141 GB). Best 1× target when active 4B
    training needs extra memory headroom or faster bf16.

  Multi-GPU targets (optional active-line sweeps / future placeholders):
  * ``blackwell6000-2x`` — 2 × RTX PRO 6000 Blackwell (96 GB each = 192 GB
    total). Useful for active 4B long-context sweeps.
  * ``b200-2x`` — 2 × NVIDIA B200 (≈183 GB each, ≈366 GB total).
    Expensive but fast fallback for throughput sweeps.
  * ``h100-2x`` — 2 × H100 SXM (80 GB each = 160 GB). Insufficient for
    large hidden placeholders, ample for active 4B.

  GRPO multi-GPU targets (verl splits actor train + rollout across the
  device pool — see ``scripts/train_grpo_verl.sh``):
  * ``h200-2x`` — 2 × H200 SXM (141 GB each = 282 GB). GRPO default for
    active 2B/4B (1 train + 1 rollout) until real timing evidence lands.
  * ``h200-4x`` — 4 × H200 SXM (564 GB total). Future/research rollout pool.
  * ``h200-8x`` — 8 × H200 SXM (1128 GB total). Future/research rollout pool.
  * ``b200-4x`` / ``b200-8x`` — B200 fallbacks when the H200 pool is
    empty. ~1.5-2× the $/hr but ~2× the throughput.

Usage from the shell:

    python -m scripts.lib.vast pick blackwell6000-2x      # cheapest matching offer id
    python -m scripts.lib.vast pick blackwell6000-2x --json
    python -m scripts.lib.vast list  blackwell6000-2x     # human table
    python -m scripts.lib.vast ssh   <instance_id>        # ssh user@host:port
    python -m scripts.lib.vast wait  <instance_id>        # block until 'running'

The module never reads or writes the API key — it relies on the ``vastai``
CLI's own credential store (``~/.config/vastai/vast_api_key`` or
``VAST_API_KEY`` env var).
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Any

# ----------------------------------------------------------------------------
# GPU target → search-query mapping.
# ----------------------------------------------------------------------------
#
# The query strings are passed verbatim to ``vastai search offers``. Tuning
# notes:
#
#   * ``rentable=true`` and ``verified=true`` are the defaults already
#     applied by ``vastai search offers``; we only restate them here for
#     readability.
#   * ``reliability > 0.97`` filters out flaky hosts. The query-time field
#     is ``reliability``; the JSON response carries the same value as
#     ``reliability2`` (which is *not* a valid query field — passing it
#     yields ``Unrecognized field`` from the API).
#   * ``inet_down >= 500`` (Mb/s) keeps dataset+model-pull time tractable.
#     A 35B fp16 weight pull is ~70 GB; at 500 Mb/s that's ~20 minutes.
#   * ``disk_space >= 500`` (GB) keeps room for HF cache + 1 checkpoint +
#     quantized sidecars. ``2000`` is what we actually want for
#     base+finetuned+quantized runs but not enough Vast hosts advertise
#     that, so the launcher exposes ``VAST_MIN_DISK_GB`` to override and
#     callers can re-search if the cheap pick is too small.
#   * ``cuda_max_good``/``cuda_vers``/``duration`` are *not* used as
#     filters — the API rejects ``cuda_max_good`` outright, ``cuda_vers``
#     comes back null on Blackwell offers, and ``duration`` filtering
#     erases all hits. We re-validate cuda + duration in the response.
TARGETS: dict[str, dict[str, Any]] = {
    # ─── single-GPU targets (active 0.8B / 2B / 4B) ───
    "blackwell6000-1x": {
        "gpu_names": ["RTX_PRO_6000_S", "RTX_PRO_6000_WS"],
        "num_gpus": 1,
        "min_per_gpu_ram_gb": 90,
        "description": "1× RTX PRO 6000 Blackwell (96 GB) — active 0.8B/2B/4B SFT default",
    },
    "h100-1x": {
        "gpu_names": ["H100_SXM", "H100_NVL"],
        "num_gpus": 1,
        "min_per_gpu_ram_gb": 75,
        "description": "1× H100 SXM/NVL (80 GB) — active 4B SFT, faster than Blackwell",
    },
    "h200-1x": {
        "gpu_names": ["H200_SXM", "H200"],
        "num_gpus": 1,
        # H200 is 141 GB HBM3e per GPU; gpu_ram>=130 robust to ECC reserve.
        "min_per_gpu_ram_gb": 130,
        "description": "1× H200 SXM (141 GB) — active 4B SFT with extra headroom",
    },
    # ─── multi-GPU targets (optional active-line sweeps / future placeholders) ───
    "blackwell6000-2x": {
        # Both Server (S) and Workstation (WS) editions are 96 GB GDDR7
        # Blackwell — same VRAM, similar bf16 perf. The CLI takes a single
        # gpu_name, so we run the search twice and merge.
        "gpu_names": ["RTX_PRO_6000_S", "RTX_PRO_6000_WS"],
        "num_gpus": 2,
        "min_per_gpu_ram_gb": 90,  # query-side units: GB. Response-side: MB.
        "description": "2× RTX PRO 6000 Blackwell (96 GB each = 192 GB total)",
    },
    "b200-2x": {
        "gpu_names": ["B200"],
        "num_gpus": 2,
        # B200 has 180 GB HBM3e per GPU. The catalog reports ~183 GB after
        # ECC reservation; gpu_ram>=170 (GB query units) is robust.
        "min_per_gpu_ram_gb": 170,
        "description": "2× NVIDIA B200 (≈183 GB each = ≈366 GB total) — fast active-line sweeps",
    },
    "h100-2x": {
        # H100 SXM and H100 NVL both ship 80 GB; SXM has higher NVLink
        # bandwidth so we list it first. ``H100_PCIE`` deliberately omitted
        # — PCIe-only H100 has 1/3 the inter-GPU bandwidth and tanks FSDP
        # all-gather throughput at 27B+.
        "gpu_names": ["H100_SXM", "H100_NVL"],
        "num_gpus": 2,
        "min_per_gpu_ram_gb": 75,
        "description": "2× H100 SXM/NVL (80 GB each = 160 GB total)",
    },
    # ─── GRPO multi-GPU targets ───
    # GRPO needs separate train + rollout GPUs (verl splits actor / rollout
    # across the available device pool via `n_gpus_per_node`). Per
    # RL_STRATEGY.md hardware budgets:
    #   active 2B/4B → 2× H200 (1 train + 1 rollout) until timing evidence lands
    # The B200 variants are 1.5-2× pricier but ~2× faster and serve as the
    # fallback when the H200 pool is empty.
    "h200-2x": {
        "gpu_names": ["H200_SXM", "H200"],
        "num_gpus": 2,
        "min_per_gpu_ram_gb": 130,
        "description": "2× H200 SXM (141 GB each = 282 GB total) — GRPO 2B default",
    },
    "h200-4x": {
        "gpu_names": ["H200_SXM", "H200"],
        "num_gpus": 4,
        "min_per_gpu_ram_gb": 130,
        "description": "4× H200 SXM (141 GB each = 564 GB total) — future/research GRPO pool",
    },
    "h200-8x": {
        "gpu_names": ["H200_SXM", "H200"],
        "num_gpus": 8,
        "min_per_gpu_ram_gb": 130,
        "description": "8× H200 SXM (141 GB each = 1128 GB total) — future/research GRPO pool",
    },
    "b200-4x": {
        "gpu_names": ["B200"],
        "num_gpus": 4,
        "min_per_gpu_ram_gb": 170,
        "description": "4× NVIDIA B200 (≈183 GB each = ≈732 GB total) — future/research GRPO fallback",
    },
    "b200-8x": {
        "gpu_names": ["B200"],
        "num_gpus": 8,
        "min_per_gpu_ram_gb": 170,
        "description": "8× NVIDIA B200 (≈183 GB each = ≈1464 GB total) — future/research GRPO fallback",
    },
}

# Defaults applied to every search; can be overridden per-call from the
# launcher via env vars (VAST_MIN_RELIABILITY, VAST_MIN_INET_DOWN_MBPS,
# VAST_MIN_DISK_GB, VAST_MIN_DURATION_DAYS).
DEFAULT_MIN_RELIABILITY = 0.97
DEFAULT_MIN_INET_DOWN_MBPS = 500.0
DEFAULT_MIN_DISK_GB = 500.0
DEFAULT_MIN_DURATION_DAYS = 3.0


@dataclass(frozen=True)
class Offer:
    """A normalized view of one ``vastai search offers`` row."""

    id: int
    gpu_name: str
    num_gpus: int
    gpu_total_ram_gb: int
    dph_total: float
    dlperf: float
    reliability: float
    inet_down_mbps: float
    inet_up_mbps: float
    disk_space_gb: float
    duration_days: float
    geolocation: str
    cuda_max_good: float

    @classmethod
    def from_raw(cls, raw: dict[str, Any]) -> "Offer":
        # Response-side ``gpu_ram`` is MB; ``gpu_total_ram`` is also MB.
        # ``duration`` is seconds.
        return cls(
            id=int(raw["id"]),
            gpu_name=str(raw.get("gpu_name", "?")),
            num_gpus=int(raw.get("num_gpus", 0)),
            gpu_total_ram_gb=int(raw.get("gpu_total_ram", 0)) // 1024,
            dph_total=float(raw.get("dph_total", 0.0)),
            dlperf=float(raw.get("dlperf", 0.0)),
            reliability=float(raw.get("reliability2", raw.get("reliability", 0.0))),
            inet_down_mbps=float(raw.get("inet_down", 0.0)),
            inet_up_mbps=float(raw.get("inet_up", 0.0)),
            disk_space_gb=float(raw.get("disk_space", 0.0)),
            duration_days=float(raw.get("duration", 0.0)) / 86400.0,
            geolocation=str(raw.get("geolocation", "?")),
            cuda_max_good=float(raw.get("cuda_max_good", 0.0)),
        )


def _vastai(*args: str) -> str:
    """Run a vastai subcommand and return stdout. Raises CalledProcessError
    on non-zero exit so callers fail loudly rather than swallowing API errors.
    """
    proc = subprocess.run(
        ["vastai", *args],
        check=True,
        text=True,
        capture_output=True,
    )
    return proc.stdout


def search(
    target: str,
    *,
    min_reliability: float = DEFAULT_MIN_RELIABILITY,
    min_inet_down_mbps: float = DEFAULT_MIN_INET_DOWN_MBPS,
    min_disk_gb: float = DEFAULT_MIN_DISK_GB,
    min_duration_days: float = DEFAULT_MIN_DURATION_DAYS,
) -> list[Offer]:
    """Return all offers matching the target's filter, sorted by dph_total asc.

    Server-side filters: gpu_name, num_gpus, gpu_ram, reliability,
    inet_down, disk_space. Client-side filter: duration (the API rejects
    duration as a query field).
    """
    if target not in TARGETS:
        raise SystemExit(
            f"unknown VAST_GPU_TARGET={target!r}; valid: {sorted(TARGETS)}"
        )
    spec = TARGETS[target]
    offers: list[Offer] = []
    # Query-side numeric fields (gpu_ram in GB, reliability fractional,
    # inet_down in Mb/s, disk_space in GB) accept ints — passing 500.0 to
    # the API silently returns 0 results, so we round.
    server_query_extra = (
        f"gpu_ram>={int(spec['min_per_gpu_ram_gb'])} "
        f"reliability>{min_reliability:g} "
        f"inet_down>={int(min_inet_down_mbps)} "
        f"disk_space>={int(min_disk_gb)}"
    )
    min_duration_s = min_duration_days * 86400.0
    for gpu_name in spec["gpu_names"]:
        query = (
            f"gpu_name={gpu_name} num_gpus={spec['num_gpus']} {server_query_extra}"
        )
        out = _vastai("search", "offers", query, "--raw")
        for raw in json.loads(out):
            if float(raw.get("duration", 0.0)) < min_duration_s:
                continue
            offers.append(Offer.from_raw(raw))
    # Dedup by id, then sort by hourly price.
    by_id = {o.id: o for o in offers}
    return sorted(by_id.values(), key=lambda o: o.dph_total)


def pick(target: str, **search_kwargs: float) -> Offer:
    """Cheapest matching offer. Raises SystemExit if no offers found."""
    offers = search(target, **search_kwargs)
    if not offers:
        raise SystemExit(
            f"no Vast offers match target={target} with filters "
            f"{search_kwargs or '<defaults>'}. "
            f"Try a different VAST_GPU_TARGET or loosen "
            f"VAST_MIN_DISK_GB / VAST_MIN_INET_DOWN_MBPS / VAST_MIN_RELIABILITY / "
            f"VAST_MIN_DURATION_DAYS; see {__file__}:TARGETS"
        )
    return offers[0]


def list_table(target: str, limit: int = 12, **search_kwargs: float) -> str:
    """Render the top ``limit`` offers as a fixed-width table for the CLI."""
    offers = search(target, **search_kwargs)
    if not offers:
        return f"(no offers for target={target})"
    header = f"{'id':>10}  {'gpu':<22}  {'tot GB':>7}  {'$/hr':>6}  {'dlperf':>7}  {'rel':>5}  {'down Mb':>8}  {'disk GB':>8}  {'days':>5}  geolocation"
    rows = [header, "-" * len(header)]
    for o in offers[:limit]:
        rows.append(
            f"{o.id:>10}  "
            f"{o.gpu_name:<22}  "
            f"{o.gpu_total_ram_gb:>7}  "
            f"{o.dph_total:>6.2f}  "
            f"{o.dlperf:>7.0f}  "
            f"{o.reliability:>5.3f}  "
            f"{o.inet_down_mbps:>8.0f}  "
            f"{o.disk_space_gb:>8.0f}  "
            f"{o.duration_days:>5.1f}  "
            f"{o.geolocation}"
        )
    return "\n".join(rows)


def show_instance(instance_id: int) -> dict[str, Any]:
    """Return the parsed instance JSON."""
    out = _vastai("show", "instance", str(instance_id), "--raw")
    return json.loads(out)


def ssh_endpoint(instance_id: int, *, retries: int = 6, retry_delay_s: int = 5) -> tuple[str, str, int]:
    """Return (user, host, port) for SSH'ing into the instance.

    Vast offers two SSH endpoints per instance:

      1. **Bouncer proxy** — ``ssh_host`` (e.g. ``ssh7.vast.ai``) +
         ``ssh_port`` (e.g. 24844) on the instance's raw json. This goes
         through Vast's relay; works on every host. Preferred.

      2. **Direct port-mapped** — ``public_ipaddr`` + ``direct_port_start``
         (the URL ``vastai ssh-url`` emits). Only works when the host's
         firewall actually exposes that port; on many hosts it doesn't,
         producing ``Connection refused``.

    Prefer (1). Fall back to (2) if the bouncer fields are missing.
    """
    last_err: str | None = None
    for attempt in range(max(1, retries)):
        try:
            info = show_instance(instance_id)
        except subprocess.CalledProcessError as exc:
            last_err = exc.stderr or exc.stdout or str(exc)
            info = {}
        ssh_host = info.get("ssh_host")
        ssh_port = info.get("ssh_port")
        if ssh_host and ssh_port:
            return "root", str(ssh_host), int(ssh_port)
        # Fallback: parse the direct ssh-url.
        try:
            out = _vastai("ssh-url", str(instance_id)).strip()
        except subprocess.CalledProcessError as exc:
            last_err = exc.stderr or exc.stdout or str(exc)
            out = ""
        if out.startswith("ssh://"):
            rest = out[len("ssh://"):]
            user, _, hostport = rest.partition("@")
            host, _, port_s = hostport.partition(":")
            port = int(port_s) if port_s else 22
            return user, host, port
        if attempt + 1 < retries:
            time.sleep(retry_delay_s)
    raise SystemExit(
        f"could not resolve SSH endpoint for instance {instance_id} after "
        f"{retries} attempts (last_err={last_err!r}); is the instance still "
        f"booting? wait for `actual_status=running` first."
    )


def is_alive(instance_id: int) -> bool:
    """True iff the instance still exists and isn't in a terminal state.

    Used by the launcher's ``provision`` to refuse spinning up a duplicate
    when ``.vast_instance_id`` already points at a healthy instance.
    """
    try:
        info = show_instance(instance_id)
    except subprocess.CalledProcessError:
        return False
    if not info:
        return False
    status = info.get("actual_status") or info.get("intended_status") or ""
    # Terminal states: 'exited', 'stopped'. Vast also emits 'destroyed' /
    # empty status when the instance has been torn down.
    return status not in {"", "exited", "stopped", "destroyed"}


def wait_running(instance_id: int, timeout_s: int = 900, poll_s: int = 10) -> dict[str, Any]:
    """Block until the instance reports ``actual_status == 'running'``.

    Vast instances move through created → loading → running. Most ready
    transitions land within 2-5 minutes; the timeout default (15 min)
    covers slow datacenter image pulls.
    """
    deadline = time.monotonic() + timeout_s
    last_status: str | None = None
    while time.monotonic() < deadline:
        info = show_instance(instance_id)
        status = info.get("actual_status") or info.get("status_msg") or "unknown"
        if status != last_status:
            print(f"[wait] instance {instance_id}: {status}", file=sys.stderr)
            last_status = status
        if info.get("actual_status") == "running":
            return info
        time.sleep(poll_s)
    raise SystemExit(
        f"instance {instance_id} did not reach 'running' within {timeout_s}s "
        f"(last status: {last_status})"
    )


def _emit_offer(offer: Offer, *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(offer.__dict__))
    else:
        # Bash-friendly KEY=value lines so callers can `eval $(... pick ...)`.
        for k, v in offer.__dict__.items():
            print(f"{k.upper()}={shlex.quote(str(v))}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="scripts.lib.vast")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_pick = sub.add_parser("pick", help="cheapest matching offer (KEY=VAL or --json)")
    p_pick.add_argument("target", choices=sorted(TARGETS))
    p_pick.add_argument("--json", action="store_true")

    p_list = sub.add_parser("list", help="human-readable offer table")
    p_list.add_argument("target", choices=sorted(TARGETS))
    p_list.add_argument("--limit", type=int, default=12)

    p_ssh = sub.add_parser("ssh", help="print 'user host port' for an instance")
    p_ssh.add_argument("instance_id", type=int)

    p_wait = sub.add_parser("wait", help="block until instance is running")
    p_wait.add_argument("instance_id", type=int)
    p_wait.add_argument("--timeout", type=int, default=900)

    p_alive = sub.add_parser("alive", help="exit 0 if instance is alive, 1 otherwise")
    p_alive.add_argument("instance_id", type=int)

    sub.add_parser("targets", help="list known GPU targets")

    args = parser.parse_args(argv)

    # Allow the launcher to dial filters via env vars without having to
    # pipe them through every subcommand explicitly.
    search_kwargs: dict[str, float] = {}
    if v := os.environ.get("VAST_MIN_RELIABILITY"):
        search_kwargs["min_reliability"] = float(v)
    if v := os.environ.get("VAST_MIN_INET_DOWN_MBPS"):
        search_kwargs["min_inet_down_mbps"] = float(v)
    if v := os.environ.get("VAST_MIN_DISK_GB"):
        search_kwargs["min_disk_gb"] = float(v)
    if v := os.environ.get("VAST_MIN_DURATION_DAYS"):
        search_kwargs["min_duration_days"] = float(v)

    if args.cmd == "pick":
        _emit_offer(pick(args.target, **search_kwargs), as_json=args.json)
        return 0
    if args.cmd == "list":
        print(list_table(args.target, args.limit, **search_kwargs))
        return 0
    if args.cmd == "ssh":
        user, host, port = ssh_endpoint(args.instance_id)
        print(f"{user} {host} {port}")
        return 0
    if args.cmd == "wait":
        info = wait_running(args.instance_id, timeout_s=args.timeout)
        print(json.dumps({"id": info.get("id"), "actual_status": info.get("actual_status")}))
        return 0
    if args.cmd == "alive":
        return 0 if is_alive(args.instance_id) else 1
    if args.cmd == "targets":
        for k, v in TARGETS.items():
            print(f"{k:<20}  {v['description']}")
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
