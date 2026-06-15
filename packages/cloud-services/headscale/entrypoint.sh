#!/bin/sh
set -e

# Make server_url env-portable. The committed config.yaml ships a prod fallback
# (headscale.elizacloud.ai), but the same image deploys to multiple Railway
# environments. server_url MUST equal the public-facing custom domain that
# agents/tunnels register and re-derive control/DERP/MagicDNS against, so it is
# driven from an explicit per-env HEADSCALE_PUBLIC_URL Railway variable (prod
# https://headscale.elizacloud.ai, staging https://headscale-staging.elizacloud.ai)
# rather than RAILWAY_PUBLIC_DOMAIN — Railway injects RAILWAY_PUBLIC_DOMAIN as
# the auto-generated *.up.railway.app host, NOT the custom domain, so templating
# from it would advertise the wrong coordination server. When HEADSCALE_PUBLIC_URL
# is unset the committed config.yaml value (prod) stands.
if [ -n "${HEADSCALE_PUBLIC_URL:-}" ]; then
  # Avoid sed string interpolation: HEADSCALE_PUBLIC_URL would otherwise need
  # `&`, `|`, `/` and newlines escaped before substitution. Rewrite the line
  # without regex so any value is written verbatim.
  grep -v '^server_url:' /etc/headscale/config.yaml > /tmp/config.yaml
  printf 'server_url: %s\n' "$HEADSCALE_PUBLIC_URL" | cat - /tmp/config.yaml > /etc/headscale/config.yaml
  rm -f /tmp/config.yaml
fi

exec headscale serve
