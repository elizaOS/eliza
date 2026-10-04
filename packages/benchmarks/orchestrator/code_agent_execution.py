"""Coding-agent cell execution, artifact ingestion, and redacted process logs."""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .analyze_trajectory import summarize as summarize_trajectory

DEFAULT_MODEL = "gemma-4-31b"


SECRET_ENV_RE = re.compile(
    r"(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTH|BEARER|SESSION|COOKIE)",
    re.IGNORECASE,
)

SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)(api[_-]?key|token|secret|password|authorization|bearer)([=:]\s*)([^\s'\"`]+)"
)

LONG_SECRET_RE = re.compile(r"\b(?:sk|sess|pk|org|key|tok|eyJ)[A-Za-z0-9_\-]{16,}\b")


@dataclass(frozen=True)
class MatrixCell:
    benchmark: str
    adapter: str
    command: list[str]
    cwd: str
    output_dir: str
    trajectory_dir: str
    env_overrides: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class CellResult:
    benchmark: str
    adapter: str
    status: str
    exit_code: int | None
    duration_seconds: float
    output_dir: str
    stdout_path: str
    stderr_path: str
    result_path: str | None
    failure_class: str
    command_path: str | None = None
    notes: list[str] = field(default_factory=list)
    score: float | None = None
    outcome_metrics: dict[str, int | float | None] = field(default_factory=dict)
    token_metrics: dict[str, int | float | None] = field(default_factory=dict)
    resumed: bool = False


def workspace_root() -> Path:
    return Path(__file__).resolve().parents[1]


def benchmarks_root(root: Path) -> Path:
    return root / "suites"


def _safe_pythonpath(root: Path) -> str:
    b_root = benchmarks_root(root)
    paths = [
        root.parent,
        b_root / "terminal-bench",
        b_root / "webshop",
        b_root / "OSWorld",
        b_root.parent / "harnesses" / "eliza",
        b_root.parent / "harnesses" / "hermes",
        b_root.parent / "harnesses" / "openclaw",
    ]
    existing = os.environ.get("PYTHONPATH", "")
    values = [str(path) for path in paths if path.exists()]
    if existing:
        values.append(existing)
    return os.pathsep.join(values)


def child_env(cell: MatrixCell) -> dict[str, str]:
    env = dict(os.environ)
    env.update(cell.env_overrides)
    root = workspace_root()
    env["PYTHONPATH"] = _safe_pythonpath(root)
    env.setdefault("PYTHONUNBUFFERED", "1")
    model = env.get("BENCHMARK_MODEL_NAME", DEFAULT_MODEL)
    for key in (
        "OPENAI_LARGE_MODEL",
        "OPENAI_SMALL_MODEL",
        "CEREBRAS_MODEL",
        "CEREBRAS_LARGE_MODEL",
        "CEREBRAS_SMALL_MODEL",
    ):
        env.setdefault(key, model)
    opencode_shim = root / "plugins" / "plugin-agent-orchestrator" / "bin" / "opencode"
    if opencode_shim.exists():
        env.setdefault("OPENCODE_BIN", str(opencode_shim))
    return env


def _cell_root(cell: MatrixCell) -> Path:
    return Path(cell.output_dir).parent


_RESULT_PATTERNS = {
    "swe_bench": ("orchestrated-*.json", "swe-bench-*.json"),
    "swe_bench_multilingual": ("orchestrated-*.json", "swe-bench-*.json"),
    "terminal_bench": ("terminal-bench-*.json", "**/summary/results.json"),
    "mind2web": ("mind2web-results.json",),
    "visualwebbench": ("visualwebbench-results.json",),
    "webshop": ("webshop-results.json",),
    "osworld": ("osworld-eliza-results-*.json", "**/summary/results.json"),
    "nl2repo": ("result.json",),
    "standard_humaneval": ("result.json",),
    "agentbench": ("agentbench-matrix-results.json",),
    "mint": ("mint-code-agent-results.json",),
    "vision_language": ("vision-language-results.json",),
}


def find_latest_result(output_dir: Path, benchmark: str | None = None) -> Path | None:
    patterns = (
        _RESULT_PATTERNS.get(benchmark, ())
        if benchmark
        else tuple(
            pattern for patterns in _RESULT_PATTERNS.values() for pattern in patterns
        )
    )
    matches: list[Path] = []
    for pattern in patterns:
        matches.extend(p for p in output_dir.glob(pattern) if p.is_file())
    matches = [p for p in matches if p.name not in {"cell-result.json", "command.json"}]
    if not matches:
        return None
    return max(matches, key=lambda p: p.stat().st_mtime)


def read_json(path: Path | None) -> Any:
    if path is None or not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def _text_has(text: str, *needles: str) -> bool:
    lowered = text.lower()
    return any(needle in lowered for needle in needles)


def _collect_result_items(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    candidates: list[Any] = []
    if isinstance(payload.get("results"), list):
        candidates.append(payload["results"])
    orchestrated = payload.get("orchestrated")
    if isinstance(orchestrated, dict):
        for provider_payload in orchestrated.values():
            if isinstance(provider_payload, dict) and isinstance(
                provider_payload.get("results"), list
            ):
                candidates.append(provider_payload["results"])
    items: list[dict[str, Any]] = []
    for candidate in candidates:
        for item in candidate:
            if isinstance(item, dict):
                items.append(item)
    return items


def classify_failure(
    *,
    exit_code: int | None,
    result_payload: Any,
    stdout: str,
    stderr: str,
) -> tuple[str, list[str]]:
    notes: list[str] = []
    combined = f"{stdout}\n{stderr}"
    score = score_from_payload(result_payload)
    if exit_code == 0 and score is not None and score >= 1.0:
        return "pass", notes
    outcome = collect_outcome_metrics(result_payload)
    accuracy = outcome.get("accuracy")
    if exit_code == 0 and isinstance(accuracy, (int, float)) and accuracy >= 1.0:
        return "pass", notes

    items = _collect_result_items(result_payload)
    statuses = " ".join(
        str(item.get("patch_status") or item.get("status") or "") for item in items
    ).lower()
    errors = " ".join(
        str(item.get("error") or item.get("error_message") or "") for item in items
    ).lower()
    if (
        "not_generated" in statuses
        or "not generated" in statuses
        or _text_has(errors, "no patch", "did not contain an applicable unified diff")
    ):
        notes.append("no generated patch reported")
        return "no_patch", notes
    if _text_has(
        errors,
        "harness did not produce a report.json",
        "swe-bench harness evaluation failed",
    ):
        notes.append("harness report failure reported")
        return "harness_error", notes
    if "apply_failed" in statuses or _text_has(
        errors, "git apply", "patch does not apply", "apply failed", "patch failed"
    ):
        notes.append("patch apply failure reported")
        return "patch_apply_failed", notes

    has_item_failure = any(item.get("success") is False for item in items) or _text_has(
        statuses, "failed"
    )
    total = outcome.get("total")
    wrong = outcome.get("wrong")
    has_partial_outcome = exit_code == 0 and (
        (isinstance(accuracy, (int, float)) and accuracy < 1.0)
        or (isinstance(wrong, (int, float)) and wrong > 0)
        or (
            isinstance(total, (int, float))
            and total > 0
            and isinstance(score, (int, float))
            and score < 1.0
        )
    )
    if exit_code == 0 and (has_item_failure or has_partial_outcome):
        notes.append("benchmark item failures reported")
        return "tests_failed", notes

    if _text_has(
        combined,
        "unauthorized",
        "forbidden",
        "invalid api key",
        "missing api key",
        "authentication",
        "no provider registered",
        "provider not found",
        "quota",
        "rate limit",
    ):
        notes.append("provider authentication/routing text found in logs")
        return "auth_or_provider", notes

    if exit_code == 124 or _text_has(
        combined, "timed out", "timeout after", "timeout expired"
    ):
        notes.append("timeout marker found")
        return "timeout", notes

    if exit_code == 127 or _text_has(
        combined,
        "command not found",
        "executable not found",
        "no such file or directory",
    ):
        notes.append("missing executable marker found")
        return "missing_cli", notes

    if isinstance(result_payload, dict):
        error_text = str(result_payload.get("error") or "")
        if error_text and _text_has(
            error_text, "missing required capabilities", "no provider registered"
        ):
            return "auth_or_provider", [error_text]
        matrix = result_payload.get("matrix")
        if (
            isinstance(matrix, dict)
            and matrix.get("strict_capabilities")
            and error_text
        ):
            return "auth_or_provider", [error_text]

    if any(item.get("success") is False for item in items) or _text_has(
        statuses, "failed"
    ):
        notes.append("benchmark item failures reported")
        return "tests_failed", notes

    if exit_code not in (0, None):
        notes.append(f"nonzero exit code {exit_code}")
        return "harness_error", notes

    if result_payload is None:
        return "stopped_early", ["no result JSON found"]

    return "unknown_failure", notes


def score_from_payload(payload: Any) -> float | None:
    if not isinstance(payload, dict):
        return None
    metrics = payload.get("metrics")
    if isinstance(metrics, dict):
        for key in ("overall_score", "accuracy", "score"):
            value = metrics.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return float(value)
    summary = payload.get("summary")
    if isinstance(summary, dict):
        for key in ("resolve_rate", "accuracy", "score"):
            value = summary.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return float(value)
    for key in ("accuracy", "resolve_rate", "score"):
        value = payload.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return None


def _metric_number(payload: dict[str, Any], *keys: str) -> int | float | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return value
    return None


def collect_outcome_metrics(payload: Any) -> dict[str, int | float | None]:
    metrics: dict[str, int | float | None] = {
        "right": None,
        "wrong": None,
        "total": None,
        "accuracy": None,
    }
    if isinstance(payload, list):
        scores = [
            item.get("score")
            for item in payload
            if isinstance(item, dict)
            and isinstance(item.get("score"), (int, float))
            and not isinstance(item.get("score"), bool)
        ]
        if scores:
            right = sum(float(score) for score in scores)
            total = len(scores)
            metrics.update(
                {
                    "right": right,
                    "wrong": total - right,
                    "total": total,
                    "accuracy": right / total,
                }
            )
        return metrics
    if not isinstance(payload, dict):
        return metrics

    metrics_payload = payload.get("metrics")
    if isinstance(metrics_payload, dict):
        accuracy = _metric_number(
            metrics_payload,
            "overall_score",
            "accuracy",
            "score",
            "success_rate",
        )
        if accuracy is not None:
            metrics["accuracy"] = accuracy

    summary = payload.get("summary")
    if isinstance(summary, dict):
        total = _metric_number(
            summary, "total_instances", "total_tasks", "total", "sample_count"
        )
        right = _metric_number(
            summary, "resolved", "passed_tasks", "passed", "successes"
        )
        wrong = _metric_number(
            summary, "unresolved", "failed_tasks", "failed", "failures"
        )
        accuracy = _metric_number(summary, "resolve_rate", "accuracy", "score")
        if (
            total is not None
            or right is not None
            or wrong is not None
            or accuracy is not None
        ):
            metrics.update(
                {
                    "right": right,
                    "wrong": wrong,
                    "total": total,
                    "accuracy": accuracy
                    if accuracy is not None
                    else metrics.get("accuracy"),
                }
            )
            return _complete_outcome_metrics(metrics)

    total = _metric_number(
        payload,
        "total_tasks",
        "total_trials",
        "total_instances",
        "total",
        "sample_count",
    )
    right = _metric_number(payload, "passed_tasks", "successes", "resolved", "passed")
    wrong = _metric_number(payload, "failed_tasks", "failures", "unresolved", "failed")
    accuracy = _metric_number(
        payload,
        "overall_accuracy",
        "success_rate",
        "overall_task_success_rate",
        "overall_step_accuracy",
        "average_reward",
        "mean_reward",
        "accuracy",
        "resolve_rate",
        "score",
    )
    if (
        total is not None
        or right is not None
        or wrong is not None
        or accuracy is not None
    ):
        metrics.update(
            {
                "right": right,
                "wrong": wrong,
                "total": total,
                "accuracy": accuracy
                if accuracy is not None
                else metrics.get("accuracy"),
            }
        )
        return _complete_outcome_metrics(metrics)

    items = _collect_result_items(payload)
    if items:
        right_count = 0
        wrong_count = 0
        scored = 0
        for item in items:
            score = _metric_number(item, "score", "reward", "accuracy")
            if score is not None:
                bounded_score = max(0.0, min(1.0, float(score)))
                scored += 1
                right_count += bounded_score
                wrong_count += 1.0 - bounded_score
                continue
            success = item.get("success")
            if isinstance(success, bool):
                scored += 1
                if success:
                    right_count += 1
                else:
                    wrong_count += 1
                continue
        if scored:
            metrics.update(
                {
                    "right": right_count,
                    "wrong": wrong_count,
                    "total": scored,
                    "accuracy": right_count / scored,
                }
            )
    return _complete_outcome_metrics(metrics)


def _complete_outcome_metrics(
    metrics: dict[str, int | float | None],
) -> dict[str, int | float | None]:
    right = metrics.get("right")
    wrong = metrics.get("wrong")
    total = metrics.get("total")
    accuracy = metrics.get("accuracy")
    if (
        total is None
        and isinstance(right, (int, float))
        and isinstance(wrong, (int, float))
    ):
        total = int(right + wrong)
        metrics["total"] = total
    if (
        wrong is None
        and isinstance(total, (int, float))
        and isinstance(right, (int, float))
    ):
        metrics["wrong"] = int(total - right)
    if (
        right is None
        and isinstance(total, (int, float))
        and isinstance(wrong, (int, float))
    ):
        metrics["right"] = int(total - wrong)
    if (
        accuracy is None
        and isinstance(total, (int, float))
        and total > 0
        and isinstance(right, (int, float))
    ):
        metrics["accuracy"] = float(right) / float(total)
    if (
        right is None
        and isinstance(total, (int, float))
        and isinstance(accuracy, (int, float))
    ):
        metrics["right"] = float(total) * float(accuracy)
    if (
        wrong is None
        and isinstance(total, (int, float))
        and isinstance(metrics.get("right"), (int, float))
    ):
        metrics["wrong"] = float(total) - float(metrics["right"])
    return metrics


def collect_token_metrics(trajectory_dir: Path) -> dict[str, int | float | None]:
    summary, _records = summarize_trajectory(trajectory_dir)
    cached_percent: float | None = None
    if summary.prompt_tokens:
        cached_percent = (summary.cached_tokens / summary.prompt_tokens) * 100.0
    return {
        "input_tokens": summary.prompt_tokens,
        "output_tokens": summary.completion_tokens,
        "total_tokens": summary.total_tokens,
        "cached_tokens": summary.cached_tokens,
        "cache_creation_tokens": summary.cache_creation_tokens,
        "cached_token_percent": cached_percent,
        "llm_call_count": summary.llm_call_count,
        "trajectory_turn_count": summary.turns,
        "trajectory_file_count": summary.files,
    }


def collect_payload_token_metrics(payload: Any) -> dict[str, int | float | None]:
    if not isinstance(payload, dict):
        return {}
    source = payload.get("token_metrics")
    if not isinstance(source, dict):
        source = (
            payload.get("summary")
            if isinstance(payload.get("summary"), dict)
            else payload
        )
    if not isinstance(source, dict):
        return {}
    input_tokens = _metric_number(
        source, "input_tokens", "prompt_tokens", "promptTokens", "input"
    )
    output_tokens = _metric_number(
        source,
        "output_tokens",
        "completion_tokens",
        "completionTokens",
        "output",
    )
    total_tokens = _metric_number(source, "total_tokens", "totalTokens", "total")
    cached_tokens = _metric_number(
        source,
        "cached_tokens",
        "cache_read_input_tokens",
        "cacheReadInputTokens",
        "cachedTokens",
    )
    cache_creation_tokens = _metric_number(
        source,
        "cache_creation_tokens",
        "cache_creation_input_tokens",
        "cacheCreationInputTokens",
    )
    llm_call_count = _metric_number(source, "llm_call_count", "llmCallCount")
    if not any(
        isinstance(value, (int, float)) and not isinstance(value, bool)
        for value in (
            input_tokens,
            output_tokens,
            total_tokens,
            cached_tokens,
            cache_creation_tokens,
            llm_call_count,
        )
    ):
        return {}
    if (
        total_tokens is None
        and isinstance(input_tokens, (int, float))
        and isinstance(output_tokens, (int, float))
    ):
        total_tokens = input_tokens + output_tokens
    cached_percent = _metric_number(source, "cached_token_percent")
    if (
        cached_percent is None
        and isinstance(input_tokens, (int, float))
        and input_tokens
        and isinstance(cached_tokens, (int, float))
    ):
        cached_percent = cached_tokens / input_tokens * 100.0
    return {
        "input_tokens": input_tokens if input_tokens is not None else 0,
        "output_tokens": output_tokens if output_tokens is not None else 0,
        "total_tokens": total_tokens if total_tokens is not None else 0,
        "cached_tokens": cached_tokens if cached_tokens is not None else 0,
        "cache_creation_tokens": cache_creation_tokens
        if cache_creation_tokens is not None
        else 0,
        "cached_token_percent": cached_percent,
        "llm_call_count": llm_call_count if llm_call_count is not None else 0,
    }


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _secret_values(env: dict[str, str]) -> list[str]:
    values: list[str] = []
    for key, value in env.items():
        if value and len(value) >= 8 and SECRET_ENV_RE.search(key):
            values.append(value)
    return sorted(values, key=len, reverse=True)


def redact_text(text: str, env: dict[str, str]) -> str:
    redacted = text
    for value in _secret_values(env):
        redacted = redacted.replace(value, "[REDACTED]")
    redacted = SECRET_ASSIGNMENT_RE.sub(r"\1\2[REDACTED]", redacted)
    redacted = LONG_SECRET_RE.sub("[REDACTED]", redacted)
    return redacted


def _write_cell_metadata(cell: MatrixCell) -> None:
    cell_root = _cell_root(cell)
    cell_root.mkdir(parents=True, exist_ok=True)
    Path(cell.output_dir).mkdir(parents=True, exist_ok=True)
    Path(cell.trajectory_dir).mkdir(parents=True, exist_ok=True)
    redaction_env = dict(os.environ)
    redaction_env.update(cell.env_overrides)
    write_json(
        cell_root / "command.json",
        {
            "benchmark": cell.benchmark,
            "adapter": cell.adapter,
            "cwd": redact_text(cell.cwd, redaction_env),
            "command": [redact_text(part, redaction_env) for part in cell.command],
            "output_dir": cell.output_dir,
            "trajectory_dir": cell.trajectory_dir,
            "env_overrides": {
                key: redact_text(value, redaction_env)
                for key, value in cell.env_overrides.items()
            },
            "secret_policy": "real process env is inherited, metadata/logs redact secret-looking values",
        },
    )


def _redact_artifact_tree(root: Path, env: dict[str, str]) -> None:
    suffixes = {".json", ".jsonl", ".log", ".md", ".txt", ".out", ".err"}
    if not root.exists():
        return
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in suffixes:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        redacted = redact_text(text, env)
        if redacted != text:
            path.write_text(redacted, encoding="utf-8")


def _load_existing_result(cell: MatrixCell) -> CellResult | None:
    path = _cell_root(cell) / "cell-result.json"
    payload = read_json(path)
    if not isinstance(payload, dict):
        return None
    try:
        return CellResult(
            benchmark=str(payload["benchmark"]),
            adapter=str(payload["adapter"]),
            status=str(payload["status"]),
            exit_code=payload.get("exit_code"),
            duration_seconds=float(payload.get("duration_seconds") or 0.0),
            output_dir=str(payload["output_dir"]),
            stdout_path=str(payload["stdout_path"]),
            stderr_path=str(payload["stderr_path"]),
            result_path=payload.get("result_path"),
            command_path=payload.get("command_path")
            or str(_cell_root(cell) / "command.json"),
            failure_class=str(payload.get("failure_class") or "unknown_failure"),
            notes=list(payload.get("notes") or []),
            score=payload.get("score"),
            outcome_metrics=dict(payload.get("outcome_metrics") or {}),
            token_metrics=dict(payload.get("token_metrics") or {}),
            resumed=True,
        )
    except (KeyError, TypeError, ValueError):
        return None


def _result_from_cell_payload(
    *,
    cell: MatrixCell,
    status: str,
    exit_code: int | None,
    duration_seconds: float,
    stdout_path: Path,
    stderr_path: Path,
    result_path: Path | None,
    failure_class: str,
    notes: list[str],
    score: float | None,
    outcome_metrics: dict[str, int | float | None] | None = None,
    token_metrics: dict[str, int | float | None] | None = None,
    resumed: bool = False,
) -> CellResult:
    return CellResult(
        benchmark=cell.benchmark,
        adapter=cell.adapter,
        status=status,
        exit_code=exit_code,
        duration_seconds=duration_seconds,
        output_dir=cell.output_dir,
        stdout_path=str(stdout_path),
        stderr_path=str(stderr_path),
        result_path=str(result_path) if result_path else None,
        command_path=str(_cell_root(cell) / "command.json"),
        failure_class=failure_class,
        notes=notes,
        score=score,
        outcome_metrics=outcome_metrics or {},
        token_metrics=token_metrics or {},
        resumed=resumed,
    )


def run_cell(
    cell: MatrixCell,
    *,
    dry_run: bool,
    timeout_seconds: int,
    resume: bool = True,
    force: bool = False,
) -> CellResult:
    _write_cell_metadata(cell)
    cell_root = _cell_root(cell)
    stdout_path = cell_root / "stdout.log"
    stderr_path = cell_root / "stderr.log"

    if resume and not force:
        existing = _load_existing_result(cell)
        if existing is not None and existing.status in {
            "succeeded",
            "failed",
            "dry_run",
        }:
            return existing

    if dry_run:
        stdout_path.write_text("Dry run: command was not executed.\n", encoding="utf-8")
        stderr_path.write_text("", encoding="utf-8")
        result = _result_from_cell_payload(
            cell=cell,
            status="dry_run",
            exit_code=None,
            duration_seconds=0.0,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            result_path=None,
            failure_class="stopped_early",
            notes=["dry run only"],
            score=None,
            outcome_metrics=collect_outcome_metrics(None),
            token_metrics=collect_token_metrics(Path(cell.trajectory_dir)),
        )
        write_json(cell_root / "cell-result.json", asdict(result))
        return result

    env = child_env(cell)
    started = time.time()
    try:
        completed = subprocess.run(
            cell.command,
            cwd=cell.cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            check=False,
        )
        exit_code = completed.returncode
        stdout = completed.stdout
        stderr = completed.stderr
    except subprocess.TimeoutExpired as exc:
        exit_code = 124
        stdout = (
            exc.stdout.decode("utf-8", errors="replace")
            if isinstance(exc.stdout, bytes)
            else exc.stdout or ""
        )
        stderr = (
            exc.stderr.decode("utf-8", errors="replace")
            if isinstance(exc.stderr, bytes)
            else exc.stderr or ""
        )
        stderr += f"\nCommand timed out after {timeout_seconds}s\n"
    except OSError as exc:
        exit_code = 127
        stdout = ""
        stderr = f"Command execution failed: {exc}\n"

    duration = time.time() - started
    stdout_path.write_text(
        redact_text(stdout, env),
        encoding="utf-8",
    )
    stderr_path.write_text(
        redact_text(stderr, env),
        encoding="utf-8",
    )
    _redact_artifact_tree(cell_root, env)

    result_path = find_latest_result(Path(cell.output_dir), cell.benchmark)
    payload = read_json(result_path)
    failure_class, notes = classify_failure(
        exit_code=exit_code,
        result_payload=payload,
        stdout=stdout_path.read_text(encoding="utf-8", errors="replace"),
        stderr=stderr_path.read_text(encoding="utf-8", errors="replace"),
    )
    score = score_from_payload(payload)
    status = "succeeded" if exit_code == 0 and result_path is not None else "failed"
    outcome_metrics = collect_outcome_metrics(payload)
    token_metrics = collect_token_metrics(Path(cell.trajectory_dir))
    payload_token_metrics = collect_payload_token_metrics(payload)
    if (
        payload_token_metrics
        and not token_metrics.get("llm_call_count")
        and not token_metrics.get("total_tokens")
    ):
        token_metrics.update(payload_token_metrics)
    result = _result_from_cell_payload(
        cell=cell,
        status=status,
        exit_code=exit_code,
        duration_seconds=duration,
        stdout_path=stdout_path,
        stderr_path=stderr_path,
        result_path=result_path,
        failure_class=failure_class,
        notes=notes,
        score=score,
        outcome_metrics=outcome_metrics,
        token_metrics=token_metrics,
    )
    write_json(cell_root / "cell-result.json", asdict(result))
    return result
