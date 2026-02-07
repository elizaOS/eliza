#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0"]
# ///
"""Validate generated skills for the testing-handbook-generator.

Performs comprehensive validation including:
- YAML frontmatter parsing and field validation
- Required sections presence by skill type
- Line count limits
- Hugo shortcode detection
- Escaped backtick detection (from template artifacts)
- Cross-reference validation (related skills exist)
- Internal link resolution

Usage:
    # Validate all skills
    uv run scripts/validate-skills.py

    # Validate specific skill
    uv run scripts/validate-skills.py --skill libfuzzer

    # Output JSON for CI
    uv run scripts/validate-skills.py --json

    # Verbose output
    uv run scripts/validate-skills.py -v
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import yaml

# Configuration
MAX_LINES = 500
MAX_NAME_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 1024
RESERVED_WORDS = frozenset({"anthropic", "claude"})
VALID_SKILL_TYPES = frozenset({"tool", "fuzzer", "technique", "domain"})
NAME_PATTERN = re.compile(r"^[a-z0-9-]{1,64}$")
SHORTCODE_PATTERN = re.compile(r"\{\{[<%]")
ESCAPED_BACKTICKS_PATTERN = re.compile(r"\\`{3}")
HTML_TAG_PATTERN = re.compile(r"<[^>]+>")

# Required sections by skill type
REQUIRED_SECTIONS: dict[str, list[str]] = {
    "tool": ["When to Use", "Quick Reference", "Installation", "Core Workflow"],
    "fuzzer": ["When to Use", "Quick Start", "Writing a Harness", "Related Skills"],
    "technique": ["When to Apply", "Quick Reference", "Tool-Specific Guidance", "Related Skills"],
    "domain": ["Background", "Quick Reference", "Testing Workflow", "Related Skills"],
}

# Skill type detection patterns (from directory structure or content)
SKILL_TYPE_INDICATORS = {
    "fuzzer": ["fuzzing", "harness", "corpus", "sanitizer"],
    "technique": ["technique", "pattern", "apply", "tool-specific"],
    "domain": ["methodology", "workflow", "background", "domain"],
    "tool": [],  # Default fallback
}


@dataclass
class ValidationResult:
    """Result of validating a single skill."""

    skill_name: str
    skill_path: Path
    valid: bool = True
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    info: dict[str, str | int | list[str]] = field(default_factory=dict)

    def add_error(self, message: str) -> None:
        """Add an error and mark as invalid."""
        self.errors.append(message)
        self.valid = False

    def add_warning(self, message: str) -> None:
        """Add a warning (doesn't affect validity)."""
        self.warnings.append(message)

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON output."""
        return {
            "skill_name": self.skill_name,
            "skill_path": str(self.skill_path),
            "valid": self.valid,
            "errors": self.errors,
            "warnings": self.warnings,
            "info": self.info,
        }


@dataclass
class ValidationReport:
    """Aggregate report for all validated skills."""

    results: list[ValidationResult] = field(default_factory=list)
    total: int = 0
    passed: int = 0
    failed: int = 0
    with_warnings: int = 0

    def add_result(self, result: ValidationResult) -> None:
        """Add a validation result and update counts."""
        self.results.append(result)
        self.total += 1
        if result.valid:
            self.passed += 1
        else:
            self.failed += 1
        if result.warnings:
            self.with_warnings += 1

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON output."""
        return {
            "summary": {
                "total": self.total,
                "passed": self.passed,
                "failed": self.failed,
                "with_warnings": self.with_warnings,
            },
            "results": [r.to_dict() for r in self.results],
        }


def extract_frontmatter(content: str) -> tuple[dict | None, str | None]:
    """Extract YAML frontmatter from markdown content.

    Args:
        content: Full markdown file content.

    Returns:
        Tuple of (parsed YAML dict, error message if parsing failed).
    """
    lines = content.split("\n")
    if not lines or lines[0].strip() != "---":
        return None, "No frontmatter found (file must start with ---)"

    end_idx = None
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_idx = i
            break

    if end_idx is None:
        return None, "Frontmatter not closed (missing closing ---)"

    frontmatter_text = "\n".join(lines[1:end_idx])
    try:
        return yaml.safe_load(frontmatter_text), None
    except yaml.YAMLError as e:
        return None, f"YAML parse error: {e}"


def detect_skill_type(
    content: str,
    frontmatter: dict | None,
) -> Literal["tool", "fuzzer", "technique", "domain"]:
    """Detect skill type from content and frontmatter.

    Prefers explicit `type` field in frontmatter. Falls back to heuristics
    if not specified.

    Args:
        content: Full markdown content.
        frontmatter: Parsed frontmatter dict.

    Returns:
        Detected skill type.
    """
    # Prefer explicit type field in frontmatter (authoritative)
    if frontmatter:
        explicit_type = frontmatter.get("type")
        if explicit_type and str(explicit_type).lower() in VALID_SKILL_TYPES:
            return str(explicit_type).lower()  # type: ignore[return-value]

    # Fallback: infer from description keywords
    if frontmatter:
        desc = str(frontmatter.get("description", "")).lower()
        if "fuzzing" in desc or "fuzzer" in desc:
            return "fuzzer"
        if "technique" in desc or "pattern" in desc:
            return "technique"
        if "methodology" in desc or "domain" in desc:
            return "domain"

    # Fallback: infer from section headers
    content_lower = content.lower()
    if "## writing a harness" in content_lower or "## quick start" in content_lower:
        return "fuzzer"
    if "## tool-specific guidance" in content_lower or "## when to apply" in content_lower:
        return "technique"
    if "## background" in content_lower and "## testing workflow" in content_lower:
        return "domain"

    # Default to tool
    return "tool"


def validate_frontmatter(
    frontmatter: dict | None,
    result: ValidationResult,
) -> None:
    """Validate frontmatter fields.

    Args:
        frontmatter: Parsed frontmatter dict.
        result: ValidationResult to update.
    """
    if frontmatter is None:
        return  # Error already added during extraction

    # Validate name field
    name = frontmatter.get("name")
    if not name:
        result.add_error("Missing required field: name")
    else:
        name_str = str(name)
        result.info["name"] = name_str

        if not NAME_PATTERN.match(name_str):
            result.add_error(
                f"Invalid name '{name_str}': must be lowercase alphanumeric with hyphens, "
                f"max {MAX_NAME_LENGTH} chars"
            )

        if any(word in name_str.lower() for word in RESERVED_WORDS):
            result.add_error(f"Name contains reserved word: {name_str}")

        if HTML_TAG_PATTERN.search(name_str):
            result.add_error(f"Name contains HTML/XML tags: {name_str}")

    # Validate description field
    description = frontmatter.get("description")
    if not description:
        result.add_error("Missing required field: description")
    else:
        desc_str = str(description).strip()
        result.info["description_length"] = len(desc_str)

        if len(desc_str) > MAX_DESCRIPTION_LENGTH:
            result.add_error(
                f"Description too long: {len(desc_str)} chars (max {MAX_DESCRIPTION_LENGTH})"
            )

        if not re.search(r"Use (when|for)", desc_str, re.IGNORECASE):
            result.add_error("Description must include trigger phrase ('Use when' or 'Use for')")

        if HTML_TAG_PATTERN.search(desc_str):
            result.add_error("Description contains HTML/XML tags")

        if SHORTCODE_PATTERN.search(desc_str):
            result.add_error("Description contains Hugo shortcodes")

    # Validate type field (recommended but not strictly required for backwards compat)
    skill_type = frontmatter.get("type")
    if not skill_type:
        result.add_warning("Missing recommended field: type (tool|fuzzer|technique|domain)")
    else:
        type_str = str(skill_type).lower()
        result.info["explicit_type"] = type_str
        if type_str not in VALID_SKILL_TYPES:
            result.add_error(
                f"Invalid type '{skill_type}': must be one of {sorted(VALID_SKILL_TYPES)}"
            )


def validate_sections(
    content: str,
    skill_type: str,
    result: ValidationResult,
) -> None:
    """Validate required sections are present.

    Args:
        content: Full markdown content.
        skill_type: Detected skill type.
        result: ValidationResult to update.
    """
    required = REQUIRED_SECTIONS.get(skill_type, REQUIRED_SECTIONS["tool"])
    result.info["skill_type"] = skill_type
    result.info["required_sections"] = required

    # Find all H2 sections
    sections_found = re.findall(r"^## (.+)$", content, re.MULTILINE)
    result.info["sections_found"] = sections_found

    missing = []
    for section in required:
        # Check for exact match or case-insensitive match
        found = any(
            s.lower() == section.lower() or section.lower() in s.lower() for s in sections_found
        )
        if not found:
            missing.append(section)

    if missing:
        result.add_error(f"Missing required sections for {skill_type} skill: {missing}")


def validate_line_count(content: str, result: ValidationResult) -> None:
    """Validate line count is under limit.

    Args:
        content: Full markdown content.
        result: ValidationResult to update.
    """
    line_count = content.count("\n") + 1
    result.info["line_count"] = line_count

    if line_count >= MAX_LINES:
        result.add_error(f"Line count {line_count} exceeds limit of {MAX_LINES}")
    elif line_count >= MAX_LINES * 0.9:  # 90% threshold
        result.add_warning(f"Line count {line_count} approaching limit of {MAX_LINES}")


def validate_shortcodes(content: str, result: ValidationResult) -> None:
    """Check for remaining Hugo shortcodes.

    Args:
        content: Full markdown content.
        result: ValidationResult to update.
    """
    matches = SHORTCODE_PATTERN.findall(content)
    if matches:
        result.add_error(f"Found {len(matches)} Hugo shortcodes that should be stripped")

        # Find specific shortcodes for better error messages
        specific_patterns = [
            (r"\{\{<\s*hint", "hint"),
            (r"\{\{<\s*tabs", "tabs"),
            (r"\{\{<\s*tab\s", "tab"),
            (r"\{\{%\s*relref", "relref"),
            (r"\{\{<\s*customFigure", "customFigure"),
        ]
        found_types = []
        for pattern, name in specific_patterns:
            if re.search(pattern, content):
                found_types.append(name)
        if found_types:
            result.info["shortcode_types"] = found_types


def validate_escaped_backticks(content: str, result: ValidationResult) -> None:
    """Check for escaped backticks from templates.

    Templates use \\``` to show code blocks in examples. These should be
    unescaped to ``` in generated skills.

    Args:
        content: Full markdown content.
        result: ValidationResult to update.
    """
    matches = ESCAPED_BACKTICKS_PATTERN.findall(content)
    if matches:
        result.add_error(f"Found {len(matches)} escaped backticks (\\```) that should be unescaped")


def validate_internal_links(
    content: str,
    skill_path: Path,
    result: ValidationResult,
) -> None:
    """Validate internal markdown links resolve.

    Args:
        content: Full markdown content.
        skill_path: Path to the skill file.
        result: ValidationResult to update.
    """
    skill_dir = skill_path.parent

    # Find all markdown links [text](path)
    link_pattern = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
    broken_links = []

    for match in link_pattern.finditer(content):
        link_text, link_path = match.groups()

        # Skip external URLs
        if link_path.startswith(("http://", "https://", "mailto:")):
            continue

        # Skip anchor-only links
        if link_path.startswith("#"):
            continue

        # Handle relative paths
        target = skill_dir / link_path.split("#")[0]  # Remove anchor
        if not target.exists():
            broken_links.append(link_path)

    if broken_links:
        result.add_warning(f"Broken internal links: {broken_links}")


def validate_related_skills(
    content: str,
    skills_dir: Path,
    result: ValidationResult,
) -> None:
    """Validate referenced skills exist.

    Args:
        content: Full markdown content.
        skills_dir: Path to skills directory.
        result: ValidationResult to update.
    """
    # Find skill references in bold (e.g., **libfuzzer**)
    skill_refs = re.findall(r"\*\*([a-z0-9-]+)\*\*", content)
    skill_refs = list(set(skill_refs))  # Dedupe

    if not skill_refs:
        return

    result.info["referenced_skills"] = skill_refs

    # Check which exist (excluding the generator itself)
    existing_skills = {
        d.name
        for d in skills_dir.iterdir()
        if d.is_dir() and d.name != "testing-handbook-generator"
    }

    missing_refs = [ref for ref in skill_refs if ref not in existing_skills]

    if missing_refs:
        # This is a warning, not error - skills may be planned for future generation
        result.add_warning(f"Referenced skills not found (may be planned): {missing_refs}")


def validate_skill(
    skill_path: Path,
    skills_dir: Path,
    verbose: bool = False,
) -> ValidationResult:
    """Validate a single skill file.

    Args:
        skill_path: Path to SKILL.md file.
        skills_dir: Path to skills directory.
        verbose: Whether to print verbose output.

    Returns:
        ValidationResult with all findings.
    """
    skill_name = skill_path.parent.name
    result = ValidationResult(skill_name=skill_name, skill_path=skill_path)

    if verbose:
        print(f"Validating: {skill_name}")

    # Read file
    try:
        content = skill_path.read_text(encoding="utf-8")
    except Exception as e:
        result.add_error(f"Failed to read file: {e}")
        return result

    # Extract and validate frontmatter
    frontmatter, error = extract_frontmatter(content)
    if error:
        result.add_error(error)
    else:
        validate_frontmatter(frontmatter, result)

    # Detect skill type
    skill_type = detect_skill_type(content, frontmatter)

    # Run all validations
    validate_sections(content, skill_type, result)
    validate_line_count(content, result)
    validate_shortcodes(content, result)
    validate_escaped_backticks(content, result)
    validate_internal_links(content, skill_path, result)
    validate_related_skills(content, skills_dir, result)

    return result


def find_skills(skills_dir: Path, specific_skill: str | None = None) -> list[Path]:
    """Find all skill files to validate.

    Args:
        skills_dir: Path to skills directory.
        specific_skill: Optional specific skill name to validate.

    Returns:
        List of paths to SKILL.md files.
    """
    skills = []

    for item in skills_dir.iterdir():
        if not item.is_dir():
            continue

        # Skip the generator itself
        if item.name == "testing-handbook-generator":
            continue

        # If specific skill requested, only include that one
        if specific_skill and item.name != specific_skill:
            continue

        skill_file = item / "SKILL.md"
        if skill_file.exists():
            skills.append(skill_file)

    return sorted(skills)


def print_result(result: ValidationResult, verbose: bool = False) -> None:
    """Print validation result to console.

    Args:
        result: ValidationResult to print.
        verbose: Whether to print verbose info.
    """
    status = "✓" if result.valid else "✗"
    warning_indicator = " ⚠" if result.warnings else ""

    print(f"{status} {result.skill_name}{warning_indicator}")

    if result.errors:
        for error in result.errors:
            print(f"  ERROR: {error}")

    if result.warnings:
        for warning in result.warnings:
            print(f"  WARNING: {warning}")

    if verbose and result.info:
        print(
            f"  Info: lines={result.info.get('line_count', '?')}, "
            f"type={result.info.get('skill_type', '?')}"
        )


def print_report(report: ValidationReport, verbose: bool = False) -> None:
    """Print validation report to console.

    Args:
        report: ValidationReport to print.
        verbose: Whether to print verbose info.
    """
    print("\n" + "=" * 50)
    print("VALIDATION REPORT")
    print("=" * 50)

    for result in report.results:
        print_result(result, verbose)

    print("\n" + "-" * 50)
    print(f"Total:    {report.total}")
    print(f"Passed:   {report.passed}")
    print(f"Failed:   {report.failed}")
    print(f"Warnings: {report.with_warnings}")
    print("-" * 50)

    if report.failed == 0:
        print("✓ All skills passed validation")
    else:
        print(f"✗ {report.failed} skill(s) failed validation")


def main() -> int:
    """Main entry point.

    Returns:
        Exit code (0 for success, 1 for validation failures).
    """
    parser = argparse.ArgumentParser(
        description="Validate generated skills for testing-handbook-generator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--skill",
        "-s",
        help="Validate specific skill by name",
    )
    parser.add_argument(
        "--json",
        "-j",
        action="store_true",
        help="Output JSON report",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Verbose output",
    )
    parser.add_argument(
        "--skills-dir",
        type=Path,
        default=None,
        help="Path to skills directory (auto-detected if not specified)",
    )

    args = parser.parse_args()

    # Find skills directory
    if args.skills_dir:
        skills_dir = args.skills_dir
    else:
        # Auto-detect: look for skills directory relative to script
        # Script is in plugins/testing-handbook-skills/scripts/
        # Skills are in plugins/testing-handbook-skills/skills/
        script_dir = Path(__file__).parent.parent
        skills_dir = script_dir / "skills"
        if not skills_dir.exists():
            # Try from current working directory
            skills_dir = Path.cwd() / "skills"

    if not skills_dir.exists():
        print(f"ERROR: Skills directory not found: {skills_dir}", file=sys.stderr)
        return 1

    # Find skills to validate
    skill_files = find_skills(skills_dir, args.skill)

    if not skill_files:
        if args.skill:
            print(f"ERROR: Skill not found: {args.skill}", file=sys.stderr)
        else:
            print("No generated skills found to validate", file=sys.stderr)
        return 1

    # Validate all skills
    report = ValidationReport()
    for skill_path in skill_files:
        result = validate_skill(skill_path, skills_dir, args.verbose)
        report.add_result(result)

    # Output results
    if args.json:
        print(json.dumps(report.to_dict(), indent=2))
    else:
        print_report(report, args.verbose)

    return 0 if report.failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
