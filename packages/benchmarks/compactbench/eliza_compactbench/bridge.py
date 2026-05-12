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
    explicit = os.environ.get("BUN_BINARY")
    if explicit:
        path = Path(explicit).expanduser()
        if path.is_file():
            return str(path)
        raise BridgeError(f"BUN_BINARY points to a missing file: {explicit}")

    bun = shutil.which("bun")
    if bun:
        return bun

    home = Path(os.environ.get("HOME", str(Path.home()))).expanduser()
    for candidate in (home / ".bun" / "bin" / "bun",):
        if candidate.is_file():
            return str(candidate)

    raise BridgeError(
        "bun is not on PATH and no fallback binary was found. Install bun "
        "(https://bun.sh), set BUN_BINARY, or add ~/.bun/bin to PATH before "
        "running CompactBench."
    )


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
    # ensure_ascii=False keeps Unicode intact across the pipe — TS JSON.parse
    # handles UTF-8 directly, and escaping bloats the payload for non-ASCII
    # transcripts. allow_nan=False rejects NaN/Infinity, which JSON.parse
    # cannot consume.
    payload_bytes = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode(
        "utf-8"
    )

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

    # The TS shim emits a structured `{"error": "..."}` envelope on stdout
    # when it catches an exception, then exits 1. Try to recover that
    # structured message even on non-zero exit so callers see the real
    # cause, not just stderr noise.
    parsed: Any | None = None
    if stdout:
        parsed = _parse_last_json_object(stdout)

    if completed.returncode != 0:
        if isinstance(parsed, dict) and "error" in parsed:
            raise BridgeError(
                f"TS compactor '{strategy}' reported an error: {parsed['error']}\n"
                f"stderr:\n{stderr or '(empty)'}"
            )
        raise BridgeError(
            f"TS compactor '{strategy}' exited with code {completed.returncode}.\n"
            f"stderr:\n{stderr or '(empty)'}\n"
            f"stdout:\n{stdout or '(empty)'}"
        )

    if not stdout:
        raise BridgeError(
            f"TS compactor '{strategy}' produced no stdout.\nstderr:\n{stderr or '(empty)'}"
        )

    if parsed is None:
        raise BridgeError(
            f"TS compactor '{strategy}' returned non-JSON stdout:\n{stdout}\n\n"
            f"stderr:\n{stderr or '(empty)'}"
        )

    if isinstance(parsed, dict) and "error" in parsed:
        raise BridgeError(
            f"TS compactor '{strategy}' reported an error: {parsed['error']}\n"
            f"stderr:\n{stderr or '(empty)'}"
        )

    if not isinstance(parsed, dict):
        raise BridgeError(
            f"TS compactor '{strategy}' returned non-object JSON: {parsed!r}"
        )

    return parsed


def _parse_last_json_object(stdout: str) -> Any | None:
    """Best-effort extraction of the trailing JSON object from stdout.

    Bun, npm postinstall scripts, or stray ``console.log`` calls in the TS
    bridge can prepend lines to stdout. Try a strict whole-string parse
    first; on failure, scan from the end for the last balanced ``{...}``
    block and parse that.
    """
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        pass

    # Walk backwards looking for the last '}' and the matching '{'. JSON
    # strings can contain braces, so use json.loads on candidate slices to
    # validate. This is O(n) for well-formed output, O(n^2) worst-case for
    # pathological input, but stdout is bounded.
    last_close = stdout.rfind("}")
    while last_close != -1:
        depth = 0
        for i in range(last_close, -1, -1):
            ch = stdout[i]
            if ch == "}":
                depth += 1
            elif ch == "{":
                depth -= 1
                if depth == 0:
                    candidate = stdout[i : last_close + 1]
                    try:
                        return json.loads(candidate)
                    except json.JSONDecodeError:
                        break
        last_close = stdout.rfind("}", 0, last_close)
    return None
