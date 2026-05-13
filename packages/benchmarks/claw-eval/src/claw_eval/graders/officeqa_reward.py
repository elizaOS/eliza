"""OfficeQA reward functions — ported from databricks/officeqa/reward.py.

Provides fuzzy matching for numerical and textual answers with configurable
tolerance. Used by OfficeQA task graders.

Usage:
    from claw_eval.graders.officeqa_reward import score_answer
    score = score_answer("2,602", "The answer is 2602 million", tolerance=0.05)
"""

from __future__ import annotations

import re


def normalize_text(text: str) -> str:
    """Normalize Unicode minus to ASCII hyphen."""
    if not text:
        raise ValueError("Cannot normalize empty or None text")
    normalized = text.replace("\u2212", "-")
    normalized = normalized.replace("−", "-")
    return normalized


def extract_numbers_with_context(
    text: str,
) -> list[tuple[float, str, bool, bool]]:
    """Extract numbers with surrounding context for unit detection.

    Returns list of (number_value, context_string, has_percent, is_negative).
    """
    if not text:
        raise ValueError("Cannot extract numbers from empty text")

    text = normalize_text(text)

    # Remove commas from thousands-separated numbers
    text_no_commas = re.sub(
        r"\d{1,3}(?:,\d{3})+(?:\.\d+)?",
        lambda m: m.group().replace(",", ""),
        text,
    )

    numbers_with_context: list[tuple[float, str, bool, bool]] = []
    pattern = r"-?\d+\.?\d*%?"

    for match in re.finditer(pattern, text_no_commas):
        matched_text = match.group()
        if not matched_text or matched_text == "-":
            continue

        has_percent = matched_text.endswith("%")
        num_text = matched_text.rstrip("%")
        is_negative = num_text.startswith("-")

        try:
            num = float(num_text)
        except ValueError as e:
            raise ValueError(
                f"Failed to parse number from '{matched_text}': {e}"
            ) from e

        start = max(0, match.start() - 20)
        end = min(len(text_no_commas), match.end() + 20)
        context = text_no_commas[start:end].lower()
        numbers_with_context.append((num, context, has_percent, is_negative))

    return numbers_with_context


def detect_unit_in_context(context: str) -> tuple[str | None, float]:
    """Detect unit words in context and return (unit_name, multiplier)."""
    context_lower = context.lower()

    if re.search(r"\btrillions?\b", context_lower):
        return ("trillion", 1e12)
    if re.search(r"\bbillions?\b", context_lower) or re.search(
        r"\bb\b", context_lower
    ):
        return ("billion", 1e9)
    if re.search(r"\bmillions?\b", context_lower) or re.search(
        r"\bm\b", context_lower
    ):
        return ("million", 1e6)
    if re.search(r"\bthousands?\b", context_lower) or re.search(
        r"\bk\b", context_lower
    ):
        return ("thousand", 1e3)

    return (None, 1.0)


def normalize_number_with_units(
    number: float, context: str
) -> tuple[float, str | None]:
    """Return (base_number, unit_name) — does NOT multiply."""
    try:
        unit_name, _ = detect_unit_in_context(context)
        return (number, unit_name)
    except Exception as e:
        raise ValueError(
            f"Failed to normalize number {number} with context '{context}': {e}"
        ) from e


def is_likely_year(num: float) -> bool:
    """Check if a number looks like a year (1900–2100)."""
    return 1900 <= num <= 2100 and num == int(num)


def has_significant_text(text: str) -> tuple[bool, str]:
    """Check if text has meaningful non-numeric content beyond unit words."""
    if not text:
        return False, ""

    cleaned = normalize_text(text).lower()
    cleaned = re.sub(r"-?\d+\.?\d*%?", "", cleaned)
    cleaned = re.sub(r"[,]", "", cleaned)

    unit_words = [
        "trillion", "trillions", "billion", "billions",
        "million", "millions", "thousand", "thousands",
        "hundred", "hundreds", "percent", "percentage", "%",
    ]
    for unit in unit_words:
        cleaned = re.sub(r"\b" + unit + r"\b", "", cleaned)

    cleaned = re.sub(r"[^\w\s]", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return len(cleaned) >= 2, cleaned


def check_text_overlap(
    gt_text: str, pred_text: str
) -> tuple[bool, str]:
    """Check if key text elements overlap between ground truth and prediction."""
    if not gt_text or not pred_text:
        return False, "Empty text in comparison"

    gt_has_text, gt_cleaned = has_significant_text(gt_text)
    pred_has_text, pred_cleaned = has_significant_text(pred_text)

    if not gt_has_text:
        return True, "GT is purely numeric, text check not required"

    if not pred_has_text:
        return False, f"GT has text '{gt_cleaned}' but prediction is purely numeric"

    if gt_cleaned in pred_cleaned:
        return True, f"Text overlap: '{gt_cleaned}' found in prediction"
    if pred_cleaned in gt_cleaned:
        return True, f"Text overlap: prediction text '{pred_cleaned}' matches GT"

    return False, f"Text mismatch: GT='{gt_cleaned}', Pred='{pred_cleaned}'"


def extract_final_answer(text: str) -> str:
    """Extract content from <FINAL_ANSWER> tags, or return original text."""
    if not text:
        raise ValueError("Cannot extract from empty text")

    match = re.search(
        r"<FINAL_ANSWER>\s*(.*?)\s*</FINAL_ANSWER>", text, re.DOTALL | re.IGNORECASE
    )
    if match:
        content = match.group(1).strip()
        if not content:
            raise ValueError("FINAL_ANSWER tags are empty")
        return content

    return text


def fuzzy_match_answer(
    ground_truth: str, predicted: str, tolerance: float = 0.05
) -> tuple[bool, str]:
    """Fuzzy match predicted answer against ground truth.

    Returns (is_correct, rationale).
    """
    if not ground_truth:
        raise ValueError("Ground truth cannot be empty")
    if not predicted:
        raise ValueError("Predicted answer cannot be empty")
    if not 0 <= tolerance <= 1:
        raise ValueError(f"Tolerance must be between 0 and 1, got {tolerance}")

    try:
        gt_numbers_with_context = extract_numbers_with_context(ground_truth)
        pred_numbers_with_context = extract_numbers_with_context(predicted)
    except Exception as e:
        raise ValueError(f"Failed to extract numbers: {e}") from e

    gt_numbers = [(num, ctx) for num, ctx, _, _ in gt_numbers_with_context]
    pred_numbers = [(num, ctx) for num, ctx, _, _ in pred_numbers_with_context]

    # Case 1: Both have numbers
    if gt_numbers and pred_numbers:
        if len(gt_numbers) > 1:
            # Multi-number answer
            pred_non_years = [
                (n, c)
                for n, c in pred_numbers
                if not is_likely_year(n)
                or any(is_likely_year(g) for g, _ in gt_numbers)
            ]

            matched_gt: list[float] = []
            unmatched_gt: list[float] = []

            for gt_val, gt_context in gt_numbers:
                gt_base, gt_unit = normalize_number_with_units(gt_val, gt_context)
                found_match = False
                for pred_val, pred_context in pred_non_years:
                    pred_base, pred_unit = normalize_number_with_units(
                        pred_val, pred_context
                    )
                    if gt_base == 0:
                        if pred_base == 0:
                            text_matches, _ = check_text_overlap(
                                ground_truth, predicted
                            )
                            if text_matches:
                                found_match = True
                                break
                    else:
                        diff_pct = abs(gt_base - pred_base) / abs(gt_base)
                        if diff_pct <= tolerance:
                            text_matches, _ = check_text_overlap(
                                ground_truth, predicted
                            )
                            if text_matches:
                                found_match = True
                                break

                if found_match:
                    matched_gt.append(gt_val)
                else:
                    unmatched_gt.append(gt_val)

            if len(matched_gt) == len(gt_numbers):
                return True, (
                    f"List match: All {len(gt_numbers)} numbers found in prediction"
                )
            return False, (
                f"List mismatch: Found {len(matched_gt)}/{len(gt_numbers)} "
                f"numbers. Missing: {unmatched_gt}"
            )

        else:
            # Single number answer
            gt_val, gt_context = gt_numbers[0]
            gt_base, gt_unit = normalize_number_with_units(gt_val, gt_context)

            gt_has_text, _ = has_significant_text(ground_truth)
            should_filter_years = not (is_likely_year(gt_val) or gt_has_text)

            best_match = None
            best_diff = float("inf")
            best_pred_info: tuple[float, str | None] | None = None

            for pred_val, pred_context in pred_numbers:
                if should_filter_years and is_likely_year(pred_val):
                    continue

                pred_base, pred_unit = normalize_number_with_units(
                    pred_val, pred_context
                )

                if gt_base == 0:
                    if pred_base == 0:
                        text_matches, text_rationale = check_text_overlap(
                            ground_truth, predicted
                        )
                        if text_matches:
                            return True, (
                                f"Exact match: Found 0 in response. {text_rationale}"
                            )
                    continue

                diff_pct = abs(gt_base - pred_base) / abs(gt_base)

                if diff_pct < best_diff:
                    best_diff = diff_pct
                    best_match = pred_base
                    best_pred_info = (pred_base, pred_unit)

                if diff_pct <= tolerance:
                    text_matches, text_rationale = check_text_overlap(
                        ground_truth, predicted
                    )
                    if not text_matches:
                        continue
                    return True, (
                        f"Numerical match: GT={gt_base} ({gt_unit or 'no unit'}), "
                        f"Pred={pred_base} ({pred_unit or 'no unit'}), "
                        f"Diff={diff_pct * 100:.2f}%. {text_rationale}"
                    )

            if best_match is not None and best_pred_info is not None:
                return False, (
                    f"No match: GT={gt_base} ({gt_unit or 'no unit'}), "
                    f"Closest={best_pred_info[0]} "
                    f"({best_pred_info[1] or 'no unit'}), "
                    f"Diff={best_diff * 100:.2f}%"
                )
            return False, (
                f"No valid numbers found in prediction "
                f"(filtered out years: {[n for n, _ in pred_numbers[:5]]})"
            )

    # Case 2: Text-based comparison
    gt_clean = ground_truth.strip().lower().strip('"').strip("'")
    pred_clean = predicted.strip().lower().strip('"').strip("'")

    gt_clean = re.sub(r"\([^)]*\)", "", gt_clean).strip()
    pred_clean = re.sub(r"\([^)]*\)", "", pred_clean).strip()

    if gt_clean in pred_clean:
        return True, f"Text match: '{ground_truth}' found in prediction"
    if gt_clean == pred_clean:
        return True, "Exact text match"

    return False, (
        f"No match found. GT: '{ground_truth[:100]}', Pred: '{predicted[:100]}'"
    )


def score_answer(
    ground_truth: str, predicted: str, tolerance: float = 0.05
) -> float:
    """Score the answer: 1.0 if fuzzy match succeeds, else 0.0."""
    is_correct, _rationale = fuzzy_match_answer(ground_truth, predicted, tolerance)
    return 1.0 if is_correct else 0.0
