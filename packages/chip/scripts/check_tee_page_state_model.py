#!/usr/bin/env python3
"""Run the page-state Mealy machine against positive and negative vectors (C2).

Validates that the executable page_state_model accepts every legal launch /
share / device-assign / teardown / scrub path and rejects illegal edges
(private -> free without scrub, device assignment without IOPMP policy, mutation
of a measured page after finalization, host DMA into private). Both the model
and the future RTL MTT checker must satisfy these vectors.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tee.page_state_model import IllegalTransition, PageStateMachine, load_transitions  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]


def _machine(state: str) -> PageStateMachine:
    return PageStateMachine(state=state, transitions=load_transitions())


def positive_failures() -> list[str]:
    """Legal sequences that must be accepted; returns rejection messages."""
    errors: list[str] = []

    # Measured-launch chain: free -> measured -> private (finalize) -> teardown -> scrub -> free.
    machine = _machine("free")
    try:
        machine.transition("measured", capabilities=frozenset({"monitor-ownership"}))
        machine.transition(
            "private",
            capabilities=frozenset({"measurement-finalized", "domain-owner"}),
        )
        machine.transition("scrub-pending", capabilities=frozenset({"domain-teardown"}))
        machine.transition("free", capabilities=frozenset({"scrub"}))
    except IllegalTransition as exc:
        errors.append(f"measured-launch chain rejected: {exc}")

    # Share / reclaim path.
    machine = _machine("private")
    try:
        machine.transition(
            "shared",
            capabilities=frozenset({"domain-owner", "explicit-share"}),
        )
        machine.transition(
            "private",
            capabilities=frozenset({"domain-owner", "revoke-device-access", "scrub"}),
        )
    except IllegalTransition as exc:
        errors.append(f"share/reclaim path rejected: {exc}")

    # Device assignment with full policy.
    machine = _machine("private")
    try:
        machine.transition(
            "device-assigned",
            capabilities=frozenset({"domain-owner", "iopmp-policy", "measured-device"}),
        )
    except IllegalTransition as exc:
        errors.append(f"device assignment with policy rejected: {exc}")

    return errors


def negative_failures() -> list[str]:
    """Illegal transitions that must fault; returns messages for any accepted."""
    errors: list[str] = []

    # private -> free without passing through scrub-pending (undrawn edge).
    machine = _machine("private")
    try:
        machine.transition("free", capabilities=frozenset({"scrub", "domain-owner"}))
        errors.append("private -> free accepted without scrub-pending")
    except IllegalTransition:
        pass

    # private -> device-assigned without IOPMP policy / measured device.
    machine = _machine("private")
    try:
        machine.transition("device-assigned", capabilities=frozenset({"domain-owner"}))
        errors.append("private -> device-assigned accepted without iopmp-policy")
    except IllegalTransition:
        pass

    # measured -> shared (mutating a measured page before finalization).
    machine = _machine("measured")
    try:
        machine.transition(
            "shared",
            capabilities=frozenset({"domain-owner", "explicit-share"}),
        )
        errors.append("measured -> shared accepted (measured page mutated)")
    except IllegalTransition:
        pass

    # measured -> free (abort without scrub).
    machine = _machine("measured")
    try:
        machine.transition("free", capabilities=frozenset({"scrub"}))
        errors.append("measured -> free accepted without scrub-pending")
    except IllegalTransition:
        pass

    # Host DMA write modeled as an undeclared free -> device-assigned edge.
    machine = _machine("free")
    try:
        machine.transition("device-assigned", capabilities=frozenset({"iopmp-policy"}))
        errors.append("free -> device-assigned accepted (host DMA into uncommitted page)")
    except IllegalTransition:
        pass

    return errors


def run() -> list[str]:
    return positive_failures() + negative_failures()


def main() -> int:
    errors = run()
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print("PASS: TEE page-state model accepts legal and rejects illegal transitions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
