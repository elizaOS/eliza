"""VisualWebBench agents backed by Eliza benchmark integrations."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from benchmarks.visualwebbench.types import (
        BBox,
        VisualWebBenchConfig,
        VisualWebBenchPrediction,
        VisualWebBenchTask,
    )

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AppHarnessInvocation:
    """Subprocess invocation for one browser-app harness task."""

    command: list[str]
    cwd: Path
    run_id: str
    run_dir: Path
    prompt: str
    target_url: str


class ElizaVisualWebBenchAgent:
    """VisualWebBench agent that routes prompts through the benchmark server."""

    def __init__(
        self,
        config: "VisualWebBenchConfig",
        client: ElizaClient | None = None,
    ) -> None:
        self.config = config
        self._client = client or ElizaClient()

    async def initialize(self) -> None:
        self._client.wait_until_ready(timeout=120)

    async def predict(self, task: "VisualWebBenchTask") -> "VisualWebBenchPrediction":
        from benchmarks.visualwebbench.types import VisualWebBenchPrediction

        started = time.time()
        self._client.reset(task_id=task.id, benchmark="visualwebbench")

        context: dict[str, object] = {
            "benchmark": "visualwebbench",
            "task_id": task.id,
            "task_type": task.task_type.value,
            "website": task.website,
            "prompt": task.prompt,
            "image_path": task.image_path or "",
            "image_size": list(task.image_size) if task.image_size else [],
            "options": _jsonable_options(task.options),
            "bbox": list(task.bbox) if task.bbox else [],
            "elem_desc": task.elem_desc,
            "response_schema": {
                "answer_text": "string",
                "choice_index": "integer|null",
                "bbox": "[x1,y1,x2,y2]|null normalized 0..1",
            },
        }

        message = (
            "Answer this VisualWebBench task. Return either BENCHMARK_ACTION params "
            "or a compact JSON object with answer_text, choice_index, and bbox.\n\n"
            f"Task type: {task.task_type.value}\n"
            f"Website: {task.website}\n"
            f"Question: {task.prompt}"
        )
        response = self._client.send_message(text=message, context=context)
        parsed = _parse_response(response.params, response.text)

        return VisualWebBenchPrediction(
            task_id=task.id,
            task_type=task.task_type,
            answer_text=str(parsed.get("answer_text") or ""),
            choice_index=_parse_int(parsed.get("choice_index")),
            bbox=_parse_bbox(parsed.get("bbox")),
            raw_output={
                "text": response.text,
                "thought": response.thought,
                "actions": response.actions,
                "params": response.params,
            },
            latency_ms=(time.time() - started) * 1000,
        )

    async def close(self) -> None:
        return None


class ElizaVisualWebBenchAppHarnessAgent:
    """VisualWebBench agent that invokes the browser-app harness per task.

    The harness is responsible for driving only the Eliza app surface. Target
    website interaction remains delegated to the agent through its BROWSER
    action, matching the guardrails in scripts/eliza-browser-app-harness.mjs.
    """

    def __init__(self, config: "VisualWebBenchConfig") -> None:
        self.config = config
        self.task_timeout_ms = config.timeout_ms + 30000

    async def initialize(self) -> None:
        return None

    async def predict(self, task: "VisualWebBenchTask") -> "VisualWebBenchPrediction":
        from benchmarks.visualwebbench.types import VisualWebBenchPrediction

        started = time.time()
        invocation = _build_app_harness_invocation(task, self.config)
        stdout = ""
        stderr = ""
        returncode: int | None = None
        error: str | None = None

        try:
            proc = await asyncio.create_subprocess_exec(
                *invocation.command,
                cwd=str(invocation.cwd),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    proc.communicate(),
                    timeout=(self.config.timeout_ms / 1000) + 30,
                )
            except asyncio.TimeoutError:
                proc.kill()
                stdout_bytes, stderr_bytes = await proc.communicate()
                error = "App harness subprocess timed out"
            stdout = stdout_bytes.decode("utf-8", errors="replace")
            stderr = stderr_bytes.decode("utf-8", errors="replace")
            returncode = proc.returncode
        except Exception as exc:  # noqa: BLE001
            error = str(exc)

        parsed = _parse_harness_artifacts(invocation.run_dir)
        if not parsed:
            stdout_json = _extract_json(stdout)
            parsed = _parse_response(stdout_json, "") if stdout_json else {}

        summary = _read_json(invocation.run_dir / "summary.json")
        if error is None and returncode not in (0, None):
            error = f"App harness exited with code {returncode}"
        if error is None and isinstance(summary, dict) and summary.get("ok") is False:
            summary_error = summary.get("error")
            error = str(summary_error or "App harness reported failure")
        if (
            error is None
            and not any(key in parsed for key in ("answer_text", "choice_index", "bbox"))
        ):
            error = "App harness did not produce a VisualWebBench answer"

        return VisualWebBenchPrediction(
            task_id=task.id,
            task_type=task.task_type,
            answer_text=str(parsed.get("answer_text") or ""),
            choice_index=_parse_int(parsed.get("choice_index")),
            bbox=_parse_bbox(parsed.get("bbox")),
            raw_output={
                "mode": "eliza_app_harness",
                "command": invocation.command,
                "cwd": str(invocation.cwd),
                "stdout": stdout,
                "stderr": stderr,
                "returncode": returncode,
                "summary": summary,
                "traces": {
                    "harness_run_id": invocation.run_id,
                    "harness_run_dir": str(invocation.run_dir),
                    "artifact_paths": _collect_harness_artifacts(invocation.run_dir),
                    "run_plan_path": str(invocation.run_dir / "run-plan.json"),
                    "summary_path": str(invocation.run_dir / "summary.json"),
                },
            },
            latency_ms=(time.time() - started) * 1000,
            error=error,
        )

    async def close(self) -> None:
        return None


def _build_app_harness_invocation(
    task: "VisualWebBenchTask",
    config: "VisualWebBenchConfig",
    *,
    run_id: str | None = None,
) -> AppHarnessInvocation:
    repo_root = _repo_root()
    script = Path(config.app_harness_script) if config.app_harness_script else _default_harness_script()
    script = script.resolve()
    resolved_run_id = run_id or _make_harness_run_id(task.id)
    run_dir = repo_root / "tmp" / "eliza-browser-harness" / resolved_run_id
    target_url = _task_target_url(task)
    prompt = _build_app_harness_prompt(task)

    command = [
        _config_text(config.app_harness_runtime, "bun"),
        str(script),
    ]
    if config.app_harness_dry_run:
        command.append("--dry-run")
    if config.app_harness_no_launch:
        command.append("--no-launch")
    if config.app_harness_prompt_via_ui:
        command.append("--prompt-via-ui")
    else:
        command.append("--prompt-via-api")
    command.extend([
        "--require-browser-tab",
        "--require-browser-events",
        "--require-trajectory",
        "--prompt",
        prompt,
        "--target-url",
        target_url,
        "--timeout",
        str(max(1000, config.timeout_ms)),
        "--run-id",
        resolved_run_id,
    ])
    if config.app_harness_api_base:
        command.extend(["--api-base", config.app_harness_api_base])
    if config.app_harness_ui_url:
        command.extend(["--ui-url", config.app_harness_ui_url])
    if config.app_harness_poll_interval_ms:
        command.extend(["--poll-interval", str(max(1, config.app_harness_poll_interval_ms))])

    return AppHarnessInvocation(
        command=command,
        cwd=repo_root,
        run_id=resolved_run_id,
        run_dir=run_dir,
        prompt=prompt,
        target_url=target_url,
    )


def _build_app_harness_prompt(task: "VisualWebBenchTask") -> str:
    context = {
        "benchmark": "visualwebbench",
        "task_id": task.id,
        "task_type": task.task_type.value,
        "website": task.website,
        "question": task.prompt,
        "image_path": task.image_path or "",
        "image_size": list(task.image_size) if task.image_size else [],
        "options": _jsonable_options(task.options),
        "bbox": list(task.bbox) if task.bbox else [],
        "elem_desc": task.elem_desc,
    }
    return (
        "Answer this VisualWebBench task through the Eliza app runtime. "
        "Use the built-in BROWSER action for any target-page work and return "
        "a compact JSON object with answer_text, choice_index, and bbox. "
        "Use normalized bbox coordinates [x1,y1,x2,y2] when grounding is required.\n\n"
        f"{json.dumps(context, ensure_ascii=True, indent=2)}"
    )


def _parse_harness_artifacts(run_dir: Path) -> dict[str, object]:
    for name in (
        "conversation-prompt-response.json",
        "poll-latest.json",
        "final-trajectories.json",
        "summary.json",
    ):
        payload = _read_json(run_dir / name)
        parsed = _find_answer_payload(payload)
        if parsed:
            return parsed
    return {}


def _find_answer_payload(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        if any(key in value for key in ("answer_text", "choice_index", "bbox")):
            return dict(value)
        for key in ("BENCHMARK_ACTION", "VISUALWEBBENCH_ANSWER", "visualwebbench", "params"):
            nested = value.get(key)
            parsed = _find_answer_payload(nested)
            if parsed:
                return parsed
        for nested in value.values():
            parsed = _find_answer_payload(nested)
            if parsed:
                return parsed
    elif isinstance(value, list):
        for item in value:
            parsed = _find_answer_payload(item)
            if parsed:
                return parsed
    elif isinstance(value, str):
        parsed_json = _extract_json(value)
        if parsed_json:
            return _parse_response(parsed_json, "")
    return {}


def _collect_harness_artifacts(run_dir: Path) -> list[str]:
    if not run_dir.exists():
        return []
    return sorted(str(path) for path in run_dir.rglob("*") if path.is_file())


def _read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _repo_root() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "scripts" / "eliza-browser-app-harness.mjs").exists():
            return parent
    return current.parents[4]


def _default_harness_script() -> Path:
    return _repo_root() / "scripts" / "eliza-browser-app-harness.mjs"


def _make_harness_run_id(task_id: str) -> str:
    millis = int(time.time() * 1000)
    return f"visualwebbench-{_safe_id(task_id)}-{millis}"


def _safe_id(value: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in value)
    return safe.strip("-") or "task"


def _task_target_url(task: "VisualWebBenchTask") -> str:
    raw = (task.website or "").strip() or "https://example.com/"
    parsed = urlparse(raw)
    if not parsed.scheme:
        raw = f"https://{raw}"
    return raw


def _config_text(value: str | None, default: str) -> str:
    text = (value or "").strip()
    return text or default


def _parse_response(params: dict[str, object], text: str) -> dict[str, object]:
    merged: dict[str, object] = dict(params)
    for key in ("BENCHMARK_ACTION", "VISUALWEBBENCH_ANSWER", "visualwebbench"):
        nested = merged.get(key)
        if isinstance(nested, dict):
            merged.update(nested)

    if any(k in merged for k in ("answer_text", "choice_index", "bbox")):
        return merged

    json_obj = _extract_json(text)
    if json_obj:
        merged.update(json_obj)
    elif text:
        merged["answer_text"] = text.strip()
    return merged


def _extract_json(text: str) -> dict[str, object]:
    stripped = text.strip()
    candidates = [stripped]
    match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
    if match:
        candidates.append(match.group(0))
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return {}


def _parse_int(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _parse_bbox(value: object) -> "BBox | None":
    if isinstance(value, str):
        parts = re.split(r"[\s,]+", value.strip().strip("[]()"))
        value = [p for p in parts if p]
    if isinstance(value, list | tuple) and len(value) >= 4:
        try:
            return (float(value[0]), float(value[1]), float(value[2]), float(value[3]))
        except (TypeError, ValueError):
            return None
    return None


def _jsonable_options(options: object) -> list[object]:
    if not isinstance(options, list):
        return []
    out: list[object] = []
    for option in options:
        if isinstance(option, tuple):
            out.append(list(option))
        else:
            out.append(option)
    return out
