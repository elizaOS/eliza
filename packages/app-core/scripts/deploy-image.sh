#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-image.sh — Deploy a eliza/agent image to running containers
#
# Usage:
#   ./scripts/deploy-image.sh [OPTIONS]
#
# Options:
#   --image TAG           Image to deploy (default: eliza/agent:latest or
#                         current image of targeted containers)
#   --container-id ID     Deploy to a specific container (by name or ID)
#   --all                 Deploy to ALL eliza containers on eliza-core-1
#   --server HOST         SSH target (default: ${DEPLOY_SERVER:-"root@your-server"})
#   --list                List running eliza containers and exit
#   --dry-run             Show what would be done without doing it
#   -h, --help            Show this help
#
# What this does per container:
#   1. Capture current env vars, port bindings, volume mounts, network, restart policy
#   2. Stop and remove the old container
#   3. Start a new container with the same name/config but new image
#   4. Wait for health check (up to 90 seconds)
#   5. Report success or failure
#
# Examples:
#   ./scripts/deploy-image.sh --list
#   ./scripts/deploy-image.sh --all --image eliza/agent:v2.0.0-alpha.54
#   ./scripts/deploy-image.sh --container-id eliza-373b9e29-c68b-47a0-85f4-ede46f4a0dec
#   ./scripts/deploy-image.sh --all --dry-run
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Server config ─────────────────────────────────────────────────────────────
DEFAULT_SERVER="${DEPLOY_SERVER:-"root@your-server"}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=20"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${BLUE}[deploy]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; }
hdr()  { echo -e "\n${CYAN}${BOLD}━━━ $* ━━━${NC}"; }
die()  { err "$*"; exit 1; }

# ── Defaults ──────────────────────────────────────────────────────────────────
TARGET_SERVER="$DEFAULT_SERVER"
TARGET_IMAGE=""
TARGET_CONTAINER=""
DEPLOY_ALL=false
DO_LIST=false
DRY_RUN=false

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --image)         TARGET_IMAGE="$2"; shift 2 ;;
    --container-id)  TARGET_CONTAINER="$2"; DEPLOY_ALL=false; shift 2 ;;
    --all)           DEPLOY_ALL=true; shift ;;
    --server)        TARGET_SERVER="$2"; shift 2 ;;
    --list)          DO_LIST=true; shift ;;
    --dry-run)       DRY_RUN=true; shift ;;
    -h|--help)
      grep '^#' "$0" | head -30 | sed 's/^# \?//'
      exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

if ! $DO_LIST && ! $DEPLOY_ALL && [[ -z "$TARGET_CONTAINER" ]]; then
  die "Specify --all, --container-id <name>, or --list (try --help)"
fi

# ── SSH helper ────────────────────────────────────────────────────────────────
ssh_run() {
  if $DRY_RUN; then
    echo -e "  ${CYAN}[dry-run ssh]${NC} $*"
    return 0
  fi
  ssh $SSH_OPTS -i "$SSH_KEY" "$TARGET_SERVER" "$@"
}

log "Server: ${YELLOW}${TARGET_SERVER}${NC}"

# ── List mode ─────────────────────────────────────────────────────────────────
if $DO_LIST; then
  hdr "Eliza containers on ${TARGET_SERVER}"
  ssh_run "docker ps -a \
    --filter 'name=eliza' \
    --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'"
  exit 0
fi

# ── Discover containers to deploy ─────────────────────────────────────────────
hdr "Discovering containers"

if $DEPLOY_ALL; then
  log "Fetching all eliza containers from ${TARGET_SERVER}..."
  if $DRY_RUN; then
    # In dry-run we can't SSH, so show what we'd do conceptually
    warn "[dry-run] Would query: docker ps --filter 'name=eliza' --format '{{.Names}}'"
    warn "[dry-run] Then redeploy each container found"
    echo ""
    ok "[dry-run] Showing a simulated deploy for illustration"
    # Use a placeholder container list for dry-run
    CONTAINER_LIST=("eliza-<container-1>" "eliza-<container-2>")
  else
    # Get container names (not IDs — names are used with docker inspect)
    mapfile -t CONTAINER_LIST < <(
      ssh $SSH_OPTS -i "$SSH_KEY" "$TARGET_SERVER" \
        "docker ps --filter 'name=eliza' --format '{{.Names}}'" 2>/dev/null
    )
    if [[ ${#CONTAINER_LIST[@]} -eq 0 ]]; then
      warn "No running eliza containers found on ${TARGET_SERVER}"
      exit 0
    fi
    log "Found ${#CONTAINER_LIST[@]} container(s):"
    for name in "${CONTAINER_LIST[@]}"; do echo "  - $name"; done
  fi
else
  # Single container specified by name or ID
  CONTAINER_LIST=("$TARGET_CONTAINER")
  log "Target container: ${YELLOW}${TARGET_CONTAINER}${NC}"
fi

$DRY_RUN && warn "DRY RUN — no changes will be made"

# ── Track results ─────────────────────────────────────────────────────────────
RESULTS=()
FAILED=()

# ── Deploy function ───────────────────────────────────────────────────────────
deploy_container() {
  local container="$1"
  hdr "Deploying: ${container}"

  # ── Inspect current container ───────────────────────────────────────────────
  log "Inspecting container..."

  # Get the current image (use TARGET_IMAGE if specified, otherwise preserve current image)
  local current_image
  current_image=$(ssh_run "docker inspect --format '{{.Config.Image}}' '${container}'" 2>/dev/null || echo "")
  [[ -z "$current_image" ]] && die "Container '${container}' not found on ${TARGET_SERVER}"

  local new_image="${TARGET_IMAGE:-$current_image}"
  log "  Current image: ${YELLOW}${current_image}${NC}"
  log "  New image:     ${GREEN}${new_image}${NC}"

  # Verify the new image exists on the server
  if ! $DRY_RUN; then
    if ! ssh_run "docker image inspect '${new_image}' > /dev/null 2>&1"; then
      err "Image '${new_image}' not found on ${TARGET_SERVER}"
      err "Run: ./scripts/build-image.sh --push  OR  ./scripts/build-image.sh --remote"
      FAILED+=("${container}: image not found")
      return 1
    fi
  fi

  # Get restart policy
  local restart_policy
  restart_policy=$(ssh_run "docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' '${container}'" 2>/dev/null || echo "unless-stopped")
  [[ -z "$restart_policy" || "$restart_policy" == "no" ]] && restart_policy="unless-stopped"

  # Capture all env vars (preserves both ELIZA_* and ELIZA_* and any others)
  # Format them as --env KEY=VALUE args for docker run
  local env_args
  env_args=$(ssh_run "docker inspect --format \
    '{{range .Config.Env}}{{println .}}{{end}}' '${container}'" 2>/dev/null \
    | grep -v '^$' \
    | grep -v '^PATH=' \
    | grep -v '^NODE_VERSION=' \
    | grep -v '^YARN_VERSION=' \
    | sed "s/^/--env '/" \
    | sed "s/$/'/" \
    | tr '\n' ' ')

  # Capture port mappings: format -p host_port:container_port
  local port_args
  port_args=$(ssh_run "docker inspect --format \
    '{{range \$port, \$bindings := .HostConfig.PortBindings}}{{range \$bindings}}-p {{if .HostIp}}{{.HostIp}}:{{end}}{{.HostPort}}:{{(split \$port \"/\") | index 0}} {{end}}{{end}}' \
    '${container}'" 2>/dev/null || echo "")

  # Capture volume mounts
  local volume_args
  volume_args=$(ssh_run "docker inspect --format \
    '{{range .Mounts}}{{if eq .Type \"bind\"}}-v {{.Source}}:{{.Destination}}{{if .RW}}{{else}}:ro{{end}} {{end}}{{end}}' \
    '${container}'" 2>/dev/null || echo "")

  # Capture network
  local network_args
  network_args=$(ssh_run "docker inspect --format \
    '{{range \$net, \$conf := .NetworkSettings.Networks}}--network {{\$net}} {{end}}' \
    '${container}'" 2>/dev/null | sed 's/--network bridge//' | xargs)

  log "  Restart: ${restart_policy}"
  log "  Ports:   ${port_args:-none}"
  log "  Volumes: ${volume_args:-none}"
  log "  Network: ${network_args:-default}"

  if $DRY_RUN; then
    warn "[dry-run] Would stop, rm, and recreate ${container} with ${new_image}"
    RESULTS+=("${container}: would redeploy with ${new_image}")
    return 0
  fi

  # ── Stop and remove old container ───────────────────────────────────────────
  log "Stopping container (30s timeout)..."
  ssh_run "docker stop -t 30 '${container}'" 2>/dev/null || warn "Stop timed out or container already stopped"
  
  log "Removing old container..."
  ssh_run "docker rm '${container}'" 2>/dev/null || warn "Remove failed (may already be gone)"

  # ── Start new container ─────────────────────────────────────────────────────
  log "Starting new container with ${new_image}..."
  
  # Build the docker run command
  # We explicitly pass all env vars so nothing is lost between versions
  local run_cmd="docker run -d \
    --name '${container}' \
    --restart=${restart_policy} \
    ${env_args} \
    ${port_args} \
    ${volume_args} \
    ${network_args} \
    '${new_image}'"

  local new_id
  new_id=$(ssh_run "${run_cmd}" 2>&1)
  
  if [[ -z "$new_id" ]]; then
    err "Failed to start container ${container}"
    FAILED+=("${container}: start failed")
    return 1
  fi
  
  ok "Container started: ${new_id:0:12}"

  # ── Wait for health check ───────────────────────────────────────────────────
  log "Waiting for health check (up to 90s)..."
  local status="starting"
  local attempts=0
  local max_attempts=18  # 18 × 5s = 90s

  while [[ $attempts -lt $max_attempts ]]; do
    sleep 5
    status=$(ssh_run "docker inspect --format '{{.State.Health.Status}}' '${container}'" 2>/dev/null || echo "unknown")
    attempts=$((attempts + 1))
    
    case "$status" in
      healthy)
        ok "Container ${container} is ${GREEN}healthy${NC}"
        RESULTS+=("${container}: ✓ healthy (${new_image})")
        return 0
        ;;
      unhealthy)
        err "Container ${container} is ${RED}unhealthy${NC}!"
        echo -e "  Last logs:"
        ssh_run "docker logs --tail 30 '${container}'" 2>&1 | sed 's/^/    /' || true
        FAILED+=("${container}: unhealthy")
        return 1
        ;;
      none|"")
        # No healthcheck defined — check if it's running
        local running
        running=$(ssh_run "docker inspect --format '{{.State.Running}}' '${container}'" 2>/dev/null || echo "false")
        if [[ "$running" == "true" ]]; then
          ok "Container ${container} is ${GREEN}running${NC} (no healthcheck)"
          RESULTS+=("${container}: ✓ running (no healthcheck) (${new_image})")
          return 0
        fi
        ;;
      starting)
        echo -ne "  [${attempts}/${max_attempts}] Still starting...\r"
        ;;
      *)
        echo -ne "  [${attempts}/${max_attempts}] Status: ${status}\r"
        ;;
    esac
  done

  # Timed out waiting
  warn "Timed out waiting for health check (last status: ${status})"
  warn "Check manually: ssh ${TARGET_SERVER} 'docker logs ${container}'"
  RESULTS+=("${container}: ⚠ timeout (status: ${status}) (${new_image})")
}

# ── Deploy each container ─────────────────────────────────────────────────────
for container in "${CONTAINER_LIST[@]}"; do
  [[ -z "$container" ]] && continue
  deploy_container "$container" || true
done

# ── Report results ────────────────────────────────────────────────────────────
hdr "Results"

if [[ ${#RESULTS[@]} -gt 0 ]]; then
  echo -e "${GREEN}Succeeded:${NC}"
  for r in "${RESULTS[@]}"; do
    echo "  ✓ $r"
  done
fi

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo ""
  echo -e "${RED}Failed:${NC}"
  for f in "${FAILED[@]}"; do
    echo "  ✗ $f"
  done
  echo ""
  err "Some containers failed to deploy"
  exit 1
fi

echo ""
ok "${BOLD}Deploy complete!${NC} (${#RESULTS[@]} container(s))"
