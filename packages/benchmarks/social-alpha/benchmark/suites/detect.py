"""
DETECT Suite — Scam and Bad Actor Detection

Tests the system's ability to protect the agent from catastrophic losses.

Tasks:
  A. Rug Pull Token Detection
  B. Scam Promoter Identification
  C. Archetype Classification
"""

from __future__ import annotations

from dataclasses import dataclass

from sklearn.metrics import (
    f1_score,
    precision_score,
    recall_score,
    confusion_matrix,
)

from ..protocol import SocialAlphaSystem
from ..utils import replay_calls


@dataclass
class DetectResults:
    # Task A: Rug Pull Detection
    rug_precision: float
    rug_recall: float
    rug_f1: float
    rug_total: int

    # Task B: Scam Promoter
    promoter_precision: float
    promoter_recall: float
    promoter_f1: float
    promoter_total: int

    # Task C: Archetype
    archetype_macro_f1: float
    archetype_accuracy: float
    archetype_confusion: list[list[int]]  # serializable confusion matrix
    archetype_labels: list[str]

    # Composite
    suite_score: float


class DetectSuite:
    """Benchmark suite for scam and bad-actor detection."""

    name = "DETECT"
    weight = 0.25

    @staticmethod
    def run(
        system: SocialAlphaSystem,
        token_ground_truth: list[dict],
        user_ground_truth: list[dict],
        call_ground_truth: list[dict],
    ) -> DetectResults:
        """Run all detection benchmarks."""

        # Replay calls so the system has state (standardized replay)
        replay_calls(system, call_ground_truth, include_prices=True)

        # ----- Task A: Rug Pull Token Detection -----
        rug_tokens = [t for t in token_ground_truth if t["call_count"] >= 2]
        y_true_rug: list[int] = []
        y_pred_rug: list[int] = []

        for token in rug_tokens:
            y_true_rug.append(1 if token["is_rug"] else 0)
            y_pred_rug.append(1 if system.is_scam_token(token["address"]) else 0)

        rug_prec = precision_score(y_true_rug, y_pred_rug, zero_division=0) if rug_tokens else 0
        rug_rec = recall_score(y_true_rug, y_pred_rug, zero_division=0) if rug_tokens else 0
        rug_f1 = f1_score(y_true_rug, y_pred_rug, zero_division=0) if rug_tokens else 0

        # ----- Task B: Scam Promoter Identification -----
        qualified_users = [u for u in user_ground_truth if u["is_qualified"]]
        y_true_promoter: list[int] = []
        y_pred_promoter: list[int] = []

        for user in qualified_users:
            is_promoter = user["archetype"] == "rug_promoter"
            y_true_promoter.append(1 if is_promoter else 0)

            sys_score = system.get_user_trust_score(user["user_id"])
            # System flags as promoter if trust score is very low
            if sys_score:
                y_pred_promoter.append(1 if sys_score.trust_score < 20 else 0)
            else:
                y_pred_promoter.append(0)

        prom_prec = precision_score(y_true_promoter, y_pred_promoter, zero_division=0)
        prom_rec = recall_score(y_true_promoter, y_pred_promoter, zero_division=0)
        prom_f1 = f1_score(y_true_promoter, y_pred_promoter, zero_division=0)

        # ----- Task C: Archetype Classification -----
        y_true_arch: list[str] = []
        y_pred_arch: list[str] = []
        arch_labels_set: set[str] = set()

        for user in qualified_users:
            y_true_arch.append(user["archetype"])
            arch_labels_set.add(user["archetype"])

            sys_score = system.get_user_trust_score(user["user_id"])
            if sys_score:
                y_pred_arch.append(sys_score.archetype)
                arch_labels_set.add(sys_score.archetype)
            else:
                y_pred_arch.append("low_info")
                arch_labels_set.add("low_info")

        arch_labels = sorted(arch_labels_set)
        arch_macro_f1 = f1_score(
            y_true_arch, y_pred_arch, labels=arch_labels, average="macro", zero_division=0
        )
        arch_acc = sum(1 for a, b in zip(y_true_arch, y_pred_arch) if a == b) / len(y_true_arch) if y_true_arch else 0

        try:
            cm = confusion_matrix(y_true_arch, y_pred_arch, labels=arch_labels).tolist()
        except Exception:
            cm = []

        # ----- Composite Score -----
        # Adaptive weighting: if a task has no positive cases, redistribute its
        # weight to the remaining tasks so the score ceiling isn't artificially capped.
        rug_has_positives = sum(y_true_rug) > 0 if y_true_rug else False
        prom_has_positives = sum(y_true_promoter) > 0 if y_true_promoter else False

        w_rug = 0.35 if rug_has_positives else 0.0
        w_prom = 0.35 if prom_has_positives else 0.0
        w_arch = 0.30
        total_w = w_rug + w_prom + w_arch
        if total_w > 0:
            w_rug /= total_w
            w_prom /= total_w
            w_arch /= total_w

        suite_score = (
            w_rug * (rug_rec * 100)
            + w_prom * (prom_f1 * 100)
            + w_arch * (arch_macro_f1 * 100)
        )

        return DetectResults(
            rug_precision=round(rug_prec, 4),
            rug_recall=round(rug_rec, 4),
            rug_f1=round(rug_f1, 4),
            rug_total=sum(y_true_rug),
            promoter_precision=round(prom_prec, 4),
            promoter_recall=round(prom_rec, 4),
            promoter_f1=round(prom_f1, 4),
            promoter_total=sum(y_true_promoter),
            archetype_macro_f1=round(arch_macro_f1, 4),
            archetype_accuracy=round(arch_acc, 4),
            archetype_confusion=cm,
            archetype_labels=arch_labels,
            suite_score=round(suite_score, 2),
        )
