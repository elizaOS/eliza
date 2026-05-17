"""
Coding task evaluator for elizaOS app benchmarks.

Scores coding task results based on code presence, keyword coverage,
TypeScript patterns, and structural quality. Deterministic — no LLM calls.
"""
from __future__ import annotations

import re
from typing import Any


def evaluate_coding_task(
    task: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any]:
    """
    Evaluate a single coding task result.

    Args:
        task: Task definition with expected_keywords, evaluation criteria, etc.
        result: Benchmark result with response, success, duration_ms, etc.

    Returns:
        Evaluation dict with score, breakdown, and feedback.
    """
    max_score = task.get("max_score", 10)
    response = result.get("response", "")

    if not result.get("success") or not response:
        return {
            "task_id": task["id"],
            "score": 0,
            "max_score": max_score,
            "pass": False,
            "breakdown": {},
            "feedback": result.get("error", "Task did not complete successfully"),
        }

    breakdown: dict[str, float] = {}
    feedback_parts: list[str] = []
    response_lower = response.lower()

    # --- Code presence (0-1) ---
    code_blocks = re.findall(r"```[\s\S]*?```", response)
    inline_code = re.findall(r"`[^`]+`", response)

    # Also detect unformatted code patterns
    has_function_def = bool(re.search(
        r"\b(function|const|let|var|class|interface|type|export|import|async)\b",
        response,
    ))
    has_braces = "{" in response and "}" in response
    has_arrow = "=>" in response

    if code_blocks:
        code_presence = 1.0
    elif has_function_def and has_braces:
        code_presence = 0.8
    elif has_function_def or inline_code:
        code_presence = 0.5
    else:
        code_presence = 0.1
        feedback_parts.append("No code found in response")

    breakdown["code_presence"] = round(code_presence, 3)

    # --- Extract code content for deeper analysis ---
    code_content = ""
    if code_blocks:
        code_content = "\n".join(
            re.sub(r"^```\w*\n?|```$", "", block, flags=re.MULTILINE)
            for block in code_blocks
        )
    else:
        code_content = response

    code_lower = code_content.lower()

    # --- Keyword coverage (0-1) ---
    expected_keywords = task.get("expected_keywords", [])
    if expected_keywords:
        matched = [kw for kw in expected_keywords if kw.lower() in response_lower]
        missing = [kw for kw in expected_keywords if kw.lower() not in response_lower]
        keyword_score = len(matched) / len(expected_keywords)
        breakdown["keyword_coverage"] = round(keyword_score, 3)
        if missing:
            feedback_parts.append(f"Missing keywords: {', '.join(missing)}")
    else:
        keyword_score = 0.5
        breakdown["keyword_coverage"] = 0.5

    # --- TypeScript quality signals (0-1) ---
    ts_signals = 0
    ts_max = 8

    # Type annotations
    if re.search(r":\s*(string|number|boolean|void|any|unknown|never)\b", code_content):
        ts_signals += 1
    # Generics
    if re.search(r"<\s*\w+", code_content):
        ts_signals += 1
    # Interface or type alias
    if re.search(r"\b(interface|type)\s+\w+", code_content):
        ts_signals += 1
    # Arrow functions
    if "=>" in code_content:
        ts_signals += 1
    # Const/let (not var)
    if re.search(r"\b(const|let)\b", code_content):
        ts_signals += 1
    # Error handling
    if re.search(r"\b(try|catch|throw|Error)\b", code_content):
        ts_signals += 1
    # Async/await
    if re.search(r"\b(async|await)\b", code_content):
        ts_signals += 1
    # Export
    if re.search(r"\bexport\b", code_content):
        ts_signals += 1

    ts_quality = min(ts_signals / (ts_max * 0.6), 1.0)  # 60% of signals = full score
    breakdown["typescript_quality"] = round(ts_quality, 3)

    # --- Completeness (0-1) — does the code look complete? ---
    completeness_signals = 0

    # Has a return statement or expression
    if re.search(r"\breturn\b", code_content) or has_arrow:
        completeness_signals += 1
    # Has function/class definition
    if re.search(r"\b(function|class)\s+\w+", code_content):
        completeness_signals += 1
    # Balanced braces (rough check)
    open_braces = code_content.count("{")
    close_braces = code_content.count("}")
    if open_braces > 0 and abs(open_braces - close_braces) <= 1:
        completeness_signals += 1
    # Sufficient length
    code_lines = [l for l in code_content.split("\n") if l.strip()]
    if len(code_lines) >= 10:
        completeness_signals += 1
    elif len(code_lines) >= 5:
        completeness_signals += 0.5

    completeness = min(completeness_signals / 3.0, 1.0)
    breakdown["completeness"] = round(completeness, 3)

    # --- Explanation quality (0-1) — did they explain the code? ---
    non_code_text = response
    for block in code_blocks:
        non_code_text = non_code_text.replace(block, "")
    explanation_words = len(non_code_text.split())

    if explanation_words >= 100:
        explanation = 1.0
    elif explanation_words >= 30:
        explanation = 0.5 + 0.5 * ((explanation_words - 30) / 70)
    else:
        explanation = 0.2
    breakdown["explanation"] = round(explanation, 3)

    # --- Weighted final score ---
    criteria = task.get("evaluation", {}).get("criteria", [])
    if criteria:
        score_map = {
            "correctness": (code_presence + keyword_score + completeness) / 3,
            "types": ts_quality,
            "type_safety": ts_quality,
            "edge_cases": keyword_score,
            "code_quality": (ts_quality + completeness) / 2,
            "complexity": ts_quality,
            "completeness": completeness,
            "timing": keyword_score,
            "cancellation": keyword_score,
            "singleton": keyword_score,
            "circular_detection": keyword_score,
            "error_reporting": keyword_score,
            "computed": keyword_score,
            "efficiency": ts_quality,
            "examples": explanation,
            "practical": explanation,
            "recommendation": explanation,
        }
        total_weight = sum(c["weight"] for c in criteria)
        weighted_sum = sum(
            c["weight"] * score_map.get(c["name"], 0.5)
            for c in criteria
        )
        final_ratio = weighted_sum / total_weight if total_weight > 0 else 0.5
    else:
        final_ratio = (
            code_presence * 0.3
            + keyword_score * 0.2
            + ts_quality * 0.2
            + completeness * 0.2
            + explanation * 0.1
        )

    final_score = round(final_ratio * max_score, 1)

    return {
        "task_id": task["id"],
        "score": final_score,
        "max_score": max_score,
        "pass": final_score >= max_score * 0.5,
        "breakdown": breakdown,
        "code_lines": len(code_lines),
        "feedback": "; ".join(feedback_parts) if feedback_parts else "OK",
    }
