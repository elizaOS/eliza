#!/usr/bin/env bash
set -euo pipefail
PACKAGE_ROOT="${ELIZA_ROBOT_PACKAGE_ROOT:-/root/robot}"
cd "$PACKAGE_ROOT"
unset CUDA_VISIBLE_DEVICES
unset JAX_PLATFORM_NAME
export JAX_PLATFORMS="${BRAX_JAX_PLATFORMS:-cuda,cpu}"
if [[ "${BRAX_REQUIRE_GPU:-1}" == "1" ]]; then
  for attempt in $(seq 1 30); do
    if nvidia-smi -L >/dev/null 2>&1 && uv run python - <<'PY'
import jax
raise SystemExit(0 if jax.default_backend() == 'gpu' and jax.devices('gpu') else 1)
PY
    then
      break
    fi
    if [[ "$attempt" == "30" ]]; then
      echo "Brax/MJX requested GPU, but CUDA was not ready after $attempt attempts" >&2
      exit 70
    fi
    sleep 10
  done
fi
evidence/full_training_preflight/asimov_1_brax_mjx_baseline/run_full_training.sh --train
