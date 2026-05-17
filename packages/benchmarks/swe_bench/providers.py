"""Compatibility providers and parser helpers for SWE-bench orchestration."""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class ProviderResult:
    text: str
    values: dict[str, Any]
    data: dict[str, Any]


class SWEBenchProvider:
    name: str = ""
    position: int = 0
    private: bool = False

    async def get(self, _runtime: object, _message: object, _state: object) -> ProviderResult:
        return ProviderResult("", {}, {})


_current_instance: object | None = None


def set_current_instance(instance: object | None) -> None:
    global _current_instance
    _current_instance = instance


def get_current_instance() -> object | None:
    return _current_instance


class IssueProvider(SWEBenchProvider):
    name = "SWE_BENCH_ISSUE"
    position = 10

    async def get(self, _runtime: object, _message: object, _state: object) -> ProviderResult:
        inst = get_current_instance()
        if inst is None:
            return ProviderResult("", {}, {})
        text = (
            "# SWE-bench Issue\n"
            f"Instance: {inst.instance_id}\n"
            f"Repo: {inst.repo}\n"
            f"Base commit: {inst.base_commit}\n\n"
            f"{inst.problem_statement}\n\n"
            f"Hints: {inst.hints_text}"
        )
        return ProviderResult(
            text=text,
            values={"instance_id": inst.instance_id, "repo": inst.repo},
            data={"problem_statement": inst.problem_statement},
        )


class ToolsProvider(SWEBenchProvider):
    name = "SWE_BENCH_TOOLS"
    position = 20

    async def get(self, _runtime: object, _message: object, _state: object) -> ProviderResult:
        tools = ["SEARCH_CODE", "READ_FILE", "LIST_FILES", "EDIT_FILE", "SUBMIT"]
        return ProviderResult(
            text="Available SWE-bench tools: " + ", ".join(tools),
            values={"available_tools": tools},
            data={},
        )


class RepoStructureProvider(SWEBenchProvider):
    name = "SWE_BENCH_REPO_STRUCTURE"
    position = 30

    async def get(self, _runtime: object, _message: object, _state: object) -> ProviderResult:
        return ProviderResult("Repository structure should be inspected before editing.", {}, {})


class StrategyProvider(SWEBenchProvider):
    name = "SWE_BENCH_STRATEGY"
    position = 40

    async def get(self, _runtime: object, _message: object, _state: object) -> ProviderResult:
        return ProviderResult(
            "Understand the issue. Locate relevant files. Analyze root cause. Fix narrowly. Submit a diff.",
            {},
            {},
        )


class SWEBenchActionResultsProvider(SWEBenchProvider):
    name = "SWE_BENCH_ACTION_RESULTS"
    position = 50
    _results: list[dict[str, str]] = []

    @classmethod
    def add_result(cls, action: str, result: str) -> None:
        cls._results.append({"action": action, "result": result})
        cls._results = cls._results[-5:]

    @classmethod
    def clear_results(cls) -> None:
        cls._results = []

    async def get(self, _runtime: object, _message: object, _state: object) -> ProviderResult:
        if not self._results:
            return ProviderResult("", {}, {})
        text = "Recent Action Results\n" + "\n".join(
            f"- {entry['action']}: {entry['result']}" for entry in self._results
        )
        return ProviderResult(text, {"action_count": len(self._results)}, {"results": list(self._results)})


def _parse_params_block(text: str) -> tuple[str, dict[str, str]]:
    action_match = re.search(r"^ACTION:\s*([A-Z_]+)\s*$", text, flags=re.MULTILINE)
    action = action_match.group(1) if action_match else ""
    params_match = re.search(r"PARAMS:\s*\n(?P<body>[\s\S]*)", text)
    body = params_match.group("body").strip() if params_match else ""
    body = body.split("<response clipped>", 1)[0].strip()
    if body.startswith("{"):
        try:
            parsed = json.loads(body)
            return action, {str(k): str(v) for k, v in parsed.items()}
        except json.JSONDecodeError:
            pass

    params: dict[str, str] = {}
    current_key: str | None = None
    collecting_triple = False
    buffer: list[str] = []
    for raw_line in body.splitlines():
        line = raw_line.rstrip()
        if collecting_triple and current_key:
            if line.strip().endswith('"""'):
                value = line.rsplit('"""', 1)[0]
                if value:
                    buffer.append(value)
                params[current_key] = "\n".join(buffer).strip()
                collecting_triple = False
                current_key = None
                buffer = []
            else:
                buffer.append(line)
            continue
        match = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        if not match:
            continue
        key, value = match.group(1), match.group(2).strip()
        if value.startswith('"""'):
            value = value[3:]
            if value.endswith('"""'):
                params[key] = value[:-3].strip()
            else:
                current_key = key
                collecting_triple = True
                buffer = [value] if value else []
        else:
            params[key] = value.strip().strip('"').strip("'")
    return action, params


def _symbol_fallback_replace(original: str, old: str, new: str) -> tuple[str, bool]:
    symbol_match = re.search(r"^\s*(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)", old, re.MULTILINE)
    if not symbol_match:
        return original, False
    symbol = symbol_match.group(1)
    pattern = re.compile(
        rf"^def\s+{re.escape(symbol)}\([^)]*\):\n(?:^[ \t].*\n?)*",
        flags=re.MULTILINE,
    )
    match = pattern.search(original)
    if not match:
        return original, False
    replacement = new.rstrip() + "\n\n"
    return original[: match.start()] + replacement + original[match.end() :], True


class ElizaCodeProvider:
    def __init__(self, runtime: object, repo_manager: object, max_steps: int = 10) -> None:
        self.runtime = runtime
        self.repo_manager = repo_manager
        self.max_steps = max_steps

    def _parse_fallback_action_response(self, text: str) -> tuple[str, dict[str, str]]:
        return _parse_params_block(text)

    async def _execute_tool(
        self,
        action: str,
        params: dict[str, str],
        _ctx: object = None,
    ) -> tuple[bool, str]:
        if action != "EDIT_FILE":
            return False, f"Unsupported action {action}"
        repo_root = getattr(self.repo_manager, "current_repo", None)
        if repo_root is None:
            return False, "No current repo"
        file_path = Path(repo_root) / params["file_path"]
        original = file_path.read_text(encoding="utf-8")
        old = params.get("old_str", "")
        new = params.get("new_str", "")
        if old in original:
            file_path.write_text(original.replace(old, new, 1), encoding="utf-8")
            return True, "edited"
        replaced, ok = _symbol_fallback_replace(original, old, new)
        if ok:
            file_path.write_text(replaced, encoding="utf-8")
            return True, "edited with fallback"
        return False, "old_str not found"


class SWEAgentProvider(ElizaCodeProvider):
    def _parse_swe_agent_response(self, text: str) -> tuple[str, dict[str, str]]:
        return _parse_params_block(text)

    async def execute_task(self, task: object, ctx: object) -> object:
        response = await self.runtime.use_model("TEXT_LARGE", {"prompt": task.description})
        action, params = self._parse_swe_agent_response(response)
        ok, message = await self._execute_tool(action, params, ctx)
        submitted = False
        if ok:
            repo_root = getattr(self.repo_manager, "current_repo", None)
            diff = ""
            if repo_root is not None:
                proc = subprocess.run(
                    ["git", "diff"],
                    cwd=repo_root,
                    check=False,
                    capture_output=True,
                    text=True,
                )
                diff = proc.stdout
            submitted = bool(diff)
        return type(
            "ProviderExecutionResult",
            (),
            {"success": bool(ok), "output": message, "extra": {"submitted": submitted}},
        )()


class SWEBenchTraceHook:
    def __init__(self, *, loop: object, trace_fn: object) -> None:
        self.loop = loop
        self.trace_fn = trace_fn
        self._pending: list[object] = []

    def _schedule(self, actor: str, event: str, data: dict[str, object]) -> None:
        self._pending.append(self.loop.create_task(self.trace_fn(actor, event, data)))

    def on_run_start(self) -> None:
        self._schedule("swe-agent", "run_start", {})

    def on_step_done(self, step: object, _result: object) -> None:
        self._schedule(
            "swe-agent",
            "step_done",
            {
                "thought": getattr(step, "thought", None),
                "action": getattr(step, "action", None),
                "output": getattr(step, "output", None),
            },
        )

    def on_run_done(self, _result: object, _error: object) -> None:
        self._schedule("swe-agent", "run_done", {})

    async def flush(self) -> None:
        if self._pending:
            import asyncio

            await asyncio.gather(*self._pending)
            self._pending = []


swe_bench_issue_provider = IssueProvider()
swe_bench_tools_provider = ToolsProvider()
swe_bench_repo_structure_provider = RepoStructureProvider()
swe_bench_strategy_provider = StrategyProvider()
swe_bench_action_results_provider = SWEBenchActionResultsProvider()
SWE_BENCH_PROVIDERS = [
    swe_bench_issue_provider,
    swe_bench_tools_provider,
    swe_bench_repo_structure_provider,
    swe_bench_strategy_provider,
    swe_bench_action_results_provider,
]
