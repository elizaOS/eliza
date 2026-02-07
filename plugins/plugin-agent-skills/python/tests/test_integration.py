"""
Integration Tests with Anthropic API

These tests verify that skills work end-to-end with a real Anthropic API.
They load real Otto skills, format them for prompt injection, and verify
the agent can understand and use the skill instructions.

Run with: ANTHROPIC_API_KEY=your-key pytest tests/test_integration.py -v
"""

import json
import os
import re
from pathlib import Path
from typing import Optional

import pytest

# Check for API key
API_KEY = os.environ.get("ANTHROPIC_API_KEY")
SKIP_REASON = "ANTHROPIC_API_KEY not set"

# Path to real skills
SCRIPT_DIR = Path(__file__).parent
OTTO_SKILLS_PATH = SCRIPT_DIR.parent.parent.parent.parent / "otto" / "skills"


# ============================================================
# PARSER FUNCTIONS (inline to avoid import issues)
# ============================================================


FRONTMATTER_REGEX = re.compile(r"^---\n([\s\S]*?)\n---\n?")


def _parse_yaml_value(value: str):
    """Parse a simple YAML value."""
    if value in ("true", "True"):
        return True
    if value in ("false", "False"):
        return False
    if value in ("null", "~", ""):
        return None
    if value.startswith('"') and value.endswith('"'):
        return value[1:-1]
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1]
    try:
        if "." in value:
            return float(value)
        return int(value)
    except ValueError:
        return value


def _count_depth_outside_strings(text: str) -> int:
    """Count brace/bracket depth ignoring those inside strings."""
    depth = 0
    in_string = False
    string_char = None
    i = 0
    while i < len(text):
        c = text[i]
        if in_string:
            if c == "\\" and i + 1 < len(text):
                i += 2
                continue
            if c == string_char:
                in_string = False
        else:
            if c in ('"', "'"):
                in_string = True
                string_char = c
            elif c in ("{", "["):
                depth += 1
            elif c in ("}", "]"):
                depth -= 1
        i += 1
    return depth


def _parse_yaml_subset(yaml_str: str) -> dict:
    """Parse a subset of YAML that can contain multiline JSON values."""
    result = {}
    stack = [(result, -1)]
    lines = yaml_str.split("\n")

    collecting_json = False
    json_buffer = []
    json_depth = 0
    json_key = ""
    json_parent = result

    i = 0
    while i < len(lines):
        line = lines[i]
        trimmed = line.strip()

        if collecting_json:
            json_buffer.append(line)
            json_depth += _count_depth_outside_strings(trimmed)

            if json_depth == 0:
                json_str = "\n".join(json_buffer)
                cleaned_json = re.sub(r",(\s*[\}\]])", r"\1", json_str)
                try:
                    json_parent[json_key] = json.loads(cleaned_json)
                except json.JSONDecodeError:
                    json_parent[json_key] = json_str.strip()
                collecting_json = False
                json_buffer = []
            i += 1
            continue

        if not trimmed or trimmed.startswith("#"):
            i += 1
            continue

        indent = len(line) - len(line.lstrip())
        while len(stack) > 1 and stack[-1][1] >= indent:
            stack.pop()

        parent = stack[-1][0]

        kv_match = re.match(r"^([^\s:]+):\s*(.*)?$", trimmed)
        if kv_match:
            key, value_str = kv_match.groups()
            value_str = (value_str or "").strip()

            if value_str == "" or value_str in ("|", ">"):
                if i + 1 < len(lines):
                    next_trimmed = lines[i + 1].strip()
                    if next_trimmed.startswith("{") or next_trimmed.startswith("["):
                        collecting_json = True
                        json_buffer = []
                        json_depth = 0
                        json_key = key
                        json_parent = parent
                        i += 1
                        continue

                child_obj = {}
                parent[key] = child_obj
                stack.append((child_obj, indent))

            elif value_str.startswith("{") or value_str.startswith("["):
                depth = _count_depth_outside_strings(value_str)
                if depth == 0:
                    try:
                        parent[key] = json.loads(value_str)
                    except json.JSONDecodeError:
                        parent[key] = value_str
                else:
                    collecting_json = True
                    json_buffer = [value_str]
                    json_depth = depth
                    json_key = key
                    json_parent = parent
            else:
                parent[key] = _parse_yaml_value(value_str)

        i += 1

    return result


def parse_frontmatter(content: str) -> dict:
    """Parse frontmatter from SKILL.md content."""
    match = FRONTMATTER_REGEX.match(content)
    if not match:
        return {"frontmatter": None, "body": content, "raw": ""}

    raw = match.group(1)
    body = content[match.end() :].strip()

    try:
        parsed = _parse_yaml_subset(raw)
        return {"frontmatter": parsed, "body": body, "raw": raw}
    except Exception:
        return {"frontmatter": None, "body": body, "raw": raw}


def generate_skills_xml(skills: list[dict], include_location: bool = False) -> str:
    """Generate XML for skill metadata to include in agent prompts."""
    if not skills:
        return ""

    skill_elements = []
    for skill in skills:
        location_tag = ""
        if include_location and skill.get("location"):
            location_tag = f"\n    <location>{skill['location']}</location>"
        skill_elements.append(
            f"  <skill>\n    <name>{skill['name']}</name>\n    "
            f"<description>{skill['description']}</description>{location_tag}\n  </skill>"
        )

    return f"<available_skills>\n{chr(10).join(skill_elements)}\n</available_skills>"


# ============================================================
# HELPER FUNCTIONS
# ============================================================


def load_real_skill(skill_name: str) -> Optional[dict]:
    """Load a skill from the otto directory."""
    skill_path = OTTO_SKILLS_PATH / skill_name / "SKILL.md"
    if not skill_path.exists():
        return None

    content = skill_path.read_text(encoding="utf-8")
    result = parse_frontmatter(content)
    frontmatter = result.get("frontmatter")

    if not frontmatter:
        return None

    return {
        "name": frontmatter.get("name", skill_name),
        "description": frontmatter.get("description", ""),
        "content": content,
        "body": result.get("body", ""),
        "frontmatter": frontmatter,
        "path": str(skill_path),
    }


def create_system_prompt_with_skills(skills: list[dict]) -> str:
    """Generate a system prompt with skill instructions."""
    skills_metadata = [
        {"name": s["name"], "description": s["description"], "location": s["path"]}
        for s in skills
    ]
    skills_xml = generate_skills_xml(skills_metadata, include_location=False)

    return f"""You are a helpful assistant with access to the following skills:

{skills_xml}

When a user asks about something covered by a skill, refer to and use that skill's capabilities.
If a skill requires specific CLI tools, mention what's needed."""


# ============================================================
# SKILL LOADING TESTS (no API key required)
# ============================================================


class TestSkillLoading:
    """Tests for loading and parsing skills."""

    def test_load_github_skill(self):
        """Should load github skill with otto metadata."""
        skill = load_real_skill("github")
        if not skill:
            pytest.skip("github skill not found")

        assert skill["name"] == "github"
        assert "gh" in skill["description"]
        otto_meta = skill["frontmatter"].get("metadata", {}).get("otto")
        assert otto_meta is not None

    def test_load_clawhub_skill(self):
        """Should load clawhub skill."""
        skill = load_real_skill("clawhub")
        if not skill:
            pytest.skip("clawhub skill not found")

        assert skill["name"] == "clawhub"
        otto_meta = skill["frontmatter"].get("metadata", {}).get("otto")
        assert otto_meta is not None

    def test_load_multiple_skills(self):
        """Should load multiple skills."""
        skill_names = ["github", "clawhub", "tmux"]
        loaded = [load_real_skill(name) for name in skill_names]
        loaded = [s for s in loaded if s is not None]

        assert len(loaded) >= 1, "At least one skill should be available"

    def test_generate_skills_xml(self):
        """Should generate valid XML from skills."""
        skill = load_real_skill("github")
        if not skill:
            pytest.skip("github skill not found")

        xml = generate_skills_xml(
            [{"name": skill["name"], "description": skill["description"], "location": skill["path"]}],
            include_location=True,
        )

        assert "<available_skills>" in xml
        assert "</available_skills>" in xml
        assert f"<name>{skill['name']}</name>" in xml


# ============================================================
# ANTHROPIC INTEGRATION TESTS
# ============================================================


@pytest.mark.skipif(not API_KEY, reason=SKIP_REASON)
class TestAnthropicIntegration:
    """Integration tests that require Anthropic API key."""

    @pytest.fixture(autouse=True)
    def setup_client(self):
        """Set up Anthropic client."""
        import anthropic

        self.client = anthropic.Anthropic(api_key=API_KEY)

    def test_understand_github_skill(self):
        """Should understand github skill and explain gh CLI usage."""
        skill = load_real_skill("github")
        if not skill:
            pytest.skip("github skill not found")

        system_prompt = create_system_prompt_with_skills([skill])

        response = self.client.messages.create(
            model="claude-3-5-haiku-20241022",
            max_tokens=500,
            system=system_prompt,
            messages=[
                {
                    "role": "user",
                    "content": "How do I list my open pull requests using the skills you have?",
                }
            ],
        )

        text = response.content[0].text if response.content else ""

        assert re.search(r"gh|github cli|pull request", text, re.IGNORECASE)
        assert len(text) > 50

    def test_identify_required_dependencies(self):
        """Should identify required dependencies from skill metadata."""
        skill = load_real_skill("github")
        if not skill:
            pytest.skip("github skill not found")

        system_prompt = f"""You help users with command-line tools.

Here is your skill documentation:

<skill name="{skill['name']}">
{skill['body']}
</skill>

When answering, mention any required tools or dependencies."""

        response = self.client.messages.create(
            model="claude-3-5-haiku-20241022",
            max_tokens=300,
            system=system_prompt,
            messages=[
                {
                    "role": "user",
                    "content": "What do I need installed to use this GitHub skill?",
                }
            ],
        )

        text = response.content[0].text if response.content else ""
        assert re.search(r"gh|github cli", text, re.IGNORECASE)

    def test_handle_multiple_skills(self):
        """Should handle multiple skills in context."""
        skill_names = ["github", "tmux", "clawhub"]
        skills = [load_real_skill(name) for name in skill_names]
        skills = [s for s in skills if s is not None]

        if len(skills) < 2:
            pytest.skip("Need at least 2 skills")

        system_prompt = create_system_prompt_with_skills(skills)

        response = self.client.messages.create(
            model="claude-3-5-haiku-20241022",
            max_tokens=300,
            system=system_prompt,
            messages=[
                {
                    "role": "user",
                    "content": "What skills do you have available? List them briefly.",
                }
            ],
        )

        text = response.content[0].text.lower() if response.content else ""

        mentioned_count = sum(1 for skill in skills if skill["name"].lower() in text)
        assert mentioned_count >= 1

    def test_use_skill_instructions(self):
        """Should use skill instructions for task execution."""
        skill = load_real_skill("github")
        if not skill:
            pytest.skip("github skill not found")

        system_prompt = f"""You are a coding assistant with the following skill:

<skill>
{skill['body']}
</skill>

Provide specific commands when asked about GitHub tasks. Format commands in code blocks."""

        response = self.client.messages.create(
            model="claude-3-5-haiku-20241022",
            max_tokens=400,
            system=system_prompt,
            messages=[
                {
                    "role": "user",
                    "content": 'Show me the command to create a new GitHub issue with the title "Bug fix needed"',
                }
            ],
        )

        text = response.content[0].text if response.content else ""
        assert re.search(r"gh\s+issue\s+create", text, re.IGNORECASE)


@pytest.mark.skipif(not API_KEY, reason=SKIP_REASON)
class TestOttoCompatibility:
    """Tests for Otto compatibility with Anthropic."""

    @pytest.fixture(autouse=True)
    def setup_client(self):
        """Set up Anthropic client."""
        import anthropic

        self.client = anthropic.Anthropic(api_key=API_KEY)

    def test_parse_install_instructions(self):
        """Should parse and use otto install instructions."""
        skill = load_real_skill("github")
        if not skill:
            pytest.skip("github skill not found")

        otto_meta = skill["frontmatter"].get("metadata", {}).get("otto", {})
        install_options = otto_meta.get("install", [])

        system_prompt = f"""You help users install tools.

For the {skill['name']} skill, here are the installation options:
{json.dumps(install_options, indent=2)}

Provide platform-appropriate install commands."""

        response = self.client.messages.create(
            model="claude-3-5-haiku-20241022",
            max_tokens=400,
            system=system_prompt,
            messages=[
                {
                    "role": "user",
                    "content": "How do I install the GitHub CLI on macOS?",
                }
            ],
        )

        text = response.content[0].text if response.content else ""
        assert re.search(r"brew|homebrew", text, re.IGNORECASE)


# ============================================================
# SKIP MESSAGE
# ============================================================

if not API_KEY:
    print(
        "\n⚠️ Skipping Anthropic integration tests: ANTHROPIC_API_KEY not set\n"
        "To run integration tests, set the environment variable:\n"
        "ANTHROPIC_API_KEY=your-key pytest tests/test_integration.py -v\n"
    )
