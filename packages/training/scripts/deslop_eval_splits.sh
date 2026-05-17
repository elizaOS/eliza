#!/usr/bin/env bash
# Apply the full deslop chain (minus integrate) to val.jsonl and test.jsonl
# for eval-set consistency with train_final.jsonl. The transforms have
# hardcoded SRC paths, so we file-swap each split into train.jsonl /
# train_final.jsonl positions while running.
#
# Steps applied to each split:
#   1. rewrites/run_all.py            (train.jsonl → train_rewritten.jsonl)
#   2. transform_corpus_cleanup       (train.jsonl → train_cleaned.jsonl,
#                                      after temporarily mv'ing rewritten in)
#   3. transform_cleanup_memoryentries (train_cleaned_pre_memoryentries → train_cleaned)
#   4. transform_deslop_assistant     (train_cleaned → train_deslopped)
#   5. transform_caveman_thoughts     (train_deslopped → train_caveman)
#   6. transform_ngram_diversify      (train_caveman → train_diversified)
#   --- skip integrate (no harness/scambench mixing for eval splits) ---
#   In-place polish on resulting file (renamed → train_final.jsonl):
#   7. transform_casual_reply_shorten
#   8. transform_task_reply_deslop
#   9. transform_unquoted_text_deslop
#   10. transform_strip_residual_openers
#   11. transform_diversify_standalone_thanks
#   12. transform_strip_think_in_text
#   13. transform_strip_trailing_offers

set -euo pipefail
cd "$(dirname "$0")/.."

DATA="data/final"

step() { echo; echo "[$(date '+%H:%M:%S')] $*"; }

process_split() {
  local name="$1"
  local src="$DATA/${name}.jsonl"
  if [[ ! -f "$src" ]]; then
    echo "[skip] $src missing"; return
  fi
  echo
  echo "=================================================================="
  echo "===== Processing $name.jsonl ($(ls -lh $src | awk '{print $5}'))"
  echo "=================================================================="

  # Stash production train.jsonl + train_final.jsonl
  [[ -e "$DATA/train.jsonl" ]] && mv "$DATA/train.jsonl" "$DATA/train.jsonl.stash"
  [[ -e "$DATA/train_final.jsonl" ]] && mv "$DATA/train_final.jsonl" "$DATA/train_final.jsonl.stash"

  # Place split as train.jsonl
  mv "$src" "$DATA/train.jsonl"

  # === Pre-integrate chain (mirrors run_full_quality_pipeline.sh) ===
  step "[$name] rewrites/run_all.py"
  python3 scripts/rewrites/run_all.py
  mv "$DATA/train.jsonl" "$DATA/train_orig.jsonl"
  mv "$DATA/train_rewritten.jsonl" "$DATA/train.jsonl"

  step "[$name] transform_corpus_cleanup"
  python3 scripts/transform_corpus_cleanup.py
  mv "$DATA/train.jsonl" "$DATA/train_rewritten.jsonl"
  mv "$DATA/train_orig.jsonl" "$DATA/train.jsonl"
  mv "$DATA/train_cleaned.jsonl" "$DATA/train_cleaned_pre_memoryentries.jsonl"
  rm -f "$DATA/train_rewritten.jsonl"

  step "[$name] transform_cleanup_memoryentries"
  python3 scripts/transform_cleanup_memoryentries.py
  rm -f "$DATA/train_cleaned_pre_memoryentries.jsonl"

  step "[$name] transform_deslop_assistant"
  python3 scripts/transform_deslop_assistant.py
  rm -f "$DATA/train_cleaned.jsonl"

  step "[$name] transform_caveman_thoughts"
  python3 scripts/transform_caveman_thoughts.py
  rm -f "$DATA/train_deslopped.jsonl"

  step "[$name] transform_ngram_diversify"
  python3 scripts/transform_ngram_diversify.py
  rm -f "$DATA/train_caveman.jsonl"

  # Promote to train_final.jsonl (skip integrate — eval splits get no harness)
  mv "$DATA/train_diversified.jsonl" "$DATA/train_final.jsonl"

  # === In-place polish ===
  step "[$name] transform_casual_reply_shorten"
  python3 scripts/transform_casual_reply_shorten.py

  step "[$name] transform_task_reply_deslop"
  python3 scripts/transform_task_reply_deslop.py

  step "[$name] transform_unquoted_text_deslop"
  python3 scripts/transform_unquoted_text_deslop.py

  step "[$name] transform_strip_residual_openers"
  python3 scripts/transform_strip_residual_openers.py

  step "[$name] transform_diversify_standalone_thanks"
  python3 scripts/transform_diversify_standalone_thanks.py

  step "[$name] transform_strip_think_in_text"
  python3 scripts/transform_strip_think_in_text.py

  step "[$name] transform_strip_trailing_offers"
  python3 scripts/transform_strip_trailing_offers.py

  # Restore: move processed result back to the split name
  mv "$DATA/train_final.jsonl" "$src"
  rm -f "$DATA/train.jsonl"  # was the unmodified copy, no longer needed

  # Restore stashed production files
  [[ -e "$DATA/train.jsonl.stash" ]] && mv "$DATA/train.jsonl.stash" "$DATA/train.jsonl"
  [[ -e "$DATA/train_final.jsonl.stash" ]] && mv "$DATA/train_final.jsonl.stash" "$DATA/train_final.jsonl"

  echo
  ls -lh "$src"
}

process_split "val"
process_split "test"

echo
echo "=== eval splits processed ==="
ls -lh "$DATA"/val.jsonl "$DATA"/test.jsonl "$DATA"/train_final.jsonl
df -h /home | tail -1
