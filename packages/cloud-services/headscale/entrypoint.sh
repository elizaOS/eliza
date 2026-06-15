#!/bin/sh
set -e

# Make server_url env-portable. The committed config.yaml ships a prod fallback
# (headscale.elizacloud.ai), but the same image deploys to multiple Railway
# environments — each gets its own RAILWAY_PUBLIC_DOMAIN (prod
# headscale.elizacloud.ai, staging headscale-staging.elizacloud.ai). Without this
# the staging instance would advertise the prod URL and agents/tunnels would
# register against the wrong coordination server.
if [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
  sed -i "s|^server_url:.*|server_url: https://${RAILWAY_PUBLIC_DOMAIN}|" /etc/headscale/config.yaml
fi

exec headscale serve
