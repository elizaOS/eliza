#!/usr/bin/env bash
# End-to-end finalizer: repair → normalize → build v2 → audit.
# Run after all synth files are populated. Idempotent.
set -euo pipefail

cd "$(dirname "$0")/.."

echo ">>> Step 1/5: native JSON repair on every synth file"
for f in data/synthesized/evaluators/*.jsonl data/synthesized/phase3/*.jsonl; do
  [ -s "$f" ] || continue
  python3 scripts/transform_repair_payload_bullets.py --input "$f" --output "$f" 2>&1 | tail -1
done

echo
echo ">>> Step 2/5: fact_extractor op normalization"
if [ -s data/synthesized/evaluators/fact_extractor.jsonl ]; then
  python3 scripts/transform_normalize_fact_ops.py \
    --input  data/synthesized/evaluators/fact_extractor.jsonl \
    --output data/synthesized/evaluators/fact_extractor.jsonl 2>&1 | tail -1
fi

echo
echo ">>> Step 3/5: per-evaluator + per-action audit"
python3 scripts/audit_pipeline_shapes.py --data-dir data/synthesized/evaluators \
  --out-md previews/AUDIT_EVAL_FINAL.md --out-json previews/audit_eval_final.json 2>&1 | tail -2
python3 scripts/audit_pipeline_shapes.py --data-dir data/synthesized/phase3 \
  --out-md previews/AUDIT_PHASE3_FINAL.md --out-json previews/audit_phase3_final.json 2>&1 | tail -2
echo "  evaluators:" && grep "^| \`" previews/AUDIT_EVAL_FINAL.md | head -10
echo "  phase3:"      && grep "^| \`" previews/AUDIT_PHASE3_FINAL.md | head -10

echo
echo ">>> Step 4/5: build v2 corpus"
python3 scripts/build_v2_corpus.py \
  --input    data/final/train.jsonl \
  --synth-dir data/synthesized \
  --output   data/final/train_v2.jsonl \
  --manifest data/final/manifest_v2.json 2>&1 | tail -10

echo
echo ">>> Step 5/5: v2 manifest summary"
python3 -c "
import json, pathlib
m = json.loads(pathlib.Path('data/final/manifest_v2.json').read_text())
print('v2_total:', m.get('v2_total'))
print('phase_distribution_pct:', m.get('phase_distribution_pct'))
print('synth_records_added:', m.get('synth_records_added'))
print('v1_dropped:', m.get('v1_dropped'))
"
