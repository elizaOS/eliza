#!/usr/bin/env bash
# orchestrate.sh — find or reuse an existing Nebius H200, run DFlash distillation,
# then STOP the instance automatically when training finishes.
#
# Never creates new instances — uses whatever is already RUNNING.
# Injects the caller's SSH public key into the instance if needed.
#
# Usage:
#   bash orchestrate.sh [--tiers 0_8b,2b] [--dry-run] [--synthetic-smoke]
#   bash orchestrate.sh --instance-id computeinstance-xxx [...]
#
# Env vars (optional):
#   NEBIUS_INSTANCE_ID   Override auto-discovery with a specific instance ID
#   SSH_KEY_FILE         Private key for SSH (default: ~/.ssh/id_ed25519)
#   SSH_PUBKEY_FILE      Public key to inject (default: SSH_KEY_FILE + .pub)
#   NEBIUS_SSH_USER      SSH username on the instance (default: ubuntu)
#   REMOTE_REPO_PATH     Path to eliza repo on the instance
#                        (default: ~/eliza-workspace/milady/eliza)
#   TARGET_CHECKPOINT_ROOT / DATASET_ROOT / OUTPUT_ROOT  (forwarded to launch script)
set -euo pipefail

# ── helpers ────────────────────────────────────────────────────────────────────
log() { printf '[orchestrate] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "FATAL: $*" >&2; exit 1; }

# ── config ────────────────────────────────────────────────────────────────────
SSH_KEY_FILE="${SSH_KEY_FILE:-${HOME}/.ssh/id_ed25519}"
SSH_PUBKEY_FILE="${SSH_PUBKEY_FILE:-${SSH_KEY_FILE}.pub}"
NEBIUS_SSH_USER="${NEBIUS_SSH_USER:-ubuntu}"
REMOTE_REPO_PATH="${REMOTE_REPO_PATH:-~/eliza-workspace/milady/eliza}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── parse args ────────────────────────────────────────────────────────────────
DRY_RUN=0
SYNTHETIC_SMOKE=0
TIERS_ARG=""
INSTANCE_ID="${NEBIUS_INSTANCE_ID:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)          DRY_RUN=1; shift ;;
    --synthetic-smoke)  SYNTHETIC_SMOKE=1; shift ;;
    --tiers)            TIERS_ARG="$2"; shift 2 ;;
    --tiers=*)          TIERS_ARG="${1#--tiers=}"; shift ;;
    --instance-id)      INSTANCE_ID="$2"; shift 2 ;;
    --instance-id=*)    INSTANCE_ID="${1#--instance-id=}"; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) die "Unknown arg: $1" ;;
  esac
done

[[ -f "${SSH_KEY_FILE}" ]]    || die "SSH private key not found: ${SSH_KEY_FILE}"
[[ -f "${SSH_PUBKEY_FILE}" ]] || die "SSH public key not found: ${SSH_PUBKEY_FILE}"

LOCAL_PUBKEY="$(cat "${SSH_PUBKEY_FILE}")"

# ── discover instance ─────────────────────────────────────────────────────────
if [[ -z "${INSTANCE_ID}" ]]; then
  log "Discovering running H200 instances..."
  # Pick the first RUNNING gpu-h200-sxm instance by name prefix eliza-train-h200
  INSTANCE_ID="$(
    nebius compute instance list --format json 2>/dev/null \
      | python3 -c "
import json, sys
data = json.load(sys.stdin)
for item in data.get('items', []):
    st = item.get('status', {}).get('state', '')
    platform = item.get('spec', {}).get('resources', {}).get('platform', '')
    name = item.get('metadata', {}).get('name', '')
    iid  = item.get('metadata', {}).get('id', '')
    if st == 'RUNNING' and 'h200' in platform and name.startswith('eliza-train'):
        print(iid)
        break
" || true
  )"
  [[ -n "${INSTANCE_ID}" ]] || die "No running eliza-train H200 instance found. Start one first."
  log "Found instance: ${INSTANCE_ID}"
fi

# ── fetch instance details ─────────────────────────────────────────────────────
INSTANCE_JSON="$(nebius compute instance get --id "${INSTANCE_ID}" --format json 2>/dev/null)"
INSTANCE_NAME="$(echo "${INSTANCE_JSON}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['metadata']['name'])")"
INSTANCE_STATE="$(echo "${INSTANCE_JSON}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['status']['state'])")"
PUBLIC_IP="$(echo "${INSTANCE_JSON}" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for ni in d.get('status', {}).get('network_interfaces', []):
    addr = ni.get('public_ip_address', {}).get('address', '')
    if addr:
        print(addr.split('/')[0])
        break
" || true)"
RESOURCE_VERSION="$(echo "${INSTANCE_JSON}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['metadata']['resource_version'])")"
CURRENT_CLOUD_INIT="$(echo "${INSTANCE_JSON}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['spec'].get('cloud_init_user_data',''))")"

log "Instance: ${INSTANCE_NAME} | state=${INSTANCE_STATE} | ip=${PUBLIC_IP}"

[[ "${INSTANCE_STATE}" == "RUNNING" ]] || die "Instance ${INSTANCE_ID} is not RUNNING (state=${INSTANCE_STATE})"
[[ -n "${PUBLIC_IP}" ]] || die "Instance has no public IP address"

# ── inject SSH key if not already present ─────────────────────────────────────
KEY_FINGERPRINT="$(ssh-keygen -l -f "${SSH_PUBKEY_FILE}" | awk '{print $2}')"
log "Checking SSH access (key fingerprint: ${KEY_FINGERPRINT})..."

ssh_ok=0
if ssh -i "${SSH_KEY_FILE}" \
       -o ConnectTimeout=8 \
       -o StrictHostKeyChecking=no \
       -o BatchMode=yes \
       "${NEBIUS_SSH_USER}@${PUBLIC_IP}" \
       "echo ssh-ok" 2>/dev/null | grep -q "ssh-ok"; then
  ssh_ok=1
  log "SSH access confirmed with existing key."
fi

if (( ! ssh_ok )); then
  log "SSH denied — injecting key via instance update + reboot."

  # Build new cloud-init that adds our key to authorized_keys.
  # We append to whatever keys were already in the cloud-init.
  NEW_CLOUD_INIT="$(python3 - <<PYEOF
import yaml, sys

raw = """${CURRENT_CLOUD_INIT}"""
try:
    cfg = yaml.safe_load(raw) or {}
except Exception:
    cfg = {}

if not isinstance(cfg, dict):
    cfg = {}

users = cfg.get('users', [])
if not isinstance(users, list):
    users = []

pubkey = """${LOCAL_PUBKEY}"""

# Find or create the ubuntu user entry.
ubuntu_user = None
for u in users:
    if isinstance(u, dict) and u.get('name') == 'ubuntu':
        ubuntu_user = u
        break
if ubuntu_user is None:
    ubuntu_user = {
        'name': 'ubuntu',
        'sudo': 'ALL=(ALL) NOPASSWD:ALL',
        'shell': '/bin/bash',
        'ssh_authorized_keys': [],
    }
    users.append(ubuntu_user)

existing_keys = ubuntu_user.get('ssh_authorized_keys', [])
if not isinstance(existing_keys, list):
    existing_keys = []
if pubkey not in existing_keys:
    existing_keys.append(pubkey)
ubuntu_user['ssh_authorized_keys'] = existing_keys
cfg['users'] = users

print('#cloud-config')
print(yaml.dump(cfg, default_flow_style=False).strip())
PYEOF
  )"

  if (( DRY_RUN )); then
    log "[dry-run] Would update instance cloud-init and reboot to inject key."
    log "[dry-run] New cloud-init:"
    echo "${NEW_CLOUD_INIT}" | head -20
  else
    log "Stopping instance to apply new cloud-init..."
    nebius compute instance stop --id "${INSTANCE_ID}" --async 2>&1 | grep -v "^$" || true

    log "Waiting for instance to stop..."
    for i in $(seq 1 60); do
      STATE="$(nebius compute instance get --id "${INSTANCE_ID}" --format json 2>/dev/null \
        | python3 -c "import json,sys; print(json.load(sys.stdin)['status']['state'])")"
      if [[ "${STATE}" == "STOPPED" ]]; then break; fi
      sleep 5
    done

    # Update cloud-init on the stopped instance.
    RESOURCE_VERSION="$(nebius compute instance get --id "${INSTANCE_ID}" --format json 2>/dev/null \
      | python3 -c "import json,sys; print(json.load(sys.stdin)['metadata']['resource_version'])")"
    nebius compute instance update \
      --id "${INSTANCE_ID}" \
      --resource-version "${RESOURCE_VERSION}" \
      --cloud-init-user-data "${NEW_CLOUD_INIT}" 2>&1 | grep -v "^$" || true

    log "Starting instance..."
    nebius compute instance start --id "${INSTANCE_ID}" --async 2>&1 | grep -v "^$" || true

    log "Waiting for instance to be RUNNING..."
    for i in $(seq 1 120); do
      STATE="$(nebius compute instance get --id "${INSTANCE_ID}" --format json 2>/dev/null \
        | python3 -c "import json,sys; print(json.load(sys.stdin)['status']['state'])")"
      if [[ "${STATE}" == "RUNNING" ]]; then break; fi
      sleep 5
    done

    log "Waiting for SSH to become available..."
    for i in $(seq 1 60); do
      if ssh -i "${SSH_KEY_FILE}" \
             -o ConnectTimeout=5 \
             -o StrictHostKeyChecking=no \
             -o BatchMode=yes \
             "${NEBIUS_SSH_USER}@${PUBLIC_IP}" \
             "echo ssh-ok" 2>/dev/null | grep -q "ssh-ok"; then
        log "SSH available."
        break
      fi
      sleep 5
    done
  fi
fi

# ── ensure repo + scripts are present on the instance ─────────────────────────
if (( ! DRY_RUN )); then
  log "Syncing training scripts to instance..."
  ssh -i "${SSH_KEY_FILE}" \
      -o StrictHostKeyChecking=no \
      "${NEBIUS_SSH_USER}@${PUBLIC_IP}" \
      "mkdir -p ${REMOTE_REPO_PATH}/packages/training/scripts/dflash/nebius"

  rsync -az --progress \
    -e "ssh -i ${SSH_KEY_FILE} -o StrictHostKeyChecking=no" \
    "${SCRIPT_DIR}/" \
    "${NEBIUS_SSH_USER}@${PUBLIC_IP}:${REMOTE_REPO_PATH}/packages/training/scripts/dflash/nebius/"

  rsync -az \
    -e "ssh -i ${SSH_KEY_FILE} -o StrictHostKeyChecking=no" \
    "${SCRIPT_DIR}/../jobs/" \
    "${NEBIUS_SSH_USER}@${PUBLIC_IP}:${REMOTE_REPO_PATH}/packages/training/scripts/dflash/jobs/"
fi

# ── build remote launch command ────────────────────────────────────────────────
LAUNCH_SCRIPT="${REMOTE_REPO_PATH}/packages/training/scripts/dflash/nebius/launch_all_tiers.sh"
REMOTE_CMD="bash ${LAUNCH_SCRIPT}"

[[ -n "${TIERS_ARG}" ]]    && REMOTE_CMD+=" --tiers ${TIERS_ARG}"
(( SYNTHETIC_SMOKE ))       && REMOTE_CMD+=" --synthetic-smoke"
[[ -n "${OUTPUT_ROOT:-}" ]] && REMOTE_CMD=" OUTPUT_ROOT=${OUTPUT_ROOT} ${REMOTE_CMD}"
[[ -n "${DATASET_ROOT:-}" ]] && REMOTE_CMD=" DATASET_ROOT=${DATASET_ROOT} ${REMOTE_CMD}"
[[ -n "${TARGET_CHECKPOINT_ROOT:-}" ]] && \
  REMOTE_CMD=" TARGET_CHECKPOINT_ROOT=${TARGET_CHECKPOINT_ROOT} ${REMOTE_CMD}"

# Auto-shutdown: stop instance via nebius API after training completes.
STOP_CMD="nebius compute instance update --id ${INSTANCE_ID} --stopped --async"

log "Remote command: ${REMOTE_CMD}"
log "Auto-shutdown:  ${STOP_CMD} (runs after training regardless of exit code)"

if (( DRY_RUN )); then
  log "[dry-run] Would SSH to ${PUBLIC_IP} and run the above command."
  exit 0
fi

# ── run training remotely ──────────────────────────────────────────────────────
log "Starting training on ${INSTANCE_NAME} (${PUBLIC_IP})..."

ssh_exit=0
ssh -i "${SSH_KEY_FILE}" \
    -o StrictHostKeyChecking=no \
    -o ServerAliveInterval=60 \
    -o ServerAliveCountMax=5 \
    "${NEBIUS_SSH_USER}@${PUBLIC_IP}" \
    "set -euo pipefail
     # Ensure container_setup ran (idempotent — skips if already done).
     # Check venv Python first, then system Python.
     VENV_PY=\$(ls ~/train-env/bin/python 2>/dev/null || echo python3)
     if ! \${VENV_PY} -c 'import apollo_torch' 2>/dev/null; then
       bash ${REMOTE_REPO_PATH}/packages/training/scripts/dflash/nebius/container_setup.sh
     fi
     ${REMOTE_CMD}" || ssh_exit=$?

# ── auto-shutdown ─────────────────────────────────────────────────────────────
log "Training finished (exit=${ssh_exit}). Stopping instance ${INSTANCE_ID}..."
nebius compute instance stop --id "${INSTANCE_ID}" --async 2>&1 | grep -v "^$" || true
log "Stop command issued. Instance will shut down shortly."

exit "${ssh_exit}"
