# /// script
# requires-python = ">=3.11"
# dependencies = ["yara-x>=0.10.0"]
# ///
"""YARA-X string atom quality analyzer.

Analyzes strings for efficient atom extraction, identifying patterns that
will cause poor scanning performance. Uses yara-x for rule validation.

Usage:
    uv run atom_analyzer.py rule.yar
    uv run atom_analyzer.py --verbose rule.yar
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import yara_x

if TYPE_CHECKING:
    from collections.abc import Iterator


@dataclass
class AtomIssue:
    """An issue with atom quality."""

    string_id: str
    severity: str  # error, warning, info
    message: str
    suggestion: str | None = None


@dataclass
class StringAnalysis:
    """Analysis of a single string's atom quality."""

    string_id: str
    string_type: str
    raw_value: str
    byte_count: int
    issues: list[AtomIssue]
    best_atom: str | None = None


# Repeated byte patterns that generate poor atoms
REPEATED_PATTERNS = [
    (rb"\x00\x00\x00\x00", "null bytes (0x00000000)"),
    (rb"\x90\x90\x90\x90", "NOP sled (0x90909090)"),
    (rb"\xCC\xCC\xCC\xCC", "INT3 padding (0xCCCCCCCC)"),
    (rb"\xFF\xFF\xFF\xFF", "all 0xFF bytes"),
    (rb"\x20\x20\x20\x20", "spaces (0x20202020)"),
]

# Common 4-byte sequences that appear in many files
COMMON_SEQUENCES = [
    b"This",  # "This program..."
    b"prog",
    b"MODE",
    b"rich",  # Rich header
    b".tex",  # Section names
    b".dat",
    b".rsr",
    b"MZ\x90\x00",  # Standard MZ header
    b"http",
    b"HTTP",
]


def hex_string_to_bytes(hex_str: str) -> tuple[bytes, list[int]]:
    """Convert YARA hex string to bytes and wildcard positions.

    Returns:
        Tuple of (bytes with wildcards as 0x00, list of wildcard positions)
    """
    # Remove braces and normalize
    hex_str = hex_str.strip().strip("{}").strip()

    # Parse hex bytes
    result = bytearray()
    wildcard_positions = []

    tokens = hex_str.split()
    pos = 0

    for token in tokens:
        if token == "??":
            result.append(0x00)
            wildcard_positions.append(pos)
            pos += 1
        elif re.match(r"^[0-9A-Fa-f]{2}$", token):
            result.append(int(token, 16))
            pos += 1
        elif re.match(r"^[0-9A-Fa-f?]{2}$", token):
            # Nibble wildcard like "5?" or "?A"
            result.append(0x00)
            wildcard_positions.append(pos)
            pos += 1
        # Skip jumps and alternatives for simplicity

    return bytes(result), wildcard_positions


def find_best_atom(data: bytes, wildcard_positions: list[int]) -> tuple[str | None, int]:
    """Find the best 4-byte atom in a byte sequence.

    Returns:
        Tuple of (atom as hex string, score 0-100)
    """
    if len(data) < 4:
        return None, 0

    best_atom = None
    best_score = 0

    for i in range(len(data) - 3):
        # Skip if any byte in this window is a wildcard
        if any(p in range(i, i + 4) for p in wildcard_positions):
            continue

        atom = data[i : i + 4]
        score = score_atom(atom)

        if score > best_score:
            best_score = score
            best_atom = atom.hex().upper()

    return best_atom, best_score


def score_atom(atom: bytes) -> int:
    """Score a 4-byte atom for quality (0-100)."""
    if len(atom) != 4:
        return 0

    score = 100

    # Penalize repeated bytes
    if len(set(atom)) == 1:
        score -= 80  # All same byte
    elif len(set(atom)) == 2:
        score -= 40  # Only 2 unique bytes

    # Penalize null bytes
    null_count = atom.count(0x00)
    score -= null_count * 15

    # Penalize known common patterns
    for pattern, _ in REPEATED_PATTERNS:
        if pattern in atom:
            score -= 60
            break

    # Penalize common sequences
    for seq in COMMON_SEQUENCES:
        if seq in atom:
            score -= 30
            break

    # Penalize printable ASCII-only (less unique)
    if all(0x20 <= b <= 0x7E for b in atom):
        score -= 10

    return max(0, score)


def analyze_text_string(string_id: str, value: str, modifiers: list[str]) -> StringAnalysis:
    """Analyze a text string for atom quality."""
    issues = []

    byte_count = len(value)

    # Check minimum length
    if byte_count < 4:
        issues.append(
            AtomIssue(
                string_id=string_id,
                severity="error",
                message=f"String is only {byte_count} bytes; no valid 4-byte atom possible",
                suggestion="Use a longer string (4+ bytes minimum)",
            )
        )
        return StringAnalysis(
            string_id=string_id,
            string_type="text",
            raw_value=value,
            byte_count=byte_count,
            issues=issues,
        )

    # YARA-X specific: base64 modifier requires 3+ chars
    if "base64" in modifiers and byte_count < 3:
        issues.append(
            AtomIssue(
                string_id=string_id,
                severity="error",
                message=f"String uses 'base64' but is only {byte_count} chars; "
                "YARA-X requires 3+ characters for base64 modifier",
                suggestion="Use a string of 3+ characters with base64 modifier",
            )
        )

    # Convert to bytes for analysis
    try:
        data = value.encode("utf-8")
    except UnicodeEncodeError:
        data = value.encode("latin-1")

    best_atom, score = find_best_atom(data, [])

    # Check score
    if score < 30:
        issues.append(
            AtomIssue(
                string_id=string_id,
                severity="error",
                message=f"Best atom score is {score}/100; string will cause slow scanning",
                suggestion="Choose a more unique string or add distinguishing bytes",
            )
        )
    elif score < 60:
        issues.append(
            AtomIssue(
                string_id=string_id,
                severity="warning",
                message=f"Best atom score is {score}/100; may cause performance issues",
            )
        )

    # Check modifiers
    if "nocase" in modifiers and byte_count > 15:
        issues.append(
            AtomIssue(
                string_id=string_id,
                severity="info",
                message="'nocase' on long string doubles atom generation",
                suggestion="Consider if case-insensitivity is truly needed",
            )
        )

    if "wide" in modifiers and "ascii" in modifiers:
        issues.append(
            AtomIssue(
                string_id=string_id,
                severity="info",
                message="'wide ascii' doubles matching; ensure both encodings are needed",
            )
        )

    return StringAnalysis(
        string_id=string_id,
        string_type="text",
        raw_value=value,
        byte_count=byte_count,
        issues=issues,
        best_atom=best_atom,
    )


def analyze_hex_string(string_id: str, value: str) -> StringAnalysis:
    """Analyze a hex string for atom quality."""
    issues = []

    data, wildcard_positions = hex_string_to_bytes(value)
    byte_count = len(data)

    # Check minimum length
    if byte_count < 4:
        issues.append(
            AtomIssue(
                string_id=string_id,
                severity="error",
                message=f"Hex string is only {byte_count} bytes; no valid 4-byte atom possible",
                suggestion="Use a longer hex pattern (4+ bytes minimum)",
            )
        )
        return StringAnalysis(
            string_id=string_id,
            string_type="byte",
            raw_value=value,
            byte_count=byte_count,
            issues=issues,
        )

    # Check for leading wildcards
    if 0 in wildcard_positions and 1 in wildcard_positions:
        issues.append(
            AtomIssue(
                string_id=string_id,
                severity="warning",
                message="Hex string starts with wildcards; atoms will be extracted from middle/end",
                suggestion="Move fixed bytes to the beginning if possible",
            )
        )

    # Check wildcard density
    if wildcard_positions:
        wildcard_ratio = len(wildcard_positions) / byte_count
        if wildcard_ratio > 0.5:
            issues.append(
                AtomIssue(
                    string_id=string_id,
                    severity="warning",
                    message=f"High wildcard density ({wildcard_ratio:.0%}); may limit atom options",
                )
            )

    best_atom, score = find_best_atom(data, wildcard_positions)

    if best_atom is None:
        issues.append(
            AtomIssue(
                string_id=string_id,
                severity="error",
                message="No valid 4-byte atom found (too many wildcards)",
                suggestion="Reduce wildcards or add fixed byte sequences",
            )
        )
    elif score < 30:
        issues.append(
            AtomIssue(
                string_id=string_id,
                severity="error",
                message=f"Best atom score is {score}/100; string will cause slow scanning",
            )
        )
    elif score < 60:
        issues.append(
            AtomIssue(
                string_id=string_id,
                severity="warning",
                message=f"Best atom score is {score}/100; may cause performance issues",
            )
        )

    return StringAnalysis(
        string_id=string_id,
        string_type="byte",
        raw_value=value,
        byte_count=byte_count,
        issues=issues,
        best_atom=best_atom,
    )


def extract_strings(content: str, rule_name: str) -> list[dict]:
    """Extract strings from a rule using regex."""
    strings = []

    # Find the rule block
    rule_pattern = rf"rule\s+{re.escape(rule_name)}\s*\{{"
    rule_match = re.search(rule_pattern, content)
    if not rule_match:
        return strings

    # Find strings section
    start = rule_match.end()
    brace_count = 1
    pos = start
    while pos < len(content) and brace_count > 0:
        if content[pos] == "{":
            brace_count += 1
        elif content[pos] == "}":
            brace_count -= 1
        pos += 1

    rule_content = content[start : pos - 1]

    strings_match = re.search(r"strings\s*:\s*(.*?)(?=condition\s*:|$)", rule_content, re.DOTALL)
    if not strings_match:
        return strings

    strings_section = strings_match.group(1)

    # Parse text strings: $name = "value" modifiers
    for match in re.finditer(r'(\$\w+)\s*=\s*"([^"]*)"([^\n]*)', strings_section):
        modifiers = match.group(3).strip().split()
        strings.append(
            {
                "name": match.group(1),
                "value": match.group(2),
                "type": "text",
                "modifiers": modifiers,
            }
        )

    # Parse hex strings: $name = { hex }
    for match in re.finditer(r"(\$\w+)\s*=\s*\{([^}]*)\}", strings_section):
        strings.append(
            {
                "name": match.group(1),
                "value": match.group(2).strip(),
                "type": "byte",
                "modifiers": [],
            }
        )

    # Parse regex strings: $name = /pattern/ modifiers
    for match in re.finditer(r"(\$\w+)\s*=\s*/([^/]*)/([^\n]*)", strings_section):
        modifiers = match.group(3).strip().split()
        strings.append(
            {
                "name": match.group(1),
                "value": match.group(2),
                "type": "regex",
                "modifiers": modifiers,
            }
        )

    return strings


def extract_rule_names(content: str) -> list[str]:
    """Extract rule names from YARA source."""
    return re.findall(r"(?:private\s+)?rule\s+(\w+)\s*[:{]", content)


def analyze_rule(rule_name: str, content: str) -> Iterator[StringAnalysis]:
    """Analyze all strings in a rule."""
    strings = extract_strings(content, rule_name)

    for string in strings:
        string_id = string.get("name", "$unknown")
        string_value = string.get("value", "")
        string_type = string.get("type", "text")
        modifiers = string.get("modifiers", [])

        if string_type == "text":
            yield analyze_text_string(string_id, string_value, modifiers)
        elif string_type == "byte":
            yield analyze_hex_string(string_id, string_value)
        # Regex strings are harder to analyze for atoms; skip for now


def analyze_file(file_path: Path, *, verbose: bool = False) -> int:
    """Analyze a YARA file and print results."""
    try:
        content = file_path.read_text()
    except OSError as e:
        print(f"Error reading {file_path}: {e}", file=sys.stderr)
        return 1

    # Validate with yara-x first
    try:
        compiler = yara_x.Compiler()
        compiler.add_source(content)
        compiler.build()
    except yara_x.CompileError as e:
        print(f"\033[91mYARA-X compilation error in {file_path}:\033[0m {e}", file=sys.stderr)
        # Continue with analysis anyway for educational purposes

    rule_names = extract_rule_names(content)
    has_issues = False

    for rule_name in rule_names:
        analyses = list(analyze_rule(rule_name, content))

        rule_has_issues = any(a.issues for a in analyses)
        if rule_has_issues or verbose:
            print(f"\n\033[1m{rule_name}\033[0m")

        for analysis in analyses:
            if not analysis.issues and not verbose:
                continue

            has_issues = has_issues or bool(analysis.issues)

            if verbose:
                atom_info = f" [atom: {analysis.best_atom}]" if analysis.best_atom else ""
                print(f"  {analysis.string_id}: {analysis.byte_count} bytes{atom_info}")

            for issue in analysis.issues:
                if issue.severity == "error":
                    color = "\033[91m"
                elif issue.severity == "warning":
                    color = "\033[93m"
                else:
                    color = "\033[94m"

                print(f"    {color}{issue.severity.upper()}\033[0m: {issue.message}")
                if issue.suggestion:
                    print(f"           Suggestion: {issue.suggestion}")

    if not has_issues:
        print(f"\n✓ All strings in {file_path} have good atom quality")
        return 0

    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="YARA-X string atom quality analyzer")
    parser.add_argument("path", type=Path, help="YARA file to analyze")
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="Show all strings, not just issues"
    )
    args = parser.parse_args()

    if not args.path.exists():
        print(f"Error: {args.path} does not exist", file=sys.stderr)
        return 1

    if args.path.is_file():
        return analyze_file(args.path, verbose=args.verbose)
    elif args.path.is_dir():
        exit_code = 0
        for yar_file in args.path.rglob("*.yar"):
            if analyze_file(yar_file, verbose=args.verbose) != 0:
                exit_code = 1
        for yar_file in args.path.rglob("*.yara"):
            if analyze_file(yar_file, verbose=args.verbose) != 0:
                exit_code = 1
        return exit_code
    else:
        print(f"Error: {args.path} is not a file or directory", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
