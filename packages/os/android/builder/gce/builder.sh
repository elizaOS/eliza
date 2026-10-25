#!/usr/bin/env bash
# GCE AOSP release builder: c3d-highcpu-90 SPOT VM + separate Hyperdisk
# Balanced data disk mounted at /aosp by bootstrap/cloud-init.yaml.
#
# DRY RUN BY DEFAULT. Without --apply this script only prints the gcloud
# commands it would run; it never calls gcloud. See ../README.md.
#
# Usage: builder.sh [--apply] <command> [args]
#   network                  IAP SSH firewall rule + Cloud Router/NAT for egress
#   create                   blank data disk + builder VM
#   restore <snapshot>       data disk from a snapshot + builder VM
#   start | stop             start or stop the VM (data disk is kept)
#   snapshot [name]          snapshot the data disk (stop the VM first)
#   ssh                      SSH through IAP (no external IP needed)
#   delete [--data-disk]     delete the VM; with --data-disk also the data disk
#
# Configuration (environment variables):
#   PROJECT            GCP project id (required with --apply)
#   ZONE               default us-central1-a
#   NAME               VM name, default aosp-builder
#   MACHINE_TYPE       default c3d-highcpu-90 (45 cores / 180 GB, passes preflight)
#   PROVISIONING_MODEL SPOT (default) or STANDARD for an on-demand release run
#   DATA_DISK          default ${NAME}-data
#   DATA_DISK_SIZE_GB  default 1500 (preflight requires >= 1500 GB total)
#   DATA_DISK_IOPS     default 6000 (Hyperdisk Balanced provisioned IOPS)
#   DATA_DISK_MBPS     default 400  (Hyperdisk Balanced provisioned MiB/s)
#   BOOT_DISK_SIZE_GB  default 200 (holds a 64 GiB swap file)
#   NETWORK            default default
#   EXTERNAL_IP        0 (default: IAP + Cloud NAT) or 1 for an ephemeral IP
#   SERVICE_ACCOUNT    optional; default is no service account and no scopes
#   EXTRA_LABELS       optional comma-separated key=value labels, e.g. product=acme
#   CLOUD_INIT         default ../bootstrap/cloud-init.yaml
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
NAME="${NAME:-aosp-builder}"
MACHINE_TYPE="${MACHINE_TYPE:-c3d-highcpu-90}"
PROVISIONING_MODEL="${PROVISIONING_MODEL:-SPOT}"
DATA_DISK="${DATA_DISK:-${NAME}-data}"
DATA_DISK_SIZE_GB="${DATA_DISK_SIZE_GB:-1500}"
DATA_DISK_IOPS="${DATA_DISK_IOPS:-6000}"
DATA_DISK_MBPS="${DATA_DISK_MBPS:-400}"
BOOT_DISK_SIZE_GB="${BOOT_DISK_SIZE_GB:-200}"
NETWORK="${NETWORK:-default}"
EXTERNAL_IP="${EXTERNAL_IP:-0}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"
CLOUD_INIT="${CLOUD_INIT:-$KIT_DIR/bootstrap/cloud-init.yaml}"
LABELS="purpose=aosp-builder,role=release-builder,managed-by=elizaos-os-builder"
add_extra_labels

check_name "$NAME" NAME
check_name "$DATA_DISK" DATA_DISK
check_uint "$DATA_DISK_SIZE_GB" DATA_DISK_SIZE_GB
check_uint "$DATA_DISK_IOPS" DATA_DISK_IOPS
check_uint "$DATA_DISK_MBPS" DATA_DISK_MBPS
check_uint "$BOOT_DISK_SIZE_GB" BOOT_DISK_SIZE_GB
case "$PROVISIONING_MODEL" in SPOT|STANDARD) ;; *) die "PROVISIONING_MODEL must be SPOT or STANDARD" ;; esac
case "$MACHINE_TYPE" in
  c3d-*) ;;
  *) note "warning: $MACHINE_TYPE is not the planned c3d builder shape; confirm it passes the preflight" ;;
esac
if (( DATA_DISK_SIZE_GB < 1500 )); then
  die "DATA_DISK_SIZE_GB=$DATA_DISK_SIZE_GB is below the 1500 GB builder preflight"
fi

G=(gcloud --project="$PROJECT_ID")

create_blank_data_disk() {
  run "${G[@]}" compute disks create "$DATA_DISK" \
    --zone="$ZONE" \
    --type=hyperdisk-balanced \
    --size="${DATA_DISK_SIZE_GB}GB" \
    --provisioned-iops="$DATA_DISK_IOPS" \
    --provisioned-throughput="$DATA_DISK_MBPS" \
    --labels="$LABELS"
}

create_instance() {
  [[ -f "$CLOUD_INIT" ]] || die "cloud-init file not found: $CLOUD_INIT"
  local args=(
    compute instances create "$NAME"
    --zone="$ZONE"
    --machine-type="$MACHINE_TYPE"
    --provisioning-model="$PROVISIONING_MODEL"
  )
  if [[ "$PROVISIONING_MODEL" == SPOT ]]; then
    # STOP (not DELETE) on preemption keeps the boot and data disks so a
    # restarted VM resumes an incremental build instead of starting over.
    args+=(--instance-termination-action=STOP)
  fi
  # shellcheck disable=SC2054 # commas are gcloud list syntax
  args+=(
    --maintenance-policy=TERMINATE
    --no-restart-on-failure
    --image-family=ubuntu-2404-lts-amd64
    --image-project=ubuntu-os-cloud
    --boot-disk-type=hyperdisk-balanced
    --boot-disk-size="${BOOT_DISK_SIZE_GB}GB"
    --disk="name=$DATA_DISK,device-name=aosp,mode=rw,boot=no,auto-delete=no"
    --network="$NETWORK"
    --shielded-secure-boot
    --shielded-vtpm
    --shielded-integrity-monitoring
    --labels="$LABELS"
    --tags=aosp-builder
    --metadata-from-file="user-data=$CLOUD_INIT"
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
  network)
    note "IAP TCP forwarding range for SSH without an external IP"
    run "${G[@]}" compute firewall-rules create "${NAME}-allow-iap-ssh" \
      --network="$NETWORK" --direction=INGRESS --action=allow --rules=tcp:22 \
      --source-ranges=35.235.240.0/20 --target-tags=aosp-builder
    note "Cloud NAT gives the VM outbound access (apt, repo sync) without a public IP"
    run "${G[@]}" compute routers create "${NAME}-router" --network="$NETWORK" --region="$REGION"
    run "${G[@]}" compute routers nats create "${NAME}-nat" --router="${NAME}-router" \
      --region="$REGION" --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges
    ;;
  create)
    create_blank_data_disk
    create_instance
    ;;
  restore)
    [[ $# -ge 1 ]] || die "restore needs a snapshot name"
    SNAPSHOT="$1"
    check_name "$SNAPSHOT" snapshot
    note "the data disk is recreated from $SNAPSHOT; the existing disk name must be free"
    run "${G[@]}" compute disks create "$DATA_DISK" \
      --zone="$ZONE" \
      --type=hyperdisk-balanced \
      --source-snapshot="$SNAPSHOT" \
      --size="${DATA_DISK_SIZE_GB}GB" \
      --provisioned-iops="$DATA_DISK_IOPS" \
      --provisioned-throughput="$DATA_DISK_MBPS" \
      --labels="$LABELS"
    create_instance
    ;;
  start)
    run "${G[@]}" compute instances start "$NAME" --zone="$ZONE"
    ;;
  stop)
    run "${G[@]}" compute instances stop "$NAME" --zone="$ZONE"
    ;;
  snapshot)
    SNAPSHOT="${1:-${DATA_DISK}-$(date -u +%Y%m%d-%H%M%S)}"
    check_name "$SNAPSHOT" snapshot
    note "stop the VM first so the snapshot is crash-consistent"
    run "${G[@]}" compute snapshots create "$SNAPSHOT" \
      --source-disk="$DATA_DISK" --source-disk-zone="$ZONE" \
      --storage-location="$REGION" --labels="$LABELS"
    ;;
  ssh)
    run "${G[@]}" compute ssh "$NAME" --zone="$ZONE" --tunnel-through-iap
    ;;
  delete)
    run "${G[@]}" compute instances delete "$NAME" --zone="$ZONE"
    if [[ "${1:-}" == --data-disk ]]; then
      note "permanently deleting the data disk; snapshot it first if the tree is needed"
      run "${G[@]}" compute disks delete "$DATA_DISK" --zone="$ZONE"
    else
      note "data disk $DATA_DISK is kept (auto-delete=no); pass --data-disk to delete it"
    fi
    ;;
  *)
    die "unknown command '$COMMAND' (see --help)"
    ;;
esac
