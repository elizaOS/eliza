#!/usr/bin/env bash

set -euo pipefail

# Use DATABASE_URL from environment, fallback to default for local testing
DB_URL=${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/test_db}

create_env_files() {
if [[ -f .env.test ]]; then
  echo "ℹ️  Using existing .env.test"
else
  echo "📝 Creating .env.test from environment variables"
  cat > .env.test <<EOF
# Database
DATABASE_URL=${DB_URL}
DIRECT_DATABASE_URL=${DIRECT_DATABASE_URL:-$DB_URL}

# Auth
# Make PRIVY_APP_ID and NEXT_PUBLIC_PRIVY_APP_ID interchangeable
PRIVY_APP_ID=${PRIVY_APP_ID:-${NEXT_PUBLIC_PRIVY_APP_ID:-}}
NEXT_PUBLIC_PRIVY_APP_ID=${NEXT_PUBLIC_PRIVY_APP_ID:-${PRIVY_APP_ID:-}}
PRIVY_APP_SECRET=${PRIVY_APP_SECRET:-}
PRIVY_TEST_EMAIL=${PRIVY_TEST_EMAIL:-}
PRIVY_TEST_PHONE=${PRIVY_TEST_PHONE:-}
PRIVY_TEST_OTP=${PRIVY_TEST_OTP:-}
PRIVY_TEST_PASSWORD=${PRIVY_TEST_PASSWORD:-}

# API Keys
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
GROQ_API_KEY=${GROQ_API_KEY:-}
FAL_KEY=${FAL_KEY:-}

# Other
CRON_SECRET=${CRON_SECRET:-test-cron-secret}
WALLET_SEED_PHRASE=${WALLET_SEED_PHRASE:-}
WALLET_PASSWORD=${WALLET_PASSWORD:-}

# Redis (if applicable)
${REDIS_URL:+REDIS_URL=${REDIS_URL}}
EOF
fi

  cp .env.test .env
  cp .env.test .env.local
}

main() {
  create_env_files
  echo "✅ Environment files created: .env.test, .env, .env.local"
  echo "   DATABASE_URL: ${DB_URL}"

  # Debug: Show which secrets are available
  echo "📋 Environment variable check:"
  echo "   NEXT_PUBLIC_PRIVY_APP_ID: ${NEXT_PUBLIC_PRIVY_APP_ID:+SET (${#NEXT_PUBLIC_PRIVY_APP_ID} chars)}${NEXT_PUBLIC_PRIVY_APP_ID:-NOT SET}"
  echo "   PRIVY_APP_ID: ${PRIVY_APP_ID:+SET (${#PRIVY_APP_ID} chars)}${PRIVY_APP_ID:-NOT SET}"
  echo "   PRIVY_TEST_EMAIL: ${PRIVY_TEST_EMAIL:+SET}${PRIVY_TEST_EMAIL:-NOT SET}"

  # Check for required secrets
  if [[ -z "${NEXT_PUBLIC_PRIVY_APP_ID:-}" && -z "${PRIVY_APP_ID:-}" ]]; then
    echo "❌ ERROR: NEXT_PUBLIC_PRIVY_APP_ID or PRIVY_APP_ID is required for tests."
    echo ""
    echo "To fix this:"
    echo "1. Go to your GitHub repository Settings → Secrets and variables → Actions"
    echo "2. Add a repository secret named NEXT_PUBLIC_PRIVY_APP_ID (or PRIVY_APP_ID)"
    echo "3. Set the value to your Privy App ID (starts with 'cl...')"
    echo ""
    echo "If you've already set the secret, check that:"
    echo "- The secret name is exactly 'NEXT_PUBLIC_PRIVY_APP_ID' or 'PRIVY_APP_ID'"
    echo "- The secret is not empty"
    echo "- The secret is available to this workflow (check environment protection rules)"
    exit 1
  fi

  # Verify the Privy App ID looks valid
  local privy_id="${NEXT_PUBLIC_PRIVY_APP_ID:-$PRIVY_APP_ID}"
  if [[ ! "$privy_id" =~ ^cl ]]; then
    echo "⚠️  WARNING: Privy App ID doesn't look valid (should start with 'cl')"
    echo "   Current value starts with: ${privy_id:0:5}..."
  fi

  # PRIVY_TEST_EMAIL is only required for E2E tests, not unit/integration tests
  if [[ -z "${PRIVY_TEST_EMAIL:-}" ]]; then
    if [[ "${SKIP_E2E_CHECKS:-false}" == "true" ]]; then
      echo "ℹ️  PRIVY_TEST_EMAIL not set, but SKIP_E2E_CHECKS=true - continuing..."
    else
      echo "⚠️  WARNING: PRIVY_TEST_EMAIL is not set. E2E tests will be skipped."
      echo "   Set SKIP_E2E_CHECKS=true to suppress this warning."
    fi
  fi
}

main "$@"
