"""
Command-line interface for Diplomacy environment.
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
        # repo_root/examples/atropos/diplomacy/elizaos_atropos_diplomacy/cli.py -> repo_root is parents[4]
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


async def run_auto_mode(
    max_years: int = 10,
    press_mode: bool = False,
    *,
    log_trajectories: bool = False,
    trajectory_output: str | None = None,
    trajectory_format: str = "art",
) -> None:
    """Run automatic play mode with AI agents."""
    _load_dotenv()

    from elizaos_atropos_diplomacy import DiplomacyEnvironment, DiplomacyAgent, Power

    print("\n🌍 ElizaOS Atropos - Diplomacy")
    print("=" * 50)
    print(f"Mode: {'Press (with negotiation)' if press_mode else 'No-Press'}")
    print(f"Max years: {max_years}")
    print("=" * 50)

    # Create environment
    env = DiplomacyEnvironment(press_mode=press_mode, max_years=max_years)
    await env.initialize()

    # Create agents for each power
    agents: dict[Power, DiplomacyAgent] = {}
    runtime = None

    # Try to use LLM
    use_llm = False
    if os.environ.get("OPENAI_API_KEY"):
        try:
            from elizaos.runtime import AgentRuntime
            from elizaos.bootstrap import bootstrap_plugin
            from elizaos_plugin_openai import get_openai_plugin

            from elizaos_atropos_diplomacy.eliza_plugin import (
                create_diplomacy_character,
                get_diplomacy_eliza_plugin,
            )

            plugins = [bootstrap_plugin, get_openai_plugin(), get_diplomacy_eliza_plugin()]

            if log_trajectories:
                try:
                    from elizaos_plugin_trajectory_logger import get_trajectory_logger_plugin

                    plugins.append(get_trajectory_logger_plugin())
                except ImportError:
                    print("⚠️ Trajectory logger plugin not installed; disabling trajectory logging")
                    log_trajectories = False

            runtime = AgentRuntime(character=create_diplomacy_character(), plugins=plugins)
            await runtime.initialize()
            use_llm = True
            print("✅ LLM initialized - using intelligent agents")
        except ImportError:
            print("⚠️ LLM plugins not available - using heuristic agents")
        except Exception as e:
            print(f"⚠️ LLM init failed: {e} - using heuristic agents")
    else:
        print("⚠️ No OPENAI_API_KEY - using heuristic agents")

    for power in Power:
        agents[power] = DiplomacyAgent(
            runtime=runtime,
            power=power,
            use_llm=use_llm,
        )

    traj_svc = None
    trajectories_by_power: dict[Power, str] = {}
    if log_trajectories and runtime is not None:
        traj_svc = runtime.get_service("trajectory_logger")
        if traj_svc is None:
            print("⚠️ Trajectory logger service not registered; disabling trajectory logging")
            log_trajectories = False
        else:
            for power in Power:
                try:
                    trajectories_by_power[power] = traj_svc.start_trajectory(  # type: ignore[attr-defined]
                        agent_id=f"diplomacy_{power.value}",
                        scenario_id=f"atropos:diplomacy:{power.value}",
                        episode_id="game",
                        metadata={"power": power.value, "pressMode": bool(press_mode)},
                    )
                except Exception:
                    pass

    print("\n🎮 Starting game...")
    print("-" * 50)

    # Game loop
    while not env.is_game_over():
        state = env.get_state()
        print(f"\n📅 {state.phase_name}")

        # Negotiation phase (if press mode)
        all_messages = []
        if press_mode and state.phase.value == "MOVEMENT":
            print("  📨 Negotiation round...")
            for power in state.active_powers:
                messages = await agents[power].negotiate(state, all_messages)
                all_messages.extend(messages)
                for msg in messages:
                    print(f"    {msg}")

        # Order submission
        orders = {}
        for power in state.active_powers:
            step_id: str | None = None
            trajectory_id: str | None = trajectories_by_power.get(power)
            if log_trajectories and traj_svc is not None and trajectory_id is not None:
                try:
                    step_id = traj_svc.start_step(  # type: ignore[attr-defined]
                        trajectory_id,
                        agent_balance=float(state.powers[power].center_count),
                        agent_points=float(state.powers[power].unit_count),
                        custom={
                            "phase": state.phase.value,
                            "phaseName": state.phase_name,
                            "centerCount": int(state.powers[power].center_count),
                            "unitCount": int(state.powers[power].unit_count),
                        },
                    )
                except Exception:
                    step_id = None

            power_orders = await agents[power].decide_orders(state, trajectory_step_id=step_id)
            orders[power] = power_orders

        # Execute orders
        result = await env.step(orders, all_messages if press_mode else None)
        print(f"\n{result.summary}")

        # Check for winner
        if state.is_game_over:
            break

        await asyncio.sleep(0.5)  # Brief pause for readability

    # Final results
    episode_result = env.get_episode_result()

    print("\n" + "=" * 50)
    print("🏁 GAME OVER")
    print("=" * 50)

    if episode_result.winner:
        print(f"🏆 Winner: {episode_result.winner.full_name}")
    else:
        print("🤝 Game ended in a draw")

    print(f"📊 Game lasted {episode_result.num_years} years")

    # Final standings
    print("\n📈 Final Supply Center Counts:")
    final_state = episode_result.final_state
    for power, pstate in sorted(
        final_state.powers.items(),
        key=lambda x: -x[1].center_count,
    ):
        status = "👑" if power == episode_result.winner else "  "
        print(f"  {status} {power.full_name}: {pstate.center_count} centers")

    # Cleanup
    await env.close()
    if runtime:
        if log_trajectories and traj_svc is not None:
            try:
                from elizaos_plugin_trajectory_logger.runtime_service import TrajectoryExportConfig

                export_cfg = TrajectoryExportConfig(
                    dataset_name="atropos_diplomacy_trajectories",
                    export_format=trajectory_format,  # type: ignore[arg-type]
                    output_dir=trajectory_output or "./trajectories",
                )
                export_result = traj_svc.export(export_cfg)  # type: ignore[attr-defined]
                print("\n📦 Exported trajectories")
                print(f"   - count: {export_result.trajectories_exported}")
                print(f"   - file: {export_result.dataset_url}")
            except Exception as e:
                print(f"\n⚠️ Trajectory export failed: {e}")

        await runtime.stop()


async def run_interactive_mode(nation: str = "france") -> None:
    """Run interactive mode - play as one nation."""
    from elizaos_atropos_diplomacy import DiplomacyEnvironment, DiplomacyAgent, Power

    # Find the player's power
    player_power = None
    for power in Power:
        if power.name.lower() == nation.lower() or power.value.lower() == nation.lower():
            player_power = power
            break

    if player_power is None:
        print(f"Unknown nation: {nation}")
        print("Available: austria, england, france, germany, italy, russia, turkey")
        return

    print("\n🌍 ElizaOS Atropos - Diplomacy (Interactive)")
    print("=" * 50)
    print(f"You are playing as: {player_power.full_name}")
    print("=" * 50)

    env = DiplomacyEnvironment(press_mode=False)
    await env.initialize()

    # Create AI agents for other powers
    agents: dict[Power, DiplomacyAgent] = {}
    for power in Power:
        if power != player_power:
            agents[power] = DiplomacyAgent(power=power, use_llm=False)

    while not env.is_game_over():
        state = env.get_state()
        player_state = state.powers[player_power]

        print(f"\n{'=' * 50}")
        print(f"📅 {state.phase_name}")
        print(f"{'=' * 50}")

        # Show player's position
        print(f"\n🏰 {player_power.full_name} Status:")
        print(f"  Supply Centers ({player_state.center_count}): {', '.join(player_state.supply_centers)}")
        print(f"  Units ({player_state.unit_count}):")
        for unit in player_state.units:
            print(f"    - {unit}")

        # Show available orders
        available = env.get_available_orders(player_power)
        print("\n📋 Available Orders:")
        for i, order in enumerate(available[:20], 1):  # Show first 20
            print(f"  {i}. {order}")
        if len(available) > 20:
            print(f"  ... and {len(available) - 20} more")

        # Get player input
        try:
            print("\nEnter order numbers (comma-separated) or 'auto' for AI suggestion:")
            user_input = input("> ").strip()
        except EOFError:
            break

        if user_input.lower() in ("quit", "q", "exit"):
            break

        # Process player orders
        player_orders = []
        if user_input.lower() == "auto":
            temp_agent = DiplomacyAgent(power=player_power, use_llm=False)
            player_orders = await temp_agent.decide_orders(state)
        else:
            try:
                indices = [int(x.strip()) - 1 for x in user_input.split(",")]
                player_orders = [available[i] for i in indices if 0 <= i < len(available)]
            except (ValueError, IndexError):
                print("Invalid input, using hold orders")
                player_orders = []

        # Fill in missing orders with holds
        from elizaos_atropos_diplomacy.types import Order, OrderType
        units_ordered = {o.unit.location for o in player_orders}
        for unit in player_state.units:
            if unit.location not in units_ordered:
                player_orders.append(Order(unit=unit, order_type=OrderType.HOLD))

        # Get AI orders
        all_orders = {player_power: player_orders}
        for power, agent in agents.items():
            if power in state.active_powers:
                all_orders[power] = await agent.decide_orders(state)

        # Execute
        result = await env.step(all_orders)
        print(f"\n{result.summary}")

    # Game over
    episode_result = env.get_episode_result()
    print("\n" + "=" * 50)
    print("🏁 GAME OVER")
    if episode_result.winner == player_power:
        print("🏆 VICTORY! You have won!")
    elif episode_result.winner:
        print(f"😢 Defeat. {episode_result.winner.full_name} has won.")
    else:
        print("🤝 Draw")

    await env.close()


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="ElizaOS Atropos Diplomacy Environment",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument(
        "--mode",
        choices=["auto", "interactive", "press"],
        default="auto",
        help="Game mode (default: auto)",
    )
    parser.add_argument(
        "--nation",
        default="france",
        help="Nation to play as in interactive mode (default: france)",
    )
    parser.add_argument(
        "--years",
        type=int,
        default=10,
        help="Maximum game years (default: 10)",
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

    try:
        if args.mode == "auto":
            asyncio.run(
                run_auto_mode(
                    args.years,
                    press_mode=False,
                    log_trajectories=args.trajectories,
                    trajectory_output=args.trajectory_output,
                    trajectory_format=args.trajectory_format,
                )
            )
        elif args.mode == "press":
            asyncio.run(
                run_auto_mode(
                    args.years,
                    press_mode=True,
                    log_trajectories=args.trajectories,
                    trajectory_output=args.trajectory_output,
                    trajectory_format=args.trajectory_format,
                )
            )
        elif args.mode == "interactive":
            asyncio.run(run_interactive_mode(args.nation))
    except KeyboardInterrupt:
        print("\n\nGoodbye! 👋")
        sys.exit(0)


if __name__ == "__main__":
    main()
