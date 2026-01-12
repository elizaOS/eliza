"""
Command-line interface for Reasoning Gym environment.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path


def _load_dotenv() -> None:
    """Best-effort load of repo/root .env (no external dependency)."""
    candidates = [
        Path.cwd() / ".env",
        # repo_root/examples/atropos/reasoning/elizaos_atropos_reasoning/cli.py -> repo_root is parents[4]
        Path(__file__).resolve().parents[4] / ".env",
    ]

    for path in candidates:
        if not path.is_file():
            continue
        try:
            for raw_line in path.read_text().splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                k = key.strip()
                if not k or k in os.environ:
                    continue
                v = value.strip()
                if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                    v = v[1:-1]
                os.environ[k] = v
        except OSError:
            pass


async def run_eval_mode(
    num_problems: int = 20,
    task_type: str = "math",
    difficulty: str = "medium",
    use_llm: bool = False,
) -> None:
    """Run evaluation mode."""
    _load_dotenv()

    from elizaos_atropos_reasoning import (
        ReasoningEnvironment,
        ReasoningAgent,
        TaskType,
        Difficulty,
    )

    print("\n🧠 ElizaOS Atropos - Reasoning Gym")
    print("=" * 50)
    print(f"Mode: {'LLM-based' if use_llm else 'Heuristic'}")
    print(f"Task: {task_type}")
    print(f"Difficulty: {difficulty}")
    print(f"Problems: {num_problems}")
    print("=" * 50)

    # Create environment
    env = ReasoningEnvironment(
        task_type=TaskType(task_type),
        difficulty=Difficulty(difficulty),
    )
    await env.initialize()

    # Create agent
    runtime = None
    if use_llm:
        try:
            from elizaos.runtime import AgentRuntime
            from elizaos_plugin_openai import get_openai_plugin

            runtime = AgentRuntime(plugins=[get_openai_plugin()])
            await runtime.initialize()
            print("✅ LLM initialized")
        except ImportError:
            print("⚠️ LLM plugins not available")
            use_llm = False
        except Exception as e:
            print(f"⚠️ Failed to initialize LLM: {e}")
            use_llm = False

    agent = ReasoningAgent(runtime=runtime, use_llm=use_llm)

    print("\n📊 Running evaluation...\n")

    correct = 0
    for i in range(num_problems):
        state = await env.reset()

        # Get agent's response
        while not state.done:
            response = await agent.reason(state)
            state = await env.step(response)

        # Record result
        result = env.get_episode_result()
        agent.record_episode(result)

        status = "✅" if result.is_correct else "❌"
        if result.is_correct:
            correct += 1

        print(f"  {i + 1}. {status} (Attempts: {result.attempts})")

    # Final summary
    print("\n" + "=" * 50)
    print("EVALUATION RESULTS")
    print("=" * 50)
    print(f"Accuracy: {correct}/{num_problems} ({correct/num_problems:.1%})")
    print(agent.get_summary())

    # Cleanup
    await env.close()
    if runtime:
        await runtime.stop()


async def run_interactive_mode(
    task_type: str = "math",
    difficulty: str = "medium",
) -> None:
    """Run interactive problem-solving mode."""
    from elizaos_atropos_reasoning import (
        ReasoningEnvironment,
        Response,
        TaskType,
        Difficulty,
    )

    print("\n🧠 ElizaOS Atropos - Reasoning Gym (Interactive)")
    print("=" * 50)
    print("Commands: type answer, 'hint' for hint, 'skip' to skip, 'quit' to exit")
    print("=" * 50)

    env = ReasoningEnvironment(
        task_type=TaskType(task_type),
        difficulty=Difficulty(difficulty),
    )
    await env.initialize()

    problems_solved = 0
    problems_total = 0

    while True:
        state = await env.reset()
        problems_total += 1

        print(f"\n{'=' * 50}")
        print(f"PROBLEM #{problems_total}")
        print(f"{'=' * 50}")
        print(f"\n{state.problem.question}\n")

        while not state.done:
            try:
                user_input = input("Your answer: ").strip()
            except EOFError:
                user_input = "quit"

            if user_input.lower() == "quit":
                print(f"\n📊 Session: {problems_solved}/{problems_total} solved")
                await env.close()
                return

            if user_input.lower() == "skip":
                print(f"\n💡 Answer was: {state.problem.expected_answer}")
                if state.problem.explanation:
                    print(f"📝 Explanation: {state.problem.explanation}")
                break

            if user_input.lower() == "hint":
                hint = env.get_hint()
                if hint:
                    print(f"\n💡 Hint: {hint}")
                else:
                    print("\n⚠️ No more hints available")
                continue

            # Submit answer
            response = Response(answer=user_input)
            state = await env.step(response)

            print(f"\n{state.feedback}")

            if state.is_correct:
                problems_solved += 1
                print("🎉 Correct!")

        print(f"\n📊 Progress: {problems_solved}/{problems_total} solved")

        try:
            cont = input("\nNext problem? (y/n): ").strip().lower()
        except EOFError:
            cont = "n"

        if cont != "y":
            break

    await env.close()


async def run_benchmark_mode(
    num_problems: int = 50,
    use_llm: bool = False,
) -> None:
    """Run full benchmark across all task types and difficulties."""
    _load_dotenv()

    from elizaos_atropos_reasoning import (
        ReasoningEnvironment,
        ReasoningAgent,
        TaskType,
        Difficulty,
        BenchmarkResult,
    )

    print("\n🧠 ElizaOS Atropos - Reasoning Gym Benchmark")
    print("=" * 60)
    print(f"Problems per category: {num_problems}")
    print("=" * 60)

    # Create agent
    runtime = None
    if use_llm:
        try:
            from elizaos.runtime import AgentRuntime
            from elizaos_plugin_openai import get_openai_plugin

            runtime = AgentRuntime(plugins=[get_openai_plugin()])
            await runtime.initialize()
            print("✅ LLM initialized")
        except ImportError:
            print("⚠️ LLM plugins not available")
            use_llm = False
        except Exception:
            use_llm = False

    agent = ReasoningAgent(runtime=runtime, use_llm=use_llm)

    results: list[BenchmarkResult] = []

    for task_type in [TaskType.MATH, TaskType.LOGIC, TaskType.PUZZLE]:
        for difficulty in [Difficulty.EASY, Difficulty.MEDIUM, Difficulty.HARD]:
            print(f"\n📊 Testing {task_type.value}/{difficulty.value}...")

            env = ReasoningEnvironment(
                task_type=task_type,
                difficulty=difficulty,
            )
            await env.initialize()

            correct = 0
            total_attempts = 0
            total_hints = 0

            for i in range(num_problems):
                state = await env.reset()

                while not state.done:
                    response = await agent.reason(state)
                    state = await env.step(response)

                result = env.get_episode_result()
                if result.is_correct:
                    correct += 1
                total_attempts += result.attempts
                total_hints += result.hints_used

            results.append(BenchmarkResult(
                task_type=task_type,
                difficulty=difficulty,
                total_problems=num_problems,
                correct=correct,
                total_attempts=total_attempts,
                total_hints=total_hints,
            ))

            print(f"  {correct}/{num_problems} ({correct/num_problems:.1%})")

            await env.close()

    # Summary table
    print("\n" + "=" * 70)
    print("BENCHMARK RESULTS")
    print("=" * 70)
    print(f"{'Category':<20} {'Easy':>12} {'Medium':>12} {'Hard':>12}")
    print("-" * 70)

    for task_type in [TaskType.MATH, TaskType.LOGIC, TaskType.PUZZLE]:
        type_results = [r for r in results if r.task_type == task_type]
        easy = next((r for r in type_results if r.difficulty == Difficulty.EASY), None)
        med = next((r for r in type_results if r.difficulty == Difficulty.MEDIUM), None)
        hard = next((r for r in type_results if r.difficulty == Difficulty.HARD), None)

        print(
            f"{task_type.value:<20} "
            f"{easy.accuracy if easy else 0:>11.1%} "
            f"{med.accuracy if med else 0:>11.1%} "
            f"{hard.accuracy if hard else 0:>11.1%}"
        )

    # Overall
    total_correct = sum(r.correct for r in results)
    total_problems = sum(r.total_problems for r in results)
    print("-" * 70)
    print(f"{'OVERALL':<20} {total_correct/total_problems:>36.1%}")
    print("=" * 70)

    if runtime:
        await runtime.stop()


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="ElizaOS Atropos Reasoning Gym Environment",
    )

    parser.add_argument(
        "--mode",
        choices=["eval", "interactive", "benchmark"],
        default="eval",
        help="Mode (default: eval)",
    )
    parser.add_argument(
        "--task",
        choices=["math", "logic", "puzzle", "mixed"],
        default="math",
        help="Task type (default: math)",
    )
    parser.add_argument(
        "--difficulty",
        choices=["easy", "medium", "hard"],
        default="medium",
        help="Difficulty (default: medium)",
    )
    parser.add_argument(
        "--problems",
        type=int,
        default=20,
        help="Number of problems (default: 20)",
    )
    parser.add_argument(
        "--llm",
        action="store_true",
        help="Use LLM for reasoning",
    )

    args = parser.parse_args()

    _load_dotenv()

    if args.llm and not os.environ.get("OPENAI_API_KEY"):
        print("⚠️ OPENAI_API_KEY not set. Falling back to heuristic mode.")
        args.llm = False

    try:
        if args.mode == "eval":
            asyncio.run(run_eval_mode(args.problems, args.task, args.difficulty, args.llm))
        elif args.mode == "interactive":
            asyncio.run(run_interactive_mode(args.task, args.difficulty))
        elif args.mode == "benchmark":
            asyncio.run(run_benchmark_mode(args.problems, args.llm))
    except KeyboardInterrupt:
        print("\n\nGoodbye! 👋")
        sys.exit(0)


if __name__ == "__main__":
    main()
