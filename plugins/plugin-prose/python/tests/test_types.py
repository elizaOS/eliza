"""Tests for plugin-prose type definitions."""

from __future__ import annotations

from dataclasses import fields

from elizaos_plugin_prose.types import (
    ProseCompileOptions,
    ProseCompileResult,
    ProseConfig,
    ProseRunOptions,
    ProseRunResult,
    ProseSkillFile,
    ProseStateMode,
)


# ---------------------------------------------------------------------------
# ProseStateMode
# ---------------------------------------------------------------------------


class TestProseStateMode:
    def test_enum_values(self) -> None:
        assert ProseStateMode.FILESYSTEM.value == "filesystem"
        assert ProseStateMode.IN_CONTEXT.value == "in-context"
        assert ProseStateMode.SQLITE.value == "sqlite"
        assert ProseStateMode.POSTGRES.value == "postgres"

    def test_enum_is_str(self) -> None:
        """ProseStateMode inherits from str, so it can be used as a string."""
        mode = ProseStateMode.FILESYSTEM
        assert isinstance(mode, str)
        assert mode == "filesystem"

    def test_enum_from_value(self) -> None:
        assert ProseStateMode("filesystem") is ProseStateMode.FILESYSTEM
        assert ProseStateMode("in-context") is ProseStateMode.IN_CONTEXT
        assert ProseStateMode("sqlite") is ProseStateMode.SQLITE
        assert ProseStateMode("postgres") is ProseStateMode.POSTGRES

    def test_enum_members_count(self) -> None:
        assert len(ProseStateMode) == 4


# ---------------------------------------------------------------------------
# ProseRunOptions
# ---------------------------------------------------------------------------


class TestProseRunOptions:
    def test_defaults(self) -> None:
        opts = ProseRunOptions(file="workflow.prose")
        assert opts.file == "workflow.prose"
        assert opts.state_mode is ProseStateMode.FILESYSTEM
        assert opts.inputs_json is None
        assert opts.cwd is None

    def test_full_construction(self) -> None:
        opts = ProseRunOptions(
            file="test.prose",
            state_mode=ProseStateMode.SQLITE,
            inputs_json='{"key": "value"}',
            cwd="/tmp",
        )
        assert opts.file == "test.prose"
        assert opts.state_mode is ProseStateMode.SQLITE
        assert opts.inputs_json == '{"key": "value"}'
        assert opts.cwd == "/tmp"


# ---------------------------------------------------------------------------
# ProseCompileOptions
# ---------------------------------------------------------------------------


class TestProseCompileOptions:
    def test_construction(self) -> None:
        opts = ProseCompileOptions(file="test.prose")
        assert opts.file == "test.prose"

    def test_field_names(self) -> None:
        names = [f.name for f in fields(ProseCompileOptions)]
        assert names == ["file"]


# ---------------------------------------------------------------------------
# ProseRunResult
# ---------------------------------------------------------------------------


class TestProseRunResult:
    def test_success(self) -> None:
        result = ProseRunResult(success=True, run_id="abc-123", outputs={"key": "val"})
        assert result.success is True
        assert result.run_id == "abc-123"
        assert result.outputs == {"key": "val"}
        assert result.error is None

    def test_failure(self) -> None:
        result = ProseRunResult(success=False, error="File not found")
        assert result.success is False
        assert result.run_id is None
        assert result.outputs is None
        assert result.error == "File not found"


# ---------------------------------------------------------------------------
# ProseCompileResult
# ---------------------------------------------------------------------------


class TestProseCompileResult:
    def test_valid(self) -> None:
        result = ProseCompileResult(valid=True)
        assert result.valid is True
        assert result.errors == []
        assert result.warnings == []

    def test_invalid_with_errors(self) -> None:
        result = ProseCompileResult(
            valid=False,
            errors=["Missing program declaration"],
            warnings=["No version specified"],
        )
        assert result.valid is False
        assert len(result.errors) == 1
        assert len(result.warnings) == 1


# ---------------------------------------------------------------------------
# ProseSkillFile
# ---------------------------------------------------------------------------


class TestProseSkillFile:
    def test_construction(self) -> None:
        sf = ProseSkillFile(name="prose.md", path="prose.md", content="# content")
        assert sf.name == "prose.md"
        assert sf.path == "prose.md"
        assert sf.content == "# content"


# ---------------------------------------------------------------------------
# ProseConfig
# ---------------------------------------------------------------------------


class TestProseConfig:
    def test_defaults(self) -> None:
        config = ProseConfig()
        assert config.workspace_dir == ".prose"
        assert config.default_state_mode is ProseStateMode.FILESYSTEM
        assert config.skills_dir is None

    def test_custom(self) -> None:
        config = ProseConfig(
            workspace_dir="custom",
            default_state_mode=ProseStateMode.POSTGRES,
            skills_dir="/opt/skills",
        )
        assert config.workspace_dir == "custom"
        assert config.default_state_mode is ProseStateMode.POSTGRES
        assert config.skills_dir == "/opt/skills"
