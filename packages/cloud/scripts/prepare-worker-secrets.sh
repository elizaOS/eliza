#!/usr/bin/env bash
set -euo pipefail

read -r -a wrangler_args <<< "$WRANGLER_ARGS"

has_nonblank_value() {
  local value="${1:-}"
  [ -n "${value//[[:space:]]/}" ]
}

is_truthy() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

# Construct the staging fallback only when the source key is real.
# Never publish the invalid-but-nonempty string "Bearer ".
if [ "$DEPLOY_ENVIRONMENT" = "staging" ] && \
   is_truthy "$VOICE_REALTIME_WS_ENABLED" && \
   ! has_nonblank_value "$VOICE_REALTIME_ELIZA_AUTHORIZATION" && \
   has_nonblank_value "$STAGING_ELIZACLOUD_API_KEY"; then
  VOICE_REALTIME_ELIZA_AUTHORIZATION="Bearer $STAGING_ELIZACLOUD_API_KEY"
  export VOICE_REALTIME_ELIZA_AUTHORIZATION
fi

# Production provider and bridge values remain managed Worker
# secrets. A protected-environment value may create or rotate one;
# a blank source preserves it, and names are verified after deploy.

# Staging advertises realtime only when the repository variable
# VOICE_REALTIME_WS_ENABLED is explicitly truthy. Refuse that opt-in
# unless every required provider and bridge credential is present; a
# green deploy with a 503-only voice route is not honest availability.
if [ "$DEPLOY_ENVIRONMENT" = "staging" ] && \
   is_truthy "$VOICE_REALTIME_WS_ENABLED"; then
  missing_voice_secrets=()
  for name in CARTESIA_API_KEY VOICE_REALTIME_ELIZA_AUTHORIZATION; do
    if ! has_nonblank_value "${!name:-}"; then
      missing_voice_secrets+=("$name")
    fi
  done
  if [ "${#missing_voice_secrets[@]}" -gt 0 ]; then
    echo "::error::Realtime voice is enabled for staging but required secrets are missing: ${missing_voice_secrets[*]}"
    exit 1
  fi
fi

if [ "${VOICE_BATCH_STT_PROVIDER,,}" = "cartesia" ]; then
  missing_cartesia_batch_config=()
  for name in CARTESIA_API_KEY CARTESIA_STT_USD_PER_CREDIT; do
    if ! has_nonblank_value "${!name:-}"; then
      missing_cartesia_batch_config+=("$name")
    fi
  done
  if [ "${#missing_cartesia_batch_config[@]}" -gt 0 ]; then
    echo "::error::Cartesia batch STT is enabled but required provider/billing config is missing: ${missing_cartesia_batch_config[*]}"
    exit 1
  fi
fi

# Value-safe validation: exact UUID allowlists, dedicated signing
# key/kid, and the code/runtime version are all required before the
# first QA-related Worker secret is touched.
node ../scripts/validate-staging-session-cutover.ts

# Fish is a separate, default-off promotion within realtime voice.
# Refuse to advertise it unless its own credentials and the exact
# voice downlink format are deployable; Cartesia is still required
# above because it handles pre-first-audio fallback.
if is_truthy "$ELIZA_TTS_FISH_ENABLED"; then
  if ! is_truthy "$FISH_AUDIO_DATA_GOVERNANCE_APPROVED"; then
    echo "::error::Fish realtime TTS is unavailable until FISH_AUDIO_DATA_GOVERNANCE_APPROVED is explicitly set after owner policy attestation"
    exit 1
  fi
  missing_fish_secrets=()
  for name in FISH_AUDIO_API_KEY FISH_AUDIO_REFERENCE_ID; do
    if ! has_nonblank_value "${!name:-}"; then
      missing_fish_secrets+=("$name")
    fi
  done
  if [ "${#missing_fish_secrets[@]}" -gt 0 ]; then
    echo "::error::Fish realtime TTS is enabled but required secrets are missing: ${missing_fish_secrets[*]}"
    exit 1
  fi
  case "$FISH_AUDIO_MODEL" in
    s1|s2-pro|s2.1-pro|s2.1-pro-free) ;;
    *)
      echo "::error::Fish realtime TTS model is invalid: $FISH_AUDIO_MODEL"
      exit 1
      ;;
  esac
  if [ "$FISH_AUDIO_SAMPLE_RATE" != "16000" ]; then
    echo "::error::Fish realtime TTS must deploy at 16000 Hz"
    exit 1
  fi
fi

# The Worker is the gateway: it calls native providers directly and
# uses OpenRouter (BYOK) as the backup. At least one provider key (the
# OpenRouter backup, or a native key) must be configured.
if [ -z "$OPENROUTER_API_KEY" ] && [ -z "$CEREBRAS_API_KEY" ] && [ -z "$OPENAI_API_KEY" ] && [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "::error::No model provider key configured. Set OPENROUTER_API_KEY (backup) and/or a native key (CEREBRAS/OPENAI/ANTHROPIC) at https://github.com/elizaOS/eliza/settings/secrets/actions."
  exit 1
fi

if has_nonblank_value "$ELIZA_APNS_TOPIC" && [ "$ELIZA_APNS_TOPIC" != "ai.elizaos.app" ]; then
  echo "::error::ELIZA_APNS_TOPIC must match the signed iOS bundle id"
  exit 1
fi
if has_nonblank_value "$ELIZA_APNS_PRODUCTION" && \
   [ "$ELIZA_APNS_PRODUCTION" != "0" ] && [ "$ELIZA_APNS_PRODUCTION" != "1" ]; then
  echo "::error::ELIZA_APNS_PRODUCTION must be exactly 0 or 1"
  exit 1
fi

declare -a worker_secret_names=()
declare -A queued_worker_secret_names=()

queue_secret() {
  local name="$1"
  local value="${!name:-}"
  case "$name" in
    CARTESIA_API_KEY)
      if ! is_truthy "$VOICE_REALTIME_WS_ENABLED" && \
         [ "${VOICE_BATCH_STT_PROVIDER,,}" != "cartesia" ]; then
        echo "::notice::$name is gated by realtime voice or VOICE_BATCH_STT_PROVIDER=cartesia; skipping"
        return 0
      fi
      ;;
    VOICE_REALTIME_ELIZA_AUTHORIZATION)
      if ! is_truthy "$VOICE_REALTIME_WS_ENABLED"; then
        echo "::notice::$name is gated by VOICE_REALTIME_WS_ENABLED; skipping"
        return 0
      fi
      ;;
    DEEPGRAM_API_KEY)
      if [ "${VOICE_BATCH_STT_PROVIDER,,}" != "deepgram" ]; then
        echo "::notice::$name is gated by VOICE_BATCH_STT_PROVIDER=deepgram; skipping"
        return 0
      fi
      ;;
    FISH_AUDIO_API_KEY|FISH_AUDIO_REFERENCE_ID)
      if ! is_truthy "$VOICE_REALTIME_WS_ENABLED" || \
         ! is_truthy "$ELIZA_TTS_FISH_ENABLED" || \
         ! is_truthy "$FISH_AUDIO_DATA_GOVERNANCE_APPROVED"; then
        echo "::notice::$name is gated by realtime voice, Fish enablement, and data-governance approval; skipping"
        return 0
      fi
      ;;
    LOCAL_EMBEDDINGS_API_KEY)
      if [ "$DEPLOY_ENVIRONMENT" != "staging" ]; then
        echo "::notice::$name is staging-only; skipping"
        return 0
      fi
      ;;
  esac
  if ! has_nonblank_value "$value"; then
    echo "::notice::$name is not configured; skipping"
    return 0
  fi
  if [ -z "${queued_worker_secret_names[$name]+configured}" ]; then
    worker_secret_names+=("$name")
    queued_worker_secret_names["$name"]=true
  fi
  return 0
}

verify_production_voice_secret_candidates() {
  if [ "$DEPLOY_ENVIRONMENT" != "production" ] || \
     ! is_truthy "$VOICE_REALTIME_WS_ENABLED"; then
    return 0
  fi
  local secret_inventory
  secret_inventory="$(bunx wrangler@4.116.0 secret list "${wrangler_args[@]}" --format json)"
  printf '%s' "$secret_inventory" | node -e '
    const fs = require("node:fs");
    const parsed = JSON.parse(fs.readFileSync(0, "utf8"));
    const entries = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.result)
        ? parsed.result
        : [];
    const available = new Set(entries.map((entry) => entry?.name).filter(Boolean));
    for (const name of process.argv.slice(1)) available.add(name);
    const required = [
      "CARTESIA_API_KEY",
      "VOICE_REALTIME_CARTESIA_VOICE_ID",
      "VOICE_REALTIME_ELIZA_AUTHORIZATION",
      "VOICE_REALTIME_ELIZA_ENDPOINT",
    ];
    const missing = required.filter((name) => !available.has(name));
    if (missing.length > 0) {
      console.error(`::error::Production realtime voice cannot be deployed; missing existing or configured Worker binding name(s): ${missing.join(" ")}`);
      process.exit(1);
    }
    console.log(`Verified ${required.length} existing or configured production voice binding names; values were not read.`);
  ' "${worker_secret_names[@]}"
}

verify_apns_binding_candidates() {
  local secret_inventory
  secret_inventory="$(bunx wrangler@4.116.0 secret list "${wrangler_args[@]}" --format json)"
  printf '%s' "$secret_inventory" | node -e '
    const fs = require("node:fs");
    const parsed = JSON.parse(fs.readFileSync(0, "utf8"));
    const entries = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.result)
        ? parsed.result
        : [];
    const available = new Set(entries.map((entry) => entry?.name).filter(Boolean));
    for (const name of process.argv.slice(1)) available.add(name);
    const apns = [
      "ELIZA_APNS_KEY",
      "ELIZA_APNS_KEY_ID",
      "ELIZA_APNS_TEAM_ID",
      "ELIZA_APNS_TOPIC",
      "ELIZA_APNS_PRODUCTION",
    ];
    const present = apns.filter((name) => available.has(name));
    if (present.length !== 0 && present.length !== apns.length) {
      console.error(`::error::Personal Shared APNs bindings must be zero-or-complete; partial existing or configured bindings: ${present.join(" ")}`);
      process.exit(1);
    }
    console.log(`Verified ${present.length} existing or configured APNs binding names; values were not read.`);
  ' "${worker_secret_names[@]}"
}

verify_telegram_binding_candidates() {
  local secret_inventory
  secret_inventory="$(bunx wrangler@4.116.0 secret list "${wrangler_args[@]}" --format json)"
  printf '%s' "$secret_inventory" | node \
    "$CHECKOUT_DIR/packages/cloud/scripts/verify-worker-secret-binding-names.ts" \
    --queued "${worker_secret_names[@]}" \
    --required \
    ELIZA_APP_TELEGRAM_BOT_TOKEN \
    ELIZA_APP_TELEGRAM_WEBHOOK_SECRET
}

verify_webhook_gateway_binding_candidates() {
  if ! has_nonblank_value "$ELIZA_APP_WEBHOOK_GATEWAY_URL"; then
    return 0
  fi
  local secret_inventory
  secret_inventory="$(bunx wrangler@4.116.0 secret list "${wrangler_args[@]}" --format json)"

  # Names-only wiring (above/below) proves a binding NAME exists or
  # is queued; it cannot prove the VALUE still matches the live
  # gateway's. Fetch that live value from Railway — the same
  # trusted source deploy-gateway-webhook.yml already reads for its
  # analogous Blooio value-match — and hand it to the node script
  # purely through this one subshell's environment. It is never
  # exported into the step's persistent shell state, assigned to a
  # variable outside this function, or passed to any command that
  # could echo it (no `set -x`, no `jq` on the raw value, no
  # temp file). A failed or empty fetch resolves to an empty
  # string, and the node script fails closed on that: a missing
  # gateway-side proof is a mismatch, never a silent pass.
  local railway_gateway_secret_inventory=""
  local railway_gateway_secret_value=""
  if railway_gateway_secret_inventory="$(railway variable list \
      --project "$RAILWAY_PROJECT_ID" \
      --environment "$RAILWAY_ENVIRONMENT_ID" \
      --service "$RAILWAY_SERVICE_ID_GATEWAY_WEBHOOK" \
      --json 2>/dev/null)"; then
    railway_gateway_secret_value="$(printf '%s' "$railway_gateway_secret_inventory" | jq -r \
      'if (.ELIZA_APP_WEBHOOK_GATEWAY_SECRET | type) == "string" then .ELIZA_APP_WEBHOOK_GATEWAY_SECRET else "" end')"
  else
    echo "::warning::Could not fetch the live gateway's ELIZA_APP_WEBHOOK_GATEWAY_SECRET from Railway; the value-match half of the webhook gateway check will fail closed"
  fi
  railway_gateway_secret_inventory=""

  printf '%s' "$secret_inventory" | env \
    "WEBHOOK_GATEWAY_RAILWAY_SECRET_VALUE=$railway_gateway_secret_value" \
    node \
    "$CHECKOUT_DIR/packages/cloud/scripts/verify-webhook-gateway-binding.ts" \
    "${worker_secret_names[@]}"
  local status=$?
  railway_gateway_secret_value=""
  return $status
}

# Like queue_secret, but for values that act as ROUTING TOGGLES
# (code branches on presence, e.g. `env.WHISPER_STT_URL`). An unset
# source must DELETE any previously published secret. A plain
# skip would leave a stale toggle active on the Worker forever
# (e.g. STT pinned to a dead Whisper host during an outage).
queue_toggle_secret() {
  local name="$1"
  local value="${!name:-}"
  if [ -n "$value" ]; then
    queue_secret "$name"
    return $?
  fi
  # Unset: use a names-only inventory before and after deletion so
  # absence is success without depending on Wrangler error prose.
  local result
  if ! result=$(node "$CHECKOUT_DIR/packages/cloud/scripts/ensure-worker-secret-absent.ts" \
    --versions "$name" "${wrangler_args[@]}"); then
    echo "::error::$name is unset but its absence could not be confirmed"
    return 1
  fi
  echo "::notice::$name is not configured; Worker binding state: $result"
  return 0
}

# Admit named staging candidates before the existing atomic queue; no values are printed.
network_site_auth_names="$(node "$CHECKOUT_DIR/packages/cloud/scripts/verify-network-site-auth-binding.ts")" || exit 1
for name in $network_site_auth_names; do queue_secret "$name" || exit 1; done

# Build the next Worker version with the QA activation bit absent.
# The served gate was already disabled above; version-aware updates
# now prepare the new config without deploying stale code between
# secret publication and the intentional code cutover.
STAGING_SESSION_EXCHANGE_ENABLED=""
export STAGING_SESSION_EXCHANGE_ENABLED
queue_toggle_secret STAGING_SESSION_EXCHANGE_ENABLED || exit 1

staging_session_config_names=(
  STAGING_SESSION_EXCHANGE_VERSION
  STAGING_SESSION_EXCHANGE_SIGNING_SECRET
  STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID
  STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS
  STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS
  STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS
)
if [ "$DEPLOY_ENVIRONMENT" = "staging" ] && \
   is_truthy "$STAGING_SESSION_EXCHANGE_DESIRED_ENABLED"; then
  for name in "${staging_session_config_names[@]}"; do
    queue_toggle_secret "$name" || exit 1
  done
else
  # Disabled/non-staging environments retain no stale QA signer or
  # allowlist. Deletion happens only after the gate is already off.
  for name in "${staging_session_config_names[@]}"; do
    printf -v "$name" '%s' ""
    export "${name?}"
    queue_toggle_secret "$name" || exit 1
  done
fi

# Queue only values explicitly configured in this protected GitHub
# environment. queue_secret intentionally skips blank values, which
# preserves an existing Cloudflare binding that GitHub cannot recover.
if has_nonblank_value "$KV_REST_API_URL"; then
  case "$DEPLOY_ENVIRONMENT:$KV_REST_API_URL" in
    staging:https://eliza-redis-http-staging.square-rain-7251.workers.dev|production:https://eliza-redis-http-production.square-rain-7251.workers.dev) ;;
    *) echo "::error::Redis HTTP cutover URL must match the release environment"; exit 1 ;;
  esac
  bridge_secret_inventory="$(bunx wrangler@4.116.0 secret list "${wrangler_args[@]}" --format json)"
  if ! jq -e 'any(.[]; .name == "KV_REST_API_TOKEN")' <<< "$bridge_secret_inventory" >/dev/null; then
    echo "::error::Redis HTTP cutover requires the existing environment bearer binding"
    exit 1
  fi
  queue_secret KV_REST_API_URL || exit 1
fi

managed_worker_provisioning_secrets=(
  DATABASE_URL
  HEADSCALE_API_KEY
  CONTAINERS_SSH_KEY
  SECRETS_MASTER_KEY
  TUNNEL_HOSTNAME_SIGNING_SECRET
)
for name in "${managed_worker_provisioning_secrets[@]}"; do
  queue_secret "$name" || exit 1
done

# Controlled cache-miss certification exists only on staging. A blank
# protected value preserves the current binding; the opt-in live
# certification workflow independently fails closed when requested.
if [ "$DEPLOY_ENVIRONMENT" = "staging" ]; then
  queue_secret INFERENCE_AUTH_PROBE_TOKEN || exit 1
fi

telegram_runtime_secret_names=(
  ELIZA_APP_TELEGRAM_BOT_TOKEN
  ELIZA_APP_TELEGRAM_WEBHOOK_SECRET
)
for name in "${telegram_runtime_secret_names[@]}"; do
  if [ "$DEPLOY_ENVIRONMENT" = "production" ] && \
     ! has_nonblank_value "${!name:-}"; then
    echo "::error::Required protected production Telegram secret is absent or blank: $name"
    exit 1
  fi
  queue_secret "$name" || exit 1
done

for name in \
  ELIZA_APP_BLOOIO_API_KEY \
  ELIZA_APP_BLOOIO_PHONE_NUMBER \
  ELIZA_APP_BLOOIO_WEBHOOK_SECRET
do
  if ! has_nonblank_value "${!name:-}"; then
    echo "::error::Required protected $DEPLOY_ENVIRONMENT Blooio secret is absent or blank: $name"
    exit 1
  fi
  queue_secret "$name" || exit 1
done

for name in \
  OPENROUTER_API_KEY \
  OPENAI_API_KEY \
  ANTHROPIC_API_KEY \
  CEREBRAS_API_KEY \
  GROQ_API_KEY \
  FAL_KEY \
  FAL_API_KEY \
  ELEVENLABS_API_KEY \
  DEEPGRAM_API_KEY \
  ELIZA_VOICE_CATALOG_SIGNING_KEY_BASE64 \
  ELIZA_VOICE_CATALOG_PUBLIC_KEY_BASE64 \
  VAST_API_KEY \
  VAST_BASE_URL \
  CARTESIA_API_KEY \
  FISH_AUDIO_API_KEY \
  FISH_AUDIO_REFERENCE_ID \
  VOICE_REALTIME_ELIZA_AUTHORIZATION \
  STEWARD_API_URL \
  STEWARD_JWT_SECRET \
  STEWARD_SESSION_SECRET \
  STEWARD_REQUEST_SIGNING_SECRET \
  STEWARD_PLATFORM_KEYS \
  STEWARD_TENANT_API_KEY \
  OIDC_SIGNING_JWKS \
  ELIZA_ENTITLEMENT_SIGNING_KEY \
  ELIZA_ENTITLEMENT_SIGNING_KEY_ID \
  ELIZA_ENTITLEMENT_PREVIOUS_PUBLIC_KEY \
  ELIZA_ENTITLEMENT_PREVIOUS_KEY_ID \
  ELIZA_ENTITLEMENT_NEXT_PUBLIC_KEY \
  ELIZA_ENTITLEMENT_NEXT_KEY_ID \
  ELIZA_SUBSCRIPTION_GRANT_CODE_PEPPER \
  OIDC_CLIENTS \
  GATEWAY_INTERNAL_SECRET \
  ELIZA_APP_WEBHOOK_GATEWAY_SECRET \
  ELIZA_APNS_KEY \
  ELIZA_APNS_KEY_ID \
  ELIZA_APNS_TEAM_ID \
  ELIZA_APNS_TOPIC \
  ELIZA_APNS_PRODUCTION \
  LOCAL_EMBEDDINGS_API_KEY \
  ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON \
  ELIZA_ANDROID_ASSET_LINKS_JSON
do
  queue_secret "$name"
done

if [ "$ELIZA_MOBILE_APP_AUTH_ENABLED" = "true" ]; then
  if ! has_nonblank_value "$ELIZA_MOBILE_APP_AUTH_APP_ID"; then
    echo "::error::Enabled mobile App Auth requires the protected ELIZA_MOBILE_APP_AUTH_APP_ID secret"
    exit 1
  fi
  queue_secret ELIZA_MOBILE_APP_AUTH_APP_ID || exit 1
fi

# Routing toggles: presence changes code paths, so unset must delete.
# A failed removal must fail the step. Configured toggle values join
# the exact Worker deploy rather than mutating an earlier version.
for name in \
  CARTESIA_API_KEY \
  CARTESIA_VOICE_ID \
  WHISPER_STT_URL \
  WHISPER_STT_MODEL \
  VOICE_BATCH_STT_PROVIDER \
  CARTESIA_STT_USD_PER_CREDIT \
  CARTESIA_BATCH_STT_TIMEOUT_MS \
  ELIZA_APP_WEBHOOK_GATEWAY_URL
do
  queue_toggle_secret "$name" || exit 1
done

# Preserve the production fail-closed boundary without mutating the
# active Worker: every required voice name must either already exist
# or be queued for the atomic version below.
verify_production_voice_secret_candidates || exit 1
# APNs is dormant only when all five names are absent. Merge the live
# names-only inventory with this deploy's candidates before mutation
# so a stale partial environment cannot receive APNs-enabled source.
verify_apns_binding_candidates || exit 1
# Staging can preserve the existing Telegram credentials when the
# protected Environment intentionally has no recoverable value.
# Production has already required both values above. In both cases,
# names-only inventory proves the atomic version can keep the route.
verify_telegram_binding_candidates || exit 1
# The messaging webhook gateway URL is a routing toggle: unset stays
# on the honest WEBHOOK_GATEWAY_NOT_CONFIGURED 503 (#18235), but a
# configured URL must point at THIS environment's canonical gateway
# and carry the paired forwarder secret, or every provider webhook
# would fail as a misleading 401/upstream error instead. This runs
# before the atomic Worker secrets version is written; the
# unset-toggle deletions in the queue loop above have already run.
verify_webhook_gateway_binding_candidates || exit 1

# STEWARD_API_URL is environment-scoped auth routing authority. A
# stale protected staging candidate must never overwrite the recovered
# staging Worker with production Steward while all health probes keep
# returning 200. Blank means preserve the unreadable existing Worker
# binding; a configured candidate must match the canonical upstream.
node "$CHECKOUT_DIR/packages/cloud/scripts/verify-steward-upstream-binding.ts"

# Wrangler deploy accepts this JSON additively: named values are
# committed in the same Worker version as the exact source, while
# omitted preserve-only bindings remain untouched. This also recovers
# when Cloudflare has an undeployed latest version, where standalone
# `wrangler secret put` refuses to proceed.
worker_secrets_file="$(node \
  "$CHECKOUT_DIR/packages/cloud/scripts/worker-secrets-file.ts" \
  create "$RUNNER_TEMP" "${worker_secret_names[@]}")"
echo "secrets_file=$worker_secrets_file" >> "$GITHUB_OUTPUT"
echo "Prepared ${#worker_secret_names[@]} configured Worker bindings for the atomic deploy; values were not printed."
