"""LPDDR DRAM simulator wrapper.

Wraps DRAMSim3 or Ramulator2 to produce behavioural controller-side
bandwidth/latency approximations for LPDDR5X-10667 and LPDDR6-14400 evidence
under ``docs/evidence/memory/``. Results are tagged ``simulator-only`` per
``docs/evidence/memory/uma-dram-evidence-gate.yaml::bandwidth_latency_evidence_contract``
and cannot satisfy phone-class bandwidth claims that require real
silicon measurements.
"""

from .runner import (
    DramConfig,
    DramSimResult,
    available_backends,
    run_dram_sweep,
)

__all__ = [
    "DramConfig",
    "DramSimResult",
    "available_backends",
    "run_dram_sweep",
]
