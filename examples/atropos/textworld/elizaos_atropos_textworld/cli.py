"""
Command-line interface for TextWorld environment.
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


async def run_auto_mode(
    num_episodes: int = 10,
    difficulty: str = "medium",
    use_llm: bool = False,
    log_trajectories: bool = False,
    trajectory_output: str | None = None,
    trajectory_format: str = "art",
) -> None:
    """Run automatic play mode."""
    _load_dotenv()

    from elizaos_atropos_textworld import (
        TextWorldEnvironment,
        TextWorldAgent,
        GameType,
        Difficulty,
    )

    print("\n📖 ElizaOS Atropos - TextWorld")
    print("=" * 50)
    print(f"Mode: {'LLM-based' if use_llm else 'Heuristic'}")
    print(f"Difficulty: {difficulty}")
    print(f"Episodes: {num_episodes}")
    print("=" * 50)

    # Create environment
    env = TextWorldEnvironment(
        game_type=GameType.TREASURE_HUNT,
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

            from elizaos_atropos_textworld.eliza_plugin import (
                create_textworld_character,
                get_textworld_eliza_plugin,
            )

            plugins.append(get_textworld_eliza_plugin())
            runtime = AgentRuntime(character=create_textworld_character(), plugins=plugins)
            await runtime.initialize()
            print("✅ LLM initialized")
        except ImportError:
            print("⚠️ LLM plugins not available, using heuristics")
            use_llm = False
        except Exception as e:
            print(f"⚠️ Failed to initialize LLM: {e}")
            use_llm = False

    agent = TextWorldAgent(runtime=runtime, use_llm=use_llm)

    print("\n📊 Running episodes...\n")

    traj_svc = None
    if log_trajectories and runtime is not None:
        traj_svc = runtime.get_service("trajectory_logger")
        if traj_svc is None:
            print("⚠️ Trajectory logger service not registered; disabling trajectory logging")
            log_trajectories = False

    for i in range(num_episodes):
        # Start trajectory for this episode
        trajectory_id: str | None = None
        if log_trajectories and traj_svc is not None:
            try:
                trajectory_id = traj_svc.start_trajectory(  # type: ignore[attr-defined]
                    agent_id="textworld_agent_001",
                    scenario_id="atropos:textworld",
                    episode_id=f"ep_{i:04d}",
                    metadata={
                        "difficulty": difficulty,
                        "useLLM": bool(use_llm),
                    },
                )
            except Exception:
                trajectory_id = None

        # Manual episode loop so we can log per-step
        state = await env.reset()
        done = False
        total_reward = 0.0
        step_num = 0

        while not done:
            step_id: str | None = None
            if log_trajectories and traj_svc is not None and trajectory_id is not None:
                try:
                    step_id = traj_svc.start_step(  # type: ignore[attr-defined]
                        trajectory_id,
                        agent_balance=total_reward,
                        agent_points=float(state.score),
                        custom={
                            "stepNumber": step_num,
                            "score": int(state.score),
                            "maxScore": int(state.max_score),
                            "location": str(state.location)[:2000],
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

            action = await agent.decide(state, trajectory_step_id=step_id)

            if token is not None:
                try:
                    from elizaos.trajectory_context import CURRENT_TRAJECTORY_STEP_ID

                    CURRENT_TRAJECTORY_STEP_ID.reset(token)
                except Exception:
                    pass

            step_result = await env.step(action)
            state = step_result.state
            done = step_result.done
            reward = float(step_result.reward)
            total_reward += reward

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
                        action_name="textworld",
                        parameters={"command": str(action)[:2000]},
                        success=True,
                        reward=reward,
                        done=bool(done),
                        result={
                            "reward": reward,
                            "done": bool(done),
                            "score": int(state.score),
                            "maxScore": int(state.max_score),
                        },
                    )
                except Exception:
                    pass

            step_num += 1
            if step_num >= int(state.max_steps):
                break

        # Build canonical episode result for stats
        result = env.get_episode_result()
        agent.record_episode(result)

        if log_trajectories and traj_svc is not None and trajectory_id is not None:
            try:
                status = "completed" if result.won else "terminated"
                await traj_svc.end_trajectory(  # type: ignore[attr-defined]
                    trajectory_id,
                    status=status,
                    final_metrics={
                        "won": bool(result.won),
                        "score": int(result.score),
                        "maxScore": int(result.max_score),
                        "stepsTaken": int(result.steps),
                    },
                )
            except Exception:
                pass

        status_text = "✅ WON" if result.won else "❌ Lost"
        print(
            f"  Episode {i + 1}: {status_text} | "
            f"Score: {result.score}/{result.max_score} | Steps: {result.steps}"
        )

    # Final summary
    print("\n" + "=" * 50)
    print("FINAL RESULTS")
    print("=" * 50)
    print(agent.get_summary())

    # Export trajectories if logging was enabled
    if log_trajectories and traj_svc is not None:
        try:
            from elizaos_plugin_trajectory_logger.runtime_service import TrajectoryExportConfig

            export_cfg = TrajectoryExportConfig(
                dataset_name="atropos_textworld_trajectories",
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


async def run_interactive_mode(difficulty: str = "medium") -> None:
    """Run interactive play mode."""
    from elizaos_atropos_textworld import (
        TextWorldEnvironment,
        GameType,
        Difficulty,
    )

    print("\n📖 ElizaOS Atropos - TextWorld (Interactive)")
    print("=" * 50)
    print("Commands: type any action, or 'quit' to exit")
    print("=" * 50)

    env = TextWorldEnvironment(
        game_type=GameType.TREASURE_HUNT,
        difficulty=Difficulty(difficulty),
    )
    await env.initialize()
    state = await env.reset()

    print(f"\n{state.description}")
    print(f"\n📊 Score: {state.score}/{state.max_score} | Steps: {state.steps}/{state.max_steps}")

    while not state.game_over:
        # Show available commands
        print("\n📋 Available commands:")
        for cmd in state.admissible_commands[:15]:
            print(f"  - {cmd}")
        if len(state.admissible_commands) > 15:
            print(f"  ... and {len(state.admissible_commands) - 15} more")

        try:
            action = input("\n> ").strip()
        except EOFError:
            break

        if action.lower() in ("quit", "q", "exit"):
            break

        if not action:
            continue

        result = await env.step(action)
        state = result.state

        print(f"\n{result.feedback}")
        print(f"\n📊 Score: {state.score}/{state.max_score} | Steps: {state.steps}/{state.max_steps}")

    # Game over
    if state.won:
        print("\n🎉 Congratulations! You won!")
    else:
        print("\n😢 Game over!")

    print(f"Final Score: {state.score}/{state.max_score}")

    await env.close()


async def run_benchmark_mode(num_episodes: int = 100, difficulty: str = "medium") -> None:
    """Run benchmark comparing strategies."""
    from elizaos_atropos_textworld import (
        TextWorldEnvironment,
        TextWorldAgent,
        GameType,
        Difficulty,
    )
    from elizaos_atropos_textworld.agent import create_heuristic_policy, create_random_policy

    print("\n📖 ElizaOS Atropos - TextWorld Benchmark")
    print("=" * 50)
    print(f"Episodes per strategy: {num_episodes}")
    print(f"Difficulty: {difficulty}")
    print("=" * 50)

    env = TextWorldEnvironment(
        game_type=GameType.TREASURE_HUNT,
        difficulty=Difficulty(difficulty),
    )
    await env.initialize()

    strategies = [
        ("Heuristic", create_heuristic_policy),
        ("Random", create_random_policy),
    ]

    results = []

    for name, policy in strategies:
        print(f"\n📊 Testing: {name}")
        agent = TextWorldAgent(use_llm=False)

        for i in range(num_episodes):
            result = await env.play_episode(policy)
            agent.record_episode(result)

            if (i + 1) % (num_episodes // 5) == 0:
                print(f"  {i + 1}/{num_episodes}: {agent.stats}")

        results.append((name, agent.stats))

    # Summary table
    print("\n" + "=" * 60)
    print("BENCHMARK RESULTS")
    print("=" * 60)
    print(f"{'Strategy':<20} {'Win Rate':>10} {'Avg Completion':>15} {'Avg Steps':>12}")
    print("-" * 60)

    for name, stats in results:
        print(f"{name:<20} {stats.win_rate:>9.1%} {stats.avg_completion:>14.1%} {stats.avg_steps:>11.1f}")

    print("=" * 60)

    await env.close()


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="ElizaOS Atropos TextWorld Environment",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  elizaos-textworld --mode auto              # Watch AI play
  elizaos-textworld --mode interactive       # Play interactively
  elizaos-textworld --mode benchmark         # Compare strategies
  elizaos-textworld --difficulty hard        # Play hard difficulty
        """,
    )

    parser.add_argument(
        "--mode",
        choices=["auto", "interactive", "benchmark"],
        default="auto",
        help="Game mode (default: auto)",
    )
    parser.add_argument(
        "--episodes",
        type=int,
        default=10,
        help="Number of episodes (default: 10)",
    )
    parser.add_argument(
        "--difficulty",
        choices=["easy", "medium", "hard"],
        default="medium",
        help="Game difficulty (default: medium)",
    )
    parser.add_argument(
        "--llm",
        action="store_true",
        help="Use LLM for decisions (requires OPENAI_API_KEY)",
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
        if args.mode == "auto":
            asyncio.run(
                run_auto_mode(
                    args.episodes,
                    args.difficulty,
                    args.llm,
                    log_trajectories=args.trajectories,
                    trajectory_output=args.trajectory_output,
                    trajectory_format=args.trajectory_format,
                )
            )
        elif args.mode == "interactive":
            asyncio.run(run_interactive_mode(args.difficulty))
        elif args.mode == "benchmark":
            asyncio.run(run_benchmark_mode(args.episodes, args.difficulty))
    except KeyboardInterrupt:
        print("\n\nGoodbye! 👋")
        sys.exit(0)


if __name__ == "__main__":
    main()
