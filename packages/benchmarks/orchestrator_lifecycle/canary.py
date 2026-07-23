"""Runs one capture-only lifecycle turn through all three native runtimes.

The canary is deliberately separate from scored benchmark orchestration. Its
only live mode starts one audited Claude-subscription gateway and three spawned
workers, then preserves native evidence while proving that publication state
remained byte-for-byte and metadata-for-metadata unchanged.
"""

from __future__ import annotations

import argparse
from collections.abc import Mapping, Sequence
from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import sys
import time
import traceback
import uuid

from benchmarks.orchestrator.locking import campaign_execution_lock
from benchmarks.publication_contracts import (
    ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256,
    ORCHESTRATOR_LIFECYCLE_TOOL_CONTRACT_SHA256,
    canonical_json_sha256,
)
from benchmarks.orchestrator.runtime_provenance import (
    native_runtime_quarantine_reason,
    summarize_runtime_provenance,
)
from benchmarks.orchestrator.subscription_gateway import (
    ClaudeSubscriptionGatewayProcess,
    FORBIDDEN_UPSTREAM_ENV,
    GatewayPauseState,
    read_gateway_pause_state,
    start_claude_subscription_gateway,
)
from benchmarks.orchestrator.subscription_provenance import (
    LIFECYCLE_EVALUATOR_GATEWAY_SCHEMA_SHA256,
    LIFECYCLE_STAGE1_GATEWAY_SCHEMA_SHA256,
    build_lifecycle_gateway_content_contract,
    evaluate_lifecycle_gateway_execution,
    scan_subscription_gateway_audit,
    subscription_gateway_quarantine_reason,
    summarize_subscription_gateway_audit,
    validate_subscription_gateway_audit_artifact,
)

from .contract import (
    LIFECYCLE_SYSTEM_HINT as _LIFECYCLE_SYSTEM_HINT,
    LIFECYCLE_TASKS_TOOLS as _LIFECYCLE_TASKS_TOOLS,
)


BENCHMARK_ID = "orchestrator_lifecycle"
CANARY_REQUEST = "fixtures/canary-request.json"
DEFAULT_MODEL = "claude-sonnet-4-6"
CANARY_REASONING_EFFORT = "medium"
CANARY_CONTENT_CONTRACT_ID = "orchestrator_lifecycle_canary_v1"
HARNESSES: tuple[str, ...] = ("eliza", "hermes", "openclaw")
EXPECTED_GATEWAY_REQUESTS: dict[str, int] = {
    "eliza": 3,
    "hermes": 2,
    "openclaw": 2,
}
EXPECTED_ELIZA_MODEL_TYPE_CALL_COUNTS: dict[str, int] = {
    "ACTION_PLANNER": 1,
    "RESPONSE_HANDLER": 2,
}
EXPECTED_STAGE_TOOL_NAMES: dict[str, tuple[tuple[str, ...], ...]] = {
    "eliza": (("HANDLE_RESPONSE",), ("TASKS",), ("HANDLE_RESPONSE",)),
    "hermes": (("TASKS",), ("TASKS",)),
    "openclaw": (("TASKS",), ("TASKS",)),
}
EXPECTED_STAGE_CALL_NAMES: dict[str, tuple[tuple[str, ...], ...]] = {
    "eliza": (("HANDLE_RESPONSE",), ("TASKS",), ("HANDLE_RESPONSE",)),
    "hermes": (("TASKS",), ()),
    "openclaw": (("TASKS",), ()),
}
EXPECTED_STAGE_TOOL_CHOICES: dict[str, tuple[str, ...]] = {
    "eliza": ("required", "required", "required"),
    "hermes": ("auto", "auto"),
    "openclaw": ("auto", "auto"),
}
EXPECTED_CAPTURE_RESULT: dict[str, object] = {
    "captured": True,
    "effect": "not_executed",
    "sequence": 0,
    "tool": "TASKS",
}
EXPECTED_TASKS_GATEWAY_SCHEMA_SHA256 = (
    "5e61574cc504c156aefc47cde293a031d1a2301daa10b1664bf3902c42c05535"
)
OPAQUE_TASK_ID_RE = re.compile(r"^orchestrator-lifecycle-[0-9a-f]{32}$")
ANSWER_LABELS = (
    "specific_request_simple",
    "spawn_subagent",
)
READINESS_TIMEOUT_SECONDS = 360.0
WORKER_TIMEOUT_SECONDS = 1_500.0
WORKER_GRACEFUL_EXIT_SECONDS = 10.0
WORKER_TERMINATE_EXIT_SECONDS = 30.0
WORKER_KILL_EXIT_SECONDS = 30.0
DEFAULT_STORAGE_MIN_FREE_BYTES = 8 * 1024**3
DEFAULT_STORAGE_EXPECTED_HEADROOM_BYTES = 4 * 1024**3
CANARY_CHECKPOINT_SCHEMA_VERSION = 1
_FINGERPRINT_EXCLUDED_PARTS = frozenset(
    {
        ".cache",
        ".git",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".turbo",
        ".venv",
        "__pycache__",
        "artifacts",
        "benchmark_results",
        "build",
        "coverage",
        "dist",
        "node_modules",
        "outputs",
        "results",
        "runs",
        "venv",
    }
)


class CanaryError(RuntimeError):
    """A live canary contract failed before evidence could be accepted."""


class CanaryWorkerError(CanaryError):
    """One or more released workers failed after every lane reached a terminal state."""

    def __init__(
        self,
        message: str,
        *,
        worker_results: Mapping[str, dict[str, object]],
    ) -> None:
        super().__init__(message)
        self.worker_results = dict(worker_results)


class CanaryStoragePreflightError(CanaryError):
    """Blocks live work before any artifact, auth, process, or model call."""

    def __init__(self, *, free_bytes: int, required_bytes: int) -> None:
        self.free_bytes = free_bytes
        self.required_bytes = required_bytes
        super().__init__(
            "Lifecycle canary storage preflight failed: "
            f"free_bytes={free_bytes}, required_bytes={required_bytes}"
        )


@dataclass(frozen=True)
class CanaryPlan:
    """Non-secret execution plan; constructing it performs no writes or calls."""

    workspace_root: Path
    output_root: Path
    artifact_root: Path
    run_group_id: str
    model: str
    prompt: str
    task_ids: Mapping[str, str]
    tasks_contract_sha256: str
    source_fingerprint_sha256: str
    execution_namespace: str
    checkpoint_root: Path
    replay_file: Path
    hmac_key_file: Path
    minimum_free_bytes: int

    def public_payload(self) -> dict[str, object]:
        return {
            "schema_version": 1,
            "kind": "orchestrator_lifecycle_tri_harness_canary",
            "run_group_id": self.run_group_id,
            "model": self.model,
            "benchmark": BENCHMARK_ID,
            "harnesses": list(HARNESSES),
            "worker_processes": len(HARNESSES),
            "shared_gateway_processes": 1,
            "outer_dispatches_per_harness": 1,
            "canary_request_sha256": hashlib.sha256(
                self.prompt.encode("utf-8")
            ).hexdigest(),
            "expected_gateway_requests": dict(EXPECTED_GATEWAY_REQUESTS),
            "expected_gateway_requests_total": sum(EXPECTED_GATEWAY_REQUESTS.values()),
            "expected_reasoning_effort": CANARY_REASONING_EFFORT,
            "tasks_contract_sha256": self.tasks_contract_sha256,
            "source_fingerprint_sha256": self.source_fingerprint_sha256,
            "execution_namespace": self.execution_namespace,
            "checkpoint_relative_path": self.replay_file.relative_to(
                self.output_root
            ).as_posix(),
            "minimum_free_bytes": self.minimum_free_bytes,
            "system_hint_sha256": ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256,
            "expected_tasks_gateway_schema_sha256": (
                EXPECTED_TASKS_GATEWAY_SCHEMA_SHA256
            ),
            "task_ids": dict(self.task_ids),
            "artifact_root": str(self.artifact_root),
            "scored": False,
            "publication_eligible": False,
            "writes_orchestrator_sqlite": False,
            "writes_latest": False,
            "writes_viewer": False,
        }


def build_canary_plan(
    *,
    model: str = DEFAULT_MODEL,
    run_group_id: str | None = None,
    workspace_root: Path | None = None,
    minimum_free_bytes: int = (
        DEFAULT_STORAGE_MIN_FREE_BYTES + DEFAULT_STORAGE_EXPECTED_HEADROOM_BYTES
    ),
) -> CanaryPlan:
    """Build and validate the dry plan without starting any runtime."""

    root = (
        workspace_root.resolve()
        if workspace_root is not None
        else Path(__file__).resolve().parents[2]
    )
    normalized_model = model.strip().split("/", 1)[-1]
    if not normalized_model:
        raise ValueError("A Claude model name is required")
    if (
        isinstance(minimum_free_bytes, bool)
        or not isinstance(minimum_free_bytes, int)
        or minimum_free_bytes <= 0
    ):
        raise ValueError("Canary minimum_free_bytes must be a positive integer")
    group = run_group_id or (
        "canary_orchestrator_lifecycle_"
        + datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        + "_"
        + uuid.uuid4().hex[:12]
    )
    if not re.fullmatch(r"canary_orchestrator_lifecycle_[A-Za-z0-9_-]+", group):
        raise ValueError("Canary run-group id is not safely scoped")
    prompt = _load_canary_prompt(root)
    contract_path = root / "benchmarks" / "orchestrator_lifecycle" / "tasks-tool.json"
    contract_bytes, contract = _load_tasks_contract(contract_path)
    parsed_contract_hash = canonical_json_sha256([contract])
    imported_contract_hash = canonical_json_sha256(list(_LIFECYCLE_TASKS_TOOLS))
    if (
        parsed_contract_hash != ORCHESTRATOR_LIFECYCLE_TOOL_CONTRACT_SHA256
        or imported_contract_hash != ORCHESTRATOR_LIFECYCLE_TOOL_CONTRACT_SHA256
        or contract != _LIFECYCLE_TASKS_TOOLS[0]
    ):
        raise CanaryError(
            "Lifecycle TASKS source and imported contracts must match the pinned "
            "full contract"
        )
    if (
        hashlib.sha256(_LIFECYCLE_SYSTEM_HINT.encode("utf-8")).hexdigest()
        != ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256
    ):
        raise CanaryError("Lifecycle shared system hint no longer matches its pin")
    derived_schema_hash = _normalized_tasks_gateway_schema_sha256(contract)
    if derived_schema_hash != EXPECTED_TASKS_GATEWAY_SCHEMA_SHA256:
        raise CanaryError(
            "Lifecycle TASKS source contract no longer matches the reviewed gateway schema"
        )
    source_fingerprint = _canary_source_fingerprint(root)
    execution_contract = {
        "schema_version": CANARY_CHECKPOINT_SCHEMA_VERSION,
        "benchmark": BENCHMARK_ID,
        "model": normalized_model,
        "reasoning_effort": CANARY_REASONING_EFFORT,
        "harnesses": list(HARNESSES),
        "expected_gateway_requests": dict(EXPECTED_GATEWAY_REQUESTS),
        "canary_request_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        "tasks_contract_sha256": hashlib.sha256(contract_bytes).hexdigest(),
        "system_hint_sha256": ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256,
        "source_fingerprint_sha256": source_fingerprint,
    }
    execution_namespace = (
        "orchestrator-lifecycle-canary-v1-"
        + canonical_json_sha256(execution_contract)
    )
    task_ids = {
        harness: "orchestrator-lifecycle-"
        + hashlib.sha256(
            f"{execution_namespace}\x00{harness}".encode("utf-8")
        ).hexdigest()[:32]
        for harness in HARNESSES
    }
    if not all(OPAQUE_TASK_ID_RE.fullmatch(value) for value in task_ids.values()):
        raise CanaryError("Canary generated a non-opaque task id")
    output_root = root / "benchmarks" / "benchmark_results"
    checkpoint_root = (
        output_root / ".subscription-checkpoints" / execution_namespace
    )
    return CanaryPlan(
        workspace_root=root,
        output_root=output_root,
        artifact_root=output_root / group,
        run_group_id=group,
        model=normalized_model,
        prompt=prompt,
        task_ids=task_ids,
        tasks_contract_sha256=hashlib.sha256(contract_bytes).hexdigest(),
        source_fingerprint_sha256=source_fingerprint,
        execution_namespace=execution_namespace,
        checkpoint_root=checkpoint_root,
        replay_file=checkpoint_root / "responses.jsonl",
        hmac_key_file=checkpoint_root / "responses.jsonl.hmac-key",
        minimum_free_bytes=minimum_free_bytes,
    )


def _canary_source_fingerprint(workspace_root: Path) -> str:
    """Bind private replay to every source surface that shapes the canary turn."""

    repository_root = workspace_root.parent
    candidates = (
        workspace_root / "benchmarks" / "orchestrator_lifecycle",
        workspace_root / "benchmarks" / "claude-subscription-gateway",
        workspace_root / "benchmarks" / "eliza-adapter",
        workspace_root / "benchmarks" / "hermes-adapter",
        workspace_root / "benchmarks" / "openclaw-adapter",
        repository_root / "package.json",
        repository_root / "bun.lock",
        repository_root / "bun.lockb",
    )
    files: set[Path] = set()
    for candidate in candidates:
        if candidate.is_file() and not candidate.is_symlink():
            files.add(candidate)
            continue
        if not candidate.is_dir():
            continue
        for path in candidate.rglob("*"):
            try:
                relative_parts = path.relative_to(candidate).parts
            except ValueError:
                continue
            if any(part in _FINGERPRINT_EXCLUDED_PARTS for part in relative_parts):
                continue
            if path.is_file() and not path.is_symlink():
                files.add(path)
    digest = hashlib.sha256()
    try:
        for path in sorted(files, key=lambda value: value.as_posix()):
            relative = path.relative_to(repository_root).as_posix().encode("utf-8")
            digest.update(len(relative).to_bytes(8, "big"))
            digest.update(relative)
            with path.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
    except OSError as error:
        # error-policy:J2 replay identity cannot omit an unreadable source input.
        raise CanaryError("Canary source fingerprint could not be completed") from error
    return digest.hexdigest()


def check_canary_storage(plan: CanaryPlan) -> dict[str, object]:
    """Reject live execution before allocating artifacts or starting auth."""

    try:
        free_bytes = int(shutil.disk_usage(plan.workspace_root).free)
    except OSError as error:
        # error-policy:J2 an unreadable filesystem reserve cannot be treated as safe.
        raise CanaryError("Lifecycle canary storage preflight is unavailable") from error
    payload: dict[str, object] = {
        "checked_at": datetime.now(UTC).isoformat(),
        "path": str(plan.workspace_root.resolve()),
        "free_bytes": free_bytes,
        "required_bytes": plan.minimum_free_bytes,
    }
    if free_bytes < plan.minimum_free_bytes:
        raise CanaryStoragePreflightError(
            free_bytes=free_bytes,
            required_bytes=plan.minimum_free_bytes,
        )
    return payload


def _load_tasks_contract(contract_path: Path) -> tuple[bytes, dict[str, object]]:
    """Load the exact workspace contract used by both plan hashes."""

    try:
        contract_bytes = contract_path.read_bytes()
        payload = json.loads(contract_bytes)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        # error-policy:J3 the local schema is a required input, never a fallback.
        raise CanaryError(
            f"Lifecycle TASKS source contract is unreadable: {contract_path}"
        ) from error
    if not isinstance(payload, dict) or payload.get("type") != "function":
        raise CanaryError("Lifecycle TASKS source contract is not a function tool")
    function = payload.get("function")
    if (
        not isinstance(function, dict)
        or function.get("name") != "TASKS"
        or not isinstance(function.get("description"), str)
        or not isinstance(function.get("parameters"), dict)
    ):
        raise CanaryError("Lifecycle TASKS source contract is malformed")
    return contract_bytes, payload


def _normalized_tasks_gateway_schema_sha256(
    contract: Mapping[str, object],
) -> str:
    """Hash TASKS exactly as the gateway's parseTool/stableJson boundary does."""

    function = contract["function"]
    if not isinstance(function, Mapping):
        raise CanaryError("Lifecycle TASKS source contract has no function schema")
    normalized = [
        {
            "type": "function",
            "function": {
                "name": function["name"],
                "description": function["description"],
                "parameters": function["parameters"],
            },
        }
    ]
    canonical = json.dumps(
        normalized,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _load_canary_prompt(workspace_root: Path) -> str:
    request_path = (
        workspace_root / "benchmarks" / "orchestrator_lifecycle" / CANARY_REQUEST
    )
    try:
        payload = json.loads(request_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        # error-policy:J3 the canary request is an input boundary, not a fallback prompt.
        raise CanaryError(f"Canary request is unreadable: {request_path}") from error
    if not isinstance(payload, Mapping):
        raise CanaryError("Canary request must be an object")
    if payload.get("schema_version") != 1 or payload.get("kind") != (
        "orchestrator_lifecycle_transport_canary"
    ):
        raise CanaryError("Canary request identity is invalid")
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise CanaryError("Canary request prompt is empty")
    if any(label in prompt.lower() for label in ANSWER_LABELS):
        raise CanaryError("Canary request prompt contains a scored answer label")
    return prompt.strip()


def _private_json(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    path.chmod(0o600)


def _path_fingerprint(path: Path) -> dict[str, object]:
    if not path.exists():
        return {"exists": False}
    if path.is_symlink():
        raise CanaryError(f"Publication target may not be a symlink: {path}")
    stat_result = path.stat()
    if path.is_file():
        return {
            "exists": True,
            "kind": "file",
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "size": stat_result.st_size,
            "mtime_ns": stat_result.st_mtime_ns,
            "mode": stat_result.st_mode & 0o777,
        }
    if not path.is_dir():
        raise CanaryError(f"Unsupported publication target type: {path}")
    digest = hashlib.sha256()
    entries = 0
    for child in sorted(path.rglob("*")):
        if child.is_symlink():
            raise CanaryError(f"Publication tree contains a symlink: {child}")
        relative = child.relative_to(path).as_posix()
        child_stat = child.stat()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(child_stat.st_mode & 0o777).encode("ascii"))
        digest.update(b"\0")
        digest.update(str(child_stat.st_mtime_ns).encode("ascii"))
        digest.update(b"\0")
        if child.is_file():
            digest.update(child.read_bytes())
        entries += 1
    return {
        "exists": True,
        "kind": "directory",
        "sha256": digest.hexdigest(),
        "entries": entries,
        "mtime_ns": stat_result.st_mtime_ns,
        "mode": stat_result.st_mode & 0o777,
    }


def publication_snapshot(workspace_root: Path) -> dict[str, dict[str, object]]:
    """Fingerprint every production database/latest/viewer publication target."""

    output_root = workspace_root / "benchmarks" / "benchmark_results"
    fixed = {
        output_root / "orchestrator.sqlite",
        output_root / "benchmarks.db",
        output_root / "viewer_data.json",
        output_root / "latest",
        workspace_root / "benchmarks" / "viewer",
    }
    if output_root.exists():
        for pattern in ("*.sqlite*", "*.db*", "viewer*"):
            fixed.update(output_root.glob(pattern))
    return {
        str(path): _path_fingerprint(path)
        for path in sorted(fixed, key=lambda item: str(item))
    }


def _lane_environment(
    *,
    plan: CanaryPlan,
    harness: str,
    gateway_env: Mapping[str, str],
    lane_root: Path,
) -> dict[str, str]:
    env = {
        key: value
        for key, value in os.environ.items()
        if key.upper() not in FORBIDDEN_UPSTREAM_ENV
    }
    for key in (
        "CEREBRAS_API_KEY",
        "CEREBRAS_BASE_URL",
        "GROQ_API_KEY",
        "GROQ_BASE_URL",
        "OPENCLAW_API_KEY",
        "OPENROUTER_API_KEY",
        "OPENROUTER_BASE_URL",
        "TOGETHER_API_KEY",
        "TOGETHER_BASE_URL",
        "MISTRAL_API_KEY",
        "MISTRAL_BASE_URL",
        "VLLM_API_KEY",
        "VLLM_BASE_URL",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "BENCHMARK_TEMPERATURE",
        "TEMPERATURE",
        "BENCHMARK_MAX_TOKENS",
        "MAX_TOKENS",
        "BENCHMARK_REASONING_EFFORT",
        "REASONING_EFFORT",
        "OPENAI_REASONING_EFFORT",
        "CEREBRAS_REASONING_EFFORT",
        "OPENCLAW_THINKING_LEVEL",
    ):
        env.pop(key, None)
    python_paths = [
        str(plan.workspace_root),
        str((plan.workspace_root / "benchmarks" / "eliza-adapter").resolve()),
        str((plan.workspace_root / "benchmarks" / "hermes-adapter").resolve()),
        str((plan.workspace_root / "benchmarks" / "openclaw-adapter").resolve()),
    ]
    existing_pythonpath = env.get("PYTHONPATH", "")
    if existing_pythonpath:
        python_paths.append(existing_pythonpath)
    path_entries = [str(Path(sys.executable).parent)]
    bun_bin = Path.home() / ".bun" / "bin"
    if bun_bin.is_dir():
        path_entries.append(str(bun_bin))
    if env.get("PATH"):
        path_entries.append(env["PATH"])
    env.update({str(key): str(value) for key, value in gateway_env.items()})
    env.update(
        {
            "PATH": os.pathsep.join(path_entries),
            "PYTHONPATH": os.pathsep.join(python_paths),
            "PYTHONUNBUFFERED": "1",
            "BENCHMARK_MODEL_PROVIDER": "claude-subscription",
            "BENCHMARK_MODEL_NAME": plan.model,
            "BENCHMARK_HARNESS": harness,
            "ELIZA_BENCH_HARNESS": harness,
            "BENCHMARK_AGENT": harness,
            "BENCHMARK_REASONING_EFFORT": CANARY_REASONING_EFFORT,
            "OPENAI_REASONING_EFFORT": CANARY_REASONING_EFFORT,
            "OPENCLAW_THINKING_LEVEL": CANARY_REASONING_EFFORT,
            "BENCHMARK_WORKSPACE_PATH": str(plan.workspace_root.parent.resolve()),
            "ELIZA_PROVIDER": "openai",
            "MODEL_NAME": plan.model,
            "OPENAI_MODEL": plan.model,
            "OPENAI_LARGE_MODEL": plan.model,
            "OPENAI_SMALL_MODEL": plan.model,
            "OPENAI_MEDIUM_MODEL": plan.model,
            "OPENAI_RESPONSE_HANDLER_MODEL": plan.model,
            "OPENAI_ACTION_PLANNER_MODEL": plan.model,
            "ELIZA_CONVERSATION_COMPACTOR": "structured-state",
            "MAX_CONVERSATION_TOKENS": "120000",
            "BENCHMARK_CAPTURE_TRAJECTORIES": "1",
            "BENCHMARK_RUN_DIR": str(lane_root),
            "BENCHMARK_TELEMETRY_JSONL": str(lane_root / "telemetry.jsonl"),
            "ELIZA_BENCH_LOG_DIR": str(lane_root / "server-logs"),
            "OPENCLAW_BENCHMARK_STATE_DIR": str(lane_root / "native-state"),
            "HERMES_MODE": "subprocess",
            "HERMES_ADAPTER_MODE": "subprocess",
        }
    )
    for key in (
        "ELIZA_BENCH_URL",
        "ELIZA_BENCH_TOKEN",
        "ELIZA_BENCH_PORT",
        "ELIZA_BENCH_HOST",
        "ELIZA_BENCH_MOCK",
        "ELIZA_BENCH_SERVER_CMD",
        "HERMES_HOME",
        "OPENCLAW_DIRECT_OPENAI_COMPAT",
        "OPENCLAW_USE_CLI",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_BENCHMARK_CAPTURE_PATH",
    ):
        env.pop(key, None)
    if harness == "eliza":
        env["ELIZA_BENCH_LIFECYCLE_PROFILE"] = "1"
        env["ELIZA_BENCH_REQUIRE_ORCHESTRATOR"] = "1"
        env["ELIZA_BENCH_SUBSCRIPTION_CHAT_ONLY"] = "1"
        env["ELIZA_BENCH_DISABLE_DOTENV"] = "1"
        env["ELIZA_DISABLE_LOCAL_EMBEDDINGS"] = "1"
        env["ELIZA_BENCH_ALLOW_STUB_EMBEDDING"] = "0"
        env["ELIZA_BENCH_SKIP_EMBEDDING"] = "0"
        env["ELIZA_BENCH_FORCE_TOOL_CALL"] = "0"
    return env


def _install_child_environment(env: Mapping[str, str]) -> None:
    os.environ.clear()
    os.environ.update({str(key): str(value) for key, value in env.items()})
    for entry in reversed(env.get("PYTHONPATH", "").split(os.pathsep)):
        if entry and entry not in sys.path:
            sys.path.insert(0, entry)


def _lane_context(
    plan: CanaryPlan,
    harness: str,
    task_id: str,
) -> dict[str, object]:
    """Build transport controls without adding repository paths to prompts."""

    context: dict[str, object] = {
        "benchmark": BENCHMARK_ID,
        "task_id": task_id,
        "model_name": plan.model,
        "system_hint": _LIFECYCLE_SYSTEM_HINT,
        "reasoning_effort": CANARY_REASONING_EFFORT,
    }
    if harness in {"hermes", "openclaw"}:
        context.update(
            {
                "benchmark_messages": [],
                "tools": deepcopy(list(_LIFECYCLE_TASKS_TOOLS)),
                "tool_choice": "auto",
                "benchmark_workspace_path": str(plan.workspace_root.parent.resolve()),
            }
        )
    return context


def _manager_for_harness(harness: str, workspace_root: Path):
    if harness == "eliza":
        from eliza_adapter.server_manager import ElizaServerManager

        return ElizaServerManager(repo_root=workspace_root.parent)
    if harness == "hermes":
        from hermes_adapter.server_manager import HermesAgentManager

        return HermesAgentManager(
            mode="subprocess",
            workspace_path=workspace_root.parent,
        )
    if harness == "openclaw":
        from openclaw_adapter.server_manager import OpenClawCLIManager

        return OpenClawCLIManager()
    raise CanaryError(f"Unsupported canary harness: {harness}")


def _validate_health(harness: str, health: Mapping[str, object]) -> None:
    if health.get("status") != "ready":
        raise CanaryError(f"{harness} did not report ready health")
    if harness == "eliza":
        expected_handlers = {
            model_type: [{"provider": "openai", "priority": 0}]
            for model_type in (
                "ACTION_PLANNER",
                "RESPONSE_HANDLER",
                "TEXT_LARGE",
                "TEXT_MEDIUM",
                "TEXT_MEGA",
                "TEXT_NANO",
                "TEXT_SMALL",
                "TEXT_TOKENIZER_DECODE",
                "TEXT_TOKENIZER_ENCODE",
            )
        }
        expected = {
            "lifecycle_profile_active": True,
            "lifecycle_task_action_registered": True,
            "lifecycle_action_catalog": ["TASKS"],
            "lifecycle_action_count": 1,
            "lifecycle_task_contexts": [
                "general",
                "code",
                "automation",
                "agent_internal",
                "connectors",
            ],
            "lifecycle_tool_bridge": "lifecycle_capture_only",
            "lifecycle_task_unconditionally_planner_available": True,
            "subscription_chat_only": True,
            "embeddingMode": "disabled-text-only",
            "semanticMemoryEnabled": False,
            "standIn": False,
            "releaseEvidence": True,
            "lifecycle_force_tool_call_disabled": True,
            "lifecycle_benchmark_provider_mode": "shared_system_hint_only",
            "lifecycle_benchmark_provider_registered": True,
            "lifecycle_benchmark_provider_payload_neutral": True,
            "model_handlers": expected_handlers,
        }
        if any(health.get(key) != value for key, value in expected.items()):
            raise CanaryError("Eliza lifecycle runtime health contract failed")
        return
    expected = (
        {
            "agent_runtime": "hermes",
            "native_runtime_class": "run_agent.AIAgent",
            "native_runtime_api": "run_conversation",
            "transport": "subprocess_loopback_openai_compatible",
            "native_agent_instantiated": True,
            "legacy_raw_openai_bypass": False,
            "publishable_native": True,
        }
        if harness == "hermes"
        else {
            "agent_runtime": "openclaw",
            "transport": "openclaw_embedded_runtime",
            "publishable_native": True,
        }
    )
    if any(health.get(key) != value for key, value in expected.items()):
        raise CanaryError(f"{harness} native runtime health contract failed")


def _normalize_arguments(value: object) -> dict[str, object]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as error:
            # error-policy:J3 model tool arguments must remain explicitly invalid.
            raise CanaryError("TASKS arguments are invalid JSON") from error
    if not isinstance(value, Mapping):
        raise CanaryError("TASKS arguments are not an object")
    return {str(key): child for key, child in value.items()}


def _validate_tasks_arguments(arguments: Mapping[str, object]) -> None:
    parameters = _LIFECYCLE_TASKS_TOOLS[0]["function"]["parameters"]
    properties = parameters["properties"]
    required = set(parameters["required"])
    if not required.issubset(arguments):
        raise CanaryError("TASKS arguments omit a required field")
    extras = set(arguments) - set(properties)
    if extras:
        raise CanaryError(f"TASKS arguments contain extra fields: {sorted(extras)}")
    for name, value in arguments.items():
        schema = properties[name]
        expected_type = schema["type"]
        valid_type = (
            isinstance(value, str)
            if expected_type == "string"
            else isinstance(value, bool)
            if expected_type == "boolean"
            else False
        )
        if not valid_type:
            raise CanaryError(f"TASKS argument {name} has the wrong type")
        allowed = schema.get("enum")
        if isinstance(allowed, list) and value not in allowed:
            raise CanaryError(f"TASKS argument {name} is outside its enum")
    if arguments.get("action") not in {"create", "spawn_agent"}:
        raise CanaryError("Canary TASKS call did not select a start action")
    task = arguments.get("task")
    if not isinstance(task, str) or not task.strip():
        raise CanaryError("Canary start call omitted its task prompt")


def validate_lane_response(payload: Mapping[str, object]) -> dict[str, object]:
    """Require one TASKS call and the exact shared capture-only handler result."""

    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise CanaryError("Canary response text is empty")
    if payload.get("actions") != ["TASKS"]:
        raise CanaryError("Canary response did not expose exactly one TASKS action")
    params = payload.get("params")
    if not isinstance(params, Mapping):
        raise CanaryError("Canary response params are missing")
    raw_calls = params.get("tool_calls")
    raw_results = params.get("lifecycle_results")
    if not isinstance(raw_calls, list) or len(raw_calls) != 1:
        raise CanaryError("Canary did not preserve exactly one native tool call")
    if not isinstance(raw_results, list) or len(raw_results) != 1:
        raise CanaryError("Canary did not preserve exactly one handler result")
    call = raw_calls[0]
    execution = raw_results[0]
    if not isinstance(call, Mapping) or call.get("name") != "TASKS":
        raise CanaryError("Canary native tool call is not TASKS")
    if not isinstance(execution, Mapping) or execution.get("name") != "TASKS":
        raise CanaryError("Canary handler result is not tied to TASKS")
    arguments = _normalize_arguments(call.get("arguments"))
    result_arguments = _normalize_arguments(execution.get("arguments"))
    if result_arguments != arguments:
        raise CanaryError("TASKS call arguments and handler evidence differ")
    result = execution.get("result")
    if result != EXPECTED_CAPTURE_RESULT:
        raise CanaryError("TASKS handler did not return the shared capture-only result")
    _validate_tasks_arguments(arguments)
    return arguments


def _response_payload(response: object) -> dict[str, object]:
    return {
        "text": str(getattr(response, "text", "") or ""),
        "thought": getattr(response, "thought", None),
        "actions": list(getattr(response, "actions", []) or []),
        "params": dict(getattr(response, "params", {}) or {}),
    }


def _copy_hermes_state(manager: object, lane_root: Path) -> None:
    client = getattr(manager, "client", None)
    home = getattr(client, "hermes_home", None)
    if home is None:
        raise CanaryError("Hermes manager did not expose its isolated profile")
    source = Path(home)
    destination = lane_root / "native-state"
    if destination.exists():
        raise CanaryError("Hermes evidence destination already exists")
    shutil.copytree(source, destination)


def _redacted_error(error: BaseException, gateway_env: Mapping[str, str]) -> str:
    rendered = "".join(
        traceback.format_exception(type(error), error, error.__traceback__)
    )
    for secret in gateway_env.values():
        if secret:
            rendered = rendered.replace(secret, "[REDACTED]")
    return rendered


def _lane_worker(
    plan: CanaryPlan,
    harness: str,
    gateway_env: Mapping[str, str],
    start_event: object,
    abort_event: object,
    result_queue: object,
) -> None:
    """Start one native manager, wait for all peers, and dispatch exactly once."""

    lane_root = plan.artifact_root / harness
    lane_root.mkdir(parents=True, exist_ok=True)
    lane_root.chmod(0o700)
    stdout_path = lane_root / "worker.stdout.log"
    stderr_path = lane_root / "worker.stderr.log"
    manager = None
    ready_sent = False

    def terminate_cleanly(_signum: int, _frame: object) -> None:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise CanaryError("Canary supervisor requested worker termination")

    signal.signal(signal.SIGTERM, terminate_cleanly)
    try:
        env = _lane_environment(
            plan=plan,
            harness=harness,
            gateway_env=gateway_env,
            lane_root=lane_root,
        )
        _install_child_environment(env)
        with (
            stdout_path.open("w", encoding="utf-8") as stdout_handle,
            stderr_path.open("w", encoding="utf-8") as stderr_handle,
            redirect_stdout(stdout_handle),
            redirect_stderr(stderr_handle),
        ):
            manager = _manager_for_harness(harness, plan.workspace_root)
            manager.start()
            client = manager.client
            health = client.health()
            if not isinstance(health, Mapping):
                raise CanaryError(f"{harness} health payload is not an object")
            _validate_health(harness, health)
            _private_json(lane_root / "health.json", dict(health))
            result_queue.put(
                {
                    "phase": "ready",
                    "harness": harness,
                    "pid": os.getpid(),
                }
            )
            ready_sent = True
            if not start_event.wait(timeout=READINESS_TIMEOUT_SECONDS):
                raise CanaryError("Timed out waiting for synchronized canary release")
            if abort_event.is_set():
                raise CanaryError("Canary release was aborted before live dispatch")

            task_id = plan.task_ids[harness]
            client.reset(task_id=task_id, benchmark=BENCHMARK_ID)
            context = _lane_context(plan, harness, task_id)
            response = client.send_message(plan.prompt, context=context)
            response_payload = _response_payload(response)
            response_artifact = {
                "schema_version": 1,
                "harness": harness,
                "benchmark": BENCHMARK_ID,
                "task_id": task_id,
                "outer_dispatches": 1,
                "response": response_payload,
                "validation_status": "pending",
                "validated_arguments": None,
                "scored": False,
                "publication_eligible": False,
            }
            _private_json(lane_root / "response.json", response_artifact)
            arguments = validate_lane_response(response_payload)
            response_artifact["validation_status"] = "succeeded"
            response_artifact["validated_arguments"] = arguments
            _private_json(lane_root / "response.json", response_artifact)
            if harness == "hermes":
                _copy_hermes_state(manager, lane_root)
            manager.stop()
            manager = None
            result_queue.put(
                {
                    "phase": "complete",
                    "harness": harness,
                    "pid": os.getpid(),
                    "outer_dispatches": 1,
                    "task_id": task_id,
                }
            )
    except Exception as error:
        # error-policy:J1 the worker process boundary persists failure evidence.
        cleanup_errors: list[str] = []
        if manager is not None:
            if harness == "hermes" and not (lane_root / "native-state").exists():
                try:
                    _copy_hermes_state(manager, lane_root)
                except Exception as cleanup_error:
                    # error-policy:J6 failure evidence copy is teardown-only.
                    cleanup_errors.append(
                        f"Hermes evidence copy: {type(cleanup_error).__name__}: {cleanup_error}"
                    )
            try:
                manager.stop()
            except Exception as cleanup_error:
                # error-policy:J6 the primary worker failure remains authoritative.
                cleanup_errors.append(
                    f"Manager stop: {type(cleanup_error).__name__}: {cleanup_error}"
                )
        rendered = _redacted_error(error, gateway_env)
        if cleanup_errors:
            rendered += "\nTeardown failures:\n" + "\n".join(cleanup_errors)
            for secret in gateway_env.values():
                if secret:
                    rendered = rendered.replace(secret, "[REDACTED]")
        _private_json(
            lane_root / "failure.json",
            {
                "schema_version": 1,
                "harness": harness,
                "phase": "after_readiness" if ready_sent else "before_readiness",
                "error": rendered,
                "scored": False,
                "publication_eligible": False,
            },
        )
        result_queue.put(
            {
                "phase": "error",
                "harness": harness,
                "pid": os.getpid(),
                "error": rendered,
            }
        )
        # The persisted redacted traceback is authoritative; re-raising would let
        # multiprocessing print the original exception after stderr redirection ends.
        raise SystemExit(1)
    finally:
        for path in (stdout_path, stderr_path):
            if path.exists():
                path.chmod(0o600)


def _queue_get(result_queue: object, deadline: float) -> Mapping[str, object]:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise CanaryError("Timed out waiting for canary worker evidence")
    try:
        message = result_queue.get(timeout=remaining)
    except queue.Empty as error:
        # error-policy:J2 retain the queue timeout as the coordinator cause.
        raise CanaryError("Timed out waiting for canary worker evidence") from error
    if not isinstance(message, Mapping):
        raise CanaryError("Canary worker returned an invalid control message")
    return message


def _join_worker_processes(
    processes: Mapping[str, object],
    *,
    timeout: float,
    cleanup_errors: list[str],
) -> None:
    """Give every started child a share of one bounded teardown window."""

    deadline = time.monotonic() + timeout
    for harness, process in processes.items():
        remaining = max(0.0, deadline - time.monotonic())
        try:
            process.join(timeout=remaining)
        except Exception as error:
            # error-policy:J6 a later terminate/kill phase still owns this child.
            cleanup_errors.append(f"{harness} join: {type(error).__name__}: {error}")


def _alive_worker_processes(
    processes: Mapping[str, object],
    *,
    cleanup_errors: list[str],
) -> dict[str, object]:
    alive: dict[str, object] = {}
    for harness, process in processes.items():
        try:
            if process.is_alive():
                alive[harness] = process
        except Exception as error:
            # error-policy:J6 an uninspectable child must still receive escalation.
            cleanup_errors.append(
                f"{harness} liveness: {type(error).__name__}: {error}"
            )
            alive[harness] = process
    return alive


def _signal_worker_processes(
    processes: Mapping[str, object],
    *,
    method_name: str,
    cleanup_errors: list[str],
) -> None:
    for harness, process in processes.items():
        method = getattr(process, method_name, None)
        if not callable(method):
            cleanup_errors.append(f"{harness} has no {method_name} method")
            continue
        try:
            method()
        except Exception as error:
            # error-policy:J6 failure on one child must not spare its peers teardown.
            cleanup_errors.append(
                f"{harness} {method_name}: {type(error).__name__}: {error}"
            )


def _shutdown_worker_processes(
    processes: Mapping[str, object],
    *,
    start_event: object,
    abort_event: object,
) -> None:
    """Abort every started child and prove none survived the escalation ladder."""

    cleanup_errors: list[str] = []
    for label, event in (("abort", abort_event), ("release", start_event)):
        try:
            event.set()
        except Exception as error:
            # error-policy:J6 process signals escalate below even if an event breaks.
            cleanup_errors.append(f"{label} event: {type(error).__name__}: {error}")

    _join_worker_processes(
        processes,
        timeout=WORKER_GRACEFUL_EXIT_SECONDS,
        cleanup_errors=cleanup_errors,
    )
    alive = _alive_worker_processes(processes, cleanup_errors=cleanup_errors)
    _signal_worker_processes(
        alive,
        method_name="terminate",
        cleanup_errors=cleanup_errors,
    )
    _join_worker_processes(
        alive,
        timeout=WORKER_TERMINATE_EXIT_SECONDS,
        cleanup_errors=cleanup_errors,
    )
    alive = _alive_worker_processes(alive, cleanup_errors=cleanup_errors)
    _signal_worker_processes(
        alive,
        method_name="kill",
        cleanup_errors=cleanup_errors,
    )
    _join_worker_processes(
        alive,
        timeout=WORKER_KILL_EXIT_SECONDS,
        cleanup_errors=cleanup_errors,
    )
    survivors = _alive_worker_processes(alive, cleanup_errors=cleanup_errors)
    if survivors:
        cleanup_errors.append("workers survived kill: " + ", ".join(sorted(survivors)))
    if cleanup_errors:
        raise CanaryError(
            "Canary worker cleanup could not prove a clean shutdown: "
            + "; ".join(cleanup_errors)
        )


def _run_workers(
    plan: CanaryPlan,
    gateway: ClaudeSubscriptionGatewayProcess,
    *,
    process_context: object | None = None,
) -> dict[str, dict[str, object]]:
    context = process_context or multiprocessing.get_context("spawn")
    start_event = context.Event()
    abort_event = context.Event()
    result_queue = context.Queue()
    processes = {
        harness: context.Process(
            target=_lane_worker,
            name=f"lifecycle-canary-{harness}",
            args=(
                plan,
                harness,
                gateway.env_for_harness(harness),
                start_event,
                abort_event,
                result_queue,
            ),
        )
        for harness in HARNESSES
    }
    started_processes: dict[str, object] = {}
    ready: dict[str, dict[str, object]] = {}
    terminal: dict[str, dict[str, object]] = {}
    try:
        for harness, process in processes.items():
            process.start()
            started_processes[harness] = process
        readiness_deadline = time.monotonic() + READINESS_TIMEOUT_SECONDS
        while len(ready) < len(HARNESSES):
            message = _queue_get(result_queue, readiness_deadline)
            phase = message.get("phase")
            harness = str(message.get("harness") or "")
            if phase == "error":
                raise CanaryError(f"{harness} failed before synchronized release")
            if phase != "ready" or harness not in HARNESSES or harness in ready:
                raise CanaryError("Unexpected canary readiness message")
            ready[harness] = dict(message)
        pids = {int(message["pid"]) for message in ready.values()}
        if len(pids) != len(HARNESSES) or os.getpid() in pids:
            raise CanaryError("Canary did not start three independent worker processes")

        start_event.set()
        completion_deadline = time.monotonic() + WORKER_TIMEOUT_SECONDS
        while len(terminal) < len(HARNESSES):
            message = _queue_get(result_queue, completion_deadline)
            phase = message.get("phase")
            harness = str(message.get("harness") or "")
            if (
                phase not in {"complete", "error"}
                or harness not in HARNESSES
                or harness in terminal
            ):
                raise CanaryError("Unexpected canary completion message")
            if phase == "complete":
                if message.get("outer_dispatches") != 1:
                    raise CanaryError(f"{harness} did not perform exactly one dispatch")
                if message.get("pid") != ready[harness].get("pid"):
                    raise CanaryError(
                        f"{harness} worker identity changed during the turn"
                    )
                terminal[harness] = dict(message)
            else:
                terminal[harness] = {
                    "phase": "error",
                    "harness": harness,
                    "pid": message.get("pid"),
                    "outer_dispatches": 1,
                }
        for harness, process in processes.items():
            process.join(timeout=30.0)
            if process.is_alive():
                raise CanaryError(
                    f"{harness} worker did not exit cleanly: {process.exitcode}"
                )
            expected_exit = 0 if terminal[harness]["phase"] == "complete" else 1
            if process.exitcode != expected_exit:
                raise CanaryError(
                    f"{harness} worker exit disagreed with its terminal evidence: "
                    f"{process.exitcode}"
                )
        failures = sorted(
            harness
            for harness, result in terminal.items()
            if result["phase"] == "error"
        )
        if failures:
            raise CanaryWorkerError(
                "Canary worker failure after all released lanes reached a terminal "
                f"state: {', '.join(failures)}",
                worker_results=terminal,
            )
        return terminal
    except BaseException:
        # error-policy:J1 the supervisor owns every worker and releases no orphan.
        try:
            _shutdown_worker_processes(
                started_processes,
                start_event=start_event,
                abort_event=abort_event,
            )
        except Exception as cleanup_error:
            # error-policy:J1 incomplete teardown supersedes an unsafe return boundary.
            raise CanaryError(
                "Canary worker supervision failed and cleanup was incomplete"
            ) from cleanup_error
        raise


def _read_json_object(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        # error-policy:J3 evidence corruption remains an explicit invalid result.
        raise CanaryError(f"Canary evidence is unreadable: {path}") from error
    if not isinstance(payload, dict):
        raise CanaryError(f"Canary evidence is not an object: {path}")
    return payload


def _read_telemetry_records(path: Path) -> list[dict[str, object]]:
    """Read intact telemetry objects without normalizing malformed lines."""

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        # error-policy:J4 failed-run preservation renders an explicit
        # unvalidated/no-response state when telemetry is unavailable.
        return []
    records: list[dict[str, object]] = []
    for line in lines:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            # error-policy:J4 malformed partial records remain excluded from
            # the explicitly unvalidated failed-run evidence view.
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def _preserve_partial_lane_response(
    plan: CanaryPlan,
    harness: str,
) -> dict[str, object]:
    """Materialize adapter-boundary output when no full response was returned."""

    lane_root = plan.artifact_root / harness
    response_path = lane_root / "response.json"
    if response_path.is_file():
        return {
            "schema_version": 1,
            "status": "full_response_present",
            "artifact": str(response_path),
            "response_obtained": True,
            "validation_status": "deferred_to_lane_contract",
            "publication_eligible": False,
        }
    telemetry_path = lane_root / "telemetry.jsonl"
    matching_records = [
        record
        for record in _read_telemetry_records(telemetry_path)
        if record.get("harness") == harness
        and record.get("benchmark") == BENCHMARK_ID
        and record.get("task_id") == plan.task_ids[harness]
    ]
    if not matching_records:
        return {
            "schema_version": 1,
            "status": "unavailable",
            "artifact": None,
            "response_obtained": False,
            "validation_status": "unvalidated_partial",
            "publication_eligible": False,
        }
    record = matching_records[-1]
    text = record.get("response_text")
    actions = record.get("actions")
    params = record.get("params")
    response = {
        "text": text if isinstance(text, str) else "",
        "actions": (
            [action for action in actions if isinstance(action, str)]
            if isinstance(actions, list)
            else []
        ),
        "params": dict(params) if isinstance(params, Mapping) else None,
    }
    response_obtained = bool(
        response["text"] or response["actions"] or response["params"]
    )
    artifact_path = lane_root / "partial-response.json"
    telemetry_sha256 = hashlib.sha256(telemetry_path.read_bytes()).hexdigest()
    _private_json(
        artifact_path,
        {
            "schema_version": 1,
            "harness": harness,
            "benchmark": BENCHMARK_ID,
            "task_id": plan.task_ids[harness],
            "source": "telemetry.jsonl",
            "source_sha256": telemetry_sha256,
            "response": response,
            "response_obtained": response_obtained,
            "error_observed": record.get("error_if_any") not in (None, ""),
            "validation_status": "unvalidated_partial",
            "scored": False,
            "publication_eligible": False,
        },
    )
    return {
        "schema_version": 1,
        "status": "partial_response_preserved",
        "artifact": str(artifact_path),
        "response_obtained": response_obtained,
        "validation_status": "unvalidated_partial",
        "publication_eligible": False,
    }


def _lane_transcript_inventory(plan: CanaryPlan, harness: str) -> dict[str, object]:
    """Index preserved transcript-like files by hash without copying content."""

    lane_root = plan.artifact_root / harness
    candidates: set[Path] = set()
    for relative in (
        "telemetry.jsonl",
        "response.json",
        "partial-response.json",
        "failure.json",
        "worker.stdout.log",
        "worker.stderr.log",
    ):
        candidate = lane_root / relative
        if candidate.is_file():
            candidates.add(candidate)
    for pattern in (
        "native-state/benchmark-tool-calls.jsonl",
        "native-state/**/sessions/*.jsonl",
        "native-state/logs/*.log",
        "server-logs/*.log",
    ):
        candidates.update(path for path in lane_root.glob(pattern) if path.is_file())
    files = [
        {
            "path": path.relative_to(plan.artifact_root).as_posix(),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "size": path.stat().st_size,
        }
        for path in sorted(candidates)
    ]
    return {
        "schema_version": 1,
        "validation_status": "unvalidated_inventory",
        "publication_eligible": False,
        "files": files,
        "file_count": len(files),
    }


def _openclaw_usage_integer(value: object) -> int:
    """Accept only the non-negative integral counters OpenClaw attests."""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CanaryError("OpenClaw native usage contains a non-numeric counter")
    integer = int(value)
    if integer != value or integer < 0:
        raise CanaryError("OpenClaw native usage contains an invalid counter")
    return integer


def _normalize_openclaw_usage(
    raw_usage: object,
    *,
    trajectory: bool,
) -> dict[str, object]:
    """Normalize native transcript and trajectory counters for comparison."""

    if not isinstance(raw_usage, Mapping):
        raise CanaryError("OpenClaw native evidence omits aggregate usage")
    total_key = "total" if trajectory else "totalTokens"
    return {
        "prompt_tokens": _openclaw_usage_integer(raw_usage.get("input")),
        "completion_tokens": _openclaw_usage_integer(raw_usage.get("output")),
        "total_tokens": _openclaw_usage_integer(raw_usage.get(total_key)),
        "prompt_tokens_details": {
            "cached_tokens": _openclaw_usage_integer(raw_usage.get("cacheRead", 0)),
            "cache_write_tokens": _openclaw_usage_integer(
                raw_usage.get("cacheWrite", 0)
            ),
        },
    }


def _aggregate_openclaw_session_usage(
    assistant_messages: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    """Sum every native assistant model call without accepting partial usage."""

    totals = {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "cached_tokens": 0,
        "cache_write_tokens": 0,
    }
    if not assistant_messages:
        raise CanaryError("OpenClaw native session has no assistant record")
    for message in assistant_messages:
        usage = _normalize_openclaw_usage(message.get("usage"), trajectory=False)
        details = usage["prompt_tokens_details"]
        assert isinstance(details, Mapping)
        totals["prompt_tokens"] += int(usage["prompt_tokens"])
        totals["completion_tokens"] += int(usage["completion_tokens"])
        totals["total_tokens"] += int(usage["total_tokens"])
        totals["cached_tokens"] += int(details["cached_tokens"])
        totals["cache_write_tokens"] += int(details["cache_write_tokens"])
    return {
        "prompt_tokens": totals["prompt_tokens"],
        "completion_tokens": totals["completion_tokens"],
        "total_tokens": totals["total_tokens"],
        "prompt_tokens_details": {
            "cached_tokens": totals["cached_tokens"],
            "cache_write_tokens": totals["cache_write_tokens"],
        },
    }


def _validate_openclaw_system_surface(
    *,
    lane_root: Path,
    task_id: str,
    benchmark_workspace_path: Path,
    telemetry_record: Mapping[str, object],
) -> dict[str, object]:
    """Tie OpenClaw's prompt, session, trajectory, and identity proofs to disk."""

    task_state_root = lane_root / "native-state" / BENCHMARK_ID / task_id
    try:
        turn_directories = sorted(
            path
            for path in task_state_root.iterdir()
            if path.is_dir() and path.name.startswith("turn-")
        )
    except OSError as error:
        # error-policy:J2 preserve the expected native-state boundary in the cause.
        raise CanaryError("OpenClaw native turn state is missing") from error
    if len(turn_directories) != 1 or turn_directories[0].name != "turn-0000":
        raise CanaryError("OpenClaw native state does not prove exactly one turn")
    turn_root = turn_directories[0]
    runtime_workspace = (turn_root / "workspace").resolve()
    target_workspace = benchmark_workspace_path.resolve()
    agents_path = runtime_workspace / "AGENTS.md"
    try:
        agents_bytes = agents_path.read_bytes()
        agents_text = agents_bytes.decode("utf-8")
    except (OSError, UnicodeDecodeError) as error:
        # error-policy:J2 preserve the expected instruction artifact in the cause.
        raise CanaryError("OpenClaw native AGENTS.md evidence is missing") from error
    expected_hint_bytes = _LIFECYCLE_SYSTEM_HINT.encode("utf-8")
    if agents_bytes != expected_hint_bytes:
        raise CanaryError("OpenClaw native AGENTS.md does not match the shared hint")
    if str(target_workspace) in agents_text:
        raise CanaryError("OpenClaw native AGENTS.md exposed the target workspace")
    agents_sha256 = hashlib.sha256(agents_bytes).hexdigest()

    session_paths = sorted(
        path
        for path in (turn_root / "agents").glob("*/sessions/*.jsonl")
        if path.is_file() and not path.name.endswith(".trajectory.jsonl")
    )
    if len(session_paths) != 1:
        raise CanaryError(
            "OpenClaw native state does not contain exactly one session transcript"
        )
    session_path = session_paths[0]
    session_bytes = session_path.read_bytes()
    final_assistant: Mapping[str, object] | None = None
    assistant_messages: list[Mapping[str, object]] = []
    thinking_levels: list[str] = []
    for line_number, raw_line in enumerate(session_bytes.splitlines(), 1):
        if not raw_line.strip():
            continue
        try:
            record = json.loads(raw_line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            # error-policy:J3 malformed native evidence is explicitly invalid.
            raise CanaryError(
                f"OpenClaw native session line {line_number} is invalid"
            ) from error
        if not isinstance(record, Mapping):
            continue
        if record.get("type") == "thinking_level_change":
            thinking_level = record.get("thinkingLevel")
            if not isinstance(thinking_level, str) or not thinking_level.strip():
                raise CanaryError("OpenClaw native thinking evidence is invalid")
            thinking_levels.append(thinking_level.strip())
            continue
        if record.get("type") != "message":
            continue
        message = record.get("message")
        if isinstance(message, Mapping) and message.get("role") == "assistant":
            final_assistant = message
            assistant_messages.append(message)
    if final_assistant is None:
        raise CanaryError("OpenClaw native session has no assistant record")
    terminal_reason = final_assistant.get("stopReason")
    error_message = final_assistant.get("errorMessage")
    valid_empty_error = error_message is None or (
        isinstance(error_message, str) and not error_message.strip()
    )
    if terminal_reason != "stop" or not valid_empty_error:
        raise CanaryError(
            "OpenClaw lifecycle session did not end in a complete stop state"
        )
    if not thinking_levels or thinking_levels[-1] != CANARY_REASONING_EFFORT:
        raise CanaryError("OpenClaw native session does not attest medium thinking")
    session_usage = _aggregate_openclaw_session_usage(assistant_messages)
    session_usage_sha256 = canonical_json_sha256(session_usage)
    session_sha256 = hashlib.sha256(session_bytes).hexdigest()

    trajectory_path = session_path.with_name(
        f"{session_path.name.removesuffix('.jsonl')}.trajectory.jsonl"
    )
    try:
        trajectory_bytes = trajectory_path.read_bytes()
    except OSError as error:
        # error-policy:J2 preserve the independent trajectory boundary in the cause.
        raise CanaryError("OpenClaw native trajectory evidence is missing") from error
    trajectory_metadata: Mapping[str, object] | None = None
    trajectory_completed: Mapping[str, object] | None = None
    trajectory_ended: Mapping[str, object] | None = None
    for line_number, raw_line in enumerate(trajectory_bytes.splitlines(), 1):
        if not raw_line.strip():
            continue
        try:
            record = json.loads(raw_line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            # error-policy:J3 malformed trajectory evidence is explicitly invalid.
            raise CanaryError(
                f"OpenClaw native trajectory line {line_number} is invalid"
            ) from error
        if not isinstance(record, Mapping):
            continue
        record_type = record.get("type")
        data = record.get("data")
        if record_type not in {"trace.metadata", "model.completed", "session.ended"}:
            continue
        if not isinstance(data, Mapping):
            raise CanaryError("OpenClaw native trajectory record omits data")
        if record_type == "trace.metadata":
            if trajectory_metadata is not None:
                raise CanaryError("OpenClaw native trajectory duplicates metadata")
            trajectory_metadata = data
        elif record_type == "model.completed":
            if trajectory_completed is not None:
                raise CanaryError("OpenClaw native trajectory duplicates completion")
            trajectory_completed = data
        else:
            if trajectory_ended is not None:
                raise CanaryError(
                    "OpenClaw native trajectory duplicates terminal state"
                )
            trajectory_ended = data
    if (
        trajectory_metadata is None
        or trajectory_completed is None
        or trajectory_ended is None
    ):
        raise CanaryError("OpenClaw native trajectory evidence is incomplete")
    if (
        trajectory_ended.get("status") != "success"
        or trajectory_ended.get("aborted") is not False
        or trajectory_ended.get("timedOut") is not False
    ):
        raise CanaryError("OpenClaw native trajectory did not end successfully")
    trajectory_harness = trajectory_metadata.get("harness")
    trajectory_model = trajectory_metadata.get("model")
    if (
        not isinstance(trajectory_harness, Mapping)
        or trajectory_harness.get("type") != "openclaw"
        or not isinstance(trajectory_model, Mapping)
    ):
        raise CanaryError("OpenClaw native trajectory identity is invalid")
    trajectory_usage = _normalize_openclaw_usage(
        trajectory_completed.get("usage"), trajectory=True
    )
    if trajectory_usage != session_usage:
        raise CanaryError("OpenClaw native transcript and trajectory usage differ")
    if trajectory_model.get("thinkLevel") != CANARY_REASONING_EFFORT:
        raise CanaryError("OpenClaw native trajectory does not attest medium thinking")
    trajectory_sha256 = hashlib.sha256(trajectory_bytes).hexdigest()

    prompt_text = telemetry_record.get("prompt_text")
    if not isinstance(prompt_text, str):
        raise CanaryError("OpenClaw telemetry omits its native prompt")
    if str(target_workspace) in prompt_text:
        raise CanaryError("OpenClaw native prompt exposed the target workspace")
    params = telemetry_record.get("params")
    meta = params.get("_meta") if isinstance(params, Mapping) else None
    adapter_meta = meta.get("openclaw_adapter") if isinstance(meta, Mapping) else None
    if not isinstance(adapter_meta, Mapping):
        raise CanaryError("OpenClaw telemetry omits native system-prompt provenance")
    trajectory_version = trajectory_harness.get("version")
    trajectory_build = trajectory_harness.get("gitSha")
    expected_identity = (
        isinstance(trajectory_version, str)
        and bool(trajectory_version.strip())
        and isinstance(trajectory_build, str)
        and bool(re.fullmatch(r"[0-9a-fA-F]{7,40}", trajectory_build))
    )
    telemetry_usage = params.get("usage") if isinstance(params, Mapping) else None
    if (
        adapter_meta.get("native_system_prompt_surface") != "workspace/AGENTS.md"
        or adapter_meta.get("native_system_prompt_sha256") != agents_sha256
        or adapter_meta.get("native_requested_system_prompt_sha256") != agents_sha256
        or adapter_meta.get("native_system_prompt_matches_requested") is not True
        or adapter_meta.get("native_system_prompt_in_cli_message") is not False
        or adapter_meta.get("native_prompt_sha256")
        != hashlib.sha256(prompt_text.encode("utf-8")).hexdigest()
        or adapter_meta.get("benchmark_workspace_path") != str(target_workspace)
        or not isinstance(adapter_meta.get("benchmark_workspace_git_sha"), str)
        or not re.fullmatch(
            r"[0-9a-fA-F]{40}",
            str(adapter_meta.get("benchmark_workspace_git_sha")),
        )
        or adapter_meta.get("runtime_workspace_path") != str(runtime_workspace)
        or adapter_meta.get("runtime_workspace_isolated") is not True
        or runtime_workspace == target_workspace
        or adapter_meta.get("native_session_evidence") != "succeeded"
        or adapter_meta.get("native_session_sha256") != session_sha256
        or adapter_meta.get("native_session_terminal_stop_reason") != terminal_reason
        or adapter_meta.get("native_session_assistant_model_call_count")
        != len(assistant_messages)
        or adapter_meta.get("native_usage_scope") != "full_native_turn_aggregate"
        or adapter_meta.get("native_usage_sha256") != session_usage_sha256
        or telemetry_usage != session_usage
        or adapter_meta.get("native_trajectory_evidence") != "succeeded"
        or adapter_meta.get("native_trajectory_sha256") != trajectory_sha256
        or adapter_meta.get("reasoning_effort_requested") != CANARY_REASONING_EFFORT
        or adapter_meta.get("thinking_level_requested") != CANARY_REASONING_EFFORT
        or adapter_meta.get("thinking_level_effective") != CANARY_REASONING_EFFORT
        or adapter_meta.get("thinking_level_trajectory") != CANARY_REASONING_EFFORT
        or adapter_meta.get("thinking_level_attested") is not True
        or expected_identity is not True
        or adapter_meta.get("native_cli_health_version") != trajectory_version
        or adapter_meta.get("native_cli_health_build") != trajectory_build
        or adapter_meta.get("native_trajectory_runtime_version") != trajectory_version
        or adapter_meta.get("native_trajectory_runtime_git_sha") != trajectory_build
        or adapter_meta.get("native_runtime_identity_attested") is not True
    ):
        raise CanaryError(
            "OpenClaw native prompt/session/trajectory provenance does not match disk"
        )
    return {
        "turn_state": str(turn_root),
        "agents_path": str(agents_path),
        "agents_sha256": agents_sha256,
        "requested_system_prompt_sha256": agents_sha256,
        "effective_system_prompt_matches_requested": True,
        "surface": "workspace/AGENTS.md",
        "in_cli_message": False,
        "benchmark_workspace_path": str(target_workspace),
        "benchmark_workspace_path_absent_from_prompt": True,
        "runtime_workspace_path": str(runtime_workspace),
        "runtime_workspace_isolated": True,
        "session_path": str(session_path),
        "session_sha256": session_sha256,
        "session_terminal_stop_reason": terminal_reason,
        "assistant_model_call_count": len(assistant_messages),
        "native_usage_scope": "full_native_turn_aggregate",
        "native_usage_sha256": session_usage_sha256,
        "trajectory_path": str(trajectory_path),
        "trajectory_sha256": trajectory_sha256,
        "trajectory_status": "succeeded",
        "reasoning_effort": CANARY_REASONING_EFFORT,
        "thinking_level_attested": True,
        "native_runtime_version": trajectory_version,
        "native_runtime_build": trajectory_build,
        "native_runtime_identity_attested": True,
    }


def _validate_hermes_system_surface(
    telemetry_record: Mapping[str, object],
) -> dict[str, object]:
    """Prove the shared hint survived once on Hermes's recorded input surface."""

    prompt_text = telemetry_record.get("prompt_text")
    if not isinstance(prompt_text, str):
        raise CanaryError("Hermes telemetry omits its prompt text")
    occurrences = prompt_text.count(_LIFECYCLE_SYSTEM_HINT)
    if occurrences != 1:
        raise CanaryError(
            "Hermes telemetry does not contain the shared lifecycle hint exactly once"
        )
    lowered_prompt = prompt_text.lower()
    if any(label in lowered_prompt for label in ANSWER_LABELS):
        raise CanaryError("Hermes prompt telemetry leaked scenario answer labels")
    return {
        "surface": "telemetry.prompt_text",
        "shared_hint_occurrences": occurrences,
        "shared_hint_sha256": hashlib.sha256(
            _LIFECYCLE_SYSTEM_HINT.encode("utf-8")
        ).hexdigest(),
        "answer_labels_absent": True,
        "native_payload_unit_contract": (
            "packages/benchmarks/hermes-adapter/tests/test_client.py::"
            "test_client_send_message_promotes_system_hint_without_duplication"
        ),
    }


def _validate_canary_user_request_surface(
    plan: CanaryPlan,
    harness: str,
    telemetry_record: Mapping[str, object],
) -> dict[str, object]:
    """Prove each native prompt received one exact copy of the user request."""

    prompt_text = telemetry_record.get("prompt_text")
    if not isinstance(prompt_text, str):
        raise CanaryError(f"{harness} telemetry omits its prompt text")
    occurrences = prompt_text.count(plan.prompt)
    if occurrences != 1:
        raise CanaryError(
            f"{harness} telemetry does not contain the canary request exactly once"
        )
    benchmark_workspace_path = str(plan.workspace_root.parent.resolve())
    if benchmark_workspace_path in prompt_text:
        raise CanaryError(
            f"{harness} telemetry exposed the benchmark workspace control path"
        )
    return {
        "surface": "telemetry.prompt_text",
        "occurrences": occurrences,
        "request_sha256": hashlib.sha256(plan.prompt.encode("utf-8")).hexdigest(),
        "benchmark_workspace_path_absent": True,
    }


def _validate_eliza_system_hint_attestation(
    telemetry_record: Mapping[str, object],
) -> dict[str, object]:
    """Pin Eliza's per-turn final-model-input proof to the canary call graph."""

    runtime_provenance = telemetry_record.get("runtime_provenance")
    usage = telemetry_record.get("usage")
    if not isinstance(runtime_provenance, Mapping) or not isinstance(usage, Mapping):
        raise CanaryError("Eliza telemetry omits model-boundary hint evidence")
    attestation = runtime_provenance.get("lifecycle_system_hint_attestation")
    if not isinstance(attestation, Mapping):
        raise CanaryError("Eliza telemetry omits model-boundary hint attestation")
    expected_fields = {
        "schema_version",
        "system_hint_sha256",
        "model_boundary_call_count",
        "model_boundary_attested_call_count",
        "model_boundary_hint_occurrence_count",
        "exact_once_per_model_call",
        "model_type_call_counts",
    }
    expected_call_count = EXPECTED_GATEWAY_REQUESTS["eliza"]
    model_type_call_counts = attestation.get("model_type_call_counts")
    if (
        set(attestation) != expected_fields
        or type(attestation.get("schema_version")) is not int
        or attestation.get("schema_version") != 1
        or attestation.get("system_hint_sha256")
        != ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256
        or attestation.get("model_boundary_call_count") != expected_call_count
        or attestation.get("model_boundary_attested_call_count")
        != expected_call_count
        or attestation.get("model_boundary_hint_occurrence_count")
        != expected_call_count
        or attestation.get("exact_once_per_model_call") is not True
        or not isinstance(model_type_call_counts, Mapping)
        or model_type_call_counts != EXPECTED_ELIZA_MODEL_TYPE_CALL_COUNTS
        or any(type(count) is not int for count in model_type_call_counts.values())
        or usage.get("callCount") != expected_call_count
    ):
        raise CanaryError("Eliza model-boundary hint attestation drifted")
    return {
        "schema_version": 1,
        "surface": "runtime_provenance.lifecycle_system_hint_attestation",
        "system_hint_sha256": ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256,
        "model_boundary_call_count": expected_call_count,
        "model_boundary_attested_call_count": expected_call_count,
        "model_boundary_hint_occurrence_count": expected_call_count,
        "exact_once_per_model_call": True,
        "model_type_call_counts": dict(EXPECTED_ELIZA_MODEL_TYPE_CALL_COUNTS),
        "usage_call_count": expected_call_count,
    }


def _validate_lane_artifacts(plan: CanaryPlan, harness: str) -> dict[str, object]:
    lane_root = plan.artifact_root / harness
    response_artifact = _read_json_object(lane_root / "response.json")
    if response_artifact.get("validation_status") != "succeeded":
        raise CanaryError(f"{harness} response artifact was not validated")
    if response_artifact.get("outer_dispatches") != 1:
        raise CanaryError(f"{harness} response artifact has an invalid dispatch count")
    if response_artifact.get("task_id") != plan.task_ids[harness]:
        raise CanaryError(f"{harness} response artifact has the wrong task id")
    response = response_artifact.get("response")
    if not isinstance(response, Mapping):
        raise CanaryError(f"{harness} response artifact omits its response")
    validate_lane_response(response)

    telemetry_path = lane_root / "telemetry.jsonl"
    try:
        telemetry_text = telemetry_path.read_text(encoding="utf-8")
    except OSError as error:
        # error-policy:J2 identify the harness evidence boundary in the cause.
        raise CanaryError(f"{harness} telemetry is missing") from error
    telemetry_lines = [line for line in telemetry_text.splitlines() if line.strip()]
    if len(telemetry_lines) != 1:
        raise CanaryError(f"{harness} telemetry does not prove one outer dispatch")
    try:
        telemetry_record = json.loads(telemetry_lines[0])
    except json.JSONDecodeError as error:
        # error-policy:J3 invalid telemetry cannot be normalized into evidence.
        raise CanaryError(f"{harness} telemetry is invalid JSON") from error
    if not isinstance(telemetry_record, Mapping):
        raise CanaryError(f"{harness} telemetry record is not an object")
    if (
        telemetry_record.get("task_id") != plan.task_ids[harness]
        or telemetry_record.get("benchmark") != BENCHMARK_ID
        or telemetry_record.get("harness") != harness
        or telemetry_record.get("error_if_any") not in (None, "")
    ):
        raise CanaryError(f"{harness} telemetry identity or success contract failed")
    lowered_evidence = (telemetry_text + json.dumps(response_artifact)).lower()
    if any(label in lowered_evidence for label in ANSWER_LABELS):
        raise CanaryError(f"{harness} evidence leaked scenario answer labels")

    eliza_hint_evidence = (
        _validate_eliza_system_hint_attestation(telemetry_record)
        if harness == "eliza"
        else None
    )
    summary = summarize_runtime_provenance(telemetry_path)
    reason = native_runtime_quarantine_reason(
        agent=harness,
        provider="claude-subscription",
        model=plan.model,
        provenance=summary,
        benchmark_id=BENCHMARK_ID,
        expected_lifecycle_turn_count=1,
        expected_lifecycle_scenario_count=1,
    )
    if reason is not None:
        raise CanaryError(f"{harness} native provenance rejected: {reason}")
    if summary.get("telemetry_records") != 1:
        raise CanaryError(f"{harness} native provenance has extra turns")
    summary["canary_user_request_evidence"] = _validate_canary_user_request_surface(
        plan, harness, telemetry_record
    )
    if eliza_hint_evidence is not None:
        summary["model_boundary_system_hint_evidence"] = eliza_hint_evidence
    elif harness == "hermes":
        summary["shared_system_hint_evidence"] = _validate_hermes_system_surface(
            telemetry_record
        )
    elif harness == "openclaw":
        summary["native_system_prompt_evidence"] = _validate_openclaw_system_surface(
            lane_root=lane_root,
            task_id=plan.task_ids[harness],
            benchmark_workspace_path=plan.workspace_root.parent,
            telemetry_record=telemetry_record,
        )
    return summary


def _load_gateway_records(
    audit_path: Path,
    *,
    require_durable: bool = False,
) -> list[dict[str, object]]:
    """Collect logical completions through the shared bounded chain validator."""

    records: list[dict[str, object]] = []

    def retain_completion(record: Mapping[str, object]) -> None:
        event = record.get("audit_event")
        if event == "logical_completion" or (
            event is None
            and record.get("schema_version") == 1
            and record.get("status") == "succeeded"
        ):
            records.append(dict(record))

    diagnostics = scan_subscription_gateway_audit(audit_path, retain_completion)
    invalid_count = sum(
        int(diagnostics.get(key) or 0)
        for key in (
            "invalid_json_lines",
            "oversized_json_lines",
            "global_invalid_contract_records",
            "invalid_contract_records",
            "invalid_chain_records",
        )
    )
    if (
        diagnostics.get("audit_file_exists") is not True
        or diagnostics.get("audit_read_error") is True
        or invalid_count
        or diagnostics.get("audit_ignored_torn_tail_bytes") not in (0, None)
        or (
            require_durable
            and diagnostics.get("audit_chain_mode") != "sha256-chain-v2"
        )
    ):
        raise CanaryError("Gateway audit failed bounded integrity validation")
    return records


_SAFE_GATEWAY_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$")
_SAFE_GATEWAY_ROLES = frozenset({"system", "developer", "user", "assistant", "tool"})
_SAFE_GATEWAY_CHOICES = frozenset({"auto", "none", "required"})
_SAFE_GATEWAY_FINISH_REASONS = frozenset({"stop", "tool_calls"})


def _safe_gateway_names(value: object) -> list[str]:
    """Keep only controlled identifiers when reducing a failed audit."""

    if not isinstance(value, list):
        return []
    return [
        child
        for child in value
        if isinstance(child, str) and _SAFE_GATEWAY_NAME_RE.fullmatch(child)
    ]


def _safe_gateway_stage_evidence(
    records: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    """Reduce allowlisted metadata without claiming that any stage is valid."""

    grouped: dict[str, list[dict[str, object]]] = {harness: [] for harness in HARNESSES}
    unknown_harness_records = 0
    reasoning_effort_field_records = 0
    reasoning_efforts: set[str] = set()
    for record in records:
        harness = record.get("harness")
        if harness not in grouped:
            unknown_harness_records += 1
            continue
        reasoning_recorded = "reasoning_effort" in record
        if reasoning_recorded:
            reasoning_effort_field_records += 1
        reasoning_effort = record.get("reasoning_effort")
        reasoning_valid = reasoning_effort in {
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
        }
        if reasoning_valid and isinstance(reasoning_effort, str):
            reasoning_efforts.add(reasoning_effort)
        tool_names = _safe_gateway_names(record.get("tool_names"))
        per_tool_hashes = record.get("tool_schema_sha256_by_name")
        tasks_schema_hash = (
            per_tool_hashes.get("TASKS")
            if isinstance(per_tool_hashes, Mapping)
            and isinstance(per_tool_hashes.get("TASKS"), str)
            and re.fullmatch(r"[0-9a-f]{64}", str(per_tool_hashes.get("TASKS")))
            else None
        )
        grouped[str(harness)].append(
            {
                "index": len(grouped[str(harness)]),
                "status": (
                    record.get("status")
                    if record.get("status") in {"succeeded", "failed"}
                    else "invalid"
                ),
                "error_present": record.get("error_code") not in (None, ""),
                "tool_names": tool_names,
                "tool_call_names": _safe_gateway_names(record.get("tool_call_names")),
                "tool_choice": (
                    record.get("tool_choice")
                    if record.get("tool_choice") in _SAFE_GATEWAY_CHOICES
                    else "invalid"
                ),
                "parallel_tool_calls": (
                    record.get("parallel_tool_calls")
                    if isinstance(record.get("parallel_tool_calls"), bool)
                    else None
                ),
                "finish_reason": (
                    record.get("finish_reason")
                    if record.get("finish_reason") in _SAFE_GATEWAY_FINISH_REASONS
                    else None
                ),
                "result_subtype": (
                    record.get("result_subtype")
                    if isinstance(record.get("result_subtype"), str)
                    and _SAFE_GATEWAY_NAME_RE.fullmatch(
                        str(record.get("result_subtype"))
                    )
                    else None
                ),
                "terminal_reason": (
                    record.get("terminal_reason")
                    if isinstance(record.get("terminal_reason"), str)
                    and _SAFE_GATEWAY_NAME_RE.fullmatch(
                        str(record.get("terminal_reason"))
                    )
                    else None
                ),
                "message_roles": [
                    role
                    for role in _safe_gateway_names(record.get("message_roles"))
                    if role in _SAFE_GATEWAY_ROLES
                ],
                "reasoning_effort_recorded": reasoning_recorded,
                "reasoning_effort": reasoning_effort if reasoning_valid else None,
                "reasoning_effort_valid": reasoning_valid,
                "tasks_schema_sha256": tasks_schema_hash,
            }
        )
    return {
        "schema_version": 1,
        "validation_status": "unvalidated",
        "publication_eligible": False,
        "records": len(records),
        "records_by_harness": {harness: len(grouped[harness]) for harness in HARNESSES},
        "unknown_harness_records": unknown_harness_records,
        "reasoning_effort_field_records": reasoning_effort_field_records,
        "reasoning_efforts_observed": sorted(reasoning_efforts),
        "stages": grouped,
    }


def validate_gateway_stages(
    records: Sequence[Mapping[str, object]],
    *,
    workspace_root: Path | None = None,
    public_prompt: str | None = None,
) -> dict[str, object]:
    """Prove the exact seven-request native stage sequence with no retry room."""

    summary = _safe_gateway_stage_evidence(records)
    expected_total = sum(EXPECTED_GATEWAY_REQUESTS.values())
    if len(records) != expected_total:
        raise CanaryError(
            f"Gateway audit contains {len(records)} records; expected {expected_total}"
        )
    grouped = {harness: [] for harness in HARNESSES}
    request_ids: set[str] = set()
    tasks_schema_hashes: set[str] = set()
    for record in records:
        harness = record.get("harness")
        if harness not in grouped:
            raise CanaryError("Gateway audit contains an unknown harness")
        if record.get("status") != "succeeded" or record.get("error_code") not in (
            None,
            "",
        ):
            raise CanaryError(f"{harness} gateway request did not succeed")
        if (
            "reasoning_effort" not in record
            or record.get("reasoning_effort") != CANARY_REASONING_EFFORT
        ):
            raise CanaryError(
                f"{harness} gateway reasoning effort did not match the cohort"
            )
        request_id = record.get("request_id")
        if not isinstance(request_id, str) or request_id in request_ids:
            raise CanaryError("Gateway request ids are missing or reused")
        for field in ("request_sha256", "prompt_sha256", "system_prompt_sha256"):
            digest = record.get(field)
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise CanaryError(f"Gateway {field} is missing or invalid")
        request_ids.add(request_id)
        grouped[str(harness)].append(record)

    content_root = (
        workspace_root.resolve()
        if workspace_root is not None
        else Path(__file__).resolve().parents[2]
    )
    prompt = public_prompt if public_prompt is not None else _load_canary_prompt(content_root)
    content_contract = build_lifecycle_gateway_content_contract(
        content_root,
        public_user_turns=[prompt],
        contract_id=CANARY_CONTENT_CONTRACT_ID,
    )
    lifecycle_contracts: dict[str, object] = {}
    for harness in HARNESSES:
        tool_calls = ["TASKS"]
        model_types = (
            dict(EXPECTED_ELIZA_MODEL_TYPE_CALL_COUNTS)
            if harness == "eliza"
            else {}
        )
        lifecycle_contract = evaluate_lifecycle_gateway_execution(
            harness=harness,
            records=grouped[harness],
            runtime_turn_manifest=[
                {
                    "ordinal": 0,
                    "task_id_sha256": hashlib.sha256(
                        f"canary:{harness}".encode("utf-8")
                    ).hexdigest(),
                    "task_turn_index": 0,
                    "model_boundary_call_count": EXPECTED_GATEWAY_REQUESTS[harness],
                    "model_call_count_source": "canary_fixed_contract",
                    "model_type_call_counts": model_types,
                    "tool_call_names": tool_calls,
                    "lifecycle_result_names": tool_calls,
                }
            ],
            content_contract=content_contract,
            expected_reasoning_effort=CANARY_REASONING_EFFORT,
        )
        if lifecycle_contract.get("validation_status") != "succeeded":
            raise CanaryError(
                f"{harness} lifecycle gateway contract failed: "
                f"{lifecycle_contract.get('rejection_reason')}"
            )
        lifecycle_contracts[harness] = lifecycle_contract

    for harness in HARNESSES:
        lane = grouped[harness]
        expected_count = EXPECTED_GATEWAY_REQUESTS[harness]
        if len(lane) != expected_count:
            raise CanaryError(
                f"{harness} gateway records={len(lane)} expected={expected_count}"
            )
        expected_tools = EXPECTED_STAGE_TOOL_NAMES[harness]
        expected_calls = EXPECTED_STAGE_CALL_NAMES[harness]
        expected_choices = EXPECTED_STAGE_TOOL_CHOICES[harness]
        for index, record in enumerate(lane):
            tool_names = tuple(record.get("tool_names") or ())
            call_names = tuple(record.get("tool_call_names") or ())
            if tool_names != expected_tools[index]:
                raise CanaryError(f"{harness} stage {index} tool catalog drifted")
            if call_names != expected_calls[index]:
                raise CanaryError(f"{harness} stage {index} tool result drifted")
            if record.get("tool_choice") != expected_choices[index]:
                raise CanaryError(f"{harness} stage {index} tool choice drifted")
            expected_finish = "tool_calls" if call_names else "stop"
            if record.get("finish_reason") != expected_finish:
                raise CanaryError(f"{harness} stage {index} finish reason drifted")
            if not isinstance(record.get("parallel_tool_calls"), bool):
                raise CanaryError(
                    f"{harness} stage {index} parallel-tool setting is missing"
                )
            if "TASKS" in tool_names:
                per_tool_hashes = record.get("tool_schema_sha256_by_name")
                if not isinstance(per_tool_hashes, Mapping):
                    raise CanaryError("TASKS gateway stage has no per-tool schema map")
                if set(per_tool_hashes) != set(tool_names):
                    raise CanaryError(
                        "Gateway per-tool schema map does not match catalog"
                    )
                schema_hash = per_tool_hashes.get("TASKS")
                if not isinstance(schema_hash, str) or len(schema_hash) != 64:
                    raise CanaryError("TASKS gateway stage has no schema hash")
                tasks_schema_hashes.add(schema_hash)
            if harness == "eliza" and tool_names == ("HANDLE_RESPONSE",):
                expected_response_hash = (
                    LIFECYCLE_STAGE1_GATEWAY_SCHEMA_SHA256
                    if index == 0
                    else LIFECYCLE_EVALUATOR_GATEWAY_SCHEMA_SHA256
                )
                per_tool_hashes = record.get("tool_schema_sha256_by_name")
                if per_tool_hashes != {"HANDLE_RESPONSE": expected_response_hash}:
                    raise CanaryError(
                        f"eliza stage {index} HANDLE_RESPONSE schema drifted"
                    )
    external_first_stage_hashes_by_harness = {
        harness: {
            field: grouped[harness][0][field]
            for field in ("request_sha256", "prompt_sha256", "system_prompt_sha256")
        }
        for harness in ("hermes", "openclaw")
    }
    if len(tasks_schema_hashes) != 1:
        raise CanaryError("Harnesses did not advertise one identical TASKS schema")
    observed_tasks_schema_hash = next(iter(tasks_schema_hashes))
    if observed_tasks_schema_hash != EXPECTED_TASKS_GATEWAY_SCHEMA_SHA256:
        raise CanaryError("Gateway TASKS schema does not match the reviewed contract")
    summary.update(
        {
            "validation_status": "succeeded",
            "request_ids_unique": True,
            "reasoning_effort": CANARY_REASONING_EFFORT,
            "reasoning_effort_parity": True,
            "tasks_gateway_schema_sha256": observed_tasks_schema_hash,
            "external_first_stage_hashes_by_harness": (
                external_first_stage_hashes_by_harness
            ),
            "lifecycle_execution_contracts": lifecycle_contracts,
        }
    )
    return summary


def _validate_gateway_audit(
    plan: CanaryPlan,
    audit_path: Path,
) -> tuple[dict[str, object], dict[str, object]]:
    records = _load_gateway_records(audit_path, require_durable=True)
    stage_summary = validate_gateway_stages(
        records,
        workspace_root=plan.workspace_root,
        public_prompt=plan.prompt,
    )
    lane_summaries: dict[str, object] = {}
    for harness in HARNESSES:
        summary = summarize_subscription_gateway_audit(audit_path, harness=harness)
        _validate_gateway_lane_summary(plan, harness, summary)
        lane_summaries[harness] = summary
    return lane_summaries, stage_summary


def _validate_gateway_lane_summary(
    plan: CanaryPlan,
    harness: str,
    summary: Mapping[str, object],
) -> None:
    """Apply the strict gateway contract to one lane independently."""

    reason = subscription_gateway_quarantine_reason(
        agent=harness,
        provider="claude-subscription",
        model=plan.model,
        provenance=summary,
        minimum_request_count=EXPECTED_GATEWAY_REQUESTS[harness],
    )
    if reason is not None:
        raise CanaryError(f"{harness} gateway provenance rejected: {reason}")
    if summary.get("audit_records") != EXPECTED_GATEWAY_REQUESTS[harness]:
        raise CanaryError(f"{harness} gateway audit permits an extra request")
    artifact_reason = validate_subscription_gateway_audit_artifact(summary)
    if artifact_reason is not None:
        raise CanaryError(
            f"{harness} gateway audit artifact rejected: {artifact_reason}"
        )


def _validation_evidence(
    *,
    status: str,
    error: BaseException | None = None,
    worker_phase: object | None = None,
) -> dict[str, object]:
    """Describe evidence validation without granting publication eligibility."""

    payload: dict[str, object] = {
        "status": status,
        "publication_eligible": False,
        "error": (f"{type(error).__name__}: {error}" if error is not None else None),
    }
    if worker_phase is not None:
        payload["worker_phase"] = worker_phase
    return payload


def run_live_canary(plan: CanaryPlan) -> Path:
    """Execute the explicit live mode without entering any publication code path."""

    initial_storage_preflight = check_canary_storage(plan)
    plan.output_root.mkdir(parents=True, exist_ok=True)
    with campaign_execution_lock(plan.output_root):
        locked_storage_preflight = check_canary_storage(plan)
        before = publication_snapshot(plan.workspace_root)
        plan.artifact_root.mkdir(parents=True, exist_ok=False)
        plan.artifact_root.chmod(0o700)
        manifest_path = plan.artifact_root / "manifest.json"
        _private_json(
            manifest_path,
            {
                **plan.public_payload(),
                "status": "running",
                "started_at": datetime.now(UTC).isoformat(),
                "storage_preflight": {
                    "before_allocation": initial_storage_preflight,
                    "after_campaign_lock": locked_storage_preflight,
                },
            },
        )
        gateway: ClaudeSubscriptionGatewayProcess | None = None
        failure: Exception | None = None
        worker_results: dict[str, dict[str, object]] = {}
        runtime_summaries: dict[str, object] = {}
        runtime_validations: dict[str, object] = {}
        gateway_summaries: dict[str, object] = {}
        gateway_validations: dict[str, object] = {}
        stage_summary: dict[str, object] = {}
        lane_partial_evidence: dict[str, object] = {}
        audit_path: Path | None = None
        gateway_pause: GatewayPauseState | None = None
        checkpoint_cleanup_status = "preserved"
        try:
            gateway = start_claude_subscription_gateway(
                workspace_root=plan.workspace_root,
                run_group_id=plan.run_group_id,
                harnesses=HARNESSES,
                benchmark_namespace=plan.execution_namespace,
                replay_file=plan.replay_file,
                hmac_key_file=plan.hmac_key_file,
                storage_root=plan.workspace_root,
                minimum_free_bytes=plan.minimum_free_bytes,
                content_attestation_contract=(
                    build_lifecycle_gateway_content_contract(
                        plan.workspace_root,
                        public_user_turns=[plan.prompt],
                        contract_id=CANARY_CONTENT_CONTRACT_ID,
                    )
                ),
            )
            worker_results = _run_workers(plan, gateway)
        except CanaryWorkerError as error:
            # error-policy:J1 retain every lane's terminal status in the failed artifact.
            worker_results = error.worker_results
            failure = error
        except Exception as error:
            # error-policy:J1 the supervisor converts one live run into one failed artifact.
            failure = error
        finally:
            if gateway is not None:
                try:
                    audit_path = gateway.close()
                except Exception as error:
                    # error-policy:J1 gateway teardown is part of the evidence boundary.
                    if failure is None:
                        failure = error

        evidence_failures: list[str] = []
        for harness in HARNESSES:
            worker_phase = worker_results.get(harness, {}).get("phase", "not_started")
            try:
                partial_response = _preserve_partial_lane_response(plan, harness)
            except Exception as error:
                # error-policy:J1 the supervisor records failed evidence preservation.
                partial_response = _validation_evidence(
                    status="preservation_failed",
                    error=error,
                    worker_phase=worker_phase,
                )
                evidence_failures.append(f"{harness}:partial-response")
            try:
                transcript_inventory = _lane_transcript_inventory(plan, harness)
            except Exception as error:
                # error-policy:J1 unreadable scoped evidence cannot be called preserved.
                transcript_inventory = _validation_evidence(
                    status="inventory_failed",
                    error=error,
                    worker_phase=worker_phase,
                )
                evidence_failures.append(f"{harness}:transcript-inventory")
            lane_partial_evidence[harness] = {
                "response": partial_response,
                "transcripts": transcript_inventory,
                "publication_eligible": False,
            }

            telemetry_path = plan.artifact_root / harness / "telemetry.jsonl"
            summary = summarize_runtime_provenance(telemetry_path)
            runtime_summaries[harness] = summary
            try:
                validated_summary = _validate_lane_artifacts(plan, harness)
                if worker_phase != "complete":
                    raise CanaryError(
                        f"{harness} worker did not complete despite artifact evidence"
                    )
            except Exception as error:
                # error-policy:J1 each lane retains its own failed validation status.
                summary["canary_validation_status"] = "failed"
                summary["canary_worker_phase"] = worker_phase
                summary["canary_publication_eligible"] = False
                runtime_validations[harness] = _validation_evidence(
                    status="failed",
                    error=error,
                    worker_phase=worker_phase,
                )
                evidence_failures.append(f"{harness}:runtime")
            else:
                validated_summary["canary_validation_status"] = "succeeded"
                validated_summary["canary_worker_phase"] = worker_phase
                validated_summary["canary_publication_eligible"] = False
                runtime_summaries[harness] = validated_summary
                runtime_validations[harness] = _validation_evidence(
                    status="succeeded",
                    worker_phase=worker_phase,
                )

        expected_audit_path = (
            audit_path
            if audit_path is not None
            else plan.artifact_root / "subscription-gateway" / "audit.jsonl"
        )
        if expected_audit_path.is_file():
            try:
                gateway_pause = read_gateway_pause_state(expected_audit_path)
            except Exception as error:
                # error-policy:J1 pause recovery is part of the durable gateway
                # boundary; malformed state cannot silently become a normal failure.
                evidence_failures.append("gateway:pause-state")
                if failure is None:
                    failure = error
        for harness in HARNESSES:
            summary = summarize_subscription_gateway_audit(
                expected_audit_path,
                harness=harness,
            )
            gateway_summaries[harness] = summary
            try:
                _validate_gateway_lane_summary(plan, harness, summary)
            except Exception as error:
                # error-policy:J1 gateway lanes are reduced independently on failure.
                summary["canary_validation_status"] = "failed"
                summary["canary_publication_eligible"] = False
                gateway_validations[harness] = _validation_evidence(
                    status="failed",
                    error=error,
                )
                evidence_failures.append(f"{harness}:gateway")
            else:
                summary["canary_validation_status"] = "succeeded"
                summary["canary_publication_eligible"] = False
                gateway_validations[harness] = _validation_evidence(status="succeeded")

        try:
            gateway_records = _load_gateway_records(
                expected_audit_path,
                require_durable=True,
            )
        except Exception as error:
            # error-policy:J1 a missing/malformed audit remains explicit evidence.
            stage_summary = {
                "schema_version": 1,
                "validation_status": "unavailable",
                "publication_eligible": False,
                "records": 0,
                "records_by_harness": {harness: 0 for harness in HARNESSES},
                "stages": {harness: [] for harness in HARNESSES},
                "error": f"{type(error).__name__}: {error}",
            }
            evidence_failures.append("gateway:stages")
        else:
            stage_summary = _safe_gateway_stage_evidence(gateway_records)
            try:
                stage_summary = validate_gateway_stages(
                    gateway_records,
                    workspace_root=plan.workspace_root,
                    public_prompt=plan.prompt,
                )
            except Exception as error:
                # error-policy:J1 preserve partial metadata without calling it valid.
                stage_summary.update(
                    {
                        "validation_status": "failed",
                        "publication_eligible": False,
                        "error": f"{type(error).__name__}: {error}",
                    }
                )
                evidence_failures.append("gateway:stages")

        if failure is None and evidence_failures:
            failure = CanaryError(
                "Canary evidence validation failed: "
                + ", ".join(sorted(set(evidence_failures)))
            )

        after = publication_snapshot(plan.workspace_root)
        if before != after:
            publication_error = CanaryError(
                "Canary changed a production SQLite/latest/viewer target"
            )
            if failure is None:
                failure = publication_error
        if failure is None and gateway is not None:
            try:
                gateway.cleanup_private_checkpoint()
                checkpoint_cleanup_status = "removed_after_success"
            except Exception as error:
                # error-policy:J1 replay material is retained only for an
                # incomplete attempt; cleanup failure prevents a success claim.
                checkpoint_cleanup_status = "cleanup_failed"
                failure = error
        final_status = (
            gateway_pause.status.value
            if gateway_pause is not None
            else "failed" if failure is not None else "succeeded"
        )
        final_manifest: dict[str, object] = {
            **plan.public_payload(),
            "status": final_status,
            "finished_at": datetime.now(UTC).isoformat(),
            "worker_results": worker_results,
            "runtime_provenance": runtime_summaries,
            "runtime_provenance_validation": runtime_validations,
            "subscription_gateway_provenance": gateway_summaries,
            "subscription_gateway_provenance_validation": gateway_validations,
            "gateway_stage_provenance": stage_summary,
            "lane_partial_evidence": lane_partial_evidence,
            "publication_snapshot_before": before,
            "publication_snapshot_after": after,
            "publication_state_unchanged": before == after,
            "audit_path": str(audit_path) if audit_path is not None else None,
            "pause": (
                {
                    "status": gateway_pause.status.value,
                    "retry_at": gateway_pause.retry_at,
                    "reason": gateway_pause.pause_reason,
                    "affected_harnesses": list(gateway_pause.affected_harnesses),
                    "active_records": gateway_pause.active_records,
                }
                if gateway_pause is not None
                else None
            ),
            "checkpoint_cleanup_status": checkpoint_cleanup_status,
            "error": f"{type(failure).__name__}: {failure}" if failure else None,
        }
        _private_json(manifest_path, final_manifest)
        if failure is not None:
            raise CanaryError(
                f"Lifecycle canary failed; preserved evidence at {plan.artifact_root}"
            ) from failure
        return manifest_path


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Plan or explicitly run the no-publication lifecycle tri-canary."
    )
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument(
        "--live",
        action="store_true",
        help="Start the shared subscription gateway and spend exactly seven calls.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    plan = build_canary_plan(model=arguments.model)
    if not arguments.live:
        print(
            json.dumps(
                {
                    **plan.public_payload(),
                    "status": "dry-run",
                    "live_execution": False,
                    "next_command": (
                        "PYTHONPATH=packages /opt/miniconda3/bin/python -m "
                        "benchmarks.orchestrator_lifecycle.canary --model "
                        f"{plan.model} --live"
                    ),
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 0
    manifest = run_live_canary(plan)
    print(manifest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


__all__: Sequence[str] = (
    "CanaryError",
    "CanaryPlan",
    "CanaryStoragePreflightError",
    "build_canary_plan",
    "check_canary_storage",
    "main",
    "publication_snapshot",
    "run_live_canary",
    "validate_gateway_stages",
    "validate_lane_response",
)
