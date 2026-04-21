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

# Configuration
SCENARIOS_DIR = Path(__file__).parent / "scenarios"
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
DEFAULT_MODEL = os.environ.get("GROQ_MODEL", "moonshotai/kimi-k2-instruct")
API_TIMEOUT = 120
MAX_STEPS = 15


class BenchmarkRunner:
    """Execute OpenClaw benchmark scenarios with actual code execution."""

    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        api_key: Optional[str] = None,
        use_docker: bool = False,
    ):
        self.model = model
        self.api_key = api_key or GROQ_API_KEY
        if not self.api_key:
            raise ValueError("API key required. Set GROQ_API_KEY environment variable.")

        self.sandbox_config = SandboxConfig(use_docker=use_docker)
        self.tool_calls: list[dict] = []
        self.executed_commands: list[dict] = []

    def load_scenario(self, name: str) -> dict:
        """Load a scenario YAML file."""
        scenario_path = SCENARIOS_DIR / f"{name}.yaml"
        if not scenario_path.exists():
            available = [f.stem for f in SCENARIOS_DIR.glob("*.yaml")]
            raise FileNotFoundError(
                f"Scenario '{name}' not found. Available: {', '.join(available)}"
            )
        with open(scenario_path) as f:
            return yaml.safe_load(f)

    def list_scenarios(self) -> list[str]:
        """List available scenarios."""
        return sorted([f.stem for f in SCENARIOS_DIR.glob("*.yaml")])

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
            "https://api.groq.com/openai/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=API_TIMEOUT,
        )

        if response.status_code != 200:
            print(f"API error ({response.status_code}): {response.text[:200]}")
            return ""

        data = response.json()
        if "choices" not in data or not data["choices"]:
            return ""

        return data["choices"][0]["message"]["content"] or ""

    def parse_tool_calls(self, text: str) -> list[dict]:
        """Extract tool calls from LLM response."""
        calls = []
        for match in re.finditer(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", text, re.DOTALL):
            try:
                calls.append(json.loads(match.group(1)))
            except json.JSONDecodeError:
                pass
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

    def run_scenario(self, scenario_name: str) -> dict:
        """Run a single scenario with actual code execution."""
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

        with SandboxExecutor(self.sandbox_config) as sandbox:
            step = 0
            while step < MAX_STEPS:
                step += 1
                print(f"\n--- Step {step} ---")

                response_text = self.call_llm(messages)
                if not response_text:
                    print("Empty response, stopping")
                    break

                all_responses.append(response_text)
                print(f"Response ({len(response_text)} chars): {response_text[:150]}...")

                # Parse and execute tool calls
                tool_calls = self.parse_tool_calls(response_text)
                if not tool_calls:
                    print("No tool calls, agent finished")
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
            if scoring_config:
                score_result = score_episode(result, scoring_config, sandbox.get_workspace())
            else:
                score_result = {"score": None, "reason": "No scoring config"}

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
            "scenario": scenario_name,
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

    def run_all(self) -> dict:
        """Run all scenarios."""
        results = {}
        total_score = 0
        task_count = 0

        for scenario in self.list_scenarios():
            try:
                result = self.run_scenario(scenario)
                results[scenario] = result
                if result.get("score", {}).get("score") is not None:
                    total_score += result["score"]["score"]
                    task_count += 1
            except Exception as e:
                print(f"Error running {scenario}: {e}")
                results[scenario] = {"error": str(e)}

        return {
            "benchmark": "openclaw",
            "model": self.model,
            "scoring_type": "execution_validation",
            "tasks": results,
            "overall_score": total_score / task_count if task_count > 0 else 0,
            "tasks_completed": task_count,
        }

    def _build_system_prompt(self) -> str:
        """Build the system prompt with tool instructions."""
        return """You are an expert software developer helping to complete coding tasks.

AVAILABLE TOOLS:
- exec: Run shell commands
  {"tool": "exec", "args": {"command": "npm init -y"}}

- write: Write a file
  {"tool": "write", "args": {"path": "src/index.ts", "content": "// code here"}}

- read: Read a file
  {"tool": "read", "args": {"path": "package.json"}}

To use a tool, format your response with:
<tool_call>
{"tool": "tool_name", "args": {"key": "value"}}
</tool_call>

You can make multiple tool calls in one response. After tool results, continue
working until the task is complete.

IMPORTANT GUIDELINES:
1. Create actual working code, not just descriptions
2. Use proper error handling
3. Follow TypeScript/JavaScript best practices
4. Test your code if possible
5. Keep files organized (src/, tests/, etc.)

When the task is complete, provide a final summary without tool calls."""


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
    parser.add_argument("--model", "-m", type=str, default=DEFAULT_MODEL,
                        help="Model to use")
    parser.add_argument("--output-dir", "-o", type=str, default=None,
                        help="Output directory for results")
    parser.add_argument("--json", "-j", action="store_true",
                        help="Output JSON to stdout")
    parser.add_argument("--docker", action="store_true",
                        help="Use Docker for sandbox isolation")

    args = parser.parse_args()

    if args.list:
        runner = BenchmarkRunner.__new__(BenchmarkRunner)
        print("Available scenarios:")
        for scenario in sorted(SCENARIOS_DIR.glob("*.yaml")):
            print(f"  - {scenario.stem}")
        return

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
