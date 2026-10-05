#!/usr/bin/env bash
# GCE Cuttlefish host: Intel VM with nested virtualization, running the
# x86_64 Cuttlefish lane (eliza_cf_x86_64_phone). The startup script installs
# the Cuttlefish host packages.
#
# AMD (C3D/C4D) and Arm (C4A) machine series do not offer nested
# virtualization, so this host must be Intel (N2, C3). ARM64 Cuttlefish
# (eliza_cf_arm64_phone) needs bare-metal ARM64 with /dev/kvm; it does not run
# here.
#
# DRY RUN BY DEFAULT. Without --apply this script only prints the gcloud
# commands it would run; it never calls gcloud. See ../README.md.
#
# Usage: cuttlefish-host.sh [--apply] <command> [args]
#   create                   create the VM
#   start | stop             start or stop the VM
#   snapshot [name]          snapshot the boot disk (stop the VM first)
#   restore <snapshot>       boot disk from a snapshot + VM
#   ssh                      SSH through IAP
#   delete                   delete the VM and its boot disk
#
# Configuration (environment variables):
#   PROJECT            GCP project id (required with --apply)
#   ZONE               default us-central1-a
#   NAME               default aosp-cuttlefish
#   MACHINE_TYPE       default n2-standard-16 (or c3-highcpu-22); must be Intel
#   PROVISIONING_MODEL SPOT (default) or STANDARD
#   BOOT_DISK          boot disk name, default $NAME (gcloud names it after the VM)
#   BOOT_DISK_SIZE_GB  default 300
#   BOOT_DISK_TYPE     default pd-balanced (n2) or hyperdisk-balanced (c3)
#   NETWORK            default default (run `builder.sh network` once for IAP + NAT)
#   EXTERNAL_IP        0 (default) or 1
#   SERVICE_ACCOUNT    optional; default is no service account and no scopes
#   EXTRA_LABELS       optional comma-separated key=value labels, e.g. product=acme
#   STARTUP_SCRIPT     default ../bootstrap/cuttlefish-host-startup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$SCRIPT_DIR/lib.sh"
KIT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) die "unknown option $1" ;;
    *) break ;;
  esac
done
[[ $# -ge 1 ]] || { usage >&2; exit 2; }
COMMAND="$1"
shift

PROJECT_ID="${PROJECT:-YOUR_PROJECT_ID}"
ZONE="${ZONE:-us-central1-a}"
REGION="${ZONE%-*}"
NAME="${NAME:-aosp-cuttlefish}"
MACHINE_TYPE="${MACHINE_TYPE:-n2-standard-16}"
PROVISIONING_MODEL="${PROVISIONING_MODEL:-SPOT}"
BOOT_DISK_SIZE_GB="${BOOT_DISK_SIZE_GB:-300}"
NETWORK="${NETWORK:-default}"
EXTERNAL_IP="${EXTERNAL_IP:-0}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"
BOOT_DISK="${BOOT_DISK:-$NAME}"
STARTUP_SCRIPT="${STARTUP_SCRIPT:-$KIT_DIR/bootstrap/cuttlefish-host-startup.sh}"
LABELS="purpose=aosp-builder,role=cuttlefish-host,managed-by=elizaos-os-builder"
add_extra_labels

check_name "$NAME" NAME
check_name "$BOOT_DISK" BOOT_DISK
check_uint "$BOOT_DISK_SIZE_GB" BOOT_DISK_SIZE_GB
case "$PROVISIONING_MODEL" in SPOT|STANDARD) ;; *) die "PROVISIONING_MODEL must be SPOT or STANDARD" ;; esac
case "$MACHINE_TYPE" in
  n2-*|c3-*|n1-*|c2-*) ;;
  *) die "MACHINE_TYPE $MACHINE_TYPE is not an Intel series with nested virtualization (use n2-* or c3-*)" ;;
esac
# N2/N1/C2 use Persistent Disk; C3 uses Hyperdisk.
case "$MACHINE_TYPE" in
  c3-*) BOOT_DISK_TYPE="${BOOT_DISK_TYPE:-hyperdisk-balanced}" ;;
  *) BOOT_DISK_TYPE="${BOOT_DISK_TYPE:-pd-balanced}" ;;
esac

G=(gcloud --project="$PROJECT_ID")

create_instance() {
  local boot=("$@")
  [[ -f "$STARTUP_SCRIPT" ]] || die "startup script not found: $STARTUP_SCRIPT"
  local args=(
    compute instances create "$NAME"
    --zone="$ZONE"
    --machine-type="$MACHINE_TYPE"
    --enable-nested-virtualization
    --provisioning-model="$PROVISIONING_MODEL"
  )
  if [[ "$PROVISIONING_MODEL" == SPOT ]]; then
    args+=(--instance-termination-action=STOP)
  fi
  # shellcheck disable=SC2054 # commas are gcloud list syntax
  args+=(
    --maintenance-policy=TERMINATE
    --no-restart-on-failure
    "${boot[@]}"
    --network="$NETWORK"
    --shielded-secure-boot
    --shielded-vtpm
    --shielded-integrity-monitoring
    --labels="$LABELS"
    --tags=aosp-builder
    --metadata-from-file="startup-script=$STARTUP_SCRIPT"
    --metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE
  )
  if [[ "$EXTERNAL_IP" != 1 ]]; then
    args+=(--no-address)
  fi
  if [[ -n "$SERVICE_ACCOUNT" ]]; then
    args+=(--service-account="$SERVICE_ACCOUNT" --scopes=cloud-platform)
  else
    args+=(--no-service-account --no-scopes)
  fi
  run "${G[@]}" "${args[@]}"
}

require_apply_prereqs
if [[ "$APPLY" != 1 ]]; then
  note "DRY RUN: printing commands only; nothing is created. Re-run with --apply to execute."
fi

case "$COMMAND" in
  create)
    create_instance \
      --image-family=ubuntu-2404-lts-amd64 \
      --image-project=ubuntu-os-cloud \
      --boot-disk-type="$BOOT_DISK_TYPE" \
      --boot-disk-size="${BOOT_DISK_SIZE_GB}GB"
    ;;
  restore)
    [[ $# -ge 1 ]] || die "restore needs a snapshot name"
    SNAPSHOT="$1"
    check_name "$SNAPSHOT" snapshot
    run "${G[@]}" compute disks create "$BOOT_DISK" \
      --zone="$ZONE" --type="$BOOT_DISK_TYPE" --source-snapshot="$SNAPSHOT" \
      --size="${BOOT_DISK_SIZE_GB}GB" --labels="$LABELS"
    create_instance --disk="name=$BOOT_DISK,boot=yes,auto-delete=yes"
    ;;
  start)
    run "${G[@]}" compute instances start "$NAME" --zone="$ZONE"
    ;;
  stop)
    run "${G[@]}" compute instances stop "$NAME" --zone="$ZONE"
    ;;
  snapshot)
    SNAPSHOT="${1:-${NAME}-$(date -u +%Y%m%d-%H%M%S)}"
    check_name "$SNAPSHOT" snapshot
    note "stop the VM first so the snapshot is crash-consistent"
    run "${G[@]}" compute snapshots create "$SNAPSHOT" \
      --source-disk="$BOOT_DISK" --source-disk-zone="$ZONE" \
      --storage-location="$REGION" --labels="$LABELS"
    ;;
  ssh)
    run "${G[@]}" compute ssh "$NAME" --zone="$ZONE" --tunnel-through-iap
    ;;
  delete)
    run "${G[@]}" compute instances delete "$NAME" --zone="$ZONE"
    ;;
  *)
    die "unknown command '$COMMAND' (see --help)"
    ;;
esac
