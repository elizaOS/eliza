"""
MCP-specific testing utilities

Provides utilities for testing MCP server functionality.
"""

import json
from typing import Any, Dict, List
import mcp.types as types


class MCPServerTester:
    """Utility class for testing MCP servers"""
    
    def __init__(self, server_instance):
        """Initialize with MCP server instance"""
        self.server = server_instance
    
    async def test_tool_exists(self, tool_name: str) -> bool:
        """Test if a tool exists in the server"""
        tools = await self.server.list_tools()
        tool_names = [tool.name for tool in tools]
        return tool_name in tool_names
    
    async def test_all_tools_exist(self, expected_tools: List[str]) -> Dict[str, bool]:
        """Test if all expected tools exist"""
        results = {}
        for tool_name in expected_tools:
            results[tool_name] = await self.test_tool_exists(tool_name)
        return results
    
    async def call_tool_safe(self, tool_name: str, arguments: Dict[str, Any]) -> List[types.TextContent]:
        """Call a tool and handle exceptions"""
        try:
            return await self.server.call_tool(tool_name, arguments)
        except Exception as e:
            return [types.TextContent(
                type="text",
                text=f"Exception calling {tool_name}: {str(e)}"
            )]
    
    async def test_tool_with_valid_args(self, tool_name: str, valid_args: Dict[str, Any]) -> bool:
        """Test tool with valid arguments"""
        response = await self.call_tool_safe(tool_name, valid_args)
        
        # Check that we got a response
        if not response or len(response) == 0:
            return False
        
        # Check that it's not an error message
        text = response[0].text
        return not text.startswith("Error:") and not text.startswith("Unknown tool:")
    
    async def test_tool_with_invalid_args(self, tool_name: str, invalid_args: Dict[str, Any]) -> bool:
        """Test tool with invalid arguments - should return error"""
        response = await self.call_tool_safe(tool_name, invalid_args)
        
        if not response or len(response) == 0:
            return True  # No response could indicate error handling
        
        text = response[0].text
        return text.startswith("Error:") or "not found" in text.lower()
    
    def validate_json_response(self, response: List[types.TextContent]) -> tuple[bool, Any]:
        """Validate that response contains valid JSON"""
        try:
            if not response or len(response) == 0:
                return False, None
            
            text = response[0].text
            data = json.loads(text)
            return True, data
        except (json.JSONDecodeError, IndexError):
            return False, None
    
    def validate_response_structure(self, response: List[types.TextContent], 
                                  expected_fields: List[str]) -> bool:
        """Validate that JSON response has expected structure"""
        is_valid, data = self.validate_json_response(response)
        if not is_valid:
            return False
        
        if isinstance(data, dict):
            return all(field in data for field in expected_fields)
        elif isinstance(data, list) and data and isinstance(data[0], dict):
            return all(field in data[0] for field in expected_fields)
        
        return False
    
    async def run_comprehensive_test(self, test_cases: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Run comprehensive tests with multiple test cases"""
        results = {
            "total_tests": len(test_cases),
            "passed": 0,
            "failed": 0,
            "details": []
        }
        
        for i, test_case in enumerate(test_cases):
            tool_name = test_case.get("tool")
            arguments = test_case.get("arguments", {})
            expected_fields = test_case.get("expected_fields", [])
            should_succeed = test_case.get("should_succeed", True)
            
            test_result = {
                "test_id": i + 1,
                "tool": tool_name,
                "arguments": arguments,
                "passed": False,
                "error": None
            }
            
            try:
                response = await self.call_tool_safe(tool_name, arguments)
                
                if should_succeed:
                    # Test should succeed
                    if expected_fields:
                        test_result["passed"] = self.validate_response_structure(response, expected_fields)
                    else:
                        # Just check that we got a non-error response
                        test_result["passed"] = not response[0].text.startswith("Error:")
                else:
                    # Test should fail
                    test_result["passed"] = response[0].text.startswith("Error:")
                
            except Exception as e:
                test_result["error"] = str(e)
                test_result["passed"] = not should_succeed  # Exception is "passed" if we expected failure
            
            results["details"].append(test_result)
            if test_result["passed"]:
                results["passed"] += 1
            else:
                results["failed"] += 1
        
        return results


class PerformanceTester:
    """Utility for testing MCP server performance"""
    
    def __init__(self, server_instance):
        self.server = server_instance
    
    async def time_tool_call(self, tool_name: str, arguments: Dict[str, Any]) -> float:
        """Time a single tool call in milliseconds"""
        import time
        
        start_time = time.time()
        await self.server.call_tool(tool_name, arguments)
        end_time = time.time()
        
        return (end_time - start_time) * 1000  # Convert to milliseconds
    
    async def benchmark_tool(self, tool_name: str, arguments: Dict[str, Any], 
                           iterations: int = 10) -> Dict[str, float]:
        """Benchmark a tool over multiple iterations"""
        times = []
        
        for _ in range(iterations):
            call_time = await self.time_tool_call(tool_name, arguments)
            times.append(call_time)
        
        return {
            "min_time_ms": min(times),
            "max_time_ms": max(times),
            "avg_time_ms": sum(times) / len(times),
            "total_time_ms": sum(times),
            "iterations": iterations
        }