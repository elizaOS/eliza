"""Tests for ProseService."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

import elizaos_plugin_prose.services.prose_service as _prose_svc_mod
from elizaos_plugin_prose.services.prose_service import (
    ProseService,
    generate_run_id,
    get_skill_content,
    set_skill_content,
)
from elizaos_plugin_prose.types import ProseConfig, ProseStateMode


# ---------------------------------------------------------------------------
# generate_run_id
# ---------------------------------------------------------------------------


class TestGenerateRunId:
    def test_returns_non_empty(self) -> None:
        run_id = generate_run_id()
        assert isinstance(run_id, str)
        assert len(run_id) > 0

    def test_contains_dashes(self) -> None:
        run_id = generate_run_id()
        assert "-" in run_id

    def test_unique(self) -> None:
        ids = {generate_run_id() for _ in range(20)}
        assert len(ids) == 20, "Expected 20 unique run IDs"


# ---------------------------------------------------------------------------
# ProseService instantiation
# ---------------------------------------------------------------------------


class TestProseServiceCreation:
    def test_default_creation(self) -> None:
        svc = ProseService()
        assert svc is not None

    def test_with_config(self) -> None:
        config = ProseConfig(
            workspace_dir="custom/.prose",
            default_state_mode=ProseStateMode.SQLITE,
        )
        svc = ProseService(config=config)
        assert svc is not None

    def test_with_skills_dir(self) -> None:
        config = ProseConfig(skills_dir="/tmp/skills")
        svc = ProseService(config=config)
        assert svc is not None


# ---------------------------------------------------------------------------
# Spec getters (empty cache)
# ---------------------------------------------------------------------------


class TestProseServiceSpecsEmpty:
    def test_get_vm_spec_none(self) -> None:
        svc = ProseService()
        assert svc.get_vm_spec() is None

    def test_get_skill_spec_none(self) -> None:
        svc = ProseService()
        assert svc.get_skill_spec() is None

    def test_get_help_none(self) -> None:
        svc = ProseService()
        assert svc.get_help() is None

    def test_get_compiler_spec_none(self) -> None:
        svc = ProseService()
        assert svc.get_compiler_spec() is None


# ---------------------------------------------------------------------------
# Spec getters (populated cache)
# ---------------------------------------------------------------------------


class TestProseServiceSpecsPopulated:
    def test_get_vm_spec(self, populated_skill_cache: dict[str, str]) -> None:
        svc = ProseService()
        result = svc.get_vm_spec()
        assert result is not None
        assert "VM Specification" in result

    def test_get_skill_spec(self, populated_skill_cache: dict[str, str]) -> None:
        svc = ProseService()
        result = svc.get_skill_spec()
        assert result is not None
        assert "SKILL" in result

    def test_get_help(self, populated_skill_cache: dict[str, str]) -> None:
        svc = ProseService()
        result = svc.get_help()
        assert result is not None
        assert "Help" in result

    def test_get_compiler_spec(self, populated_skill_cache: dict[str, str]) -> None:
        svc = ProseService()
        result = svc.get_compiler_spec()
        assert result is not None
        assert "Compiler" in result

    def test_get_state_spec_filesystem(self, populated_skill_cache: dict[str, str]) -> None:
        svc = ProseService()
        result = svc.get_state_spec(ProseStateMode.FILESYSTEM)
        assert result is not None
        assert "Filesystem" in result

    def test_get_state_spec_in_context(self, populated_skill_cache: dict[str, str]) -> None:
        svc = ProseService()
        result = svc.get_state_spec(ProseStateMode.IN_CONTEXT)
        assert result is not None
        assert "In-context" in result

    def test_get_state_spec_sqlite(self, populated_skill_cache: dict[str, str]) -> None:
        svc = ProseService()
        result = svc.get_state_spec(ProseStateMode.SQLITE)
        assert result is not None
        assert "SQLite" in result

    def test_get_state_spec_postgres(self, populated_skill_cache: dict[str, str]) -> None:
        svc = ProseService()
        result = svc.get_state_spec(ProseStateMode.POSTGRES)
        assert result is not None
        assert "Postgres" in result


# ---------------------------------------------------------------------------
# Authoring guidance
# ---------------------------------------------------------------------------


class TestAuthoringGuidance:
    def test_guidance_empty(self) -> None:
        svc = ProseService()
        guidance = svc.get_authoring_guidance()
        assert "patterns" in guidance
        assert "antipatterns" in guidance
        assert guidance["patterns"] is None
        assert guidance["antipatterns"] is None

    def test_guidance_populated(self, populated_skill_cache: dict[str, str]) -> None:
        svc = ProseService()
        guidance = svc.get_authoring_guidance()
        assert guidance["patterns"] is not None
        assert guidance["antipatterns"] is not None
        assert "Patterns" in guidance["patterns"]
        assert "Antipatterns" in guidance["antipatterns"]


# ---------------------------------------------------------------------------
# Loaded skills
# ---------------------------------------------------------------------------


class TestLoadedSkills:
    def test_loaded_skills_empty(self) -> None:
        svc = ProseService()
        skills = svc.get_loaded_skills()
        assert isinstance(skills, list)
        assert len(skills) == 0

    def test_loaded_skills_populated(self, populated_skill_cache: dict[str, str]) -> None:
        svc = ProseService()
        skills = svc.get_loaded_skills()
        assert isinstance(skills, list)
        assert len(skills) == len(populated_skill_cache)
        names = {s.name for s in skills}
        assert "prose.md" in names
        assert "help.md" in names


# ---------------------------------------------------------------------------
# build_vm_context
# ---------------------------------------------------------------------------


class TestBuildVMContext:
    def test_builds_context_empty_cache(self) -> None:
        svc = ProseService()
        context = svc.build_vm_context()
        assert isinstance(context, str)
        assert "OpenProse" in context

    def test_builds_context_with_vm_spec(self, populated_skill_cache: dict[str, str]) -> None:
        svc = ProseService()
        context = svc.build_vm_context(state_mode=ProseStateMode.FILESYSTEM)
        assert "OpenProse VM" in context
        assert "VM Specification" in context

    def test_builds_context_with_compiler(self, populated_skill_cache: dict[str, str]) -> None:
        svc = ProseService()
        context = svc.build_vm_context(include_compiler=True)
        assert "Compiler" in context

    def test_builds_context_without_compiler(self, populated_skill_cache: dict[str, str]) -> None:
        svc = ProseService()
        context = svc.build_vm_context(include_compiler=False)
        # "Compiler/Validator" heading should not be present
        assert "Compiler/Validator" not in context

    def test_builds_context_with_guidance(self, populated_skill_cache: dict[str, str]) -> None:
        svc = ProseService()
        context = svc.build_vm_context(include_guidance=True)
        assert "Authoring Patterns" in context
        assert "Authoring Antipatterns" in context

    def test_builds_context_without_guidance(
        self, populated_skill_cache: dict[str, str]
    ) -> None:
        svc = ProseService()
        context = svc.build_vm_context(include_guidance=False)
        assert "Authoring Patterns" not in context


# ---------------------------------------------------------------------------
# File operations (async)
# ---------------------------------------------------------------------------


class TestFileOperations:
    @pytest.mark.asyncio
    async def test_file_exists_true(self) -> None:
        svc = ProseService()
        with tempfile.NamedTemporaryFile(suffix=".prose", delete=False) as f:
            f.write(b"program test {}")
            tmp = f.name
        try:
            assert await svc.file_exists(tmp) is True
        finally:
            os.unlink(tmp)

    @pytest.mark.asyncio
    async def test_file_exists_false(self) -> None:
        svc = ProseService()
        assert await svc.file_exists("/nonexistent/path/test.prose") is False

    @pytest.mark.asyncio
    async def test_read_prose_file(self) -> None:
        svc = ProseService()
        content = 'program "hello" version "1.0" { session main() {} }'
        with tempfile.NamedTemporaryFile(
            suffix=".prose", mode="w", encoding="utf-8", delete=False
        ) as f:
            f.write(content)
            tmp = f.name
        try:
            result = await svc.read_prose_file(tmp)
            assert result == content
        finally:
            os.unlink(tmp)


# ---------------------------------------------------------------------------
# Workspace & run directory (async)
# ---------------------------------------------------------------------------


class TestWorkspaceOperations:
    @pytest.mark.asyncio
    async def test_ensure_workspace(self) -> None:
        svc = ProseService()
        with tempfile.TemporaryDirectory() as tmpdir:
            ws = await svc.ensure_workspace(tmpdir)
            assert Path(ws).exists()
            assert (Path(ws) / "runs").exists()
            assert (Path(ws) / "agents").exists()

    @pytest.mark.asyncio
    async def test_create_run_directory(self) -> None:
        svc = ProseService()
        with tempfile.TemporaryDirectory() as tmpdir:
            ws = await svc.ensure_workspace(tmpdir)
            program = 'program "test" version "1.0" { session main() {} }'
            run_id, run_dir = await svc.create_run_directory(ws, program)

            assert len(run_id) > 0
            assert "-" in run_id

            run_path = Path(run_dir)
            assert run_path.exists()
            assert (run_path / "program.prose").exists()
            assert (run_path / "state.md").exists()
            assert (run_path / "bindings").exists()
            assert (run_path / "agents").exists()
            assert (run_path / "imports").exists()

            # Verify program content was written
            written = (run_path / "program.prose").read_text(encoding="utf-8")
            assert written == program

            # Verify state.md contains run_id
            state = (run_path / "state.md").read_text(encoding="utf-8")
            assert run_id in state


# ---------------------------------------------------------------------------
# Examples (async)
# ---------------------------------------------------------------------------


class TestExamples:
    @pytest.mark.asyncio
    async def test_list_examples_no_skills_dir(self) -> None:
        svc = ProseService()
        examples = await svc.list_examples()
        assert examples == []

    @pytest.mark.asyncio
    async def test_list_examples_with_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config = ProseConfig(skills_dir=tmpdir)
            svc = ProseService(config=config)
            await svc.init(skills_dir=tmpdir)

            examples_dir = Path(tmpdir) / "examples"
            examples_dir.mkdir()
            (examples_dir / "hello.prose").write_text("program hello {}")
            (examples_dir / "world.prose").write_text("program world {}")
            (examples_dir / "readme.md").write_text("not a prose file")

            examples = await svc.list_examples()
            assert sorted(examples) == ["hello.prose", "world.prose"]

    @pytest.mark.asyncio
    async def test_read_example_found(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config = ProseConfig(skills_dir=tmpdir)
            svc = ProseService(config=config)
            await svc.init(skills_dir=tmpdir)

            examples_dir = Path(tmpdir) / "examples"
            examples_dir.mkdir()
            (examples_dir / "hello.prose").write_text("program hello {}")

            content = await svc.read_example("hello")
            assert content == "program hello {}"

    @pytest.mark.asyncio
    async def test_read_example_not_found(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config = ProseConfig(skills_dir=tmpdir)
            svc = ProseService(config=config)
            await svc.init(skills_dir=tmpdir)

            examples_dir = Path(tmpdir) / "examples"
            examples_dir.mkdir()

            content = await svc.read_example("nonexistent")
            assert content is None

    @pytest.mark.asyncio
    async def test_read_example_no_skills_dir(self) -> None:
        svc = ProseService()
        content = await svc.read_example("hello")
        assert content is None


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


class TestModuleLevelHelpers:
    def test_set_skill_content(self) -> None:
        set_skill_content({"test.md": "test content"})
        result = get_skill_content()
        assert result.get("test.md") == "test content"

    def test_get_skill_content(self) -> None:
        _prose_svc_mod._skill_content["key.md"] = "value"
        result = get_skill_content()
        assert result == {"key.md": "value"}

    def test_set_and_get_roundtrip(self) -> None:
        data = {"a.md": "alpha", "b.md": "beta"}
        set_skill_content(data)
        result = get_skill_content()
        assert result == data


# ---------------------------------------------------------------------------
# Init with skill files (async)
# ---------------------------------------------------------------------------


class TestInit:
    @pytest.mark.asyncio
    async def test_init_loads_skill_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create stub skill files
            (Path(tmpdir) / "prose.md").write_text("# VM Spec")
            (Path(tmpdir) / "help.md").write_text("# Help")
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            (state_dir / "filesystem.md").write_text("# Filesystem")

            svc = ProseService()
            await svc.init(skills_dir=tmpdir)

            assert svc.get_vm_spec() is not None
            assert "VM Spec" in svc.get_vm_spec()
            assert svc.get_help() is not None
            assert svc.get_state_spec(ProseStateMode.FILESYSTEM) is not None

    @pytest.mark.asyncio
    async def test_init_without_skills_dir(self) -> None:
        svc = ProseService()
        await svc.init()
        # Should complete without error
        assert svc.get_vm_spec() is None
