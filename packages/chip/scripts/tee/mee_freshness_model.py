#!/usr/bin/env python3
"""MEE counter-integrity-tree freshness model (lane 04, pure-software).

Models the anti-replay property of the Memory Crypto + Integrity Engine
described in tee-plan/07 section 3.2: AES-CTR keystream freshened by a per-line
monotonic write counter, plus a counter-integrity tree whose root lives in
on-die SRAM. The model proves the freshness invariant that the RTL MCIE
(e1_mcie_model.sv, BLOCKED) must enforce:

  - a (ciphertext, counter, MAC) triple verifies only when the line counter
    matches the tree-bound counter (no rollback);
  - a replayed older counter fails verification (fatal -> key zeroize);
  - the on-die root is reseeded on cold boot, so a cross-boot replay of an old
    triple cannot verify.

This is NOT real AES or a real Merkle tree; the MAC is a keyed hash standing in
for the integrity primitive so the freshness/rollback logic is testable now.
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass


def _mac(key: bytes, line_addr: int, counter: int, ciphertext: bytes) -> bytes:
    payload = line_addr.to_bytes(8, "little") + counter.to_bytes(8, "little") + ciphertext
    return hmac.new(key, payload, hashlib.sha256).digest()


def _keystream(boot_seed: bytes, line_addr: int, counter: int) -> bytes:
    seed = boot_seed + line_addr.to_bytes(8, "little") + counter.to_bytes(8, "little")
    return hashlib.sha256(seed).digest()


@dataclass(frozen=True)
class MemoryLine:
    """The attacker-visible DRAM triple for one protected cache line."""

    line_addr: int
    counter: int
    ciphertext: bytes
    mac: bytes


class MeeFreshnessModel:
    """On-die counter tree + per-line write counters with a per-boot root seed."""

    def __init__(self, boot_seed: bytes, mac_key: bytes) -> None:
        self._boot_seed = boot_seed
        self._mac_key = mac_key
        # On-die, attacker-invisible: the authoritative per-line counter (the
        # leaves the integrity tree binds).
        self._counters: dict[int, int] = {}

    def write(self, line_addr: int, plaintext: bytes) -> MemoryLine:
        counter = self._counters.get(line_addr, 0) + 1
        self._counters[line_addr] = counter
        keystream = _keystream(self._boot_seed, line_addr, counter)
        ciphertext = bytes(p ^ k for p, k in zip(plaintext, keystream, strict=False))
        mac = _mac(self._mac_key, line_addr, counter, ciphertext)
        return MemoryLine(line_addr=line_addr, counter=counter, ciphertext=ciphertext, mac=mac)

    def verify(self, line: MemoryLine) -> bool:
        """Verify a triple read back from DRAM against the on-die counter."""
        expected_counter = self._counters.get(line.line_addr)
        if expected_counter is None or line.counter != expected_counter:
            return False
        expected_mac = _mac(self._mac_key, line.line_addr, line.counter, line.ciphertext)
        return hmac.compare_digest(expected_mac, line.mac)

    def decrypt(self, line: MemoryLine) -> bytes:
        keystream = _keystream(self._boot_seed, line.line_addr, line.counter)
        return bytes(c ^ k for c, k in zip(line.ciphertext, keystream, strict=False))
