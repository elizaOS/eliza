"""Tests for SWE-bench agent."""

import subprocess

import pytest

from benchmarks.swe_bench.agent import ParsedResponse, SWEAgent, parse_xml_response
from benchmarks.swe_bench.repo_manager import RepositoryManager


class TestParseXMLResponse:
    """Test XML response parsing."""

    def test_parse_complete_response(self) -> None:
        """Test parsing a complete XML response."""
        xml = """<response>
<thought>I need to search for the bug</thought>
<text>Searching for the issue...</text>
<actions>SEARCH_CODE</actions>
<params>
<SEARCH_CODE>
<query>ValidationError</query>
<file_pattern>*.py</file_pattern>
</SEARCH_CODE>
</params>
</response>"""
        
        result = parse_xml_response(xml)
        
        assert result.thought == "I need to search for the bug"
        assert result.text == "Searching for the issue..."
        assert result.action == "SEARCH_CODE"
        assert result.params.get("query") == "ValidationError"
        assert result.params.get("file_pattern") == "*.py"

    def test_parse_submit_action(self) -> None:
        """Test parsing SUBMIT action with empty params."""
        xml = """<response>
<thought>I've fixed the bug, time to submit</thought>
<text>Submitting solution</text>
<actions>SUBMIT</actions>
<params>
</params>
</response>"""
        
        result = parse_xml_response(xml)
        
        assert result.action == "SUBMIT"
        assert result.params == {}

    def test_parse_read_file_with_line_numbers(self) -> None:
        """Test parsing READ_FILE with line number params."""
        xml = """<response>
<thought>Reading specific lines</thought>
<text>Reading lines 10-20</text>
<actions>READ_FILE</actions>
<params>
<READ_FILE>
<file_path>src/main.py</file_path>
<start_line>10</start_line>
<end_line>20</end_line>
</READ_FILE>
</params>
</response>"""
        
        result = parse_xml_response(xml)
        
        assert result.action == "READ_FILE"
        assert result.params.get("file_path") == "src/main.py"
        assert result.params.get("start_line") == 10
        assert result.params.get("end_line") == 20

    def test_parse_edit_file(self) -> None:
        """Test parsing EDIT_FILE action."""
        xml = """<response>
<thought>Fixing the bug</thought>
<text>Editing the file</text>
<actions>EDIT_FILE</actions>
<params>
<EDIT_FILE>
<file_path>src/utils.py</file_path>
<old_content>return None</old_content>
<new_content>return result</new_content>
</EDIT_FILE>
</params>
</response>"""
        
        result = parse_xml_response(xml)
        
        assert result.action == "EDIT_FILE"
        assert result.params.get("file_path") == "src/utils.py"
        assert result.params.get("old_content") == "return None"
        assert result.params.get("new_content") == "return result"

    def test_parse_without_response_wrapper(self) -> None:
        """Test parsing without <response> wrapper (auto-wrapped)."""
        xml = """<thought>Thinking</thought>
<text>Doing something</text>
<actions>LIST_FILES</actions>
<params>
<LIST_FILES>
<directory>src</directory>
</LIST_FILES>
</params>"""
        
        result = parse_xml_response(xml)
        
        assert result.thought == "Thinking"
        assert result.action == "LIST_FILES"
        assert result.params.get("directory") == "src"

    def test_parse_action_case_insensitive(self) -> None:
        """Test that action parsing is case insensitive."""
        xml = """<response>
<thought>test</thought>
<text>test</text>
<actions>search_code</actions>
<params></params>
</response>"""
        
        result = parse_xml_response(xml)
        assert result.action == "SEARCH_CODE"

    def test_parse_empty_response(self) -> None:
        """Test parsing empty response."""
        result = parse_xml_response("")
        
        assert result.thought == ""
        assert result.text == ""
        assert result.action is None
        assert result.params == {}

    def test_parse_malformed_xml(self) -> None:
        """Test parsing malformed XML falls back to regex."""
        # Incomplete XML
        xml = "<thought>My thought</thought><actions>SUBMIT</actions>"
        
        result = parse_xml_response(xml)
        
        assert result.thought == "My thought"
        assert result.action == "SUBMIT"

    def test_parse_legacy_format(self) -> None:
        """Test parsing legacy ACTION: format as fallback."""
        text = """THOUGHT: I'm thinking about this
ACTION: SEARCH_CODE
PARAMS: {"query": "test"}"""
        
        result = parse_xml_response(text)
        
        # Should detect ACTION from legacy format
        assert result.action == "SEARCH_CODE"

    def test_parse_boolean_params(self) -> None:
        """Test parsing boolean parameter values."""
        xml = """<response>
<thought>test</thought>
<text>test</text>
<actions>TEST_ACTION</actions>
<params>
<TEST_ACTION>
<enabled>true</enabled>
<disabled>false</disabled>
</TEST_ACTION>
</params>
</response>"""
        
        result = parse_xml_response(xml)
        
        assert result.params.get("enabled") is True
        assert result.params.get("disabled") is False

    def test_parse_null_params(self) -> None:
        """Test parsing null parameter values."""
        xml = """<response>
<thought>test</thought>
<text>test</text>
<actions>TEST_ACTION</actions>
<params>
<TEST_ACTION>
<optional>null</optional>
</TEST_ACTION>
</params>
</response>"""
        
        result = parse_xml_response(xml)
        
        assert result.params.get("optional") is None


class TestParsedResponse:
    """Test ParsedResponse dataclass."""

    def test_create_parsed_response(self) -> None:
        """Test creating a ParsedResponse."""
        response = ParsedResponse(
            thought="thinking",
            text="doing",
            action="SEARCH_CODE",
            params={"query": "test"},
        )
        
        assert response.thought == "thinking"
        assert response.text == "doing"
        assert response.action == "SEARCH_CODE"
        assert response.params == {"query": "test"}

    def test_create_empty_parsed_response(self) -> None:
        """Test creating an empty ParsedResponse."""
        response = ParsedResponse(
            thought="",
            text="",
            action=None,
            params={},
        )
        
        assert response.action is None
        assert response.params == {}


class _RuntimeStub:
    agent_id = "test-agent"


@pytest.mark.asyncio
async def test_execute_action_search_code_works_without_runtime_action_payload(tmp_path) -> None:
    """Direct action execution should search code successfully."""
    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True, exist_ok=True)
    file_path = repo_root / "sample.py"
    file_path.write_text(
        "def demo():\n    return 'needle'\n",
        encoding="utf-8",
    )

    manager = RepositoryManager(str(tmp_path / "workspace"))
    manager.current_repo = repo_root
    manager._current_repo_resolved = repo_root.resolve()

    agent = SWEAgent(runtime=_RuntimeStub(), repo_manager=manager, max_steps=1)
    output = await agent._execute_action(
        "SEARCH_CODE",
        {"query": "needle", "file_pattern": "*.py"},
    )
    assert "Found 1 matches:" in output
    assert "sample.py:2:" in output


@pytest.mark.asyncio
async def test_execute_action_edit_file_and_submit_reports_patch(tmp_path) -> None:
    """EDIT_FILE followed by SUBMIT should produce real patch bytes."""
    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "init"],
        cwd=repo_root,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=repo_root,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test User"],
        cwd=repo_root,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    file_path = repo_root / "sample.py"
    file_path.write_text("def demo():\n    return 1\n", encoding="utf-8")
    subprocess.run(
        ["git", "add", "sample.py"],
        cwd=repo_root,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["git", "commit", "-m", "init"],
        cwd=repo_root,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    manager = RepositoryManager(str(tmp_path / "workspace"))
    manager.current_repo = repo_root
    manager._current_repo_resolved = repo_root.resolve()

    agent = SWEAgent(runtime=_RuntimeStub(), repo_manager=manager, max_steps=1)
    edit_out = await agent._execute_action(
        "EDIT_FILE",
        {"file_path": "sample.py", "old_str": "return 1", "new_str": "return 2"},
    )
    assert "Successfully edited sample.py" in edit_out

    submit_out = await agent._execute_action("SUBMIT", {})
    assert "Submitted. has_changes=True. patch_bytes=" in submit_out
