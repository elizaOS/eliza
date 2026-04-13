"""
Command-line interface for Blackjack environment.
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
    num_episodes: int = 100,
    use_llm: bool = False,
    log_trajectories: bool = False,
    trajectory_output: str | None = None,
) -> None:
    """Run automatic play mode with optional trajectory logging."""
    _load_dotenv()

    from elizaos_atropos_blackjack import BlackjackAgent, BlackjackEnvironment
    from elizaos_atropos_blackjack.types import EpisodeResult

    print("\n🃏 ElizaOS Atropos - Blackjack")
    print("=" * 40)
    print(f"Mode: {'LLM-based' if use_llm else 'Optimal Strategy'}")
    print(f"Episodes: {num_episodes}")
    if log_trajectories:
        print(f"Trajectories: Enabled")
    print("=" * 40)

    # Create environment
    env = BlackjackEnvironment()
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

            from elizaos_atropos_blackjack.eliza_plugin import (
                create_blackjack_character,
                get_blackjack_eliza_plugin,
            )

            plugins.append(get_blackjack_eliza_plugin())
            runtime = AgentRuntime(character=create_blackjack_character(), plugins=plugins)
            await runtime.initialize()
            print("✅ LLM initialized")
        except ImportError:
            print("⚠️ LLM plugins not available, using optimal strategy")
            use_llm = False
        except Exception as e:
            print(f"⚠️ Failed to initialize LLM: {e}")
            use_llm = False

    agent = BlackjackAgent(runtime=runtime, use_llm=use_llm)
    agent_id = "blackjack_agent_001"

    print("\n📊 Running episodes...\n")

    # Optional: get trajectory logger runtime service
    traj_svc = None
    if log_trajectories and runtime is not None:
        traj_svc = runtime.get_service("trajectory_logger")
        if traj_svc is None:
            print("⚠️ Trajectory logger service not registered; disabling trajectory logging")
            log_trajectories = False

    # Play episodes
    for i in range(num_episodes):
        trajectory_id: str | None = None
        if log_trajectories and traj_svc is not None:
            try:
                trajectory_id = traj_svc.start_trajectory(  # type: ignore[attr-defined]
                    agent_id=agent_id,
                    scenario_id="atropos:blackjack",
                    episode_id=f"ep_{i:04d}",
                    metadata={
                        "episodeNum": i,
                        "useLLM": bool(use_llm),
                    },
                )
            except Exception:
                trajectory_id = None

        state = await env.reset()
        done = False
        total_reward = 0.0
        action_history: list = []
        step_num = 0

        while not done:
            step_id: str | None = None
            if log_trajectories and traj_svc is not None and trajectory_id is not None:
                try:
                    step_id = traj_svc.start_step(  # type: ignore[attr-defined]
                        trajectory_id,
                        agent_balance=total_reward,
                        agent_points=float(state.player_sum),
                        agent_pnl=0.0,
                        open_positions=0,
                        custom={
                            "stepNumber": step_num,
                            "playerSum": int(state.player_sum),
                            "dealerCard": int(state.dealer_card),
                            "usableAce": bool(state.usable_ace),
                        },
                    )
                except Exception:
                    step_id = None

            # Set trajectory step context so runtime logs LLM calls
            token = None
            if step_id is not None:
                try:
                    from elizaos.trajectory_context import CURRENT_TRAJECTORY_STEP_ID

                    token = CURRENT_TRAJECTORY_STEP_ID.set(step_id)
                except Exception:
                    token = None

            # Decide action (canonical ElizaOS pipeline)
            action = await agent.decide(
                state,
                env.get_available_actions(),
                trajectory_step_id=step_id,
            )

            if token is not None:
                try:
                    from elizaos.trajectory_context import CURRENT_TRAJECTORY_STEP_ID

                    CURRENT_TRAJECTORY_STEP_ID.reset(token)
                except Exception:
                    pass

            # Execute action
            step_result = await env.step(action)
            done = step_result.done
            reward = step_result.reward
            total_reward += reward
            action_history.append(action)

            # Complete trajectory step with environment outcome
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
                        action_name="blackjack",
                        parameters={"action": str(action.value)},
                        success=True,
                        reward=float(reward),
                        done=bool(done),
                        result={
                            "playerSum": int(step_result.state.player_sum),
                            "dealerCard": int(step_result.state.dealer_card),
                            "reward": float(reward),
                        },
                    )
                except Exception:
                    pass

            state = step_result.state
            step_num += 1

        # End trajectory
        if log_trajectories and traj_svc is not None and trajectory_id is not None:
            try:
                status = "completed" if total_reward > 0 else "terminated"
                await traj_svc.end_trajectory(  # type: ignore[attr-defined]
                    trajectory_id,
                    status=status,
                    final_metrics={
                        "totalReward": float(total_reward),
                        "stepsTaken": int(step_num),
                        "won": bool(total_reward > 0),
                    },
                )
            except Exception:
                pass

        # Record episode in agent stats (use canonical EpisodeResult type)
        agent.record_episode(
            EpisodeResult(
                reward=float(step_result.reward),
                num_steps=len(action_history),
                final_state=state,
                action_history=list(action_history),
                won=float(step_result.reward) > 0,
                is_blackjack=float(step_result.reward) == 1.5,
                is_bust=state.player_sum > 21,
            )
        )

        # Show progress every 10%
        if (i + 1) % max(1, num_episodes // 10) == 0:
            print(f"  Progress: {i + 1}/{num_episodes} | {agent.stats}")

    # Final summary
    print("\n" + "=" * 40)
    print("FINAL RESULTS")
    print("=" * 40)
    print(agent.get_summary())

    # Export trajectories if logging was enabled
    if log_trajectories and traj_svc is not None:
        try:
            from elizaos_plugin_trajectory_logger.runtime_service import TrajectoryExportConfig

            export_cfg = TrajectoryExportConfig(
                dataset_name="atropos_blackjack_trajectories",
                export_format="art",
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


async def run_interactive_mode(use_llm: bool = False) -> None:
    """Run interactive play mode."""
    from elizaos_atropos_blackjack import BlackjackEnvironment, BlackjackAction
    from elizaos_atropos_blackjack.strategy import BasicStrategy

    print("\n🃏 ElizaOS Atropos - Blackjack (Interactive)")
    print("=" * 40)
    print("Commands: h=hit, s=stand, q=quit, r=reset")
    print("=" * 40)

    env = BlackjackEnvironment()
    await env.initialize()

    wins, losses, draws = 0, 0, 0

    while True:
        state = await env.reset()
        print("\n" + env.format_state())

        # Show optimal play hint
        optimal = BasicStrategy.get_action(state)
        print(f"💡 Basic strategy suggests: {'HIT' if optimal == BlackjackAction.HIT else 'STAND'}")

        done = False
        while not done:
            try:
                cmd = input("\nYour action (h/s/q/r): ").strip().lower()
            except EOFError:
                cmd = "q"

            if cmd == "q":
                print(f"\n📊 Session: {wins}W / {losses}L / {draws}D")
                await env.close()
                return
            elif cmd == "r":
                print("🔄 Resetting hand...")
                break
            elif cmd in ("h", "hit"):
                action = BlackjackAction.HIT
            elif cmd in ("s", "stand"):
                action = BlackjackAction.STICK
            else:
                print("Invalid command. Use h=hit, s=stand, q=quit, r=reset")
                continue

            result = await env.step(action)
            done = result.done

            if not done:
                print("\n" + env.format_state())
                optimal = BasicStrategy.get_action(result.state)
                print(f"💡 Basic strategy suggests: {'HIT' if optimal == BlackjackAction.HIT else 'STAND'}")
            else:
                print("\n" + env.format_state())
                if result.reward > 0:
                    wins += 1
                    if result.reward == 1.5:
                        print("🎉 BLACKJACK! You win 1.5x!")
                    else:
                        print("✅ You WIN!")
                elif result.reward < 0:
                    losses += 1
                    if result.state.player_sum > 21:
                        print("💥 BUST! You lose.")
                    else:
                        print("❌ You LOSE.")
                else:
                    draws += 1
                    print("🤝 PUSH (Draw)")

                print(f"📊 Session: {wins}W / {losses}L / {draws}D")


async def run_benchmark_mode(num_episodes: int = 10000) -> None:
    """Run benchmark comparing strategies."""
    from elizaos_atropos_blackjack import BlackjackEnvironment, BlackjackAgent
    from elizaos_atropos_blackjack.agent import create_optimal_policy, create_random_policy
    from elizaos_atropos_blackjack.strategy import SimpleStrategy, ConservativeStrategy, AggressiveStrategy

    print("\n🃏 ElizaOS Atropos - Blackjack Benchmark")
    print("=" * 50)
    print(f"Episodes per strategy: {num_episodes}")
    print("=" * 50)

    env = BlackjackEnvironment()
    await env.initialize()

    strategies = [
        ("Basic Strategy (Optimal)", create_optimal_policy),
        ("Simple (Stand on 17+)", lambda s, a: SimpleStrategy.get_action(s)),
        ("Conservative (Stand on 15+)", lambda s, a: ConservativeStrategy.get_action(s)),
        ("Aggressive (Stand on 19+)", lambda s, a: AggressiveStrategy.get_action(s)),
        ("Random", create_random_policy),
    ]

    results = []

    for name, policy in strategies:
        print(f"\n📊 Testing: {name}")
        agent = BlackjackAgent(use_llm=False)

        for i in range(num_episodes):
            # Wrap sync policies in async
            if asyncio.iscoroutinefunction(policy):
                result = await env.play_episode(policy)
            else:
                async def async_policy(s, a, p=policy):
                    return p(s, a)
                result = await env.play_episode(async_policy)
            agent.record_episode(result)

            if (i + 1) % (num_episodes // 5) == 0:
                print(f"  {i + 1}/{num_episodes}: {agent.stats}")

        results.append((name, agent.stats))

    # Summary table
    print("\n" + "=" * 60)
    print("BENCHMARK RESULTS")
    print("=" * 60)
    print(f"{'Strategy':<30} {'Win%':>8} {'Loss%':>8} {'Avg Reward':>12}")
    print("-" * 60)

    for name, stats in results:
        print(f"{name:<30} {stats.win_rate:>7.1%} {stats.loss_rate:>7.1%} {stats.average_reward:>11.4f}")

    print("=" * 60)

    await env.close()


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="ElizaOS Atropos Blackjack Environment",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  elizaos-blackjack --mode auto             # Watch AI play 100 hands
  elizaos-blackjack --mode interactive      # Play interactively
  elizaos-blackjack --mode benchmark        # Compare strategies
  elizaos-blackjack --mode auto --llm       # Use LLM for decisions
  elizaos-blackjack --trajectories          # Export trajectories for RL training
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
        default=100,
        help="Number of episodes for auto/benchmark mode (default: 100)",
    )
    parser.add_argument(
        "--llm",
        action="store_true",
        help="Use LLM for decisions (requires OPENAI_API_KEY)",
    )
    parser.add_argument(
        "--trajectories",
        action="store_true",
        help="Enable trajectory logging for RL training export",
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
        print("⚠️ OPENAI_API_KEY not set. LLM mode requires this environment variable.")
        print("   Falling back to optimal strategy mode.")
        args.llm = False

    try:
        if args.mode == "auto":
            asyncio.run(run_auto_mode(
                args.episodes,
                args.llm,
                log_trajectories=args.trajectories,
                trajectory_output=args.trajectory_output,
            ))
        elif args.mode == "interactive":
            asyncio.run(run_interactive_mode(args.llm))
        elif args.mode == "benchmark":
            asyncio.run(run_benchmark_mode(args.episodes))
    except KeyboardInterrupt:
        print("\n\nGoodbye! 👋")
        sys.exit(0)


if __name__ == "__main__":
    main()
