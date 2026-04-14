#!/usr/bin/env bash
<<<<<<< HEAD
#
# deploy-to-nodes.sh — Load a Docker image onto remote nodes and optionally
# restart matching containers in place.
#
# Usage:
#   ./deploy-to-nodes.sh [OPTIONS]
#
# Options:
#   --image TAG       Image to deploy (default: APP_IMAGE with :latest if no tag)
#   --nodes LIST      Override nodes with comma-separated name:ip pairs
#   --node NAME       Deploy to a single node by name
#   --restart         Restart matching containers after loading the image
#   --rolling         Rolling restart (one container at a time, wait for healthy)
#   --snapshot        Create container snapshots before restarting (default when --restart)
#   --no-snapshot     Skip snapshot before restart
#   --list            List matching running containers only
#   --status          Show image and container status on each node
#   --dry-run         Show what would be done
#   -h, --help        Show this help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
WORK_DIR="${PWD}"
SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=15)

=======
# deploy-to-nodes.sh — Deploy milady/agent image to Docker nodes
#
# Usage:
#   ./deploy/deploy-to-nodes.sh [OPTIONS]
#
# Options:
#   --image TAG       Image to deploy (default: milady/agent:latest)
#   --nodes LIST      Comma-separated node list: name:ip (overrides defaults)
#   --node NAME       Deploy to a single node by name (agent-node-1 or nyx-node)
#   --restart         Restart all milady containers after loading image
#   --rolling         Rolling restart (one container at a time, wait for healthy)
#   --snapshot        Create container snapshots before restarting (default when --restart)
#   --no-snapshot     Skip snapshot before restart
#   --list            Just list running containers, don't deploy
#   --status          Show image and container status on all nodes
#   --dry-run         Show what would be done
#   -h, --help        Show this help
#
# Examples:
#   ./deploy/deploy-to-nodes.sh --status                    # Check current state
#   ./deploy/deploy-to-nodes.sh --list                      # List running containers
#   ./deploy/deploy-to-nodes.sh                             # Load image to all nodes
#   ./deploy/deploy-to-nodes.sh --restart                   # Load + restart all containers
#   ./deploy/deploy-to-nodes.sh --restart --rolling          # Rolling restart
#   ./deploy/deploy-to-nodes.sh --node agent-node-1 --list  # List on one node

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
DEFAULT_IMAGE="milady/agent:latest"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/clawdnet_nodes}"
SSH_USER="${SSH_USER:-root}"
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=15"

declare -A NODE_MAP=(
  ["agent-node-1"]="37.27.190.196"
  ["nyx-node"]="89.167.49.4"
)
ALL_NODES=("agent-node-1" "nyx-node")

# ── Defaults ──────────────────────────────────────────────────────────────────
IMAGE="$DEFAULT_IMAGE"
DO_RESTART=false
DO_ROLLING=false
DO_SNAPSHOT=true  # default: snapshot before restart
DO_LIST=false
DO_STATUS=false
DRY_RUN=false
SELECTED_NODES=()

# ── Colors ────────────────────────────────────────────────────────────────────
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${BLUE}[deploy]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; }
hdr()  { echo -e "\n${CYAN}━━━ $* ━━━${NC}"; }

<<<<<<< HEAD
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

resolve_nodes_file() {
  local candidate
  for candidate in \
    "${DEPLOY_NODES_FILE:-}" \
    "$WORK_DIR/nodes.json" \
    "$WORK_DIR/../deploy/nodes.json" \
    "$REPO_ROOT/deploy/nodes.json"; do
    if [[ -n "$candidate" && -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

default_image_ref() {
  if [[ "$APP_IMAGE" == *:* ]]; then
    printf '%s\n' "$APP_IMAGE"
  else
    printf '%s:latest\n' "$APP_IMAGE"
  fi
}

dedupe_lines() {
  awk '!seen[$0]++'
}

escape_ere() {
  sed 's/[][(){}.^$?+*|/\\-]/\\&/g'
}

join_by() {
  local delimiter="$1"
  shift
  local first=1
  local item
  for item in "$@"; do
    if [[ $first -eq 1 ]]; then
      printf '%s' "$item"
      first=0
    else
      printf '%s%s' "$delimiter" "$item"
    fi
  done
}

NODE_NAMES=()
NODE_IPS=()

add_node() {
  NODE_NAMES+=("$1")
  NODE_IPS+=("$2")
}

find_node_index() {
  local target="$1"
  local i
  for i in "${!NODE_NAMES[@]}"; do
    if [[ "${NODE_NAMES[$i]}" == "$target" ]]; then
      printf '%s\n' "$i"
      return 0
    fi
  done
  return 1
}

node_ip_for() {
  local index
  index="$(find_node_index "$1")" || return 1
  printf '%s\n' "${NODE_IPS[$index]}"
}

build_image_regex() {
  local local_repo="${APP_IMAGE%%:*}"
  local image_tail="${local_repo##*/}"
  local candidate
  local -a candidates=("$local_repo")

  if [[ -n "${APP_REGISTRY:-}" ]]; then
    candidates+=("${APP_REGISTRY}/${local_repo}")
    candidates+=("${APP_REGISTRY}/${image_tail}")
  fi

  local -a escaped=()
  while IFS= read -r candidate; do
    [[ -z "$candidate" ]] && continue
    escaped+=("$(printf '%s' "$candidate" | escape_ere)")
  done < <(printf '%s\n' "${candidates[@]}" | dedupe_lines)

  printf '^(%s)(:|@)' "$(join_by "|" "${escaped[@]}")"
}

ssh_cmd() {
  local ip="$1"
  shift
  local -a cmd=(ssh "${SSH_OPTS[@]}")
  if [[ -n "${SSH_KEY:-}" ]]; then
    cmd+=(-i "$SSH_KEY")
  fi
  cmd+=("${SSH_USER}@${ip}" "$@")
  "${cmd[@]}"
}

list_remote_images_cmd() {
  printf '%s\n' \
    "docker images --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.ID}}\t{{.CreatedSince}}' | grep -E '${IMAGE_REGEX%(:|@)}:' || true"
}

list_remote_containers_cmd() {
  printf '%s\n' \
    "{ printf 'NAMES|IMAGE|STATUS|PORTS\n'; docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}'; } | awk -F'|' -v pattern='${IMAGE_REGEX}' 'NR == 1 || \$2 ~ pattern'"
}

list_remote_container_names_cmd() {
  printf '%s\n' \
    "docker ps --format '{{.Names}}|{{.Image}}' | awk -F'|' -v pattern='${IMAGE_REGEX}' '\$2 ~ pattern { print \$1 }'"
}

command -v docker >/dev/null 2>&1 || { err "docker is required"; exit 1; }
command -v python3 >/dev/null 2>&1 || { err "python3 is required"; exit 1; }

load_env_file "$SCRIPT_DIR/deploy.defaults.env"
CONFIG_FILE="$(resolve_config_file || true)"
if [[ -n "$CONFIG_FILE" ]]; then
  load_env_file "$CONFIG_FILE"
fi

APP_IMAGE="${APP_IMAGE:-eliza:local}"
APP_REGISTRY="${APP_REGISTRY:-}"
DEFAULT_IMAGE="$(default_image_ref)"

NODES_OVERRIDE=""
IMAGE="$DEFAULT_IMAGE"
DO_RESTART=false
DO_ROLLING=false
DO_SNAPSHOT=true
DO_LIST=false
DO_STATUS=false
DRY_RUN=false
SELECTED_NODES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)
      IMAGE="$2"
      shift 2
      ;;
    --nodes)
      NODES_OVERRIDE="$2"
      shift 2
      ;;
    --node)
      SELECTED_NODES+=("$2")
      shift 2
      ;;
    --restart)
      DO_RESTART=true
      shift
      ;;
    --rolling)
      DO_ROLLING=true
      DO_RESTART=true
      shift
      ;;
    --snapshot)
      DO_SNAPSHOT=true
      shift
      ;;
    --no-snapshot)
      DO_SNAPSHOT=false
      shift
      ;;
    --list)
      DO_LIST=true
      shift
      ;;
    --status)
      DO_STATUS=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      sed -n '1,26p' "$0" | sed 's/^# \{0,1\}//'
=======
ssh_cmd() {
  local ip="$1"; shift
  ssh $SSH_OPTS -i "$SSH_KEY" "${SSH_USER}@${ip}" "$@"
}

list_remote_images_cmd() {
  cat <<'EOF'
docker images --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.ID}}\t{{.CreatedSince}}' | grep -E '^(milady/agent|ghcr\.io/milady-ai/agent|ghcr\.io/milady-ai/milady/agent):' || true
EOF
}

list_remote_containers_cmd() {
  cat <<'EOF'
{
  printf 'NAMES|IMAGE|STATUS|PORTS\n'
  docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}'
} | awk -F'|' 'NR == 1 || $2 ~ /^(milady\/agent|ghcr\.io\/milady-ai\/agent|ghcr\.io\/milady-ai\/milady\/agent)(:|@)/'
EOF
}

list_remote_container_names_cmd() {
  cat <<'EOF'
docker ps --format '{{.Names}}|{{.Image}}' | awk -F'|' '$2 ~ /^(milady\/agent|ghcr\.io\/milady-ai\/agent|ghcr\.io\/milady-ai\/milady\/agent)(:|@)/ { print $1 }'
EOF
}

# ── Parse Args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --image)        IMAGE="$2"; shift 2 ;;
    --node)
      if [[ -z "${NODE_MAP[$2]+x}" ]]; then
        err "Unknown node: $2 (known: ${ALL_NODES[*]})"
        exit 1
      fi
      SELECTED_NODES+=("$2"); shift 2 ;;
    --restart)      DO_RESTART=true; shift ;;
    --rolling)      DO_ROLLING=true; DO_RESTART=true; shift ;;
    --snapshot)     DO_SNAPSHOT=true; shift ;;
    --no-snapshot)  DO_SNAPSHOT=false; shift ;;
    --list)         DO_LIST=true; shift ;;
    --status)       DO_STATUS=true; shift ;;
    --dry-run)      DRY_RUN=true; shift ;;
    -h|--help)
      head -28 "$0" | grep '^#' | sed 's/^# \?//'
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      exit 1
      ;;
  esac
done

<<<<<<< HEAD
ALL_NODES=()

if [[ -n "$NODES_OVERRIDE" ]]; then
  IFS=',' read -r -a override_entries <<<"$NODES_OVERRIDE"
  for entry in "${override_entries[@]}"; do
    [[ -z "$entry" ]] && continue
    name="${entry%%:*}"
    ip="${entry#*:}"
    if [[ -z "$name" || -z "$ip" || "$name" == "$ip" ]]; then
      err "Invalid --nodes entry: $entry"
      exit 1
    fi
    add_node "$name" "$ip"
    ALL_NODES+=("$name")
  done
else
  NODES_FILE="$(resolve_nodes_file || true)"
  if [[ -z "$NODES_FILE" ]]; then
    err "nodes.json not found. Set DEPLOY_NODES_FILE or run from a deploy config directory."
    exit 1
  fi

  parsed_nodes="$(python3 - "$NODES_FILE" <<'PY'
import json
import os
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    data = json.load(fh)

nodes = data.get("nodes") or {}
if not isinstance(nodes, dict):
    raise SystemExit("nodes.json: .nodes must be an object")

print(os.path.expanduser(str(data.get("sshKey", ""))))
print(str(data.get("sshUser", "root")))
for name, ip in nodes.items():
    print(f"{name}\t{ip}")
PY
)"

  SSH_KEY="${SSH_KEY:-$(printf '%s\n' "$parsed_nodes" | sed -n '1p')}"
  SSH_USER="${SSH_USER:-$(printf '%s\n' "$parsed_nodes" | sed -n '2p')}"

  while IFS=$'\t' read -r name ip; do
    [[ -z "$name" || -z "$ip" ]] && continue
    add_node "$name" "$ip"
    ALL_NODES+=("$name")
  done <<EOF
$(printf '%s\n' "$parsed_nodes" | tail -n +3)
EOF
fi

SSH_USER="${SSH_USER:-root}"
IMAGE_REGEX="$(build_image_regex)"

if [[ ${#ALL_NODES[@]} -eq 0 ]]; then
  err "No nodes configured."
  exit 1
fi

if [[ ${#SELECTED_NODES[@]} -eq 0 ]]; then
  SELECTED_NODES=("${ALL_NODES[@]}")
else
  for node in "${SELECTED_NODES[@]}"; do
    if ! find_node_index "$node" >/dev/null 2>&1; then
      err "Unknown node: $node (known: ${ALL_NODES[*]})"
      exit 1
    fi
  done
fi

if $DO_STATUS; then
  for node in "${SELECTED_NODES[@]}"; do
    ip="$(node_ip_for "$node")"
    hdr "$node ($ip)"
    echo -e "${YELLOW}Images:${NC}"
    ssh_cmd "$ip" "$(list_remote_images_cmd)" 2>/dev/null || warn "Failed to connect"
=======
# Default to all nodes if none selected
if [[ ${#SELECTED_NODES[@]} -eq 0 ]]; then
  SELECTED_NODES=("${ALL_NODES[@]}")
fi

# ── Status mode ───────────────────────────────────────────────────────────────
if $DO_STATUS; then
  for node in "${SELECTED_NODES[@]}"; do
    ip="${NODE_MAP[$node]}"
    hdr "$node ($ip)"
    
    echo -e "${YELLOW}Images:${NC}"
    ssh_cmd "$ip" "$(list_remote_images_cmd)" 2>/dev/null || warn "Failed to connect"
    
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
    echo -e "\n${YELLOW}Running containers:${NC}"
    ssh_cmd "$ip" "$(list_remote_containers_cmd)" 2>/dev/null || true
  done
  exit 0
fi

<<<<<<< HEAD
if $DO_LIST; then
  for node in "${SELECTED_NODES[@]}"; do
    ip="$(node_ip_for "$node")"
=======
# ── List mode ─────────────────────────────────────────────────────────────────
if $DO_LIST; then
  for node in "${SELECTED_NODES[@]}"; do
    ip="${NODE_MAP[$node]}"
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
    hdr "$node ($ip)"
    ssh_cmd "$ip" "$(list_remote_containers_cmd)" 2>/dev/null || warn "Failed to connect"
  done
  exit 0
fi

<<<<<<< HEAD
log "Image: ${YELLOW}${IMAGE}${NC}"
log "Nodes: ${YELLOW}${SELECTED_NODES[*]}${NC}"
=======
# ── Deploy image ──────────────────────────────────────────────────────────────
log "Image: ${YELLOW}${IMAGE}${NC}"
log "Nodes: ${YELLOW}${SELECTED_NODES[*]}${NC}"

>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
if $DRY_RUN; then
  warn "DRY RUN mode"
fi

<<<<<<< HEAD
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  err "Image $IMAGE not found locally."
  exit 1
fi

TMPFILE="$(mktemp /tmp/eliza-deploy-XXXXXX.tar)"
trap 'rm -f "$TMPFILE"' EXIT

if ! $DRY_RUN; then
  log "Saving image to tarball..."
  docker save "$IMAGE" >"$TMPFILE"
  TAR_SIZE="$(du -h "$TMPFILE" | cut -f1)"
  ok "Saved ($TAR_SIZE)"
fi

for node in "${SELECTED_NODES[@]}"; do
  ip="$(node_ip_for "$node")"
  hdr "$node ($ip)"

  if $DRY_RUN; then
    echo "  Would load $IMAGE"
    if $DO_RESTART; then
      echo "  Would restart matching containers"
    fi
    continue
  fi

  log "Loading image..."
  LOAD_START="$(date +%s)"
  ssh_cmd "$ip" "docker load" <"$TMPFILE"
  LOAD_END="$(date +%s)"
  ok "Loaded in $((LOAD_END - LOAD_START))s"

  CONTAINERS="$(ssh_cmd "$ip" "$(list_remote_container_names_cmd)" 2>/dev/null || true)"
  if [[ -z "$CONTAINERS" ]]; then
    warn "No running containers matched the configured image filter on $node"
    continue
  fi

  CONTAINER_COUNT="$(printf '%s\n' "$CONTAINERS" | sed '/^$/d' | wc -l | tr -d ' ')"
  log "Found ${YELLOW}${CONTAINER_COUNT}${NC} running container(s)"
  printf '%s\n' "$CONTAINERS" | sed '/^$/d' | while read -r container; do
    echo "  - $container"
  done

  if ! $DO_RESTART; then
    continue
  fi

  printf '%s\n' "$CONTAINERS" | sed '/^$/d' | while read -r container; do
    log "Restarting ${YELLOW}${container}${NC}..."

    if $DO_SNAPSHOT; then
      SNAP_NAME="${container}-pre-deploy-$(date +%Y%m%d-%H%M%S)"
      log "Creating snapshot: $SNAP_NAME"
      ssh_cmd "$ip" "docker commit $container $SNAP_NAME" >/dev/null 2>&1 && \
        ok "Snapshot created" || \
        warn "Snapshot failed (continuing anyway)"
    fi

    CONTAINER_ENV="$(ssh_cmd "$ip" "docker inspect --format '{{range .Config.Env}}--env {{.}} {{end}}' $container" 2>/dev/null || true)"
    CONTAINER_PORTS="$(ssh_cmd "$ip" "docker inspect --format '{{range \$p, \$conf := .NetworkSettings.Ports}}{{range \$conf}}-p {{.HostIp}}:{{.HostPort}}:{{index (split \$p \"/\") 0}} {{end}}{{end}}' $container" 2>/dev/null || true)"
    CONTAINER_VOLS="$(ssh_cmd "$ip" "docker inspect --format '{{range .Mounts}}-v {{.Source}}:{{.Destination}} {{end}}' $container" 2>/dev/null || true)"
    CONTAINER_NET="$(ssh_cmd "$ip" "docker inspect --format '{{range \$net, \$conf := .NetworkSettings.Networks}}--network {{\$net}} {{end}}' $container" 2>/dev/null || true)"
    CONTAINER_RESTART="$(ssh_cmd "$ip" "docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' $container" 2>/dev/null || echo "unless-stopped")"

    log "Stopping $container..."
    ssh_cmd "$ip" "docker stop -t 30 $container" >/dev/null 2>&1 || true
    ssh_cmd "$ip" "docker rm $container" >/dev/null 2>&1 || true

    log "Starting $container with new image..."
    ssh_cmd "$ip" "docker run -d \
      --name $container \
      --restart=$CONTAINER_RESTART \
      $CONTAINER_ENV \
      $CONTAINER_PORTS \
      $CONTAINER_VOLS \
      $CONTAINER_NET \
      $IMAGE" >/dev/null 2>&1

    if $DO_ROLLING; then
      log "Waiting for $container to become healthy..."
      for _ in $(seq 1 60); do
        STATUS="$(ssh_cmd "$ip" "docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' $container" 2>/dev/null || echo "unknown")"
        if [[ "$STATUS" == "healthy" || "$STATUS" == "running" ]]; then
          ok "$container is ready"
          break
        fi
        if [[ "$STATUS" == "unhealthy" ]]; then
          err "$container is unhealthy. Check logs:"
          echo "  ssh ${SSH_USER}@${ip} 'docker logs --tail 50 $container'"
          break
        fi
        sleep 5
      done
    fi
  done
done
=======
# Check image exists locally
if ! docker image inspect "$IMAGE" &>/dev/null; then
  err "Image $IMAGE not found locally. Build it first:"
  echo "  ./scripts/build-image.sh --tag latest"
  exit 1
fi

# Save image to temp file
TMPFILE=$(mktemp /tmp/milady-deploy-XXXXXX.tar)
trap "rm -f $TMPFILE" EXIT

if ! $DRY_RUN; then
  log "Saving image to tarball..."
  docker save "$IMAGE" > "$TMPFILE"
  TAR_SIZE=$(du -h "$TMPFILE" | cut -f1)
  ok "Saved ($TAR_SIZE)"
fi

# Push to each node
for node in "${SELECTED_NODES[@]}"; do
  ip="${NODE_MAP[$node]}"
  hdr "$node ($ip)"
  
  if $DRY_RUN; then
    echo "  Would load $IMAGE"
    if $DO_RESTART; then echo "  Would restart milady containers"; fi
    continue
  fi
  
  # Load image
  log "Loading image..."
  LOAD_START=$(date +%s)
  ssh_cmd "$ip" "docker load" < "$TMPFILE"
  LOAD_END=$(date +%s)
  ok "Loaded in $((LOAD_END - LOAD_START))s"
  
  # Get running milady containers
  CONTAINERS=$(ssh_cmd "$ip" "$(list_remote_container_names_cmd)" 2>/dev/null || true)
  
  if [[ -z "$CONTAINERS" ]]; then
    warn "No running milady containers on $node"
    continue
  fi
  
  CONTAINER_COUNT=$(echo "$CONTAINERS" | wc -l)
  log "Found ${YELLOW}${CONTAINER_COUNT}${NC} running container(s)"
  echo "$CONTAINERS" | while read -r c; do echo "  - $c"; done
  
  # Restart containers if requested
  if $DO_RESTART; then
    echo "$CONTAINERS" | while read -r container; do
      [[ -z "$container" ]] && continue
      
      log "Restarting ${YELLOW}${container}${NC}..."
      
      # Snapshot before restart
      if $DO_SNAPSHOT; then
        SNAP_NAME="${container}-pre-deploy-$(date +%Y%m%d-%H%M%S)"
        log "Creating snapshot: $SNAP_NAME"
        ssh_cmd "$ip" "docker commit $container $SNAP_NAME" 2>/dev/null && \
          ok "Snapshot created" || \
          warn "Snapshot failed (continuing anyway)"
      fi
      
      # Get container config for recreation
      CONTAINER_ENV=$(ssh_cmd "$ip" "docker inspect --format '{{range .Config.Env}}--env {{.}} {{end}}' $container" 2>/dev/null || true)
      CONTAINER_PORTS=$(ssh_cmd "$ip" "docker inspect --format '{{range \$p, \$conf := .NetworkSettings.Ports}}{{range \$conf}}-p {{.HostIp}}:{{.HostPort}}:{{index (split \$p \"/\") 0}} {{end}}{{end}}' $container" 2>/dev/null || true)
      CONTAINER_VOLS=$(ssh_cmd "$ip" "docker inspect --format '{{range .Mounts}}-v {{.Source}}:{{.Destination}} {{end}}' $container" 2>/dev/null || true)
      CONTAINER_NET=$(ssh_cmd "$ip" "docker inspect --format '{{range \$net, \$conf := .NetworkSettings.Networks}}--network {{\$net}} {{end}}' $container" 2>/dev/null || true)
      CONTAINER_RESTART=$(ssh_cmd "$ip" "docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' $container" 2>/dev/null || echo "unless-stopped")
      
      # Stop old container
      log "Stopping $container..."
      ssh_cmd "$ip" "docker stop -t 30 $container" 2>/dev/null
      ssh_cmd "$ip" "docker rm $container" 2>/dev/null
      
      # Start new container
      log "Starting $container with new image..."
      ssh_cmd "$ip" "docker run -d \
        --name $container \
        --restart=$CONTAINER_RESTART \
        $CONTAINER_ENV \
        $CONTAINER_PORTS \
        $CONTAINER_VOLS \
        $CONTAINER_NET \
        $IMAGE" 2>/dev/null
      
      # Wait for healthy if rolling
      if $DO_ROLLING; then
        log "Waiting for $container to become healthy..."
        for i in $(seq 1 60); do
          STATUS=$(ssh_cmd "$ip" "docker inspect --format '{{.State.Health.Status}}' $container" 2>/dev/null || echo "unknown")
          if [[ "$STATUS" == "healthy" ]]; then
            ok "$container is healthy"
            break
          fi
          if [[ "$STATUS" == "unhealthy" ]]; then
            err "$container is unhealthy! Check logs:"
            echo "  ssh -i $SSH_KEY ${SSH_USER}@${ip} 'docker logs --tail 50 $container'"
            break
          fi
          sleep 5
        done
        if [[ "$STATUS" != "healthy" && "$STATUS" != "unhealthy" ]]; then
          warn "Timed out waiting for $container health check (status: $STATUS)"
        fi
      fi
      
      ok "$container restarted"
    done
  fi
done

echo ""
ok "Deploy complete!"
if ! $DO_RESTART; then
  echo ""
  echo "  Image loaded but containers not restarted."
  echo "  To restart containers:"
  echo "    $0 --restart"
  echo "    $0 --restart --rolling   # one at a time"
fi
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
