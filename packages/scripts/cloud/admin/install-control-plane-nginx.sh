#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "install-control-plane-nginx.sh must run as root" >&2
  exit 1
fi

env_file="${ELIZA_CLOUD_ENV_FILE:-/opt/eliza/cloud/.env.local}"

read_env_value() {
  local key="$1"
  local fallback="$2"
  local direct="${!key:-}"
  if [[ -n "$direct" ]]; then
    printf '%s' "$direct"
    return
  fi
  if [[ -f "$env_file" ]]; then
    awk -F= -v key="$key" '
      $1 == key {
        value = $0
        sub(/^[^=]+=/, "", value)
        gsub(/^'\''|'\''$/, "", value)
        gsub(/^"|"$/, "", value)
        print value
        exit
      }
    ' "$env_file"
    return
  fi
  printf '%s' "$fallback"
}

environment="$(read_env_value ENVIRONMENT production)"
if [[ "$environment" == "staging" ]]; then
  default_origin_host="eliza-staging-1.elizacloud.ai"
  default_control_host="control-staging.elizacloud.ai"
  default_headscale_host="headscale-staging.elizacloud.ai"
else
  default_origin_host="eliza-production-1.elizacloud.ai"
  default_control_host="control.elizacloud.ai"
  default_headscale_host="headscale.elizacloud.ai"
fi

agent_router_port="$(read_env_value AGENT_ROUTER_PORT 3458)"
headscale_port="$(read_env_value HEADSCALE_PORT 8081)"
agent_base_domain="$(read_env_value ELIZA_CLOUD_AGENT_BASE_DOMAIN elizacloud.ai)"
origin_host="$(read_env_value AGENT_ROUTER_ORIGIN_HOST "$default_origin_host")"
control_host="$(read_env_value CONTAINER_CONTROL_PLANE_HOST "$default_control_host")"
headscale_host="$(read_env_value HEADSCALE_HOST "$default_headscale_host")"
acme_root="${ACME_WEBROOT:-/var/www/letsencrypt}"
config_path="/etc/nginx/sites-available/eliza-agent-router"
enabled_path="/etc/nginx/sites-enabled/eliza-agent-router"
origin_cert="${AGENT_ROUTER_TLS_CERT_PATH:-/etc/letsencrypt/live/${origin_host}/fullchain.pem}"
origin_key="${AGENT_ROUTER_TLS_KEY_PATH:-/etc/letsencrypt/live/${origin_host}/privkey.pem}"
headscale_cert="${HEADSCALE_TLS_CERT_PATH:-/etc/letsencrypt/live/${headscale_host}/fullchain.pem}"
headscale_key="${HEADSCALE_TLS_KEY_PATH:-/etc/letsencrypt/live/${headscale_host}/privkey.pem}"

install -d -m 0755 "$acme_root" /etc/nginx/sites-available /etc/nginx/sites-enabled

tmp_config="$(mktemp)"
trap 'rm -f "$tmp_config"' EXIT

cat > "$tmp_config" <<NGINX
server {
  listen 80;
  listen [::]:80;
  server_name ${headscale_host} headscale.${origin_host};
  client_max_body_size 50m;

  location ^~ /.well-known/acme-challenge/ {
    root ${acme_root};
    default_type text/plain;
  }

  location = /health {
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_pass http://127.0.0.1:${headscale_port}/health;
  }

  location / {
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_buffering off;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
    proxy_pass http://127.0.0.1:${headscale_port};
  }
}

server {
  listen 80;
  listen [::]:80;
  server_name ${origin_host} ${control_host} .${agent_base_domain};
  client_max_body_size 50m;

  location ^~ /.well-known/acme-challenge/ {
    root ${acme_root};
    default_type text/plain;
  }

  location = /health {
    access_log off;
    add_header Content-Type application/json;
    return 200 '{"ok":true,"service":"eliza-control-plane"}';
  }

  location / {
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
    proxy_pass http://127.0.0.1:${agent_router_port};
  }
}
NGINX

if [[ -f "$origin_cert" && -f "$origin_key" ]]; then
  cat >> "$tmp_config" <<NGINX

server {
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name ${origin_host};
  client_max_body_size 50m;
  ssl_certificate ${origin_cert};
  ssl_certificate_key ${origin_key};

  location = /health {
    access_log off;
    add_header Content-Type application/json;
    return 200 '{"ok":true,"service":"eliza-control-plane"}';
  }

  location / {
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
    proxy_pass http://127.0.0.1:${agent_router_port};
  }
}
NGINX
fi

if [[ -f "$headscale_cert" && -f "$headscale_key" ]]; then
  cat >> "$tmp_config" <<NGINX

server {
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name ${headscale_host};
  client_max_body_size 50m;
  ssl_certificate ${headscale_cert};
  ssl_certificate_key ${headscale_key};

  location = /health {
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_pass http://127.0.0.1:${headscale_port}/health;
  }

  location / {
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_buffering off;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
    proxy_pass http://127.0.0.1:${headscale_port};
  }
}
NGINX
fi

install -m 0644 "$tmp_config" "$config_path"
ln -sfn "$config_path" "$enabled_path"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "Installed eliza control-plane nginx config: origin=${origin_host}, control=${control_host}, headscale=${headscale_host}, base=${agent_base_domain}"
