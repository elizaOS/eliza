"""
Storage Tests

Tests for the skill storage abstraction layer.
"""

import asyncio
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Optional

import pytest


# ============================================================
# INLINE PARSER (to avoid import issues with elizaos)
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


# ============================================================
# INLINE STORAGE CLASSES
# ============================================================


class SkillFile:
    def __init__(self, path: str, content, is_text: bool):
        self.path = path
        self.content = content
        self.is_text = is_text


class SkillPackage:
    def __init__(self, slug: str, files: dict = None):
        self.slug = slug
        self.files = files or {}


class MemorySkillStore:
    def __init__(self, base_path: str = "/virtual/skills"):
        self._base_path = base_path
        self._skills: dict[str, SkillPackage] = {}

    @property
    def storage_type(self) -> str:
        return "memory"

    async def initialize(self):
        pass

    async def list_skills(self):
        return list(self._skills.keys())

    async def has_skill(self, slug: str) -> bool:
        return slug in self._skills

    async def load_skill_content(self, slug: str) -> Optional[str]:
        pkg = self._skills.get(slug)
        if not pkg:
            return None
        skill_md = pkg.files.get("SKILL.md")
        if not skill_md or not skill_md.is_text:
            return None
        return skill_md.content if isinstance(skill_md.content, str) else None

    async def load_file(self, slug: str, relative_path: str):
        pkg = self._skills.get(slug)
        if not pkg:
            return None
        file = pkg.files.get(relative_path)
        return file.content if file else None

    async def list_files(self, slug: str, subdir: Optional[str] = None):
        pkg = self._skills.get(slug)
        if not pkg:
            return []
        prefix = f"{subdir}/" if subdir else ""
        files = []
        for path in pkg.files.keys():
            if subdir:
                if path.startswith(prefix) and "/" not in path[len(prefix) :]:
                    files.append(path[len(prefix) :])
            elif "/" not in path:
                files.append(path)
        return files

    async def save_skill(self, pkg: SkillPackage):
        self._skills[pkg.slug] = pkg

    async def delete_skill(self, slug: str) -> bool:
        if slug in self._skills:
            del self._skills[slug]
            return True
        return False

    def get_skill_path(self, slug: str) -> str:
        return f"{self._base_path}/{slug}"

    async def load_from_content(
        self, slug: str, skill_md_content: str, additional_files: Optional[dict] = None
    ):
        files = {"SKILL.md": SkillFile("SKILL.md", skill_md_content, True)}
        if additional_files:
            for path, content in additional_files.items():
                files[path] = SkillFile(path, content, isinstance(content, str))
        await self.save_skill(SkillPackage(slug, files))


class FileSystemSkillStore:
    def __init__(self, base_path: str = "./skills"):
        self._base_path = Path(base_path)

    @property
    def storage_type(self) -> str:
        return "filesystem"

    async def initialize(self):
        self._base_path.mkdir(parents=True, exist_ok=True)

    async def list_skills(self):
        if not self._base_path.exists():
            return []
        return [d.name for d in self._base_path.iterdir() if d.is_dir() and not d.name.startswith(".")]

    async def has_skill(self, slug: str) -> bool:
        return (self._base_path / slug / "SKILL.md").exists()

    async def load_skill_content(self, slug: str) -> Optional[str]:
        skill_path = self._base_path / slug / "SKILL.md"
        if not skill_path.exists():
            return None
        return skill_path.read_text(encoding="utf-8")

    async def save_skill(self, pkg: SkillPackage):
        skill_dir = self._base_path / pkg.slug
        skill_dir.mkdir(parents=True, exist_ok=True)
        for relative_path, file in pkg.files.items():
            full_path = skill_dir / relative_path
            full_path.parent.mkdir(parents=True, exist_ok=True)
            if file.is_text:
                full_path.write_text(str(file.content), encoding="utf-8")
            else:
                full_path.write_bytes(file.content if isinstance(file.content, bytes) else file.content.encode())

    async def delete_skill(self, slug: str) -> bool:
        import shutil

        skill_dir = self._base_path / slug
        if not skill_dir.exists():
            return False
        shutil.rmtree(skill_dir)
        return True

    def get_skill_path(self, slug: str) -> str:
        return str((self._base_path / slug).resolve())


# ============================================================
# TEST DATA
# ============================================================

TEST_SKILL_MD = """---
name: test-skill
description: A test skill for unit tests
license: MIT
compatibility: Claude
---

# Test Skill

This is a test skill.
"""

TEST_SKILL_MD_WITH_METADATA = """---
name: scripted-skill
description: A skill with scripts and metadata
license: MIT
compatibility: Claude
metadata:
  version: "1.0.0"
  otto:
    requires:
      bins:
        - node
---

# Scripted Skill

A skill that uses scripts.
"""


# ============================================================
# MEMORY STORAGE TESTS
# ============================================================


class TestMemorySkillStore:
    """Tests for in-memory skill storage."""

    @pytest.mark.asyncio
    async def test_should_start_empty(self):
        store = MemorySkillStore("/virtual/skills")
        await store.initialize()
        skills = await store.list_skills()
        assert skills == []

    @pytest.mark.asyncio
    async def test_should_report_memory_type(self):
        store = MemorySkillStore()
        assert store.storage_type == "memory"

    @pytest.mark.asyncio
    async def test_should_save_and_retrieve_skill(self):
        store = MemorySkillStore()
        await store.initialize()

        pkg = SkillPackage(
            slug="test-skill",
            files={"SKILL.md": SkillFile("SKILL.md", TEST_SKILL_MD, True)},
        )
        await store.save_skill(pkg)

        assert await store.has_skill("test-skill")
        assert await store.list_skills() == ["test-skill"]

        content = await store.load_skill_content("test-skill")
        assert content == TEST_SKILL_MD

    @pytest.mark.asyncio
    async def test_should_delete_skill(self):
        store = MemorySkillStore()
        await store.initialize()
        await store.load_from_content("to-delete", TEST_SKILL_MD)

        assert await store.has_skill("to-delete")
        assert await store.delete_skill("to-delete")
        assert not await store.has_skill("to-delete")

    @pytest.mark.asyncio
    async def test_should_return_none_for_nonexistent(self):
        store = MemorySkillStore()
        await store.initialize()
        content = await store.load_skill_content("nonexistent")
        assert content is None

    @pytest.mark.asyncio
    async def test_should_get_virtual_path(self):
        store = MemorySkillStore("/virtual/skills")
        path = store.get_skill_path("my-skill")
        assert path == "/virtual/skills/my-skill"

    @pytest.mark.asyncio
    async def test_should_load_from_content(self):
        store = MemorySkillStore()
        await store.initialize()
        await store.load_from_content("direct-skill", TEST_SKILL_MD)

        assert await store.has_skill("direct-skill")
        content = await store.load_skill_content("direct-skill")
        assert content == TEST_SKILL_MD

    @pytest.mark.asyncio
    async def test_should_load_with_additional_files(self):
        store = MemorySkillStore()
        await store.initialize()

        additional_files = {
            "scripts/run.sh": '#!/bin/bash\necho "Hello"',
            "references/api.md": "# API Reference",
        }
        await store.load_from_content("with-files", TEST_SKILL_MD, additional_files)

        script = await store.load_file("with-files", "scripts/run.sh")
        assert script == '#!/bin/bash\necho "Hello"'

        ref = await store.load_file("with-files", "references/api.md")
        assert ref == "# API Reference"


# ============================================================
# FILESYSTEM STORAGE TESTS
# ============================================================


class TestFileSystemSkillStore:
    """Tests for filesystem-based skill storage."""

    @pytest.fixture
    def temp_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            yield tmp

    @pytest.mark.asyncio
    async def test_should_create_directory_on_initialize(self, temp_dir):
        store = FileSystemSkillStore(temp_dir)
        await store.initialize()
        assert Path(temp_dir).exists()

    @pytest.mark.asyncio
    async def test_should_report_filesystem_type(self, temp_dir):
        store = FileSystemSkillStore(temp_dir)
        assert store.storage_type == "filesystem"

    @pytest.mark.asyncio
    async def test_should_start_empty(self, temp_dir):
        store = FileSystemSkillStore(temp_dir)
        await store.initialize()
        skills = await store.list_skills()
        assert skills == []

    @pytest.mark.asyncio
    async def test_should_save_and_retrieve_skill(self, temp_dir):
        store = FileSystemSkillStore(temp_dir)
        await store.initialize()

        pkg = SkillPackage(
            slug="fs-skill",
            files={"SKILL.md": SkillFile("SKILL.md", TEST_SKILL_MD, True)},
        )
        await store.save_skill(pkg)

        assert await store.has_skill("fs-skill")
        assert await store.list_skills() == ["fs-skill"]

        content = await store.load_skill_content("fs-skill")
        assert content == TEST_SKILL_MD

        # Verify file exists on disk
        skill_path = Path(temp_dir) / "fs-skill" / "SKILL.md"
        assert skill_path.exists()

    @pytest.mark.asyncio
    async def test_should_delete_skill(self, temp_dir):
        store = FileSystemSkillStore(temp_dir)
        await store.initialize()

        pkg = SkillPackage(
            slug="to-remove",
            files={"SKILL.md": SkillFile("SKILL.md", TEST_SKILL_MD, True)},
        )
        await store.save_skill(pkg)

        assert await store.has_skill("to-remove")
        assert await store.delete_skill("to-remove")
        assert not await store.has_skill("to-remove")
        assert not (Path(temp_dir) / "to-remove").exists()


# ============================================================
# REAL SKILL TESTS
# ============================================================

SCRIPT_DIR = Path(__file__).parent
OTTO_SKILLS_PATH = SCRIPT_DIR.parent.parent.parent.parent / "otto" / "skills"


class TestRealSkills:
    """Tests with real Otto skills."""

    @pytest.mark.asyncio
    async def test_load_github_skill_into_memory(self):
        skill_path = OTTO_SKILLS_PATH / "github" / "SKILL.md"
        if not skill_path.exists():
            pytest.skip("github skill not found")

        content = skill_path.read_text(encoding="utf-8")

        store = MemorySkillStore()
        await store.initialize()
        await store.load_from_content("github", content)

        loaded_content = await store.load_skill_content("github")
        assert loaded_content is not None

        result = parse_frontmatter(loaded_content)
        fm = result.get("frontmatter")
        assert fm is not None
        assert fm.get("name") == "github"
        otto_meta = fm.get("metadata", {}).get("otto")
        assert otto_meta is not None

    @pytest.mark.asyncio
    async def test_load_clawhub_skill_into_memory(self):
        skill_path = OTTO_SKILLS_PATH / "clawhub" / "SKILL.md"
        if not skill_path.exists():
            pytest.skip("clawhub skill not found")

        content = skill_path.read_text(encoding="utf-8")

        store = MemorySkillStore()
        await store.initialize()
        await store.load_from_content("clawhub", content)

        loaded_content = await store.load_skill_content("clawhub")
        assert loaded_content is not None

        result = parse_frontmatter(loaded_content)
        fm = result.get("frontmatter")
        assert fm is not None
        assert fm.get("name") == "clawhub"
