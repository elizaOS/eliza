#!/usr/bin/env bash
# Full quality pipeline: applies all corpus transforms in order to whatever
# train.jsonl / train_final.jsonl currently contains.
#
# Run after `pack_dataset.py` rebuilds the raw aggregated corpus, or any
# time you want to re-apply the full deslop chain.
#
# Steps (each writes a new file or rewrites in-place; intermediates are
# deleted after the next step succeeds to save disk):
#   1. rewrites/run_all.py        — fix 5 problem sources (mcp-routing,
#                                    openclaw-operator, etc.)
#   2. transform_corpus_cleanup   — strip wrapper tokens from expectedResponse
#   3. transform_cleanup_memoryentries — strip wrappers from memoryEntries
#   4. transform_deslop_assistant — short replies, drop "You are a..." opens,
#                                    drop trailing-question slop
#   5. transform_caveman_thoughts — caveman-compress the thought: field
#   6. transform_ngram_diversify  — paraphrase top n-grams
#   7. integrate.py               — merge harness + scambench
#   8. transform_casual_reply_shorten — casual replies: diversify "You're
#                                    welcome!", strip lead/tail slop, cap at 250
#   9. transform_task_reply_deslop — task replies: strip "Hello! I'd...",
#                                    "Sure, here", "Apologies, but", etc.
#  10. transform_unquoted_text_deslop — same but for unquoted native JSON text values
#  11. transform_strip_residual_openers — final pass for residual social
#                                    openers like "You're welcome! Now..."
#  12. transform_diversify_standalone_thanks — diversify all remaining
#                                    standalone "You're welcome!" replies
#  13. transform_strip_think_in_text — strip <think> tag slop from text fields
#
# Usage:
#   bash scripts/run_full_quality_pipeline.sh
#
# Environment:
#   ELIZA_INTEGRATE_TRIVIAL=1   integrate round-3 thought replacements (req:
#                                round-3 finished)

set -euo pipefail
cd "$(dirname "$0")/.."

DATA="data/final"

step() { echo; echo "[$(date '+%H:%M:%S')] $*"; df -h /home | tail -1; }

require_input() {
  local f="$1"
  if [[ ! -e "$f" ]]; then
    echo "[error] required input missing: $f"; exit 1
  fi
}

# Pre: handle the case where train.jsonl is a symlink to train_final.jsonl
# (state pack_dataset.py leaves us in). We need them to be distinct files
# because the pipeline reads train.jsonl and writes train_final.jsonl.
if [[ -L "$DATA/train.jsonl" ]]; then
  step "untangle train.jsonl symlink"
  target=$(readlink "$DATA/train.jsonl")
  rm "$DATA/train.jsonl"
  if [[ "$target" == "train_final.jsonl" && -e "$DATA/train_final.jsonl" ]]; then
    mv "$DATA/train_final.jsonl" "$DATA/train.jsonl"
  fi
fi

# NOTE: most transform_*.py scripts have HARDCODED input/output paths and
# ignore CLI flags. The pipeline threads files via `mv` between steps, and
# preserves the original raw train.jsonl as train_orig.jsonl until step 6
# completes.

# Step 1: rewrites (reads train.jsonl, writes train_rewritten.jsonl)
require_input "$DATA/train.jsonl"
step "rewrites/run_all.py"
python3 scripts/rewrites/run_all.py
require_input "$DATA/train_rewritten.jsonl"
# Stash the original; corpus_cleanup reads from train.jsonl
mv "$DATA/train.jsonl" "$DATA/train_orig.jsonl"
mv "$DATA/train_rewritten.jsonl" "$DATA/train.jsonl"

# Step 2: corpus cleanup (reads train.jsonl → writes train_cleaned.jsonl)
step "transform_corpus_cleanup"
python3 scripts/transform_corpus_cleanup.py
require_input "$DATA/train_cleaned.jsonl"
# Restore the raw corpus; cleanup_memoryentries reads pre_memoryentries
mv "$DATA/train.jsonl" "$DATA/train_rewritten.jsonl"
mv "$DATA/train_orig.jsonl" "$DATA/train.jsonl"
mv "$DATA/train_cleaned.jsonl" "$DATA/train_cleaned_pre_memoryentries.jsonl"
rm -f "$DATA/train_rewritten.jsonl"

# Step 3: memoryEntries gap cleanup
# (reads train_cleaned_pre_memoryentries.jsonl → writes train_cleaned.jsonl)
step "transform_cleanup_memoryentries"
python3 scripts/transform_cleanup_memoryentries.py
require_input "$DATA/train_cleaned.jsonl"
rm -f "$DATA/train_cleaned_pre_memoryentries.jsonl"

# Step 4: deslop assistant text
step "transform_deslop_assistant"
python3 scripts/transform_deslop_assistant.py
rm -f "$DATA/train_cleaned.jsonl"

# Step 5: caveman thoughts
step "transform_caveman_thoughts"
python3 scripts/transform_caveman_thoughts.py
rm -f "$DATA/train_deslopped.jsonl"

# Step 6: n-gram diversify
step "transform_ngram_diversify"
python3 scripts/transform_ngram_diversify.py
rm -f "$DATA/train_caveman.jsonl"

# Step 7: integrate (merge harness + scambench → train_final.jsonl)
step "integrate.py"
python3 scripts/integrate.py
rm -f "$DATA/train_diversified.jsonl"
require_input "$DATA/train_final.jsonl"

# Steps 8-13: in-place rewrites of train_final.jsonl
step "transform_casual_reply_shorten"
python3 scripts/transform_casual_reply_shorten.py

step "transform_task_reply_deslop"
python3 scripts/transform_task_reply_deslop.py

step "transform_unquoted_text_deslop"
python3 scripts/transform_unquoted_text_deslop.py

step "transform_strip_residual_openers"
python3 scripts/transform_strip_residual_openers.py

step "transform_diversify_standalone_thanks"
python3 scripts/transform_diversify_standalone_thanks.py

step "transform_strip_think_in_text"
python3 scripts/transform_strip_think_in_text.py

step "done"
ls -lh "$DATA"/
df -h /home | tail -1
