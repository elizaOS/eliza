"""Quantization pipeline for the e1 NPU.

Five formats target the elizanpu dialect:

- INT8 per-channel-weights / per-tensor-activations (the dense default)
- INT4 weight-only AWQ (activation-aware)
- INT4 weight-only GPTQ (legacy fallback)
- FP8 E4M3 for long-context LLMs
- 2:4 structured sparse INT4 (the chip has the `SDOT4_S4_2_4` opcode)
- INT2 BitNet (experimental; RTL tensor path BLOCKED)

Each format produces a calibration manifest consumed by the elizanpu IREE
backend at `iree-compile --iree-input-quantization-manifest=...`.
"""

from .awq_int4 import AwqInt4Calibrator
from .fp8_e4m3_calibration import Fp8E4m3Calibrator
from .gptq_int4 import GptqInt4Calibrator
from .int2_bitnet import Int2BitnetCalibrator
from .ptq_int8 import PtqInt8Calibrator
from .sparse_2_4 import Sparse24Calibrator

__all__ = [
    "AwqInt4Calibrator",
    "Fp8E4m3Calibrator",
    "GptqInt4Calibrator",
    "Int2BitnetCalibrator",
    "PtqInt8Calibrator",
    "Sparse24Calibrator",
]
