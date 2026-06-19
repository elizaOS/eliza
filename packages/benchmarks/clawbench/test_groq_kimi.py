#!/usr/bin/env python3
"""Test ClawBench scenario with Groq's Kimi model (single-turn version).

This is a simpler version that makes a single API call without tool execution.
For full trajectory testing with tool execution, use test_groq_full.py instead.
"""

import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

import httpx
import yaml

# Configuration
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
if not GROQ_API_KEY:
    raise ValueError("GROQ_API_KEY environment variable is required")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "moonshotai/kimi-k2-instruct")
MOCK_TOOLS_URL = os.environ.get("MOCK_TOOLS_URL", "http://localhost:3001")
API_RETRY_ATTEMPTS = 3
API_RETRY_DELAY = 2

# Paths
SCENARIOS_DIR = Path(__file__).parent / "scenarios"
FIXTURES_DIR = Path(__file__).parent / "fixtures"

sys.path.insert(0, str(Path(__file__).parent))
from clawbench.scoring import score_episode


class BenchmarkError(Exception):
    """Base exception for benchmark errors."""
    pass


def load_scenario(name: str) -> dict:
    """Load scenario YAML with validation."""
    scenario_path = SCENARIOS_DIR / f"{name}.yaml"
    if not scenario_path.exists():
        available = [f.stem for f in SCENARIOS_DIR.glob("*.yaml")]
        raise BenchmarkError(
            f"Scenario '{name}' not found. Available: {', '.join(available)}"
        )
    try:
        with open(scenario_path) as f:
            return yaml.safe_load(f)
    except yaml.YAMLError as e:
        raise BenchmarkError(f"Invalid YAML in scenario '{name}': {e}")


def load_fixtures(scenario: str) -> dict:
    """Load fixtures for a scenario with error handling."""
    fixture_dir = FIXTURES_DIR / scenario
    fixtures = {}

    if not fixture_dir.exists():
        print(f"Warning: No fixtures directory for scenario '{scenario}'")
        return fixtures

    for f in fixture_dir.glob("*.json"):
        try:
            with open(f) as fp:
                fixtures[f.stem] = json.load(fp)
        except (json.JSONDecodeError, IOError) as e:
            print(f"Warning: Could not load fixture {f.name}: {e}")

    # Load memory files
    memory_dir = fixture_dir / "memory"
    if memory_dir.exists():
        fixtures["memory"] = {}
        for f in memory_dir.glob("*.md"):
            try:
                fixtures["memory"][f.stem] = f.read_text()
            except IOError as e:
                print(f"Warning: Could not read memory file {f.name}: {e}")

    return fixtures


def build_system_prompt(scenario_config: dict, fixtures: dict) -> str:
    """Build a system prompt with context."""
    tools_desc = """You are an AI assistant helping with email, calendar, and task management.

Available tools:
- exec: Run shell commands (himalaya for email, curl for calendar/tasks)
- slack: Read/send Slack messages
- memory_search: Search memory files
- memory_get: Get specific memory file
- read: Read workspace files

When you need to use a tool, respond with:
<tool_call>
{"tool": "tool_name", "args": {"arg1": "value1"}}
</tool_call>

After getting tool results, continue reasoning and respond with your final answer.
"""

    # Add fixture context
    context_parts = [tools_desc, "\n### Current Context:\n"]

    if "inbox" in fixtures:
        context_parts.append(f"**Email Inbox ({len(fixtures['inbox'])} messages):**\n")
        for email in fixtures["inbox"][:5]:  # First 5
            context_parts.append(f"- {email.get('from', 'Unknown')}: {email.get('subject', 'No subject')[:60]}\n")

    if "calendar" in fixtures:
        context_parts.append(f"\n**Calendar ({len(fixtures['calendar'])} events):**\n")
        for event in fixtures["calendar"][:5]:
            context_parts.append(f"- {event.get('start', '?')}: {event.get('title', 'No title')[:40]}\n")

    if "tasks" in fixtures:
        context_parts.append(f"\n**Tasks ({len(fixtures['tasks'])} items):**\n")
        for task in fixtures["tasks"][:5]:
            context_parts.append(f"- [{task.get('status', '?')}] {task.get('title', 'No title')[:40]}\n")

    return "".join(context_parts)


def call_groq(messages: list, model: str = GROQ_MODEL) -> str:
    """Call Groq API with retry logic."""
    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 2000,
    }

    last_error: Optional[Exception] = None
    for attempt in range(API_RETRY_ATTEMPTS):
        try:
            response = httpx.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers=headers,
                json=payload,
                timeout=120,
            )

            if response.status_code == 429:
                wait_time = API_RETRY_DELAY * (attempt + 1)
                print(f"Rate limited, waiting {wait_time}s...")
                time.sleep(wait_time)
                continue

            if response.status_code != 200:
                print(f"Groq API error: {response.status_code}")
                print(response.text[:500])
                if response.status_code >= 500:
                    time.sleep(API_RETRY_DELAY)
                    continue
                return ""

            data = response.json()
            if "choices" not in data or not data["choices"]:
                print("Invalid API response: missing choices")
                return ""

            content = data["choices"][0].get("message", {}).get("content")
            return content or ""

        except httpx.TimeoutException:
            last_error = Exception(f"Timeout (attempt {attempt + 1})")
            print(f"Timeout on attempt {attempt + 1}")
            time.sleep(API_RETRY_DELAY)
        except httpx.RequestError as e:
            last_error = e
            print(f"Request error: {e}")
            time.sleep(API_RETRY_DELAY)

    if last_error:
        print(f"All attempts failed: {last_error}")
    return ""


def run_scenario(scenario_name: str = "inbox_triage") -> dict:
    """Run a scenario and return results."""
    print(f"\n{'='*60}")
    print(f"Running scenario: {scenario_name}")
    print(f"Model: {GROQ_MODEL}")
    print(f"{'='*60}")

    scenario = load_scenario(scenario_name)
    fixtures = load_fixtures(scenario_name)

    system_prompt = build_system_prompt(scenario, fixtures)
    user_prompt = scenario.get("prompt", "Help me with my tasks.")

    print(f"\nPrompt: {user_prompt[:100]}...")

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    # Get response from Groq
    print("\nCalling Groq API...")
    response_text = call_groq(messages)

    if not response_text:
        print("No response from Groq")
        return {"error": "No response", "score": 0}

    print(f"\nResponse ({len(response_text)} chars):")
    print("-" * 40)
    print(response_text[:500])
    if len(response_text) > 500:
        print("...")
    print("-" * 40)

    # Extract tool calls (simple parsing)
    import re
    tool_calls = []
    for match in re.finditer(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", response_text, re.DOTALL):
        try:
            tc = json.loads(match.group(1))
            tool_calls.append(tc)
        except json.JSONDecodeError:
            pass

    print(f"\nTool calls detected: {len(tool_calls)}")

    # Build scorable result
    scorable = {
        "response": response_text,
        "tool_calls_raw": [{"tool": tc.get("tool", "unknown"), "args": tc.get("args", {})} for tc in tool_calls],
        "tool_calls_by_type": {},
        "tool_calls_total": len(tool_calls),
    }

    # Count tool types
    for tc in tool_calls:
        tool_name = tc.get("tool", "unknown")
        scorable["tool_calls_by_type"][tool_name] = scorable["tool_calls_by_type"].get(tool_name, 0) + 1

    # Score
    scoring_config = scenario.get("scoring")
    if scoring_config:
        score_result = score_episode(scorable, scoring_config)
        print(f"\nScore: {score_result.get('score', 0):.1%}")
        print(f"Passed: {score_result.get('passed', 0)}/{score_result.get('total', 0)} checks")

        if score_result.get("failures"):
            print("\nFailed checks:")
            for f in score_result["failures"][:5]:
                print(f"  - {f}")

        return {
            "scenario": scenario_name,
            "model": GROQ_MODEL,
            "response": response_text,
            "tool_calls": tool_calls,
            "score": score_result,
        }

    return {
        "scenario": scenario_name,
        "model": GROQ_MODEL,
        "response": response_text,
        "tool_calls": tool_calls,
    }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(
        description="Run ClawBench single-turn test with Groq API"
    )
    parser.add_argument("--scenario", "-s", default="inbox_triage",
                        help="Scenario to run")
    parser.add_argument("--model", "-m", default=GROQ_MODEL,
                        help="Groq model to use")
    parser.add_argument("--list", "-l", action="store_true",
                        help="List available scenarios")
    args = parser.parse_args()

    if args.list:
        print("Available scenarios:")
        for f in sorted(SCENARIOS_DIR.glob("*.yaml")):
            print(f"  - {f.stem}")
        sys.exit(0)

    GROQ_MODEL = args.model

    try:
        result = run_scenario(args.scenario)
    except BenchmarkError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nInterrupted")
        sys.exit(130)

    if "error" in result:
        print(f"Error: {result['error']}", file=sys.stderr)
        sys.exit(1)

    print(f"\n{'='*60}")
    print("COMPLETE")
    print(f"{'='*60}")
