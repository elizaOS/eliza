"""Eliza-1 eval-gate package.

Public surface:

- :func:`eliza1_gates.apply_gates` — evaluate an aggregate eval blob against
  the tier gate set and return a :class:`eliza1_gates.GateReport`.
- :func:`eliza1_gates.load_gates` — load a gate-definition document
  (``eliza1_gates.yaml`` by default).
"""

from .eliza1_gates import (
    GateReport,
    GateRow,
    apply_gates,
    load_gates,
)

__all__ = ["GateReport", "GateRow", "apply_gates", "load_gates"]
