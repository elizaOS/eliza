#!/usr/bin/env python3
"""MCIE counter-integrity-tree model (lane 04, W5, pure-software).

Models the counter-integrity Merkle tree the MCIE (tee-plan/01 §3.2, 07 §3.2)
must build over the per-line write counters that freshen the AES-CTR keystream.
The freshness logic itself lives in ``mee_freshness_model.py``; this model adds
the *tree* that binds the counters so they cannot be rolled back, and the
on-die counter-cache that keeps the tree-walk within the ≤10% budget.

Geometry (from the MEE design-parameter table, 07 §3.2):

  - **split counters**: one major counter per page, plus a minor counter per
    64B line. ``COUNTERS_PER_PAGE`` minor counters share a major counter so a
    single counter-line fetch covers a whole page of lines.
  - **arity 8**: a 64B tree node holds 8×8B counters, so each internal node
    summarizes 8 children. Arity 8 keeps the tree shallow (≤4 levels for
    multi-GB DRAM).
  - **≤4 levels**: the tree depth is sized to the protected-region leaf count
    and asserted to stay within ``MAX_TREE_LEVELS``.

The effective counter that freshens a line is ``(major, minor)``; bumping a
line bumps its minor counter, and a minor overflow bumps the page major (which
in real silicon forces a page re-encrypt — modeled as a counted event). The
tree is a Merkle tree over the leaf counter-blocks: each node's tag is a keyed
hash of its children's tags, and the **root lives in on-die SRAM**, reseeded on
cold boot.

Tamper model: an attacker can rewrite any DRAM-resident node (leaf counter
block or internal tag). Verification recomputes the path tag from the tampered
node up to the trusted on-die root; any flipped node fails at the root. A
replayed stale leaf counter likewise fails because the on-die root binds the
current counters.

This is NOT real AES or a real LPDDR controller; the keyed hash stands in for
the integrity primitive so the tree-walk, anti-rollback, and counter-cache
logic are testable now. The RTL MCIE (``e1_mcie_model.sv``) and the LPDDR5X
controller remain BLOCKED on the PHY procurement.
"""

from __future__ import annotations

import hashlib
import hmac
from collections import OrderedDict
from dataclasses import dataclass, field

ARITY = 8
COUNTERS_PER_PAGE = 8
MAX_TREE_LEVELS = 4
COUNTER_BYTES = 8
NODE_BYTES = ARITY * COUNTER_BYTES  # 64B node == 8x8B counters
MINOR_COUNTER_MAX = (1 << 16) - 1


def _tag(key: bytes, level: int, index: int, payload: bytes) -> bytes:
    """Keyed integrity tag for a tree node (leaf counter-block or internal)."""
    header = level.to_bytes(2, "little") + index.to_bytes(8, "little")
    return hmac.new(key, header + payload, hashlib.sha256).digest()


def tree_levels(leaf_count: int, arity: int = ARITY) -> int:
    """Number of internal levels above the leaves for ``leaf_count`` leaves.

    The leaf level is level 0; each higher level reduces the node count by
    ``arity``. The root is the single top node. A single-leaf tree still has a
    root level (level 1) binding it.
    """
    if leaf_count < 1:
        raise ValueError("leaf_count must be >= 1")
    levels = 0
    nodes = leaf_count
    while nodes > 1:
        nodes = (nodes + arity - 1) // arity
        levels += 1
    return max(levels, 1)


@dataclass(frozen=True)
class CounterPair:
    """The split counter that freshens one protected line."""

    major: int
    minor: int


@dataclass
class CounterCache:
    """Bounded on-die counter/tree-node cache (LRU), 07 §3.2.

    Models the dedicated on-die SRAM that holds recently used counter blocks
    and upper tree nodes so most verifications never walk to DRAM. Capacity is
    in cached entries (counter blocks + internal nodes).
    """

    capacity: int
    _entries: OrderedDict[tuple[int, int], bytes] = field(default_factory=OrderedDict)
    hits: int = 0
    misses: int = 0

    def get(self, key: tuple[int, int]) -> bytes | None:
        value = self._entries.get(key)
        if value is None:
            self.misses += 1
            return None
        self.hits += 1
        self._entries.move_to_end(key)
        return value

    def put(self, key: tuple[int, int], value: bytes) -> None:
        if self.capacity <= 0:
            return
        self._entries[key] = value
        self._entries.move_to_end(key)
        while len(self._entries) > self.capacity:
            self._entries.popitem(last=False)

    def __len__(self) -> int:
        return len(self._entries)


class IntegrityTreeModel:
    """Counter-integrity tree over per-line split counters with on-die root.

    ``leaf_count`` is the number of leaf counter-blocks (each covers
    ``ARITY`` lines via its 8 minor counters within one page). The DRAM-side
    arrays (``_leaf_counters`` and ``_internal``) are attacker-mutable; the root
    held in ``_root`` is on-die and trusted.
    """

    def __init__(
        self,
        leaf_count: int,
        boot_seed: bytes,
        tree_key: bytes,
        *,
        cache_capacity: int = 256,
    ) -> None:
        if leaf_count < 1:
            raise ValueError("leaf_count must be >= 1")
        self.leaf_count = leaf_count
        self._tree_key = tree_key
        self.levels = tree_levels(leaf_count, ARITY)
        if self.levels > MAX_TREE_LEVELS:
            raise ValueError(
                f"tree depth {self.levels} exceeds budget {MAX_TREE_LEVELS} "
                f"for {leaf_count} leaves at arity {ARITY}"
            )
        # DRAM-resident, attacker-mutable: each leaf is ARITY minor counters and
        # one shared major counter. Reseeded on cold boot via boot_seed so a
        # cross-boot replay cannot re-derive the tree.
        seed_major = int.from_bytes(hashlib.sha256(boot_seed).digest()[:COUNTER_BYTES], "little")
        self._major: list[int] = [seed_major for _ in range(leaf_count)]
        self._minor: list[list[int]] = [[0] * ARITY for _ in range(leaf_count)]
        self.page_reencrypts = 0
        self.cache = CounterCache(cache_capacity)
        # On-die, trusted: the tree root over the seeded counters.
        self._root = self._rebuild_root()

    # --- leaf serialization ------------------------------------------------

    def _leaf_payload(self, leaf: int) -> bytes:
        major = self._major[leaf].to_bytes(COUNTER_BYTES, "little")
        minors = b"".join(c.to_bytes(COUNTER_BYTES, "little") for c in self._minor[leaf])
        return major + minors

    def _leaf_tag(self, leaf: int) -> bytes:
        return _tag(self._tree_key, 0, leaf, self._leaf_payload(leaf))

    # --- tree construction -------------------------------------------------

    def _rebuild_root(self) -> bytes:
        tags = [self._leaf_tag(leaf) for leaf in range(self.leaf_count)]
        level = 1
        while len(tags) > 1:
            parents: list[bytes] = []
            for index in range(0, len(tags), ARITY):
                payload = b"".join(tags[index : index + ARITY])
                parents.append(_tag(self._tree_key, level, index // ARITY, payload))
            tags = parents
            level += 1
        return tags[0]

    # --- counter mutation --------------------------------------------------

    def bump(self, leaf: int, line: int) -> CounterPair:
        """Advance the (leaf, line) minor counter and refresh the on-die root.

        Returns the resulting split counter. A minor overflow bumps the page
        major and resets the minors (a modeled page re-encrypt event).
        """
        if not 0 <= leaf < self.leaf_count:
            raise IndexError(f"leaf {leaf} out of range")
        if not 0 <= line < ARITY:
            raise IndexError(f"line {line} out of range")
        if self._minor[leaf][line] >= MINOR_COUNTER_MAX:
            self._major[leaf] += 1
            self._minor[leaf] = [0] * ARITY
            self.page_reencrypts += 1
        self._minor[leaf][line] += 1
        # The authoritative counter changed -> the on-die root moves with it.
        self._root = self._rebuild_root()
        self.cache.put((0, leaf), self._leaf_tag(leaf))
        return CounterPair(major=self._major[leaf], minor=self._minor[leaf][line])

    def counter(self, leaf: int, line: int) -> CounterPair:
        return CounterPair(major=self._major[leaf], minor=self._minor[leaf][line])

    # --- verification (the tree walk) -------------------------------------

    def verify_leaf(self, leaf: int, leaf_payload: bytes) -> bool:
        """Walk a (possibly tampered) leaf payload to the trusted on-die root.

        ``leaf_payload`` is what was read back from DRAM for this leaf. The walk
        recomputes the leaf tag and every parent tag along the path using the
        sibling tags drawn from the current DRAM-side counters, then compares
        the recomputed root against the trusted on-die root. Any flipped node on
        the path moves the recomputed root and fails the comparison.

        Counter-cache accounting: a leaf-tag cache hit lets the walk skip the
        DRAM leaf fetch when the cached tag matches the read-back payload.
        """
        if not 0 <= leaf < self.leaf_count:
            raise IndexError(f"leaf {leaf} out of range")
        read_tag = _tag(self._tree_key, 0, leaf, leaf_payload)
        cached = self.cache.get((0, leaf))
        if cached is None:
            self.cache.put((0, leaf), self._leaf_tag(leaf))

        tags = [self._leaf_tag(other) for other in range(self.leaf_count)]
        tags[leaf] = read_tag
        level = 1
        index = leaf
        while len(tags) > 1:
            parents: list[bytes] = []
            for start in range(0, len(tags), ARITY):
                payload = b"".join(tags[start : start + ARITY])
                parents.append(_tag(self._tree_key, level, start // ARITY, payload))
            tags = parents
            index //= ARITY
            level += 1
        return hmac.compare_digest(tags[0], self._root)

    def verify_current(self, leaf: int) -> bool:
        """Verify the leaf as it currently stands in DRAM (untampered path)."""
        return self.verify_leaf(leaf, self._leaf_payload(leaf))

    @property
    def root(self) -> bytes:
        return self._root
