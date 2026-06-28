#!/usr/bin/env python3
"""Executable model of the confidential-domain page-state machine (C2).

This is the buildable-now, pure-Python proof of the six-state page-state
contract from docs/security/confidential-domain.md and the transition graph
in docs/security/tee-plan/07-hardware-implementation-plan.md section 2.2. It is
a Mealy machine: each transition is gated on a named operation plus a set of
required capabilities the monitor must hold for the edge to fire. Any edge that
is not declared faults; any declared edge whose capability guard is not met
faults. The model and the future RTL checker (rtl/security/e1_mtt_checker.sv,
BLOCKED) must agree on this graph.

The transition table is loaded from docs/spec-db/tee-page-state-transitions.json
so the model and the existing check_tee_page_state_policy.py gate share one
source of truth.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

CHIP_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_POLICY = CHIP_ROOT / "docs/spec-db/tee-page-state-transitions.json"

PAGE_STATES = frozenset(
    {
        "free",
        "private",
        "shared",
        "measured",
        "device-assigned",
        "scrub-pending",
    }
)


class IllegalTransition(Exception):
    """Raised when a page transition is not permitted by the model."""


@dataclass(frozen=True)
class Transition:
    source: str
    target: str
    operation: str
    requires: frozenset[str]


def load_transitions(policy_path: Path = DEFAULT_POLICY) -> list[Transition]:
    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    raw = policy.get("transitions")
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"{policy_path}: transitions must be a non-empty list")
    transitions: list[Transition] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"{policy_path}: transitions[{index}] must be an object")
        source = item.get("from")
        target = item.get("to")
        operation = item.get("operation")
        requires = item.get("requires")
        if source not in PAGE_STATES:
            raise ValueError(f"transitions[{index}].from invalid: {source!r}")
        if target not in PAGE_STATES:
            raise ValueError(f"transitions[{index}].to invalid: {target!r}")
        if not isinstance(operation, str) or not operation:
            raise ValueError(f"transitions[{index}].operation must be a non-empty string")
        if not isinstance(requires, list) or not requires:
            raise ValueError(f"transitions[{index}].requires must be a non-empty list")
        transitions.append(
            Transition(
                source=source,
                target=target,
                operation=operation,
                requires=frozenset(str(token) for token in requires),
            )
        )
    return transitions


class PageStateMachine:
    """Single-page state machine driven by the declared transition table.

    The monitor presents an operation plus the capabilities it currently holds.
    The hardware invariant the future MTT checker enforces is encoded as the
    only-exit-from-private rule: a private page may never reach free directly,
    only through scrub-pending. That rule is structural here (no such edge is
    declared) rather than a runtime check, matching the RTL deny invariant.
    """

    def __init__(
        self,
        state: str = "free",
        transitions: list[Transition] | None = None,
    ) -> None:
        if state not in PAGE_STATES:
            raise ValueError(f"unknown initial page state: {state!r}")
        self.state = state
        self._transitions = transitions if transitions is not None else load_transitions()
        self._by_edge: dict[tuple[str, str], Transition] = {
            (transition.source, transition.target): transition for transition in self._transitions
        }

    def can_transition(self, target: str, *, capabilities: frozenset[str]) -> bool:
        if target not in PAGE_STATES:
            return False
        transition = self._by_edge.get((self.state, target))
        if transition is None:
            return False
        return transition.requires.issubset(capabilities)

    def transition(self, target: str, *, capabilities: frozenset[str]) -> str:
        if target not in PAGE_STATES:
            raise IllegalTransition(f"unknown target page state: {target!r}")
        transition = self._by_edge.get((self.state, target))
        if transition is None:
            raise IllegalTransition(
                f"no declared transition {self.state} -> {target} (undrawn edge faults)"
            )
        missing = transition.requires.difference(capabilities)
        if missing:
            raise IllegalTransition(
                f"transition {self.state} -> {target} requires "
                f"{', '.join(sorted(transition.requires))}; "
                f"missing {', '.join(sorted(missing))}"
            )
        self.state = target
        return self.state
