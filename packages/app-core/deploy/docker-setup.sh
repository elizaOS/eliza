#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
WORK_DIR="${PWD}"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
EXTRA_COMPOSE_FILE="$WORK_DIR/docker-compose.extra.yml"
ENV_FILE="$WORK_DIR/.env"
DOCKERIGNORE_BACKUP=""
HAD_ROOT_DOCKERIGNORE=0

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

resolve_config_file() {
  local candidate
  for candidate in \
    "${DEPLOY_CONFIG:-}" \
    "$WORK_DIR/deploy.env" \
    "$WORK_DIR/../deploy/deploy.env" \
    "$REPO_ROOT/deploy/deploy.env"; do
    if [[ -n "$candidate" && -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

write_extra_compose() {
  local home_volume="$1"
  shift
  local -a mounts=("$@")
  local mount

  cat >"$EXTRA_COMPOSE_FILE" <<'YAML'
services:
  gateway:
    volumes:
YAML

  if [[ -n "$home_volume" ]]; then
    printf '      - %s:/home/node\n' "$home_volume" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s:%s\n' "$APP_CONFIG_DIR" "$APP_STATE_DIR" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s:%s/workspace\n' "$APP_WORKSPACE_DIR" "$APP_STATE_DIR" >>"$EXTRA_COMPOSE_FILE"
  fi

  for mount in "${mounts[@]}"; do
    printf '      - %s\n' "$mount" >>"$EXTRA_COMPOSE_FILE"
  done

  cat >>"$EXTRA_COMPOSE_FILE" <<'YAML'
  cli:
    volumes:
YAML

  if [[ -n "$home_volume" ]]; then
    printf '      - %s:/home/node\n' "$home_volume" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s:%s\n' "$APP_CONFIG_DIR" "$APP_STATE_DIR" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s:%s/workspace\n' "$APP_WORKSPACE_DIR" "$APP_STATE_DIR" >>"$EXTRA_COMPOSE_FILE"
  fi

  for mount in "${mounts[@]}"; do
    printf '      - %s\n' "$mount" >>"$EXTRA_COMPOSE_FILE"
  done

  if [[ -n "$home_volume" && "$home_volume" != *"/"* ]]; then
    cat >>"$EXTRA_COMPOSE_FILE" <<YAML
volumes:
  ${home_volume}:
YAML
  fi
}

upsert_env() {
  local file="$1"
  shift
  local -a keys=("$@")
  local tmp
  tmp="$(mktemp)"

  format_assignment() {
    local key="$1"
    local value="$2"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    value="${value//\$/\\$}"
    value="${value//\`/\\\`}"
    printf '%s="%s"\n' "$key" "$value"
  }

  if [[ -f "$file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      local key="${line%%=*}"
      local replaced=false
      for k in "${keys[@]}"; do
        if [[ "$key" == "$k" ]]; then
          format_assignment "$k" "${!k-}" >>"$tmp"
          replaced=true
          break
        fi
      done
      if [[ "$replaced" == false ]]; then
        printf '%s\n' "$line" >>"$tmp"
      fi
    done <"$file"
  fi

  for k in "${keys[@]}"; do
    if ! grep -q "^${k}=" "$tmp" 2>/dev/null; then
      format_assignment "$k" "${!k-}" >>"$tmp"
    fi
  done

  mv "$tmp" "$file"
}

prepare_dockerignore() {
  DOCKERIGNORE_BACKUP="$WORK_DIR/.dockerignore.backup.$$"
  HAD_ROOT_DOCKERIGNORE=0

  if [[ -f "$REPO_ROOT/.dockerignore" ]]; then
    HAD_ROOT_DOCKERIGNORE=1
    cp "$REPO_ROOT/.dockerignore" "$DOCKERIGNORE_BACKUP"
  fi

  cp "$SCRIPT_DIR/.dockerignore.ci" "$REPO_ROOT/.dockerignore"
}

cleanup_dockerignore() {
  if [[ -z "$DOCKERIGNORE_BACKUP" ]]; then
    return
  fi

  if [[ "$HAD_ROOT_DOCKERIGNORE" == "1" ]]; then
    mv "$DOCKERIGNORE_BACKUP" "$REPO_ROOT/.dockerignore"
  else
    rm -f "$REPO_ROOT/.dockerignore" "$DOCKERIGNORE_BACKUP"
  fi
}

trap cleanup_dockerignore EXIT

ensure_runtime_artifacts() {
  if [[ -f "$REPO_ROOT/dist/index.js" && -d "$REPO_ROOT/apps/app/dist" ]]; then
    return
  fi

  require_cmd bun
  echo "==> Building runtime artifacts"
  (
    cd "$REPO_ROOT"
    bun run build
  )
}

require_cmd docker
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose not available (try: docker compose version)" >&2
  exit 1
fi

load_env_file "$SCRIPT_DIR/deploy.defaults.env"
CONFIG_FILE="$(resolve_config_file || true)"
if [[ -n "$CONFIG_FILE" ]]; then
  load_env_file "$CONFIG_FILE"
fi

APP_NAME="${APP_NAME:-eliza}"
APP_ENTRYPOINT="${APP_ENTRYPOINT:-app.mjs}"
APP_CMD_START="${APP_CMD_START:-node --import ./node_modules/tsx/dist/loader.mjs ${APP_ENTRYPOINT} start}"
APP_IMAGE="${APP_IMAGE:-eliza:local}"
APP_REGISTRY="${APP_REGISTRY:-}"
APP_PORT="${APP_PORT:-${ELIZA_PORT:-2138}}"
APP_GATEWAY_PORT="${APP_GATEWAY_PORT:-${ELIZA_GATEWAY_PORT:-18789}}"
APP_BRIDGE_PORT="${APP_BRIDGE_PORT:-${ELIZA_BRIDGE_PORT:-18790}}"
APP_GATEWAY_BIND="${APP_GATEWAY_BIND:-lan}"
APP_STATE_DIR="${APP_STATE_DIR:-${ELIZA_STATE_DIR:-/home/node/.eliza}}"
APP_CONFIG_DIR="${APP_CONFIG_DIR:-${ELIZA_CONFIG_DIR:-${HOME}/.eliza}}"
APP_WORKSPACE_DIR="${APP_WORKSPACE_DIR:-${ELIZA_WORKSPACE_DIR:-${APP_CONFIG_DIR}/workspace}}"
APP_API_BIND="${APP_API_BIND:-${ELIZA_API_BIND:-127.0.0.1}}"
APP_ALLOWED_ORIGINS="${APP_ALLOWED_ORIGINS:-${ELIZA_ALLOWED_ORIGINS:-}}"
APP_API_TOKEN="${APP_API_TOKEN:-${ELIZA_API_TOKEN:-}}"
APP_GATEWAY_TOKEN="${APP_GATEWAY_TOKEN:-}"
APP_EXTRA_MOUNTS="${APP_EXTRA_MOUNTS:-}"
APP_HOME_VOLUME="${APP_HOME_VOLUME:-}"
APP_DOCKER_APT_PACKAGES="${APP_DOCKER_APT_PACKAGES:-}"
OCI_SOURCE="${OCI_SOURCE:-}"
OCI_TITLE="${OCI_TITLE:-elizaOS Agent}"
OCI_DESCRIPTION="${OCI_DESCRIPTION:-elizaOS agent runtime}"
OCI_LICENSES="${OCI_LICENSES:-MIT}"

mkdir -p "$APP_CONFIG_DIR" "$APP_WORKSPACE_DIR"

export APP_NAME
export APP_ENTRYPOINT
export APP_CMD_START
export APP_IMAGE
export APP_REGISTRY
export APP_PORT
export APP_GATEWAY_PORT
export APP_BRIDGE_PORT
export APP_GATEWAY_BIND
export APP_STATE_DIR
export APP_CONFIG_DIR
export APP_WORKSPACE_DIR
export APP_API_BIND
export APP_ALLOWED_ORIGINS
export APP_API_TOKEN
export APP_EXTRA_MOUNTS
export APP_HOME_VOLUME
export APP_DOCKER_APT_PACKAGES

export ELIZA_PORT="${ELIZA_PORT:-$APP_PORT}"
export ELIZA_API_PORT="${ELIZA_API_PORT:-$APP_PORT}"
export ELIZA_GATEWAY_PORT="${ELIZA_GATEWAY_PORT:-$APP_GATEWAY_PORT}"
export ELIZA_BRIDGE_PORT="${ELIZA_BRIDGE_PORT:-$APP_BRIDGE_PORT}"
export ELIZA_STATE_DIR="${ELIZA_STATE_DIR:-$APP_STATE_DIR}"
export ELIZA_API_BIND="${ELIZA_API_BIND:-$APP_API_BIND}"
if [[ -n "$APP_ALLOWED_ORIGINS" ]]; then
  export ELIZA_ALLOWED_ORIGINS="${ELIZA_ALLOWED_ORIGINS:-$APP_ALLOWED_ORIGINS}"
fi
if [[ -n "$APP_API_TOKEN" ]]; then
  export ELIZA_API_TOKEN="${ELIZA_API_TOKEN:-$APP_API_TOKEN}"
fi

if [[ -z "${APP_GATEWAY_TOKEN:-}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    APP_GATEWAY_TOKEN="$(openssl rand -hex 32)"
  else
    APP_GATEWAY_TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
  fi
fi
export APP_GATEWAY_TOKEN

VALID_MOUNTS=()
if [[ -n "$APP_EXTRA_MOUNTS" ]]; then
  IFS=',' read -r -a mounts <<<"$APP_EXTRA_MOUNTS"
  for mount in "${mounts[@]}"; do
    mount="${mount#"${mount%%[![:space:]]*}"}"
    mount="${mount%"${mount##*[![:space:]]}"}"
    if [[ -n "$mount" ]]; then
      VALID_MOUNTS+=("$mount")
    fi
  done
fi

COMPOSE_FILES=("$COMPOSE_FILE")
if [[ -n "$APP_HOME_VOLUME" || ${#VALID_MOUNTS[@]} -gt 0 ]]; then
  write_extra_compose "$APP_HOME_VOLUME" "${VALID_MOUNTS[@]}"
  COMPOSE_FILES+=("$EXTRA_COMPOSE_FILE")
fi

COMPOSE_ARGS=()
COMPOSE_HINT="docker compose"
for compose_file in "${COMPOSE_FILES[@]}"; do
  COMPOSE_ARGS+=("-f" "$compose_file")
  COMPOSE_HINT+=" -f ${compose_file}"
done

upsert_env "$ENV_FILE" \
  APP_NAME \
  APP_ENTRYPOINT \
  APP_CMD_START \
  APP_IMAGE \
  APP_PORT \
  APP_GATEWAY_PORT \
  APP_BRIDGE_PORT \
  APP_GATEWAY_BIND \
  APP_STATE_DIR \
  APP_CONFIG_DIR \
  APP_WORKSPACE_DIR \
  APP_GATEWAY_TOKEN \
  APP_ALLOWED_ORIGINS \
  APP_API_TOKEN \
  APP_API_BIND \
  APP_EXTRA_MOUNTS \
  APP_HOME_VOLUME \
  APP_DOCKER_APT_PACKAGES

ensure_runtime_artifacts
prepare_dockerignore

echo "==> Building Docker image: $APP_IMAGE"
docker build \
  --build-arg "APP_ENTRYPOINT=${APP_ENTRYPOINT}" \
  --build-arg "APP_CMD_START=${APP_CMD_START}" \
  --build-arg "APP_PORT=${APP_PORT}" \
  --build-arg "APP_API_BIND=${APP_API_BIND}" \
  --build-arg "OCI_SOURCE=${OCI_SOURCE}" \
  --build-arg "OCI_TITLE=${OCI_TITLE}" \
  --build-arg "OCI_DESCRIPTION=${OCI_DESCRIPTION}" \
  --build-arg "OCI_LICENSES=${OCI_LICENSES}" \
  -t "$APP_IMAGE" \
  -f "$SCRIPT_DIR/Dockerfile.ci" \
  "$REPO_ROOT"

echo
echo "==> Onboarding (interactive)"
echo "When prompted:"
echo "  - Gateway bind: ${APP_GATEWAY_BIND}"
echo "  - Gateway auth: token"
echo "  - Gateway token: $APP_GATEWAY_TOKEN"
echo "  - Tailscale exposure: Off"
echo "  - Install Gateway daemon: No"
echo
docker compose "${COMPOSE_ARGS[@]}" run --rm cli setup

echo
echo "==> Connector setup (optional)"
echo "Example commands:"
echo "  ${COMPOSE_HINT} run --rm cli channels login"
echo "  ${COMPOSE_HINT} run --rm cli channels add --channel telegram --token <token>"
echo "  ${COMPOSE_HINT} run --rm cli channels add --channel discord --token <token>"

echo
echo "==> Starting gateway"
docker compose "${COMPOSE_ARGS[@]}" up -d gateway

echo
echo "${APP_NAME} gateway is running with host port mapping."
echo "Config: $APP_CONFIG_DIR"
echo "Workspace: $APP_WORKSPACE_DIR"
echo "Token: $APP_GATEWAY_TOKEN"
echo
echo "Commands:"
echo "  ${COMPOSE_HINT} logs -f gateway"
echo "  ${COMPOSE_HINT} exec gateway node dist/index.js health --token \"$APP_GATEWAY_TOKEN\""
