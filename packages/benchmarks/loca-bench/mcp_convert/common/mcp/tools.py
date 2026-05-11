"""
Tool utilities for MCP servers

Provides utilities for defining and managing MCP tools.
"""

from typing import Any, Dict, List, Callable, Optional
import mcp.types as types
from dataclasses import dataclass


@dataclass
class ToolDefinition:
    """Definition of an MCP tool"""
    name: str
    description: str
    input_schema: Dict[str, Any]
    handler: Callable


class ToolRegistry:
    """Registry for managing MCP tools"""
    
    def __init__(self):
        """Initialize tool registry"""
        self.tools: Dict[str, ToolDefinition] = {}
    
    def register(self, 
                 name: str, 
                 description: str, 
                 input_schema: Dict[str, Any],
                 handler: Callable):
        """Register a new tool"""
        tool_def = ToolDefinition(
            name=name,
            description=description,
            input_schema=input_schema,
            handler=handler
        )
        self.tools[name] = tool_def
    
    def get_tool_definitions(self) -> List[types.Tool]:
        """Get MCP tool definitions"""
        return [
            types.Tool(
                name=tool_def.name,
                description=tool_def.description,
                inputSchema=tool_def.input_schema
            )
            for tool_def in self.tools.values()
        ]
    
    async def call_tool(self, name: str, arguments: Dict[str, Any]) -> List[types.TextContent]:
        """Call a registered tool"""
        if name not in self.tools:
            return [types.TextContent(
                type="text",
                text=f"Unknown tool: {name}"
            )]
        
        tool_def = self.tools[name]
        try:
            result = await tool_def.handler(arguments)
            if isinstance(result, list) and all(isinstance(r, types.TextContent) for r in result):
                return result
            elif isinstance(result, str):
                return [types.TextContent(type="text", text=result)]
            else:
                import json
                return [types.TextContent(
                    type="text", 
                    text=json.dumps(result, indent=2, ensure_ascii=False)
                )]
        except Exception as e:
            return [types.TextContent(
                type="text",
                text=f"Error executing {name}: {str(e)}"
            )]
    
    def validate_arguments(self, tool_name: str, arguments: Dict[str, Any]) -> tuple[bool, str]:
        """Validate tool arguments against schema"""
        if tool_name not in self.tools:
            return False, f"Tool {tool_name} not found"
        
        tool_def = self.tools[tool_name]
        schema = tool_def.input_schema
        
        # Basic validation - check required fields
        if 'required' in schema:
            required_fields = schema['required']
            missing_fields = [field for field in required_fields if field not in arguments]
            if missing_fields:
                return False, f"Missing required fields: {', '.join(missing_fields)}"
        
        # Type validation for properties
        if 'properties' in schema:
            properties = schema['properties']
            for field_name, value in arguments.items():
                if field_name in properties:
                    field_schema = properties[field_name]
                    if 'type' in field_schema:
                        expected_type = field_schema['type']
                        if not self._validate_type(value, expected_type):
                            return False, f"Field {field_name} should be of type {expected_type}"
        
        return True, ""
    
    def _validate_type(self, value: Any, expected_type: str) -> bool:
        """Validate value against expected JSON schema type"""
        type_mapping = {
            'string': str,
            'number': (int, float),
            'integer': int,
            'boolean': bool,
            'array': list,
            'object': dict
        }
        
        if expected_type in type_mapping:
            return isinstance(value, type_mapping[expected_type])
        
        return True  # Unknown type, allow it


def create_simple_tool_schema(required_params: List[str], 
                             optional_params: Dict[str, Dict[str, Any]] = None) -> Dict[str, Any]:
    """Create a simple tool input schema"""
    schema = {
        "type": "object",
        "properties": {},
        "required": required_params
    }
    
    # Add required parameters as string type by default
    for param in required_params:
        schema["properties"][param] = {"type": "string"}
    
    # Add optional parameters
    if optional_params:
        for param_name, param_config in optional_params.items():
            schema["properties"][param_name] = param_config
    
    return schema


def create_ticker_tool_schema(additional_required: List[str] = None, 
                             additional_optional: Dict[str, Dict[str, Any]] = None) -> Dict[str, Any]:
    """Create a tool schema for ticker-based tools (common pattern)"""
    required = ["ticker"]
    if additional_required:
        required.extend(additional_required)
    
    optional = additional_optional or {}
    
    return create_simple_tool_schema(required, optional)