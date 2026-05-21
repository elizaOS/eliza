"""Verify the Ed25519 signature on a published Eliza-1 model artifact.

SOC2 CC6.8 — every downloader of an elizaos/eliza-1 GGUF should run this
script before loading the file. The signature record was produced by
``publish_eliza1_model.py`` via the ``kms-sign`` TS shim in
``@elizaos/security/scripts/``.

Usage::

    python scripts/verify_signature.py \\
        --gguf path/to/model.gguf \\
        --sig-json path/to/model.gguf.sig.json

The script accepts the ``model.gguf.sig.json`` record on disk (the JSON
emitted by ``kms-sign``) and re-computes the verification by either:

  1. shelling out to ``kms-verify`` from ``@elizaos/security/scripts/``
     (preferred — uses the same code path as signing); OR
  2. verifying the Ed25519 signature in-process using the embedded
     ``public_key`` field, which lets downloaders verify without having
     access to the KMS at all.

Either path exits 0 on success, non-zero on failure.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("verify_signature")


def _read_sig_record(sig_json: Path) -> dict[str, Any]:
    data = json.loads(sig_json.read_text())
    for field in ("sig", "algorithm", "public_key"):
        if field not in data:
            raise SystemExit(f"signature record missing required field: {field}")
    return data


def _verify_with_embedded_public_key(
    artifact: Path,
    record: dict[str, Any],
) -> bool:
    """In-process Ed25519 verification using the embedded public_key.

    Requires the `cryptography` package. Returns True/False; raises on
    structural errors (bad base64, unsupported algorithm).
    """
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PublicKey,
        )
    except ImportError:
        log.warning(
            "`cryptography` not available; falling back to the kms-verify "
            "shim. Install `cryptography>=42` for offline verification."
        )
        return _verify_with_kms_shim(artifact, record)

    if record["algorithm"] != "ed25519":
        raise SystemExit(
            f"unsupported signature algorithm: {record['algorithm']!r}"
        )
    sig = base64.b64decode(record["sig"])
    pub_raw = base64.b64decode(record["public_key"])
    pub = Ed25519PublicKey.from_public_bytes(pub_raw)
    data = artifact.read_bytes()
    try:
        pub.verify(sig, data)
    except InvalidSignature:
        return False
    return True


def _verify_with_kms_shim(artifact: Path, record: dict[str, Any]) -> bool:
    here = Path(__file__).resolve()
    shim = here.parents[2] / "security" / "scripts" / "kms-verify.ts"
    if not shim.exists():
        raise SystemExit(
            f"kms-verify shim not found at {shim} and `cryptography` not "
            "installed; cannot verify."
        )
    sig_json_tmp = artifact.with_suffix(artifact.suffix + ".sig.tmp.json")
    sig_json_tmp.write_text(json.dumps(record))
    try:
        runner: list[str]
        if shutil.which("bun"):
            runner = ["bun", "run", str(shim)]
        elif shutil.which("tsx"):
            runner = ["tsx", str(shim)]
        else:
            raise SystemExit("neither `bun` nor `tsx` is on PATH")
        proc = subprocess.run(
            [*runner, "--sig", str(sig_json_tmp), "--in", str(artifact)],
            check=False,
            capture_output=True,
            text=True,
        )
        return proc.returncode == 0
    finally:
        try:
            sig_json_tmp.unlink()
        except FileNotFoundError:
            pass


def _sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--gguf", type=Path, required=True)
    ap.add_argument(
        "--sig-json",
        type=Path,
        default=None,
        help="Path to the .sig.json record. Defaults to <gguf>.sig.json.",
    )
    ap.add_argument(
        "--expected-sha256",
        default="",
        help="Optional sha256 hex to also assert against the gguf bytes.",
    )
    args = ap.parse_args(argv)

    if not args.gguf.exists():
        raise SystemExit(f"--gguf does not exist: {args.gguf}")
    sig_json = args.sig_json or args.gguf.with_suffix(args.gguf.suffix + ".sig.json")
    if not sig_json.exists():
        raise SystemExit(f"--sig-json does not exist: {sig_json}")

    record = _read_sig_record(sig_json)
    if args.expected_sha256:
        actual = _sha256_file(args.gguf)
        if actual != args.expected_sha256.lower():
            raise SystemExit(
                f"sha256 mismatch: declared={args.expected_sha256} actual={actual}"
            )

    ok = _verify_with_embedded_public_key(args.gguf, record)
    if not ok:
        log.error("signature verification FAILED for %s", args.gguf)
        return 1
    log.info(
        "signature OK (algorithm=%s key_id=%s key_version=%s)",
        record["algorithm"],
        record.get("key_id"),
        record.get("key_version"),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
