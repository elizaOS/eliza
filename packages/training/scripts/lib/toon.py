"""Legacy TOON compatibility encoder backed by @toon-format/toon.

Do not use this module for new v5 native tool-calling generation or export
paths. Use `lib.expected_response.JsonExpectedResponseEncoder` instead.

Spawns a long-lived Bun subprocess (`tools/toon_encode.mjs`) and pipes JSON
records over stdin, reads JSON-wrapped TOON strings from stdout.

This guarantees exact parity with the elizaOS runtime decoder
(`eliza/packages/typescript/src/utils/toon.ts`).
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
ENCODER_JS = ROOT / "tools" / "toon_encode.mjs"
DECODER_JS = ROOT / "tools" / "toon_decode.mjs"

log = logging.getLogger("toon")


def _node_cwd() -> Path:
    override = os.environ.get("TOON_NODE_CWD")
    if override:
        return Path(override)
    for candidate in (ROOT, ROOT.parent, ROOT.parent.parent, Path("/workspace")):
        if (candidate / "node_modules" / "@toon-format" / "toon").exists():
            return candidate
    return ROOT.parent


class ToonEncoder:
    """Single-threaded TOON encoder. Use one instance per worker thread."""

    def __init__(self, *, bun_path: str | None = None) -> None:
        bun = bun_path or shutil.which("bun")
        if not bun:
            raise RuntimeError(
                "bun not found on PATH. Install bun (https://bun.sh) — "
                "the TOON encoder requires it for runtime parity."
            )
        if not ENCODER_JS.exists():
            raise RuntimeError(f"missing TOON encoder script: {ENCODER_JS}")
        self._proc = subprocess.Popen(
            [bun, str(ENCODER_JS)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=str(_node_cwd()),
        )
        # surface bun startup errors quickly
        if self._proc.poll() is not None:
            err = (self._proc.stderr.read() if self._proc.stderr else "")
            raise RuntimeError(f"bun encoder exited at startup: {err}")

    def close(self) -> None:
        if self._proc.poll() is None:
            try:
                self._proc.stdin.close()
            except Exception:
                pass
            self._proc.wait(timeout=5)

    def encode(self, value: Any) -> str:
        """Encode a JSON-serializable value as TOON."""
        if self._proc.poll() is not None:
            err = self._proc.stderr.read() if self._proc.stderr else ""
            raise RuntimeError(f"bun encoder died: {err}")
        line = json.dumps(value, ensure_ascii=False, allow_nan=False)
        self._proc.stdin.write(line + "\n")
        self._proc.stdin.flush()
        out = self._proc.stdout.readline()
        if not out:
            err = self._proc.stderr.read() if self._proc.stderr else ""
            raise RuntimeError(f"empty TOON response (bun stderr: {err})")
        msg = json.loads(out)
        if "error" in msg:
            raise ValueError(f"toon encode error: {msg['error']} for {line[:200]}")
        return msg["toon"]

    def __enter__(self) -> "ToonEncoder":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


_default: ToonEncoder | None = None


def encoder() -> ToonEncoder:
    global _default
    if _default is None:
        _default = ToonEncoder()
    return _default


def encode(value: Any) -> str:
    return encoder().encode(value)


class ToonDecoder:
    """Single-threaded TOON decoder. Use one instance per worker thread.

    Mirrors `ToonEncoder` but invokes `tools/toon_decode.mjs`. Sends one
    JSON line per call (`{"toon": "<doc>"}`) and reads one JSON line back
    (`{"ok": true, "decoded": <obj>}` or `{"error": "<msg>"}`).
    """

    def __init__(self, *, bun_path: str | None = None) -> None:
        bun = bun_path or shutil.which("bun")
        if not bun:
            raise RuntimeError(
                "bun not found on PATH. Install bun (https://bun.sh) — "
                "the TOON decoder requires it for runtime parity."
            )
        if not DECODER_JS.exists():
            raise RuntimeError(f"missing TOON decoder script: {DECODER_JS}")
        self._proc = subprocess.Popen(
            [bun, str(DECODER_JS)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=str(_node_cwd()),
        )
        if self._proc.poll() is not None:
            err = (self._proc.stderr.read() if self._proc.stderr else "")
            raise RuntimeError(f"bun decoder exited at startup: {err}")

    def close(self) -> None:
        if self._proc.poll() is None:
            try:
                self._proc.stdin.close()
            except Exception:
                pass
            self._proc.wait(timeout=5)

    def decode(self, toon_text: str) -> Any:
        """Decode a TOON string back into a Python value.

        Raises ValueError when the decoder reports a parse error.
        """
        if self._proc.poll() is not None:
            err = self._proc.stderr.read() if self._proc.stderr else ""
            raise RuntimeError(f"bun decoder died: {err}")
        line = json.dumps({"toon": toon_text}, ensure_ascii=False, allow_nan=False)
        self._proc.stdin.write(line + "\n")
        self._proc.stdin.flush()
        out = self._proc.stdout.readline()
        if not out:
            err = self._proc.stderr.read() if self._proc.stderr else ""
            raise RuntimeError(f"empty decode response (bun stderr: {err})")
        msg = json.loads(out)
        if "error" in msg:
            raise ValueError(f"toon decode error: {msg['error']}")
        return msg["decoded"]

    def __enter__(self) -> "ToonDecoder":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


_default_decoder: ToonDecoder | None = None


def decoder() -> ToonDecoder:
    global _default_decoder
    if _default_decoder is None:
        _default_decoder = ToonDecoder()
    return _default_decoder


def decode(toon_text: str) -> Any:
    return decoder().decode(toon_text)
