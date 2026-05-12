"""
RANK Suite — Trust Score Ranking Quality

Tests whether computed trust scores correctly order users by reliability.

Tasks:
  A. Global Ranking Correlation (Spearman rho)
  B. Top-K Precision (are the system's top users actually good?)
  C. Bottom-K Precision (are the system's worst users actually bad?)
  D. Trustworthy/Untrustworthy binary classification (AUROC)
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.stats import spearmanr, kendalltau
from sklearn.metrics import roc_auc_score, f1_score, ndcg_score

from ..protocol import SocialAlphaSystem
from ..utils import safe_float, replay_calls


@dataclass
class RankResults:
    # Task A: Global Ranking
    spearman_rho: float
    kendall_tau: float
    num_ranked_users: int

    # Task B: Top-K Precision
    precision_at_10: float
    precision_at_25: float
    precision_at_50: float
    ndcg_at_10: float

    # Task C: Bottom-K Precision
    bottom_precision_at_10: float
    bottom_precision_at_25: float

    # Task D: Binary Classification
    auroc_trustworthy: float
    f1_trustworthy: float

    # Composite
    suite_score: float


class RankSuite:
    """Benchmark suite for trust score ranking quality."""

    name = "RANK"
    weight = 0.30

    @staticmethod
    def run(
        system: SocialAlphaSystem,
        user_ground_truth: list[dict],
        call_ground_truth: list[dict],
    ) -> RankResults:
        """
        Run all ranking benchmarks.

        First replays all calls through the system chronologically,
        then evaluates the resulting rankings against ground truth.
        """
        # ----- Step 1: Replay calls chronologically (standardized) -----
        replay_calls(system, call_ground_truth, include_prices=True)

        # ----- Step 2: Get system's rankings -----
        qualified_gt = [u for u in user_ground_truth if u["is_qualified"]]
        if not qualified_gt:
            return _empty_results()

        system_leaderboard = system.get_leaderboard(top_k=len(qualified_gt))
        system_scores_by_id = {s.user_id: s for s in system_leaderboard}

        # Match users between ground truth and system
        matched_users = []
        for gt_user in qualified_gt:
            sys_score = system_scores_by_id.get(gt_user["user_id"])
            if sys_score:
                matched_users.append((gt_user, sys_score))

        if len(matched_users) < 5:
            return _empty_results()

        # ----- Task A: Global Ranking Correlation -----
        gt_scores = [u["rank_score"] for u, _ in matched_users]
        sys_scores = [s.trust_score for _, s in matched_users]

        rho_raw, _ = spearmanr(gt_scores, sys_scores)
        tau_raw, _ = kendalltau(gt_scores, sys_scores)
        rho = safe_float(rho_raw)
        tau = safe_float(tau_raw)

        # ----- Task B: Top-K Precision -----
        # Sort ground truth by actual performance (descending)
        gt_ranked = sorted(matched_users, key=lambda x: x[0]["rank_score"], reverse=True)
        gt_top_10_ids = {u["user_id"] for u, _ in gt_ranked[:10]}
        gt_top_25_ids = {u["user_id"] for u, _ in gt_ranked[:25]}
        gt_top_50_ids = {u["user_id"] for u, _ in gt_ranked[:50]}

        # Sort by system score (descending)
        sys_ranked = sorted(matched_users, key=lambda x: x[1].trust_score, reverse=True)
        sys_top_10_ids = {s.user_id for _, s in sys_ranked[:10]}
        sys_top_25_ids = {s.user_id for _, s in sys_ranked[:25]}
        sys_top_50_ids = {s.user_id for _, s in sys_ranked[:50]}

        p_at_10 = len(gt_top_10_ids & sys_top_10_ids) / 10 if len(matched_users) >= 10 else 0
        p_at_25 = len(gt_top_25_ids & sys_top_25_ids) / 25 if len(matched_users) >= 25 else 0
        p_at_50 = len(gt_top_50_ids & sys_top_50_ids) / 50 if len(matched_users) >= 50 else 0

        # NDCG@10 — use matched_users in FIXED order (not sorted), let ndcg_score handle ranking.
        # y_true = ground truth relevance, y_score = system's predicted relevance.
        if len(matched_users) >= 10:
            y_true_ndcg = np.array([u["rank_score"] for u, _ in matched_users]).reshape(1, -1)
            y_score_ndcg = np.array([s.trust_score for _, s in matched_users]).reshape(1, -1)
            ndcg_10 = safe_float(float(ndcg_score(y_true_ndcg, y_score_ndcg, k=10)))
        else:
            ndcg_10 = 0.0

        # ----- Task C: Bottom-K Precision -----
        gt_bottom_10_ids = {u["user_id"] for u, _ in gt_ranked[-10:]}
        gt_bottom_25_ids = {u["user_id"] for u, _ in gt_ranked[-25:]}
        sys_bottom_10_ids = {s.user_id for _, s in sys_ranked[-10:]}
        sys_bottom_25_ids = {s.user_id for _, s in sys_ranked[-25:]}

        bp_at_10 = len(gt_bottom_10_ids & sys_bottom_10_ids) / 10 if len(matched_users) >= 10 else 0
        bp_at_25 = len(gt_bottom_25_ids & sys_bottom_25_ids) / 25 if len(matched_users) >= 25 else 0

        # ----- Task D: Binary Classification (Trustworthy vs Not) -----
        y_true = [1 if u["is_trustworthy"] else 0 for u, _ in matched_users]
        y_scores = [s.trust_score for _, s in matched_users]

        if len(set(y_true)) > 1:
            auroc = roc_auc_score(y_true, y_scores)
        else:
            auroc = 0.5  # degenerate case

        # F1 at median threshold
        threshold = np.median(y_scores)
        y_pred = [1 if s >= threshold else 0 for s in y_scores]
        f1_trust = f1_score(y_true, y_pred, zero_division=0)

        # ----- Composite Score -----
        suite_score = (
            0.30 * (max(safe_float(rho), 0) * 100)
            + 0.30 * (safe_float(ndcg_10) * 100)
            + 0.20 * (safe_float(auroc) * 100)
            + 0.20 * (p_at_10 * 100)
        )

        return RankResults(
            spearman_rho=round(rho, 4),
            kendall_tau=round(tau, 4),
            num_ranked_users=len(matched_users),
            precision_at_10=round(p_at_10, 4),
            precision_at_25=round(p_at_25, 4),
            precision_at_50=round(p_at_50, 4),
            ndcg_at_10=round(ndcg_10, 4),
            bottom_precision_at_10=round(bp_at_10, 4),
            bottom_precision_at_25=round(bp_at_25, 4),
            auroc_trustworthy=round(auroc, 4),
            f1_trustworthy=round(f1_trust, 4),
            suite_score=round(suite_score, 2),
        )


def _empty_results() -> RankResults:
    return RankResults(
        spearman_rho=0, kendall_tau=0, num_ranked_users=0,
        precision_at_10=0, precision_at_25=0, precision_at_50=0, ndcg_at_10=0,
        bottom_precision_at_10=0, bottom_precision_at_25=0,
        auroc_trustworthy=0.5, f1_trustworthy=0,
        suite_score=0,
    )
