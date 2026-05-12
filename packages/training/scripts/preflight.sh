#!/usr/bin/env bash
# Pre-flight gate for Vast.ai provisioning.
#
# Run this BEFORE `bash scripts/train_vast.sh provision`. It catches the
# seven classes of failure that have actually burned smoke runs / paid GPU
# time in this repo:
#
#   1. uv lock drift             → ancient pin (e.g. pandas==1.0.5) gets
#                                   resolved on the remote and fails to build.
#   2. CPU unit tests fail       → memory_calc / model_registry / reward_fn
#                                   regressions land on Vast and OOM or crash.
#   3. dataset schema corruption → empty val.jsonl, missing metadata.task_type,
#                                   etc. — the trainer silently drops rows.
#   4. memory-budget overshoot   → model+seq_len combo exceeds 85% of target
#                                   GPU capacity (the empirical buffer for the
#                                   ~+30 GB FSDP-2 all-gather peak we measured
#                                   on Blackwell).
#   5. stale local smoke         → benchmarks/<key>-smoke-fullstack/sft/
#                                   summary.json older than 24h or
#                                   content_pct < 80 — operator must re-run
#                                   smoke before paying for cloud hardware.
#   6. CUDA capability mismatch  → torch wheels need cu126/cu130 floor and
#                                   the picked GPU target's driver / sm level
#                                   must support it.
#   7. format ceiling violations → per-task_type schema (planner envelope,
#                                   TOON-decoded routing tokens, tool-call
#                                   action shape, default-thought leaks) —
#                                   things `eliza_record.is_valid()` doesn't
#                                   catch. Trainer ingests the data anyway
#                                   and the model learns the wrong shape.
#
# On full success the script writes `.preflight.ok` at the repo root with
# a JSON summary and current timestamp. `train_vast.sh provision` reads
# the mtime of that file and refuses to provision unless it was updated
# within the current calendar hour.
#
# Bypass with ELIZA_SKIP_PREFLIGHT=1 (loud warning printed). Use only
# in operator emergencies — the gate exists because every check here
# costs cents to run locally and saves dollars on Vast.
#
# Usage:
#   bash scripts/preflight.sh [--registry-key qwen3.6-27b] [--gpu-target b200-2x]
#
# Reads (env, all optional with sensible defaults):
#   REGISTRY_KEY           — same as train_vast.sh; default qwen3.6-27b
#   VAST_GPU_TARGET        — same as train_vast.sh; default auto-picked
#   ELIZA_PREFLIGHT_SAMPLE_LINES — schema sample size per file; default 1000
#   ELIZA_PREFLIGHT_MAX_UTIL_PCT — memory headroom cutoff; default 85
#   ELIZA_PREFLIGHT_SMOKE_MAX_AGE_HOURS — stale-smoke cutoff; default 24
#   ELIZA_PREFLIGHT_MIN_CONTENT_PCT — minimum content_pct in summary; default 80

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log()      { printf '[preflight] %s\n' "$*"; }
log_ok()   { printf '[preflight] PASS  %s\n' "$*"; }
log_err()  { printf '[preflight] FAIL  %s\n' "$*" >&2; }
log_skip() { printf '[preflight] SKIP  %s\n' "$*"; }

REGISTRY_KEY="${REGISTRY_KEY:-qwen3.6-27b}"
SAMPLE_LINES="${ELIZA_PREFLIGHT_SAMPLE_LINES:-1000}"
MAX_UTIL_PCT="${ELIZA_PREFLIGHT_MAX_UTIL_PCT:-85}"
SMOKE_MAX_AGE_HOURS="${ELIZA_PREFLIGHT_SMOKE_MAX_AGE_HOURS:-24}"
MIN_CONTENT_PCT="${ELIZA_PREFLIGHT_MIN_CONTENT_PCT:-80}"

# Mirror train_vast.sh's GPU-target auto-pick so a user who only sets
# REGISTRY_KEY gets the same default the launcher would.
case "$REGISTRY_KEY" in
  qwen3.5-2b|qwen3.5-9b) DEFAULT_GPU_TARGET="blackwell6000-1x" ;;
  qwen3.6-27b)           DEFAULT_GPU_TARGET="b200-2x" ;;
  qwen3.5-0.8b)            DEFAULT_GPU_TARGET="blackwell6000-1x" ;;
  *)                     DEFAULT_GPU_TARGET="blackwell6000-2x" ;;
esac
VAST_GPU_TARGET="${VAST_GPU_TARGET:-$DEFAULT_GPU_TARGET}"

# Permit a one-shot `--registry-key X --gpu-target Y` invocation.
while [ $# -gt 0 ]; do
  case "$1" in
    --registry-key)  REGISTRY_KEY="$2"; shift 2 ;;
    --gpu-target)    VAST_GPU_TARGET="$2"; shift 2 ;;
    *) log_err "unknown arg: $1"; exit 2 ;;
  esac
done

log "registry-key=$REGISTRY_KEY  gpu-target=$VAST_GPU_TARGET"

SUMMARY_FILE="$ROOT/.preflight.ok"
SUMMARY_TMP="$(mktemp)"
trap 'rm -f "$SUMMARY_TMP"' EXIT

# Each check appends one JSON object to $SUMMARY_TMP; we wrap them at the
# end. Format: {"name": "...", "status": "pass|fail", "detail": {...}}.
record() {
  # NOTE: do NOT use `${3:-{}}` for the default — bash's ${var:-word}
  # parser stops at the first unescaped `}`, so `${3:-{}}` expands to
  # `${3:-{}` followed by a literal `}`, double-closing the JSON object.
  # Fall back via an explicit if/else.
  local name="$1"; local status="$2"
  local detail_json
  if [ "$#" -ge 3 ] && [ -n "$3" ]; then
    detail_json="$3"
  else
    detail_json='{}'
  fi
  printf '{"name":"%s","status":"%s","detail":%s}\n' "$name" "$status" "$detail_json" \
    >> "$SUMMARY_TMP"
}

# ──────────────────────────────────────────────────────────────────────
# Check 1 — uv lock consistency
# ──────────────────────────────────────────────────────────────────────
log "[1/8] uv lock --check (pyproject.toml ↔ uv.lock)"
if uv lock --check >/dev/null 2>&1; then
  log_ok "uv lock consistent"
  record uv_lock pass '{}'
else
  log_err "uv lock is stale — pyproject.toml and uv.lock disagree."
  log_err "Fix:  uv lock"
  record uv_lock fail '{"fix":"uv lock"}'
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────
# Check 2 — CPU pytest sweep
# ──────────────────────────────────────────────────────────────────────
log "[2/8] CPU pytest sweep (training + quantization + reward + hf publish)"
PYTEST_TARGETS=(
  scripts/training/test_memory_calc.py
  scripts/training/test_model_registry.py
  scripts/training/test_optimizer_cpu.py
  scripts/quantization/test_recipes_smoke.py
  scripts/test_eliza_record.py
  scripts/test_reward_fn.py
  scripts/test_hf_publish.py
)
# test_apollo.py boots a real GPU — exclude from CPU sweep.
EXISTING_TARGETS=()
for t in "${PYTEST_TARGETS[@]}"; do
  [ -f "$t" ] && EXISTING_TARGETS+=("$t")
done
if [ "${#EXISTING_TARGETS[@]}" -eq 0 ]; then
  log_err "no pytest targets resolved — repo layout regression?"
  record pytest fail '{"fix":"check scripts/training and scripts/quantization layout"}'
  exit 1
fi

if uv run --extra train pytest "${EXISTING_TARGETS[@]}" -x -q --no-header 2>&1 | tee /tmp/preflight_pytest.log; then
  log_ok "pytest sweep green (${#EXISTING_TARGETS[@]} files)"
  record pytest pass "$(printf '{"files":%d}' "${#EXISTING_TARGETS[@]}")"
else
  log_err "pytest sweep failed — see /tmp/preflight_pytest.log"
  log_err "Fix:  uv run --extra train pytest ${EXISTING_TARGETS[*]} -x"
  record pytest fail '{"fix":"uv run --extra train pytest <targets> -x","log":"/tmp/preflight_pytest.log"}'
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────
# Check 3 — eliza_record schema gate over data/final/{train,val,test}.jsonl
# ──────────────────────────────────────────────────────────────────────
log "[3/8] schema gate — data/final/{train,val,test}.jsonl (≤${SAMPLE_LINES} lines/file)"
SCHEMA_DETAIL_FILE="$(mktemp)"
trap 'rm -f "$SUMMARY_TMP" "$SCHEMA_DETAIL_FILE"' EXIT
if uv run --extra train python - "$ROOT" "$SAMPLE_LINES" "$SCHEMA_DETAIL_FILE" <<'PY'
"""Validate data/final/{train,val,test}.jsonl against ElizaRecord.is_valid().

Walks ≤sample_lines lines per file, builds a sha256 of the raw bytes
read, and reports per-file line counts plus the first invalid record's
reason. Fails on any of:
  - file missing
  - file empty (0 bytes or 0 lines)
  - any sampled line is not valid JSON
  - any sampled line fails ElizaRecord.is_valid()
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

ROOT = Path(sys.argv[1])
SAMPLE_LINES = int(sys.argv[2])
DETAIL_OUT = Path(sys.argv[3])

sys.path.insert(0, str(ROOT))
from scripts.lib.eliza_record import ElizaRecord  # noqa: E402

FILES = ["train.jsonl", "val.jsonl", "test.jsonl"]
results: dict[str, dict] = {}
ok = True

for name in FILES:
    path = ROOT / "data" / "final" / name
    entry: dict = {"path": str(path)}
    if not path.exists():
        entry.update({"status": "fail", "reason": "missing"})
        results[name] = entry
        ok = False
        continue
    size = path.stat().st_size
    if size == 0:
        entry.update({"status": "fail", "reason": "empty (0 bytes)", "size_bytes": 0})
        results[name] = entry
        ok = False
        continue

    sha = hashlib.sha256()
    line_count = 0
    sampled = 0
    first_failure: tuple[int, str] | None = None
    parse_error: tuple[int, str] | None = None
    with path.open("rb") as f:
        for raw in f:
            line_count += 1
            sha.update(raw)
            if sampled >= SAMPLE_LINES:
                continue
            sampled += 1
            try:
                blob = json.loads(raw)
            except json.JSONDecodeError as e:
                if parse_error is None:
                    parse_error = (line_count, str(e))
                continue
            try:
                rec = ElizaRecord(
                    roomName=blob.get("roomName", ""),
                    agentId=blob.get("agentId", ""),
                    memoryEntries=blob.get("memoryEntries", []),
                    currentMessage=blob.get("currentMessage", {}),
                    expectedResponse=blob.get("expectedResponse", ""),
                    availableActions=blob.get("availableActions", []),
                    metadata=blob.get("metadata", {}),
                )
            except Exception as e:  # missing keys, type errors
                if first_failure is None:
                    first_failure = (line_count, f"construct: {e}")
                continue
            valid, why = rec.is_valid()
            if not valid and first_failure is None:
                first_failure = (line_count, why)

    entry.update({
        "size_bytes": size,
        "line_count": line_count,
        "sampled": sampled,
        "sha256_prefix": sha.hexdigest()[:16],
    })
    if line_count == 0:
        entry.update({"status": "fail", "reason": "empty (0 lines)"})
        ok = False
    elif parse_error is not None:
        entry.update({"status": "fail", "reason": f"json parse line {parse_error[0]}: {parse_error[1]}"})
        ok = False
    elif first_failure is not None:
        entry.update({"status": "fail", "reason": f"line {first_failure[0]}: {first_failure[1]}"})
        ok = False
    else:
        entry["status"] = "pass"
    results[name] = entry

DETAIL_OUT.write_text(json.dumps(results, separators=(",", ":")))
sys.exit(0 if ok else 1)
PY
then
  log_ok "schema gate passed"
  record schema pass "$(cat "$SCHEMA_DETAIL_FILE")"
else
  log_err "schema gate failed — bad records or missing/empty file"
  if [ -s "$SCHEMA_DETAIL_FILE" ]; then
    log_err "detail: $(cat "$SCHEMA_DETAIL_FILE")"
  fi
  log_err "Fix:  inspect data/final/{train,val,test}.jsonl; rerun bun run training:format if needed"
  detail_json="$(cat "$SCHEMA_DETAIL_FILE" 2>/dev/null || echo '{}')"
  record schema fail "$detail_json"
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────
# Check 4 — memory projection vs target hardware (85% cap)
# ──────────────────────────────────────────────────────────────────────
log "[4/8] memory projection ≤${MAX_UTIL_PCT}% of target hardware"
MEM_DETAIL_FILE="$(mktemp)"
trap 'rm -f "$SUMMARY_TMP" "$SCHEMA_DETAIL_FILE" "$MEM_DETAIL_FILE"' EXIT
if uv run --extra train python - "$REGISTRY_KEY" "$VAST_GPU_TARGET" "$MAX_UTIL_PCT" "$MEM_DETAIL_FILE" <<'PY'
"""Project per-GPU training memory and fail if predicted use exceeds
MAX_UTIL_PCT % of the target hardware's per-GPU capacity.

The 85% cutoff buffers the empirical +30 GB all-gather peak we measured
on the 27B FSDP-2 Blackwell smoke (memory_calc projected 67 GB,
realtime nvidia-smi peaked at 95 GB). Any combo predicted >85% of cap
should NOT be paid for on Vast — drop seq_len, scale up world_size,
or pick a higher-VRAM GPU target.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REGISTRY_KEY = sys.argv[1]
GPU_TARGET = sys.argv[2]
MAX_UTIL_PCT = float(sys.argv[3])
DETAIL_OUT = Path(sys.argv[4])

ROOT = Path(__file__).resolve().parents[2] if "/" in __file__ else Path.cwd()
sys.path.insert(0, str(Path.cwd()))

from scripts.lib import vast as vast_lib  # noqa: E402
from scripts.training.memory_calc import (  # noqa: E402
    HARDWARE,
    SHAPES,
    TrainConfig,
    TrainOpt,
    estimate_train,
)
from scripts.training.model_registry import get as registry_get  # noqa: E402

# 1. Resolve target → (HARDWARE per-GPU key, world_size)
TARGET_TO_HW: dict[str, tuple[str, int]] = {
    "blackwell6000-1x": ("rtx-pro-6000-blackwell", 1),
    "blackwell6000-2x": ("rtx-pro-6000-blackwell", 2),
    "h100-1x":          ("h100-80",                1),
    "h100-2x":          ("h100-80",                2),
    "h200-1x":          ("h200-141",               1),
    "h200-2x":          ("h200-141",               2),
    "b200-2x":          ("b200-180",               2),
}
if GPU_TARGET not in TARGET_TO_HW:
    msg = (
        f"unknown VAST_GPU_TARGET={GPU_TARGET!r}; "
        f"valid: {sorted(TARGET_TO_HW)}"
    )
    DETAIL_OUT.write_text(json.dumps({"error": msg}))
    print(msg, file=sys.stderr)
    sys.exit(1)
hw_key, world_size = TARGET_TO_HW[GPU_TARGET]
per_gpu_cap_gb = HARDWARE[hw_key]

# 2. Resolve registry → shape + train config
entry = registry_get(REGISTRY_KEY)
if REGISTRY_KEY not in SHAPES:
    msg = f"no ModelShape for {REGISTRY_KEY!r}; add to memory_calc.SHAPES"
    DETAIL_OUT.write_text(json.dumps({"error": msg}))
    print(msg, file=sys.stderr)
    sys.exit(1)
shape = SHAPES[REGISTRY_KEY]
opt_map = {
    "apollo": TrainOpt.APOLLO,
    "apollo_mini": TrainOpt.APOLLO_MINI,
}
optimizer = opt_map.get(entry.optimizer, TrainOpt.APOLLO_MINI)

cfg = TrainConfig(
    seq_len=entry.seq_len,
    micro_batch=entry.micro_batch,
    optimizer=optimizer,
    apollo_rank=entry.optimizer_rank,
    use_liger=True,                   # all-optimizations-on
    use_grad_checkpointing=True,
    use_flash_attn=True,
    fsdp_world_size=world_size,
    cpu_offload_optimizer=False,
)
breakdown = estimate_train(shape, cfg)
util_pct = 100.0 * breakdown.total_gb / per_gpu_cap_gb

detail = {
    "registry_key": REGISTRY_KEY,
    "gpu_target": GPU_TARGET,
    "hw_key": hw_key,
    "world_size": world_size,
    "per_gpu_cap_gb": per_gpu_cap_gb,
    "predicted_per_gpu_gb": round(breakdown.total_gb, 2),
    "util_pct": round(util_pct, 1),
    "max_util_pct": MAX_UTIL_PCT,
    "seq_len": entry.seq_len,
    "optimizer": entry.optimizer,
    "world_size_fsdp": world_size,
    "breakdown": {
        k: round(v, 2) for k, v in {
            "weights_gb": breakdown.weights_gb,
            "gradients_gb": breakdown.gradients_gb,
            "optimizer_state_gb": breakdown.optimizer_state_gb,
            "activations_gb": breakdown.activations_gb,
            "logits_transient_gb": breakdown.logits_transient_gb,
            "kv_cache_gb": breakdown.kv_cache_gb,
            "misc_gb": breakdown.misc_gb,
        }.items()
    },
}
DETAIL_OUT.write_text(json.dumps(detail, separators=(",", ":")))

print(f"  shape={shape.name} optimizer={entry.optimizer} seq={entry.seq_len} "
      f"fsdp={world_size}", file=sys.stderr)
print(f"  predicted per-GPU: {breakdown.total_gb:.1f} GB  "
      f"cap: {per_gpu_cap_gb:.0f} GB  util: {util_pct:.0f}% "
      f"(cutoff: {MAX_UTIL_PCT:.0f}%)", file=sys.stderr)

if util_pct > MAX_UTIL_PCT:
    print(
        f"FAIL: predicted util {util_pct:.0f}% > {MAX_UTIL_PCT:.0f}% cap. "
        f"Empirical FSDP-2 all-gather adds ~+30GB on top of static estimate; "
        f"this combo will OOM on cloud hardware.",
        file=sys.stderr,
    )
    sys.exit(1)
sys.exit(0)
PY
then
  log_ok "memory projection within ${MAX_UTIL_PCT}% cap"
  record memory pass "$(cat "$MEM_DETAIL_FILE")"
else
  log_err "memory projection exceeds ${MAX_UTIL_PCT}% — would OOM on Vast"
  log_err "Fix:  drop seq_len in model_registry.py, increase FSDP world_size, "
  log_err "      or pick a higher-VRAM target via VAST_GPU_TARGET"
  detail_json="$(cat "$MEM_DETAIL_FILE" 2>/dev/null || echo '{}')"
  record memory fail "$detail_json"
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────
# Check 5 — recent local smoke green
# ──────────────────────────────────────────────────────────────────────
log "[5/8] local smoke fresh (<${SMOKE_MAX_AGE_HOURS}h, content_pct ≥ ${MIN_CONTENT_PCT})"
SMOKE_DETAIL_FILE="$(mktemp)"
trap 'rm -f "$SUMMARY_TMP" "$SCHEMA_DETAIL_FILE" "$MEM_DETAIL_FILE" "$SMOKE_DETAIL_FILE"' EXIT
if uv run --extra train python - "$REGISTRY_KEY" "$SMOKE_MAX_AGE_HOURS" "$MIN_CONTENT_PCT" "$SMOKE_DETAIL_FILE" <<'PY'
"""Stat benchmarks/<key>-smoke-fullstack/sft/summary.json. Fail if missing,
older than the cutoff, or content_pct under threshold across any bucket.

The smoke benchmark dir uses the dotted registry key with dots replaced
by hyphens (e.g. qwen3.5-2b → qwen3-5-2b-smoke-fullstack).
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

REGISTRY_KEY = sys.argv[1]
MAX_AGE_HOURS = float(sys.argv[2])
MIN_CONTENT_PCT = float(sys.argv[3])
DETAIL_OUT = Path(sys.argv[4])

# `.`. → `-`. matches smoke_full_stack.sh's run-name convention.
hyphen_key = REGISTRY_KEY.replace(".", "-")
candidate_dirs = [
    Path("benchmarks") / f"{hyphen_key}-smoke-fullstack",
    Path("benchmarks") / f"{REGISTRY_KEY}-smoke-fullstack",
]
summary_path: Path | None = None
for d in candidate_dirs:
    p = d / "sft" / "summary.json"
    if p.exists():
        summary_path = p
        break

detail: dict = {
    "candidates": [str(c / "sft" / "summary.json") for c in candidate_dirs],
}

if summary_path is None:
    detail["status"] = "fail"
    detail["reason"] = "no summary.json under benchmarks/<key>-smoke-fullstack/sft/"
    DETAIL_OUT.write_text(json.dumps(detail))
    print(f"FAIL: no smoke summary at {detail['candidates']}", file=sys.stderr)
    sys.exit(1)

mtime = summary_path.stat().st_mtime
age_hours = (time.time() - mtime) / 3600.0
detail.update({
    "summary_path": str(summary_path),
    "age_hours": round(age_hours, 2),
    "max_age_hours": MAX_AGE_HOURS,
})

if age_hours > MAX_AGE_HOURS:
    detail["status"] = "fail"
    detail["reason"] = f"smoke summary {age_hours:.1f}h old > {MAX_AGE_HOURS}h cutoff"
    DETAIL_OUT.write_text(json.dumps(detail))
    print(f"FAIL: smoke too old ({age_hours:.1f}h)", file=sys.stderr)
    sys.exit(1)

blob = json.loads(summary_path.read_text())
buckets = blob.get("buckets", {}) or {}
content_pcts = {name: float(b.get("content_pct", 0.0)) for name, b in buckets.items()}
detail["content_pct_per_bucket"] = content_pcts
detail["min_content_pct"] = MIN_CONTENT_PCT

if not content_pcts:
    detail["status"] = "fail"
    detail["reason"] = "no buckets in smoke summary"
    DETAIL_OUT.write_text(json.dumps(detail))
    print("FAIL: no buckets in smoke summary", file=sys.stderr)
    sys.exit(1)

worst = min(content_pcts.values())
detail["worst_content_pct"] = worst
if worst < MIN_CONTENT_PCT:
    detail["status"] = "fail"
    detail["reason"] = f"worst content_pct {worst:.1f} < {MIN_CONTENT_PCT}"
    DETAIL_OUT.write_text(json.dumps(detail))
    print(f"FAIL: smoke content_pct {worst:.1f}% < {MIN_CONTENT_PCT}%", file=sys.stderr)
    sys.exit(1)

detail["status"] = "pass"
DETAIL_OUT.write_text(json.dumps(detail))
print(f"  smoke {summary_path} age={age_hours:.1f}h worst_content_pct={worst:.1f}%",
      file=sys.stderr)
sys.exit(0)
PY
then
  log_ok "local smoke fresh and green"
  record smoke pass "$(cat "$SMOKE_DETAIL_FILE")"
else
  log_err "local smoke missing/stale/red — re-run before paying for Vast"
  log_err "Fix:  bash scripts/smoke_full_stack.sh"
  detail_json="$(cat "$SMOKE_DETAIL_FILE" 2>/dev/null || echo '{}')"
  record smoke fail "$detail_json"
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────
# Check 6 — CUDA capability declaration
# ──────────────────────────────────────────────────────────────────────
log "[6/8] CUDA capability ≥ torch wheel floor for $VAST_GPU_TARGET"
CUDA_DETAIL_FILE="$(mktemp)"
trap 'rm -f "$SUMMARY_TMP" "$SCHEMA_DETAIL_FILE" "$MEM_DETAIL_FILE" "$SMOKE_DETAIL_FILE" "$CUDA_DETAIL_FILE"' EXIT
if uv run --extra train python - "$VAST_GPU_TARGET" "$CUDA_DETAIL_FILE" <<'PY'
"""Assert the picked Vast GPU target meets torch's CUDA capability floor.

torch>=2.10 wheels on this repo's `train` extra are built against cu126
(sm_90 compute capability minimum for FA3 on Hopper, sm_120 for the
Blackwell consumer line). torch>=2.11 wheels (auto-pulled when `serve`
extra is also active) need cu130, which adds Blackwell datacenter sm_100
(B200) support.

Mapping below is the empirically-verified set — Vast offers a
`cuda_max_good` field per host, and torch+cu13x demands cuda_max_good
≥ 13.0 to avoid the runtime kernel-load failures we hit on the
2026-05-04 smoke.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

GPU_TARGET = sys.argv[1]
DETAIL_OUT = Path(sys.argv[2])

# Per-target SM compute capability + minimum driver-reported cuda_max_good.
# cu126 → cuda_max_good ≥ 12.6; cu130 → cuda_max_good ≥ 13.0.
# Blackwell consumer (sm_120) ships on cu128+; Blackwell datacenter B200
# (sm_100) needs cu130. H100/H200 (sm_90) are fine on cu126.
TARGET_CAPS: dict[str, dict] = {
    "blackwell6000-1x": {"sm": 120, "cuda_max_good_min": 12.8},
    "blackwell6000-2x": {"sm": 120, "cuda_max_good_min": 12.8},
    "h100-1x":          {"sm":  90, "cuda_max_good_min": 12.6},
    "h100-2x":          {"sm":  90, "cuda_max_good_min": 12.6},
    "h200-1x":          {"sm":  90, "cuda_max_good_min": 12.6},
    "h200-2x":          {"sm":  90, "cuda_max_good_min": 12.6},
    "b200-2x":          {"sm": 100, "cuda_max_good_min": 13.0},
}

if GPU_TARGET not in TARGET_CAPS:
    msg = f"unknown gpu_target {GPU_TARGET!r}"
    DETAIL_OUT.write_text(json.dumps({"error": msg}))
    print(msg, file=sys.stderr)
    sys.exit(1)

cap = TARGET_CAPS[GPU_TARGET]
detail = {
    "gpu_target": GPU_TARGET,
    "expected_sm": cap["sm"],
    "cuda_max_good_min": cap["cuda_max_good_min"],
    # We don't query a live offer here — that costs an API call and
    # belongs to the `vast pick` stage. We *declare* the contract; the
    # picker enforces it server-side via the search filter.
    "status": "pass",
}
DETAIL_OUT.write_text(json.dumps(detail))
print(f"  target={GPU_TARGET}  sm_{cap['sm']}  cuda_max_good ≥ {cap['cuda_max_good_min']}",
      file=sys.stderr)
sys.exit(0)
PY
then
  log_ok "CUDA capability declaration recorded"
  record cuda_capability pass "$(cat "$CUDA_DETAIL_FILE")"
else
  log_err "CUDA capability gate failed for $VAST_GPU_TARGET"
  log_err "Fix:  set VAST_GPU_TARGET to one of {blackwell6000-1x, blackwell6000-2x, h100-1x, h100-2x, h200-1x, h200-2x, b200-2x}"
  detail_json="$(cat "$CUDA_DETAIL_FILE" 2>/dev/null || echo '{}')"
  record cuda_capability fail "$detail_json"
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────
# Check 7 — per-task_type format ceiling validation
# ──────────────────────────────────────────────────────────────────────
# `eliza_record.is_valid()` enforces only the FLOOR (top-level fields,
# non-empty content). validate_corpus.py enforces the CEILING — that the
# `expectedResponse` for each `metadata.task_type` actually matches what
# the eliza runtime parses. Catches the format drift DATASET_REVIEW.md
# documented (default-thought leaks, lowercase routing actions, missing
# REPLY/IGNORE/STOP, malformed planner envelopes, tool-calls that don't
# decode to TOON, etc.).
log "[7/8] format ceiling — validate_corpus.py --strict on data/final/{train,val,test}.jsonl"
FORMAT_DETAIL_FILE="$(mktemp)"
trap 'rm -f "$SUMMARY_TMP" "$SCHEMA_DETAIL_FILE" "$MEM_DETAIL_FILE" "$SMOKE_DETAIL_FILE" "$CUDA_DETAIL_FILE" "$FORMAT_DETAIL_FILE"' EXIT
FORMAT_OK=1
FORMAT_FAILED_FILES=()
mkdir -p "$ROOT/data/synthesized/review"
for SPLIT in train val test; do
  SPLIT_PATH="$ROOT/data/final/${SPLIT}.jsonl"
  REPORT_PATH="$ROOT/data/synthesized/review/format_validation_${SPLIT}.json"
  if [ ! -f "$SPLIT_PATH" ]; then
    log_err "format ceiling: $SPLIT_PATH missing"
    FORMAT_OK=0
    FORMAT_FAILED_FILES+=("${SPLIT}:missing")
    continue
  fi
  if uv run --extra train python "$ROOT/scripts/validate_corpus.py" \
        --input "$SPLIT_PATH" \
        --report "$REPORT_PATH" \
        --strict 2>&1 | tee -a /tmp/preflight_format.log; then
    log_ok "format ceiling: $SPLIT clean (report: $REPORT_PATH)"
  else
    log_err "format ceiling: $SPLIT has invalid records (report: $REPORT_PATH)"
    FORMAT_OK=0
    FORMAT_FAILED_FILES+=("${SPLIT}:invalid")
  fi
done

if [ "$FORMAT_OK" -eq 1 ]; then
  printf '{"reports":["data/synthesized/review/format_validation_%s.json"]}' \
      "{train,val,test}" > "$FORMAT_DETAIL_FILE"
  record format_ceiling pass "$(cat "$FORMAT_DETAIL_FILE")"
else
  printf '{"failed":["%s"],"fix":"inspect data/synthesized/review/format_validation_*.json; fix the named adapter in scripts/lib/adapters.py"}' \
      "$(IFS=,; echo "${FORMAT_FAILED_FILES[*]}")" > "$FORMAT_DETAIL_FILE"
  record format_ceiling fail "$(cat "$FORMAT_DETAIL_FILE")"
  log_err "Fix:  open data/synthesized/review/format_validation_<split>.json,"
  log_err "      identify the failing task_type/source, patch the adapter."
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────
# Check 8 — default-thought leak scan (fast, scoped, actionable)
# ──────────────────────────────────────────────────────────────────────
# DATASET_REVIEW.md flagged literal default-thought injection as the most
# damning corpus pollution. This check is intentionally separate from
# check #7 because it has a *concrete* fix path (run
# transform_fix_default_thoughts.py) and a tight per-record cost — we
# count, threshold, and fail with the exact remediation command. Threshold
# defaults to 100 records cumulative across train/val/test; override via
# ELIZA_PREFLIGHT_LEAK_THRESHOLD.
LEAK_THRESHOLD="${ELIZA_PREFLIGHT_LEAK_THRESHOLD:-100}"
log "[8/8] default-thought leak scan (≤${LEAK_THRESHOLD} cumulative leaks)"
LEAK_DETAIL_FILE="$(mktemp)"
trap 'rm -f "$SUMMARY_TMP" "$SCHEMA_DETAIL_FILE" "$MEM_DETAIL_FILE" "$SMOKE_DETAIL_FILE" "$CUDA_DETAIL_FILE" "$FORMAT_DETAIL_FILE" "$LEAK_DETAIL_FILE"' EXIT
if uv run --extra train python - "$ROOT" "$LEAK_THRESHOLD" "$LEAK_DETAIL_FILE" <<'PY'
"""Count records in data/final/{train,val,test}.jsonl whose first
`thought:` line equals one of the canonical leak literals from
scripts/lib/eliza_record.DEFAULT_THOUGHT_LEAKS. Aggregate count above
threshold = fail.

Cheap: streams JSONL line by line, only inspects the first ~1KB of
expectedResponse to find the thought line, never touches the bun TOON
decoder.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(sys.argv[1])
THRESHOLD = int(sys.argv[2])
DETAIL_OUT = Path(sys.argv[3])

sys.path.insert(0, str(ROOT))
from scripts.lib.eliza_record import (  # noqa: E402
    DEFAULT_THOUGHT_LEAKS, is_default_thought_leak,
)

leak_counter: Counter = Counter()
per_split: dict[str, dict] = {}
total_leaks = 0
total_records = 0

for name in ("train.jsonl", "val.jsonl", "test.jsonl"):
    path = ROOT / "data" / "final" / name
    n_recs = 0
    n_leaks = 0
    if not path.exists():
        per_split[name] = {"path": str(path), "missing": True,
                           "records": 0, "leaks": 0}
        continue
    with path.open("rb") as f:
        for raw in f:
            n_recs += 1
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            er = rec.get("expectedResponse") or ""
            if not er:
                continue
            head = er[:1024]
            for line in head.splitlines():
                s = line.strip()
                if s.startswith("thought:") or s.startswith('"thought":'):
                    key = "thought:" if s.startswith("thought:") else '"thought":'
                    v = s[len(key):].strip()
                    if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
                        v = v[1:-1]
                    if is_default_thought_leak(v):
                        n_leaks += 1
                        leak_counter[v.strip()] += 1
                    break
    per_split[name] = {"path": str(path), "records": n_recs, "leaks": n_leaks}
    total_leaks += n_leaks
    total_records += n_recs

detail = {
    "threshold": THRESHOLD,
    "total_records": total_records,
    "total_leaks": total_leaks,
    "by_split": per_split,
    "by_phrase": dict(sorted(leak_counter.items(), key=lambda kv: -kv[1])),
    "leak_literals": list(DEFAULT_THOUGHT_LEAKS),
}
DETAIL_OUT.write_text(json.dumps(detail, separators=(",", ":")))

print(f"  scanned={total_records}  leaks={total_leaks}  "
      f"threshold={THRESHOLD}", file=sys.stderr)
if total_leaks > THRESHOLD:
    print(
        f"FAIL: {total_leaks} default-thought leak literals found in "
        f"data/final/ (threshold {THRESHOLD}). These records train the "
        f"model to emit phrases like {DEFAULT_THOUGHT_LEAKS[0]!r} "
        f"verbatim. Remediate with:\n"
        f"  .venv/bin/python scripts/transform_fix_default_thoughts.py",
        file=sys.stderr,
    )
    sys.exit(1)
sys.exit(0)
PY
then
  log_ok "default-thought leak count under threshold"
  record default_thought_leak pass "$(cat "$LEAK_DETAIL_FILE")"
else
  log_err "default-thought leak count exceeds threshold ${LEAK_THRESHOLD}"
  log_err "Fix:  .venv/bin/python scripts/transform_fix_default_thoughts.py"
  log_err "      then mv data/intermediate/train_thought_fixed.jsonl data/final/train.jsonl"
  detail_json="$(cat "$LEAK_DETAIL_FILE" 2>/dev/null || echo '{}')"
  record default_thought_leak fail "$detail_json"
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────
# All eight checks passed — write summary
# ──────────────────────────────────────────────────────────────────────
TS_EPOCH="$(date +%s)"
TS_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

uv run --extra train python - "$SUMMARY_TMP" "$SUMMARY_FILE" "$TS_EPOCH" "$TS_ISO" \
                                "$REGISTRY_KEY" "$VAST_GPU_TARGET" <<'PY'
"""Wrap per-check JSON records into the final .preflight.ok summary.

The bash record() helper emits one line per check, but printf line-buffers
them and the embedded `detail` objects can contain {}-balanced sequences
that look like JSONL boundaries. Use json.JSONDecoder.raw_decode() in a
loop to greedily parse one object at a time, ignoring whitespace between
them — robust to either form.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

tmp = Path(sys.argv[1])
out = Path(sys.argv[2])
ts_epoch = int(sys.argv[3])
ts_iso = sys.argv[4]
registry_key = sys.argv[5]
gpu_target = sys.argv[6]

raw = tmp.read_text()
decoder = json.JSONDecoder()
checks: dict[str, dict] = {}
i = 0
n = len(raw)
while i < n:
    while i < n and raw[i] in " \t\r\n":
        i += 1
    if i >= n:
        break
    obj, end = decoder.raw_decode(raw, i)
    checks[obj["name"]] = {"status": obj["status"], "detail": obj["detail"]}
    i = end

summary = {
    "timestamp_epoch": ts_epoch,
    "timestamp": ts_iso,
    "registry_key": registry_key,
    "gpu_target": gpu_target,
    "checks": checks,
}
out.write_text(json.dumps(summary, indent=2))
PY

log "PASS — all 8 checks green. Wrote $SUMMARY_FILE"
log "      registry-key=$REGISTRY_KEY gpu-target=$VAST_GPU_TARGET"
log "      next: bash scripts/train_vast.sh provision"
