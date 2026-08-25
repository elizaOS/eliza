#!/usr/bin/env bash
# Tail live Worker logs.
#   bash packages/cloud/scripts/admin/cf-tail.sh             -> production
#   bash packages/cloud/scripts/admin/cf-tail.sh staging     -> staging
#   bash packages/cloud/scripts/admin/cf-tail.sh pr-123      -> PR preview Worker
#
# WARNING — Workers Observability query truncation (#22548): the historical
# query API silently caps results (~50 events) with NO truncation signal. A
# single wide query over a multi-minute window can return only the last few
# seconds and look complete; the same window queried in ~5-second slices
# returns orders of magnitude more events. Never conclude "no events" (or
# measure a rate) from one wide query — slice the window and sum the slices.
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
