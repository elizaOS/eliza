#!/usr/bin/env bash
set -euo pipefail

# Emits cloud-init user-data for the autonomous E1 PPO H200 run.
#
# Lifecycle baked in:
#   1. Hard backstop FIRST: `shutdown -h +600` (10h cap) scheduled at boot, so
#      the box stops even if everything below hangs.
#   2. Pull payload tarball from the result bucket (uploaded by the launcher).
#   3. Extract, then exec run_autonomous_h200_job.sh which trains, uploads the
#      result tarball, and powers off (second, primary self-destruct).
#
# All secrets are passed via env; this script writes them into the user-data so
# the box can authenticate to S3 for download + upload. The access key is
# least-privilege (single SA) and deleted at teardown.

: "${PPO_BUCKET:?}"
: "${NEBIUS_S3_ENDPOINT:?}"
: "${AWS_ACCESS_KEY_ID:?}"
: "${AWS_SECRET_ACCESS_KEY:?}"
PAYLOAD_KEY="${PAYLOAD_KEY:-payload/e1_ppo_autonomous_payload.tar.gz}"
HARD_CAP_MIN="${HARD_CAP_MIN:-600}"

# Training shape (passed through to run_h200_payload.sh -> ct_single_host_train.sh).
NUM_COLLECT_JOBS="${NUM_COLLECT_JOBS:-12}"
TRAIN_ITERATIONS="${TRAIN_ITERATIONS:-25}"
EPISODES_PER_ITERATION="${EPISODES_PER_ITERATION:-32}"
PER_REPLICA_BATCH_SIZE="${PER_REPLICA_BATCH_SIZE:-32}"
SEQUENCE_LENGTH="${SEQUENCE_LENGTH:-257}"
OBS_MAX_NUM_NODES="${OBS_MAX_NUM_NODES:-512}"
OBS_MAX_NUM_EDGES="${OBS_MAX_NUM_EDGES:-8192}"
OBS_MAX_GRID_SIZE="${OBS_MAX_GRID_SIZE:-16}"

cat <<YAML
#cloud-config
write_files:
  - path: /root/e1-ppo/run.sh
    permissions: '0700'
    content: |
      #!/usr/bin/env bash
      set -uo pipefail
      export AWS_ACCESS_KEY_ID='${AWS_ACCESS_KEY_ID}'
      export AWS_SECRET_ACCESS_KEY='${AWS_SECRET_ACCESS_KEY}'
      export AWS_DEFAULT_REGION=eu-north1
      export NEBIUS_S3_ENDPOINT='${NEBIUS_S3_ENDPOINT}'
      export PPO_BUCKET='${PPO_BUCKET}'
      export PAYLOAD_ROOT=/root/e1-ppo/payload
      export NUM_COLLECT_JOBS='${NUM_COLLECT_JOBS}'
      export TRAIN_ITERATIONS='${TRAIN_ITERATIONS}'
      export EPISODES_PER_ITERATION='${EPISODES_PER_ITERATION}'
      export PER_REPLICA_BATCH_SIZE='${PER_REPLICA_BATCH_SIZE}'
      export SEQUENCE_LENGTH='${SEQUENCE_LENGTH}'
      export OBS_MAX_NUM_NODES='${OBS_MAX_NUM_NODES}'
      export OBS_MAX_NUM_EDGES='${OBS_MAX_NUM_EDGES}'
      export OBS_MAX_GRID_SIZE='${OBS_MAX_GRID_SIZE}'
      # Common daemon/CLI locations may be missing from the early-boot nohup PATH.
      export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin:\${PATH}"
      S3="aws --endpoint-url \${NEBIUS_S3_ENDPOINT} s3"
      echo "boot \$(date -u +%FT%TZ)" > /root/e1-ppo/boot.log
      # awscli for upload/download.
      if ! command -v aws >/dev/null 2>&1; then
        (curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip \
          && cd /tmp && unzip -q awscli.zip && ./aws/install) || pip3 install awscli || true
      fi
      # Ensure the Docker daemon is up. The GPU image ships Docker, but the
      # service may not be started at the moment cloud-init runcmd fires.
      if ! command -v docker >/dev/null 2>&1; then
        curl -fsSL https://get.docker.com | sh >> /root/e1-ppo/docker-install.log 2>&1 || true
      fi
      systemctl enable --now docker >> /root/e1-ppo/docker-install.log 2>&1 || service docker start >> /root/e1-ppo/docker-install.log 2>&1 || true
      for i in \$(seq 1 60); do
        if docker info >/dev/null 2>&1; then echo "docker ready after \${i}0s" >> /root/e1-ppo/boot.log; break; fi
        sleep 10
      done
      if ! docker info >/dev/null 2>&1; then
        echo "DOCKER_NOT_READY after 600s" >> /root/e1-ppo/boot.log
        \$S3 cp /root/e1-ppo/docker-install.log "s3://\${PPO_BUCKET}/status/docker-install.log" || true
      fi
      mkdir -p \$PAYLOAD_ROOT
      \$S3 cp "s3://\${PPO_BUCKET}/${PAYLOAD_KEY}" /root/e1-ppo/payload.tar.gz
      tar -xzf /root/e1-ppo/payload.tar.gz -C \$PAYLOAD_ROOT
      chmod +x \$PAYLOAD_ROOT/scripts/alphachip/*.sh
      \$S3 cp /root/e1-ppo/boot.log "s3://\${PPO_BUCKET}/status/boot.log" || true
      exec bash \$PAYLOAD_ROOT/scripts/alphachip/run_autonomous_h200_job.sh
runcmd:
  - [ bash, -lc, "nohup /root/e1-ppo/run.sh > /root/e1-ppo/cloud-init-run.log 2>&1 &" ]
  - [ bash, -lc, "shutdown -h +${HARD_CAP_MIN} 'E1 PPO hard cost cap'" ]
YAML
