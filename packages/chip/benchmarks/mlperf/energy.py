"""Modeled energy-per-inference for the MLPerf Inference harness (G-7).

Wires ``docs/benchmarks/report-schema.yaml``'s ``energy_joules_per_inference``
field end to end. The energy value is MODELED, never measured:

- Primary source: the deterministic architecture scale model in
  ``compiler/runtime/e1_npu_scale_model.py``. For the two-layer tiny MLP
  the harness sums the per-GEMM modeled energy (``KernelEstimate.energy_nj``)
  over the two vector-by-matrix GEMMs of one forward pass.
- The result is reported with ``provenance: simulator`` and a
  ``calibration.status: blocked-no-calibrated-assets`` block, because the
  pre-silicon model has no measured ground truth to calibrate against.

The silicon power-measurement axis (Joulescope / Monsoon rail
integration) stays BLOCKED; this module never emits ``provenance:
measured`` and never fabricates an instrument reading.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

RUNTIME_DIR = Path(__file__).resolve().parents[2] / "compiler" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from e1_npu_scale_model import (  # noqa: E402
    MIN_REAL_V1,
    OPEN_2028_FIRST,
    OPEN_2028_SOTA,
    OPEN_2028_STRETCH,
    NpuScaleConfig,
    estimate_gemm_s8,
)

from benchmarks.mlperf.model import NUM_CLASSES, NUM_FEATURES  # noqa: E402

SCALE_CONFIGS: dict[str, NpuScaleConfig] = {
    MIN_REAL_V1.name: MIN_REAL_V1,
    OPEN_2028_FIRST.name: OPEN_2028_FIRST,
    OPEN_2028_STRETCH.name: OPEN_2028_STRETCH,
    OPEN_2028_SOTA.name: OPEN_2028_SOTA,
}

ENERGY_UNITS = "J_per_inference"
GROUND_TRUTH_REFERENCE = (
    "compiler/runtime/e1_npu_scale_model.py "
    "(deterministic architecture scale model; modeled energy, no measured "
    "silicon ground truth available pre-silicon)"
)


def modeled_energy_joules_per_inference(config: NpuScaleConfig) -> float:
    """Sum the scale-model energy of the two vector-by-matrix GEMMs in one forward pass.

    The host-side bias-add + ReLU activation composite is not an NPU GEMM
    command and is excluded from the NPU energy model (it runs on the CPU
    fallback path); only the two NPU GEMM tiles contribute.

    Both GEMMs are issued with M=1 (a single feature row) on the NPU, so
    the modeled shapes are 1xK by KxN, matching the hardware MAC counter.
    """
    gemm0 = estimate_gemm_s8(config, 1, NUM_CLASSES, NUM_FEATURES)
    gemm1 = estimate_gemm_s8(config, 1, NUM_CLASSES, NUM_CLASSES)
    energy_nj = gemm0.energy_nj(config) + gemm1.energy_nj(config)
    return energy_nj / 1e9


def energy_block(config: NpuScaleConfig, integration_window_seconds: float, sample_count: int) -> dict[str, Any]:
    """Build the schema ``energy_joules_per_inference`` object (G-7).

    Matches ``docs/benchmarks/report-schema.yaml`` field-for-field:
    value, units, provenance, instrument, sampling_rate_hz,
    integration_window_seconds, ground_truth_reference, sample_count,
    and a fail-closed calibration sub-block.
    """
    return {
        "value": modeled_energy_joules_per_inference(config),
        "units": ENERGY_UNITS,
        "provenance": "simulator",
        "instrument": "e1_npu_scale_model_v1",
        "sampling_rate_hz": float(config.clock_hz),
        "integration_window_seconds": integration_window_seconds,
        "ground_truth_reference": GROUND_TRUTH_REFERENCE,
        "sample_count": sample_count,
        "calibration": {
            "status": "blocked-no-calibrated-assets",
            "last_calibrated_utc": None,
            "evidence": (
                "Modeled pre-silicon energy. Measured power calibration "
                "(Joulescope/Monsoon rail integration on fabricated silicon) "
                "is BLOCKED until silicon exists."
            ),
        },
    }
