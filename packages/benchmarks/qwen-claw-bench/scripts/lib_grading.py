"""
QwenClawBench grading engine.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.request
import urllib.error
import time
from math import comb
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from lib_agent import ensure_agent_exists, run_openclaw_prompt, slugify_model
from lib_tasks import Task


logger = logging.getLogger(__name__)

OPENCLAW_ENV_FILE = Path(__file__).parent.parent / "openclaw_config" / ".env"

DEFAULT_JUDGE_MODEL = "claude-opus-4-5-20251101"
DEFAULT_JUDGE_AGENT_PREFIX = "bench-judge"
DEFAULT_JUDGE_TIMEOUT_SECONDS = 1800
JUDGE_API_MAX_RETRIES = 100
JUDGE_API_RETRY_BASE_SECONDS = 5

# Threshold for the penalized hybrid scoring (default):
# if auto_score < this value, the LLM judge contribution is zeroed out.
AUTO_PENALTY_THRESHOLD = 0.75

def _load_openclaw_env(env_file: Path = OPENCLAW_ENV_FILE) -> Dict[str, str]:
    """Parse KEY=VALUE pairs from openclaw_config/.env (ignores comments and blank lines)."""
    env = {}
    if not env_file.exists():
        return env
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    return env


def _call_llm_judge_api(
    prompt: str,
    model: str,
    base_url: str,
    api_key: str,
    timeout_seconds: float = DEFAULT_JUDGE_TIMEOUT_SECONDS,
) -> str:
    """Call an OpenAI-compatible chat completions API using only stdlib.

    Returns the assistant message content.
    """
    url = base_url.rstrip("/") + "/chat/completions"
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.0,
        "max_tokens": 20480
    }).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        raise RuntimeError(
            f"LLM judge API returned {exc.code}: {error_body}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"LLM judge API request failed: {exc}") from exc

    choices = body.get("choices", [])
    if not choices:
        raise RuntimeError(f"LLM judge API returned no choices: {body}")
    return choices[0].get("message", {}).get("content", "")


@dataclass
class GradeResult:
    task_id: str
    score: float
    max_score: float
    grading_type: str
    breakdown: Dict[str, float]
    notes: str
    # score_simple: simple weighted average for hybrid tasks (auto * w + llm * w) / total.
    # None means the task is not hybrid (score_simple == score in that case).
    score_simple: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "score": self.score,
            "score_simple": self.score_simple if self.score_simple is not None else self.score,
            "max_score": self.max_score,
            "grading_type": self.grading_type,
            "breakdown": self.breakdown,
            "notes": self.notes,
        }


def grade_task(
    *,
    task: Task,
    execution_result: Dict[str, Any],
    skill_dir: Path,
    judge_model: str = DEFAULT_JUDGE_MODEL,
    judge_agent_prefix: str = DEFAULT_JUDGE_AGENT_PREFIX,
    judge_timeout_seconds: float = DEFAULT_JUDGE_TIMEOUT_SECONDS,
    verbose: bool = False,
) -> GradeResult:
    grading_type = task.grading_type
    if verbose:
        logger.info("   [VERBOSE] Grading task %s with type: %s", task.task_id, grading_type)
        logger.info("   [VERBOSE] Execution status: %s", execution_result.get("status", "unknown"))
    
    if grading_type == "automated":
        result = _grade_automated(task, execution_result, verbose=verbose)
        if verbose:
            logger.info("   [VERBOSE] Automated grade breakdown: %s", result.breakdown)
        return result
    if grading_type == "llm_judge":
        result = _grade_llm_judge(
            task=task,
            execution_result=execution_result,
            judge_model=judge_model,
            judge_agent_prefix=judge_agent_prefix,
            judge_timeout_seconds=judge_timeout_seconds,
            skill_dir=skill_dir,
            verbose=verbose,
        )
        if verbose:
            logger.info("   [VERBOSE] LLM judge breakdown: %s", result.breakdown)
        return result
    if grading_type == "hybrid":
        auto_result = _grade_automated(task, execution_result, verbose=verbose)
        llm_result = _grade_llm_judge(
            task=task,
            execution_result=execution_result,
            judge_model=judge_model,
            judge_agent_prefix=judge_agent_prefix,
            judge_timeout_seconds=judge_timeout_seconds,
            skill_dir=skill_dir,
            verbose=verbose,
        )
        return _combine_grades(task, auto_result, llm_result)
    raise ValueError(f"Unknown grading type: {grading_type}")


def _grade_automated(task: Task, execution_result: Dict[str, Any], verbose: bool = False) -> GradeResult:
    grading_code = _extract_grading_code(task)
    if not grading_code:
        return GradeResult(
            task_id=task.task_id,
            score=0.0,
            max_score=1.0,
            grading_type="automated",
            breakdown={},
            notes="No automated grading code found",
        )

    namespace: Dict[str, Any] = {}
    exec(grading_code, namespace)
    grade_func = namespace.get("grade")
    if not callable(grade_func):
        return GradeResult(
            task_id=task.task_id,
            score=0.0,
            max_score=1.0,
            grading_type="automated",
            breakdown={},
            notes="Automated grading function missing",
        )

    scores = grade_func(
        execution_result.get("transcript", []),
        execution_result.get("workspace", ""),
    )
    if not isinstance(scores, dict):
        scores = {}
    
    if verbose:
        logger.info("   [VERBOSE] Automated grading scores: %s", scores)

    total = _average_scores(scores)
    return GradeResult(
        task_id=task.task_id,
        score=total,
        max_score=1.0,
        grading_type="automated",
        breakdown=_normalize_score_dict(scores),
        notes="",
    )


def _grade_llm_judge(
    *,
    task: Task,
    execution_result: Dict[str, Any],
    judge_model: str,
    judge_agent_prefix: str,
    judge_timeout_seconds: float,
    skill_dir: Path,
    verbose: bool = False,
) -> GradeResult:
    transcript_summary = _summarize_transcript(execution_result.get("transcript", []))
    if verbose:
        logger.info(
            "   [VERBOSE] Transcript summary for judge (first 1000 chars):\n%s",
            transcript_summary[:1000],
        )
    rubric = task.llm_judge_rubric or _format_grading_criteria(task)
    prompt = _build_judge_prompt(task, transcript_summary, rubric)

    # Resolve judge API credentials: env vars take priority, then host ~/.openclaw/.env
    host_env = _load_openclaw_env()
    base_url = os.environ.get("JUDGE_BASE_URL") or host_env.get("JUDGE_BASE_URL")
    api_key = os.environ.get("JUDGE_API_KEY") or host_env.get("JUDGE_API_KEY")

    if not base_url or not api_key:
        raise RuntimeError(
            "LLM judge requires JUDGE_BASE_URL and JUDGE_API_KEY. "
            "Set them as environment variables or add them to ~/.openclaw/.env."
        )

    api_model = judge_model.split("/", 1)[-1] if "/" in judge_model else judge_model
    last_exc = None
    for attempt in range(JUDGE_API_MAX_RETRIES):
        if attempt > 0:
            delay = JUDGE_API_RETRY_BASE_SECONDS * (2 ** (attempt - 1))
            logger.info("   LLM judge: retry %d/%d in %.0fs after: %s", attempt + 1, JUDGE_API_MAX_RETRIES, delay, last_exc)
            time.sleep(delay)
        logger.info(
            "   LLM judge: calling %s via direct API (%s)%s",
            judge_model,
            base_url,
            f" [attempt {attempt + 1}/{JUDGE_API_MAX_RETRIES}]" if JUDGE_API_MAX_RETRIES > 1 else "",
        )
        try:
            response_text = _call_llm_judge_api(
                prompt=prompt,
                model=api_model,
                base_url=base_url,
                api_key=api_key,
                timeout_seconds=judge_timeout_seconds,
            )
            if verbose:
                logger.info("   [VERBOSE] Judge raw response:\n%s", response_text[:2000])

            raw_parsed = _parse_judge_text_response(response_text)
            parsed = _normalize_judge_response(raw_parsed)
            if verbose:
                logger.info("   [VERBOSE] Normalized judge response: %s", parsed)

            breakdown = parsed.get("scores", {})
            total = parsed.get("total")
            notes = parsed.get("notes", "")
            return GradeResult(
                task_id=task.task_id,
                score=float(total) if total is not None else 0.0,
                max_score=1.0,
                grading_type="llm_judge",
                breakdown=_normalize_score_dict(breakdown),
                notes=str(notes) if notes is not None else "",
            )
        except Exception as exc:
            last_exc = exc
            if attempt == JUDGE_API_MAX_RETRIES - 1:
                logger.warning(
                    "   Direct API judge failed after %d attempts, falling back to openclaw agent: %s",
                    JUDGE_API_MAX_RETRIES,
                    exc,
                )
            else:
                logger.warning("   LLM judge attempt %d/%d failed: %s", attempt + 1, JUDGE_API_MAX_RETRIES, exc)

    # Fallback: use openclaw agent as judge
    logger.info("   LLM judge: using openclaw agent (model=%s)", judge_model)
    agent_id = _ensure_judge_agent(judge_agent_prefix, judge_model, skill_dir)
    judge_workspace = Path(f"/tmp/qwenclawbench/judge/{task.task_id}")
    judge_result = run_openclaw_prompt(
        agent_id=agent_id,
        prompt=prompt,
        workspace=judge_workspace,
        timeout_seconds=judge_timeout_seconds,
    )

    raw_parsed = _parse_judge_response(judge_result.get("transcript", []))
    if verbose:
        logger.info("   [VERBOSE] Judge raw response parsed: %s", raw_parsed)

    parsed = _normalize_judge_response(raw_parsed)
    if verbose:
        logger.info("   [VERBOSE] Normalized judge response: %s", parsed)

    breakdown = parsed.get("scores", {})
    total = parsed.get("total")
    notes = parsed.get("notes", "")
    return GradeResult(
        task_id=task.task_id,
        score=float(total) if total is not None else 0.0,
        max_score=1.0,
        grading_type="llm_judge",
        breakdown=_normalize_score_dict(breakdown),
        notes=str(notes) if notes is not None else "",
    )


def _combine_grades(task: Task, auto_result: GradeResult, llm_result: GradeResult) -> GradeResult:
    weights = task.grading_weights or {"automated": 0.5, "llm_judge": 0.5}
    auto_weight = float(weights.get("automated", 0.5))
    llm_weight = float(weights.get("llm_judge", 0.5))
    total_weight = auto_weight + llm_weight
    if total_weight <= 0:
        auto_weight = llm_weight = 0.5
        total_weight = 1.0
    score_simple = (
        auto_result.score * auto_weight + llm_result.score * llm_weight
    ) / total_weight

    # Default (penalized): zero out LLM contribution when auto_score <= threshold
    llm_adj = 0.0 if auto_result.score < AUTO_PENALTY_THRESHOLD else llm_result.score
    score = (auto_result.score * auto_weight + llm_adj * llm_weight) / total_weight

    breakdown = {
        **{f"automated.{k}": v for k, v in auto_result.breakdown.items()},
        **{f"llm_judge.{k}": v for k, v in llm_result.breakdown.items()},
    }
    notes = " | ".join(filter(None, [auto_result.notes, llm_result.notes]))
    return GradeResult(
        task_id=task.task_id,
        score=score,
        score_simple=score_simple,
        max_score=1.0,
        grading_type="hybrid",
        breakdown=breakdown,
        notes=notes,
    )


def _extract_grading_code(task: Task) -> str:
    if not task.automated_checks:
        return ""
    # Match until ``` at line start (code block end), not ``` inside the code
    match = re.search(r"```python\s*\n(.*?)\n\s*```", task.automated_checks, re.DOTALL)
    if not match:
        return ""
    return match.group(1)


def _average_scores(scores: Dict[str, Any]) -> float:
    values = [float(v) for v in scores.values() if isinstance(v, (int, float))]
    if not values:
        return 0.0
    return sum(values) / len(values)


def strict_accuracy_stats(means: List[float]) -> Tuple[float, int]:
    """Strict accuracy (满分率): fraction of tasks with mean score == 1.0.

    Returns (rate in [0, 1], count of perfect tasks). Empty input -> (0.0, 0).
    """
    n = len(means)
    if n == 0:
        return 0.0, 0
    perfect = sum(1 for m in means if float(m) >= 1.0 - 1e-9)
    return perfect / n, perfect


def _pass_at_k(n: int, c: int, k: int) -> float:
    """Unbiased pass@k: prob at least 1 of k sampled runs is perfect."""
    if n < k:
        return 0.0
    if c >= n:
        return 1.0
    return 1.0 - comb(n - c, k) / comb(n, k)


def _pass_pow_k(n: int, c: int, k: int) -> float:
    """pass^k: prob all k sampled runs are perfect."""
    if n < k:
        return 0.0
    return comb(c, k) / comb(n, k)


def pass_k_stats(grades_by_task_id: Dict[str, Any], runs_per_task: int) -> Dict[str, Any]:
    """Return pass@k and pass^k (macro avg and task count) for k=1..runs_per_task."""
    result: Dict[str, Any] = {}
    for k in range(1, runs_per_task + 1):
        at_vals: List[float] = []
        pow_vals: List[float] = []
        for g in grades_by_task_id.values():
            runs = g.get("runs", [])
            n = len(runs)
            c = sum(1 for r in runs if r.get("score", 0) >= 1.0 - 1e-9)
            at_vals.append(_pass_at_k(n, c, k))
            pow_vals.append(_pass_pow_k(n, c, k))
        result[f"pass@{k}"] = round(sum(at_vals) / len(at_vals), 4) if at_vals else 0.0
        result[f"pass^{k}"] = round(sum(pow_vals) / len(pow_vals), 4) if pow_vals else 0.0
        result[f"pass@{k}_count"] = sum(1 for v in at_vals if v >= 1.0 - 1e-9)
        result[f"pass^{k}_count"] = sum(1 for v in pow_vals if v >= 1.0 - 1e-9)
    return result


def _normalize_score_dict(scores: Dict[str, Any]) -> Dict[str, float]:
    normalized: Dict[str, float] = {}
    for key, value in scores.items():
        try:
            normalized[str(key)] = float(value)
        except (TypeError, ValueError):
            continue
    return normalized


def _format_grading_criteria(task: Task) -> str:
    if not task.grading_criteria:
        return ""
    return "\n".join(f"- {criterion}" for criterion in task.grading_criteria)


def _summarize_transcript(transcript: List[Dict[str, Any]]) -> str:
    summary_parts: List[str] = []
    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        role = msg.get("role")
        if role == "assistant":
            for item in msg.get("content", []):
                if item.get("type") == "toolCall":
                    summary_parts.append(
                        f"Tool: {item.get('name')}({json.dumps(item.get('arguments', {}))})"
                    )
        elif role == "toolResult":
            content = msg.get("content", [])
            if content:
                result_preview = str(content[0])[:200]
                summary_parts.append(f"Result: {result_preview}")
        elif role == "user":
            content = msg.get("content", [])
            if content:
                summary_parts.append(f"User: {content[0]}")
    return "\n".join(summary_parts)


def _build_judge_prompt(task: Task, transcript_summary: str, rubric: str) -> str:
    return (
        "You are a grading function. Your ONLY job is to output a single JSON object.\n\n"
        "CRITICAL RULES:\n"
        "- Do NOT use any tools (no Read, Write, exec, or any other tool calls)\n"
        "- Do NOT create files or run commands\n"
        "- Do NOT write any prose, explanation, or commentary outside the JSON\n"
        "- Respond with ONLY a JSON object — nothing else\n\n"
        "Be a strict evaluator. Reserve 1.0 for genuinely excellent performance. "
        "An average acceptable completion should score around 0.6-0.7. "
        "Deduct points for unnecessary steps, verbose output, and inefficient tool usage.\n\n"
        "## Task\n"
        f"{task.prompt}\n\n"
        "## Expected Behavior\n"
        f"{task.expected_behavior}\n\n"
        "## Agent Transcript (summarized)\n"
        f"{transcript_summary}\n\n"
        "## Grading Rubric\n"
        f"{rubric}\n\n"
        "Score each criterion from 0.0 to 1.0.\n\n"
        "Respond with ONLY this JSON structure (no markdown, no code fences, no extra text):\n"
        '{"scores": {"criterion_name": 0.0}, "total": 0.0, "notes": "brief justification"}'
    )


def _ensure_judge_agent(judge_agent_prefix: str, judge_model: str, skill_dir: Path) -> str:
    model_slug = slugify_model(judge_model)
    agent_id = f"{judge_agent_prefix}-{model_slug}"
    workspace = Path("/tmp/qwenclawbench/judge/workspace")
    ensure_agent_exists(agent_id, judge_model, workspace)
    return agent_id


def _parse_judge_response(transcript: List[Dict[str, Any]]) -> Dict[str, Any]:
    content_chunks: List[str] = []
    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        if msg.get("role") != "assistant":
            continue
        for item in msg.get("content", []):
            if item.get("type") == "text":
                content_chunks.append(item.get("text", ""))
    raw_text = "\n".join(content_chunks).strip()
    if not raw_text:
        return {}

    # First, try to extract JSON from code blocks (```json ... ```)
    code_block_match = re.search(r"```json\s*(.*?)\s*```", raw_text, re.DOTALL)
    if code_block_match:
        try:
            parsed = json.loads(code_block_match.group(1))
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

    # Find all potential JSON objects by looking for balanced braces
    # We'll extract chunks that start with { and try to parse them
    json_candidates: List[str] = []
    brace_depth = 0
    current_json = []
    for char in raw_text:
        if char == "{":
            if brace_depth == 0:
                current_json = []
            brace_depth += 1

        if brace_depth > 0:
            current_json.append(char)

        if char == "}":
            brace_depth -= 1
            if brace_depth == 0 and current_json:
                json_candidates.append("".join(current_json))

    # Try parsing from the last JSON object backwards (most recent response)
    for candidate in reversed(json_candidates):
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict) and "scores" in parsed:
                # Prefer JSON that has the expected structure
                return parsed
        except json.JSONDecodeError:
            continue

    # Try any valid JSON dict
    for candidate in reversed(json_candidates):
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue

    # Fallback: try to extract numeric scores from prose responses.
    # Models sometimes return "Total: 0.72" or "Overall score: 0.65" instead of JSON.
    score_pattern = re.search(
        r"(?:total|overall|final)\s*(?:score)?[:\s]*(0\.\d+|1\.0+)",
        raw_text,
        re.IGNORECASE,
    )
    if score_pattern:
        try:
            total = float(score_pattern.group(1))
            if 0.0 <= total <= 1.0:
                logger.warning(
                    "Fell back to regex score extraction from prose (total=%.2f)", total
                )
                return {"scores": {}, "total": total, "notes": "Score extracted from prose (JSON parse failed)"}
        except ValueError:
            pass

    logger.warning("Failed to parse judge JSON response")
    return {}

def _parse_judge_text_response(raw_text: str) -> Dict[str, Any]:
    """Parse a JSON grading response from raw LLM text output.

    Handles markdown code fences, extra prose around JSON, and fallback
    regex extraction for non-JSON responses.
    """
    raw_text = raw_text.strip()
    if not raw_text:
        return {}

    # Try code block first (```json ... ```)
    code_block_match = re.search(r"```(?:json)?\s*(.*?)\s*```", raw_text, re.DOTALL)
    if code_block_match:
        try:
            parsed = json.loads(code_block_match.group(1))
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

    # Find balanced-brace JSON objects
    json_candidates: List[str] = []
    brace_depth = 0
    current_json: List[str] = []
    for char in raw_text:
        if char == "{":
            if brace_depth == 0:
                current_json = []
            brace_depth += 1
        if brace_depth > 0:
            current_json.append(char)
        if char == "}":
            brace_depth -= 1
            if brace_depth == 0 and current_json:
                json_candidates.append("".join(current_json))

    # Prefer JSON with expected "scores" key
    for candidate in reversed(json_candidates):
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict) and "scores" in parsed:
                return parsed
        except json.JSONDecodeError:
            continue

    # Any valid JSON dict
    for candidate in reversed(json_candidates):
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue

    # Fallback: regex for numeric total from prose
    score_pattern = re.search(
        r"(?:total|overall|final)\s*(?:score)?[:\s]*(0\.\d+|1\.0+)",
        raw_text,
        re.IGNORECASE,
    )
    if score_pattern:
        try:
            total = float(score_pattern.group(1))
            if 0.0 <= total <= 1.0:
                logger.warning(
                    "Fell back to regex score extraction from prose (total=%.2f)", total
                )
                return {
                    "scores": {},
                    "total": total,
                    "notes": "Score extracted from prose (JSON parse failed)",
                }
        except ValueError:
            pass

    logger.warning("Failed to parse judge text response as JSON")
    return {}



def _normalize_judge_response(parsed: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize judge response to expected format with 'scores', 'total', and 'notes'.
    
    Handles various response formats:
    - {"scores": {...}, "total": 0.9, "notes": "..."}  (expected)
    - {"criteria_scores": {...}, ...}  (Claude sometimes uses this)
    - {"score": 0.9, "justification": "..."}  (simplified format)
    """
    result: Dict[str, Any] = {"scores": {}, "total": None, "notes": ""}
    
    # Extract scores from various keys
    if "scores" in parsed:
        scores_data = parsed["scores"]
        if isinstance(scores_data, dict):
            # Handle nested structure: {"criterion": {"score": 0.9, "weight": 0.3}}
            for key, value in scores_data.items():
                if isinstance(value, dict) and "score" in value:
                    result["scores"][key] = float(value["score"]) if isinstance(value["score"], (int, float, str)) else value["score"]
                elif isinstance(value, (int, float)):
                    result["scores"][key] = value
    elif "criteria_scores" in parsed:
        # Handle Claude's alternate format
        criteria = parsed["criteria_scores"]
        if isinstance(criteria, dict):
            for key, value in criteria.items():
                if isinstance(value, dict) and "score" in value:
                    result["scores"][key] = value["score"]
                elif isinstance(value, (int, float)):
                    result["scores"][key] = value
    
    # Extract total score
    if "total" in parsed and parsed["total"] is not None:
        result["total"] = float(parsed["total"]) if isinstance(parsed["total"], (int, float)) else None
    elif "score" in parsed and isinstance(parsed["score"], (int, float)):
        result["total"] = float(parsed["score"])
    elif result["scores"]:
        # Calculate average if we have individual scores but no total
        values = [v for v in result["scores"].values() if isinstance(v, (int, float))]
        if values:
            result["total"] = sum(values) / len(values)
    
    # Extract notes/justification
    if "notes" in parsed:
        result["notes"] = str(parsed["notes"])
    elif "justification" in parsed:
        result["notes"] = str(parsed["justification"])
    elif "reasoning" in parsed:
        result["notes"] = str(parsed["reasoning"])
    
    return result
