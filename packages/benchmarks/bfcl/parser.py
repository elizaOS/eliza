"""
BFCL Function Call Parser

Parses function calls from various response formats including:
- JSON format
- XML format (<params>)
- Natural language with tool use markers
"""

from __future__ import annotations

import json
import logging
import re
from typing import Optional
from xml.etree import ElementTree

from benchmarks.bfcl.types import ArgumentValue, FunctionCall

logger = logging.getLogger(__name__)


class FunctionCallParser:
    """
    Parse function calls from agent responses.

    Supports multiple formats:
    - JSON: {"name": "func", "arguments": {...}}
    - JSON array: [{"name": "func", "arguments": {...}}, ...]
    - XML: <function_call><name>func</name><arguments>...</arguments></function_call>
    - ElizaOS params: <params><FUNC><arg>value</arg></FUNC></params>
    - Natural language: "I'll call func(arg=value)"
    """

    # Patterns for extracting function calls
    JSON_PATTERN = re.compile(
        r'\{[^{}]*"name"\s*:\s*"([^"]+)"[^{}]*"arguments"\s*:\s*(\{[^{}]*\})[^{}]*\}',
        re.DOTALL,
    )
    FUNCTION_CALL_PATTERN = re.compile(
        r'(\w+)\s*\(\s*([^)]*)\s*\)',
        re.DOTALL,
    )
    XML_FUNCTION_PATTERN = re.compile(
        r'<function_call>(.*?)</function_call>',
        re.DOTALL | re.IGNORECASE,
    )

    def __init__(
        self,
        prefer_json: bool = True,
        extract_from_text: bool = True,
    ):
        """
        Initialize parser.

        Args:
            prefer_json: If True, try JSON parsing first
            extract_from_text: If True, try to extract from natural language
        """
        self.prefer_json = prefer_json
        self.extract_from_text = extract_from_text

    def parse(self, response: str) -> list[FunctionCall]:
        """
        Extract function calls from a response string.

        Args:
            response: The raw response text

        Returns:
            List of parsed function calls
        """
        if not response or not response.strip():
            return []

        calls: list[FunctionCall] = []

        # Try JSON parsing first
        if self.prefer_json:
            json_calls = self._parse_json(response)
            if json_calls:
                return json_calls

        # Try XML parsing
        xml_calls = self._parse_xml(response)
        if xml_calls:
            return xml_calls

        # Try ElizaOS params format
        params_calls = self._parse_elizaos_params(response)
        if params_calls:
            return params_calls

        # Try natural language extraction
        if self.extract_from_text:
            text_calls = self._parse_natural_language(response)
            if text_calls:
                return text_calls

        return calls

    def _parse_json(self, response: str) -> list[FunctionCall]:
        """Parse JSON formatted function calls."""
        calls: list[FunctionCall] = []

        # Try to parse as full JSON first
        try:
            # Look for JSON blocks in code fences
            json_blocks = re.findall(
                r'```(?:json)?\s*([\s\S]*?)```',
                response,
            )
            for block in json_blocks:
                parsed = json.loads(block)
                calls.extend(self._extract_calls_from_json(parsed))
                if calls:
                    return calls
        except json.JSONDecodeError:
            pass

        # Try to find JSON objects directly
        try:
            # Find all potential JSON objects
            start = response.find('{')
            while start != -1:
                # Try to find matching closing brace
                depth = 0
                end = start
                for i, char in enumerate(response[start:], start):
                    if char == '{':
                        depth += 1
                    elif char == '}':
                        depth -= 1
                        if depth == 0:
                            end = i + 1
                            break

                if end > start:
                    try:
                        obj = json.loads(response[start:end])
                        extracted = self._extract_calls_from_json(obj)
                        calls.extend(extracted)
                    except json.JSONDecodeError:
                        pass

                start = response.find('{', end)

        except Exception:
            pass

        return calls

    def _extract_calls_from_json(self, data: object) -> list[FunctionCall]:
        """Extract function calls from parsed JSON data."""
        calls: list[FunctionCall] = []

        if isinstance(data, list):
            for item in data:
                calls.extend(self._extract_calls_from_json(item))
        elif isinstance(data, dict):
            # Direct function call format
            if "name" in data and ("arguments" in data or "parameters" in data):
                name = str(data["name"])
                args = data.get("arguments", data.get("parameters", {}))
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except json.JSONDecodeError:
                        args = {}
                if isinstance(args, dict):
                    # Normalize arguments to proper types
                    normalized_args = self._normalize_arguments(args)
                    calls.append(FunctionCall(name=name, arguments=normalized_args))

            # Function wrapper format
            elif "function" in data:
                func = data["function"]
                if isinstance(func, dict):
                    calls.extend(self._extract_calls_from_json(func))

            # Tool calls format (OpenAI style)
            elif "tool_calls" in data:
                tool_calls = data["tool_calls"]
                if isinstance(tool_calls, list):
                    for tc in tool_calls:
                        if isinstance(tc, dict):
                            func = tc.get("function", {})
                            if isinstance(func, dict):
                                calls.extend(self._extract_calls_from_json(func))

        return calls

    def _normalize_arguments(self, args: dict[str, object]) -> dict[str, ArgumentValue]:
        """Normalize argument dict to proper types."""
        normalized: dict[str, ArgumentValue] = {}
        for key, value in args.items():
            # First normalize the JSON value
            norm_val = self._normalize_json_value(value)
            # Then apply type coercion and array flattening
            norm_val = self._coerce_types(norm_val)
            norm_val = self._flatten_single_element_arrays(norm_val)
            normalized[str(key)] = norm_val
        return normalized
    
    def _coerce_types(self, value: ArgumentValue) -> ArgumentValue:
        """Coerce string values to proper types where possible."""
        if isinstance(value, str):
            # Try to convert string numbers to actual numbers
            if value.isdigit():
                return int(value)
            try:
                # Check for float-like strings
                if '.' in value or 'e' in value.lower():
                    return float(value)
            except ValueError:
                pass
            # Try negative numbers
            if value.startswith('-') and value[1:].isdigit():
                return int(value)
        elif isinstance(value, list):
            return [self._coerce_types(v) for v in value]
        elif isinstance(value, dict):
            return {k: self._coerce_types(v) for k, v in value.items()}
        return value
    
    def _flatten_single_element_arrays(self, value: ArgumentValue) -> ArgumentValue:
        """
        Flatten unnecessarily nested single-element arrays.
        
        E.g., [["value"]] -> ["value"]
        """
        if isinstance(value, list):
            # Recursively process list elements
            processed = [self._flatten_single_element_arrays(v) for v in value]
            # Check if this is a single-element list containing another list
            if len(processed) == 1 and isinstance(processed[0], list):
                # Flatten: [[a, b]] -> [a, b]
                return processed[0]
            return processed
        elif isinstance(value, dict):
            return {k: self._flatten_single_element_arrays(v) for k, v in value.items()}
        return value

    def _parse_xml(self, response: str) -> list[FunctionCall]:
        """Parse XML formatted function calls."""
        calls: list[FunctionCall] = []

        # Find function_call XML blocks
        matches = self.XML_FUNCTION_PATTERN.findall(response)
        for match in matches:
            try:
                # Wrap in root element if needed
                xml_str = f"<root>{match}</root>"
                root = ElementTree.fromstring(xml_str)

                name_elem = root.find(".//name")
                args_elem = root.find(".//arguments")

                if name_elem is not None and name_elem.text:
                    name = name_elem.text.strip()
                    arguments: dict[str, ArgumentValue] = {}

                    if args_elem is not None:
                        # Try parsing arguments as JSON
                        if args_elem.text:
                            try:
                                arguments = json.loads(args_elem.text)
                            except json.JSONDecodeError:
                                pass
                        # Or extract from child elements
                        else:
                            for child in args_elem:
                                if child.text:
                                    arguments[child.tag] = self._parse_value(child.text)

                    calls.append(FunctionCall(name=name, arguments=arguments))

            except ElementTree.ParseError:
                continue

        return calls

    def _parse_elizaos_params(self, response: str) -> list[FunctionCall]:
        """Parse ElizaOS <params> format."""
        calls: list[FunctionCall] = []

        # Find params blocks
        params_pattern = re.compile(
            r'<params>(.*?)</params>',
            re.DOTALL | re.IGNORECASE,
        )
        matches = params_pattern.findall(response)

        for match in matches:
            try:
                # Parse as XML
                xml_str = f"<root>{match}</root>"
                root = ElementTree.fromstring(xml_str)

                # Each child of root is an action/function
                for action_elem in root:
                    name = action_elem.tag
                    arguments: dict[str, ArgumentValue] = {}

                    # Each child of action is a parameter
                    for param_elem in action_elem:
                        if param_elem.text:
                            arguments[param_elem.tag] = self._parse_value(param_elem.text)

                    if name.lower() != "root":
                        calls.append(FunctionCall(name=name, arguments=arguments))

            except ElementTree.ParseError:
                continue

        return calls

    def _parse_natural_language(self, response: str) -> list[FunctionCall]:
        """Extract function calls from natural language text."""
        calls: list[FunctionCall] = []

        # Look for function call patterns like "func(arg=value)"
        matches = self.FUNCTION_CALL_PATTERN.findall(response)

        for name, args_str in matches:
            # Skip common non-function words
            if name.lower() in (
                "if", "for", "while", "with", "def", "class",
                "return", "print", "input", "len", "str", "int",
            ):
                continue

            arguments = self._parse_arguments_string(args_str)
            if arguments is not None:
                calls.append(FunctionCall(name=name, arguments=arguments))

        return calls

    def _parse_arguments_string(self, args_str: str) -> Optional[dict[str, ArgumentValue]]:
        """Parse a comma-separated arguments string."""
        if not args_str.strip():
            return {}

        arguments: dict[str, ArgumentValue] = {}

        # Split by comma, but respect nested structures
        parts = self._split_arguments(args_str)

        for part in parts:
            part = part.strip()
            if "=" in part:
                key, value = part.split("=", 1)
                arguments[key.strip()] = self._parse_value(value.strip())
            elif part:
                # Positional argument - use index as key
                arguments[f"arg_{len(arguments)}"] = self._parse_value(part)

        return arguments

    def _split_arguments(self, args_str: str) -> list[str]:
        """Split arguments string respecting nested structures."""
        parts: list[str] = []
        current = ""
        depth = 0

        for char in args_str:
            if char in "([{":
                depth += 1
                current += char
            elif char in ")]}":
                depth -= 1
                current += char
            elif char == "," and depth == 0:
                parts.append(current)
                current = ""
            else:
                current += char

        if current:
            parts.append(current)

        return parts

    def _parse_value(self, value: str) -> ArgumentValue:
        """Parse a string value into appropriate Python type."""
        value = value.strip()

        # Remove quotes
        if (value.startswith('"') and value.endswith('"')) or \
           (value.startswith("'") and value.endswith("'")):
            return value[1:-1]

        # Try boolean
        if value.lower() == "true":
            return True
        if value.lower() == "false":
            return False
        if value.lower() in ("null", "none"):
            return None

        # Try numeric
        try:
            if "." in value:
                return float(value)
            return int(value)
        except ValueError:
            pass

        # Try JSON
        try:
            parsed = json.loads(value)
            return self._normalize_json_value(parsed)
        except json.JSONDecodeError:
            pass

        return value

    def _normalize_json_value(self, value: object) -> ArgumentValue:
        """Normalize a JSON-parsed value to ArgumentValue type."""
        if value is None:
            return None
        if isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, list):
            return [self._normalize_json_value(v) for v in value]
        if isinstance(value, dict):
            return {str(k): self._normalize_json_value(v) for k, v in value.items()}
        return str(value)
