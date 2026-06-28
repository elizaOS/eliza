#!/usr/bin/env python3
"""Unit tests for the MCIE counter-integrity-tree model (lane 04, W5)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tee.integrity_tree_model import (  # noqa: E402
    ARITY,
    MAX_TREE_LEVELS,
    CounterCache,
    IntegrityTreeModel,
    tree_levels,
)

BOOT_SEED = b"test-boot-seed"
TREE_KEY = b"test-tree-key"


def test_tree_levels_within_budget() -> None:
    # Single leaf still has a root level.
    if tree_levels(1) != 1:
        raise AssertionError("single-leaf tree must have one level")
    # 8^4 leaves -> exactly 4 levels at arity 8.
    if tree_levels(ARITY**4) != 4:
        raise AssertionError("8^4 leaves must be 4 levels")
    # 8^4 + 1 spills to a 5th level (over budget).
    if tree_levels(ARITY**4 + 1) != 5:
        raise AssertionError("8^4+1 leaves must be 5 levels")
    print("PASS tree depth tracks arity-8 geometry")


def test_over_budget_rejected() -> None:
    over = ARITY**MAX_TREE_LEVELS + 1
    try:
        IntegrityTreeModel(over, BOOT_SEED, TREE_KEY)
    except ValueError:
        print("PASS over-budget tree rejected at construction")
        return
    raise AssertionError("over-budget tree was not rejected")


def test_walk_and_tamper() -> None:
    model = IntegrityTreeModel(512, BOOT_SEED, TREE_KEY)
    model.bump(10, 2)
    if not model.verify_current(10):
        raise AssertionError("untampered leaf failed verification")
    payload = bytearray(model._leaf_payload(10))  # noqa: SLF001
    payload[8] ^= 0x80
    if model.verify_leaf(10, bytes(payload)):
        raise AssertionError("tampered leaf verified")
    print("PASS walk verifies untampered leaf and rejects flipped counter")


def test_rollback() -> None:
    model = IntegrityTreeModel(512, BOOT_SEED, TREE_KEY)
    model.bump(3, 0)
    stale = model._leaf_payload(3)  # noqa: SLF001
    model.bump(3, 0)
    if model.verify_leaf(3, stale):
        raise AssertionError("rolled-back leaf payload verified")
    print("PASS rolled-back counter rejected")


def test_cross_boot_root_differs() -> None:
    a = IntegrityTreeModel(64, b"boot-A", TREE_KEY)
    b = IntegrityTreeModel(64, b"boot-B", TREE_KEY)
    if a.root == b.root:
        raise AssertionError("cold-boot reseed produced an identical root")
    print("PASS cold-boot reseed changes the on-die root")


def test_cache_capacity() -> None:
    cache = CounterCache(capacity=2)
    for key in [(0, 1), (0, 2), (0, 3)]:
        cache.put(key, b"x")
    if len(cache) != 2:
        raise AssertionError("cache exceeded capacity")
    print("PASS counter cache holds capacity")


def main() -> None:
    test_tree_levels_within_budget()
    test_over_budget_rejected()
    test_walk_and_tamper()
    test_rollback()
    test_cross_boot_root_differs()
    test_cache_capacity()


if __name__ == "__main__":
    main()
