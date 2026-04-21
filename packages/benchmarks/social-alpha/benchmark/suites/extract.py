"""
EXTRACT Suite — Recommendation Extraction Quality

Tests the system's NLP pipeline for pulling structured signals from raw chat.

Tasks:
  A. Call Detection (binary: is this a trading recommendation?)
  B. Sentiment Classification (positive / negative / neutral)
  C. Conviction Estimation (HIGH / MEDIUM / LOW)
  D. Token Extraction (ticker + resolved address)
"""

from __future__ import annotations

from dataclasses import dataclass

from sklearn.metrics import (
    accuracy_score,
    f1_score,
    precision_score,
    recall_score,
)
from scipy.stats import kendalltau

from ..protocol import SocialAlphaSystem
from ..utils import safe_float


@dataclass
class ExtractResults:
    # Task A: Call Detection
    detection_precision: float
    detection_recall: float
    detection_f1: float
    detection_accuracy: float

    # Task B: Sentiment Classification
    sentiment_macro_f1: float
    sentiment_precision_buy: float
    sentiment_recall_buy: float
    sentiment_precision_sell: float
    sentiment_recall_sell: float

    # Task C: Conviction
    conviction_kendall_tau: float
    conviction_accuracy: float

    # Task D: Token Extraction
    token_extraction_accuracy: float
    token_resolution_accuracy: float

    # Composite
    suite_score: float


class ExtractSuite:
    """Benchmark suite for recommendation extraction quality."""

    name = "EXTRACT"
    weight = 0.25  # contribution to composite TMS score

    @staticmethod
    def run(
        system: SocialAlphaSystem,
        call_ground_truth: list[dict],
        message_ground_truth: list[dict] | None = None,
    ) -> ExtractResults:
        """
        Run all extraction benchmarks.

        IMPORTANT: We call extract_recommendation ONCE per item and cache the
        result. This avoids double-consuming stateful systems like the Oracle.
        """
        # ----- Step 0: Extract all predictions up front (one call per item) -----
        predictions: list[tuple[dict, "ExtractionResult"]] = []
        for gt in call_ground_truth:
            result = system.extract_recommendation(gt["content"])
            predictions.append((gt, result))

        # ----- Task A: Call Detection -----
        y_true_detect: list[int] = []
        y_pred_detect: list[int] = []

        for gt, result in predictions:
            y_true_detect.append(1 if gt["is_recommendation"] else 0)
            y_pred_detect.append(1 if result.is_recommendation else 0)

        det_prec = precision_score(y_true_detect, y_pred_detect, zero_division=0)
        det_rec = recall_score(y_true_detect, y_pred_detect, zero_division=0)
        det_f1 = f1_score(y_true_detect, y_pred_detect, zero_division=0)
        det_acc = accuracy_score(y_true_detect, y_pred_detect)

        # ----- Task B: Sentiment Classification -----
        recs_preds = [(gt, r) for gt, r in predictions if gt["is_recommendation"]]
        y_true_sent: list[str] = []
        y_pred_sent: list[str] = []

        for gt, result in recs_preds:
            y_true_sent.append(gt["recommendation_type"])
            y_pred_sent.append(result.recommendation_type)

        sent_macro_f1 = f1_score(y_true_sent, y_pred_sent, average="macro", zero_division=0)
        labels_buy = ["BUY"]
        labels_sell = ["SELL"]
        sent_prec_buy = precision_score(
            y_true_sent, y_pred_sent, labels=labels_buy, average="micro", zero_division=0
        )
        sent_rec_buy = recall_score(
            y_true_sent, y_pred_sent, labels=labels_buy, average="micro", zero_division=0
        )
        sent_prec_sell = precision_score(
            y_true_sent, y_pred_sent, labels=labels_sell, average="micro", zero_division=0
        )
        sent_rec_sell = recall_score(
            y_true_sent, y_pred_sent, labels=labels_sell, average="micro", zero_division=0
        )

        # ----- Task C: Conviction Estimation -----
        conv_map = {"HIGH": 3, "MEDIUM": 2, "LOW": 1, "NONE": 0}
        y_true_conv: list[int] = []
        y_pred_conv: list[int] = []

        for gt, result in recs_preds:
            y_true_conv.append(conv_map.get(gt["conviction"], 0))
            y_pred_conv.append(conv_map.get(result.conviction, 0))

        tau_raw, _ = kendalltau(y_true_conv, y_pred_conv) if y_true_conv else (0.0, 1.0)
        tau = safe_float(tau_raw)
        conv_acc = accuracy_score(y_true_conv, y_pred_conv) if y_true_conv else 0.0

        # ----- Task D: Token Extraction -----
        token_extract_correct = 0
        token_resolve_correct = 0
        token_total = 0

        for gt, result in recs_preds:
            if not gt.get("token_mentioned"):
                continue
            token_total += 1

            # Extraction: did we find the right ticker?
            gt_ticker = gt["token_mentioned"].upper().strip("$")
            pred_ticker = result.token_mentioned.upper().strip("$")
            if gt_ticker == pred_ticker:
                token_extract_correct += 1

            # Resolution: did we resolve to the right address?
            if gt.get("token_address") and result.token_address:
                if gt["token_address"].lower() == result.token_address.lower():
                    token_resolve_correct += 1

        tok_ext_acc = token_extract_correct / token_total if token_total > 0 else 0.0
        tok_res_acc = token_resolve_correct / token_total if token_total > 0 else 0.0

        # ----- Composite Score -----
        suite_score = (
            0.30 * (det_f1 * 100)
            + 0.30 * (sent_macro_f1 * 100)
            + 0.15 * (max(safe_float(tau), 0) * 100)
            + 0.25 * (tok_ext_acc * 100)
        )

        return ExtractResults(
            detection_precision=round(det_prec, 4),
            detection_recall=round(det_rec, 4),
            detection_f1=round(det_f1, 4),
            detection_accuracy=round(det_acc, 4),
            sentiment_macro_f1=round(sent_macro_f1, 4),
            sentiment_precision_buy=round(sent_prec_buy, 4),
            sentiment_recall_buy=round(sent_rec_buy, 4),
            sentiment_precision_sell=round(sent_prec_sell, 4),
            sentiment_recall_sell=round(sent_rec_sell, 4),
            conviction_kendall_tau=round(tau, 4),
            conviction_accuracy=round(conv_acc, 4),
            token_extraction_accuracy=round(tok_ext_acc, 4),
            token_resolution_accuracy=round(tok_res_acc, 4),
            suite_score=round(suite_score, 2),
        )
