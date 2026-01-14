"""
Run all Atropos example environments and compute benchmark metrics.

This runner uses the *canonical* ElizaOS message pipeline for each agent (via the
environment-specific Eliza plugins + message_service.handle_message()) and reports
high-level scores for comparison across runs.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _load_dotenv(repo_root: Path) -> None:
    """
    Minimal .env loader (no external dependency).

    Loads KEY=VALUE lines into os.environ if not already set.
    """

    env_path = repo_root / ".env"
    if not env_path.exists():
        return

    try:
        raw = env_path.read_text(encoding="utf-8")
    except OSError:
        return

    for line in raw.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        k = k.strip()
        v = v.strip()
        if not k or k in os.environ:
            continue
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        os.environ[k] = v


def _bootstrap_sys_path(repo_root: Path) -> None:
    """
    Make example packages importable without installing them.
    """

    paths = [
        repo_root / "packages" / "python",
        repo_root / "plugins" / "plugin-openai" / "python",
        repo_root / "examples" / "atropos" / "blackjack",
        repo_root / "examples" / "atropos" / "textworld",
        repo_root / "examples" / "atropos" / "holdem",
        repo_root / "examples" / "atropos" / "reasoning",
        repo_root / "examples" / "atropos" / "diplomacy",
    ]

    # Prepend so these win over any globally installed packages.
    for p in reversed(paths):
        sys.path.insert(0, str(p))


@dataclass(frozen=True)
class BlackjackBenchConfig:
    episodes: int


@dataclass(frozen=True)
class TextWorldBenchConfig:
    episodes: int
    difficulty: str


@dataclass(frozen=True)
class HoldemBenchConfig:
    hands: int
    players: int


@dataclass(frozen=True)
class ReasoningBenchConfig:
    problems: int
    task: str
    difficulty: str


@dataclass(frozen=True)
class DiplomacyBenchConfig:
    years: int
    press: bool


@dataclass(frozen=True)
class BenchRunConfig:
    blackjack: BlackjackBenchConfig
    textworld: TextWorldBenchConfig
    holdem: HoldemBenchConfig
    reasoning: ReasoningBenchConfig
    diplomacy: DiplomacyBenchConfig


async def _make_runtime(*, character, plugins):
    from elizaos.bootstrap import bootstrap_plugin
    from elizaos.runtime import AgentRuntime

    # Ensure bootstrap is always present.
    full_plugins = [bootstrap_plugin, *plugins]
    runtime = AgentRuntime(character=character, plugins=full_plugins)
    await runtime.initialize()
    return runtime


async def run_blackjack(cfg: BlackjackBenchConfig) -> dict[str, object]:
    from elizaos_plugin_openai import get_openai_plugin
    from elizaos_atropos_blackjack import BlackjackEnvironment, BlackjackAgent
    from elizaos_atropos_blackjack.eliza_plugin import create_blackjack_character, get_blackjack_eliza_plugin

    runtime = await _make_runtime(
        character=create_blackjack_character(),
        plugins=[get_openai_plugin(), get_blackjack_eliza_plugin()],
    )

    env = BlackjackEnvironment()
    await env.initialize()

    agent = BlackjackAgent(runtime=runtime, use_llm=True)

    async def policy(state, actions):
        return await agent.decide(state, actions)

    for _ in range(cfg.episodes):
        result = await env.play_episode(policy)
        agent.record_episode(result)

    await env.close()
    await runtime.stop()

    s = agent.stats
    return {
        "episodes": int(s.episodes),
        "win_rate": float(s.win_rate),
        "avg_reward": float(s.average_reward),
        "blackjacks": int(s.blackjacks),
        "busts": int(s.busts),
    }


async def run_textworld(cfg: TextWorldBenchConfig) -> dict[str, object]:
    from elizaos_plugin_openai import get_openai_plugin
    from elizaos_atropos_textworld import TextWorldEnvironment, TextWorldAgent, Difficulty, GameType
    from elizaos_atropos_textworld.eliza_plugin import create_textworld_character, get_textworld_eliza_plugin

    runtime = await _make_runtime(
        character=create_textworld_character(),
        plugins=[get_openai_plugin(), get_textworld_eliza_plugin()],
    )

    env = TextWorldEnvironment(game_type=GameType.TREASURE_HUNT, difficulty=Difficulty(cfg.difficulty))
    await env.initialize()

    agent = TextWorldAgent(runtime=runtime, use_llm=True)

    async def policy(state):
        return await agent.decide(state)

    for _ in range(cfg.episodes):
        result = await env.play_episode(policy)
        agent.record_episode(result)

    await env.close()
    await runtime.stop()

    s = agent.stats
    return {
        "episodes": int(s.episodes),
        "win_rate": float(s.win_rate),
        "avg_completion": float(s.avg_completion),
        "avg_steps": float(s.avg_steps),
    }


async def run_holdem(cfg: HoldemBenchConfig) -> dict[str, object]:
    from elizaos_plugin_openai import get_openai_plugin
    from elizaos_atropos_holdem import HoldemEnvironment, HoldemAgent
    from elizaos_atropos_holdem.eliza_plugin import create_holdem_character, get_holdem_eliza_plugin

    runtime = await _make_runtime(
        character=create_holdem_character(),
        plugins=[get_openai_plugin(), get_holdem_eliza_plugin()],
    )

    env = HoldemEnvironment(num_players=cfg.players, starting_stack=1000, small_blind=5, big_blind=10)
    await env.initialize()

    agents = [HoldemAgent(runtime=runtime, position=i, use_llm=True) for i in range(cfg.players)]

    for _ in range(cfg.hands):
        state = await env.reset()
        while not state.hand_over:
            current_pos = state.current_player
            action = await agents[current_pos].decide(state)
            state = await env.step(action)

        result = env.get_hand_result()
        for i, agent in enumerate(agents):
            profit = int(result.payouts.get(i, 0))
            won = i in result.winners
            agent.record_result(profit, won, int(state.pot) if won else 0)

    await env.close()
    await runtime.stop()

    per_player = []
    for agent in agents:
        s = agent.stats
        per_player.append(
            {
                "position": int(agent.position),
                "hands": int(s.hands_played),
                "win_rate": float(s.win_rate),
                "total_profit": int(s.total_profit),
                "avg_profit": float(s.avg_profit),
            }
        )

    # Aggregate
    total_profit = sum(p["total_profit"] for p in per_player)
    return {
        "hands": int(cfg.hands),
        "players": int(cfg.players),
        "total_profit_sum": int(total_profit),
        "per_player": per_player,
    }


async def run_reasoning(cfg: ReasoningBenchConfig) -> dict[str, object]:
    from elizaos_plugin_openai import get_openai_plugin
    from elizaos_atropos_reasoning import ReasoningEnvironment, ReasoningAgent, TaskType, Difficulty
    from elizaos_atropos_reasoning.eliza_plugin import create_reasoning_character, get_reasoning_eliza_plugin

    runtime = await _make_runtime(
        character=create_reasoning_character(),
        plugins=[get_openai_plugin(), get_reasoning_eliza_plugin()],
    )

    env = ReasoningEnvironment(task_type=TaskType(cfg.task), difficulty=Difficulty(cfg.difficulty))
    await env.initialize()

    agent = ReasoningAgent(runtime=runtime, use_llm=True)

    for _ in range(cfg.problems):
        state = await env.reset()
        while not state.done:
            resp = await agent.reason(state)
            state = await env.step(resp)
        result = env.get_episode_result()
        agent.record_episode(result)

    await env.close()
    await runtime.stop()

    s = agent.stats
    return {
        "problems": int(s.problems_attempted),
        "accuracy": float(s.accuracy),
        "avg_attempts": float(s.total_attempts / max(1, s.problems_attempted)),
        "total_hints": int(s.total_hints),
    }


async def run_diplomacy(cfg: DiplomacyBenchConfig) -> dict[str, object]:
    from elizaos_plugin_openai import get_openai_plugin
    from elizaos_atropos_diplomacy import DiplomacyEnvironment, DiplomacyAgent, Power
    from elizaos_atropos_diplomacy.eliza_plugin import create_diplomacy_character, get_diplomacy_eliza_plugin

    runtime = await _make_runtime(
        character=create_diplomacy_character(),
        plugins=[get_openai_plugin(), get_diplomacy_eliza_plugin()],
    )

    env = DiplomacyEnvironment(press_mode=cfg.press, max_years=cfg.years)
    await env.initialize()

    agents = {p: DiplomacyAgent(runtime=runtime, power=p, use_llm=True) for p in Power}

    while not env.is_game_over():
        state = env.get_state()

        all_messages = []
        if cfg.press and state.phase.value == "MOVEMENT":
            for power in state.active_powers:
                msgs = await agents[power].negotiate(state, all_messages)
                all_messages.extend(msgs)

        orders = {p: await agents[p].decide_orders(state) for p in state.active_powers}
        _ = await env.step(orders, all_messages if cfg.press else None)

        # Safety: stop if state marks game over.
        if state.is_game_over:
            break

    episode = env.get_episode_result()
    final_counts = {p.value: int(c) for p, c in episode.final_state.get_center_count().items()}

    await env.close()
    await runtime.stop()

    return {
        "years": int(episode.num_years),
        "winner": episode.winner.value if episode.winner is not None else None,
        "is_draw": bool(episode.is_draw),
        "final_center_counts": final_counts,
    }


def _to_markdown(report: dict[str, object]) -> str:
    lines = []
    lines.append("# Atropos Benchmarks\n")
    meta = report.get("meta")
    if isinstance(meta, dict):
        lines.append("## Meta")
        for k in ("started_at", "git_commit", "openai_model_hint"):
            v = meta.get(k)
            if v is not None:
                lines.append(f"- **{k}**: {v}")
        lines.append("")

    results = report.get("results")
    if not isinstance(results, dict):
        return "\n".join(lines) + "\n"

    def _fmt_pct(x: object) -> str:
        if isinstance(x, (int, float)):
            return f"{100.0 * float(x):.1f}%"
        return str(x)

    lines.append("## Results")
    bj = results.get("blackjack")
    if isinstance(bj, dict):
        lines.append("### Blackjack")
        lines.append(f"- **episodes**: {bj.get('episodes')}")
        lines.append(f"- **win_rate**: {_fmt_pct(bj.get('win_rate'))}")
        lines.append(f"- **avg_reward**: {bj.get('avg_reward')}")
        lines.append("")

    tw = results.get("textworld")
    if isinstance(tw, dict):
        lines.append("### TextWorld")
        lines.append(f"- **episodes**: {tw.get('episodes')}")
        lines.append(f"- **win_rate**: {_fmt_pct(tw.get('win_rate'))}")
        lines.append(f"- **avg_completion**: {_fmt_pct(tw.get('avg_completion'))}")
        lines.append(f"- **avg_steps**: {tw.get('avg_steps')}")
        lines.append("")

    ho = results.get("holdem")
    if isinstance(ho, dict):
        lines.append("### Hold'em")
        lines.append(f"- **hands**: {ho.get('hands')}")
        lines.append(f"- **players**: {ho.get('players')}")
        lines.append(f"- **total_profit_sum**: {ho.get('total_profit_sum')}")
        lines.append("")

    rg = results.get("reasoning")
    if isinstance(rg, dict):
        lines.append("### Reasoning Gym")
        lines.append(f"- **problems**: {rg.get('problems')}")
        lines.append(f"- **accuracy**: {_fmt_pct(rg.get('accuracy'))}")
        lines.append(f"- **avg_attempts**: {rg.get('avg_attempts')}")
        lines.append("")

    dp = results.get("diplomacy")
    if isinstance(dp, dict):
        lines.append("### Diplomacy")
        lines.append(f"- **years**: {dp.get('years')}")
        lines.append(f"- **winner**: {dp.get('winner')}")
        lines.append(f"- **is_draw**: {dp.get('is_draw')}")
        lines.append("")

    return "\n".join(lines) + "\n"


def _git_head(repo_root: Path) -> str | None:
    head = repo_root / ".git" / "HEAD"
    if not head.exists():
        return None
    try:
        txt = head.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if txt.startswith("ref:"):
        ref = txt.split(":", 1)[1].strip()
        ref_path = repo_root / ".git" / ref
        try:
            return ref_path.read_text(encoding="utf-8").strip()
        except OSError:
            return None
    return txt or None


async def main_async(args: argparse.Namespace) -> int:
    repo_root = _repo_root()
    _bootstrap_sys_path(repo_root)
    _load_dotenv(repo_root)

    if not os.environ.get("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY is not set (expected in environment or .env)")
        return 2

    cfg = BenchRunConfig(
        blackjack=BlackjackBenchConfig(episodes=int(args.blackjack_episodes)),
        textworld=TextWorldBenchConfig(episodes=int(args.textworld_episodes), difficulty=str(args.textworld_difficulty)),
        holdem=HoldemBenchConfig(hands=int(args.holdem_hands), players=int(args.holdem_players)),
        reasoning=ReasoningBenchConfig(
            problems=int(args.reasoning_problems),
            task=str(args.reasoning_task),
            difficulty=str(args.reasoning_difficulty),
        ),
        diplomacy=DiplomacyBenchConfig(years=int(args.diplomacy_years), press=bool(args.diplomacy_press)),
    )

    started_at = datetime.now(timezone.utc).isoformat()
    report: dict[str, object] = {
        "meta": {
            "started_at": started_at,
            "git_commit": _git_head(repo_root),
            "openai_model_hint": os.environ.get("OPENAI_MODEL") or os.environ.get("OPENAI_DEFAULT_MODEL"),
        },
        "config": {
            "blackjack": asdict(cfg.blackjack),
            "textworld": asdict(cfg.textworld),
            "holdem": asdict(cfg.holdem),
            "reasoning": asdict(cfg.reasoning),
            "diplomacy": asdict(cfg.diplomacy),
        },
        "results": {},
    }

    results: dict[str, object] = {}
    # Run sequentially to keep API usage predictable.
    print("Running Blackjack...")
    results["blackjack"] = await run_blackjack(cfg.blackjack)
    print("Running TextWorld...")
    results["textworld"] = await run_textworld(cfg.textworld)
    print("Running Hold'em...")
    results["holdem"] = await run_holdem(cfg.holdem)
    print("Running Reasoning...")
    results["reasoning"] = await run_reasoning(cfg.reasoning)
    print("Running Diplomacy...")
    results["diplomacy"] = await run_diplomacy(cfg.diplomacy)

    report["results"] = results

    out_dir = Path(args.output).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    json_path = out_dir / f"atropos_benchmarks_{stamp}.json"
    md_path = out_dir / f"atropos_benchmarks_{stamp}.md"

    json_path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    md_path.write_text(_to_markdown(report), encoding="utf-8")

    print(f"\nWrote JSON: {json_path}")
    print(f"Wrote MD:   {md_path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Atropos benchmarks (all environments).")
    parser.add_argument("--output", type=str, default="benchmark_results/atropos", help="Output directory")

    parser.add_argument("--blackjack-episodes", type=int, default=25)
    parser.add_argument("--textworld-episodes", type=int, default=2)
    parser.add_argument("--textworld-difficulty", type=str, default="easy", choices=["easy", "medium", "hard"])
    parser.add_argument("--holdem-hands", type=int, default=2)
    parser.add_argument("--holdem-players", type=int, default=2)
    parser.add_argument("--reasoning-problems", type=int, default=3)
    parser.add_argument("--reasoning-task", type=str, default="math", choices=["math", "logic", "puzzle"])
    parser.add_argument("--reasoning-difficulty", type=str, default="easy", choices=["easy", "medium", "hard"])
    parser.add_argument("--diplomacy-years", type=int, default=1)
    parser.add_argument("--diplomacy-press", action="store_true")

    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())

