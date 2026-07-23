"""
PROFIT Suite — Real-World Profitability Simulation

Tests whether following the system's output would have actually made money.

Tasks:
  A. Follow-the-Leaders Portfolio
  B. Avoid-the-Losers Filter
  C. Trust-Weighted Strategy
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from ..protocol import SocialAlphaSystem
from ..utils import safe_float, replay_calls


@dataclass
class ProfitResults:
    # Task A: Follow-the-Leaders
    leaders_total_return: float  # %
    leaders_sharpe: float
    leaders_max_drawdown: float  # %
    leaders_num_trades: int
    baseline_total_return: float  # equal-weight all users

    # Task B: Avoid-the-Losers
    filtered_total_return: float  # %
    return_improvement: float  # % points vs baseline
    loss_avoidance_rate: float  # % of losses avoided

    # Task C: Trust-Weighted
    weighted_total_return: float  # %
    information_ratio: float  # excess return / tracking error vs baseline

    # Composite
    suite_score: float


def _sharpe(returns: list[float], risk_free: float = 0.0) -> float:
    """Annualized Sharpe ratio from a series of per-trade returns."""
    if len(returns) < 2:
        return 0.0
    arr = np.array(returns)
    excess = arr - risk_free
    mean_r = float(np.mean(excess))
    std_r = float(np.std(excess, ddof=1))
    if std_r == 0:
        return 0.0
    # Annualize: assume ~365 trades/year opportunity
    return mean_r / std_r * math.sqrt(min(len(returns), 365))


def _max_drawdown(cumulative_returns: list[float]) -> float:
    """Max drawdown from a cumulative return series."""
    if not cumulative_returns:
        return 0.0
    peak = cumulative_returns[0]
    max_dd = 0.0
    for r in cumulative_returns:
        if r > peak:
            peak = r
        dd = (peak - r) / peak if peak > 0 else 0
        max_dd = max(max_dd, dd)
    return max_dd * 100


class ProfitSuite:
    """Benchmark suite for real-world profitability simulation."""

    name = "PROFIT"
    weight = 0.20

    @staticmethod
    def run(
        system: SocialAlphaSystem,
        call_ground_truth: list[dict],
        user_ground_truth: list[dict],
    ) -> ProfitResults:
        """Run profitability simulations."""

        # Sort calls chronologically
        sorted_calls = sorted(call_ground_truth, key=lambda c: c["timestamp"])
        buy_calls = [c for c in sorted_calls if c["recommendation_type"] == "BUY"]

        if not buy_calls:
            return _empty_profit()

        # Replay all calls to build system state (standardized replay)
        replay_calls(system, call_ground_truth, include_prices=True)

        # Get system's leaderboard
        leaderboard = system.get_leaderboard(top_k=100)
        if not leaderboard:
            return _empty_profit()

        top_10_ids = {s.user_id for s in leaderboard[:10]}
        bottom_10_ids = {s.user_id for s in leaderboard[-10:]} if len(leaderboard) >= 20 else set()
        trust_by_user = {s.user_id: s.trust_score for s in leaderboard}

        # ----- BASELINE: Equal-weight all buy calls (include ALL, even zero-profit) -----
        all_returns = [c["profit_pct"] for c in buy_calls]
        baseline_total = sum(all_returns) / len(all_returns) if all_returns else 0

        # ----- Task A: Follow-the-Leaders -----
        leader_calls = [c for c in buy_calls if c["user_id"] in top_10_ids]
        leader_returns = [c["profit_pct"] for c in leader_calls]
        leader_avg = sum(leader_returns) / len(leader_returns) if leader_returns else 0
        leader_sharpe = _sharpe(leader_returns)  # include ALL returns (zeros are real outcomes)

        # Cumulative for drawdown — start with initial investment
        leader_cum: list[float] = [100.0]  # include initial value
        running = 100.0
        for r in leader_returns:
            running *= (1 + r / 100)
            running = max(running, 0.01)  # clamp to avoid negative
            leader_cum.append(running)
        leader_mdd = _max_drawdown(leader_cum)

        # ----- Task B: Avoid-the-Losers -----
        filtered_calls = [c for c in buy_calls if c["user_id"] not in bottom_10_ids]
        filtered_returns = [c["profit_pct"] for c in filtered_calls]
        filtered_total = sum(filtered_returns) / len(filtered_returns) if filtered_returns else 0
        improvement = filtered_total - baseline_total

        # Count losses avoided
        excluded_calls = [c for c in buy_calls if c["user_id"] in bottom_10_ids]
        excluded_losses = sum(1 for c in excluded_calls if c["profit_pct"] < 0)
        loss_avoidance = excluded_losses / len(excluded_calls) if excluded_calls else 0

        # ----- Task C: Trust-Weighted -----
        # Use same population as baseline (all buy_calls).
        # Each call is weighted by the caller's trust score.
        weights = []
        for c in buy_calls:
            trust = trust_by_user.get(c["user_id"], 50)
            weights.append(max(trust / 100, 0.01))

        total_weight = sum(weights)
        n = len(buy_calls)

        # Weighted average return
        weighted_total = (
            sum(c["profit_pct"] * w for c, w in zip(buy_calls, weights)) / total_weight
            if total_weight > 0
            else 0
        )

        # Information Ratio = (weighted_return - baseline_return) / tracking_error
        # Tracking error = std of per-call contribution differences between the
        # weighted strategy and the equal-weight benchmark.
        #   weighted contribution_i = return_i * (w_i / sum(w))
        #   baseline contribution_i = return_i * (1 / N)
        #   diff_i = return_i * (w_i/sum(w) - 1/N)
        diffs = []
        for c, w in zip(buy_calls, weights):
            weighted_frac = w / total_weight if total_weight > 0 else 0
            baseline_frac = 1.0 / n if n > 0 else 0
            diffs.append(c["profit_pct"] * (weighted_frac - baseline_frac))

        te_std = float(np.std(diffs, ddof=1)) if len(diffs) > 1 else 0.0
        ir = (weighted_total - baseline_total) / te_std if te_std > 1e-10 else 0.0

        # ----- Composite Score -----
        # Guard all values against NaN/inf
        leader_sharpe = safe_float(leader_sharpe)
        leader_avg = safe_float(leader_avg)
        baseline_total = safe_float(baseline_total)
        improvement = safe_float(improvement)
        ir = min(safe_float(ir), 10.0)  # cap IR at 10 to prevent inf from tiny tracking error

        # Sharpe ratio score: reflects risk-adjusted quality of leader picks.
        # With many calls, Sharpe is the most reliable signal.
        # Scale: 1.0 -> 50, 2.0 -> 100
        sharpe_score = min(100, max(0, leader_sharpe * 50)) if leader_sharpe > 0 else 0

        # Leaders outperform baseline? Scale so +0.5% above = 100, -0.5% below = 0.
        leaders_vs_baseline = leader_avg - baseline_total
        leader_alpha_score = min(100, max(0, 50 + leaders_vs_baseline * 100))

        # Filtering improvement: does removing bottom users help?
        improvement_score = min(100, max(0, 50 + improvement * 100))

        # Number of leader trades — more is better (shows the system can FIND good users,
        # not just luck into 14 trades). Log scale: 10 -> 25, 100 -> 50, 1000 -> 75, 10000 -> 100
        coverage_score = min(100, max(0, math.log10(max(len(leader_calls), 1)) * 33))

        suite_score = (
            0.30 * sharpe_score
            + 0.25 * leader_alpha_score
            + 0.20 * improvement_score
            + 0.25 * coverage_score
        )

        return ProfitResults(
            leaders_total_return=round(leader_avg, 4),
            leaders_sharpe=round(leader_sharpe, 4),
            leaders_max_drawdown=round(leader_mdd, 4),
            leaders_num_trades=len(leader_calls),
            baseline_total_return=round(baseline_total, 4),
            filtered_total_return=round(filtered_total, 4),
            return_improvement=round(improvement, 4),
            loss_avoidance_rate=round(loss_avoidance, 4),
            weighted_total_return=round(weighted_total, 4),
            information_ratio=round(ir, 4),
            suite_score=round(suite_score, 2),
        )


def _empty_profit() -> ProfitResults:
    return ProfitResults(
        leaders_total_return=0, leaders_sharpe=0, leaders_max_drawdown=0,
        leaders_num_trades=0, baseline_total_return=0,
        filtered_total_return=0, return_improvement=0, loss_avoidance_rate=0,
        weighted_total_return=0, information_ratio=0,
        suite_score=0,
    )
