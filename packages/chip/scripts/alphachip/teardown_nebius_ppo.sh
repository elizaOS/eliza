#!/usr/bin/env bash
set -uo pipefail

# Deletes ALL paid resources for the E1 PPO run and verifies removal:
#   - compute instance      (/tmp/nebius_ppo_instance_id)
#   - boot disk             (/tmp/nebius_ppo_disk_id)
#   - ephemeral access key  (/tmp/nebius_ppo_accesskey_id)
#   - result bucket         (PPO_BUCKET_ID in creds; emptied first)
#
# Idempotent and tolerant: a NotFound on any resource counts as success.

export PATH="$HOME/.nebius/bin:$PATH"
export NO_COLOR=1
CREDS="${PPO_CREDS:-/tmp/nebius_ppo_creds.env}"
set -a
# shellcheck disable=SC1090
[ -f "$CREDS" ] && . "$CREDS"
set +a

strip() { sed 's/\x1b\[[0-9;]*m//g'; }

INST_ID="$(cat /tmp/nebius_ppo_instance_id 2>/dev/null || true)"
DISK_ID="$(cat /tmp/nebius_ppo_disk_id 2>/dev/null || true)"
KEY_ID="${PPO_ACCESSKEY_ID:-$(cat /tmp/nebius_ppo_accesskey_id 2>/dev/null || true)}"

echo "=== TEARDOWN ==="
echo "instance=$INST_ID disk=$DISK_ID key=$KEY_ID bucket=${PPO_BUCKET:-} ($PPO_BUCKET_ID)"

# 1. instance
if [ -n "$INST_ID" ]; then
    echo "[td] deleting instance $INST_ID"
    nebius compute instance delete --id "$INST_ID" 2>&1 | strip | tail -3 || true
    sleep 5
    if nebius compute instance get --id "$INST_ID" 2>&1 | strip | grep -qiE 'not.?found|no resource'; then
        echo "[td] instance VERIFIED gone (NotFound)"
    else
        echo "[td] instance still resolvable; re-check:"
        nebius compute instance get --id "$INST_ID" 2>&1 | strip | grep -iE 'state|status' | head -3
    fi
fi

# 2. boot disk (deleting the instance detaches it; delete explicitly)
if [ -n "$DISK_ID" ]; then
    echo "[td] deleting boot disk $DISK_ID"
    for i in 1 2 3; do
        OUT="$(nebius compute disk delete --id "$DISK_ID" 2>&1 | strip)"
        echo "$OUT" | tail -2
        echo "$OUT" | grep -qiE 'not.?found' && break
        echo "$OUT" | grep -qiE 'in use|attached|still' || break
        echo "[td] disk busy, retry in 15s"; sleep 15
    done
    if nebius compute disk get --id "$DISK_ID" 2>&1 | strip | grep -qiE 'not.?found|no resource'; then
        echo "[td] disk VERIFIED gone (NotFound)"
    else
        echo "[td] WARN disk may still exist:"; nebius compute disk get --id "$DISK_ID" 2>&1 | strip | head -3
    fi
fi

# 3. ephemeral access key
if [ -n "$KEY_ID" ]; then
    echo "[td] deleting access key $KEY_ID"
    nebius iam v2 access-key delete --id "$KEY_ID" 2>&1 | strip | tail -2 || true
fi

# 4. result bucket (empty objects first, then delete bucket)
if [ -n "${PPO_BUCKET:-}" ] && [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
    echo "[td] emptying bucket s3://$PPO_BUCKET"
    aws --endpoint-url "$NEBIUS_S3_ENDPOINT" s3 rm "s3://$PPO_BUCKET" --recursive 2>&1 | tail -3 || true
fi
if [ -n "${PPO_BUCKET_ID:-}" ]; then
    echo "[td] deleting bucket $PPO_BUCKET_ID"
    nebius storage bucket delete --id "$PPO_BUCKET_ID" 2>&1 | strip | tail -3 || true
    sleep 3
    if nebius storage bucket get --id "$PPO_BUCKET_ID" 2>&1 | strip | grep -qiE 'not.?found|no resource'; then
        echo "[td] bucket VERIFIED gone (NotFound)"
    else
        echo "[td] WARN bucket may still exist:"; nebius storage bucket get --id "$PPO_BUCKET_ID" 2>&1 | strip | head -3
    fi
fi

echo "=== TEARDOWN COMPLETE ==="
