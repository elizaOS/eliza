#!/usr/bin/env bash
# End-to-end smoke for the corpus-quality chain.
#
# Exercises every link in the runtime-phase enforcement pipeline:
#   1. Phase-4 evaluator synthesizer  (--dry-run)
#   2. Phase-3 action synthesizer     (--dry-run)
#   3. Classifier                     (each dry-run output → expected phase)
#   4. Audit                          (--strict-phases against an OOB fixture)
#   5. Reasoning-cot transform        (--mode reshape on a small fixture)
#   6. Claude-distill transform       (round-trip on a small fixture)
#
# A failure of any step exits non-zero. The CI runs this; locally it can
# be run with `bash scripts/ci_smoke_e2e.sh` from the training package.
#
# Designed to need NO external network and NO GPU.

set -euo pipefail
cd "$(dirname "$0")/.."

PY=${PY:-python3}
WORK=$(mktemp -d -t milady-ci-XXXXXX)
trap 'rm -rf "$WORK"' EXIT

step() { echo; echo "[ci-smoke] $*"; }
fail() { echo "[ci-smoke] FAIL: $*" >&2; exit 1; }

# ─────────────────────────────────────────────────────────────────────
step "1. Phase-4 evaluator synthesizer dry-run"
"$PY" scripts/synthesize_evaluator_prompts.py --dry-run --out "$WORK/eval/" >/dev/null
EVAL_FILES=("reflection.jsonl" "reflection_evaluator.jsonl" "fact_extractor.jsonl"
            "summarization.jsonl" "long_term_extraction.jsonl")
for f in "${EVAL_FILES[@]}"; do
  [[ -f "$WORK/eval/$f" ]] || fail "missing $WORK/eval/$f"
done

# ─────────────────────────────────────────────────────────────────────
step "2. Phase-3 action synthesizer dry-run"
"$PY" scripts/synthesize_phase3_actions.py --dry-run --out "$WORK/p3/" >/dev/null
P3_FILES=("reply.jsonl" "remove_contact.jsonl" "extract_option.jsonl"
          "extract_secret_operation.jsonl" "extract_secret_request.jsonl"
          "post_creation.jsonl" "post_action_decision.jsonl")
for f in "${P3_FILES[@]}"; do
  [[ -f "$WORK/p3/$f" ]] || fail "missing $WORK/p3/$f"
done

# ─────────────────────────────────────────────────────────────────────
step "3. Classifier — each evaluator file should be 100% Phase 4"
for f in "${EVAL_FILES[@]}"; do
  out="$WORK/cls_eval_${f%.jsonl}/"
  "$PY" scripts/classify_records_by_phase.py --input "$WORK/eval/$f" --out "$out" >/dev/null
  pct=$("$PY" -c "import json; d=json.load(open('$out/phase_coverage.json')); print(d['phase_counts'].get('4',0))")
  total=$("$PY" -c "import json; d=json.load(open('$out/phase_coverage.json')); print(d['total'])")
  [[ "$pct" == "$total" ]] || fail "$f: expected all $total Phase-4, got $pct"
done

step "3b. Classifier — Phase-3 files (except reply) should be 100% Phase 3"
for f in remove_contact.jsonl extract_option.jsonl extract_secret_operation.jsonl \
         extract_secret_request.jsonl post_creation.jsonl post_action_decision.jsonl; do
  out="$WORK/cls_p3_${f%.jsonl}/"
  "$PY" scripts/classify_records_by_phase.py --input "$WORK/p3/$f" --out "$out" >/dev/null
  pct=$("$PY" -c "import json; d=json.load(open('$out/phase_coverage.json')); print(d['phase_counts'].get('3',0))")
  total=$("$PY" -c "import json; d=json.load(open('$out/phase_coverage.json')); print(d['total'])")
  [[ "$pct" == "$total" ]] || fail "$f: expected all $total Phase-3, got $pct"
done
# reply.jsonl is structurally Phase 2 because the canonical reply task_type
# lives in PHASE_2_RESPONSE — see lib/runtime_phases.py.
out="$WORK/cls_p3_reply/"
"$PY" scripts/classify_records_by_phase.py --input "$WORK/p3/reply.jsonl" --out "$out" >/dev/null
pct=$("$PY" -c "import json; d=json.load(open('$out/phase_coverage.json')); print(d['phase_counts'].get('2',0))")
total=$("$PY" -c "import json; d=json.load(open('$out/phase_coverage.json')); print(d['total'])")
[[ "$pct" == "$total" ]] || fail "reply.jsonl: expected all $total Phase-2, got $pct"

# ─────────────────────────────────────────────────────────────────────
step "4. Audit --strict-phases against an OOB fixture"
mkdir -p "$WORK/strict/data/normalized"
cp "$WORK/eval/reflection_evaluator.jsonl" "$WORK/strict/data/normalized/synth_ref_eval.jsonl"
# OOB record (reasoning_cot)
"$PY" -c "
import json
rec = {
  'roomName': 'oob1', 'agentId': 'a',
  'memoryEntries': [],
  'currentMessage': {'role':'user','speaker':'u','content':'q','channel':'dm'},
  'expectedResponse': 'thought: x\ntext: y',
  'availableActions': ['REPLY'],
  'metadata': {'task_type':'reasoning_cot','source_dataset':'smoke'}
}
print(json.dumps(rec))" > "$WORK/strict/data/normalized/oob_smoke.jsonl"

set +e
"$PY" scripts/audit_pipeline_shapes.py --data-dir "$WORK/strict/data/normalized" \
  --out-md "$WORK/strict/AUDIT.md" --out-json "$WORK/strict/audit.json" \
  --strict-phases > "$WORK/strict/audit.log" 2>&1
rc=$?
set -e
[[ "$rc" == "2" ]] || fail "audit --strict-phases should exit 2 on OOB; got rc=$rc"

# Same dir without strict should exit 0
set +e
"$PY" scripts/audit_pipeline_shapes.py --data-dir "$WORK/strict/data/normalized" \
  --out-md "$WORK/strict/AUDIT2.md" --out-json "$WORK/strict/audit2.json" \
  > "$WORK/strict/audit2.log" 2>&1
rc=$?
set -e
[[ "$rc" == "0" ]] || fail "audit without --strict-phases should exit 0 even with OOB; got rc=$rc"

# ─────────────────────────────────────────────────────────────────────
step "5. Reasoning-cot transform — reshape mode round-trip"
"$PY" -c "
import json
recs = []
for i in range(3):
  recs.append({
    'roomName': f'rc{i}', 'agentId': 'a',
    'memoryEntries': [],
    'currentMessage': {'role':'user','speaker':'u','content':f'question {i}','channel':'dm'},
    'expectedResponse': f'<think>step {i} reasoning</think>final answer {i}',
    'availableActions': ['REPLY'],
    'metadata': {'task_type':'reasoning_cot','source_dataset':'kimi'}
  })
import sys
sys.stdout.write('\n'.join(json.dumps(r) for r in recs) + '\n')
" > "$WORK/rc_in.jsonl"
"$PY" scripts/transform_reasoning_cot.py --input "$WORK/rc_in.jsonl" --mode reshape --output "$WORK/rc_out.jsonl" >/dev/null
n_out=$(wc -l < "$WORK/rc_out.jsonl")
[[ "$n_out" == "3" ]] || fail "reasoning_cot reshape: expected 3 lines, got $n_out"
"$PY" scripts/classify_records_by_phase.py --input "$WORK/rc_out.jsonl" --out "$WORK/rc_phase/" >/dev/null
p2=$("$PY" -c "import json; d=json.load(open('$WORK/rc_phase/phase_coverage.json')); print(d['phase_counts'].get('2',0))")
[[ "$p2" == "3" ]] || fail "reasoning_cot reshape should land in Phase 2; got p2=$p2"

# ─────────────────────────────────────────────────────────────────────
step "6. Claude-distill transform — round-trip"
"$PY" -c "
import json
recs = []
for i in range(3):
  recs.append({
    'roomName': f'cd{i}', 'agentId': 'a',
    'memoryEntries': [],
    'currentMessage': {'role':'user','speaker':'u','content':f'q{i}','channel':'dm'},
    'expectedResponse': f'<think>my reasoning {i}</think>The answer is {i*7}.',
    'availableActions': ['REPLY'],
    'metadata': {'task_type':'claude_distill','source_dataset':'claude-distills'}
  })
import sys
sys.stdout.write('\n'.join(json.dumps(r) for r in recs) + '\n')
" > "$WORK/cd_in.jsonl"
"$PY" scripts/transform_claude_distill_to_reply.py --input "$WORK/cd_in.jsonl" --output "$WORK/cd_out.jsonl" >/dev/null
n_out=$(wc -l < "$WORK/cd_out.jsonl")
[[ "$n_out" == "3" ]] || fail "claude_distill: expected 3 lines, got $n_out"
"$PY" scripts/classify_records_by_phase.py --input "$WORK/cd_out.jsonl" --out "$WORK/cd_phase/" >/dev/null
p2=$("$PY" -c "import json; d=json.load(open('$WORK/cd_phase/phase_coverage.json')); print(d['phase_counts'].get('2',0))")
[[ "$p2" == "3" ]] || fail "claude_distill: expected 3 Phase-2 records; got p2=$p2"

# ─────────────────────────────────────────────────────────────────────
echo
echo "[ci-smoke] OK — all 6 phases of the corpus-quality chain passed"
