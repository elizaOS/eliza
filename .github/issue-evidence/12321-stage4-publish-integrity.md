# Stage 4 Publish Integrity Evidence

Issue: #12321

## Scope Exercised

- Manifest construction reads `general.architecture` from GGUF bytes, records it on text files, derives tokenizer family from that byte-level source, and blocks publish-ready non-Gemma text GGUFs.
- Publish orchestration binds recorded GPU verification and eval reports to the current commit and shipped text GGUF SHA-256s, requires device evidence, removes eval alias bypasses, and runs the live HF release audit after upload/final evidence promotion before tagging.
- Removed stale release bypass paths for the Eliza-1 publish flow: runtime publish-status env override, per-tier `--allow-missing`, `--skip-hash-verify`, verification-queue `--summary-json`, wrapper forwarding of those flags, and legacy `--mode optimized` dispatch.
- Fixed the `27b-256k` orchestrator metadata path by adding its tagline and RAM budget.

## Commands Run

```bash
uv run --project packages/training --with pytest -- python -m pytest \
  packages/training/scripts/manifest/test_eliza1_manifest.py \
  packages/training/scripts/manifest/test_audit_hf_eliza1_release.py \
  packages/training/scripts/manifest/test_release_verification_queue.py \
  packages/training/scripts/publish/test_orchestrator.py \
  packages/training/scripts/publish/test_publish_eliza1_model_repo.py \
  packages/training/scripts/publish/test_publish_model.py \
  packages/training/scripts/test_emit_eliza1_catalog.py
```

Result: `228 passed, 1 warning in 41.02s`.

```bash
python -m py_compile \
  packages/training/scripts/manifest/eliza1_manifest.py \
  packages/training/scripts/manifest/audit_hf_eliza1_release.py \
  packages/training/scripts/manifest/stage_real_eliza1_bundle.py \
  packages/training/scripts/manifest/stage_local_eliza1_bundle.py \
  packages/training/scripts/manifest/release_verification_queue.py \
  packages/training/scripts/emit_eliza1_catalog.py \
  packages/training/scripts/sync_catalog_from_hf.py \
  packages/training/scripts/publish/orchestrator.py \
  packages/training/scripts/publish/publish_eliza1_model_repo.py \
  packages/training/scripts/publish/publish_model.py \
  packages/training/scripts/publish/stage_base_v1_candidate.py \
  packages/training/scripts/publish/test_orchestrator.py \
  packages/training/scripts/publish/test_publish_model.py
```

Result: passed.

```bash
node --check packages/training/scripts/publish/eliza1-hf-stage.mjs
bash -n packages/training/scripts/publish/eliza1-hf-push.sh
git diff --check
```

Result: passed.

## Manual Review Notes

- Reviewed issue #12321 and scoped this chunk to publish/manifest integrity files only.
- No screenshots, screen recordings, audio, or live-LLM trajectories apply to this CLI/publish-gate-only slice.

## Remaining Real-World Evidence Blockers

- A live Hugging Face upload/audit was not run in this workspace because no production Hugging Face publish was performed here.
- `publish_all_eliza1.sh --filter-tier 27b-256k --dry-run` was not run against a full real 27b-256k release bundle in this workspace; the path is covered by orchestrator metadata/tests rather than a production bundle transcript.
- Real qwen35 and Gemma release GGUFs were not downloaded for this run; byte-architecture behavior is covered by GGUF-header fixtures in the manifest and HF audit tests.
