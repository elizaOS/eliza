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
    candidates = [
        Path.cwd() / ".env",
        # repo_root/examples/atropos/textworld/elizaos_atropos_textworld/cli.py -> repo_root is parents[4]
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
    num_episodes: int = 10,
    difficulty: str = "medium",
    use_llm: bool = False,
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
            from elizaos_plugin_openai import get_openai_plugin

            runtime = AgentRuntime(plugins=[get_openai_plugin()])
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

    for i in range(num_episodes):
        result = await env.play_episode(agent.decide)
        agent.record_episode(result)

        status = "✅ WON" if result.won else "❌ Lost"
        print(f"  Episode {i + 1}: {status} | Score: {result.score}/{result.max_score} | Steps: {result.steps}")

    # Final summary
    print("\n" + "=" * 50)
    print("FINAL RESULTS")
    print("=" * 50)
    print(agent.get_summary())

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

    print("\n📖 elizaOS Atropos - TextWorld Benchmark")
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


async def run_atropos_gen_mode(
    num_episodes: int = 100,
    output: str = "trajectories.jsonl",
    use_elizaos: bool = True,
    difficulty: str = "medium",
    tokenizer: str = "meta-llama/Llama-3.2-3B-Instruct",
) -> None:
    """Generate Atropos training data from elizaOS gameplay."""
    _load_dotenv()

    try:
        from elizaos_atropos_textworld.atropos_integration import (
            generate_training_data,
            AtroposConfig,
        )
    except ImportError as e:
        print(f"❌ Atropos integration not available: {e}")
        print("Install with: pip install -e '.[atropos]'")
        sys.exit(1)

    print("\n📖 elizaOS TextWorld - Atropos Data Generation")
    print("=" * 50)
    print(f"Episodes: {num_episodes}")
    print(f"Agent: {'elizaOS' if use_elizaos else 'heuristic'}")
    print(f"Difficulty: {difficulty}")
    print(f"Tokenizer: {tokenizer}")
    print(f"Output: {output}")
    print("=" * 50 + "\n")

    config = AtroposConfig(
        tokenizer_name=tokenizer,
        difficulty=difficulty,
        use_elizaos=use_elizaos,
    )

    trajectories = await generate_training_data(
        num_episodes=num_episodes,
        config=config,
        output_path=output,
        verbose=True,
    )

    # Summary
    print("\n" + "=" * 50)
    print("GENERATION COMPLETE")
    print("=" * 50)
    print(f"Total trajectories: {len(trajectories)}")

    if trajectories:
        scores = [t["scores"] for t in trajectories]
        tokens = [len(t["tokens"]) for t in trajectories]
        wins = sum(1 for t in trajectories if t["overrides"]["won"])

        print(f"Win rate: {wins / len(trajectories):.1%}")
        print(f"Avg score: {sum(scores) / len(scores):.3f}")
        print(f"Avg tokens: {sum(tokens) / len(tokens):.0f}")
        print(f"Max tokens: {max(tokens)}")

    print("=" * 50)


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="elizaOS Atropos TextWorld Environment",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  elizaos-textworld --mode auto              # Watch AI play
  elizaos-textworld --mode interactive       # Play interactively
  elizaos-textworld --mode benchmark         # Compare strategies
  elizaos-textworld --mode atropos-gen       # Generate Atropos training data
  elizaos-textworld --difficulty hard        # Play hard difficulty

Atropos data generation:
  elizaos-textworld --mode atropos-gen --episodes 500 --use-elizaos -o train.jsonl
  elizaos-textworld --mode atropos-gen --episodes 500 --no-use-elizaos -o baseline.jsonl
        """,
    )

    parser.add_argument(
        "--mode",
        choices=["auto", "interactive", "benchmark", "atropos-gen"],
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
    # Atropos-specific arguments
    parser.add_argument(
        "--use-elizaos",
        action="store_true",
        default=True,
        help="Use elizaOS agent for atropos-gen (default: True)",
    )
    parser.add_argument(
        "--no-use-elizaos",
        action="store_false",
        dest="use_elizaos",
        help="Use heuristic agent instead of elizaOS for atropos-gen",
    )
    parser.add_argument(
        "-o", "--output",
        type=str,
        default="trajectories.jsonl",
        help="Output file for atropos-gen (default: trajectories.jsonl)",
    )
    parser.add_argument(
        "--tokenizer",
        type=str,
        default="meta-llama/Llama-3.2-3B-Instruct",
        help="HuggingFace tokenizer for atropos-gen",
    )

    args = parser.parse_args()

    _load_dotenv()

    if args.llm and not os.environ.get("OPENAI_API_KEY"):
        print("⚠️ OPENAI_API_KEY not set. Falling back to heuristic mode.")
        args.llm = False

    if args.mode == "atropos-gen" and args.use_elizaos and not os.environ.get("OPENAI_API_KEY"):
        print("⚠️ OPENAI_API_KEY not set. Falling back to heuristic agent.")
        args.use_elizaos = False

    try:
        if args.mode == "auto":
            asyncio.run(run_auto_mode(args.episodes, args.difficulty, args.llm))
        elif args.mode == "interactive":
            asyncio.run(run_interactive_mode(args.difficulty))
        elif args.mode == "benchmark":
            asyncio.run(run_benchmark_mode(args.episodes, args.difficulty))
        elif args.mode == "atropos-gen":
            asyncio.run(run_atropos_gen_mode(
                num_episodes=args.episodes,
                output=args.output,
                use_elizaos=args.use_elizaos,
                difficulty=args.difficulty,
                tokenizer=args.tokenizer,
            ))
    except KeyboardInterrupt:
        print("\n\nGoodbye! 👋")
        sys.exit(0)


if __name__ == "__main__":
    main()
