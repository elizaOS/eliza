#!/usr/bin/env bash
# deploy-to-nodes.sh — Deploy eliza/agent image to Docker nodes
#
# Usage:
#   ./deploy/deploy-to-nodes.sh [OPTIONS]
#
# Options:
#   --image TAG       Image to deploy (default: eliza/agent:latest)
#   --nodes LIST      Comma-separated node list: name:ip (overrides defaults)
#   --node NAME       Deploy to a single node by name (agent-node-1 or nyx-node)
#   --restart         Restart all eliza containers after loading image
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
DEFAULT_IMAGE="eliza/agent:latest"
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

ssh_cmd() {
  local ip="$1"; shift
  ssh $SSH_OPTS -i "$SSH_KEY" "${SSH_USER}@${ip}" "$@"
}

list_remote_images_cmd() {
  cat <<'EOF'
docker images --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.ID}}\t{{.CreatedSince}}' | grep -E '^(eliza/agent|ghcr\.io/eliza-ai/agent|ghcr\.io/eliza-ai/eliza/agent):' || true
EOF
}

list_remote_containers_cmd() {
  cat <<'EOF'
{
  printf 'NAMES|IMAGE|STATUS|PORTS\n'
  docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}'
} | awk -F'|' 'NR == 1 || $2 ~ /^(eliza\/agent|ghcr\.io\/eliza-ai\/agent|ghcr\.io\/eliza-ai\/eliza\/agent)(:|@)/'
EOF
}

list_remote_container_names_cmd() {
  cat <<'EOF'
docker ps --format '{{.Names}}|{{.Image}}' | awk -F'|' '$2 ~ /^(eliza\/agent|ghcr\.io\/eliza-ai\/agent|ghcr\.io\/eliza-ai\/eliza\/agent)(:|@)/ { print $1 }'
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
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      exit 1
      ;;
  esac
done

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
    
    echo -e "\n${YELLOW}Running containers:${NC}"
    ssh_cmd "$ip" "$(list_remote_containers_cmd)" 2>/dev/null || true
  done
  exit 0
fi

# ── List mode ─────────────────────────────────────────────────────────────────
if $DO_LIST; then
  for node in "${SELECTED_NODES[@]}"; do
    ip="${NODE_MAP[$node]}"
    hdr "$node ($ip)"
    ssh_cmd "$ip" "$(list_remote_containers_cmd)" 2>/dev/null || warn "Failed to connect"
  done
  exit 0
fi

# ── Deploy image ──────────────────────────────────────────────────────────────
log "Image: ${YELLOW}${IMAGE}${NC}"
log "Nodes: ${YELLOW}${SELECTED_NODES[*]}${NC}"

if $DRY_RUN; then
  warn "DRY RUN mode"
fi

# Check image exists locally
if ! docker image inspect "$IMAGE" &>/dev/null; then
  err "Image $IMAGE not found locally. Build it first:"
  echo "  ./scripts/build-image.sh --tag latest"
  exit 1
fi

# Save image to temp file
TMPFILE=$(mktemp /tmp/eliza-deploy-XXXXXX.tar)
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
    if $DO_RESTART; then echo "  Would restart eliza containers"; fi
    continue
  fi
  
  # Load image
  log "Loading image..."
  LOAD_START=$(date +%s)
  ssh_cmd "$ip" "docker load" < "$TMPFILE"
  LOAD_END=$(date +%s)
  ok "Loaded in $((LOAD_END - LOAD_START))s"
  
  # Get running eliza containers
  CONTAINERS=$(ssh_cmd "$ip" "$(list_remote_container_names_cmd)" 2>/dev/null || true)
  
  if [[ -z "$CONTAINERS" ]]; then
    warn "No running eliza containers on $node"
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
