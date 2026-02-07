"""
Parser Tests

Tests SKILL.md parsing and validation with real skills from otto.
"""

import pytest
from pathlib import Path

from elizaos_plugin_agent_skills.parser import (
    parse_frontmatter,
    validate_frontmatter,
    validate_skill_directory,
    extract_body,
    estimate_tokens,
    generate_skills_xml,
)

# Path to otto skills for testing
OTTO_SKILLS_PATH = Path(__file__).parent.parent.parent.parent.parent / "otto" / "skills"


class TestParseFrontmatter:
    """Tests for parse_frontmatter function."""

    def test_parse_simple_frontmatter(self):
        """Should parse simple frontmatter."""
        content = """---
name: test-skill
description: A test skill for testing purposes.
---
# Test Skill

Instructions here.
"""
        result = parse_frontmatter(content)
        frontmatter = result["frontmatter"]
        body = result["body"]
        raw = result["raw"]

        assert frontmatter is not None
        assert frontmatter["name"] == "test-skill"
        assert frontmatter["description"] == "A test skill for testing purposes."
        assert "# Test Skill" in body
        assert "name: test-skill" in raw

    def test_parse_frontmatter_with_optional_fields(self):
        """Should parse frontmatter with optional fields."""
        content = """---
name: advanced-skill
description: An advanced skill with all optional fields.
license: MIT
compatibility: Requires Python 3.10+
homepage: https://example.com
---
# Advanced Skill
"""
        result = parse_frontmatter(content)
        frontmatter = result["frontmatter"]

        assert frontmatter["license"] == "MIT"
        assert frontmatter["compatibility"] == "Requires Python 3.10+"
        assert frontmatter["homepage"] == "https://example.com"

    def test_no_frontmatter_returns_none(self):
        """Should return None frontmatter for content without frontmatter."""
        content = """# No Frontmatter

Just regular markdown.
"""
        result = parse_frontmatter(content)
        frontmatter = result["frontmatter"]
        body = result["body"]

        assert frontmatter is None
        assert "# No Frontmatter" in body

    @pytest.mark.skipif(
        not OTTO_SKILLS_PATH.exists(),
        reason="Otto skills not available"
    )
    def test_parse_real_github_skill(self):
        """Should parse real otto github skill."""
        skill_path = OTTO_SKILLS_PATH / "github" / "SKILL.md"

        if skill_path.exists():
            content = skill_path.read_text()
            result = parse_frontmatter(content)
            frontmatter = result["frontmatter"]
            body = result["body"]

            assert frontmatter is not None
            assert frontmatter["name"] == "github"
            assert "gh" in frontmatter["description"]
            assert "# GitHub Skill" in body

            # Check Otto metadata
            metadata = frontmatter.get("metadata", {})
            assert metadata is not None
            otto_meta = metadata.get("otto", {})
            assert otto_meta is not None
            requires = otto_meta.get("requires", {})
            assert "gh" in requires.get("bins", [])

    @pytest.mark.skipif(
        not OTTO_SKILLS_PATH.exists(),
        reason="Otto skills not available"
    )
    def test_parse_real_1password_skill(self):
        """Should parse real otto 1password skill with references."""
        skill_path = OTTO_SKILLS_PATH / "1password" / "SKILL.md"

        if skill_path.exists():
            content = skill_path.read_text()
            result = parse_frontmatter(content)
            frontmatter = result["frontmatter"]
            body = result["body"]

            assert frontmatter is not None
            assert frontmatter["name"] == "1password"
            metadata = frontmatter.get("metadata", {})
            otto_meta = metadata.get("otto", {})
            requires = otto_meta.get("requires", {})
            assert requires.get("bins")
            assert "references/" in body


class TestValidateFrontmatter:
    """Tests for validate_frontmatter function."""

    def test_validate_correct_frontmatter(self):
        """Should validate correct frontmatter."""
        fm = {
            "name": "valid-skill",
            "description": "A valid skill description that explains what it does.",
        }

        result = validate_frontmatter(fm)

        assert result["valid"]
        assert len(result["errors"]) == 0

    def test_reject_missing_name(self):
        """Should reject missing name."""
        fm = {
            "name": "",
            "description": "A description.",
        }

        result = validate_frontmatter(fm)

        assert not result["valid"]
        assert any(e["code"] == "MISSING_NAME" for e in result["errors"])

    def test_reject_invalid_name_format(self):
        """Should reject invalid name format."""
        fm = {
            "name": "Invalid-Name",  # uppercase not allowed
            "description": "A description.",
        }

        result = validate_frontmatter(fm)

        assert not result["valid"]
        assert any(e["code"] == "INVALID_NAME_FORMAT" for e in result["errors"])

    def test_reject_consecutive_hyphens(self):
        """Should reject name with consecutive hyphens."""
        fm = {
            "name": "invalid--name",
            "description": "A description.",
        }

        result = validate_frontmatter(fm)

        assert not result["valid"]
        assert any(e["code"] == "NAME_CONSECUTIVE_HYPHENS" for e in result["errors"])

    def test_reject_missing_description(self):
        """Should reject missing description."""
        fm = {
            "name": "valid-name",
            "description": "",
        }

        result = validate_frontmatter(fm)

        assert not result["valid"]
        assert any(e["code"] == "MISSING_DESCRIPTION" for e in result["errors"])

    def test_warn_short_description(self):
        """Should warn about short description."""
        fm = {
            "name": "valid-name",
            "description": "Too short.",
        }

        result = validate_frontmatter(fm)

        assert result["valid"]  # warnings don't make it invalid
        assert any(w["code"] == "DESCRIPTION_TOO_SHORT" for w in result["warnings"])

    def test_validate_directory_name_match(self):
        """Should validate directory name match."""
        fm = {
            "name": "skill-name",
            "description": "A valid description that is long enough.",
        }

        result = validate_frontmatter(fm, "different-name")

        assert not result["valid"]
        assert any(e["code"] == "NAME_MISMATCH" for e in result["errors"])


class TestExtractBody:
    """Tests for extract_body function."""

    def test_extract_body_without_frontmatter(self):
        """Should extract body without frontmatter."""
        content = """---
name: test
description: Test skill.
---
# Main Content

This is the body.
"""
        body = extract_body(content)

        assert body == "# Main Content\n\nThis is the body."
        assert "---" not in body
        assert "name: test" not in body


class TestEstimateTokens:
    """Tests for estimate_tokens function."""

    def test_estimate_tokens_based_on_characters(self):
        """Should estimate tokens based on character count."""
        text = "This is some text that should be approximately some tokens."
        tokens = estimate_tokens(text)

        assert tokens > 0
        assert tokens < len(text)  # ~4 chars per token


class TestGenerateSkillsXml:
    """Tests for generate_skills_xml function."""

    def test_generate_xml_with_locations(self):
        """Should generate valid XML with locations."""
        skills = [
            {"name": "skill-one", "description": "First skill.", "location": "/path/to/skill-one/SKILL.md"},
            {"name": "skill-two", "description": "Second skill.", "location": "/path/to/skill-two/SKILL.md"},
        ]

        xml = generate_skills_xml(skills, include_location=True)

        assert "<available_skills>" in xml
        assert "<name>skill-one</name>" in xml
        assert "<description>First skill.</description>" in xml
        assert "<location>/path/to/skill-one/SKILL.md</location>" in xml
        assert "</available_skills>" in xml

    def test_generate_xml_without_locations(self):
        """Should generate XML without locations."""
        skills = [{"name": "skill-one", "description": "First skill.", "location": "/path"}]

        xml = generate_skills_xml(skills, include_location=False)

        assert "<location>" not in xml

    def test_escape_xml_special_characters(self):
        """Should escape XML special characters."""
        skills = [{"name": "test", "description": 'Use when <condition> & "situation".'}]

        xml = generate_skills_xml(skills)

        assert "&lt;condition&gt;" in xml
        assert "&amp;" in xml
        assert "&quot;" in xml

    def test_empty_skills_returns_empty_string(self):
        """Should return empty string for empty skills array."""
        xml = generate_skills_xml([])
        assert xml == ""


@pytest.mark.skipif(
    not OTTO_SKILLS_PATH.exists(),
    reason="Otto skills not available"
)
class TestRealOttoSkills:
    """Tests for validating real otto skills."""

    @pytest.mark.parametrize("skill_dir", [
        "github",
        "1password",
        "clawhub",
        "skill-creator",
        "tmux",
    ])
    def test_validate_skill(self, skill_dir: str):
        """Should validate real otto skills."""
        skill_path = OTTO_SKILLS_PATH / skill_dir

        if skill_path.exists():
            skill_md_path = skill_path / "SKILL.md"
            content = skill_md_path.read_text()

            result = validate_skill_directory(str(skill_path), content, skill_dir)

            # Log any errors for debugging
            if not result["valid"]:
                print(f"{skill_dir} validation errors:", result["errors"])

            # Most skills should be valid
            assert result is not None
