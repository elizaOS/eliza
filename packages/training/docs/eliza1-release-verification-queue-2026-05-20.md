# Eliza-1 release verification queue — 2026-05-20

Live HF audit:

- `ok`: `false`
- `failedCheckCount`: `23`
- summary JSON: `/tmp/eliza-1-hf-audit-current.json`

Generated queue:

- JSON: `/tmp/eliza-1-verification-queue-current.json`
- Markdown: `/tmp/eliza-1-verification-queue-current.md`
- total items: `45`
- local-only items: `0`

Queue categories:

- `backendVerification`: `8`
- `platformEvidence`: `24`
- `mtpDrafter`: `5`
- `imagegenEvidence`: `1`
- `fineTuneComparison`: `1`
- `releaseEvidence`: `6`

All remaining queue items require real hardware, cloud training, or final
release artifacts. The current audit has no bookkeeping-only failure that can
be cleared honestly from this Mac.

Known remaining blockers:

- CUDA/ROCm backend verification for larger tiers.
- CUDA imagegen stable-diffusion.cpp runtime smoke.
- Required iOS, Android, Linux, and Windows platform evidence.
- Active `0_8b` fine-tuned artifact plus baseline-vs-finetuned comparison
  reports.
- MTP drafter validation, acceptance, and speedup evidence for `2b`, `4b`,
  `9b`, `27b`, and `27b-256k`.
- Final release evidence promotion after the above gates pass.

Commands used:

```bash
python3 packages/training/scripts/manifest/audit_hf_eliza1_release.py \
  --summary > /tmp/eliza-1-hf-audit-current.json

python3 packages/training/scripts/manifest/release_verification_queue.py \
  --summary-json /tmp/eliza-1-hf-audit-current.json \
  --format json > /tmp/eliza-1-verification-queue-current.json

python3 packages/training/scripts/manifest/release_verification_queue.py \
  --summary-json /tmp/eliza-1-hf-audit-current.json \
  --format markdown --limit 80 > /tmp/eliza-1-verification-queue-current.md
```
