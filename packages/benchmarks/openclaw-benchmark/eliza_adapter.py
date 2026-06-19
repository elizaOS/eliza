#!/usr/bin/env python3
"""Eliza adapter for OpenClaw Benchmark suite.

This adapter supports TWO scoring modes:

1. EXECUTION MODE (--mode execution) [RECOMMENDED]
   - Actually executes code in a sandboxed environment
   - Validates files were created, code compiles, tests pass
   - Provides REAL measurement of agent capability

2. CONCEPTUAL MODE (--mode conceptual) [LEGACY]
   - Only checks if LLM mentions expected concepts
   - Does NOT execute code or verify anything
   - Useful for quick testing but scores are not meaningful

Usage:
    # Execution mode (real validation)
    python eliza_adapter.py --task setup --mode execution

    # Legacy conceptual mode
    python eliza_adapter.py --task setup --mode conceptual

    # Run all with execution validation
    python eliza_adapter.py --all --mode execution --json
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

# Add the eliza-adapter package directory to sys.path. This script's own
# directory must NOT come before it on sys.path because this file is itself
# named `eliza_adapter.py` and would shadow the `eliza_adapter` package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "eliza-adapter"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "hermes-adapter"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "openclaw-adapter"))

try:
    from eliza_adapter import ElizaClient, ElizaServerManager
    ELIZA_AVAILABLE = True
except ImportError:
    ELIZA_AVAILABLE = False

# Now make the script's own directory available so the local `openclaw/`
# package can be imported.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Try to import the new execution-based runner
try:
    from openclaw.runner import BenchmarkRunner
    from openclaw.scenarios import count_scenarios, load_scenarios, validate_scenarios
    from openclaw.scoring import format_score_summary
    EXECUTION_MODE_AVAILABLE = True
except ImportError:
    EXECUTION_MODE_AVAILABLE = False

# ---------------------------------------------------------------------------
# Paths & Configuration
# ---------------------------------------------------------------------------
BENCHMARK_DIR = Path(__file__).resolve().parent
ELIZA_URL = os.environ.get("ELIZA_BENCH_URL", "http://localhost:3939")

# Legacy conceptual tasks - only used in conceptual mode
CONCEPTUAL_TASKS = {
    "setup": {
        "name": "Environment Setup",
        "description": "Test understanding of Node.js/TypeScript project initialization",
        "prompt": "Set up a new Node.js project with TypeScript. Create the basic project structure with src/, tests/, and configuration files (package.json, tsconfig.json). Initialize git.",
        "expected_concepts": [
            ("npm init", ["npm init", "package.json", "npm", "bun", "yarn"]),
            ("typescript config", ["tsconfig", "typescript", "tsc"]),
            ("git init", ["git init", "git", ".gitignore"]),
            ("directory structure", ["src/", "src", "mkdir", "directory", "folder"]),
        ],
    },
    "implementation": {
        "name": "Feature Implementation",
        "description": "Test understanding of CLI application development",
        "prompt": "Implement a CLI tool that fetches weather data. It should accept a city name as argument, call a weather API (use OpenWeatherMap or similar), and display temperature, humidity, and conditions. Include error handling for invalid cities and network errors.",
        "expected_concepts": [
            ("API call", ["fetch", "axios", "http", "api", "request"]),
            ("argument parsing", ["argv", "argument", "commander", "yargs", "process.argv"]),
            ("error handling", ["try", "catch", "error", "throw", "exception"]),
            ("display output", ["console.log", "print", "output", "display"]),
        ],
    },
    "refactoring": {
        "name": "Code Refactoring",
        "description": "Test understanding of software architecture patterns",
        "prompt": "Refactor the weather CLI to use a modular architecture. Extract the API client to a separate module, add proper TypeScript types, implement dependency injection for testability, and add configuration management for API keys.",
        "expected_concepts": [
            ("module extraction", ["module", "import", "export", "separate"]),
            ("typescript types", ["interface", "type", "types", "typing"]),
            ("dependency injection", ["inject", "dependency", "di", "constructor"]),
            ("configuration", ["config", "environment", "env", "dotenv"]),
        ],
    },
    "testing": {
        "name": "Test Implementation",
        "description": "Test understanding of testing practices",
        "prompt": "Write comprehensive tests for the weather CLI. Include unit tests for the API client (with mocked responses), integration tests for the CLI commands, and add test coverage reporting. Use Jest or Vitest as the test framework.",
        "expected_concepts": [
            ("test framework", ["jest", "vitest", "mocha", "test"]),
            ("mocking", ["mock", "stub", "spy", "vi.mock", "jest.mock"]),
            ("coverage", ["coverage", "istanbul", "c8"]),
            ("assertions", ["expect", "assert", "should", "toBe"]),
        ],
    },
}


def score_conceptual_understanding(task_id: str, response: str) -> dict:
    """
    Score based on conceptual understanding shown in response.

    WARNING: This is NOT code verification. It only checks if the LLM
    mentioned the expected concepts. This is the LEGACY scoring mode.
    """
    if task_id not in CONCEPTUAL_TASKS:
        return {"error": f"Unknown task: {task_id}", "score": 0}

    task = CONCEPTUAL_TASKS[task_id]
    response_lower = response.lower()

    checks = []
    passed = 0

    for concept_name, keywords in task["expected_concepts"]:
        found = any(kw.lower() in response_lower for kw in keywords)
        checks.append({
            "concept": concept_name,
            "keywords": keywords,
            "found": found,
        })
        if found:
            passed += 1

    total = len(checks)
    score = passed / total if total > 0 else 0

    return {
        "task_id": task_id,
        "scoring_type": "conceptual_understanding",
        "warning": "LEGACY MODE: This measures concept mention, NOT actual implementation",
        "passed": passed,
        "total": total,
        "score": score,
        "checks": checks,
    }


class ConceptualBenchRunner:
    """Run OpenClaw benchmark tasks in conceptual mode (legacy)."""

    def __init__(self, client=None):
        self.client = client

    def run_task(self, task_id: str) -> dict:
        """Run a single benchmark task."""
        if task_id not in CONCEPTUAL_TASKS:
            return {"error": f"Unknown task: {task_id}"}

        task = CONCEPTUAL_TASKS[task_id]
        start_time = time.time()

        if self.client:
            self.client.reset(task_id=task_id, benchmark="openclaw")
            response = self.client.send_message(
                text=task["prompt"],
                context={
                    "benchmark": "openclaw",
                    "task_id": task_id,
                    "task_name": task["name"],
                    "task_description": task["description"],
                },
            )
            response_text = response.text
            actions = response.actions
        else:
            response_text = "[No LLM response - running in standalone mode]"
            actions = []

        duration_ms = (time.time() - start_time) * 1000
        score = score_conceptual_understanding(task_id, response_text)

        return {
            "task_id": task_id,
            "task_name": task["name"],
            "prompt": task["prompt"],
            "response": response_text,
            "actions": actions,
            "duration_ms": duration_ms,
            "score": score,
            "mode": "conceptual",
        }

    def run_all(self) -> dict:
        """Run all benchmark tasks."""
        results = {}
        total_score = 0
        task_count = 0

        for task_id in CONCEPTUAL_TASKS:
            result = self.run_task(task_id)
            results[task_id] = result
            if "score" in result and isinstance(result["score"], dict):
                total_score += result["score"].get("score", 0)
                task_count += 1

        return {
            "benchmark": "openclaw",
            "mode": "conceptual",
            "scoring_type": "conceptual_understanding",
            "warning": "LEGACY MODE: Scores measure concept mention only, NOT actual implementation",
            "tasks": results,
            "overall_score": total_score / task_count if task_count > 0 else 0,
            "tasks_completed": task_count,
        }


def _selected_harness_name(raw: str | None = None) -> str:
    return (
        raw
        or os.environ.get("BENCHMARK_HARNESS")
        or os.environ.get("ELIZA_BENCH_HARNESS")
        or ""
    ).strip().lower()


def _last_user_text(messages: list[dict]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            return str(message.get("content") or "")
    return ""


def _first_system_text(messages: list[dict]) -> str:
    for message in messages:
        if message.get("role") == "system":
            return str(message.get("content") or "")
    return ""


def _structured_action_system_prompt() -> str:
    return (
        "You are an expert software developer completing coding tasks in a sandbox. "
        "Return exactly one JSON object and no prose. The object must have "
        '"action":"BENCHMARK_ACTION" and a "params" object. The params object '
        "must describe the concrete project files and shell setup operations for "
        "the requested task. Use packageJson, tsconfigJson, gitignoreContents, "
        "and directories fields for setup tasks. Do not answer with acknowledgements."
    )


def _structured_action_text(task_text: str) -> str:
    return (
        f"{task_text.strip()}\n\n"
        "Return exactly this JSON shape, filled with the concrete setup data:\n"
        "{"
        '"action":"BENCHMARK_ACTION",'
        '"params":{'
        '"packageJson":{'
        '"name":"weather-cli",'
        '"version":"1.0.0",'
        '"type":"module",'
        '"scripts":{"build":"tsc","test":"node --test"}'
        "},"
        '"tsconfigJson":{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"Node","strict":true,"outDir":"dist","rootDir":"src"},"include":["src/**/*.ts"]},'
        '"gitignoreContents":"node_modules\\ndist\\n",'
        '"directories":{"src":"src","tests":"tests"}'
        "}"
        "}"
    )


def _load_first_json_object(text: str) -> dict | None:
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char != "{":
            continue
        try:
            value, _end = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def _action_as_xml(text: str) -> str:
    payload = _load_first_json_object(text)
    if payload is None:
        return ""
    if not isinstance(payload, dict) or payload.get("action") != "BENCHMARK_ACTION":
        return ""
    params = payload.get("params")
    if not isinstance(params, dict):
        return ""

    calls: list[dict] = []
    package_json = params.get("packageJson") or params.get("package_json")
    if isinstance(package_json, dict):
        calls.append(
            {
                "tool": "write",
                "args": {
                    "path": "package.json",
                    "content": json.dumps(package_json, ensure_ascii=False, indent=2),
                },
            }
        )
    tsconfig = params.get("tsconfigJson") or params.get("tsconfig_json")
    if isinstance(tsconfig, dict):
        calls.append(
            {
                "tool": "write",
                "args": {
                    "path": "tsconfig.json",
                    "content": json.dumps(tsconfig, ensure_ascii=False, indent=2),
                },
            }
        )
    gitignore = params.get("gitignoreContents") or params.get("gitignore")
    if isinstance(gitignore, str):
        calls.append({"tool": "write", "args": {"path": ".gitignore", "content": gitignore}})

    directories = params.get("directories")
    if isinstance(directories, dict):
        src_dir = str(directories.get("src") or "src")
        tests_dir = str(directories.get("tests") or "tests")
        calls.append(
            {
                "tool": "exec",
                "args": {
                    "command": (
                        f"mkdir -p {src_dir} {tests_dir} && "
                        f"touch {src_dir}/index.ts {tests_dir}/.gitkeep"
                    )
                },
            }
        )
    if any(call["args"].get("path") == "package.json" for call in calls if call["tool"] == "write"):
        calls.append({"tool": "exec", "args": {"command": "git init"}})

    return "\n".join(
        "<tool_call>" + json.dumps(call, ensure_ascii=False) + "</tool_call>"
        for call in calls
    )


class HarnessExecutionRunner(BenchmarkRunner):
    """Execution-mode OpenClaw benchmark routed through a real harness client."""

    def __init__(
        self,
        *,
        harness: str,
        model: str,
        use_docker: bool = False,
        start_server: bool = False,
    ) -> None:
        super().__init__(
            model=model,
            api_key=os.environ.get("OPENAI_API_KEY")
            or os.environ.get("CEREBRAS_API_KEY")
            or "harness",
            use_docker=use_docker,
        )
        self.harness = harness
        self._manager = None
        self._client = self._build_client(start_server=start_server)
        self._turn_index = 0

    def close(self) -> None:
        if self._manager is not None:
            self._manager.stop()
            self._manager = None

    def _build_client(self, *, start_server: bool):
        provider = (os.environ.get("BENCHMARK_MODEL_PROVIDER") or "cerebras").strip().lower()
        timeout_s = float(os.environ.get("OPENCLAW_BENCH_HARNESS_TIMEOUT_S", "120"))
        if self.harness == "hermes":
            from hermes_adapter.client import HermesClient

            return HermesClient(provider=provider, model=self.model, timeout_s=timeout_s)
        if self.harness == "openclaw":
            from openclaw_adapter.client import OpenClawClient

            return OpenClawClient(
                provider=provider,
                model=self.model,
                timeout_s=timeout_s,
                direct_openai_compatible=True,
                reasoning_effort=os.environ.get("OPENCLAW_BENCH_THINKING", "low"),
            )
        if self.harness == "eliza":
            if not ELIZA_AVAILABLE:
                raise RuntimeError("eliza_adapter package is unavailable")
            if start_server or (
                not os.environ.get("ELIZA_BENCH_URL")
                or not os.environ.get("ELIZA_BENCH_TOKEN")
            ):
                self._manager = ElizaServerManager()
                self._manager.start()
                return self._manager.client
            return ElizaClient(ELIZA_URL, token=os.environ.get("ELIZA_BENCH_TOKEN"))
        raise RuntimeError(f"unsupported OpenClaw benchmark harness: {self.harness}")

    def call_llm(self, messages: list) -> str:
        self._turn_index += 1
        if hasattr(self._client, "reset") and self._turn_index == 1:
            self._client.reset("openclaw-bench", "openclaw_bench")
        if self._turn_index > 1:
            return "Done."
        user_text = _last_user_text(messages)
        harness_messages = [
            {"role": "system", "content": _structured_action_system_prompt()},
            {"role": "user", "content": _structured_action_text(user_text)},
        ]
        context = {
            "benchmark": "openclaw_bench",
            "task_id": "openclaw-bench",
            "messages": harness_messages,
            "system_prompt": _first_system_text(harness_messages),
            "temperature": 0.1,
            "max_tokens": 4000,
        }
        response = self._client.send_message(_last_user_text(harness_messages), context=context)
        response_text = str(response.text or "")
        action_xml = _action_as_xml(response_text)
        if action_xml:
            return action_xml
        raw_action = response.params.get("BENCHMARK_ACTION") if isinstance(response.params, dict) else None
        if isinstance(raw_action, dict):
            action_xml = _action_as_xml(
                json.dumps({"action": "BENCHMARK_ACTION", "params": raw_action})
            )
            if action_xml:
                return action_xml
        return response_text


def main():
    parser = argparse.ArgumentParser(
        description="Run OpenClaw benchmark with eliza",
        epilog="""
Scoring modes:
  execution   - RECOMMENDED: Actually executes code and validates results
  conceptual  - LEGACY: Only checks if concepts are mentioned (not reliable)
"""
    )
    parser.add_argument("--task", "-t", type=str, default=None,
                        help="Task to run (setup, implementation, refactoring, testing)")
    parser.add_argument("--all", "-a", action="store_true",
                        help="Run all tasks")
    parser.add_argument("--list", "-l", action="store_true",
                        help="List available tasks")
    parser.add_argument("--count-scenarios", action="store_true",
                        help="Print authored, added, and total scenario counts")
    parser.add_argument("--validate-scenarios", action="store_true",
                        help="Validate expanded scenario corpus and exit")
    parser.add_argument("--mode", "-m", type=str, default="execution",
                        choices=["execution", "conceptual"],
                        help="Scoring mode: execution (real) or conceptual (legacy)")
    parser.add_argument("--json", "-j", action="store_true",
                        help="Output JSON")
    parser.add_argument("--output-dir", "-o", type=str, default=None,
                        help="Output directory for results")
    parser.add_argument("--model", type=str, default=None,
                        help="Model to use (for execution mode)")
    parser.add_argument("--docker", action="store_true",
                        help="Use Docker for sandbox isolation (execution mode)")
    parser.add_argument("--start-server", action="store_true",
                        help="Auto-start eliza benchmark server (conceptual mode)")
    parser.add_argument("--harness", type=str, default=None,
                        choices=["eliza", "hermes", "openclaw", "direct"],
                        help="Route execution-mode LLM calls through a benchmark harness")

    args = parser.parse_args()

    if args.count_scenarios:
        if not EXECUTION_MODE_AVAILABLE:
            print("Error: Execution mode not available. Install openclaw module or use --mode conceptual")
            sys.exit(1)
        print(json.dumps(count_scenarios(), indent=2))
        return

    if args.validate_scenarios:
        if not EXECUTION_MODE_AVAILABLE:
            print("Error: Execution mode not available. Install openclaw module or use --mode conceptual")
            sys.exit(1)
        validate_scenarios()
        print("OpenClaw scenarios valid")
        return

    # List tasks
    if args.list:
        print("Available OpenClaw benchmark tasks:")
        print()
        if args.mode == "execution" and EXECUTION_MODE_AVAILABLE:
            print("Mode: EXECUTION (validates actual code)")
            for scenario in sorted(load_scenarios()):
                print(f"  {scenario}")
        else:
            print("Mode: CONCEPTUAL (keyword matching only)")
            print("WARNING: Conceptual mode scores are not meaningful!")
            print()
            for task_id, task in CONCEPTUAL_TASKS.items():
                print(f"  {task_id:15s} - {task['name']}")
        return

    # Validate mode
    if args.mode == "execution" and not EXECUTION_MODE_AVAILABLE:
        print("Error: Execution mode not available. Install openclaw module or use --mode conceptual")
        print("Run: pip install pyyaml httpx")
        sys.exit(1)

    # Run benchmark
    if args.mode == "execution":
        # Use the new execution-based runner. Accepts any OpenAI-compatible
        # provider via OPENAI_API_KEY + OPENAI_BASE_URL (cerebras, openrouter,
        # vllm, openai) and falls back to legacy GROQ_API_KEY.
        api_key = (
            os.environ.get("OPENAI_API_KEY")
            or os.environ.get("CEREBRAS_API_KEY")
            or os.environ.get("GROQ_API_KEY")
        )
        if not api_key:
            print(
                "Error: OPENAI_API_KEY (or CEREBRAS_API_KEY / GROQ_API_KEY) "
                "is required for execution mode",
            )
            sys.exit(1)

        model = (
            args.model
            or os.environ.get("BENCHMARK_MODEL_NAME")
            or os.environ.get("GROQ_MODEL")
            or "moonshotai/kimi-k2-instruct"
        )

        try:
            harness = _selected_harness_name(args.harness)
            if harness in {"eliza", "hermes", "openclaw"}:
                runner = HarnessExecutionRunner(
                    harness=harness,
                    model=model,
                    use_docker=args.docker,
                    start_server=args.start_server,
                )
            else:
                runner = BenchmarkRunner(model=model, api_key=api_key, use_docker=args.docker)
        except Exception as e:
            print(f"Error initializing runner: {e}")
            sys.exit(1)

        try:
            if args.all:
                result = runner.run_all()
            elif args.task:
                result = runner.run_scenario(args.task)
            else:
                print("Error: Specify --task or --all")
                sys.exit(1)
        finally:
            close = getattr(runner, "close", None)
            if callable(close):
                close()

        selected_harness = _selected_harness_name(args.harness)
        if selected_harness in {"eliza", "hermes", "openclaw"}:
            result["harness"] = selected_harness
            result["agent_type"] = f"{selected_harness}-benchmark-bridge"
            result["model_provider"] = (
                os.environ.get("BENCHMARK_MODEL_PROVIDER") or "cerebras"
            )
            result["model_name"] = model
            result["real_validation"] = {
                "mode": "execution",
                "scoring": "file_command_and_test_execution",
                "conceptual_scoring": False,
            }

    else:
        # Legacy conceptual mode
        client = None
        mgr = None

        if ELIZA_AVAILABLE:
            if args.start_server:
                mgr = ElizaServerManager()
                mgr.start()
                client = mgr.client
            else:
                client = ElizaClient(ELIZA_URL)
                try:
                    client.wait_until_ready(timeout=10)
                except TimeoutError:
                    print("Warning: Eliza server not available, running in standalone mode")
                    client = None

        runner = ConceptualBenchRunner(client)

        if args.all:
            result = runner.run_all()
        elif args.task:
            result = runner.run_task(args.task)
        else:
            print("Error: Specify --task or --all")
            if mgr:
                mgr.stop()
            return

        if mgr:
            mgr.stop()

    # Save results
    if args.output_dir:
        output_dir = Path(args.output_dir)
        output_dir.mkdir(exist_ok=True, parents=True)
        timestamp = int(time.time())
        mode_suffix = "exec" if args.mode == "execution" else "concept"
        output_file = output_dir / f"openclaw_{args.task or 'all'}_{mode_suffix}_{timestamp}.json"
        with open(output_file, "w") as f:
            json.dump(result, f, indent=2, default=str)
        if not args.json:
            print(f"Results saved to: {output_file}")

    # Output
    if args.json:
        print(json.dumps(result, indent=2, default=str))
    else:
        if args.mode == "execution":
            # Execution mode output
            print(f"\n{'='*60}")
            print("OPENCLAW BENCHMARK RESULTS - EXECUTION MODE")
            print("Validates actual code execution and file creation")
            print(f"{'='*60}")

            if args.all:
                print(f"\nOverall Score: {result.get('overall_score', 0):.1%}")
                print(f"Tasks Completed: {result.get('tasks_completed', 0)}")
                for task_id, task_result in result.get("tasks", {}).items():
                    score = task_result.get("score", {})
                    print(f"\n  {task_id}: {score.get('score', 0):.1%} "
                          f"({score.get('passed', 0)}/{score.get('total_checks', 0)} checks)")
            else:
                score = result.get("score", {})
                print(f"\nTask: {result.get('scenario_name', result.get('scenario', 'Unknown'))}")
                print(f"Score: {score.get('score', 0):.1%}")
                print(f"Passed: {score.get('passed', 0)}/{score.get('total_checks', 0)} checks")

                if EXECUTION_MODE_AVAILABLE:
                    print(f"\n{format_score_summary(score)}")
        else:
            # Conceptual mode output
            print(f"\n{'='*60}")
            print("OPENCLAW BENCHMARK RESULTS - CONCEPTUAL MODE (LEGACY)")
            print("WARNING: Only measures keyword presence, NOT actual code!")
            print(f"{'='*60}")

            if args.all:
                print(f"\nOverall Score: {result['overall_score']:.1%}")
                print(f"Tasks Completed: {result['tasks_completed']}")
                for task_id, task_result in result.get("tasks", {}).items():
                    score = task_result.get("score", {})
                    print(f"\n  {task_id}: {score.get('passed', 0)}/{score.get('total', 0)} concepts mentioned")
            else:
                print(f"\nTask: {result.get('task_name', 'Unknown')}")
                print(f"Response: {result.get('response', '')[:300]}...")
                score = result.get("score", {})
                print(f"\nConcepts mentioned: {score.get('passed', 0)}/{score.get('total', 0)}")
                for check in score.get("checks", []):
                    status = "+" if check["found"] else "-"
                    print(f"  {status} {check['concept']}")


if __name__ == "__main__":
    main()
