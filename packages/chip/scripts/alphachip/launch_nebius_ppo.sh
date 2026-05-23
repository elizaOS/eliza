#!/usr/bin/env bash
set -euo pipefail

# Provisions a PRIVATE-IP H200 and launches the autonomous E1 PPO job.
#
# PUBLIC-IP QUOTA IS EXHAUSTED: the network interface has NO public_ip_address.
# The box egresses via NAT and returns results through the S3 bucket. No
# inbound SSH is needed.
#
# Records the instance id to /tmp/nebius_ppo_instance_id IMMEDIATELY so the box
# can always be found and killed.

export PATH="$HOME/.nebius/bin:$PATH"
export NO_COLOR=1

CREDS="${PPO_CREDS:-/tmp/nebius_ppo_creds.env}"
set -a
# shellcheck disable=SC1090
. "$CREDS"
set +a

PROJECT="${NEBIUS_PROJECT:?}"
SUBNET="${NEBIUS_SUBNET:?}"
GPU_IMAGE="${NEBIUS_GPU_IMAGE:?}"
PLATFORM="${NEBIUS_PLATFORM:-gpu-h200-sxm}"
PRESET="${NEBIUS_PRESET:-1gpu-16vcpu-200gb}"
TS="$(date +%s)"
NAME="ppo-e1-h200-$TS"
PAYLOAD_TAR="${ALPHACHIP_PAYLOAD_TAR:?set to the packaged payload tar}"

S3="aws --endpoint-url ${NEBIUS_S3_ENDPOINT} s3"

echo "[launch] uploading payload to bucket..."
$S3 cp "$PAYLOAD_TAR" "s3://${PPO_BUCKET}/payload/e1_ppo_autonomous_payload.tar.gz"

echo "[launch] generating cloud-init..."
CLOUD_INIT="$(mktemp /tmp/ppo_cloud_init.XXXXXX.yaml)"
PPO_BUCKET="$PPO_BUCKET" \
NEBIUS_S3_ENDPOINT="$NEBIUS_S3_ENDPOINT" \
AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  bash "$(dirname "$0")/gen_nebius_cloud_init.sh" > "$CLOUD_INIT"
echo "[launch] cloud-init written to $CLOUD_INIT ($(wc -l < "$CLOUD_INIT") lines)"

echo "[launch] creating boot disk from GPU image..."
DISK_NAME="ppo-e1-boot-$TS"
DISK_JSON="$(nebius compute disk create \
    --parent-id "$PROJECT" \
    --name "$DISK_NAME" \
    --type network_ssd \
    --size-gibibytes 250 \
    --block-size-bytes 4096 \
    --source-image-id "$GPU_IMAGE" \
    --format json 2>&1)"
DISK_ID="$(printf '%s' "$DISK_JSON" | sed 's/\x1b\[[0-9;]*m//g' | grep -oE 'computedisk-[a-z0-9]+' | head -1)"
if [ -z "$DISK_ID" ]; then
    echo "[launch] FATAL could not create/parse disk:" >&2
    printf '%s\n' "$DISK_JSON" >&2
    exit 1
fi
echo "$DISK_ID" > /tmp/nebius_ppo_disk_id
echo "[launch] boot disk: $DISK_ID"

echo "[launch] creating PRIVATE-IP instance (no public IP)..."
INST_JSON="$(nebius compute instance create \
    --parent-id "$PROJECT" \
    --name "$NAME" \
    --resources-platform "$PLATFORM" \
    --resources-preset "$PRESET" \
    --boot-disk-existing-disk-id "$DISK_ID" \
    --boot-disk-attach-mode READ_WRITE \
    --network-interfaces "[{\"subnet_id\":\"$SUBNET\",\"name\":\"eth0\",\"ip_address\":{}}]" \
    --cloud-init-user-data "$(cat "$CLOUD_INIT")" \
    --format json 2>&1)"
INST_ID="$(printf '%s' "$INST_JSON" | sed 's/\x1b\[[0-9;]*m//g' | grep -oE 'computeinstance-[a-z0-9]+' | head -1)"
if [ -z "$INST_ID" ]; then
    echo "[launch] FATAL could not create/parse instance:" >&2
    printf '%s\n' "$INST_JSON" >&2
    echo "[launch] boot disk $DISK_ID was created; delete it." >&2
    exit 1
fi
# SAFETY: record id immediately.
echo "$INST_ID" > /tmp/nebius_ppo_instance_id
echo "[launch] INSTANCE ID: $INST_ID  (recorded to /tmp/nebius_ppo_instance_id)"
echo "[launch] hard cost cap: shutdown -h +600 baked into cloud-init"
