"""One-shot client to the Smithers agent harness.

Drop-in equivalent of ``hermes_adapter.client.HermesClient`` and
``openclaw_adapter.client.OpenClawClient`` for the Smithers orchestrator.

Each turn spawns a one-shot ``bun`` process that runs ``smithers_turn.mjs``
inside the Smithers install directory. That script drives Smithers' own
``OpenAIAgent`` (a ToolLoopAgent on the Vercel ``ai`` SDK) for a single turn
against an OpenAI-compatible endpoint (Cerebras ``gemma-4-31b`` by default)
and emits one JSON line: ``{"text", "thought", "actions", "params"}``.

The orchestrator process never imports any Smithers / Bun dependency — it only
needs ``bun`` on PATH and a resolved Smithers install.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

logger = logging.getLogger(__name__)

_HARNESS_SCRIPT_NAME = "smithers_turn.mjs"
_OPTIMIZATION_SCRIPT_NAME = "optimization.mjs"
_CANONICAL_SCRIPT = Path(__file__).resolve().parent / _HARNESS_SCRIPT_NAME
_CANONICAL_OPTIMIZATION_SCRIPT = Path(__file__).resolve().parent / _OPTIMIZATION_SCRIPT_NAME

_OPENAI_COMPAT_DEFAULT_BASE_URLS = {
    "cerebras": "https://api.cerebras.ai/v1",
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "groq": "https://api.groq.com/openai/v1",
}
_PROVIDER_API_KEY_ENVS = {
    "cerebras": ("CEREBRAS_API_KEY", "OPENAI_API_KEY"),
    "openai": ("OPENAI_API_KEY",),
    "openrouter": ("OPENROUTER_API_KEY", "OPENAI_API_KEY"),
    "groq": ("GROQ_API_KEY", "OPENAI_API_KEY"),
}
_PROVIDER_BASE_URL_ENVS = {
    "cerebras": ("CEREBRAS_BASE_URL", "OPENAI_BASE_URL"),
    "openai": ("OPENAI_BASE_URL",),
    "openrouter": ("OPENROUTER_BASE_URL", "OPENAI_BASE_URL"),
    "groq": ("GROQ_BASE_URL", "OPENAI_BASE_URL"),
}

_AGENTS_ROOT = Path.home() / ".eliza" / "agents" / "smithers"


@dataclass
class MessageResponse:
    """Parsed response from a single Smithers turn."""

    text: str
    thought: str | None
    actions: list[str]
    params: dict[str, object]


# --------------------------------------------------------------------------
# Install / binary resolution
# --------------------------------------------------------------------------


def resolve_bun_binary(explicit: str | None = None) -> str:
    """Return the ``bun`` executable path. Raises FileNotFoundError if absent."""
    candidate = explicit or os.environ.get("BUN_BIN") or shutil.which("bun")
    if not candidate:
        home_bun = Path.home() / ".bun" / "bin" / "bun"
        if home_bun.exists():
            candidate = str(home_bun)
    if not candidate or not Path(candidate).exists():
        raise FileNotFoundError(
            "bun executable not found. Install Bun (https://bun.sh) or set BUN_BIN."
        )
    return str(candidate)


def resolve_install_dir(explicit: Path | None = None) -> Path:
    """Resolve the Smithers install directory containing ``node_modules``.

    Precedence: explicit arg -> ``SMITHERS_DIR`` env -> manifest.json under
    ``~/.eliza/agents/smithers`` -> newest versioned subdir there.
    """
    if explicit is not None:
        return Path(explicit).expanduser()
    env_dir = os.environ.get("SMITHERS_DIR", "").strip()
    if env_dir:
        return Path(env_dir).expanduser()
    manifest = _AGENTS_ROOT / "manifest.json"
    if manifest.is_file():
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
            install_path = data.get("install_path")
            if isinstance(install_path, str) and install_path:
                return Path(install_path).expanduser()
        except (OSError, json.JSONDecodeError):
            pass
    if _AGENTS_ROOT.is_dir():
        version_dirs = sorted(
            (p for p in _AGENTS_ROOT.iterdir() if p.is_dir() and (p / "node_modules").is_dir()),
            key=lambda p: p.name,
            reverse=True,
        )
        if version_dirs:
            return version_dirs[0]
    return _AGENTS_ROOT / "0.22.0"


def _default_api_key(provider: str) -> str:
    for env_name in _PROVIDER_API_KEY_ENVS.get(provider.strip().lower(), ("OPENAI_API_KEY",)):
        value = os.environ.get(env_name, "").strip()
        if value:
            return value
    return ""


def _default_base_url(provider: str) -> str:
    key = provider.strip().lower()
    for env_name in _PROVIDER_BASE_URL_ENVS.get(key, ("OPENAI_BASE_URL",)):
        value = os.environ.get(env_name, "").strip()
        if value:
            return value.rstrip("/")
    return _OPENAI_COMPAT_DEFAULT_BASE_URLS.get(key, "https://api.cerebras.ai/v1")


def _coerce_float(value: object, fallback: float | None) -> float | None:
    if isinstance(value, bool):
        return fallback
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value)
        except ValueError:
            return fallback
    return fallback


def _coerce_int(value: object, fallback: int | None) -> int | None:
    if isinstance(value, bool):
        return fallback
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return int(value)
        except ValueError:
            return fallback
    return fallback


def _is_gpt_oss(model: str) -> bool:
    return model.rsplit("/", 1)[-1].startswith("gpt-oss")


# --------------------------------------------------------------------------
# Telemetry — mirrors the hermes/openclaw per-turn JSONL record so the
# orchestrator's token + cost aggregation reads Smithers runs identically.
# --------------------------------------------------------------------------

_TELEMETRY_TURN_COUNTER = 0
_TELEMETRY_FALLBACK_PATH: str | None = None


def _resolve_telemetry_path() -> str | None:
    explicit = os.environ.get("BENCHMARK_TELEMETRY_JSONL", "").strip()
    if explicit:
        return explicit
    run_dir = os.environ.get("BENCHMARK_RUN_DIR", "").strip()
    if run_dir:
        return str(Path(run_dir) / "telemetry.jsonl")
    global _TELEMETRY_FALLBACK_PATH
    if _TELEMETRY_FALLBACK_PATH is None:
        import tempfile

        _TELEMETRY_FALLBACK_PATH = str(
            Path(tempfile.mkdtemp(prefix="smithers-adapter-telemetry-")) / "telemetry.jsonl"
        )
        logger.info("BENCHMARK_RUN_DIR not set; telemetry -> %s", _TELEMETRY_FALLBACK_PATH)
    return _TELEMETRY_FALLBACK_PATH


def _usage_tokens(usage: Mapping[str, object]) -> dict[str, int | None]:
    def pick(*keys: str) -> int | None:
        for key in keys:
            v = usage.get(key)
            if isinstance(v, bool):
                continue
            if isinstance(v, (int, float)):
                return int(v)
        return None

    return {
        "prompt_tokens": pick("prompt_tokens", "promptTokens", "input_tokens"),
        "completion_tokens": pick("completion_tokens", "completionTokens", "output_tokens"),
        "total_tokens": pick("total_tokens", "totalTokens"),
        "cache_read_input_tokens": pick("cached_tokens", "cache_read_input_tokens"),
        "cache_creation_input_tokens": pick("cache_creation_input_tokens"),
    }


def _write_telemetry(
    *,
    provider: str,
    model: str,
    text: str,
    latency_ms: float,
    task_id: str | None,
    benchmark: str | None,
    response: MessageResponse | None = None,
    error: str | None = None,
) -> None:
    path_str = _resolve_telemetry_path()
    if not path_str:
        return
    usage: dict[str, object] = {}
    if response is not None:
        raw = response.params.get("usage")
        if isinstance(raw, Mapping):
            usage = dict(raw)
    tokens = _usage_tokens(usage) if usage else {
        "prompt_tokens": None,
        "completion_tokens": None,
        "total_tokens": None,
        "cache_read_input_tokens": None,
        "cache_creation_input_tokens": None,
    }
    global _TELEMETRY_TURN_COUNTER
    turn_index = _TELEMETRY_TURN_COUNTER
    _TELEMETRY_TURN_COUNTER += 1
    record: dict[str, Any] = {
        "harness": "smithers",
        "provider": provider,
        "model": model,
        "benchmark": benchmark,
        "task_id": task_id,
        "turn_index": turn_index,
        "prompt_text": text,
        "prompt_chars": len(text),
        "latency_ms": latency_ms,
        "usage": dict(usage),
        "prompt_tokens": tokens["prompt_tokens"],
        "completion_tokens": tokens["completion_tokens"],
        "total_tokens": tokens["total_tokens"],
        "cache_read_input_tokens": tokens["cache_read_input_tokens"],
        "cache_creation_input_tokens": tokens["cache_creation_input_tokens"],
        "actions": list(response.actions) if response is not None else [],
        "params": response.params if response is not None else {},
        "response_text": response.text if response is not None else "",
        "error_if_any": error,
    }
    try:
        path = Path(path_str)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=True, sort_keys=True) + "\n")
    except OSError as exc:
        logger.debug("failed to write smithers telemetry: %s", exc)


class SmithersClient:
    """Client for one-shot turns against the Smithers OpenAIAgent harness."""

    def __init__(
        self,
        *,
        install_dir: Path | None = None,
        bun_bin: str | None = None,
        provider: str = "cerebras",
        model: str = "gemma-4-31b",
        api_key: str | None = None,
        base_url: str | None = None,
        timeout_s: float = 1200.0,
        temperature: float | None = None,
        reasoning_effort: str | None = None,
        max_tokens: int | None = None,
    ) -> None:
        self.install_dir = resolve_install_dir(install_dir)
        self._bun_bin_explicit = bun_bin
        self.provider = provider
        self.model = model
        self.api_key = api_key if api_key is not None else _default_api_key(provider)
        self.base_url = (
            base_url.rstrip("/") if isinstance(base_url, str) and base_url else _default_base_url(provider)
        )
        self.timeout_s = float(timeout_s)
        self.temperature = temperature
        self.reasoning_effort = (
            reasoning_effort
            if reasoning_effort is not None
            else os.environ.get("BENCHMARK_REASONING_EFFORT") or os.environ.get("CEREBRAS_REASONING_EFFORT")
        )
        self.max_tokens = max_tokens
        self._task_id: str | None = None
        self._benchmark: str | None = None
        self._script_path: Path | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    @property
    def bun_bin(self) -> str:
        return resolve_bun_binary(self._bun_bin_explicit)

    def materialize_script(self) -> Path:
        """Copy the canonical harness files into the install dir.

        Bun resolves an entry file's bare imports from the file's own directory
        tree, so the script must live next to Smithers' ``node_modules``.
        """
        self.install_dir.mkdir(parents=True, exist_ok=True)
        target = self.install_dir / _HARNESS_SCRIPT_NAME
        optimization_target = self.install_dir / _OPTIMIZATION_SCRIPT_NAME
        for src, dst in (
            (_CANONICAL_SCRIPT, target),
            (_CANONICAL_OPTIMIZATION_SCRIPT, optimization_target),
        ):
            src_text = src.read_text(encoding="utf-8")
            if not dst.exists() or dst.read_text(encoding="utf-8") != src_text:
                dst.write_text(src_text, encoding="utf-8")
        self._script_path = target
        return target

    def health(self) -> dict[str, object]:
        try:
            bun = self.bun_bin
        except FileNotFoundError as exc:
            return {"status": "error", "error": str(exc)}
        node_modules = self.install_dir / "node_modules" / "smithers-orchestrator"
        if not node_modules.exists():
            return {
                "status": "error",
                "error": f"smithers-orchestrator not installed at {node_modules}",
            }
        try:
            self.materialize_script()
        except OSError as exc:
            return {"status": "error", "error": f"cannot materialize harness: {exc}"}
        # Confirm bun can import the package.
        probe = subprocess.run(  # noqa: S603 — argv constructed
            [bun, "-e", "import('smithers-orchestrator').then(()=>console.log('ok'))"],
            cwd=str(self.install_dir),
            capture_output=True,
            text=True,
            timeout=60,
        )
        if probe.returncode != 0 or "ok" not in (probe.stdout or ""):
            return {"status": "error", "error": (probe.stderr or "")[-2000:]}
        return {"status": "ready", "stdout": "ok"}

    def is_ready(self) -> bool:
        return self.health().get("status") == "ready"

    def wait_until_ready(self, timeout: float = 60.0, poll: float = 1.0) -> None:
        deadline = time.monotonic() + float(timeout)
        last_err: object = "no probe attempted"
        while time.monotonic() < deadline:
            probe = self.health()
            if probe.get("status") == "ready":
                logger.info("smithers harness ready (install=%s)", self.install_dir)
                return
            last_err = probe.get("error") or probe
            time.sleep(poll)
        raise TimeoutError(f"smithers harness not ready after {timeout}s: {last_err}")

    def reset(self, task_id: str, benchmark: str, **kwargs: object) -> dict[str, object]:
        del kwargs
        self._task_id = task_id
        self._benchmark = benchmark
        return {"task_id": task_id, "benchmark": benchmark, "status": "ready"}

    # ------------------------------------------------------------------
    # Per-turn
    # ------------------------------------------------------------------

    def build_payload(self, text: str, context: Mapping[str, object] | None) -> dict[str, object]:
        ctx = dict(context or {})
        reasoning_effort = ctx.get("reasoning_effort") or self.reasoning_effort
        if not reasoning_effort and _is_gpt_oss(self.model):
            reasoning_effort = "low"
        return {
            "text": text,
            "context": ctx,
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
            "api_key": self.api_key,
            "system_prompt": ctx.get("system_prompt"),
            "tools": ctx.get("tools"),
            "tool_choice": ctx.get("tool_choice"),
            "temperature": _coerce_float(ctx.get("temperature"), self.temperature),
            "reasoning_effort": reasoning_effort,
            "max_tokens": _coerce_int(ctx.get("max_tokens"), self.max_tokens),
            "task_id": self._task_id,
            "benchmark": self._benchmark,
        }

    def build_command(self) -> list[str]:
        script = self._script_path or self.materialize_script()
        return [self.bun_bin, "run", str(script)]

    def send_message(self, text: str, context: Mapping[str, object] | None = None) -> MessageResponse:
        started = time.monotonic()
        try:
            response = self._send_subprocess(text, context)
        except Exception as exc:
            _write_telemetry(
                provider=self.provider,
                model=self.model,
                text=text,
                latency_ms=(time.monotonic() - started) * 1000.0,
                task_id=self._task_id,
                benchmark=self._benchmark,
                error=f"{type(exc).__name__}: {exc}",
            )
            raise
        _write_telemetry(
            provider=self.provider,
            model=self.model,
            text=text,
            latency_ms=(time.monotonic() - started) * 1000.0,
            task_id=self._task_id,
            benchmark=self._benchmark,
            response=response,
        )
        return response

    def _send_subprocess(self, text: str, context: Mapping[str, object] | None) -> MessageResponse:
        cmd = self.build_command()
        payload = self.build_payload(text, context)
        env = {**os.environ}
        env["CEREBRAS_API_KEY"] = self.api_key or env.get("CEREBRAS_API_KEY", "")
        env["OPENAI_API_KEY"] = self.api_key or env.get("OPENAI_API_KEY", "")
        result = subprocess.run(  # noqa: S603 — argv constructed, not shell
            cmd,
            input=json.dumps(payload),
            cwd=str(self.install_dir),
            env=env,
            capture_output=True,
            text=True,
            timeout=self.timeout_s,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"smithers send_message failed (rc={result.returncode}):\n"
                f"STDERR (last 4000 chars):\n{(result.stderr or '')[-4000:]}"
            )
        stdout = (result.stdout or "").strip()
        last_line = stdout.rsplit("\n", 1)[-1] if stdout else ""
        if not last_line:
            raise RuntimeError(
                f"smithers send_message produced no JSON. STDERR:\n{(result.stderr or '')[-2000:]}"
            )
        try:
            parsed = json.loads(last_line)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"smithers stdout not JSON: {exc}\nstdout: {stdout[-2000:]}") from exc
        response = self._parse_response(parsed)
        adapter_error = response.params.get("error")
        if (
            isinstance(adapter_error, str)
            and adapter_error.strip()
            and not response.text.strip()
            and not response.actions
        ):
            raise RuntimeError(f"smithers adapter error: {adapter_error}")
        return response

    @staticmethod
    def _parse_response(raw: Mapping[str, object]) -> MessageResponse:
        actions_raw = raw.get("actions")
        actions = (
            [str(a) for a in actions_raw]
            if isinstance(actions_raw, Sequence) and not isinstance(actions_raw, (str, bytes))
            else []
        )
        params = dict(raw.get("params")) if isinstance(raw.get("params"), Mapping) else {}
        thought_raw = raw.get("thought")
        thought = str(thought_raw) if isinstance(thought_raw, str) and thought_raw else None
        text = str(raw.get("text") or "")
        if not text.strip() and thought is not None:
            text = thought
        return MessageResponse(text=text, thought=thought, actions=actions, params=params)
