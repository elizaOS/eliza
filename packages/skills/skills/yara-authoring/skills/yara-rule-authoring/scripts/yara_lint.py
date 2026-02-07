# /// script
# requires-python = ">=3.11"
# dependencies = ["yara-x>=0.10.0"]
# ///
"""YARA-X rule linter for style, metadata, compatibility, and common anti-patterns.

Uses the yara-x Python package for actual rule validation, ensuring rules are
compatible with YARA-X before deployment.

Usage:
    uv run yara_lint.py rule.yar
    uv run yara_lint.py --json rules/
    uv run yara_lint.py --strict rule.yar
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path
from typing import TYPE_CHECKING

import yara_x

if TYPE_CHECKING:
    from collections.abc import Iterator


@dataclass
class Issue:
    """A linting issue."""

    rule: str
    severity: str  # error, warning, info
    code: str
    message: str
    line: int | None = None

    def to_dict(self) -> dict:
        return {
            "rule": self.rule,
            "severity": self.severity,
            "code": self.code,
            "message": self.message,
            "line": self.line,
        }


@dataclass
class LintResult:
    """Result of linting a file."""

    file: str
    issues: list[Issue] = field(default_factory=list)
    parse_error: str | None = None

    @property
    def error_count(self) -> int:
        return sum(1 for i in self.issues if i.severity == "error")

    @property
    def warning_count(self) -> int:
        return sum(1 for i in self.issues if i.severity == "warning")


# Naming convention patterns
VALID_CATEGORY_PREFIXES = frozenset(
    {
        "MAL",
        "HKTL",
        "WEBSHELL",
        "EXPL",
        "VULN",
        "SUSP",
        "PUA",
        "GEN",
        "APT",
        "CRIME",
        "RANSOM",
        "RAT",
        "MINER",
        "STEALER",
        "LOADER",
        "C2",
    }
)

VALID_PLATFORM_INDICATORS = frozenset(
    {
        "Win",
        "Lnx",
        "Mac",
        "Android",
        "iOS",
        "Multi",
        "PE",
        "ELF",
        "PS",
        "DOC",
        "PDF",
        "JAR",
        "CRX",
    }
)

# Common FP-prone strings to warn about
FP_PRONE_STRINGS = frozenset(
    {
        "cmd.exe",
        "powershell.exe",
        "explorer.exe",
        "notepad.exe",
        "VirtualAlloc",
        "VirtualProtect",
        "CreateRemoteThread",
        "WriteProcessMemory",
        "ReadProcessMemory",
        "NtCreateThread",
        "KERNEL32.dll",
        "ntdll.dll",
        "USER32.dll",
        "ADVAPI32.dll",
        "C:\\Windows",
        "C:\\Windows\\System32",
        "%s",
        "%d",
        "%x",
        "%08x",
        "http://",
        "https://",
    }
)

# Deprecated features
DEPRECATED_PATTERNS = {
    "entrypoint": "Use pe.entry_point instead of deprecated entrypoint",
    "PEiD": "PEiD-style signatures are obsolete; use modern detection",
}


def check_naming_convention(rule_name: str) -> Iterator[Issue]:
    """Check if rule name follows the style guide convention."""
    parts = rule_name.split("_")

    if len(parts) < 3:
        yield Issue(
            rule=rule_name,
            severity="warning",
            code="W001",
            message=f"Rule name '{rule_name}' should follow CATEGORY_PLATFORM_FAMILY_DATE format",
        )
        return

    # Check category prefix
    if parts[0] not in VALID_CATEGORY_PREFIXES:
        valid = ", ".join(sorted(VALID_CATEGORY_PREFIXES))
        yield Issue(
            rule=rule_name,
            severity="info",
            code="I001",
            message=f"Unrecognized category prefix '{parts[0]}'; expected one of: {valid}",
        )


def extract_metadata(content: str, rule_name: str) -> dict[str, str]:
    """Extract metadata from a rule using regex (since yara-x doesn't expose parsed AST)."""
    metadata = {}

    # Find the rule block
    rule_pattern = rf"rule\s+{re.escape(rule_name)}\s*\{{"
    rule_match = re.search(rule_pattern, content)
    if not rule_match:
        return metadata

    # Find meta: section within the rule
    start = rule_match.end()
    # Find matching closing brace
    brace_count = 1
    pos = start
    while pos < len(content) and brace_count > 0:
        if content[pos] == "{":
            brace_count += 1
        elif content[pos] == "}":
            brace_count -= 1
        pos += 1

    rule_content = content[start : pos - 1]

    # Extract meta section
    pattern = r"meta\s*:\s*(.*?)(?=strings\s*:|condition\s*:|$)"
    meta_match = re.search(pattern, rule_content, re.DOTALL)
    if meta_match:
        meta_section = meta_match.group(1)
        # Parse key = "value" pairs
        for match in re.finditer(r'(\w+)\s*=\s*"([^"]*)"', meta_section):
            metadata[match.group(1)] = match.group(2)

    return metadata


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


def check_metadata(rule_name: str, metadata: dict[str, str]) -> Iterator[Issue]:
    """Check for required and well-formed metadata."""
    # Required fields
    required = ["description", "author", "date"]
    for field_name in required:
        if field_name not in metadata:
            yield Issue(
                rule=rule_name,
                severity="error",
                code="E001",
                message=f"Missing required metadata field: {field_name}",
            )

    # Description checks
    if "description" in metadata:
        desc = metadata["description"]
        if not desc.startswith("Detects"):
            yield Issue(
                rule=rule_name,
                severity="warning",
                code="W002",
                message="Description should start with 'Detects'",
            )
        if len(desc) < 60:
            yield Issue(
                rule=rule_name,
                severity="warning",
                code="W003",
                message=f"Description too short ({len(desc)} chars); aim for 60-400 characters",
            )
        if len(desc) > 400:
            yield Issue(
                rule=rule_name,
                severity="info",
                code="I002",
                message=f"Description quite long ({len(desc)} chars); consider trimming to <400",
            )

    # Reference check
    if "reference" not in metadata:
        yield Issue(
            rule=rule_name,
            severity="warning",
            code="W004",
            message="Missing 'reference' metadata; add URL to analysis or source",
        )


def check_strings(rule_name: str, strings: list[dict]) -> Iterator[Issue]:
    """Check strings for anti-patterns and quality issues."""
    for string in strings:
        string_id = string.get("name", "unknown")
        string_value = string.get("value", "")
        string_type = string.get("type", "text")
        modifiers = string.get("modifiers", [])

        # Check string length (text strings)
        if string_type == "text":
            if len(string_value) < 4:
                yield Issue(
                    rule=rule_name,
                    severity="error",
                    code="E002",
                    message=f"String {string_id} is only {len(string_value)} bytes; "
                    "minimum 4 bytes for good atoms",
                )

            # Check for FP-prone strings
            for fp_string in FP_PRONE_STRINGS:
                if fp_string.lower() in string_value.lower():
                    yield Issue(
                        rule=rule_name,
                        severity="warning",
                        code="W005",
                        message=f"String {string_id} contains FP-prone pattern '{fp_string}'",
                    )

            # YARA-X specific: base64 modifier requires 3+ chars
            if "base64" in modifiers and len(string_value) < 3:
                yield Issue(
                    rule=rule_name,
                    severity="error",
                    code="E006",
                    message=f"String {string_id} uses 'base64' but is only {len(string_value)} "
                    "chars; YARA-X requires 3+ characters for base64 modifier",
                )

        # Check hex strings
        if string_type == "byte":
            hex_value = string_value
            # Count actual bytes (excluding wildcards and spaces)
            byte_count = len(re.findall(r"[0-9A-Fa-f]{2}", hex_value))
            if byte_count < 4:
                yield Issue(
                    rule=rule_name,
                    severity="error",
                    code="E003",
                    message=f"Hex string {string_id} has only {byte_count} bytes; "
                    "minimum 4 for good atoms",
                )

            # Check for too many wildcards at start
            if re.match(r"^\s*\?\?", hex_value):
                yield Issue(
                    rule=rule_name,
                    severity="warning",
                    code="W006",
                    message=f"Hex string {string_id} starts with wildcard; "
                    "move fixed bytes first for better atoms",
                )

        # Check regex strings for YARA-X compatibility issues
        if string_type == "regex":
            # Check for unescaped { in regex (YARA-X strict mode)
            if re.search(r"(?<!\\)\{(?![0-9])", string_value):
                yield Issue(
                    rule=rule_name,
                    severity="error",
                    code="E007",
                    message=f"Regex {string_id} has unescaped '{{'; "
                    "YARA-X requires escaping as '\\{{'",
                )

            # Check for unbounded regex
            if re.search(r"(?<!\\)\.\*(?!\?)", string_value) or re.search(
                r"(?<!\\)\.\+(?!\?)", string_value
            ):
                yield Issue(
                    rule=rule_name,
                    severity="warning",
                    code="W008",
                    message=f"Regex {string_id} has unbounded quantifier (.*/.+); "
                    "use bounded quantifiers {{1,N}}",
                )


def check_string_modifiers(rule_name: str, strings: list[dict]) -> Iterator[Issue]:
    """Check string modifiers for performance concerns."""
    for string in strings:
        string_id = string.get("name", "unknown")
        modifiers = string.get("modifiers", [])
        value = string.get("value", "")

        # nocase on long strings
        if "nocase" in modifiers and len(value) > 20:
            yield Issue(
                rule=rule_name,
                severity="info",
                code="I003",
                message=f"String {string_id} uses 'nocase' on long string; performance impact",
            )

        # xor without range
        if "xor" in modifiers and not any("xor(" in str(m) for m in modifiers):
            yield Issue(
                rule=rule_name,
                severity="info",
                code="I004",
                message=f"String {string_id} uses 'xor' without range; generates 255 patterns",
            )


def check_condition(rule_name: str, content: str) -> Iterator[Issue]:
    """Check condition for performance and deprecated features."""
    # Find the rule's condition
    rule_pattern = rf"rule\s+{re.escape(rule_name)}\s*\{{"
    rule_match = re.search(rule_pattern, content)
    if not rule_match:
        return

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

    condition_match = re.search(r"condition\s*:\s*(.*)", rule_content, re.DOTALL)
    if not condition_match:
        return

    condition_str = condition_match.group(1).strip()

    # Check for deprecated features
    for pattern, message in DEPRECATED_PATTERNS.items():
        if pattern.lower() in condition_str.lower():
            yield Issue(
                rule=rule_name,
                severity="warning",
                code="W007",
                message=message,
            )

    # Check for negative array indexing (not supported in YARA-X)
    if re.search(r"@\w+\s*\[\s*-\d+\s*\]", condition_str):
        yield Issue(
            rule=rule_name,
            severity="error",
            code="E008",
            message="Negative array indexing (e.g., @a[-1]) not supported in YARA-X; "
            "use @a[#a - 1] instead",
        )


def extract_rule_names(content: str) -> list[str]:
    """Extract rule names from YARA source."""
    return re.findall(r"(?:private\s+)?rule\s+(\w+)\s*[:{]", content)


def lint_file(file_path: Path) -> LintResult:
    """Lint a YARA file using yara-x for validation."""
    result = LintResult(file=str(file_path))

    try:
        content = file_path.read_text()
    except OSError as e:
        result.parse_error = f"Cannot read file: {e}"
        return result

    # First, try to compile with yara-x to catch syntax/compatibility errors
    try:
        compiler = yara_x.Compiler()
        compiler.add_source(content)
        compiler.build()
    except yara_x.CompileError as e:
        # Extract useful information from the error
        error_msg = str(e)
        result.issues.append(
            Issue(
                rule="(compilation)",
                severity="error",
                code="E000",
                message=f"YARA-X compilation error: {error_msg}",
            )
        )
        # Still try to do style checks even if compilation fails

    # Extract rule names and perform style checks
    rule_names = extract_rule_names(content)

    for rule_name in rule_names:
        result.issues.extend(check_naming_convention(rule_name))

        metadata = extract_metadata(content, rule_name)
        result.issues.extend(check_metadata(rule_name, metadata))

        strings = extract_strings(content, rule_name)
        result.issues.extend(check_strings(rule_name, strings))
        result.issues.extend(check_string_modifiers(rule_name, strings))

        result.issues.extend(check_condition(rule_name, content))

    return result


def lint_directory(dir_path: Path) -> list[LintResult]:
    """Lint all YARA files in a directory."""
    results = []
    for yar_file in dir_path.rglob("*.yar"):
        results.append(lint_file(yar_file))
    for yar_file in dir_path.rglob("*.yara"):
        results.append(lint_file(yar_file))
    return results


def format_result(result: LintResult, *, use_color: bool = True) -> str:
    """Format a lint result for terminal output."""
    lines = []

    if use_color:
        red = "\033[91m"
        yellow = "\033[93m"
        blue = "\033[94m"
        reset = "\033[0m"
        bold = "\033[1m"
    else:
        red = yellow = blue = reset = bold = ""

    if result.parse_error:
        lines.append(f"{bold}{result.file}{reset}")
        lines.append(f"  {red}ERROR{reset}: {result.parse_error}")
        return "\n".join(lines)

    if not result.issues:
        return ""

    lines.append(f"{bold}{result.file}{reset}")

    for issue in result.issues:
        if issue.severity == "error":
            color = red
        elif issue.severity == "warning":
            color = yellow
        else:
            color = blue

        severity_upper = issue.severity.upper()
        line_info = f":{issue.line}" if issue.line else ""
        msg = f"  {color}{severity_upper}{reset} [{issue.code}] "
        msg += f"{issue.rule}{line_info}: {issue.message}"
        lines.append(msg)

    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="YARA-X rule linter")
    parser.add_argument("path", type=Path, help="File or directory to lint")
    parser.add_argument("--json", action="store_true", help="Output JSON format")
    parser.add_argument("--strict", action="store_true", help="Treat warnings as errors")
    parser.add_argument("--no-color", action="store_true", help="Disable colored output")
    args = parser.parse_args()

    if args.path.is_file():
        results = [lint_file(args.path)]
    elif args.path.is_dir():
        results = lint_directory(args.path)
    else:
        print(f"Error: {args.path} does not exist", file=sys.stderr)
        return 1

    if args.json:
        output = {
            "results": [
                {
                    "file": r.file,
                    "parse_error": r.parse_error,
                    "issues": [i.to_dict() for i in r.issues],
                }
                for r in results
            ]
        }
        print(json.dumps(output, indent=2))
    else:
        use_color = not args.no_color and sys.stdout.isatty()
        for result in results:
            formatted = format_result(result, use_color=use_color)
            if formatted:
                print(formatted)
                print()

    # Calculate exit code
    total_errors = sum(r.error_count for r in results)
    total_warnings = sum(r.warning_count for r in results)
    parse_errors = sum(1 for r in results if r.parse_error)

    if parse_errors > 0 or total_errors > 0:
        return 1
    if args.strict and total_warnings > 0:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
