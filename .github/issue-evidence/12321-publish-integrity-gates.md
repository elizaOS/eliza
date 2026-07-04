# Release Verification Queue Integrity Evidence

Issue: #12321

## Scope Exercised

- Removed saved-summary input from the verification queue CLI so queue
  generation uses the live HF release audit instead of an operator-supplied
  stale or forged audit summary.
- The per-tier `--allow-missing` and `--skip-hash-verify` bypass removals
  landed separately in #12768; this branch was rebased over that work.

## Commands Run

```bash
python3 -m py_compile \
  packages/training/scripts/manifest/release_verification_queue.py \
  packages/training/scripts/publish/publish_eliza1_model_repo.py
node --check packages/training/scripts/publish/eliza1-hf-stage.mjs
bash -n packages/training/scripts/publish/eliza1-hf-push.sh
git diff --check origin/develop..HEAD
```

Result: passed.

```bash
uv run --project packages/training --with pytest -- python -m pytest \
  packages/training/scripts/publish/test_publish_eliza1_model_repo.py \
  packages/training/scripts/manifest/test_release_verification_queue.py -q
```

Result after rebase over #12768: `32 passed`.

## N/A Evidence

- Screenshots, recordings, audio, and live-LLM trajectories are not applicable;
  this change only affects CLI publish gate behavior.
- No live Hugging Face upload was performed.
