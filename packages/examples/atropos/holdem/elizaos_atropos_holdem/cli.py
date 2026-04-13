"""
Command-line interface for Texas Hold'em environment.
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
    num_hands: int = 100,
    num_players: int = 2,
    use_llm: bool = False,
    log_trajectories: bool = False,
    trajectory_output: str | None = None,
    trajectory_format: str = "art",
) -> None:
    """Run automatic play mode."""
    _load_dotenv()

    from elizaos_atropos_holdem import HoldemEnvironment, HoldemAgent

    print("\n🃏 ElizaOS Atropos - Texas Hold'em")
    print("=" * 50)
    print(f"Mode: {'LLM-based' if use_llm else 'Heuristic'}")
    print(f"Players: {num_players}")
    print(f"Hands: {num_hands}")
    print("=" * 50)

    # Create environment
    env = HoldemEnvironment(
        num_players=num_players,
        starting_stack=1000,
        small_blind=5,
        big_blind=10,
    )
    await env.initialize()

    # Create agents
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

            runtime = AgentRuntime(plugins=plugins)
            from elizaos_atropos_holdem.eliza_plugin import (
                create_holdem_character,
                get_holdem_eliza_plugin,
            )

            plugins.append(get_holdem_eliza_plugin())
            runtime = AgentRuntime(character=create_holdem_character(), plugins=plugins)
            await runtime.initialize()
            print("✅ LLM initialized")
        except ImportError:
            print("⚠️ LLM plugins not available, using heuristics")
            use_llm = False
        except Exception as e:
            print(f"⚠️ Failed to initialize LLM: {e}")
            use_llm = False

    agents = [
        HoldemAgent(runtime=runtime, position=i, use_llm=use_llm)
        for i in range(num_players)
    ]

    print("\n📊 Playing hands...\n")

    traj_svc = None
    if log_trajectories and runtime is not None:
        traj_svc = runtime.get_service("trajectory_logger")
        if traj_svc is None:
            print("⚠️ Trajectory logger service not registered; disabling trajectory logging")
            log_trajectories = False

    for hand_num in range(num_hands):
        trajectory_id: str | None = None
        if log_trajectories and traj_svc is not None:
            try:
                trajectory_id = traj_svc.start_trajectory(  # type: ignore[attr-defined]
                    agent_id="holdem_table",
                    scenario_id="atropos:holdem",
                    episode_id=f"hand_{hand_num:04d}",
                    metadata={
                        "players": int(num_players),
                        "useLLM": bool(use_llm),
                    },
                )
            except Exception:
                trajectory_id = None

        state = await env.reset()
        step_num = 0

        # Play until hand is over
        while not state.hand_over:
            current_pos = state.current_player
            step_id: str | None = None
            if log_trajectories and traj_svc is not None and trajectory_id is not None:
                try:
                    step_id = traj_svc.start_step(  # type: ignore[attr-defined]
                        trajectory_id,
                        agent_balance=float(state.stacks.get(current_pos, 0)),
                        agent_points=float(state.pot),
                        custom={
                            "handNumber": int(hand_num),
                            "stepNumber": int(step_num),
                            "currentPlayer": int(current_pos),
                            "pot": float(state.pot),
                            "stage": str(state.stage)[:2000],
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

            action = await agents[current_pos].decide(state, trajectory_step_id=step_id)
            state = await env.step(action)

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
                        action_name="holdem",
                        parameters={"action": str(action)[:2000], "player": int(current_pos)},
                        success=True,
                        reward=0.0,
                        done=bool(state.hand_over),
                        result={"handOver": bool(state.hand_over), "pot": float(state.pot)},
                    )
                except Exception:
                    pass

            step_num += 1

        # Record results
        result = env.get_hand_result()
        for i, agent in enumerate(agents):
            profit = result.payouts.get(i, 0)
            won = i in result.winners
            agent.record_result(profit, won, state.pot if won else 0)

        if log_trajectories and traj_svc is not None and trajectory_id is not None:
            try:
                await traj_svc.end_trajectory(  # type: ignore[attr-defined]
                    trajectory_id,
                    status="completed",
                    final_metrics={
                        "handNumber": int(hand_num),
                        "winners": str(result.winners)[:2000],
                        "pot": float(state.pot),
                    },
                )
            except Exception:
                pass

        # Show progress
        if (hand_num + 1) % max(1, num_hands // 10) == 0:
            print(f"  Hand {hand_num + 1}/{num_hands}")
            for agent in agents:
                print(f"    P{agent.position}: {agent.stats}")

    # Final summary
    print("\n" + "=" * 50)
    print("FINAL RESULTS")
    print("=" * 50)
    for agent in agents:
        print(agent.get_summary())
        print()

    # Export trajectories if logging was enabled
    if log_trajectories and traj_svc is not None:
        try:
            from elizaos_plugin_trajectory_logger.runtime_service import TrajectoryExportConfig

            export_cfg = TrajectoryExportConfig(
                dataset_name="atropos_holdem_trajectories",
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


async def run_interactive_mode(num_players: int = 2) -> None:
    """Run interactive play mode."""
    from elizaos_atropos_holdem import (
        HoldemEnvironment,
        HoldemAgent,
        Action,
        ActionType,
    )

    print("\n🃏 ElizaOS Atropos - Texas Hold'em (Interactive)")
    print("=" * 50)
    print("You are Player 0")
    print("Commands: f=fold, c=check/call, r=raise, a=all-in, q=quit")
    print("=" * 50)

    env = HoldemEnvironment(
        num_players=num_players,
        starting_stack=1000,
        small_blind=5,
        big_blind=10,
    )
    await env.initialize()

    # Create AI opponents
    agents = [
        HoldemAgent(position=i, use_llm=False)
        for i in range(1, num_players)
    ]

    hand_num = 0

    while True:
        hand_num += 1
        print(f"\n{'=' * 50}")
        print(f"HAND #{hand_num}")
        print(f"{'=' * 50}")

        state = await env.reset()

        while not state.hand_over:
            print(f"\n{env.format_state(player_position=0)}")

            current_pos = state.current_player

            if current_pos == 0:
                # Human player's turn
                valid_actions = state.get_valid_actions()
                print("\nYour actions:")
                for i, action in enumerate(valid_actions):
                    print(f"  {i + 1}. {action}")

                try:
                    cmd = input("\nYour action: ").strip().lower()
                except EOFError:
                    cmd = "q"

                if cmd == "q":
                    print(f"\nSession ended after {hand_num} hands.")
                    await env.close()
                    return

                # Parse command
                action = None
                if cmd in ("f", "fold"):
                    action = Action(ActionType.FOLD)
                elif cmd in ("c", "check", "call"):
                    for a in valid_actions:
                        if a.action_type in (ActionType.CHECK, ActionType.CALL):
                            action = a
                            break
                elif cmd in ("r", "raise"):
                    for a in valid_actions:
                        if a.action_type == ActionType.RAISE:
                            action = a
                            break
                elif cmd in ("a", "all", "allin"):
                    for a in valid_actions:
                        if a.action_type == ActionType.ALL_IN:
                            action = a
                            break
                elif cmd.isdigit():
                    idx = int(cmd) - 1
                    if 0 <= idx < len(valid_actions):
                        action = valid_actions[idx]

                if action is None:
                    action = Action(ActionType.FOLD)
                    print("Invalid action, folding.")

                print(f"You: {action}")
            else:
                # AI turn
                agent = agents[current_pos - 1]
                action = await agent.decide(state)
                print(f"Player {current_pos}: {action}")

            state = await env.step(action)

        # Show result
        result = env.get_hand_result()
        print(f"\n{'=' * 50}")
        print("HAND RESULT")
        print(f"{'=' * 50}")
        print(env.format_state(player_position=0))
        print(f"\n{result}")

        your_profit = result.payouts.get(0, 0)
        print(f"\nYour profit: {your_profit:+d}")

        try:
            input("\nPress Enter for next hand...")
        except EOFError:
            break

    await env.close()


async def run_tournament_mode(
    num_players: int = 6,
    num_hands: int = 500,
) -> None:
    """Run tournament simulation."""
    from elizaos_atropos_holdem import HoldemEnvironment, HoldemAgent

    print("\n🃏 ElizaOS Atropos - Hold'em Tournament")
    print("=" * 50)
    print(f"Players: {num_players}")
    print(f"Hands: {num_hands}")
    print("=" * 50)

    env = HoldemEnvironment(
        num_players=num_players,
        starting_stack=1000,
        small_blind=5,
        big_blind=10,
    )
    await env.initialize()

    # Create agents with different styles
    styles = ["balanced", "tight", "aggressive", "loose", "balanced", "tight"]
    agents = [
        HoldemAgent(position=i, use_llm=False, style=styles[i % len(styles)])
        for i in range(num_players)
    ]

    print("\n📊 Tournament in progress...\n")

    for hand_num in range(num_hands):
        state = await env.reset()

        while not state.hand_over:
            current_pos = state.current_player
            action = await agents[current_pos].decide(state)
            state = await env.step(action)

        result = env.get_hand_result()
        for i, agent in enumerate(agents):
            profit = result.payouts.get(i, 0)
            won = i in result.winners
            agent.record_result(profit, won, state.pot if won else 0)

        if (hand_num + 1) % (num_hands // 5) == 0:
            print(f"  Progress: {hand_num + 1}/{num_hands}")

    # Final standings
    print("\n" + "=" * 60)
    print("TOURNAMENT RESULTS")
    print("=" * 60)

    # Sort by profit
    sorted_agents = sorted(agents, key=lambda a: a.stats.total_profit, reverse=True)

    print(f"{'Rank':<6} {'Player':<10} {'Style':<12} {'Profit':>10} {'Win Rate':>10}")
    print("-" * 60)

    for rank, agent in enumerate(sorted_agents, 1):
        medal = "🥇" if rank == 1 else "🥈" if rank == 2 else "🥉" if rank == 3 else "  "
        print(
            f"{medal}{rank:<4} P{agent.position:<9} {agent._style:<12} "
            f"{agent.stats.total_profit:>+10} {agent.stats.win_rate:>9.1%}"
        )

    print("=" * 60)

    await env.close()


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="ElizaOS Atropos Texas Hold'em Environment",
    )

    parser.add_argument(
        "--mode",
        choices=["auto", "interactive", "tournament"],
        default="auto",
        help="Game mode (default: auto)",
    )
    parser.add_argument(
        "--players",
        type=int,
        default=2,
        help="Number of players (default: 2)",
    )
    parser.add_argument(
        "--hands",
        type=int,
        default=100,
        help="Number of hands (default: 100)",
    )
    parser.add_argument(
        "--llm",
        action="store_true",
        help="Use LLM for decisions",
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
                    args.hands,
                    args.players,
                    args.llm,
                    log_trajectories=args.trajectories,
                    trajectory_output=args.trajectory_output,
                    trajectory_format=args.trajectory_format,
                )
            )
        elif args.mode == "interactive":
            asyncio.run(run_interactive_mode(args.players))
        elif args.mode == "tournament":
            asyncio.run(run_tournament_mode(args.players, args.hands))
    except KeyboardInterrupt:
        print("\n\nGoodbye! 👋")
        sys.exit(0)


if __name__ == "__main__":
    main()
