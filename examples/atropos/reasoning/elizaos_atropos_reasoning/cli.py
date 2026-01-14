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
    candidates: list[Path] = [Path.cwd() / ".env"]
    # Also search upward from this file location (handles running from any cwd).
    for parent in Path(__file__).resolve().parents:
        candidates.append(parent / ".env")

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
    log_trajectories: bool = False,
    trajectory_output: str | None = None,
    trajectory_format: str = "art",
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
            from elizaos.bootstrap import bootstrap_plugin
            from elizaos_plugin_openai import get_openai_plugin

            plugins = [bootstrap_plugin, get_openai_plugin()]

            # Optional: register trajectory logger plugin for end-to-end capture
            if log_trajectories:
                try:
                    from elizaos_plugin_trajectory_logger import get_trajectory_logger_plugin

                    plugins.append(get_trajectory_logger_plugin())
                except ImportError:
                    print("⚠️ Trajectory logger plugin not installed; disabling trajectory logging")
                    log_trajectories = False

            from elizaos_atropos_reasoning.eliza_plugin import (
                create_reasoning_character,
                get_reasoning_eliza_plugin,
            )

            plugins.append(get_reasoning_eliza_plugin())
            runtime = AgentRuntime(character=create_reasoning_character(), plugins=plugins)
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

    traj_svc = None
    if log_trajectories and runtime is not None:
        traj_svc = runtime.get_service("trajectory_logger")
        if traj_svc is None:
            print("⚠️ Trajectory logger service not registered; disabling trajectory logging")
            log_trajectories = False

    correct = 0
    for i in range(num_problems):
        state = await env.reset()
        trajectory_id: str | None = None
        if log_trajectories and traj_svc is not None:
            try:
                trajectory_id = traj_svc.start_trajectory(  # type: ignore[attr-defined]
                    agent_id="reasoning_agent_001",
                    scenario_id=f"atropos:reasoning:{task_type}",
                    episode_id=f"problem_{i:04d}",
                    metadata={
                        "taskType": str(task_type),
                        "difficulty": str(difficulty),
                        "useLLM": bool(use_llm),
                    },
                )
            except Exception:
                trajectory_id = None

        # Get agent's response
        step_num = 0
        while not state.done:
            step_id: str | None = None
            if log_trajectories and traj_svc is not None and trajectory_id is not None:
                try:
                    step_id = traj_svc.start_step(  # type: ignore[attr-defined]
                        trajectory_id,
                        agent_balance=0.0,
                        agent_points=float(state.attempts),
                        custom={
                            "problemIndex": int(i),
                            "stepNumber": int(step_num),
                            "attempts": int(state.attempts),
                            "question": str(state.problem.question)[:2000],
                        },
                    )
                except Exception:
                    step_id = None

            token = None
            if step_id is not None:
                try:
                    from elizaos.trajectory_context import CURRENT_TRAJECTORY_STEP_ID

                    token = CURRENT_TRAJECTORY_STEP_ID.set(step_id)
                except Exception:
                    token = None

            response = await agent.reason(state)
            state = await env.step(response)

            if token is not None:
                try:
                    from elizaos.trajectory_context import CURRENT_TRAJECTORY_STEP_ID

                    CURRENT_TRAJECTORY_STEP_ID.reset(token)
                except Exception:
                    pass

            if (
                log_trajectories
                and traj_svc is not None
                and trajectory_id is not None
                and step_id is not None
            ):
                try:
                    traj_svc.complete_step(  # type: ignore[attr-defined]
                        trajectory_id=trajectory_id,
                        step_id=step_id,
                        action_type="atropos",
                        action_name="reasoning",
                        parameters={"answer": str(response.answer)[:2000]},
                        success=True,
                        reward=float(state.reward),
                        done=bool(state.done),
                        result={
                            "done": bool(state.done),
                            "attempts": int(state.attempts),
                        },
                    )
                except Exception:
                    pass

            step_num += 1

        # Record result
        result = env.get_episode_result()
        agent.record_episode(result)

        status = "✅" if result.is_correct else "❌"
        if result.is_correct:
            correct += 1

        print(f"  {i + 1}. {status} (Attempts: {result.attempts})")

        if log_trajectories and traj_svc is not None and trajectory_id is not None:
            try:
                await traj_svc.end_trajectory(  # type: ignore[attr-defined]
                    trajectory_id,
                    status="completed" if result.is_correct else "terminated",
                    final_metrics={
                        "isCorrect": bool(result.is_correct),
                        "attempts": int(result.attempts),
                    },
                )
            except Exception:
                pass

    # Final summary
    print("\n" + "=" * 50)
    print("EVALUATION RESULTS")
    print("=" * 50)
    print(f"Accuracy: {correct}/{num_problems} ({correct/num_problems:.1%})")
    print(agent.get_summary())

    # Export trajectories if logging was enabled
    if log_trajectories and traj_svc is not None:
        try:
            from elizaos_plugin_trajectory_logger.runtime_service import TrajectoryExportConfig

            export_cfg = TrajectoryExportConfig(
                dataset_name="atropos_reasoning_trajectories",
                export_format=trajectory_format,  # type: ignore[arg-type]
                output_dir=trajectory_output or "./trajectories",
            )
            export_result = traj_svc.export(export_cfg)  # type: ignore[attr-defined]
            print("\n📦 Exported trajectories")
            print(f"   - count: {export_result.trajectories_exported}")
            print(f"   - file: {export_result.dataset_url}")
        except Exception as e:
            print(f"\n⚠️ Trajectory export failed: {e}")

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
    parser.add_argument(
        "--trajectories",
        action="store_true",
        help="Enable trajectory logging for RL training export (requires trajectory logger plugin)",
    )
    parser.add_argument(
        "--trajectory-format",
        choices=["art", "grpo"],
        default="art",
        help="Trajectory export format (art=OpenPipe ART, grpo=GRPO groups)",
    )
    parser.add_argument(
        "--trajectory-output",
        type=str,
        default="./trajectories",
        help="Output directory for trajectory files (default: ./trajectories)",
    )

    args = parser.parse_args()

    _load_dotenv()

    if args.llm and not os.environ.get("OPENAI_API_KEY"):
        print("⚠️ OPENAI_API_KEY not set. Falling back to heuristic mode.")
        args.llm = False

    try:
        if args.mode == "eval":
            asyncio.run(
                run_eval_mode(
                    args.problems,
                    args.task,
                    args.difficulty,
                    args.llm,
                    log_trajectories=args.trajectories,
                    trajectory_output=args.trajectory_output,
                    trajectory_format=args.trajectory_format,
                )
            )
        elif args.mode == "interactive":
            asyncio.run(run_interactive_mode(args.task, args.difficulty))
        elif args.mode == "benchmark":
            asyncio.run(run_benchmark_mode(args.problems, args.llm))
    except KeyboardInterrupt:
        print("\n\nGoodbye! 👋")
        sys.exit(0)


if __name__ == "__main__":
    main()
