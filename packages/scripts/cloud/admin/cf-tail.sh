#!/usr/bin/env bash
# Tail live Worker logs.
#   bash packages/scripts/cf-tail.sh             -> production
#   bash packages/scripts/cf-tail.sh staging     -> staging
#   bash packages/scripts/cf-tail.sh pr-123      -> PR preview Worker
set -eu

ENV="${1:-prod}"
case "$ENV" in
  prod|production) NAME="eliza-cloud-api-prod" ;;
  staging)         NAME="eliza-cloud-api-staging" ;;
  pr-*)            NAME="eliza-cloud-api-${ENV}" ;;
  *)               NAME="$ENV" ;;  # raw worker name
esac

echo "Tailing $NAME ..."
exec wrangler tail "$NAME"
