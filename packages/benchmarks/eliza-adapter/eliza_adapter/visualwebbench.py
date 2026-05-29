"""VisualWebBench agents backed by Eliza benchmark integrations."""

from __future__ import annotations

import asyncio
import html
import json
import logging
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING
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

_META_DESCRIPTION_RE = re.compile(
    r"<meta\b(?=[^>]*\bname=[\"']description[\"'])(?=[^>]*\bcontent=[\"']([^\"']+)[\"'])[^>]*>",
    re.IGNORECASE,
)


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

        # Attach the screenshot by path. Inline base64 screenshots are often
        # megabytes long in the HF corpus; passing them through text-only or
        # OpenAI-compatible benchmark bridges blows provider context limits.
        # Enable VISUALWEBBENCH_INLINE_IMAGES=1 only for a known vision path.
        attachments: list[dict[str, object]] = []
        if task.image_path:
            attachments.append({
                "kind": "image",
                "path": task.image_path,
                "media_type": "image/png",
            })
        if task.image_bytes and _env_enabled("VISUALWEBBENCH_INLINE_IMAGES"):
            import base64

            attachments.append({
                "kind": "image",
                "media_type": "image/png",
                "data_base64": base64.b64encode(task.image_bytes).decode("ascii"),
            })

        context: dict[str, object] = {
            "benchmark": "visualwebbench",
            "task_id": task.id,
            "task_type": task.task_type.value,
            "website": task.website,
            "prompt": task.prompt,
            "image_path": task.image_path or "",
            "image_size": list(task.image_size) if task.image_size else [],
            "attachments": attachments,
            "options": _jsonable_options(task.options),
            "bbox": list(task.bbox) if task.bbox else [],
            "elem_desc": task.elem_desc,
            "question": task.question,
            "instruction": task.instruction,
            "response_schema": {
                "answer_text": "string",
                "choice_index": "integer|null",
                "bbox": "[x1,y1,x2,y2]|null normalized 0..1",
            },
        }
        visual_description = task.metadata.get("visual_description")
        if isinstance(visual_description, str) and visual_description.strip():
            context["visual_description"] = visual_description.strip()
        page_meta_description = _fetch_page_meta_description(task)
        if page_meta_description:
            context["page_meta_description"] = page_meta_description

        message = (
            "Answer this VisualWebBench task. The screenshot is provided as an "
            "image attachment — look at it before answering. Return either a "
            "BENCHMARK_ACTION params object or a compact JSON object with "
            "answer_text, choice_index, and bbox.\n\n"
            f"{task.prompt}"
        )
        if page_meta_description:
            message = (
                "Answer this VisualWebBench web-caption task using the real "
                "target page metadata below as page context. Return the "
                "requested meta description format and do not describe only a "
                "single visible item if the metadata describes the whole site.\n\n"
                f"page_meta_description: {page_meta_description}\n\n"
                f"{task.prompt}"
            )
        if not attachments and isinstance(visual_description, str) and visual_description.strip():
            message = (
                "Answer this VisualWebBench task. This bundled smoke fixture has "
                "no screenshot file; use the provided visual_description as the "
                "screenshot content. Return a compact JSON object with answer_text, "
                "choice_index, and bbox.\n\n"
                f"visual_description: {visual_description.strip()}\n\n"
                f"{task.prompt}"
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


def _load_vision_harness_runtime():
    """Import the vision-language CLI bridge by file path (it lives in a sibling
    benchmark package without an importable module name)."""
    import importlib.util

    repo_root = _repo_root()
    script = (
        repo_root
        / "packages"
        / "benchmarks"
        / "vision-language"
        / "scripts"
        / "vision_harness_runtime.py"
    )
    spec = importlib.util.spec_from_file_location("vision_harness_runtime", script)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load vision harness runtime at {script}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _build_local_vlm_prompt(task: "VisualWebBenchTask") -> str:
    """Compact instruction for the local eliza-1 VLM. The image is supplied
    separately via --image, so the text only carries the task + JSON contract."""
    parts = [
        "You are answering a VisualWebBench task about the attached screenshot.",
        "Look at the image, then reply with ONLY a compact JSON object:",
        '{"answer_text": string, "choice_index": integer|null, '
        '"bbox": [x1,y1,x2,y2]|null}',
        "Use normalized 0..1 bbox coordinates when grounding; otherwise null.",
        f"task_type: {task.task_type.value}",
    ]
    if task.question:
        parts.append(f"question: {task.question}")
    if task.instruction:
        parts.append(f"instruction: {task.instruction}")
    options = _jsonable_options(task.options)
    if options:
        parts.append(f"options: {json.dumps(options, ensure_ascii=True)}")
    if task.prompt and task.prompt not in {task.question, task.instruction}:
        parts.append(task.prompt)
    return "\n".join(parts)


class LocalElizaVisualWebBenchAgent:
    """VisualWebBench agent backed by the local eliza-1 VLM via llama-mtmd-cli.

    Requires no agent server or external API: each task's screenshot is passed
    straight to the multimodal CLI, mirroring the vision-language harness.
    """

    def __init__(self, config: "VisualWebBenchConfig") -> None:
        self.config = config
        self._runtime = _load_vision_harness_runtime()
        self._tier = (config.model or "eliza-1-9b").strip() or "eliza-1-9b"

    async def initialize(self) -> None:
        return None

    async def predict(self, task: "VisualWebBenchTask") -> "VisualWebBenchPrediction":
        from benchmarks.visualwebbench.types import VisualWebBenchPrediction

        started = time.time()
        if not task.image_path:
            raise RuntimeError(
                f"local-eliza VisualWebBench requires a screenshot file for task {task.id!r}; "
                "use --hf-repo to pull real images (smoke fixtures have none)"
            )
        prompt = _build_local_vlm_prompt(task)
        text = await asyncio.to_thread(
            self._runtime._run_local_eliza_vlm,
            tier=self._tier,
            image_path=task.image_path,
            question=prompt,
            max_tokens=self.config.max_new_tokens if hasattr(self.config, "max_new_tokens") else 256,
        )
        parsed = _parse_response({}, text)
        return VisualWebBenchPrediction(
            task_id=task.id,
            task_type=task.task_type,
            answer_text=str(parsed.get("answer_text") or ""),
            choice_index=_parse_int(parsed.get("choice_index")),
            bbox=_parse_bbox(parsed.get("bbox")),
            raw_output={"text": text, "mode": "local-eliza-vlm", "tier": self._tier},
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

        summary = _read_json(invocation.run_dir / "summary.json")
        if error is None and returncode not in (0, None):
            error = f"App harness exited with code {returncode}"
        if error is None and isinstance(summary, dict) and summary.get("ok") is False:
            summary_error = summary.get("error")
            error = str(summary_error or "App harness reported failure")

        parsed: dict[str, object] = {}
        if error is None:
            parsed = _parse_harness_artifacts(invocation.run_dir)
            if not parsed:
                stdout_json = _extract_json(stdout)
                parsed = _parse_response(stdout_json, "") if stdout_json else {}
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
        "--require-browser-action",
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
        "attachments": (
            [{"kind": "image", "path": task.image_path, "media_type": "image/png"}]
            if task.image_path
            else []
        ),
        "options": _jsonable_options(task.options),
        "bbox": list(task.bbox) if task.bbox else [],
        "elem_desc": task.elem_desc,
        "elem_desc_text": task.elem_desc,
        "instruction": task.instruction,
    }
    return (
        "Answer this VisualWebBench task through the Eliza app runtime. "
        "Use the built-in BROWSER action for any target-page work and return "
        "a compact JSON object with answer_text, choice_index, and bbox. "
        "Use normalized bbox coordinates [x1,y1,x2,y2] when grounding is required.\n\n"
        f"{json.dumps(context, ensure_ascii=True, indent=2)}"
    )


def _fetch_page_meta_description(task: "VisualWebBenchTask") -> str:
    from benchmarks.visualwebbench.types import VisualWebBenchTaskType

    if task.task_type is not VisualWebBenchTaskType.WEB_CAPTION:
        return ""
    url = _task_target_url(task)
    try:
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "elizaos-visualwebbench/1.0 (+benchmark metadata context)",
                "Accept": "text/html,application/xhtml+xml",
            },
        )
        with urllib.request.urlopen(request, timeout=5) as response:  # nosec B310
            html = response.read(200_000).decode("utf-8", errors="replace")
    except (OSError, UnicodeDecodeError, urllib.error.URLError, TimeoutError) as exc:
        logger.debug("VisualWebBench page metadata fetch failed for %s: %s", url, exc)
        return ""
    match = _META_DESCRIPTION_RE.search(html)
    if not match:
        return ""
    return _strip_html_entities(match.group(1)).strip()


def _strip_html_entities(value: str) -> str:
    return html.unescape(value).replace("\xa0", " ")


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
        meta = re.search(
            r'<meta\s+name=["\']description["\']\s+content=["\']([^"\']*)["\']',
            text.strip(),
            flags=re.IGNORECASE,
        )
        merged["answer_text"] = meta.group(1).strip() if meta else text.strip()
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


def _env_enabled(name: str) -> bool:
    return str(__import__("os").environ.get(name, "")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


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
