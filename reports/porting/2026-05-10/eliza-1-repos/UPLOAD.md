# Eliza-1 placeholder repos — upload commands

These directories are README + manifest only. Each will become a real
elizaos HF repo once W5-Pipeline drops the corresponding fused GGUF
into the directory. The publisher refuses to push a zero-byte GGUF, so
the placeholders cannot accidentally ship.

## Prerequisites

- `HF_TOKEN` with write access to https://huggingface.co/elizaos
- `huggingface_hub[cli]` installed (`uv pip install "huggingface_hub[cli]>=0.24"`)

## Per-repo upload commands

```bash
# qwen3.5-4b-optimized
uv run python packages/training/scripts/publish_eliza1_model.py \
    --model-dir reports/porting/2026-05-10/eliza-1-repos/qwen3.5-4b-optimized \
    --repo-id elizaos/qwen3.5-4b-optimized \
    --dry-run  # smoke first; drop --dry-run for the real push

# qwen3.5-4b-drafter
uv run python packages/training/scripts/publish_eliza1_model.py \
    --model-dir reports/porting/2026-05-10/eliza-1-repos/qwen3.5-4b-drafter \
    --repo-id elizaos/qwen3.5-4b-drafter \
    --dry-run  # smoke first; drop --dry-run for the real push

# qwen3.5-9b-optimized
uv run python packages/training/scripts/publish_eliza1_model.py \
    --model-dir reports/porting/2026-05-10/eliza-1-repos/qwen3.5-9b-optimized \
    --repo-id elizaos/qwen3.5-9b-optimized \
    --dry-run  # smoke first; drop --dry-run for the real push

# qwen3.5-9b-drafter
uv run python packages/training/scripts/publish_eliza1_model.py \
    --model-dir reports/porting/2026-05-10/eliza-1-repos/qwen3.5-9b-drafter \
    --repo-id elizaos/qwen3.5-9b-drafter \
    --dry-run  # smoke first; drop --dry-run for the real push

# qwen3.6-27b-optimized
uv run python packages/training/scripts/publish_eliza1_model.py \
    --model-dir reports/porting/2026-05-10/eliza-1-repos/qwen3.6-27b-optimized \
    --repo-id elizaos/qwen3.6-27b-optimized \
    --dry-run  # smoke first; drop --dry-run for the real push

# qwen3.6-27b-drafter
uv run python packages/training/scripts/publish_eliza1_model.py \
    --model-dir reports/porting/2026-05-10/eliza-1-repos/qwen3.6-27b-drafter \
    --repo-id elizaos/qwen3.6-27b-drafter \
    --dry-run  # smoke first; drop --dry-run for the real push

# bonsai-8b-1bit-optimized
uv run python packages/training/scripts/publish_eliza1_model.py \
    --model-dir reports/porting/2026-05-10/eliza-1-repos/bonsai-8b-1bit-optimized \
    --repo-id elizaos/bonsai-8b-1bit-optimized \
    --dry-run  # smoke first; drop --dry-run for the real push

# eliza-1-2b-optimized
uv run python packages/training/scripts/publish_eliza1_model.py \
    --model-dir reports/porting/2026-05-10/eliza-1-repos/eliza-1-2b-optimized \
    --repo-id elizaos/eliza-1-2b-optimized \
    --dry-run  # smoke first; drop --dry-run for the real push

# eliza-1-9b-optimized
uv run python packages/training/scripts/publish_eliza1_model.py \
    --model-dir reports/porting/2026-05-10/eliza-1-repos/eliza-1-9b-optimized \
    --repo-id elizaos/eliza-1-9b-optimized \
    --dry-run  # smoke first; drop --dry-run for the real push

# eliza-1-27b-optimized
uv run python packages/training/scripts/publish_eliza1_model.py \
    --model-dir reports/porting/2026-05-10/eliza-1-repos/eliza-1-27b-optimized \
    --repo-id elizaos/eliza-1-27b-optimized \
    --dry-run  # smoke first; drop --dry-run for the real push

```

## Bulk publish

```bash
for dir in reports/porting/2026-05-10/eliza-1-repos/*/; do
  name=$(basename "$dir")
  [ "$name" = "UPLOAD.md" ] && continue
  uv run python packages/training/scripts/publish_eliza1_model.py \
      --model-dir "$dir" \
      --repo-id "elizaos/$name"
done
```

## After upload

Refresh the catalog diff and run the phone-equivalent download check:

```bash
uv run python packages/training/scripts/sync_catalog_from_hf.py \
    --org elizaos \
    --out reports/porting/$(date -u +%Y-%m-%d)/catalog-diff.json
node scripts/verify-phone-download.mjs --diff-first \
    --model-id qwen3.5-4b-optimized
```
