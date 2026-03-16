"""Tests for plugin-prose actions (PROSE_RUN, PROSE_COMPILE, PROSE_HELP)."""

from __future__ import annotations

import pytest

from elizaos_plugin_prose.actions.compile import ProseCompileAction
from elizaos_plugin_prose.actions.help import ProseHelpAction
from elizaos_plugin_prose.actions.run import ProseRunAction
from elizaos_plugin_prose.generated.specs.specs import ACTION_SPECS, require_action_spec

from .conftest import make_message


# ═══════════════════════════════════════════════════════════════════════════
# Action specs
# ═══════════════════════════════════════════════════════════════════════════


class TestActionSpecs:
    def test_prose_run_spec_exists(self) -> None:
        spec = ACTION_SPECS["PROSE_RUN"]
        assert spec.name == "PROSE_RUN"
        assert "OpenProse" in spec.description

    def test_prose_compile_spec_exists(self) -> None:
        spec = ACTION_SPECS["PROSE_COMPILE"]
        assert spec.name == "PROSE_COMPILE"
        assert "Validate" in spec.description

    def test_prose_help_spec_exists(self) -> None:
        spec = ACTION_SPECS["PROSE_HELP"]
        assert spec.name == "PROSE_HELP"
        assert "help" in spec.description.lower()

    def test_require_action_spec_found(self) -> None:
        spec = require_action_spec("PROSE_RUN")
        assert spec.name == "PROSE_RUN"

    def test_require_action_spec_not_found(self) -> None:
        with pytest.raises(KeyError, match="Action spec not found: UNKNOWN_ACTION"):
            require_action_spec("UNKNOWN_ACTION")

    def test_all_specs_have_similes(self) -> None:
        for name, spec in ACTION_SPECS.items():
            assert len(spec.similes) > 0, f"{name} has no similes"

    def test_all_specs_have_examples(self) -> None:
        for name, spec in ACTION_SPECS.items():
            assert len(spec.examples) > 0, f"{name} has no examples"


# ═══════════════════════════════════════════════════════════════════════════
# ProseRunAction
# ═══════════════════════════════════════════════════════════════════════════


class TestProseRunAction:
    @pytest.fixture()
    def action(self) -> ProseRunAction:
        return ProseRunAction()

    def test_metadata(self, action: ProseRunAction) -> None:
        assert action.name == "PROSE_RUN"
        assert action.description is not None
        assert len(action.description) > 0

    def test_has_similes(self, action: ProseRunAction) -> None:
        assert isinstance(action.similes, list)
        assert len(action.similes) > 0

    def test_has_examples(self, action: ProseRunAction) -> None:
        assert isinstance(action.examples, list)
        assert len(action.examples) > 0

    # --- validate positive ---

    @pytest.mark.asyncio
    async def test_validate_prose_run(self, action: ProseRunAction) -> None:
        msg = make_message("prose run workflow.prose")
        assert await action.validate(msg) is True

    @pytest.mark.asyncio
    async def test_validate_run_with_prose_file(self, action: ProseRunAction) -> None:
        msg = make_message("run my-workflow.prose")
        assert await action.validate(msg) is True

    @pytest.mark.asyncio
    async def test_validate_execute_with_prose(self, action: ProseRunAction) -> None:
        msg = make_message("execute test.prose")
        assert await action.validate(msg) is True

    @pytest.mark.asyncio
    async def test_validate_case_insensitive(self, action: ProseRunAction) -> None:
        msg = make_message("PROSE RUN workflow.prose")
        assert await action.validate(msg) is True

    # --- validate negative ---

    @pytest.mark.asyncio
    async def test_validate_unrelated(self, action: ProseRunAction) -> None:
        msg = make_message("what is the weather today?")
        assert await action.validate(msg) is False

    @pytest.mark.asyncio
    async def test_validate_empty(self, action: ProseRunAction) -> None:
        msg = make_message("")
        assert await action.validate(msg) is False

    # --- handler ---

    @pytest.mark.asyncio
    async def test_handler_no_file(self, action: ProseRunAction) -> None:
        msg = make_message("prose run")
        result = await action.handler(msg)
        assert result["success"] is False
        assert "specify" in result["text"].lower()

    @pytest.mark.asyncio
    async def test_extract_file_from_prose_run(self, action: ProseRunAction) -> None:
        """The internal _extract_file should find the filename."""
        assert action._extract_file("prose run workflow.prose") == "workflow.prose"

    @pytest.mark.asyncio
    async def test_extract_file_from_run_command(self, action: ProseRunAction) -> None:
        assert action._extract_file("run my-workflow.prose") == "my-workflow.prose"

    @pytest.mark.asyncio
    async def test_extract_file_from_execute(self, action: ProseRunAction) -> None:
        assert action._extract_file("execute test.prose") == "test.prose"

    @pytest.mark.asyncio
    async def test_extract_file_xml_format(self, action: ProseRunAction) -> None:
        text = "<file>my-program.prose</file>"
        assert action._extract_file(text) == "my-program.prose"

    @pytest.mark.asyncio
    async def test_extract_file_none(self, action: ProseRunAction) -> None:
        assert action._extract_file("nothing here") is None


# ═══════════════════════════════════════════════════════════════════════════
# ProseCompileAction
# ═══════════════════════════════════════════════════════════════════════════


class TestProseCompileAction:
    @pytest.fixture()
    def action(self) -> ProseCompileAction:
        return ProseCompileAction()

    def test_metadata(self, action: ProseCompileAction) -> None:
        assert action.name == "PROSE_COMPILE"
        assert action.description is not None

    def test_has_similes(self, action: ProseCompileAction) -> None:
        assert isinstance(action.similes, list)
        assert len(action.similes) > 0

    # --- validate positive ---

    @pytest.mark.asyncio
    async def test_validate_prose_compile(self, action: ProseCompileAction) -> None:
        msg = make_message("prose compile workflow.prose")
        assert await action.validate(msg) is True

    @pytest.mark.asyncio
    async def test_validate_prose_validate(self, action: ProseCompileAction) -> None:
        msg = make_message("prose validate test.prose")
        assert await action.validate(msg) is True

    @pytest.mark.asyncio
    async def test_validate_check_prose(self, action: ProseCompileAction) -> None:
        msg = make_message("check my-workflow.prose")
        assert await action.validate(msg) is True

    @pytest.mark.asyncio
    async def test_validate_validate_prose(self, action: ProseCompileAction) -> None:
        msg = make_message("validate my-workflow.prose")
        assert await action.validate(msg) is True

    # --- validate negative ---

    @pytest.mark.asyncio
    async def test_validate_unrelated(self, action: ProseCompileAction) -> None:
        msg = make_message("what is the weather today?")
        assert await action.validate(msg) is False

    @pytest.mark.asyncio
    async def test_validate_empty(self, action: ProseCompileAction) -> None:
        msg = make_message("")
        assert await action.validate(msg) is False

    # --- handler ---

    @pytest.mark.asyncio
    async def test_handler_no_file(self, action: ProseCompileAction) -> None:
        msg = make_message("prose compile")
        result = await action.handler(msg)
        assert result["success"] is False
        assert "specify" in result["text"].lower()

    # --- internal _basic_validate ---

    def test_basic_validate_valid(self, action: ProseCompileAction) -> None:
        content = 'program "test" version "1.0" { session main() {} }'
        result = action._basic_validate(content)
        assert result["valid"] is True
        assert result["errors"] == []

    def test_basic_validate_missing_program(self, action: ProseCompileAction) -> None:
        content = 'session main() { do stuff }'
        result = action._basic_validate(content)
        assert result["valid"] is False
        assert any("program" in e.lower() for e in result["errors"])

    def test_basic_validate_unbalanced_braces(self, action: ProseCompileAction) -> None:
        content = 'program "test" { session main() {'
        result = action._basic_validate(content)
        assert result["valid"] is False
        assert any("brace" in e.lower() for e in result["errors"])

    def test_basic_validate_no_session_warning(self, action: ProseCompileAction) -> None:
        content = 'program "test" version "1.0" { }'
        result = action._basic_validate(content)
        assert result["valid"] is True
        assert any("session" in w.lower() for w in result["warnings"])

    def test_basic_validate_no_version_warning(self, action: ProseCompileAction) -> None:
        content = 'program "test" { session main() {} }'
        result = action._basic_validate(content)
        assert result["valid"] is True
        assert any("version" in w.lower() for w in result["warnings"])

    # --- extract_file ---

    def test_extract_file_compile(self, action: ProseCompileAction) -> None:
        assert action._extract_file("prose compile workflow.prose") == "workflow.prose"

    def test_extract_file_validate(self, action: ProseCompileAction) -> None:
        assert action._extract_file("prose validate test.prose") == "test.prose"

    def test_extract_file_check(self, action: ProseCompileAction) -> None:
        assert action._extract_file("check my-workflow.prose") == "my-workflow.prose"

    def test_extract_file_none(self, action: ProseCompileAction) -> None:
        assert action._extract_file("nothing here") is None


# ═══════════════════════════════════════════════════════════════════════════
# ProseHelpAction
# ═══════════════════════════════════════════════════════════════════════════


class TestProseHelpAction:
    @pytest.fixture()
    def action(self) -> ProseHelpAction:
        return ProseHelpAction()

    def test_metadata(self, action: ProseHelpAction) -> None:
        assert action.name == "PROSE_HELP"
        assert action.description is not None

    def test_has_similes(self, action: ProseHelpAction) -> None:
        assert isinstance(action.similes, list)
        assert len(action.similes) > 0

    # --- validate positive ---

    @pytest.mark.asyncio
    async def test_validate_prose_help(self, action: ProseHelpAction) -> None:
        msg = make_message("prose help")
        assert await action.validate(msg) is True

    @pytest.mark.asyncio
    async def test_validate_prose_examples(self, action: ProseHelpAction) -> None:
        msg = make_message("prose examples")
        assert await action.validate(msg) is True

    @pytest.mark.asyncio
    async def test_validate_prose_syntax(self, action: ProseHelpAction) -> None:
        msg = make_message("prose syntax")
        assert await action.validate(msg) is True

    @pytest.mark.asyncio
    async def test_validate_how_to_write(self, action: ProseHelpAction) -> None:
        msg = make_message("how do I write a prose program?")
        assert await action.validate(msg) is True

    @pytest.mark.asyncio
    async def test_validate_what_is_openprose(self, action: ProseHelpAction) -> None:
        msg = make_message("what is openprose?")
        assert await action.validate(msg) is True

    @pytest.mark.asyncio
    async def test_validate_tutorial(self, action: ProseHelpAction) -> None:
        msg = make_message("openprose tutorial")
        assert await action.validate(msg) is True

    # --- validate negative ---

    @pytest.mark.asyncio
    async def test_validate_unrelated(self, action: ProseHelpAction) -> None:
        msg = make_message("what is the weather today?")
        assert await action.validate(msg) is False

    @pytest.mark.asyncio
    async def test_validate_empty(self, action: ProseHelpAction) -> None:
        msg = make_message("")
        assert await action.validate(msg) is False

    # --- handler ---

    @pytest.mark.asyncio
    async def test_handler_quick_reference(self, action: ProseHelpAction) -> None:
        msg = make_message("prose help")
        result = await action.handler(msg)
        assert result["success"] is True
        assert "OpenProse" in result["text"]
        assert "prose run" in result["text"]

    @pytest.mark.asyncio
    async def test_handler_examples_request(self, action: ProseHelpAction) -> None:
        msg = make_message("prose examples")
        result = await action.handler(msg)
        assert result["success"] is True
        assert "Example" in result["text"]
        assert "hello" in result["text"].lower()

    @pytest.mark.asyncio
    async def test_handler_guidance_request(self, action: ProseHelpAction) -> None:
        msg = make_message("how do I write a prose program?")
        result = await action.handler(msg)
        assert result["success"] is True
        assert "OpenProse" in result["text"]

    @pytest.mark.asyncio
    async def test_handler_returns_data(self, action: ProseHelpAction) -> None:
        msg = make_message("prose help")
        result = await action.handler(msg)
        assert "data" in result
