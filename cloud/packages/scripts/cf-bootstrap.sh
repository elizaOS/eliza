#!/usr/bin/env bash
# =============================================================================
# cf-bootstrap.sh — One-time Cloudflare resource bootstrap for eliza-cloud
# =============================================================================
# Creates the R2 bucket, KV namespaces, and (optionally) Vectorize index that
# the Workers API and Pages frontend need.
#
# Idempotent: every create is wrapped in `|| true`, so re-running on an
# already-bootstrapped account is safe.
#
# Prerequisites:
#   - `wrangler` CLI installed (npm i -g wrangler  OR  bunx wrangler)
#   - `wrangler login` already run, OR CLOUDFLARE_API_TOKEN exported
#
# Usage:
#   bash packages/scripts/cf-bootstrap.sh
#
# After running, paste the printed namespace IDs into cloud/apps/api/wrangler.toml
# at the `id = "REPLACE_ME"` lines.
# =============================================================================

set -u  # NOT -e: we want to continue past idempotent failures

WRANGLER="${WRANGLER:-wrangler}"
R2_BUCKET="${R2_BUCKET:-eliza-cloud-blob}"
VECTORIZE_INDEX="${VECTORIZE_INDEX:-eliza-cloud-embeddings}"
SKIP_VECTORIZE="${SKIP_VECTORIZE:-0}"

echo "============================================================"
echo "  eliza-cloud Cloudflare bootstrap"
echo "  wrangler: $($WRANGLER --version 2>/dev/null || echo 'NOT FOUND')"
echo "============================================================"
echo

# -----------------------------------------------------------------------------
# 1. R2 bucket — replaces legacy blob storage
# -----------------------------------------------------------------------------
echo "[1/4] Creating R2 bucket: $R2_BUCKET"
$WRANGLER r2 bucket create "$R2_BUCKET" || true
echo

# -----------------------------------------------------------------------------
# 2. KV namespaces — session cache, rate limit, general cache
# -----------------------------------------------------------------------------
echo "[2/4] Creating KV namespaces"
echo "      Capture the printed \`id\` values and paste them into"
echo "      cloud/apps/api/wrangler.toml (kv_namespaces blocks)."
echo

for NS in SESSION_CACHE RATE_LIMIT CACHE; do
  echo "  -> $NS (production)"
  $WRANGLER kv namespace create "$NS" || true
  echo "  -> $NS (preview)"
  $WRANGLER kv namespace create "$NS" --preview || true
  echo
done

# -----------------------------------------------------------------------------
# 3. Vectorize index — embeddings (optional)
# -----------------------------------------------------------------------------
if [ "$SKIP_VECTORIZE" = "1" ]; then
  echo "[3/4] Skipping Vectorize index (SKIP_VECTORIZE=1)"
else
  echo "[3/4] Creating Vectorize index: $VECTORIZE_INDEX"
  echo "      (set SKIP_VECTORIZE=1 to skip; requires Workers Paid plan)"
  $WRANGLER vectorize create "$VECTORIZE_INDEX" \
    --dimensions=1536 \
    --metric=cosine \
    || true
fi
echo

# -----------------------------------------------------------------------------
# 4. Redis queue — Stripe webhook fan-out
# -----------------------------------------------------------------------------
# The Stripe webhook handler enqueues JSON envelopes to Redis; the scheduled
# cron route drains bounded batches and demotes exhausted retries to
# stripe-events:dlq.
# -----------------------------------------------------------------------------
echo "[4/4] Stripe webhook queue uses Redis"
echo "      Configure UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN"
echo "      (or KV_REST_API_URL/KV_REST_API_TOKEN) as Worker secrets."
echo

# -----------------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------------
echo "============================================================"
echo "  Bootstrap complete."
echo
echo "  Next steps:"
echo "    1. Open cloud/apps/api/wrangler.toml"
echo "    2. Replace each REPLACE_ME 'id' with the matching namespace ID"
echo "       printed above (SESSION_CACHE, RATE_LIMIT, CACHE)."
echo "    3. Set 'account_id' in cloud/apps/api/wrangler.toml to your Cloudflare"
echo "       account ID (wrangler whoami)."
echo "    4. Push secrets:  bun run cf:secrets:put:staging"
echo "                      bun run cf:secrets:put:prod"
echo "    5. First deploy:  bun run deploy"
echo "============================================================"
