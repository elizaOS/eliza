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


async def run_auto_mode(max_years: int = 10, press_mode: bool = False) -> None:
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
            from elizaos_plugin_openai import get_openai_plugin

            runtime = AgentRuntime(plugins=[get_openai_plugin()])
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
            power_orders = await agents[power].decide_orders(state)
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

    args = parser.parse_args()

    try:
        if args.mode == "auto":
            asyncio.run(run_auto_mode(args.years, press_mode=False))
        elif args.mode == "press":
            asyncio.run(run_auto_mode(args.years, press_mode=True))
        elif args.mode == "interactive":
            asyncio.run(run_interactive_mode(args.nation))
    except KeyboardInterrupt:
        print("\n\nGoodbye! 👋")
        sys.exit(0)


if __name__ == "__main__":
    main()
