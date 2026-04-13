#!/usr/bin/env python3
"""
Run a single episode against the OpenClaw sandbox.

Scenario-aware: reads the scenario YAML config to get the default prompt,
tool list, and other settings. Can also accept a custom message.

Usage:
    python scripts/run_episode.py --scenario inbox_triage
    python scripts/run_episode.py --scenario inbox_triage --message "Custom prompt"
    python scripts/run_episode.py --wait --scenario inbox_triage
"""

import argparse
import json
import os
import shutil
import sys
import time
from collections import Counter
from pathlib import Path

import httpx
import yaml

# Allow imports from the clawbench package
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from clawbench.scoring import score_episode

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SANDBOX_DIR = Path(__file__).resolve().parent.parent
SCENARIOS_DIR = SANDBOX_DIR / "scenarios"
FIXTURES_DIR = SANDBOX_DIR / "fixtures"
WORKSPACE_DIR = SANDBOX_DIR / "workspace"

# ---------------------------------------------------------------------------
# Configuration (env vars with defaults)
# ---------------------------------------------------------------------------
OPENCLAW_URL = os.getenv("OPENCLAW_URL", "http://localhost:18790")
OPENCLAW_TOKEN = os.getenv("OPENCLAW_GATEWAY_TOKEN", "sandbox-token-12345")
MOCK_TOOLS_URL = os.getenv("MOCK_TOOLS_URL", "http://localhost:3001")
CLAWBENCH_MODEL = os.getenv("CLAWBENCH_MODEL", "anthropic/claude-sonnet-4-5-20250929")


def load_scenario(name: str) -> dict | None:
    """Load scenario YAML config. Returns None if not found."""
    path = SCENARIOS_DIR / f"{name}.yaml"
    if not path.exists():
        return None
    with open(path) as f:
        return yaml.safe_load(f)


def wait_for_services(timeout: int = 60) -> bool:
    """Wait for OpenClaw and mock-tools to be ready."""
    print("Waiting for services...")
    start = time.time()
    mock_ready = False
    openclaw_ready = False

    while time.time() - start < timeout:
        if not mock_ready:
            try:
                r = httpx.get(f"{MOCK_TOOLS_URL}/health", timeout=2)
                if r.status_code == 200:
                    health = r.json()
                    print(f"  Mock tools: OK ({health.get('tools_available', '?')} tools, scenario={health.get('scenario', '?')})")
                    mock_ready = True
            except httpx.RequestError:
                pass

        if mock_ready and not openclaw_ready:
            try:
                r = httpx.get(f"{OPENCLAW_URL}/health", timeout=2)
                if r.status_code == 200:
                    print("  OpenClaw: OK")
                    openclaw_ready = True
            except httpx.RequestError:
                pass

        if mock_ready and openclaw_ready:
            return True

        elapsed = int(time.time() - start)
        if elapsed > 0 and elapsed % 10 == 0:
            status = []
            if not mock_ready:
                status.append("mock-tools")
            if not openclaw_ready:
                status.append("openclaw")
            print(f"  Still waiting for {', '.join(status)}... ({elapsed}s)")

        time.sleep(1)

    if not mock_ready:
        print("  TIMEOUT: mock-tools not ready")
    if not openclaw_ready:
        print("  TIMEOUT: OpenClaw not ready")
    return False


def send_message(message: str) -> dict:
    """Send a message to OpenClaw via OpenAI-compatible API."""
    url = f"{OPENCLAW_URL}/v1/chat/completions"

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {OPENCLAW_TOKEN}",
    }

    payload = {
        "model": CLAWBENCH_MODEL,
        "messages": [{"role": "user", "content": message}],
        "stream": False,
    }

    print(f"\nSending message to OpenClaw:")
    print(f"  URL: {url}")
    print(f"  Message: {message[:100]}...")

    try:
        response = httpx.post(url, headers=headers, json=payload, timeout=120)

        if response.status_code != 200:
            print(f"  Error: {response.status_code}")
            print(f"  Body: {response.text[:500]}")
            return {"error": response.text, "status": response.status_code}

        return response.json()

    except httpx.RequestError as e:
        print(f"  Request error: {e}")
        return {"error": str(e)}


def get_tool_calls() -> list:
    """Get successful tool calls from mock-tools server."""
    try:
        response = httpx.get(f"{MOCK_TOOLS_URL}/tool_calls", timeout=5)
        if response.status_code == 200:
            return response.json().get("calls", [])
    except httpx.RequestError:
        pass
    return []


def get_all_requests() -> dict:
    """Get ALL requests (including failures) from mock-tools server."""
    try:
        response = httpx.get(f"{MOCK_TOOLS_URL}/all_requests", timeout=5)
        if response.status_code == 200:
            return response.json()
    except httpx.RequestError:
        pass
    return {"requests": [], "summary": {"total": 0, "success": 0, "failed": 0}}


def reset_scenario(scenario: str) -> bool:
    """Reset mock-tools to a specific scenario."""
    try:
        response = httpx.post(f"{MOCK_TOOLS_URL}/set_scenario/{scenario}", timeout=5)
        return response.status_code == 200
    except httpx.RequestError:
        return False


def setup_workspace(scenario_config: dict, variant: str) -> bool:
    """Copy AGENTS.md variant and workspace files for the scenario."""
    scenario_name = scenario_config["name"]
    fixture_dir = FIXTURES_DIR / scenario_name

    variants = scenario_config.get("variants", {})
    if variant not in variants:
        print(f"  WARNING: Unknown variant '{variant}', available: {list(variants.keys())}")
        return False

    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

    agents_src = fixture_dir / variants[variant]
    if agents_src.exists():
        shutil.copy2(agents_src, WORKSPACE_DIR / "AGENTS.md")
        print(f"  Copied {agents_src.name} -> workspace/AGENTS.md")
    else:
        print(f"  WARNING: {agents_src} not found")
        return False

    for dest_name, src_name in scenario_config.get("workspace", {}).items():
        src = fixture_dir / src_name
        if src.exists():
            shutil.copy2(src, WORKSPACE_DIR / dest_name)

    return True


def run_episode(message: str, scenario: str = "inbox_triage") -> dict:
    """Run a complete episode and return results."""

    # Reset scenario
    print(f"\nResetting to scenario: {scenario}")
    if not reset_scenario(scenario):
        print("  Warning: Could not reset scenario")

    # Send message
    response = send_message(message)

    # Get tool calls
    tool_calls = get_tool_calls()
    all_reqs = get_all_requests()

    # Extract assistant response
    assistant_message = ""
    if "choices" in response:
        assistant_message = response["choices"][0].get("message", {}).get("content", "")

    # Detect errors
    failed_requests = [r for r in all_reqs.get("requests", []) if not r.get("success")]

    error_patterns = [
        "technical issue", "encountered an error", "unable to",
        "couldn't", "failed to", "try again",
    ]
    response_has_error_hints = any(
        pattern in assistant_message.lower() for pattern in error_patterns
    )

    result = {
        "scenario": scenario,
        "input_message": message,
        "response": assistant_message,
        "tool_calls": tool_calls,
        "all_requests": all_reqs.get("requests", []),
        "request_summary": all_reqs.get("summary", {}),
        "failed_requests": failed_requests,
        "response_has_error_hints": response_has_error_hints,
        "raw_response": response,
    }

    return result


def main():
    parser = argparse.ArgumentParser(description="Run an episode against the OpenClaw sandbox")
    parser.add_argument("--scenario", "-s", type=str, default="inbox_triage",
                        help="Scenario name (must have a YAML config in scenarios/)")
    parser.add_argument("--variant", "-v", type=str, default="optimized",
                        help="AGENTS.md variant (default: optimized)")
    parser.add_argument("--message", "-m", type=str, default=None,
                        help="Message to send (overrides scenario default prompt)")
    parser.add_argument("--wait", "-w", action="store_true",
                        help="Wait for services to be ready")
    parser.add_argument("--output", "-o", type=str,
                        help="Output file for results (JSON)")
    parser.add_argument("--json", "-j", action="store_true",
                        help="Output scored JSON to stdout (for validator integration)")
    parser.add_argument("--workspace", type=str,
                        help="Custom workspace directory (skips default workspace setup)")
    parser.add_argument("--list", "-l", action="store_true",
                        help="List available scenarios")

    args = parser.parse_args()

    # In --json mode, redirect verbose prints to stderr so only JSON goes to stdout
    if args.json:
        _real_stdout = sys.stdout
        sys.stdout = sys.stderr

    if args.list:
        scenarios = sorted(SCENARIOS_DIR.glob("*.yaml"))
        print("Available scenarios:")
        for p in scenarios:
            with open(p) as f:
                s = yaml.safe_load(f)
            tools = s.get("tools", [])
            print(f"  {p.stem:25s} — {s.get('description', '').strip()[:60]}")
            print(f"  {'':25s}   tools: {len(tools)}, variants: {', '.join(s.get('variants', {}).keys())}")
        return

    # Load scenario config for default prompt
    scenario_config = load_scenario(args.scenario)
    if scenario_config is None:
        print(f"WARNING: No scenario config found for '{args.scenario}' — using defaults")
        default_prompt = "Review my inbox and draft replies for urgent emails."
    else:
        default_prompt = scenario_config.get("prompt", "Help me with my tasks.").strip()
        print(f"Loaded scenario: {scenario_config.get('name', args.scenario)}")
        print(f"  Tools: {', '.join(scenario_config.get('tools', []))}")

    message = args.message or default_prompt

    # Setup workspace files for this scenario/variant
    # If --workspace is given, the caller already prepared the workspace (e.g.,
    # validator wrote the pack's AGENTS.md there), so we skip the default setup
    # but still point WORKSPACE_DIR at it.
    if args.workspace:
        global WORKSPACE_DIR
        WORKSPACE_DIR = Path(args.workspace)
        WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    elif scenario_config:
        setup_workspace(scenario_config, args.variant)

    if args.wait:
        if not wait_for_services():
            print("ERROR: Services not ready")
            sys.exit(1)

    # Run episode
    result = run_episode(message, args.scenario)

    # Restore stdout for JSON output
    if args.json:
        sys.stdout = _real_stdout

    # --json mode: score and output JSON for validator integration
    if args.json:
        tool_calls = result.get("tool_calls", [])
        tool_counts = dict(Counter(tc["tool"] for tc in tool_calls))

        # Build the result dict that scoring.py expects
        scorable = {
            "response": result.get("response", ""),
            "tool_calls_raw": tool_calls,
            "tool_calls_by_type": tool_counts,
            "tool_calls_total": len(tool_calls),
        }

        # Score against scenario rubric
        rubric = {}
        score_val = 0.0
        success = False

        if scenario_config:
            scoring_config = scenario_config.get("scoring")
            if scoring_config:
                score_result = score_episode(scorable, scoring_config)
                score_val = score_result.get("score", 0.0)
                success = score_result.get("failed", 1) == 0
                rubric = score_result

        output = {
            "score": score_val,
            "success": success,
            "tool_calls": len(tool_calls),
            "response": result.get("response", ""),
            "rubric": rubric,
        }

        if result.get("response_has_error_hints"):
            output["error"] = "Response contains error language"

        print(json.dumps(output))
        return result

    # Normal mode: print human-readable summary
    print("\n" + "=" * 60)
    print("EPISODE RESULTS")
    print("=" * 60)

    summary = result.get("request_summary", {})
    print(f"\nRequests: {summary.get('total', '?')} total, "
          f"{summary.get('success', '?')} succeeded, "
          f"{summary.get('failed', '?')} failed")

    print(f"\nSuccessful Tool Calls ({len(result['tool_calls'])}):")
    for call in result["tool_calls"]:
        print(f"  + {call['tool']}: {call.get('args', {})}")

    if result.get("failed_requests"):
        print(f"\nFailed Requests ({len(result['failed_requests'])}):")
        for req in result["failed_requests"]:
            print(f"  ! {req.get('tool', '?')} (HTTP {req.get('status_code', '?')})")

    if result.get("response_has_error_hints"):
        print("\n** WARNING: Assistant response contains error language **")

    print(f"\nAssistant Response:")
    resp_text = result["response"]
    print(f"  {resp_text[:500]}{'...' if len(resp_text) > 500 else ''}")

    # Save to file if requested
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            json.dump(result, f, indent=2)
        print(f"\nResults saved to: {args.output}")

    return result


if __name__ == "__main__":
    main()
