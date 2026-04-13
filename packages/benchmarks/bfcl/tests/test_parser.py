"""
Tests for BFCL Function Call Parser
"""

import pytest

from benchmarks.bfcl.parser import FunctionCallParser


class TestFunctionCallParser:
    """Tests for the function call parser."""

    @pytest.fixture
    def parser(self) -> FunctionCallParser:
        return FunctionCallParser()

    def test_parse_json_single_call(self, parser: FunctionCallParser) -> None:
        """Test parsing a single JSON function call."""
        response = '{"name": "get_weather", "arguments": {"location": "NYC"}}'
        calls = parser.parse(response)

        assert len(calls) == 1
        assert calls[0].name == "get_weather"
        assert calls[0].arguments == {"location": "NYC"}

    def test_parse_json_array(self, parser: FunctionCallParser) -> None:
        """Test parsing JSON array of calls."""
        response = '''[
            {"name": "func1", "arguments": {"x": 1}},
            {"name": "func2", "arguments": {"y": 2}}
        ]'''
        calls = parser.parse(response)

        assert len(calls) == 2
        assert calls[0].name == "func1"
        assert calls[1].name == "func2"

    def test_parse_json_in_code_fence(self, parser: FunctionCallParser) -> None:
        """Test parsing JSON in code fences."""
        response = '''Here's the function call:
```json
{"name": "search", "arguments": {"query": "test"}}
```
'''
        calls = parser.parse(response)

        assert len(calls) == 1
        assert calls[0].name == "search"

    def test_parse_xml_format(self, parser: FunctionCallParser) -> None:
        """Test parsing XML function call format."""
        response = '''<function_call>
            <name>get_weather</name>
            <arguments>{"location": "SF"}</arguments>
        </function_call>'''
        calls = parser.parse(response)

        assert len(calls) == 1
        assert calls[0].name == "get_weather"
        assert calls[0].arguments["location"] == "SF"

    def test_parse_elizaos_params_format(self, parser: FunctionCallParser) -> None:
        """Test parsing ElizaOS params format."""
        response = '''<params>
            <GET_WEATHER>
                <location>San Francisco</location>
                <unit>celsius</unit>
            </GET_WEATHER>
        </params>'''
        calls = parser.parse(response)

        assert len(calls) == 1
        assert calls[0].name == "GET_WEATHER"
        assert calls[0].arguments["location"] == "San Francisco"
        assert calls[0].arguments["unit"] == "celsius"

    def test_parse_natural_language(self, parser: FunctionCallParser) -> None:
        """Test parsing function calls from natural language."""
        response = "I'll call get_weather(location='NYC', unit='fahrenheit')"
        calls = parser.parse(response)

        assert len(calls) == 1
        assert calls[0].name == "get_weather"
        assert calls[0].arguments["location"] == "NYC"

    def test_parse_empty_response(self, parser: FunctionCallParser) -> None:
        """Test parsing empty response."""
        assert parser.parse("") == []
        assert parser.parse("   ") == []

    def test_parse_no_function_calls(self, parser: FunctionCallParser) -> None:
        """Test parsing text with no function calls."""
        response = "I cannot help with that request."
        calls = parser.parse(response)
        assert len(calls) == 0

    def test_parse_tool_calls_format(self, parser: FunctionCallParser) -> None:
        """Test parsing OpenAI tool_calls format."""
        response = '''{
            "tool_calls": [
                {
                    "type": "function",
                    "function": {"name": "search", "arguments": {"query": "test"}}
                }
            ]
        }'''
        calls = parser.parse(response)

        assert len(calls) == 1
        assert calls[0].name == "search"

    def test_parse_numeric_arguments(self, parser: FunctionCallParser) -> None:
        """Test parsing numeric argument values."""
        response = '{"name": "calculate", "arguments": {"value": 42, "factor": 1.5}}'
        calls = parser.parse(response)

        assert len(calls) == 1
        assert calls[0].arguments["value"] == 42
        assert calls[0].arguments["factor"] == 1.5

    def test_parse_boolean_arguments(self, parser: FunctionCallParser) -> None:
        """Test parsing boolean argument values."""
        response = '{"name": "set_flag", "arguments": {"enabled": true, "verbose": false}}'
        calls = parser.parse(response)

        assert len(calls) == 1
        assert calls[0].arguments["enabled"] is True
        assert calls[0].arguments["verbose"] is False

    def test_parse_nested_json(self, parser: FunctionCallParser) -> None:
        """Test parsing response with nested JSON in arguments."""
        response = '{"name": "configure", "arguments": {"config": {"key": "value"}}}'
        calls = parser.parse(response)

        assert len(calls) == 1
        assert calls[0].arguments["config"] == {"key": "value"}

    def test_parse_mixed_content(self, parser: FunctionCallParser) -> None:
        """Test parsing response with mixed content."""
        response = '''Let me help you with that.

```json
{"name": "get_info", "arguments": {"id": "123"}}
```

I've called the function above.'''
        calls = parser.parse(response)

        assert len(calls) == 1
        assert calls[0].name == "get_info"
