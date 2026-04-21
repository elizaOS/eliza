#!/usr/bin/env python3
"""
Run ALL scenarios × variants in batch, save results for review.

This script:
  1. Generates an all-tools-allowed openclaw.json (so we don't restart between scenarios)
  2. Optionally starts/stops docker compose
  3. Loops through every scenario × variant
  4. For each: copies workspace files, resets mock server, sends prompt, collects results
  5. Saves per-run JSON + a human-readable summary

Usage:
    # Full lifecycle (recommended):
    python scripts/run_batch.py --start --wait --stop

    # If services are already running:
    python scripts/run_batch.py --wait

    # Just one scenario (both variants):
    python scripts/run_batch.py --wait --only morning_brief

    # Dry run (no API calls — just verify fixtures load):
    python scripts/run_batch.py --dry-run

Results appear in:
    results/
    ├── morning_brief_baseline.json        # full results
    ├── morning_brief_baseline_response.md # assistant response only
    ├── morning_brief_optimized.json
    ├── morning_brief_optimized_response.md
    ├── ...
    └── summary.md                         # comparison table
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
import yaml

# Add project root to path so we can import the scoring module
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from clawbench.scoring import score_episode, format_score_summary, format_score_markdown

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SANDBOX_DIR = Path(__file__).resolve().parent.parent
SCENARIOS_DIR = SANDBOX_DIR / "scenarios"
FIXTURES_DIR = SANDBOX_DIR / "fixtures"
WORKSPACE_DIR = SANDBOX_DIR / "workspace"
GENERATED_DIR = SANDBOX_DIR / "generated"
RESULTS_DIR = SANDBOX_DIR / "results"

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
OPENCLAW_URL = os.getenv("OPENCLAW_URL", "http://localhost:18790")
OPENCLAW_TOKEN = os.getenv("OPENCLAW_GATEWAY_TOKEN", "sandbox-token-12345")
MOCK_TOOLS_URL = os.getenv("MOCK_TOOLS_URL", "http://localhost:3001")
CLAWBENCH_MODEL = os.getenv("CLAWBENCH_MODEL", "anthropic/claude-sonnet-4-5-20250929")

# All mock tools — must match the real OpenClaw tool surface (see mock_tools/server.py)
ALL_MOCK_TOOLS = [
    "exec",
    "slack",
    "memory_search",
    "memory_get",
    "web_search",
    "web_fetch",
    "read",
]

# Tools to deny in the generated config (dangerous/unused in sandbox)
DENY_TOOLS = [
    "process",
    "browser",
    "canvas",
    "nodes",
    "cron",
    "gateway",
    "apply_patch",
]


# ---------------------------------------------------------------------------
# Generate all-tools openclaw config
# ---------------------------------------------------------------------------
def generate_all_tools_config():
    """Generate an openclaw.json that allows ALL mock tools (for batch testing)."""
    config = {
        "gateway": {
            "mode": "local", "bind": "lan", "port": 18789,
            "auth": {"mode": "token", "token": "sandbox-token-12345"},
            "tailscale": {"mode": "off"},
            "http": {"endpoints": {"chatCompletions": {"enabled": True}}},
        },
        "agents": {
            "defaults": {
                "workspace": "/workspace",
                "model": {"primary": CLAWBENCH_MODEL},
            },
        },
        "plugins": {
            "entries": {
                "clawbench-tools": {
                    "enabled": True,
                    "config": {"mockServerUrl": "http://mock-tools:3001", "scenario": "inbox_triage"},
                },
            },
        },
        "tools": {
            "deny": DENY_TOOLS,
            "allow": ALL_MOCK_TOOLS + ["read", "session_status"],
        },
        "channels": {},
    }
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    config_path = GENERATED_DIR / "openclaw.json"
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)
    print(f"Generated all-tools config: {config_path}")
    return config_path


# ---------------------------------------------------------------------------
# Docker lifecycle
# ---------------------------------------------------------------------------
def start_services():
    print("\n=== Starting docker compose (detached) ===")
    subprocess.run(
        ["docker", "compose", "up", "--build", "-d"],
        cwd=SANDBOX_DIR, check=True,
    )


def stop_services():
    print("\n=== Stopping docker compose ===")
    subprocess.run(
        ["docker", "compose", "down"],
        cwd=SANDBOX_DIR, check=True,
    )


def wait_for_services(timeout: int = 120) -> bool:
    print("Waiting for services...")
    start = time.time()
    mock_ready = False
    openclaw_ready = False

    while time.time() - start < timeout:
        # Check mock tools
        if not mock_ready:
            try:
                r = httpx.get(f"{MOCK_TOOLS_URL}/health", timeout=3)
                if r.status_code == 200:
                    health = r.json()
                    print(f"  Mock tools: OK ({health.get('tools_available', '?')} tools)")
                    mock_ready = True
            except httpx.RequestError:
                pass

        # Check OpenClaw (try the health or just a connection)
        if mock_ready and not openclaw_ready:
            try:
                r = httpx.get(f"{OPENCLAW_URL}/health", timeout=3)
                openclaw_ready = True
                print("  OpenClaw: OK")
            except httpx.RequestError:
                try:
                    # Some versions don't have /health — try chat endpoint
                    r = httpx.get(OPENCLAW_URL, timeout=3)
                    openclaw_ready = True
                    print("  OpenClaw: OK (responded)")
                except httpx.RequestError:
                    pass

        if mock_ready and openclaw_ready:
            return True

        elapsed = int(time.time() - start)
        if elapsed % 10 == 0 and elapsed > 0:
            print(f"  Still waiting... ({elapsed}s)")
        time.sleep(2)

    print(f"  TIMEOUT after {timeout}s")
    return False


# ---------------------------------------------------------------------------
# Scenario helpers
# ---------------------------------------------------------------------------
def load_all_scenarios() -> list[dict]:
    """Load all scenario YAML configs, sorted by name."""
    scenarios = []
    for path in sorted(SCENARIOS_DIR.glob("*.yaml")):
        with open(path) as f:
            s = yaml.safe_load(f)
        s["_path"] = path
        scenarios.append(s)
    return scenarios


def setup_workspace(scenario: dict, variant: str) -> bool:
    """Copy AGENTS.md variant and workspace files for a scenario."""
    name = scenario["name"]
    fixture_dir = FIXTURES_DIR / name
    variants = scenario.get("variants", {})

    if variant not in variants:
        print(f"  WARNING: variant '{variant}' not found in {name}")
        return False

    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

    # Copy AGENTS.md variant
    src = fixture_dir / variants[variant]
    if src.exists():
        shutil.copy2(src, WORKSPACE_DIR / "AGENTS.md")
    else:
        print(f"  WARNING: {src} not found")
        return False

    # Copy workspace files
    for dest_name, src_name in scenario.get("workspace", {}).items():
        src = fixture_dir / src_name
        if src.exists():
            shutil.copy2(src, WORKSPACE_DIR / dest_name)

    return True


def reset_mock_scenario(scenario_name: str) -> bool:
    """Tell the mock server to switch fixture directory."""
    try:
        r = httpx.post(f"{MOCK_TOOLS_URL}/set_scenario/{scenario_name}", timeout=5)
        return r.status_code == 200
    except httpx.RequestError:
        return False


def send_message(message: str) -> dict:
    """Send a message to OpenClaw and return the raw response."""
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

    try:
        response = httpx.post(url, headers=headers, json=payload, timeout=180)
        if response.status_code != 200:
            return {"error": response.text, "status": response.status_code}
        return response.json()
    except httpx.RequestError as e:
        return {"error": str(e)}


def get_tool_calls() -> list:
    try:
        r = httpx.get(f"{MOCK_TOOLS_URL}/tool_calls", timeout=5)
        if r.status_code == 200:
            return r.json().get("calls", [])
    except httpx.RequestError:
        pass
    return []


def get_all_requests() -> dict:
    try:
        r = httpx.get(f"{MOCK_TOOLS_URL}/all_requests", timeout=5)
        if r.status_code == 200:
            return r.json()
    except httpx.RequestError:
        pass
    return {"requests": [], "summary": {"total": 0, "success": 0, "failed": 0}}


# ---------------------------------------------------------------------------
# Dry-run: verify fixtures without API calls
# ---------------------------------------------------------------------------
def dry_run_scenario(scenario: dict, variant: str) -> dict:
    """Verify fixtures load correctly without calling the LLM."""
    name = scenario["name"]
    fixture_dir = FIXTURES_DIR / name
    variants = scenario.get("variants", {})

    result = {
        "scenario": name,
        "variant": variant,
        "dry_run": True,
        "status": "ok",
        "issues": [],
        "fixtures_found": [],
        "fixtures_missing": [],
    }

    # Check variant file exists
    if variant not in variants:
        result["status"] = "error"
        result["issues"].append(f"Variant '{variant}' not defined in scenario YAML")
        return result

    agents_file = fixture_dir / variants[variant]
    if agents_file.exists():
        result["fixtures_found"].append(str(variants[variant]))
    else:
        result["status"] = "error"
        result["issues"].append(f"AGENTS.md variant not found: {agents_file}")

    # Check workspace files
    for dest, src in scenario.get("workspace", {}).items():
        src_path = fixture_dir / src
        if src_path.exists():
            result["fixtures_found"].append(src)
        else:
            result["fixtures_missing"].append(src)
            result["issues"].append(f"Workspace file missing: {src_path}")

    # Check tool fixtures — map real tool names to expected fixture files
    tools = scenario.get("tools", [])
    TOOL_FIXTURES = {
        "exec": ["inbox.json", "calendar.json", "tasks.json"],
        "slack": ["slack_messages.json"],
        "memory_search": [],  # checked separately below
        "memory_get": [],
        "read": [],  # reads workspace files, not fixtures
        "web_search": ["web_search_results.json"],
        "web_fetch": ["web_pages.json"],
    }
    checked = set()
    for tool in tools:
        for fixture_name in TOOL_FIXTURES.get(tool, []):
            if fixture_name in checked:
                continue
            checked.add(fixture_name)
            fixture_path = fixture_dir / fixture_name
            if fixture_path.exists():
                with open(fixture_path) as f:
                    data = json.load(f)
                count = len(data) if isinstance(data, list) else 1
                result["fixtures_found"].append(f"{fixture_name} ({count} items)")
            else:
                result["fixtures_missing"].append(fixture_name)

    # Check memory fixtures
    if "memory_search" in tools or "memory_get" in tools:
        memory_dir = fixture_dir / "memory"
        if memory_dir.exists():
            memory_files = list(memory_dir.iterdir())
            for mf in memory_files:
                result["fixtures_found"].append(f"memory/{mf.name}")
        else:
            result["fixtures_missing"].append("memory/ directory")

    if result["fixtures_missing"]:
        result["status"] = "warning"

    return result


# ---------------------------------------------------------------------------
# Run a single episode
# ---------------------------------------------------------------------------
def run_single(scenario: dict, variant: str) -> dict:
    """Run one scenario × variant and return structured results."""
    name = scenario["name"]
    prompt = scenario.get("prompt", "Help me with my tasks.").strip()
    tools = scenario.get("tools", [])

    print(f"\n{'='*60}")
    print(f"  {name} / {variant}")
    print(f"  Tools: {len(tools)} | Prompt: {prompt[:60]}...")
    print(f"{'='*60}")

    # Setup
    if not setup_workspace(scenario, variant):
        return {"scenario": name, "variant": variant, "status": "error", "error": "workspace setup failed"}

    if not reset_mock_scenario(name):
        return {"scenario": name, "variant": variant, "status": "error", "error": "mock server reset failed"}

    # Small delay for workspace file to be visible
    time.sleep(1)

    # Send message
    t0 = time.time()
    raw_response = send_message(prompt)
    elapsed = time.time() - t0

    # Collect tool data
    tool_calls = get_tool_calls()
    all_reqs = get_all_requests()

    # Extract response
    assistant_message = ""
    if "choices" in raw_response:
        assistant_message = raw_response["choices"][0].get("message", {}).get("content", "")

    failed_requests = [r for r in all_reqs.get("requests", []) if not r.get("success")]
    summary = all_reqs.get("summary", {})

    # Detect error hints
    error_patterns = ["technical issue", "encountered an error", "unable to", "couldn't", "failed to"]
    has_errors = any(p in assistant_message.lower() for p in error_patterns)

    # Tool call summary
    tool_call_counts: dict[str, int] = {}
    for tc in tool_calls:
        tool_call_counts[tc["tool"]] = tool_call_counts.get(tc["tool"], 0) + 1

    result = {
        "scenario": name,
        "variant": variant,
        "status": "error" if "error" in raw_response else "ok",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "elapsed_seconds": round(elapsed, 1),
        "prompt": prompt,
        "response": assistant_message,
        "response_length": len(assistant_message),
        "tool_calls_total": len(tool_calls),
        "tool_calls_by_type": tool_call_counts,
        "tool_calls_raw": tool_calls,
        "requests_total": summary.get("total", 0),
        "requests_success": summary.get("success", 0),
        "requests_failed": summary.get("failed", 0),
        "failed_requests": failed_requests,
        "response_has_error_hints": has_errors,
        "raw_response": raw_response,
    }

    # Score the episode
    scoring_config = scenario.get("scoring")
    if scoring_config:
        score = score_episode(result, scoring_config)
        result["score"] = score
    else:
        result["score"] = {"score": None, "reason": "no scoring rubric"}

    # Print quick status
    status_icon = "✅" if result["status"] == "ok" and not has_errors else "⚠️" if has_errors else "❌"
    score_str = f", score={result['score']['score']:.0%}" if result["score"].get("score") is not None else ""
    print(f"\n  {status_icon} {name}/{variant}: {len(tool_calls)} tool calls, "
          f"{summary.get('failed', 0)} failures, "
          f"{len(assistant_message)} chars, "
          f"{elapsed:.1f}s{score_str}")

    if result["score"].get("score") is not None:
        print(format_score_summary(result["score"]))

    if failed_requests:
        for fr in failed_requests[:3]:
            print(f"     ❌ {fr.get('tool', '?')} → HTTP {fr.get('status_code', '?')}")

    return result


# ---------------------------------------------------------------------------
# Save results
# ---------------------------------------------------------------------------
def save_results(results: list[dict], run_id: str):
    """Save individual result files + summary."""
    run_dir = RESULTS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    all_summaries = []

    for r in results:
        name = r["scenario"]
        variant = r["variant"]
        tag = f"{name}_{variant}"

        # Full JSON result
        with open(run_dir / f"{tag}.json", "w") as f:
            json.dump(r, f, indent=2)

        # Response-only markdown (easy to read)
        response_text = r.get("response", "(no response)")
        with open(run_dir / f"{tag}_response.md", "w") as f:
            f.write(f"# {name} / {variant}\n\n")
            f.write(f"**Prompt:** {r.get('prompt', '?')}\n\n")
            f.write(f"**Tool calls:** {r.get('tool_calls_total', '?')} | ")
            f.write(f"**Failed:** {r.get('requests_failed', '?')} | ")
            f.write(f"**Time:** {r.get('elapsed_seconds', '?')}s\n\n")
            f.write(f"**Tool call breakdown:** {json.dumps(r.get('tool_calls_by_type', {}))}\n\n")
            f.write("---\n\n")
            f.write("## Assistant Response\n\n")
            f.write(response_text)
            f.write("\n")

        # Score card markdown
        score_data = r.get("score", {})
        if score_data.get("score") is not None:
            score_md = format_score_markdown(score_data, name, variant)
            with open(run_dir / f"{tag}_score.md", "w") as f:
                f.write(score_md + "\n")

        all_summaries.append({
            "scenario": name,
            "variant": variant,
            "status": r.get("status", "?"),
            "tool_calls": r.get("tool_calls_total", 0),
            "failed_requests": r.get("requests_failed", 0),
            "response_length": r.get("response_length", 0),
            "elapsed_seconds": r.get("elapsed_seconds", 0),
            "has_error_hints": r.get("response_has_error_hints", False),
            "tool_calls_by_type": r.get("tool_calls_by_type", {}),
            "score": score_data.get("score"),
            "score_detail": score_data.get("by_category"),
        })

    # Summary markdown
    with open(run_dir / "summary.md", "w") as f:
        f.write(f"# Batch Run Summary\n\n")
        f.write(f"**Run ID:** {run_id}\n")
        f.write(f"**Date:** {datetime.now(timezone.utc).isoformat()}\n")
        f.write(f"**Episodes:** {len(results)}\n\n")

        f.write("## Results\n\n")
        f.write("| Scenario | Variant | Status | Score | Tool Calls | Failures | Response Len | Time (s) |\n")
        f.write("|----------|---------|--------|-------|------------|----------|-------------|----------|\n")
        for s in all_summaries:
            status = "✅" if s["status"] == "ok" and not s["has_error_hints"] else "⚠️"
            score_str = f"{s['score']:.0%}" if s.get("score") is not None else "—"
            f.write(f"| {s['scenario']} | {s['variant']} | {status} | {score_str} | "
                    f"{s['tool_calls']} | {s['failed_requests']} | "
                    f"{s['response_length']} | {s['elapsed_seconds']} |\n")

        # Comparison: baseline vs optimized per scenario
        f.write("\n## Baseline vs Optimized Comparison\n\n")
        scenarios_seen = {}
        for s in all_summaries:
            scenarios_seen.setdefault(s["scenario"], {})[s["variant"]] = s

        for scenario_name, variants in scenarios_seen.items():
            baseline = variants.get("baseline")
            optimized = variants.get("optimized")
            if baseline and optimized:
                f.write(f"### {scenario_name}\n\n")
                f.write(f"| Metric | Baseline | Optimized | Delta |\n")
                f.write(f"|--------|----------|-----------|-------|\n")

                tc_b, tc_o = baseline["tool_calls"], optimized["tool_calls"]
                f.write(f"| Tool calls | {tc_b} | {tc_o} | {tc_o - tc_b:+d} |\n")

                rl_b, rl_o = baseline["response_length"], optimized["response_length"]
                f.write(f"| Response length | {rl_b} | {rl_o} | {rl_o - rl_b:+d} |\n")

                et_b, et_o = baseline["elapsed_seconds"], optimized["elapsed_seconds"]
                f.write(f"| Time (s) | {et_b} | {et_o} | {et_o - et_b:+.1f} |\n")

                ff_b, ff_o = baseline["failed_requests"], optimized["failed_requests"]
                f.write(f"| Failed requests | {ff_b} | {ff_o} | {ff_o - ff_b:+d} |\n")

                # Score comparison
                sc_b = baseline.get("score")
                sc_o = optimized.get("score")
                if sc_b is not None and sc_o is not None:
                    f.write(f"| **Score** | **{sc_b:.0%}** | **{sc_o:.0%}** | **{sc_o - sc_b:+.0%}** |\n")

                    # Per-category score comparison
                    f.write(f"\n**Score breakdown:**\n\n")
                    f.write(f"| Category | Baseline | Optimized |\n")
                    f.write(f"|----------|----------|----------|\n")
                    cats_b = baseline.get("score_detail", {})
                    cats_o = optimized.get("score_detail", {})
                    for cat in ["safety", "correctness", "efficiency", "structure"]:
                        cb = cats_b.get(cat, {})
                        co = cats_o.get(cat, {})
                        b_str = f"{cb.get('earned', 0)}/{cb.get('possible', 0)}" if cb else "—"
                        o_str = f"{co.get('earned', 0)}/{co.get('possible', 0)}" if co else "—"
                        f.write(f"| {cat} | {b_str} | {o_str} |\n")

                f.write(f"\n**Baseline tools:** {json.dumps(baseline['tool_calls_by_type'])}\n")
                f.write(f"**Optimized tools:** {json.dumps(optimized['tool_calls_by_type'])}\n\n")

        # Per-run file listing
        f.write("\n## Result Files\n\n")
        for s in all_summaries:
            tag = f"{s['scenario']}_{s['variant']}"
            f.write(f"- `{tag}.json` — full results\n")
            f.write(f"- `{tag}_response.md` — assistant response\n")

    # Summary JSON (machine-readable)
    with open(run_dir / "summary.json", "w") as f:
        json.dump({"run_id": run_id, "results": all_summaries}, f, indent=2)

    print(f"\n📁 Results saved to: {run_dir}/")
    print(f"   summary.md — comparison table")
    print(f"   summary.json — machine-readable")
    for s in all_summaries:
        tag = f"{s['scenario']}_{s['variant']}"
        print(f"   {tag}_response.md — assistant output")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Batch-run all scenarios and save results for review",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Full lifecycle:
  python scripts/run_batch.py --start --wait --stop

  # Services already running:
  python scripts/run_batch.py --wait

  # Just one scenario:
  python scripts/run_batch.py --wait --only morning_brief

  # Dry run (verify fixtures, no LLM calls):
  python scripts/run_batch.py --dry-run
        """,
    )
    parser.add_argument("--start", action="store_true", help="Start docker compose before running")
    parser.add_argument("--stop", action="store_true", help="Stop docker compose after running")
    parser.add_argument("--wait", "-w", action="store_true", help="Wait for services to be ready")
    parser.add_argument("--only", type=str, help="Run only this scenario (both variants)")
    parser.add_argument("--variant", type=str, help="Run only this variant (use with --only)")
    parser.add_argument("--dry-run", action="store_true", help="Verify fixtures without calling the LLM")
    parser.add_argument("--timeout", type=int, default=120, help="Service startup timeout in seconds")

    args = parser.parse_args()

    run_id = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")

    # Load scenarios
    scenarios = load_all_scenarios()
    if not scenarios:
        print("ERROR: No scenarios found in scenarios/")
        sys.exit(1)

    # Filter if --only
    if args.only:
        scenarios = [s for s in scenarios if s["name"] == args.only]
        if not scenarios:
            print(f"ERROR: Scenario '{args.only}' not found")
            sys.exit(1)

    # Build run plan
    plan: list[tuple[dict, str]] = []
    for s in scenarios:
        variants = list(s.get("variants", {}).keys())
        if args.variant:
            variants = [v for v in variants if v == args.variant]
        for v in variants:
            plan.append((s, v))

    print(f"=== Batch Run Plan ===")
    print(f"Run ID: {run_id}")
    print(f"Episodes: {len(plan)}")
    for s, v in plan:
        tools = s.get("tools", [])
        print(f"  • {s['name']}/{v} ({len(tools)} tools)")

    # -----------------------------------------------------------------------
    # Dry run mode
    # -----------------------------------------------------------------------
    if args.dry_run:
        print(f"\n=== Dry Run (fixture verification) ===\n")
        results = []
        for s, v in plan:
            r = dry_run_scenario(s, v)
            results.append(r)
            icon = {"ok": "✅", "warning": "⚠️", "error": "❌"}.get(r["status"], "?")
            print(f"  {icon} {s['name']}/{v}")
            for fix in r["fixtures_found"]:
                print(f"      ✓ {fix}")
            for fix in r["fixtures_missing"]:
                print(f"      ✗ {fix} (missing — tool will return empty)")
            for issue in r["issues"]:
                print(f"      ! {issue}")

        # Show scoring rubric summary
        print(f"\n=== Scoring Rubrics ===\n")
        seen_scenarios = set()
        for s, v in plan:
            if s["name"] in seen_scenarios:
                continue
            seen_scenarios.add(s["name"])
            scoring = s.get("scoring", {})
            checks = scoring.get("checks", [])
            if checks:
                total_points = sum(c.get("points", 1) for c in checks)
                cats = {}
                for c in checks:
                    cat = c.get("category", "other")
                    cats[cat] = cats.get(cat, 0) + c.get("points", 1)
                cat_str = ", ".join(f"{cat}={pts}" for cat, pts in sorted(cats.items()))
                print(f"  {s['name']}: {len(checks)} checks, {total_points} points ({cat_str})")
                for c in checks:
                    print(f"    [{c.get('category', '?'):>12}] {c['id']} ({c.get('points', 1)}pts) — {c.get('description', '')}")
            else:
                print(f"  {s['name']}: (no scoring rubric)")

        # Save dry run report
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        with open(RESULTS_DIR / "dry_run.json", "w") as f:
            json.dump(results, f, indent=2)
        print(f"\nDry run report: results/dry_run.json")
        return

    # -----------------------------------------------------------------------
    # Live run
    # -----------------------------------------------------------------------

    # Generate all-tools config
    generate_all_tools_config()

    # Start services
    if args.start:
        start_services()

    # Wait for services
    if args.wait or args.start:
        if not wait_for_services(timeout=args.timeout):
            print("ERROR: Services not ready. Is docker compose running?")
            if args.start:
                stop_services()
            sys.exit(1)

    # Run episodes
    results = []
    for i, (s, v) in enumerate(plan):
        print(f"\n[{i+1}/{len(plan)}] Running {s['name']}/{v}...")
        try:
            result = run_single(s, v)
            results.append(result)
        except Exception as e:
            print(f"  ❌ Exception: {e}")
            results.append({
                "scenario": s["name"], "variant": v,
                "status": "exception", "error": str(e),
            })

    # Save results
    save_results(results, run_id)

    # Print final summary table
    print(f"\n{'='*80}")
    print(f"  BATCH SUMMARY — {len(results)} episodes")
    print(f"{'='*80}")
    print(f"{'Scenario':<20} {'Variant':<10} {'Status':<6} {'Score':<7} {'Tools':<6} {'Fail':<5} {'Resp':<7} {'Time':<6}")
    print(f"{'-'*20} {'-'*10} {'-'*6} {'-'*7} {'-'*6} {'-'*5} {'-'*7} {'-'*6}")
    for r in results:
        status = "OK" if r.get("status") == "ok" and not r.get("response_has_error_hints") else "WARN" if r.get("response_has_error_hints") else "ERR"
        score = r.get("score", {})
        score_str = f"{score['score']:.0%}" if score.get("score") is not None else "—"
        print(f"{r.get('scenario','?'):<20} {r.get('variant','?'):<10} {status:<6} "
              f"{score_str:<7} "
              f"{r.get('tool_calls_total', '?'):<6} {r.get('requests_failed', '?'):<5} "
              f"{r.get('response_length', '?'):<7} {r.get('elapsed_seconds', '?'):<6}")

    # Stop services
    if args.stop:
        stop_services()

    print(f"\nDone. Review results in: results/{run_id}/")


if __name__ == "__main__":
    main()
