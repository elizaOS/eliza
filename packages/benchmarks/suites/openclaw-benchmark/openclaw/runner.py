#!/usr/bin/env python3
"""
OpenClaw Benchmark Runner.

Executes benchmark scenarios against an LLM agent and validates ACTUAL
code execution, not just conceptual understanding.

Usage:
    python -m openclaw.runner --scenario setup --model groq/kimi-k2
    python -m openclaw.runner --all --output-dir ./results
"""

import argparse
import json
import math
import os
import re
import sys
import time
from pathlib import Path
from typing import Optional

import httpx
import yaml

from .sandbox import SandboxExecutor, SandboxConfig
from .scoring import score_episode, format_score_summary
from .scenarios import (
    count_scenarios,
    load_scenarios,
    scenario_provenance,
    validate_scenarios,
)

# Configuration
DEFAULT_MODEL = (
    os.environ.get("BENCHMARK_MODEL_NAME")
    or os.environ.get("GROQ_MODEL")
    or "moonshotai/kimi-k2-instruct"
)
DEFAULT_BASE_URL = (
    os.environ.get("OPENAI_BASE_URL")
    or "https://api.groq.com/openai/v1"
)
API_TIMEOUT = 120
MAX_STEPS = 15


def _resolve_api_key() -> Optional[str]:
    """Pick the API key to use based on the configured OpenAI-compatible endpoint.

    The orchestrator sets OPENAI_API_KEY (and OPENAI_BASE_URL) for any
    OpenAI-compatible provider — cerebras, openrouter, vllm, openai. Standalone
    invocations may set GROQ_API_KEY for the legacy Groq path.
    """
    return (
        os.environ.get("OPENAI_API_KEY")
        or os.environ.get("CEREBRAS_API_KEY")
        or os.environ.get("GROQ_API_KEY")
    )


class BenchmarkRunner:
    """Execute OpenClaw benchmark scenarios with actual code execution."""

    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        api_key: Optional[str] = None,
        use_docker: bool = False,
        base_url: Optional[str] = None,
    ):
        self.model = model
        self.api_key = api_key or _resolve_api_key()
        if not self.api_key:
            raise ValueError(
                "API key required. Set OPENAI_API_KEY (recommended), CEREBRAS_API_KEY, "
                "or GROQ_API_KEY in the environment."
            )
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")

        self.sandbox_config = SandboxConfig(use_docker=use_docker)
        self.tool_calls: list[dict] = []
        self.executed_commands: list[dict] = []

    def load_scenario(self, name: str) -> dict:
        """Load a scenario YAML file."""
        scenarios = load_scenarios()
        if name not in scenarios:
            available = sorted(scenarios)
            raise FileNotFoundError(
                f"Scenario '{name}' not found. Available: {', '.join(available)}"
            )
        return scenarios[name]

    def list_scenarios(self) -> list[str]:
        """List available scenarios."""
        return sorted(load_scenarios())

    def call_llm(self, messages: list) -> str:
        """Call the LLM API."""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.3,  # Lower for more consistent code generation
            "max_tokens": 4000,
        }

        response = httpx.post(
            f"{self.base_url}/chat/completions",
            headers=headers,
            json=payload,
            timeout=API_TIMEOUT,
        )

        if response.status_code != 200:
            raise RuntimeError(
                f"LLM API returned HTTP {response.status_code}: {response.text[:500]}"
            )
        data = response.json()
        choices = data.get("choices") if isinstance(data, dict) else None
        if not isinstance(choices, list) or not choices:
            raise RuntimeError("LLM API response has no choices")
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("LLM API response has no assistant content")
        return content

    def parse_tool_calls(self, text: str) -> list[dict]:
        """Extract tool calls from LLM response."""
        calls = []
        for match in re.finditer(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", text, re.DOTALL):
            try:
                call = json.loads(match.group(1))
            except json.JSONDecodeError as exc:
                raise RuntimeError("assistant emitted malformed tool-call JSON") from exc
            if not isinstance(call, dict):
                raise RuntimeError("assistant tool call must be a JSON object")
            calls.append(call)
        return calls

    def execute_tool(self, tool_name: str, args: dict, sandbox: SandboxExecutor) -> dict:
        """Execute a tool call in the sandbox."""
        result = {"tool": tool_name, "args": args}

        if tool_name == "exec":
            command = args.get("command", "")
            exec_result = sandbox.execute(command)
            result["result"] = {
                "success": exec_result.success,
                "exit_code": exec_result.exit_code,
                "stdout": exec_result.stdout[:2000],
                "stderr": exec_result.stderr[:500],
            }
            self.executed_commands.append({
                "command": command,
                "success": exec_result.success,
                "exit_code": exec_result.exit_code,
            })

        elif tool_name == "write":
            path = args.get("path", "")
            content = args.get("content", "")
            try:
                sandbox.write_file(path, content)
                result["result"] = {"success": True, "path": path}
            except Exception as e:
                # error-policy:J1 Tool execution returns an explicit failure to
                # the agent so it can correct the path or content on a later turn.
                result["result"] = {"success": False, "error": str(e)}

        elif tool_name == "read":
            path = args.get("path", "")
            content = sandbox.read_file(path)
            if content is not None:
                result["result"] = {"success": True, "content": content[:5000]}
            else:
                result["result"] = {"success": False, "error": f"File not found: {path}"}

        else:
            result["result"] = {"error": f"Unknown tool: {tool_name}"}

        self.tool_calls.append(result)
        return result["result"]

    def run_scenario(
        self,
        scenario_name: str,
        sandbox: Optional["SandboxExecutor"] = None,
    ) -> dict:
        """Run a single scenario with actual code execution.

        If ``sandbox`` is supplied the scenario runs inside that pre-existing
        sandbox so prerequisite scenarios can leave files for downstream
        scenarios. Otherwise a fresh sandbox is created for this scenario
        only and torn down on exit.
        """
        print(f"\n{'='*60}")
        print(f"SCENARIO: {scenario_name} | MODEL: {self.model}")
        print(f"{'='*60}")

        scenario = self.load_scenario(scenario_name)
        self.tool_calls = []
        self.executed_commands = []

        start_time = time.time()

        # Build system prompt with tool instructions
        system_prompt = self._build_system_prompt()
        user_prompt = scenario["prompt"]

        print(f"Task: {scenario['name']}")
        print(f"Prompt: {user_prompt[:100]}...")

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        all_responses = []
        finished = False

        owns_sandbox = sandbox is None
        sandbox_cm = SandboxExecutor(self.sandbox_config) if owns_sandbox else None
        sandbox = sandbox_cm.__enter__() if owns_sandbox else sandbox

        try:
            step = 0
            while step < MAX_STEPS:
                step += 1
                print(f"\n--- Step {step} ---")

                response_text = self.call_llm(messages)
                if not response_text:
                    raise RuntimeError(
                        f"scenario {scenario_name} returned an empty model response"
                    )

                all_responses.append(response_text)
                print(f"Response ({len(response_text)} chars): {response_text[:150]}...")

                # Parse and execute tool calls
                tool_calls = self.parse_tool_calls(response_text)
                if not tool_calls:
                    print("No tool calls, agent finished")
                    finished = True
                    break

                # Execute tools
                tool_results = []
                for tc in tool_calls:
                    tool_name = tc.get("tool", "unknown")
                    tool_args = tc.get("args", {})
                    print(f"  Tool: {tool_name} | Args: {str(tool_args)[:60]}...")

                    result = self.execute_tool(tool_name, tool_args, sandbox)
                    tool_results.append({"tool": tool_name, "result": result})

                # Add to conversation
                messages.append({"role": "assistant", "content": response_text})

                results_text = "Tool results:\n"
                for tr in tool_results:
                    result_str = json.dumps(tr["result"], indent=2)
                    if len(result_str) > 500:
                        result_str = result_str[:500] + "..."
                    results_text += f"\n[{tr['tool']}]: {result_str}\n"

                messages.append({"role": "user", "content": results_text})

            if not finished:
                raise RuntimeError(
                    f"scenario {scenario_name} exhausted {MAX_STEPS} steps "
                    "without a terminal answer"
                )

            # Build result for scoring
            final_response = "\n\n".join(all_responses)

            tool_counts = {}
            for tc in self.tool_calls:
                name = tc.get("tool", "unknown")
                tool_counts[name] = tool_counts.get(name, 0) + 1

            result = {
                "response": final_response,
                "tool_calls_raw": self.tool_calls,
                "tool_calls_by_type": tool_counts,
                "tool_calls_total": len(self.tool_calls),
                "executed_commands": self.executed_commands,
                "files_created": sandbox.get_files_created(),
            }

            # Score against rubric - THIS IS THE KEY DIFFERENCE
            # We pass the workspace so file checks actually validate the sandbox
            scoring_config = scenario.get("scoring")
            if not isinstance(scoring_config, dict) or not scoring_config.get("checks"):
                raise ValueError(f"scenario {scenario_name} has no scoring checks")
            score_result = score_episode(
                result, scoring_config, sandbox.get_workspace()
            )
            _validated_score(score_result, scenario_name)
        finally:
            if owns_sandbox and sandbox_cm is not None:
                sandbox_cm.__exit__(None, None, None)

        duration_ms = (time.time() - start_time) * 1000

        print(f"\n{'='*60}")
        print("RESULTS")
        print(f"{'='*60}")
        print(f"Duration: {duration_ms/1000:.1f}s")
        print(f"Steps: {step}")
        print(f"Tool calls: {len(self.tool_calls)}")
        print(f"Files created: {len(result['files_created'])}")
        print(f"\n{format_score_summary(score_result)}")

        return {
            "benchmark": "openclaw",
            "complete": True,
            "scenario": scenario_name,
            "scenario_id": scenario_name,
            "scenario_name": scenario["name"],
            "model": self.model,
            "duration_ms": duration_ms,
            "steps": step,
            "tool_calls": self.tool_calls,
            "executed_commands": self.executed_commands,
            "files_created": list(result["files_created"].keys()),
            "score": score_result,
            "response": final_response,
        }

    def _ordered_scenarios(self) -> list[str]:
        """Return scenarios in topological order based on declared
        ``prerequisites`` so downstream tasks see files created by their
        prerequisites in the shared sandbox."""
        loaded = load_scenarios()
        scenarios = sorted(loaded)
        deps: dict[str, list[str]] = {}
        for name in scenarios:
            cfg = loaded[name]
            prereqs = cfg.get("prerequisites") or []
            deps[name] = list(prereqs)

        ordered: list[str] = []
        visited: set[str] = set()
        visiting: set[str] = set()

        def visit(name: str) -> None:
            if name in visited:
                return
            if name in visiting:
                raise ValueError(f"scenario dependency cycle includes {name}")
            visiting.add(name)
            for dep in deps.get(name, []):
                visit(dep)
            visiting.discard(name)
            visited.add(name)
            ordered.append(name)

        for name in scenarios:
            visit(name)
        return ordered

    @staticmethod
    def _scenario_cohort(name: str) -> str:
        marker = "--edge-"
        return name.split(marker, 1)[1] if marker in name else "authored"

    def run_all(self) -> dict:
        """Run all scenarios in dependency order, sharing one sandbox so
        downstream scenarios can read files left by their prerequisites."""
        results: dict[str, dict] = {}
        total_score = 0.0
        task_count = 0

        validate_scenarios()
        ordered = self._ordered_scenarios()
        cohorts: dict[str, list[str]] = {}
        for scenario in ordered:
            cohorts.setdefault(self._scenario_cohort(scenario), []).append(scenario)

        # Authored tasks form one dependency chain, while each edge variant is
        # an independent chain. A fresh sandbox per cohort prevents an earlier
        # perturbation from pre-populating files that a later one is scored on.
        for cohort_scenarios in cohorts.values():
            with SandboxExecutor(self.sandbox_config) as sandbox:
                for scenario in cohort_scenarios:
                    try:
                        result = self.run_scenario(scenario, sandbox=sandbox)
                        results[scenario] = result
                        total_score += _validated_score(result.get("score"), scenario)
                        task_count += 1
                    except Exception as e:
                        # error-policy:J1 Per-scenario failures remain visible in
                        # the complete report; callers reject `complete=false`.
                        print(f"Error running {scenario}: {e}")
                        results[scenario] = {"error": str(e)}

        return {
            "benchmark": "openclaw",
            "model": self.model,
            "scoring_type": "execution_validation",
            "tasks": results,
            "overall_score": total_score / task_count if task_count > 0 else 0,
            "tasks_completed": task_count,
            "expected_tasks": len(ordered),
            "failed_tasks": sum(1 for result in results.values() if "error" in result),
            "scenario_cohorts": len(cohorts),
            "dataset_provenance": scenario_provenance(),
            "complete": (
                len(results) == len(ordered)
                and task_count == len(ordered)
                and all("error" not in result for result in results.values())
            ),
        }

    def _build_system_prompt(self) -> str:
        """Build the system prompt with tool instructions."""
        return """You are an expert software developer completing coding tasks in a sandbox.

You MUST take action by emitting tool calls. Describing what you "will do" without
emitting <tool_call> blocks counts as zero work and the task will fail.

AVAILABLE TOOLS:
- exec: Run shell commands (npm, git, mkdir, etc.)
  <tool_call>{"tool": "exec", "args": {"command": "git init"}}</tool_call>

- write: Create or overwrite a file (parent directories are created automatically)
  <tool_call>{"tool": "write", "args": {"path": "src/index.ts", "content": "// code"}}</tool_call>

- read: Read an existing file
  <tool_call>{"tool": "read", "args": {"path": "package.json"}}</tool_call>

RULES:
1. Every turn must contain at least one <tool_call> block until the task is fully done.
2. Emit tool calls as raw text in your response, exactly like the examples above —
   one JSON object per <tool_call>...</tool_call> block. Multiple blocks per turn
   are allowed and encouraged.
3. Do NOT wrap tool calls in markdown fences. Do NOT use any other tag name.
4. Create the actual files and run the actual commands the task requires.
   "I will create X" without a corresponding write/exec call is a failure.
5. Only emit a final summary (no tool calls) once every requirement is satisfied.
6. Never use destructive shell patterns (rm -rf, sudo, chmod 777, curl | sh).
"""


def _validated_score(score_result: object, scenario_name: str) -> float:
    if not isinstance(score_result, dict):
        raise ValueError(f"scenario {scenario_name} returned a non-object score")
    score = score_result.get("score")
    if (
        not isinstance(score, (int, float))
        or isinstance(score, bool)
        or not math.isfinite(float(score))
        or not 0 <= float(score) <= 1
    ):
        raise ValueError(
            f"scenario {scenario_name} returned invalid score {score!r}"
        )
    return float(score)


def require_complete_full_result(result: object) -> None:
    """Reject a partial full-suite result before any publication side effect."""
    if not isinstance(result, dict):
        raise RuntimeError("OpenClaw full-suite result is not an object")
    expected = result.get("expected_tasks")
    tasks = result.get("tasks")
    provenance = result.get("dataset_provenance")
    if (
        result.get("complete") is not True
        or not isinstance(expected, int)
        or expected <= 0
        or result.get("tasks_completed") != expected
        or result.get("failed_tasks") != 0
        or not isinstance(tasks, dict)
        or len(tasks) != expected
        or not isinstance(provenance, dict)
        or provenance.get("total_scenarios") != expected
        or not isinstance(provenance.get("workload_sha256"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", provenance["workload_sha256"])
    ):
        raise RuntimeError(
            "refusing to publish incomplete or unprovenanced OpenClaw full-suite "
            f"result: completed={result.get('tasks_completed')!r}, "
            f"expected={expected!r}, failed={result.get('failed_tasks')!r}"
        )


def main():
    parser = argparse.ArgumentParser(
        description="Run OpenClaw benchmark with actual code execution"
    )
    parser.add_argument("--scenario", "-s", type=str, default=None,
                        help="Scenario to run")
    parser.add_argument("--all", "-a", action="store_true",
                        help="Run all scenarios")
    parser.add_argument("--list", "-l", action="store_true",
                        help="List available scenarios")
    parser.add_argument("--count-scenarios", action="store_true",
                        help="Print authored, added, and total scenario counts")
    parser.add_argument("--validate-scenarios", action="store_true",
                        help="Validate expanded scenario corpus and exit")
    parser.add_argument("--model", "-m", type=str, default=DEFAULT_MODEL,
                        help="Model to use")
    parser.add_argument("--output-dir", "-o", type=str, default=None,
                        help="Output directory for results")
    parser.add_argument("--json", "-j", action="store_true",
                        help="Output JSON to stdout")
    parser.add_argument("--docker", action="store_true",
                        help="Use Docker for sandbox isolation")

    args = parser.parse_args()

    if args.count_scenarios:
        validate_scenarios()
        print(json.dumps(count_scenarios(), indent=2))
        return

    if args.validate_scenarios:
        validate_scenarios()
        print("OpenClaw scenarios valid")
        return

    if args.list:
        runner = BenchmarkRunner.__new__(BenchmarkRunner)
        print("Available scenarios:")
        for scenario in runner.list_scenarios():
            print(f"  - {scenario}")
        return

    validate_scenarios()

    try:
        runner = BenchmarkRunner(model=args.model, use_docker=args.docker)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    if args.all:
        result = runner.run_all()
    elif args.scenario:
        result = runner.run_scenario(args.scenario)
    else:
        print("Error: Specify --scenario or --all")
        sys.exit(1)

    if args.all:
        require_complete_full_result(result)

    # Save results
    if args.output_dir:
        output_dir = Path(args.output_dir)
    else:
        output_dir = Path(__file__).parent.parent / "outputs"
    output_dir.mkdir(exist_ok=True, parents=True)

    timestamp = int(time.time())
    scenario_name = args.scenario or "all"
    output_file = output_dir / f"openclaw_{scenario_name}_{timestamp}.json"

    with open(output_file, "w") as f:
        json.dump(result, f, indent=2, default=str)

    if args.json:
        print(json.dumps(result, indent=2, default=str))
    else:
        print(f"\nResults saved to: {output_file}")


if __name__ == "__main__":
    main()
