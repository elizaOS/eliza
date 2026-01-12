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
    candidates = [
        Path.cwd() / ".env",
        # repo_root/examples/atropos/blackjack/elizaos_atropos_blackjack/cli.py -> repo_root is parents[4]
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


async def run_auto_mode(num_episodes: int = 100, use_llm: bool = False) -> None:
    """Run automatic play mode."""
    _load_dotenv()

    from elizaos_atropos_blackjack import BlackjackEnvironment, BlackjackAgent

    print("\n🃏 ElizaOS Atropos - Blackjack")
    print("=" * 40)
    print(f"Mode: {'LLM-based' if use_llm else 'Optimal Strategy'}")
    print(f"Episodes: {num_episodes}")
    print("=" * 40)

    # Create environment
    env = BlackjackEnvironment()
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
            print("⚠️ LLM plugins not available, using optimal strategy")
            use_llm = False
        except Exception as e:
            print(f"⚠️ Failed to initialize LLM: {e}")
            use_llm = False

    agent = BlackjackAgent(runtime=runtime, use_llm=use_llm)

    print("\n📊 Running episodes...\n")

    # Play episodes
    for i in range(num_episodes):
        result = await env.play_episode(agent.decide)
        agent.record_episode(result)

        # Show progress every 10%
        if (i + 1) % max(1, num_episodes // 10) == 0:
            print(f"  Progress: {i + 1}/{num_episodes} | {agent.stats}")

    # Final summary
    print("\n" + "=" * 40)
    print("FINAL RESULTS")
    print("=" * 40)
    print(agent.get_summary())

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
  elizaos-blackjack --mode auto          # Watch AI play 100 hands
  elizaos-blackjack --mode interactive   # Play interactively
  elizaos-blackjack --mode benchmark     # Compare strategies
  elizaos-blackjack --mode auto --llm    # Use LLM for decisions
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

    args = parser.parse_args()

    if args.llm and not os.environ.get("OPENAI_API_KEY"):
        print("⚠️ OPENAI_API_KEY not set. LLM mode requires this environment variable.")
        print("   Falling back to optimal strategy mode.")
        args.llm = False

    try:
        if args.mode == "auto":
            asyncio.run(run_auto_mode(args.episodes, args.llm))
        elif args.mode == "interactive":
            asyncio.run(run_interactive_mode(args.llm))
        elif args.mode == "benchmark":
            asyncio.run(run_benchmark_mode(args.episodes))
    except KeyboardInterrupt:
        print("\n\nGoodbye! 👋")
        sys.exit(0)


if __name__ == "__main__":
    main()
