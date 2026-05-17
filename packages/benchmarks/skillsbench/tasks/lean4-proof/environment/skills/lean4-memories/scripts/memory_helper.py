#!/usr/bin/env python3
"""
Memory Helper for Lean 4 Formalization

This script provides convenient wrappers for MCP memory operations
specific to Lean 4 theorem proving workflows.

Usage:
    # Store a successful proof pattern
    ./memory_helper.py store-pattern --goal "..." --tactics "..." --confidence 0.9

    # Retrieve similar patterns
    ./memory_helper.py find-patterns --query "conditional expectation"

    # Store a failed approach
    ./memory_helper.py store-failure --tactic "simp only [...]" --error "infinite loop"

    # Check for known failures
    ./memory_helper.py check-failure --tactic "simp only [...]"

Note: This script assumes MCP memory server is configured and available.
      It provides a CLI interface but is primarily designed to be used
      programmatically by Claude during theorem proving sessions.
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

# Note: In actual usage with MCP, these would use the MCP client API
# For now, this is a template showing the structure and interface


def get_project_root() -> str:
    """Get absolute path to current project (git root or cwd)."""
    cwd = os.getcwd()

    # Try to find git root
    current = Path(cwd)
    while current != current.parent:
        if (current / ".git").exists():
            return str(current)
        current = current.parent

    # Fall back to cwd
    return cwd


def estimate_difficulty(lines: int) -> str:
    """Estimate proof difficulty from line count."""
    if lines <= 10:
        return "small"
    elif lines <= 50:
        return "medium"
    elif lines <= 100:
        return "large"
    else:
        return "huge"


def store_proof_pattern(args: argparse.Namespace) -> None:
    """Store a successful proof pattern in memory."""

    project = get_project_root()

    entity = {
        "entity_type": "ProofPattern",
        "name": args.name or f"pattern_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
        "content": {
            "project": project,
            "skill": "lean4-memories",
            "goal_pattern": args.goal,
            "tactics_sequence": args.tactics.split(",") if isinstance(args.tactics, str) else args.tactics,
            "helper_lemmas": args.lemmas.split(",") if args.lemmas else [],
            "domain": args.domain or "general",
            "difficulty": args.difficulty or estimate_difficulty(args.lines or 20),
            "lines_of_proof": args.lines or 0,
            "confidence": args.confidence,
            "file": args.file or "",
            "theorem_name": args.theorem or "",
            "success_count": 1,
            "timestamp": datetime.now().isoformat(),
        },
    }

    # In actual MCP usage, this would call:
    # mcp_client.create_entity(**entity)

    print(f"Would store ProofPattern: {entity['name']}")
    print(json.dumps(entity, indent=2))
    print("\n✅ Pattern stored successfully (simulation)")


def find_similar_patterns(args: argparse.Namespace) -> None:
    """Find similar proof patterns from memory."""

    project = get_project_root()

    query_params = {
        "query": args.query,
        "entity_type": "ProofPattern",
        "filters": {"project": project, "skill": "lean4-memories", "confidence": {">=": args.min_confidence}},
        "limit": args.limit,
    }

    # In actual MCP usage, this would call:
    # results = mcp_client.search_entities(**query_params)

    print(f"Would query for patterns: {args.query}")
    print(json.dumps(query_params, indent=2))
    print("\n📋 Results would appear here (simulation)")
    print("Example result:")
    print(
        {
            "name": "pi_system_uniqueness",
            "goal_pattern": "Show measures equal via finite marginals",
            "tactics": ["apply measure_eq_of_fin_marginals_eq", "intro n"],
            "confidence": 0.9,
        }
    )


def store_failed_approach(args: argparse.Namespace) -> None:
    """Store a failed approach to avoid repeating."""

    project = get_project_root()

    entity = {
        "entity_type": "FailedApproach",
        "name": args.name or f"failure_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
        "content": {
            "project": project,
            "skill": "lean4-memories",
            "failed_tactic": args.tactic,
            "error_type": args.error_type or "unknown",
            "error_message": args.error,
            "context": args.context or "",
            "goal_pattern": args.goal or "",
            "file": args.file or "",
            "line": args.line or 0,
            "alternative_approach": args.alternative or "",
            "time_wasted": args.time_wasted or "",
            "confidence": 0.95,  # High confidence in failures
            "timestamp": datetime.now().isoformat(),
        },
    }

    # In actual MCP usage, this would call:
    # mcp_client.create_entity(**entity)

    print(f"Would store FailedApproach: {entity['name']}")
    print(json.dumps(entity, indent=2))
    print("\n✅ Failure stored successfully (simulation)")
    print("⚠️  This approach will be flagged in future sessions")


def check_for_failure(args: argparse.Namespace) -> None:
    """Check if a tactic is known to fail."""

    project = get_project_root()

    query_params = {"query": args.tactic, "entity_type": "FailedApproach", "filters": {"project": project, "skill": "lean4-memories"}}

    # In actual MCP usage, this would call:
    # results = mcp_client.search_entities(**query_params)

    print(f"Checking if tactic is known to fail: {args.tactic}")
    print(json.dumps(query_params, indent=2))
    print("\n🔍 Check results (simulation):")
    print("✅ No known failures for this tactic")
    # Or if found:
    # print("⚠️ WARNING: This tactic causes infinite loop (stored 2025-10-17)")


def store_convention(args: argparse.Namespace) -> None:
    """Store a project convention."""

    project = get_project_root()

    entity = {
        "entity_type": "ProjectConvention",
        "name": args.name or f"convention_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
        "content": {
            "project": project,
            "skill": "lean4-memories",
            "convention_type": args.type or "general",
            "pattern": args.pattern,
            "description": args.description,
            "domain": args.domain or "general",
            "frequency": args.frequency or 1,
            "confidence": args.confidence,
            "timestamp": datetime.now().isoformat(),
        },
    }

    print(f"Would store ProjectConvention: {entity['name']}")
    print(json.dumps(entity, indent=2))
    print("\n✅ Convention stored successfully (simulation)")


def list_memories(args: argparse.Namespace) -> None:
    """List all memories for current project."""

    project = get_project_root()

    print(f"📁 Project: {project}")
    print(f"🔍 Memory type: {args.type or 'all'}")
    print("\nWould list memories here (simulation)")
    print("\nExample memories:")
    print("- ProofPattern: pi_system_uniqueness (confidence: 0.9, used: 3 times)")
    print("- FailedApproach: simp_condExp_loop (avoided infinite loop)")
    print("- ProjectConvention: hypothesis_naming (h_ prefix)")


def export_memories(args: argparse.Namespace) -> None:
    """Export memories to JSON file for sharing."""

    project = get_project_root()
    output_file = args.output or "lean4_memories_export.json"

    print(f"Would export memories from {project} to {output_file}")
    print("✅ Export complete (simulation)")


def main():
    parser = argparse.ArgumentParser(
        description="Memory Helper for Lean 4 Formalization", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__
    )

    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # Store proof pattern
    pattern_parser = subparsers.add_parser("store-pattern", help="Store successful proof pattern")
    pattern_parser.add_argument("--name", help="Pattern name")
    pattern_parser.add_argument("--goal", required=True, help="Goal description")
    pattern_parser.add_argument("--tactics", required=True, help="Comma-separated tactics")
    pattern_parser.add_argument("--lemmas", help="Comma-separated helper lemmas")
    pattern_parser.add_argument("--domain", help="Domain (measure_theory, probability, etc.)")
    pattern_parser.add_argument("--difficulty", choices=["small", "medium", "large", "huge"])
    pattern_parser.add_argument("--lines", type=int, help="Lines of proof")
    pattern_parser.add_argument("--confidence", type=float, default=0.8, help="Confidence (0.0-1.0)")
    pattern_parser.add_argument("--file", help="File name")
    pattern_parser.add_argument("--theorem", help="Theorem name")

    # Find patterns
    find_parser = subparsers.add_parser("find-patterns", help="Find similar proof patterns")
    find_parser.add_argument("--query", required=True, help="Search query")
    find_parser.add_argument("--min-confidence", type=float, default=0.7, help="Minimum confidence")
    find_parser.add_argument("--limit", type=int, default=5, help="Max results")

    # Store failure
    failure_parser = subparsers.add_parser("store-failure", help="Store failed approach")
    failure_parser.add_argument("--name", help="Failure name")
    failure_parser.add_argument("--tactic", required=True, help="Failed tactic")
    failure_parser.add_argument("--error", required=True, help="Error message")
    failure_parser.add_argument("--error-type", help="Error type (infinite_loop, type_mismatch, etc.)")
    failure_parser.add_argument("--context", help="Context description")
    failure_parser.add_argument("--goal", help="Goal pattern")
    failure_parser.add_argument("--file", help="File name")
    failure_parser.add_argument("--line", type=int, help="Line number")
    failure_parser.add_argument("--alternative", help="Alternative that worked")
    failure_parser.add_argument("--time-wasted", help='Time wasted (e.g., "20 minutes")')

    # Check failure
    check_parser = subparsers.add_parser("check-failure", help="Check if tactic is known to fail")
    check_parser.add_argument("--tactic", required=True, help="Tactic to check")

    # Store convention
    convention_parser = subparsers.add_parser("store-convention", help="Store project convention")
    convention_parser.add_argument("--name", help="Convention name")
    convention_parser.add_argument("--type", help="Convention type")
    convention_parser.add_argument("--pattern", required=True, help="Pattern")
    convention_parser.add_argument("--description", required=True, help="Description")
    convention_parser.add_argument("--domain", help="Domain")
    convention_parser.add_argument("--frequency", type=int, help="Observation frequency")
    convention_parser.add_argument("--confidence", type=float, default=0.8, help="Confidence")

    # List memories
    list_parser = subparsers.add_parser("list", help="List memories for current project")
    list_parser.add_argument("--type", help="Filter by type (ProofPattern, FailedApproach, etc.)")

    # Export memories
    export_parser = subparsers.add_parser("export", help="Export memories to JSON")
    export_parser.add_argument("--output", help="Output file (default: lean4_memories_export.json)")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    # Dispatch to appropriate handler
    handlers = {
        "store-pattern": store_proof_pattern,
        "find-patterns": find_similar_patterns,
        "store-failure": store_failed_approach,
        "check-failure": check_for_failure,
        "store-convention": store_convention,
        "list": list_memories,
        "export": export_memories,
    }

    handler = handlers.get(args.command)
    if handler:
        handler(args)
    else:
        print(f"Unknown command: {args.command}")
        sys.exit(1)


if __name__ == "__main__":
    main()
