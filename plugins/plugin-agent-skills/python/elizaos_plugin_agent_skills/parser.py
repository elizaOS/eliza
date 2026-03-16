"""
Skill Parser

Parses and validates SKILL.md files according to the Agent Skills specification.

See: https://agentskills.io/specification
"""

from __future__ import annotations

import json
import re
from html import escape
from typing import Any, Dict, List, Optional, Tuple

from .types import (
    SKILL_COMPATIBILITY_MAX_LENGTH,
    SKILL_DESCRIPTION_MAX_LENGTH,
    SKILL_NAME_MAX_LENGTH,
    SKILL_NAME_PATTERN,
)


# ============================================================
# FRONTMATTER PARSING
# ============================================================


def parse_frontmatter(content: str) -> Dict[str, Any]:
    """
    Parse YAML frontmatter from SKILL.md content.

    Returns: dict with 'frontmatter' (dict or None), 'body' (str), 'raw' (str)
    """
    # Match frontmatter block
    match = re.match(r"^---\n([\s\S]*?)\n---\n?", content)

    if not match:
        return {"frontmatter": None, "body": content, "raw": ""}

    raw = match.group(1)
    body = content[match.end() :].strip()

    try:
        parsed = _parse_yaml_subset(raw)
        # Return dict instead of dataclass for consistency with storage.py usage
        return {"frontmatter": parsed, "body": body, "raw": raw}
    except Exception:
        return {"frontmatter": None, "body": body, "raw": raw}


def _parse_yaml_subset(yaml: str) -> Dict[str, Any]:
    """
    Parse a subset of YAML sufficient for skill frontmatter.
    Handles strings, numbers, booleans, nested objects, and embedded JSON.
    """
    result: Dict[str, Any] = {}
    lines = yaml.split("\n")
    stack: List[Tuple[Dict[str, Any], int]] = [(result, -1)]

    # Track multiline JSON parsing
    collecting_json = False
    json_buffer = ""
    json_depth = 0
    json_key = ""
    json_parent: Optional[Dict[str, Any]] = None

    i = 0
    while i < len(lines):
        line = lines[i]
        trimmed = line.strip()

        # If we're collecting a multiline JSON object
        if collecting_json:
            # Skip empty lines within JSON
            if not trimmed:
                i += 1
                continue

            json_buffer += trimmed

            # Count braces/brackets (ignoring those inside strings)
            in_string = False
            escape = False
            for char in trimmed:
                if escape:
                    escape = False
                    continue
                if char == "\\":
                    escape = True
                    continue
                if char == '"':
                    in_string = not in_string
                    continue
                if not in_string:
                    if char in "{[":
                        json_depth += 1
                    elif char in "}]":
                        json_depth -= 1

            # If we've closed all braces, parse the complete JSON
            if json_depth == 0:
                try:
                    # Remove trailing commas before ] or } (JSON5-style cleanup)
                    cleaned_json = re.sub(r",(\s*[}\]])", r"\1", json_buffer)
                    if json_parent is not None:
                        json_parent[json_key] = json.loads(cleaned_json)
                except json.JSONDecodeError:
                    # If JSON parse fails, store as string
                    if json_parent is not None:
                        json_parent[json_key] = json_buffer

                collecting_json = False
                json_buffer = ""
                json_key = ""
                json_parent = None

            i += 1
            continue

        # Skip empty lines and comments
        if not trimmed or trimmed.startswith("#"):
            i += 1
            continue

        # Calculate indentation
        indent = len(line) - len(line.lstrip())

        # Handle key-value pairs
        kv_match = re.match(r"^([a-zA-Z0-9_-]+):\s*(.*)", trimmed)
        if kv_match:
            key, value_str = kv_match.groups()

            # Pop stack until we find appropriate parent
            while len(stack) > 1 and stack[-1][1] >= indent:
                stack.pop()

            parent = stack[-1][0]

            if value_str == "" or value_str in ("|", ">"):
                # Could be object, multiline string, or multiline JSON
                # Check if next non-empty line starts with { or [
                next_idx = i + 1
                while next_idx < len(lines) and not lines[next_idx].strip():
                    next_idx += 1
                next_trimmed = lines[next_idx].strip() if next_idx < len(lines) else ""

                if next_trimmed.startswith("{") or next_trimmed.startswith("["):
                    # Multiline JSON - set up to collect it
                    json_key = key
                    json_parent = parent
                    json_buffer = ""
                    json_depth = 0
                    collecting_json = True
                else:
                    # Regular nested object
                    child_obj: Dict[str, Any] = {}
                    parent[key] = child_obj
                    stack.append((child_obj, indent))
            elif value_str.startswith("{") or value_str.startswith("["):
                # Could be inline JSON or start of multiline JSON
                # Count braces to determine (ignoring those inside strings)
                depth = 0
                in_string = False
                escape = False
                for char in value_str:
                    if escape:
                        escape = False
                        continue
                    if char == "\\":
                        escape = True
                        continue
                    if char == '"':
                        in_string = not in_string
                        continue
                    if not in_string:
                        if char in "{[":
                            depth += 1
                        elif char in "}]":
                            depth -= 1

                if depth == 0:
                    # Complete inline JSON
                    try:
                        cleaned_json = re.sub(r",(\s*[}\]])", r"\1", value_str)
                        parent[key] = json.loads(cleaned_json)
                    except json.JSONDecodeError:
                        parent[key] = value_str
                else:
                    # Start of multiline JSON
                    json_key = key
                    json_parent = parent
                    json_buffer = value_str
                    json_depth = depth
                    collecting_json = True
            else:
                # Simple value
                parent[key] = _parse_yaml_value(value_str)

        i += 1

    return result


def _parse_yaml_value(value: str) -> Any:
    """Parse a YAML scalar value."""
    trimmed = value.strip()

    # Handle quoted strings
    if (trimmed.startswith('"') and trimmed.endswith('"')) or (
        trimmed.startswith("'") and trimmed.endswith("'")
    ):
        return trimmed[1:-1]

    # Handle booleans
    if trimmed == "true":
        return True
    if trimmed == "false":
        return False

    # Handle null
    if trimmed in ("null", "~"):
        return None

    # Handle numbers
    if re.match(r"^-?\d+$", trimmed):
        return int(trimmed)
    if re.match(r"^-?\d+\.\d+$", trimmed):
        return float(trimmed)

    # Default to string
    return trimmed


# ============================================================
# VALIDATION
# ============================================================


def validate_frontmatter(
    frontmatter: Dict[str, Any], directory_name: Optional[str] = None
) -> Dict[str, Any]:
    """Validate a skill's frontmatter according to the Agent Skills specification."""
    errors: List[Dict[str, str]] = []
    warnings: List[Dict[str, str]] = []

    name = frontmatter.get("name", "")
    description = frontmatter.get("description", "")
    compatibility = frontmatter.get("compatibility")

    # Required: name
    if not name:
        errors.append(
            {"field": "name", "message": "name is required", "code": "MISSING_NAME"}
        )
    else:
        # Validate name format
        if len(name) > SKILL_NAME_MAX_LENGTH:
            errors.append(
                {
                    "field": "name",
                    "message": f"name must be {SKILL_NAME_MAX_LENGTH} characters or less",
                    "code": "NAME_TOO_LONG",
                }
            )

        if not SKILL_NAME_PATTERN.match(name):
            errors.append(
                {
                    "field": "name",
                    "message": "name must contain only lowercase letters, numbers, and hyphens",
                    "code": "INVALID_NAME_FORMAT",
                }
            )

        if name.startswith("-") or name.endswith("-"):
            errors.append(
                {
                    "field": "name",
                    "message": "name cannot start or end with a hyphen",
                    "code": "NAME_INVALID_HYPHEN",
                }
            )

        if "--" in name:
            errors.append(
                {
                    "field": "name",
                    "message": "name cannot contain consecutive hyphens",
                    "code": "NAME_CONSECUTIVE_HYPHENS",
                }
            )

        # Check directory name matches
        if directory_name and directory_name != name:
            errors.append(
                {
                    "field": "name",
                    "message": f'name "{name}" must match directory name "{directory_name}"',
                    "code": "NAME_MISMATCH",
                }
            )

    # Required: description
    if not description:
        errors.append(
            {
                "field": "description",
                "message": "description is required",
                "code": "MISSING_DESCRIPTION",
            }
        )
    else:
        if len(description) > SKILL_DESCRIPTION_MAX_LENGTH:
            errors.append(
                {
                    "field": "description",
                    "message": f"description must be {SKILL_DESCRIPTION_MAX_LENGTH} characters or less",
                    "code": "DESCRIPTION_TOO_LONG",
                }
            )

        if len(description) < 20:
            warnings.append(
                {
                    "field": "description",
                    "message": "description is very short; consider adding more detail",
                    "code": "DESCRIPTION_TOO_SHORT",
                }
            )

    # Optional: compatibility
    if compatibility:
        if len(compatibility) > SKILL_COMPATIBILITY_MAX_LENGTH:
            errors.append(
                {
                    "field": "compatibility",
                    "message": f"compatibility must be {SKILL_COMPATIBILITY_MAX_LENGTH} characters or less",
                    "code": "COMPATIBILITY_TOO_LONG",
                }
            )

    return {"valid": len(errors) == 0, "errors": errors, "warnings": warnings}


def validate_skill_directory(
    path: str, content: str, directory_name: str
) -> Dict[str, Any]:
    """Validate a complete skill directory."""
    errors: List[Dict[str, str]] = []
    warnings: List[Dict[str, str]] = []

    result = parse_frontmatter(content)
    frontmatter = result.get("frontmatter")

    if not frontmatter:
        errors.append(
            {
                "field": "frontmatter",
                "message": "SKILL.md must have valid YAML frontmatter",
                "code": "MISSING_FRONTMATTER",
            }
        )
        return {"valid": False, "errors": errors, "warnings": warnings}

    fm_result = validate_frontmatter(frontmatter, directory_name)
    errors.extend(fm_result.get("errors", []))
    warnings.extend(fm_result.get("warnings", []))

    return {"valid": len(errors) == 0, "errors": errors, "warnings": warnings}


# ============================================================
# SKILL BODY EXTRACTION
# ============================================================


def extract_body(content: str) -> str:
    """Extract the body (instructions) from SKILL.md content."""
    result = parse_frontmatter(content)
    return result.get("body", content)


def estimate_tokens(text: str) -> int:
    """Estimate token count for text (~4 characters per token)."""
    return len(text) // 4


# ============================================================
# PROMPT XML GENERATION
# ============================================================


def generate_skills_xml(
    skills: List[Dict[str, str]], include_location: bool = True
) -> str:
    """
    Generate XML for skill metadata to include in agent prompts.

    Format follows Claude's recommended skill prompt structure.
    """
    if not skills:
        return ""

    skill_elements = []
    for skill in skills:
        location_tag = ""
        if include_location and skill.get("location"):
            location_tag = f"\n    <location>{escape(skill['location'])}</location>"

        element = f"""  <skill>
    <name>{escape(skill.get('name', ''))}</name>
    <description>{escape(skill.get('description', ''))}</description>{location_tag}
  </skill>"""
        skill_elements.append(element)

    return f"""<available_skills>
{chr(10).join(skill_elements)}
</available_skills>"""
