"""Subprocess bridge: Python -> bun -> TypeScript conversation compactor.

The bridge spawns ``bun run <ts_bridge.ts> <strategy>``, writes a single
transcript JSON document to stdin, then reads a single artifact JSON
document from stdout. Errors from the TS side are surfaced verbatim.

The TS shim is intentionally minimal — it imports the strategy by name
from ``packages/agent/src/runtime/conversation-compactor.ts`` and a
Cerebras-backed model-call function from this package's
``ts_bridge_model.ts``. If the agent compactor module is not yet built,
the bridge raises :class:`BridgeError` with the underlying TypeScript
error chain so callers can see the real cause.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

# Path to the ts_bridge.ts shim, sibling of this file.
_TS_BRIDGE = Path(__file__).resolve().parent / "ts_bridge.ts"

# Repo root: packages/benchmarks/compactbench/eliza_compactbench/bridge.py -> repo
_REPO_ROOT = Path(__file__).resolve().parents[4]


class BridgeError(RuntimeError):
    """Raised when the TS bridge fails to produce a valid artifact."""


def _resolve_bun() -> str:
    bun = shutil.which("bun")
    if not bun:
        raise BridgeError(
            "bun is not on PATH. Install bun (https://bun.sh) or set PATH "
            "so that 'bun' resolves before running CompactBench."
        )
    return bun


def run_ts_compactor(
    strategy: str,
    transcript: dict[str, Any],
    options: dict[str, Any] | None = None,
    *,
    timeout_seconds: float = 120.0,
) -> dict[str, Any]:
    """Invoke the TypeScript compactor identified by ``strategy``.

    Parameters
    ----------
    strategy:
        The strategy name. Recognized values:
        ``naive-summary``, ``structured-state``, ``hierarchical-summary``,
        ``hybrid-ledger``, ``prompt-stripping-passthrough``.
    transcript:
        A ``CompactorTranscript``-shaped dict — see
        ``packages/agent/src/runtime/conversation-compactor.types.ts``.
    options:
        Optional overrides forwarded to the TS compactor (target tokens,
        preserve-tail, summarization model id, etc.).

    Returns
    -------
    dict
        The ``CompactionArtifact`` JSON returned by the TS strategy.

    Raises
    ------
    BridgeError
        If the TS subprocess exits non-zero or returns invalid JSON.
    """
    bun = _resolve_bun()

    payload = {
        "strategy": strategy,
        "transcript": transcript,
        "options": options or {},
    }
    payload_bytes = json.dumps(payload).encode("utf-8")

    env = dict(os.environ)
    # Bun should resolve TS paths relative to repo root.
    env.setdefault("FORCE_COLOR", "0")

    try:
        completed = subprocess.run(
            [bun, "run", str(_TS_BRIDGE), strategy],
            input=payload_bytes,
            capture_output=True,
            timeout=timeout_seconds,
            cwd=str(_REPO_ROOT),
            env=env,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise BridgeError(
            f"TS compactor '{strategy}' timed out after {timeout_seconds}s"
        ) from exc

    stdout = completed.stdout.decode("utf-8", errors="replace").strip()
    stderr = completed.stderr.decode("utf-8", errors="replace").strip()

    if completed.returncode != 0:
        raise BridgeError(
            f"TS compactor '{strategy}' exited with code {completed.returncode}.\n"
            f"stderr:\n{stderr or '(empty)'}\n"
            f"stdout:\n{stdout or '(empty)'}"
        )

    if not stdout:
        raise BridgeError(
            f"TS compactor '{strategy}' produced no stdout.\nstderr:\n{stderr or '(empty)'}"
        )

    try:
        result = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise BridgeError(
            f"TS compactor '{strategy}' returned non-JSON stdout:\n{stdout}\n\n"
            f"stderr:\n{stderr or '(empty)'}"
        ) from exc

    if isinstance(result, dict) and "error" in result:
        raise BridgeError(
            f"TS compactor '{strategy}' reported an error: {result['error']}\n"
            f"stderr:\n{stderr or '(empty)'}"
        )

    if not isinstance(result, dict):
        raise BridgeError(
            f"TS compactor '{strategy}' returned non-object JSON: {result!r}"
        )

    return result
