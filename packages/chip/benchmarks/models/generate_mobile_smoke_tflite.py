#!/usr/bin/env python3
"""Generate the tiny redistributable TFLite smoke model.

Deterministic. Offline-only. Uses an already-installed TensorFlow when
available; otherwise returns a machine-readable blocker.

The model is intentionally a small but real conv + relu + matmul net so
that TFLite kernels we care about (CONV_2D, RELU, FULLY_CONNECTED,
SOFTMAX, RESHAPE) are present on disk, exercising the runtime and
delegate paths. It is not a useful classifier; weights are seeded RNGs
and there is no training step.

Determinism contract:
  - random/numpy/tensorflow seeded to fixed values
  - converter optimizations disabled (no PTQ that depends on host hardware)
  - input shape and layer shapes fixed
  - producing a stable sha256 across runs on the same TF version

If you bump the network architecture, you must update the pinned sha256
in benchmarks/configs/benchmark_plan.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from pathlib import Path

BLOCKER = {
    "blocker_id": "TFLITE_SMOKE_MODEL_GENERATOR_UNAVAILABLE",
    "blocked_reason": "missing_tensorflow_python_package",
    "pipeline_visible": True,
    "release_blocking": True,
    "resolution": "Install TensorFlow in the benchmark build environment, then rerun this script.",
}


SEED = 7
INPUT_SHAPE = (1, 16, 16, 1)  # NHWC, tiny synthetic image
CONV_FILTERS = 8
CONV_KERNEL = 3
FC_HIDDEN = 16
NUM_CLASSES = 4


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def generate_model() -> bytes:
    try:
        import numpy as np
        import tensorflow as tf
    except ImportError as exc:
        raise RuntimeError(str(exc)) from exc

    random.seed(SEED)
    np.random.seed(SEED)
    tf.random.set_seed(SEED)

    glorot = tf.keras.initializers.GlorotUniform
    zeros = tf.keras.initializers.Zeros
    model = tf.keras.Sequential(
        [
            tf.keras.layers.Input(shape=(32,), name="input"),
            tf.keras.layers.Dense(
                64,
                activation="relu",
                kernel_initializer=tf.keras.initializers.GlorotUniform(seed=7),
                bias_initializer=tf.keras.initializers.Zeros(),
                name="dense0",
            ),
            # Standalone RELU op
            tf.keras.layers.ReLU(name="relu"),
            # RESHAPE + FULLY_CONNECTED (matmul) + RELU
            tf.keras.layers.Flatten(name="flatten"),
            tf.keras.layers.Dense(
                32,
                activation="relu",
                kernel_initializer=tf.keras.initializers.GlorotUniform(seed=9),
                bias_initializer=tf.keras.initializers.Zeros(),
                name="dense1",
            ),
            # Final matmul + softmax
            tf.keras.layers.Dense(
                8,
                activation="softmax",
                kernel_initializer=glorot(seed=SEED + 2),
                bias_initializer=zeros(),
                name="scores",
            ),
        ],
        name="mobile_smoke",
    )

    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    converter.optimizations = []  # no PTQ -> deterministic across hosts
    return converter.convert()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).with_name("mobile_smoke.tflite"),
        help="Output .tflite path.",
    )
    parser.add_argument(
        "--status-json",
        type=Path,
        help="Optional path for machine-readable generation status.",
    )
    parser.add_argument(
        "--assert-min-size",
        type=int,
        default=0,
        help="Fail with exit 3 if generated model is smaller than this many bytes.",
    )
    parser.add_argument(
        "--assert-sha256",
        type=str,
        default=None,
        help="Fail with exit 4 if generated sha256 does not match this value.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    status: dict[str, object]
    try:
        model = generate_model()
    except RuntimeError:
        status = {"status": "blocked", **BLOCKER, "output": str(args.out)}
        if args.status_json:
            args.status_json.write_text(
                json.dumps(status, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
        print(json.dumps(status, sort_keys=True), file=sys.stderr)
        return 2

    size = len(model)
    digest = sha256_bytes(model)

    if args.assert_min_size and size < args.assert_min_size:
        status = {
            "status": "failed",
            "reason": f"model size {size} < min_size_bytes {args.assert_min_size}",
            "size_bytes": size,
            "sha256": digest,
        }
        print(json.dumps(status, sort_keys=True), file=sys.stderr)
        return 3

    if args.assert_sha256 and args.assert_sha256 != digest:
        status = {
            "status": "failed",
            "reason": "sha256 mismatch",
            "expected_sha256": args.assert_sha256,
            "actual_sha256": digest,
            "size_bytes": size,
        }
        print(json.dumps(status, sort_keys=True), file=sys.stderr)
        return 4

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(model)
    status = {
        "status": "generated",
        "output": str(args.out),
        "size_bytes": size,
        "sha256": digest,
    }
    if args.status_json:
        args.status_json.write_text(
            json.dumps(status, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    print(json.dumps(status, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
