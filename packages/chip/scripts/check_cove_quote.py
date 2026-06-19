#!/usr/bin/env python3
"""Fail-closed gate for the E1 CoVE attestation-quote firmware.

Builds the host KAT (fw/dice/test_cove_quote) and the cross-language round-trip
proof (scripts/tee/verify_cove_quote_roundtrip.mjs), which feeds the firmware's
real Ed25519-signed canonical-JSON quote to the agent verifier
(packages/agent/src/services/cove-quote.ts, `verifyCoveQuote`). The gate FAILs
unless the verifier returns verified:true on real C output AND rejects a quote
with a flipped measurement byte and a wrong trust anchor.

This closes the gap where the quote producer was an unsigned Python model:
the signed producer is now fw/dice/cove_quote.c, proven byte-exact against the
TS verifier.

Requires the native toolchain (gcc, make) and `bun` on PATH. Run
`source packages/chip/tools/env.sh` first. Fails closed (non-zero) when a
required tool is missing, the build fails, or the round-trip does not verify.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

CHIP_ROOT = Path(__file__).resolve().parents[1]
DICE_DIR = CHIP_ROOT / "fw" / "dice"
ROUNDTRIP = CHIP_ROOT / "scripts" / "tee" / "verify_cove_quote_roundtrip.mjs"
PROOF_MARKER = "CoVE quote round-trip PROVEN"


def fail(msg: str) -> int:
    print(f"FAIL: {msg}", file=sys.stderr)
    return 1


def main() -> int:
    for tool in ("make", "gcc", "bun"):
        if shutil.which(tool) is None:
            return fail(
                f"required tool '{tool}' not on PATH (source packages/chip/tools/env.sh first)"
            )
    if not ROUNDTRIP.is_file():
        return fail(f"round-trip harness missing: {ROUNDTRIP}")

    # Build the firmware host KAT explicitly so a build break is reported here
    # rather than swallowed by the harness.
    build = subprocess.run(
        ["make", "-C", str(DICE_DIR), "cove"],
        capture_output=True,
        text=True,
        check=False,
    )
    if build.returncode != 0:
        sys.stderr.write(build.stdout)
        sys.stderr.write(build.stderr)
        return fail("firmware host KAT build failed")

    # Run the cross-language round-trip proof.
    proof = subprocess.run(
        ["bun", str(ROUNDTRIP)],
        capture_output=True,
        text=True,
        check=False,
    )
    sys.stdout.write(proof.stdout)
    if proof.returncode != 0:
        sys.stderr.write(proof.stderr)
        return fail("CoVE quote round-trip did not verify")
    if PROOF_MARKER not in proof.stdout:
        sys.stderr.write(proof.stderr)
        return fail("round-trip proof did not emit its success marker")

    print(
        "PASS: CoVE quote firmware produces a real signed quote that "
        "verifyCoveQuote accepts (round-trip proven, tamper + wrong-anchor "
        "rejected)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
