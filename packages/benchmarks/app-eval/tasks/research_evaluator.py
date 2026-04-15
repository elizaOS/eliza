#!/usr/bin/env python3
"""
Research benchmark evaluator for elizaOS app agent.

Scores a research response against a task definition from research-tasks.json.
Checks for required elements (string matching), evaluates structural quality,
and outputs a score breakdown as JSON.

Usage:
    python research-evaluator.py --task research-tasks.json --task-id research-001 --response response.txt
    python research-evaluator.py --task research-tasks.json --task-id research-001 --response-json result.json

    # Batch mode: evaluate all tasks from a JSONL results file
    python research-evaluator.py --task research-tasks.json --results results.jsonl

    # Pipe a response from stdin
    echo "My research response..." | python research-evaluator.py --task research-tasks.json --task-id research-001
"""

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Any


def load_task(task_file: str, task_id: str) -> dict[str, Any]:
    """Load a specific task definition by ID from the tasks JSON file."""
    with open(task_file, "r") as f:
        tasks = json.load(f)

    for task in tasks:
        if task["id"] == task_id:
            return task

    available = [t["id"] for t in tasks]
    raise ValueError(f"Task '{task_id}' not found. Available: {available}")


def load_response(response_path: str | None, response_json: str | None) -> str:
    """Load the response text from a file, JSON result, or stdin."""
    if response_json:
        with open(response_json, "r") as f:
            data = json.load(f)
        # Support both direct text and benchmark result format
        if isinstance(data, str):
            return data
        return data.get("response", data.get("output", ""))

    if response_path:
        with open(response_path, "r") as f:
            return f.read()

    # Read from stdin
    if not sys.stdin.isatty():
        return sys.stdin.read()

    raise ValueError("No response provided. Use --response, --response-json, or pipe to stdin.")


def normalize(text: str) -> str:
    """Normalize text for fuzzy matching: lowercase, collapse whitespace, strip punctuation."""
    text = text.lower()
    text = re.sub(r"[^\w\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def check_required_elements(response: str, required: list[str]) -> dict[str, Any]:
    """Check which required elements appear in the response using fuzzy substring matching.

    Each required element is checked by:
    1. Exact normalized substring match
    2. Key-phrase matching: extract significant words and check if most appear nearby
    """
    norm_response = normalize(response)
    results = {}

    for element in required:
        norm_element = normalize(element)

        # Direct substring match
        if norm_element in norm_response:
            results[element] = {"found": True, "method": "exact"}
            continue

        # Key-phrase matching: extract words >= 4 chars, check if 70%+ appear
        keywords = [w for w in norm_element.split() if len(w) >= 4]
        if not keywords:
            keywords = norm_element.split()

        found_count = sum(1 for kw in keywords if kw in norm_response)
        ratio = found_count / len(keywords) if keywords else 0

        if ratio >= 0.7:
            results[element] = {
                "found": True,
                "method": "keyword",
                "keyword_ratio": round(ratio, 2),
            }
        else:
            results[element] = {
                "found": False,
                "method": "keyword",
                "keyword_ratio": round(ratio, 2),
                "missing_keywords": [kw for kw in keywords if kw not in norm_response],
            }

    return results


def score_completeness(response: str, expected_subtopics: list[str]) -> dict[str, Any]:
    """Score how many expected subtopics are covered in the response."""
    norm_response = normalize(response)
    covered = []
    missing = []

    for topic in expected_subtopics:
        # Check if key terms from the subtopic appear in the response
        keywords = [w for w in normalize(topic).split() if len(w) >= 4]
        if not keywords:
            keywords = normalize(topic).split()

        found = sum(1 for kw in keywords if kw in norm_response)
        ratio = found / len(keywords) if keywords else 0

        if ratio >= 0.5:
            covered.append(topic)
        else:
            missing.append(topic)

    coverage_ratio = len(covered) / len(expected_subtopics) if expected_subtopics else 0
    return {
        "covered_count": len(covered),
        "total_count": len(expected_subtopics),
        "coverage_ratio": round(coverage_ratio, 2),
        "covered": covered,
        "missing": missing,
    }


def score_structure(response: str) -> dict[str, Any]:
    """Evaluate structural quality of the response."""
    lines = response.strip().split("\n")
    non_empty_lines = [l for l in lines if l.strip()]

    # Check for headings (markdown or plain)
    heading_patterns = [
        r"^#{1,4}\s+\S",          # markdown headings
        r"^\*\*[^*]+\*\*\s*$",    # bold-only lines as pseudo-headings
        r"^\d+\.\s+\*\*",         # numbered bold items
        r"^[A-Z][^.!?]*:$",       # "Title:" style headings
    ]
    headings = []
    for line in non_empty_lines:
        stripped = line.strip()
        for pattern in heading_patterns:
            if re.match(pattern, stripped):
                headings.append(stripped)
                break

    # Check for lists
    list_items = [l for l in non_empty_lines if re.match(r"^\s*[-*]\s+\S", l.strip()) or re.match(r"^\s*\d+\.\s+\S", l.strip())]

    # Check for paragraphs (blocks of text separated by blank lines)
    paragraph_count = 0
    in_paragraph = False
    for line in lines:
        if line.strip():
            if not in_paragraph:
                paragraph_count += 1
                in_paragraph = True
        else:
            in_paragraph = False

    word_count = len(response.split())

    # Structure score: headings + lists + adequate length + paragraphing
    structure_score = 0.0
    if len(headings) >= 2:
        structure_score += 2.5
    elif len(headings) >= 1:
        structure_score += 1.5

    if len(list_items) >= 3:
        structure_score += 1.5
    elif len(list_items) >= 1:
        structure_score += 0.75

    if word_count >= 500:
        structure_score += 2.0
    elif word_count >= 300:
        structure_score += 1.5
    elif word_count >= 150:
        structure_score += 0.75

    if paragraph_count >= 4:
        structure_score += 2.0
    elif paragraph_count >= 2:
        structure_score += 1.0

    # Presence of conclusion or summary section
    has_conclusion = bool(re.search(
        r"(conclusion|summary|in summary|overall|key (findings|takeaways))",
        response.lower(),
    ))
    if has_conclusion:
        structure_score += 2.0

    # Cap at 10
    structure_score = min(structure_score, 10.0)

    return {
        "score": round(structure_score, 1),
        "headings_count": len(headings),
        "list_items_count": len(list_items),
        "paragraph_count": paragraph_count,
        "word_count": word_count,
        "has_conclusion": has_conclusion,
    }


def compute_overall_score(
    element_results: dict[str, Any],
    completeness: dict[str, Any],
    structure: dict[str, Any],
    max_score: int = 10,
) -> dict[str, Any]:
    """Compute the overall score as a weighted combination of sub-scores.

    Weights:
        - Required elements: 40% (must-have facts and concepts)
        - Completeness: 35% (subtopic coverage breadth)
        - Structure: 25% (organization and presentation)
    """
    # Required elements: fraction of elements found
    total_elements = len(element_results)
    found_elements = sum(1 for v in element_results.values() if v["found"])
    element_score = (found_elements / total_elements) * max_score if total_elements else 0

    # Completeness: use coverage ratio
    completeness_score = completeness["coverage_ratio"] * max_score

    # Structure: already on 0-10 scale
    structure_score = structure["score"]

    # Weighted combination
    weighted = (
        0.40 * element_score
        + 0.35 * completeness_score
        + 0.25 * structure_score
    )

    # Round to nearest 0.5
    final_score = round(weighted * 2) / 2

    return {
        "overall_score": final_score,
        "max_score": max_score,
        "component_scores": {
            "required_elements": {
                "score": round(element_score, 1),
                "weight": 0.40,
                "found": found_elements,
                "total": total_elements,
            },
            "completeness": {
                "score": round(completeness_score, 1),
                "weight": 0.35,
                "coverage_ratio": completeness["coverage_ratio"],
            },
            "structure": {
                "score": round(structure_score, 1),
                "weight": 0.25,
            },
        },
    }


def determine_rubric_band(score: float, rubric: dict[str, str]) -> str:
    """Map a numeric score to the appropriate rubric band description."""
    for band, description in rubric.items():
        parts = band.split("-")
        if len(parts) == 2:
            low, high = float(parts[0]), float(parts[1])
            if low <= score <= high:
                return description

    # Fallback when no rubric bands are provided or score doesn't match
    if not rubric:
        if score <= 2:
            return "Poor"
        if score <= 4:
            return "Below Average"
        if score <= 6:
            return "Average"
        if score <= 8:
            return "Good"
        return "Excellent"

    return "Score outside rubric range"


def evaluate_task(task: dict[str, Any], response: str) -> dict[str, Any]:
    """Run full evaluation of a response against a task definition."""
    evaluation = task.get("evaluation", {})
    context = task.get("context", {})

    # Resolve keywords — tasks may use either top-level expected_keywords
    # or nested evaluation.required_elements / context.expected_subtopics
    keywords = (
        task.get("expected_keywords")
        or evaluation.get("required_elements")
        or []
    )
    subtopics = (
        context.get("expected_subtopics")
        or task.get("expected_keywords")
        or []
    )

    # Check required elements
    element_results = check_required_elements(response, keywords)

    # Score completeness against expected subtopics
    completeness = score_completeness(response, subtopics)

    # Score structure
    structure = score_structure(response)

    # Compute overall score
    scoring = evaluation.get("scoring", {"max_score": 10})
    overall = compute_overall_score(
        element_results, completeness, structure, scoring.get("max_score", 10)
    )

    # Map to rubric band
    rubric = scoring.get("rubric", {})
    rubric_band = determine_rubric_band(overall["overall_score"], rubric)

    return {
        "task_id": task["id"],
        "domain": context.get("domain", "unknown"),
        "difficulty": context.get("difficulty", "unknown"),
        "overall_score": overall["overall_score"],
        "max_score": overall["max_score"],
        "rubric_band": rubric_band,
        "component_scores": overall["component_scores"],
        "required_elements": element_results,
        "completeness": completeness,
        "structure": structure,
        "quality_criteria": evaluation.get("quality_criteria", {}),
    }


def evaluate_batch(task_file: str, results_file: str) -> list[dict[str, Any]]:
    """Evaluate a batch of results from a JSONL file. Each line should have 'id' and 'response' fields."""
    with open(task_file, "r") as f:
        tasks = json.load(f)
    task_map = {t["id"]: t for t in tasks}

    evaluations = []
    with open(results_file, "r") as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                result = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"Warning: skipping line {line_num}, invalid JSON: {e}", file=sys.stderr)
                continue

            task_id = result.get("id", "")
            response = result.get("response", result.get("output", ""))

            if task_id not in task_map:
                print(f"Warning: skipping unknown task_id '{task_id}' on line {line_num}", file=sys.stderr)
                continue

            evaluation = evaluate_task(task_map[task_id], response)
            evaluations.append(evaluation)

    return evaluations


def print_summary(evaluations: list[dict[str, Any]]) -> None:
    """Print a human-readable summary of batch evaluation results."""
    if not evaluations:
        print("No evaluations to summarize.", file=sys.stderr)
        return

    print("\n" + "=" * 70, file=sys.stderr)
    print("RESEARCH BENCHMARK RESULTS", file=sys.stderr)
    print("=" * 70, file=sys.stderr)

    total_score = 0
    total_max = 0

    for ev in evaluations:
        score = ev["overall_score"]
        max_s = ev["max_score"]
        total_score += score
        total_max += max_s
        bar = "#" * int(score) + "." * (max_s - int(score))
        print(
            f"  {ev['task_id']:16s} [{bar}] {score:4.1f}/{max_s}  ({ev['domain']}, {ev['difficulty']})",
            file=sys.stderr,
        )

    avg = total_score / len(evaluations) if evaluations else 0
    print("-" * 70, file=sys.stderr)
    print(f"  {'AVERAGE':16s}                    {avg:4.1f}/{evaluations[0]['max_score'] if evaluations else 10}", file=sys.stderr)
    print("=" * 70, file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate elizaOS app research benchmark responses",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--task", required=True, help="Path to research-tasks.json"
    )
    parser.add_argument(
        "--task-id", help="ID of the task to evaluate (e.g., research-001)"
    )
    parser.add_argument(
        "--response", help="Path to plain text response file"
    )
    parser.add_argument(
        "--response-json", help="Path to JSON result file with 'response' or 'output' field"
    )
    parser.add_argument(
        "--results", help="Path to JSONL file for batch evaluation (one result per line)"
    )
    parser.add_argument(
        "--summary", action="store_true", help="Print human-readable summary to stderr (batch mode)"
    )
    parser.add_argument(
        "--pretty", action="store_true", help="Pretty-print JSON output"
    )

    args = parser.parse_args()

    # Batch mode
    if args.results:
        evaluations = evaluate_batch(args.task, args.results)
        if args.summary:
            print_summary(evaluations)
        indent = 2 if args.pretty else None
        print(json.dumps(evaluations, indent=indent))
        return

    # Single-task mode
    if not args.task_id:
        parser.error("--task-id is required for single-task evaluation")

    task = load_task(args.task, args.task_id)
    response = load_response(args.response, args.response_json)

    if not response.strip():
        print("Error: empty response", file=sys.stderr)
        sys.exit(1)

    result = evaluate_task(task, response)
    indent = 2 if args.pretty else None
    print(json.dumps(result, indent=indent))


if __name__ == "__main__":
    main()
