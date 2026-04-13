"""
Benchmark Harness — Main entry point for running the Trust Marketplace Benchmark.

Usage:
    python -m benchmark.harness --data-dir ./trenches-chat-dataset/data
    python -m benchmark.harness --suite extract --data-dir ./trenches-chat-dataset/data
    python -m benchmark.harness --generate-gt --data-dir ./trenches-chat-dataset/data
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import asdict
from pathlib import Path

import click
from rich.console import Console
from rich.table import Table

from .ground_truth import generate_ground_truth, save_ground_truth
from .protocol import ExtractionResult, SocialAlphaSystem, UserTrustScore
from .systems.oracle import OracleSystem
from .systems.smart_baseline import SmartBaselineSystem
from .systems.full_system import FullSystem
from .systems.eliza_system import ElizaSystem
from .suites import ExtractSuite, RankSuite, DetectSuite, ProfitSuite

console = Console()
LOG_LINES: list[str] = []  # accumulate detailed logs


def log(msg: str, level: str = "INFO") -> None:
    """Log with both console and accumulated buffer."""
    tag = {"INFO": "[blue]", "WARN": "[yellow]", "ERROR": "[red]", "OK": "[green]", "DETAIL": "[dim]"}
    console.print(f"  {tag.get(level, '')}[{level}][/] {msg}")
    LOG_LINES.append(f"[{level}] {msg}")

# ---------------------------------------------------------------------------
# Baseline System (rule-based, no ML) — used as a reference implementation
# ---------------------------------------------------------------------------


class BaselineSystem(SocialAlphaSystem):
    """
    Simple rule-based baseline for comparison.
    Uses keyword matching for extraction and raw P&L averaging for trust scores.
    """

    def __init__(self) -> None:
        self._user_calls: dict[str, list[dict]] = {}
        self._token_prices: dict[str, list[tuple[int, float]]] = {}
        self._token_worst: dict[str, float] = {}

    def extract_recommendation(self, message_text: str) -> ExtractionResult:
        text = message_text.lower()
        buy_words = {"buy", "moon", "pump", "bullish", "long", "ape", "100x", "gem", "alpha"}
        sell_words = {"sell", "dump", "scam", "rug", "bearish", "short", "avoid", "trash"}

        has_buy = sum(1 for w in buy_words if w in text)
        has_sell = sum(1 for w in sell_words if w in text)

        # Look for $ ticker
        token = ""
        for word in message_text.split():
            if word.startswith("$") and len(word) > 1:
                token = word[1:].upper()
                break

        if has_buy > has_sell and has_buy > 0:
            rec_type = "BUY"
            conviction = "HIGH" if has_buy >= 2 else "MEDIUM"
        elif has_sell > has_buy and has_sell > 0:
            rec_type = "SELL"
            conviction = "HIGH" if has_sell >= 2 else "MEDIUM"
        else:
            rec_type = "NOISE"
            conviction = "NONE"

        is_rec = rec_type != "NOISE"

        return ExtractionResult(
            is_recommendation=is_rec,
            recommendation_type=rec_type,
            conviction=conviction,
            token_mentioned=token,
            token_address="",  # baseline doesn't resolve
        )

    def process_call(self, user_id: str, token_address: str, recommendation_type: str,
                     conviction: str, price_at_call: float, timestamp: int) -> None:
        self._user_calls.setdefault(user_id, []).append({
            "token": token_address,
            "type": recommendation_type,
            "conviction": conviction,
            "price": price_at_call,
            "ts": timestamp,
            "profit": 0.0,
        })

    def update_price(self, token_address: str, price: float, timestamp: int) -> None:
        self._token_prices.setdefault(token_address, []).append((timestamp, price))

        # Update user call profits
        for user_calls in self._user_calls.values():
            for call in user_calls:
                if call["token"] == token_address and call["price"] > 0:
                    pct = ((price - call["price"]) / call["price"]) * 100
                    if call["type"] == "BUY":
                        call["profit"] = max(call["profit"], pct)
                    elif call["type"] == "SELL":
                        call["profit"] = max(call["profit"], -pct)

        # Track worst price for scam detection
        current_worst = self._token_worst.get(token_address, price)
        self._token_worst[token_address] = min(current_worst, price)

    def get_user_trust_score(self, user_id: str) -> UserTrustScore | None:
        calls = self._user_calls.get(user_id)
        if not calls:
            return None

        profits = [c["profit"] for c in calls]
        wins = sum(1 for p in profits if p >= 5)  # match ground truth WIN_THRESHOLD_PCT
        win_rate = wins / len(profits) if profits else 0

        avg_profit = sum(profits) / len(profits) if profits else 0
        trust = min(100, max(0, 50 + avg_profit))

        return UserTrustScore(
            user_id=user_id,
            trust_score=trust,
            win_rate=win_rate,
            total_calls=len(calls),
            archetype="low_info",  # baseline doesn't classify
        )

    def get_leaderboard(self, top_k: int = 50) -> list[UserTrustScore]:
        scores = []
        for uid in self._user_calls:
            score = self.get_user_trust_score(uid)
            if score:
                scores.append(score)
        scores.sort(key=lambda s: s.trust_score, reverse=True)
        return scores[:top_k]

    def is_scam_token(self, token_address: str) -> bool:
        prices = self._token_prices.get(token_address, [])
        if not prices:
            return False
        first_price = prices[0][1]
        worst = self._token_worst.get(token_address, first_price)
        if first_price <= 0:
            return False
        drop = ((worst - first_price) / first_price) * 100
        return drop <= -80

    def reset(self) -> None:
        self._user_calls.clear()
        self._token_prices.clear()
        self._token_worst.clear()


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------


def load_ground_truth(data_dir: Path) -> dict[str, list[dict]]:
    """Load or generate ground truth."""
    gt_dir = data_dir / "ground_truth"
    calls_path = gt_dir / "ground_truth_calls.json"
    users_path = gt_dir / "ground_truth_users.json"
    tokens_path = gt_dir / "ground_truth_tokens.json"

    if calls_path.exists() and users_path.exists() and tokens_path.exists():
        console.print("[bold green]Loading cached ground truth...[/]")
        with open(calls_path) as f:
            calls = json.load(f)
        with open(users_path) as f:
            users = json.load(f)
        with open(tokens_path) as f:
            tokens = json.load(f)
        return {"calls": calls, "users": users, "tokens": tokens}
    else:
        console.print("[bold yellow]Generating ground truth (first run)...[/]")
        gt = generate_ground_truth(data_dir)
        save_ground_truth(gt, gt_dir)
        return gt


def run_benchmark(
    system: SocialAlphaSystem,
    ground_truth: dict[str, list[dict]],
    suites: list[str] | None = None,
) -> dict[str, dict]:
    """Run all (or specified) benchmark suites with detailed observability."""
    results: dict[str, dict] = {}

    # --- Data diagnostics ---
    calls = ground_truth["calls"]
    users = ground_truth["users"]
    tokens = ground_truth["tokens"]

    rec_count = sum(1 for c in calls if c["is_recommendation"])
    noise_count = len(calls) - rec_count
    buy_count = sum(1 for c in calls if c["recommendation_type"] == "BUY")
    sell_count = sum(1 for c in calls if c["recommendation_type"] == "SELL")
    win_count = sum(1 for c in calls if c["outcome"] == "WIN")
    loss_count = sum(1 for c in calls if c["outcome"] == "LOSS")
    rug_token_count = sum(1 for t in tokens if t["is_rug"])
    qualified_user_count = sum(1 for u in users if u["is_qualified"])
    trustworthy_count = sum(1 for u in users if u["is_trustworthy"])

    archetypes: dict[str, int] = {}
    for u in users:
        archetypes[u["archetype"]] = archetypes.get(u["archetype"], 0) + 1

    log(f"Dataset: {len(calls):,} calls ({rec_count:,} recs, {noise_count:,} noise)")
    log(f"  BUY: {buy_count:,} | SELL: {sell_count:,}")
    log(f"  WIN: {win_count:,} | LOSS: {loss_count:,} | NEUTRAL: {len(calls)-win_count-loss_count:,}")
    log(f"  Users: {len(users):,} total, {qualified_user_count:,} qualified, {trustworthy_count:,} trustworthy")
    log(f"  Tokens: {len(tokens):,} total, {rug_token_count:,} rug tokens")
    log(f"  Archetypes: {archetypes}")

    if rug_token_count == 0:
        log("WARNING: 0 rug tokens — DETECT rug/promoter tasks will score 0", "WARN")

    promoter_count = sum(1 for u in users if u["archetype"] == "rug_promoter")
    if promoter_count == 0:
        log("WARNING: 0 rug_promoter users — DETECT promoter task will score 0", "WARN")

    # --- Suite execution ---
    suite_map = {
        "extract": (ExtractSuite, lambda: ExtractSuite.run(system, calls)),
        "rank": (RankSuite, lambda: RankSuite.run(system, users, calls)),
        "detect": (DetectSuite, lambda: DetectSuite.run(system, tokens, users, calls)),
        "profit": (ProfitSuite, lambda: ProfitSuite.run(system, calls, users)),
    }

    run_suites = suites or list(suite_map.keys())

    for suite_name in run_suites:
        if suite_name not in suite_map:
            log(f"Unknown suite: {suite_name}", "ERROR")
            continue

        suite_cls, runner = suite_map[suite_name]
        console.print(f"\n[bold cyan]{'='*60}[/]")
        console.print(f"[bold cyan]  Running {suite_cls.name} suite (weight: {suite_cls.weight:.0%})[/]")
        console.print(f"[bold cyan]{'='*60}[/]")
        system.reset()

        start = time.time()
        result = runner()
        elapsed = time.time() - start

        result_dict = asdict(result)
        result_dict["elapsed_seconds"] = round(elapsed, 2)
        results[suite_cls.name] = result_dict

        # --- Detailed per-metric logging ---
        _log_suite_details(suite_cls.name, result_dict)

        color = "green" if result.suite_score >= 90 else "yellow" if result.suite_score >= 50 else "red"
        console.print(f"\n  [bold {color}]Suite Score: {result.suite_score:.1f} / 100[/]  ({elapsed:.1f}s)")

    # --- Composite TMS ---
    if len(results) >= 4:
        tms = (
            0.25 * results.get("EXTRACT", {}).get("suite_score", 0)
            + 0.30 * results.get("RANK", {}).get("suite_score", 0)
            + 0.25 * results.get("DETECT", {}).get("suite_score", 0)
            + 0.20 * results.get("PROFIT", {}).get("suite_score", 0)
        )
        results["COMPOSITE"] = {"trust_marketplace_score": round(tms, 2)}

    return results


def _log_suite_details(suite_name: str, data: dict) -> None:
    """Log detailed per-metric breakdown for a suite."""
    skip = {"suite_score", "elapsed_seconds", "archetype_confusion"}
    for key, val in data.items():
        if key in skip:
            continue
        if isinstance(val, float):
            # Color code: green >= 0.8, yellow >= 0.5, red < 0.5
            if val >= 0.8:
                level = "OK"
            elif val >= 0.5:
                level = "INFO"
            elif val > 0:
                level = "WARN"
            else:
                level = "DETAIL"
            log(f"  {key}: {val:.4f}", level)
        elif isinstance(val, int):
            log(f"  {key}: {val}", "DETAIL")
        elif isinstance(val, list):
            log(f"  {key}: {val}", "DETAIL")


def print_results(results: dict[str, dict]) -> None:
    """Pretty-print benchmark results."""
    table = Table(title="Trust Marketplace Benchmark Results")
    table.add_column("Suite", style="cyan")
    table.add_column("Score", justify="right", style="bold")
    table.add_column("Key Metrics", style="dim")

    for suite_name, data in results.items():
        if suite_name == "COMPOSITE":
            continue
        score = data.get("suite_score", 0)
        elapsed = data.get("elapsed_seconds", 0)

        # Pick 2-3 key metrics to show
        key_metrics: list[str] = []
        if suite_name == "EXTRACT":
            key_metrics.append(f"F1={data.get('detection_f1', 0):.3f}")
            key_metrics.append(f"Sent-F1={data.get('sentiment_macro_f1', 0):.3f}")
        elif suite_name == "RANK":
            key_metrics.append(f"ρ={data.get('spearman_rho', 0):.3f}")
            key_metrics.append(f"P@10={data.get('precision_at_10', 0):.3f}")
        elif suite_name == "DETECT":
            key_metrics.append(f"Rug-R={data.get('rug_recall', 0):.3f}")
            key_metrics.append(f"Prom-F1={data.get('promoter_f1', 0):.3f}")
        elif suite_name == "PROFIT":
            key_metrics.append(f"Sharpe={data.get('leaders_sharpe', 0):.2f}")
            key_metrics.append(f"Δ={data.get('return_improvement', 0):+.1f}%")

        metrics_str = ", ".join(key_metrics) + f"  [{elapsed:.1f}s]"

        color = "green" if score >= 70 else "yellow" if score >= 40 else "red"
        table.add_row(suite_name, f"[{color}]{score:.1f}[/]", metrics_str)

    composite = results.get("COMPOSITE", {}).get("trust_marketplace_score", 0)
    if composite:
        table.add_section()
        color = "green" if composite >= 70 else "yellow" if composite >= 40 else "red"
        table.add_row("[bold]COMPOSITE (TMS)[/]", f"[bold {color}]{composite:.1f}[/]", "")

    console.print(table)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


@click.command()
@click.option("--data-dir", required=True, type=click.Path(exists=True), help="Path to trenches-chat-dataset/data/")
@click.option("--suite", multiple=True, help="Specific suite(s) to run (extract, rank, detect, profit)")
@click.option("--output", default=None, type=click.Path(), help="Output directory for results JSON")
@click.option("--generate-gt", is_flag=True, help="Only generate ground truth, don't run benchmarks")
@click.option("--system", "system_name", default="baseline", help="System to benchmark (baseline or path to plugin)")
@click.option("--model", default=None, type=str, help="Model name override for LLM-backed systems")
@click.option("--api-base", default=None, type=str, help="OpenAI-compatible API base URL (e.g. https://api.groq.com/openai/v1)")
def main(
    data_dir: str,
    suite: tuple[str, ...],
    output: str | None,
    generate_gt: bool,
    system_name: str,
    model: str | None,
    api_base: str | None,
) -> None:
    """Trust Marketplace Benchmark Harness."""
    data_path = Path(data_dir)

    console.print("[bold]Trust Marketplace Benchmark[/]")
    console.print(f"Data: {data_path}")

    # Generate ground truth
    gt = load_ground_truth(data_path)
    console.print(f"  Calls:  {len(gt['calls']):,}")
    console.print(f"  Users:  {len(gt['users']):,}")
    console.print(f"  Tokens: {len(gt['tokens']):,}")

    if generate_gt:
        console.print("[green]Ground truth generated. Exiting.[/]")
        return

    # Initialize system
    if system_name == "oracle":
        console.print("\n[bold magenta]System: OracleSystem (perfect-knowledge validator)[/]")
        sys_instance: SocialAlphaSystem = OracleSystem(gt["calls"], gt["users"], gt["tokens"])
    elif system_name == "smart":
        console.print("\n[bold cyan]System: SmartBaselineSystem (improved heuristics)[/]")
        sys_instance = SmartBaselineSystem()
    elif system_name == "full":
        cache_dir = data_path / ".." / ".benchmark_cache"
        console.print(f"\n[bold green]System: FullSystem (LLM extraction + balanced trust scoring)[/]")
        console.print(f"  Cache dir: {cache_dir.resolve()}")
        from dotenv import load_dotenv
        load_dotenv(Path(__file__).resolve().parents[3] / ".env")  # load from workspace root
        if api_base:
            os.environ["OPENAI_BASE_URL"] = api_base
        sys_instance = FullSystem(cache_dir=cache_dir, model=model or "gpt-4o-mini")
    elif system_name == "eliza":
        cache_dir = data_path / ".." / ".benchmark_cache"
        console.print(f"\n[bold blue]System: ElizaSystem (Eliza AgentRuntime + social-alpha plugin)[/]")
        console.print(f"  Cache dir: {cache_dir.resolve()}")
        from dotenv import load_dotenv
        load_dotenv(Path(__file__).resolve().parents[3] / ".env")  # load from workspace root
        if api_base:
            os.environ["OPENAI_BASE_URL"] = api_base
        sys_instance = ElizaSystem(cache_dir=cache_dir, model=model or "gpt-4o-mini")
    else:
        sys_instance = BaselineSystem()
        console.print(f"\nSystem: [bold]{sys_instance.__class__.__name__}[/]")

    suites_to_run = list(suite) if suite else None
    selected_suites = [s.lower() for s in suites_to_run] if suites_to_run else None

    # Pre-warm cache for LLM systems only when EXTRACT is requested.
    # Rank/Detect/Profit do not depend on extraction and should not pay LLM cost.
    if hasattr(sys_instance, "warm_cache") and (selected_suites is None or "extract" in selected_suites):
        all_messages = [c["content"] for c in gt["calls"]]
        sys_instance.warm_cache(all_messages)

    # Run benchmarks
    results = run_benchmark(sys_instance, gt, suites_to_run)

    # Print results
    print_results(results)

    # Finalize system (save caches, print stats)
    if hasattr(sys_instance, "finalize"):
        sys_instance.finalize()

    # Save results
    if output:
        output_path = Path(output)
        output_path.mkdir(parents=True, exist_ok=True)
        tag = system_name or "baseline"
        results_file = output_path / f"benchmark_results_{tag}.json"
        with open(results_file, "w") as f:
            json.dump(results, f, indent=2, default=str)
        console.print(f"\n[green]Results saved to {results_file}[/]")

        # Save detailed log
        log_file = output_path / f"benchmark_log_{tag}.txt"
        with open(log_file, "w") as f:
            f.write("\n".join(LOG_LINES))
        console.print(f"[green]Detailed log saved to {log_file}[/]")


if __name__ == "__main__":
    main()
