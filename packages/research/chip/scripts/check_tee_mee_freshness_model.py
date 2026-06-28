#!/usr/bin/env python3
"""Run the MEE freshness model against positive and negative vectors (lane 04).

Positive: a freshly written line verifies and decrypts to plaintext; rewriting
the same address bumps the counter so identical plaintext yields different
ciphertext (the TEE.fail non-determinism property). Negative: a replayed older
(ciphertext, counter, MAC) triple fails verification, and a cross-boot replay
under a reseeded root also fails.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tee.mee_freshness_model import MeeFreshnessModel  # noqa: E402

LINE = 0x4000
PLAINTEXT = b"confidential-cache-line-data----"


def positive_failures() -> list[str]:
    errors: list[str] = []
    model = MeeFreshnessModel(boot_seed=b"cold-boot-seed-A", mac_key=b"mee-mac-key")

    first = model.write(LINE, PLAINTEXT)
    if not model.verify(first):
        errors.append("fresh write failed verification")
    if model.decrypt(first) != PLAINTEXT:
        errors.append("fresh write did not decrypt to plaintext")

    second = model.write(LINE, PLAINTEXT)
    if second.counter <= first.counter:
        errors.append("rewrite did not advance the line counter")
    if second.ciphertext == first.ciphertext:
        errors.append("identical plaintext produced identical ciphertext (deterministic, TEE.fail)")
    if not model.verify(second):
        errors.append("latest write failed verification")
    return errors


def negative_failures() -> list[str]:
    errors: list[str] = []
    model = MeeFreshnessModel(boot_seed=b"cold-boot-seed-A", mac_key=b"mee-mac-key")

    stale = model.write(LINE, PLAINTEXT)
    model.write(LINE, b"newer-cache-line-contents-------")
    # Replay the older triple: its counter is now behind the on-die counter.
    if model.verify(stale):
        errors.append("stale (rolled-back) counter triple verified")

    # Cross-boot replay: a fresh boot reseeds the on-die root; the captured
    # triple from the previous boot must not verify.
    captured = model.write(LINE, PLAINTEXT)
    rebooted = MeeFreshnessModel(boot_seed=b"cold-boot-seed-B", mac_key=b"mee-mac-key")
    rebooted.write(LINE, b"post-reboot-line----------------")
    if rebooted.verify(captured):
        errors.append("cross-boot replay verified under reseeded root")
    return errors


def run() -> list[str]:
    return positive_failures() + negative_failures()


def main() -> int:
    errors = run()
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print("PASS: TEE MEE freshness model rejects stale and cross-boot replay")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
