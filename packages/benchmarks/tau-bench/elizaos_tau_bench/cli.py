"""tau-bench CLI.

Run all 165 official tasks with pass^k=4 by default:

    python -m elizaos_tau_bench --agent-model gpt-4o

Smoke test without an LLM:

    python -m elizaos_tau_bench --mock --use-sample-tasks
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

from elizaos_tau_bench.runner import TauBenchRunner
from elizaos_tau_bench.types import TauBenchConfig

logger = logging.getLogger("elizaos_tau_bench")


def _maybe_load_dotenv() -> None:
    try:
        from dotenv import find_dotenv, load_dotenv  # type: ignore
    except Exception:
        return
    try:
        env_path = find_dotenv(usecwd=True)
        if env_path:
            load_dotenv(env_path, override=False)
        local = Path(__file__).resolve().parent.parent / ".env.tau-bench"
        if local.exists():
            load_dotenv(local, override=False)
    except Exception:
        return


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="elizaos-tau-bench",
        description="Run sierra-research/tau-bench against an ElizaOS-friendly harness.",
    )
    p.add_argument(
        "--domain",
        choices=["retail", "airline", "both"],
        default="both",
        help="Domain(s) to run.",
    )
    p.add_argument(
        "--task-split",
        choices=["test", "dev", "train"],
        default="test",
        help="Upstream task split (retail has test/dev/train; airline has only test).",
    )
    p.add_argument(
        "--task-ids",
        type=int,
        nargs="+",
        default=None,
        help="Only run these task indices.",
    )
    p.add_argument("--start-index", type=int, default=0)
    p.add_argument("--end-index", type=int, default=-1)
    p.add_argument("--max-tasks-per-domain", type=int, default=None)
    p.add_argument(
        "--use-sample-tasks",
        action="store_true",
        help="Run a tiny 4-task smoke subset rather than all 165 tasks.",
    )

    # Pass^k
    p.add_argument(
        "--num-trials",
        type=int,
        default=4,
        help="Trials per task. Defaults to 4 per the tau-bench paper.",
    )
    p.add_argument("--pass-k-values", type=int, nargs="+", default=[1, 2, 4])

    # Agent
    p.add_argument("--mock", action="store_true", help="Use mock ground-truth-replay agent.")
    p.add_argument(
        "--agent-harness",
        choices=["litellm", "eliza", "hermes", "openclaw"],
        default="litellm",
        help="Which agent harness drives the per-turn completion. "
        "'litellm' (default) uses the built-in LiteLLM tool-calling agent; "
        "'eliza' / 'hermes' / 'openclaw' route through the matching adapter.",
    )
    p.add_argument("--agent-model", default="gpt-4o")
    p.add_argument("--agent-provider", default="openai")
    p.add_argument("--agent-temperature", type=float, default=0.0)
    p.add_argument("--agent-max-turns", type=int, default=30)

    # User simulator
    p.add_argument(
        "--user-strategy",
        choices=["llm", "react", "verify", "reflection", "human"],
        default="llm",
    )
    p.add_argument("--user-model", default="gpt-4o")
    p.add_argument("--user-provider", default="openai")

    # Judge
    p.add_argument("--no-llm-judge", action="store_true", help="Disable LLM judge (use substring).")
    p.add_argument("--judge-model", default="gpt-4o-mini")
    p.add_argument("--judge-provider", default="openai")

    # IO
    p.add_argument("--output-dir", default=None)
    p.add_argument("--seed", type=int, default=10)
    p.add_argument("--verbose", action="store_true")
    return p.parse_args(argv)


def build_config(args: argparse.Namespace) -> TauBenchConfig:
    domains: list[str]
    if args.domain == "both":
        domains = ["retail", "airline"]
    else:
        domains = [args.domain]

    output_dir = args.output_dir
    if not output_dir:
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        output_dir = f"./benchmark_results/tau-bench/{ts}"

    return TauBenchConfig(
        domains=domains,  # type: ignore[arg-type]
        task_split=args.task_split,
        num_trials=args.num_trials,
        pass_k_values=list(args.pass_k_values),
        task_ids=args.task_ids,
        start_index=args.start_index,
        end_index=args.end_index,
        max_tasks_per_domain=args.max_tasks_per_domain,
        use_sample_tasks=args.use_sample_tasks,
        use_mock=args.mock,
        agent_harness=args.agent_harness,
        agent_model=args.agent_model,
        agent_provider=args.agent_provider,
        agent_temperature=args.agent_temperature,
        agent_max_turns=args.agent_max_turns,
        user_strategy=args.user_strategy,
        user_model=args.user_model,
        user_provider=args.user_provider,
        use_llm_judge=not args.no_llm_judge,
        judge_model=args.judge_model,
        judge_provider=args.judge_provider,
        output_dir=output_dir,
        seed=args.seed,
        verbose=args.verbose,
    )


def _check_keys(cfg: TauBenchConfig) -> int:
    """Return 1 if a required API key is missing for non-mock runs."""
    if cfg.use_mock:
        return 0
    missing: list[str] = []
    needed_providers = {cfg.agent_provider, cfg.user_provider}
    if cfg.use_llm_judge:
        needed_providers.add(cfg.judge_provider)
    for prov in needed_providers:
        key_var = {
            "openai": "OPENAI_API_KEY",
            "anthropic": "ANTHROPIC_API_KEY",
            "google": "GOOGLE_API_KEY",
            "groq": "GROQ_API_KEY",
            "openrouter": "OPENROUTER_API_KEY",
        }.get(prov)
        if key_var and not os.environ.get(key_var):
            missing.append(f"{prov}->{key_var}")
    if missing:
        logger.error(
            "Missing required API keys for providers: %s. Use --mock for a smoke run.",
            ", ".join(missing),
        )
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    _maybe_load_dotenv()
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s | %(message)s",
        stream=sys.stdout,
    )
    cfg = build_config(args)

    rc = _check_keys(cfg)
    if rc != 0:
        return rc

    print(json.dumps({"event": "config", "config": cfg.to_dict()}, indent=2))

    runner = TauBenchRunner(cfg)
    try:
        report = runner.run()
    except KeyboardInterrupt:
        logger.warning("Interrupted")
        return 130
    except Exception as e:
        logger.exception("Run failed: %s", e)
        return 1

    print(
        json.dumps(
            {
                "event": "summary",
                "num_tasks": report.num_tasks,
                "num_trials": report.num_trials_per_task,
                "avg_reward": report.avg_reward,
                "pass_k": {
                    k: {"pass_hat_k": v.pass_hat_k, "num_tasks": v.num_tasks}
                    for k, v in report.pass_k.items()
                },
                "output_dir": cfg.output_dir,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
