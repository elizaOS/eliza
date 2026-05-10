# Milady-AI placeholder repos — upload commands

These directories are README + manifest only. Each will become a real
milady-ai HF repo once W5-Pipeline drops the corresponding fused GGUF
into the directory. The publisher refuses to push a zero-byte GGUF, so
the placeholders cannot accidentally ship.

## Prerequisites

- `HF_TOKEN` with write access to https://huggingface.co/milady-ai
- `huggingface_hub[cli]` installed (`uv pip install "huggingface_hub[cli]>=0.24"`)

## Per-repo upload commands

```bash
# qwen3.5-4b-milady-optimized
uv run python packages/training/scripts/publish_milady_model.py \
    --model-dir reports/porting/2026-05-10/milady-ai-repos/qwen3.5-4b-milady-optimized \
    --repo-id milady-ai/qwen3.5-4b-milady-optimized \
    --dry-run  # smoke first; drop --dry-run for the real push

# qwen3.5-4b-milady-drafter
uv run python packages/training/scripts/publish_milady_model.py \
    --model-dir reports/porting/2026-05-10/milady-ai-repos/qwen3.5-4b-milady-drafter \
    --repo-id milady-ai/qwen3.5-4b-milady-drafter \
    --dry-run  # smoke first; drop --dry-run for the real push

# qwen3.5-9b-milady-optimized
uv run python packages/training/scripts/publish_milady_model.py \
    --model-dir reports/porting/2026-05-10/milady-ai-repos/qwen3.5-9b-milady-optimized \
    --repo-id milady-ai/qwen3.5-9b-milady-optimized \
    --dry-run  # smoke first; drop --dry-run for the real push

# qwen3.5-9b-milady-drafter
uv run python packages/training/scripts/publish_milady_model.py \
    --model-dir reports/porting/2026-05-10/milady-ai-repos/qwen3.5-9b-milady-drafter \
    --repo-id milady-ai/qwen3.5-9b-milady-drafter \
    --dry-run  # smoke first; drop --dry-run for the real push

# qwen3.6-27b-milady-optimized
uv run python packages/training/scripts/publish_milady_model.py \
    --model-dir reports/porting/2026-05-10/milady-ai-repos/qwen3.6-27b-milady-optimized \
    --repo-id milady-ai/qwen3.6-27b-milady-optimized \
    --dry-run  # smoke first; drop --dry-run for the real push

# qwen3.6-27b-milady-drafter
uv run python packages/training/scripts/publish_milady_model.py \
    --model-dir reports/porting/2026-05-10/milady-ai-repos/qwen3.6-27b-milady-drafter \
    --repo-id milady-ai/qwen3.6-27b-milady-drafter \
    --dry-run  # smoke first; drop --dry-run for the real push

# bonsai-8b-1bit-milady-optimized
uv run python packages/training/scripts/publish_milady_model.py \
    --model-dir reports/porting/2026-05-10/milady-ai-repos/bonsai-8b-1bit-milady-optimized \
    --repo-id milady-ai/bonsai-8b-1bit-milady-optimized \
    --dry-run  # smoke first; drop --dry-run for the real push

# eliza-1-2b-milady-optimized
uv run python packages/training/scripts/publish_milady_model.py \
    --model-dir reports/porting/2026-05-10/milady-ai-repos/eliza-1-2b-milady-optimized \
    --repo-id milady-ai/eliza-1-2b-milady-optimized \
    --dry-run  # smoke first; drop --dry-run for the real push

# eliza-1-9b-milady-optimized
uv run python packages/training/scripts/publish_milady_model.py \
    --model-dir reports/porting/2026-05-10/milady-ai-repos/eliza-1-9b-milady-optimized \
    --repo-id milady-ai/eliza-1-9b-milady-optimized \
    --dry-run  # smoke first; drop --dry-run for the real push

# eliza-1-27b-milady-optimized
uv run python packages/training/scripts/publish_milady_model.py \
    --model-dir reports/porting/2026-05-10/milady-ai-repos/eliza-1-27b-milady-optimized \
    --repo-id milady-ai/eliza-1-27b-milady-optimized \
    --dry-run  # smoke first; drop --dry-run for the real push

```

## Bulk publish

```bash
for dir in reports/porting/2026-05-10/milady-ai-repos/*/; do
  name=$(basename "$dir")
  [ "$name" = "UPLOAD.md" ] && continue
  uv run python packages/training/scripts/publish_milady_model.py \
      --model-dir "$dir" \
      --repo-id "milady-ai/$name"
done
```

## After upload

Refresh the catalog diff and run the phone-equivalent download check:

```bash
uv run python packages/training/scripts/sync_catalog_from_hf.py \
    --org milady-ai \
    --out reports/porting/$(date -u +%Y-%m-%d)/catalog-diff.json
node scripts/verify-phone-download.mjs --diff-first \
    --model-id qwen3.5-4b-milady-optimized
```
