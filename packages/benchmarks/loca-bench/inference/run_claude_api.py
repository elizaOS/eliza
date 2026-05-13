# Copyright 2025 AxonRL Team. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Parallel inference runner using Claude API directly with MCP tools."""

import json
import os
import time
import importlib
import random
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Optional, List, Dict, Any

try:
    import fire
except ModuleNotFoundError:  # pragma: no cover - only needed for programmatic runners
    class _MissingFire:
        @staticmethod
        def Fire(*_args: object, **_kwargs: object) -> None:
            raise ModuleNotFoundError(
                "The optional 'fire' package is required only for the "
                "run_claude_api.py command-line entrypoint."
            )

    fire = _MissingFire()
import anthropic
from dotenv import load_dotenv

# Import all potential tools and wrappers
from gem.tools.mcp_tool import MCPTool
from gem.tools.mcp_server.programmatic_tool_calling.helper import ProgrammaticToolCallingTool
from gem.tools.tool_env_wrapper import ToolEnvWrapperClaimDone, ToolEnvWrapperOpenAI
from gem.tools.mcp_server.config_loader import build_server_config
from gem.tools.mcp_server.canvas.helper import get_canvas_stdio_config
from gem.tools.mcp_server.claim_done.helper import get_claim_done_stdio_config
from gem.tools.mcp_server.filesystem.helper import get_filesystem_stdio_config
from gem.tools.mcp_server.memory.helper import get_memory_stdio_config
from gem.tools.mcp_server.memory_tool.helper import get_memory_tool_stdio_config
from gem.tools.mcp_server.python_execute.helper import get_python_execute_stdio_config
from gem.tools.mcp_server.programmatic_tool_calling.helper import get_programmatic_tool_calling_stdio_config
from gem.tools.mcp_server.emails.helper import get_email_stdio_config
from gem.tools.mcp_server.excel.helper import get_excel_stdio_config
from gem.tools.mcp_server.terminal.helper import get_terminal_stdio_config
from gem.tools.mcp_server.google_cloud.helper import get_google_cloud_stdio_config
from gem.tools.mcp_server.google_sheet.helper import get_google_sheet_stdio_config
from gem.tools.mcp_server.pdf_tools.helper import get_pdf_tools_stdio_config
from gem.tools.mcp_server.calendar_server.helper import get_calendar_stdio_config
from gem.tools.mcp_server.woocommerce.helper import get_woocommerce_stdio_config
from gem.tools.mcp_server.snowflake.helper import get_snowflake_stdio_config
from inference.common.output_io import (
    build_task_workspace,
    write_all_trajectories_file,
    write_eval_file,
    write_results_file,
    write_summary_file,
    write_trajectory_file,
)
from inference.common.trajectory_schema import (
    attach_conversation,
    attach_events,
    attach_metrics,
    attach_provider_payload,
    make_base_envelope,
)

load_dotenv()


# Claude API Pricing (per 1M tokens)
# See: https://www.anthropic.com/pricing#anthropic-api
CLAUDE_PRICING = {
    "claude-sonnet-4-5": {
        "input": 3.00,           # $3.00 per 1M input tokens
        "output": 15.00,         # $15.00 per 1M output tokens
        "cache_write": 3.75,     # $3.75 per 1M cache write tokens
        "cache_read": 0.30,      # $0.30 per 1M cache read tokens
    },
    # Default pricing (use Sonnet 4.5 as fallback)
    "default": {
        "input": 3.00,
        "output": 15.00,
        "cache_write": 3.75,
        "cache_read": 0.30,
    }
}


def calculate_cost(usage, model: str = "claude-sonnet-4-5") -> float:
    """Calculate cost in USD based on token usage.

    Args:
        usage: Usage object from Claude API with token counts
        model: Model name for pricing lookup

    Returns:
        Cost in USD
    """
    # Get pricing for model (use default if model not found)
    pricing = CLAUDE_PRICING.get(model, CLAUDE_PRICING["default"])

    # Extract token counts
    input_tokens = getattr(usage, 'input_tokens', 0)
    output_tokens = getattr(usage, 'output_tokens', 0)
    cache_creation_tokens = getattr(usage, 'cache_creation_input_tokens', 0) or 0
    cache_read_tokens = getattr(usage, 'cache_read_input_tokens', 0) or 0

    # Calculate cost (pricing is per 1M tokens)
    cost = (
        (input_tokens * pricing["input"] / 1_000_000) +
        (output_tokens * pricing["output"] / 1_000_000) +
        (cache_creation_tokens * pricing["cache_write"] / 1_000_000) +
        (cache_read_tokens * pricing["cache_read"] / 1_000_000)
    )

    return cost


def dynamic_import_class(class_path: str):
    """Dynamically import a class from a module path.

    Args:
        class_path: Full path to class, e.g., 'gem.envs.canvas_list_test_s2l.canvas_list_test_s2l.CanvasListTestS2LEnv'

    Returns:
        The imported class
    """
    module_path, class_name = class_path.rsplit('.', 1)
    module = importlib.import_module(module_path)
    return getattr(module, class_name)


def setup_mcp_servers(
    mcp_configs: Dict[str, Any],
    task_workspace: Path,
    agent_workspace: Path,
) -> Dict[str, Any]:
    """Setup MCP servers based on configuration.
    
    Args:
        mcp_configs: Dictionary of MCP server configurations
        task_workspace: Path to task workspace
        agent_workspace: Path to agent workspace
    
    Returns:
        Dictionary with mcpServers configuration
    """
    config = {"mcpServers": {}}
    
    for server_name, server_config in mcp_configs.items():
        if not server_config.get("enabled", True):
            continue
            
        server_type = server_config.get("type")
        params = server_config.get("params", {})
        
        # Replace path placeholders
        for key, value in params.items():
            if isinstance(value, str):
                value = value.replace("{task_workspace}", str(task_workspace))
                value = value.replace("{agent_workspace}", str(agent_workspace))
                params[key] = value

        # Add workspace paths to params for placeholder replacement in YAML loader
        params["task_workspace"] = str(task_workspace)
        params["agent_workspace"] = str(agent_workspace)

        # Try YAML-based config first, fall back to legacy helpers
        try:
            server_cfg = build_server_config(
                server_type=server_type,
                params=params,
                server_name=server_name
            )
        except FileNotFoundError:
            # Fallback to legacy helpers during migration
            if server_type == "canvas":
                server_cfg = get_canvas_stdio_config(**params)
            elif server_type == "email":
                server_cfg = get_email_stdio_config(**params)
            elif server_type == "excel":
                server_cfg = get_excel_stdio_config(**params)
            elif server_type == "python_execute":
                server_cfg = get_python_execute_stdio_config(**params)
            elif server_type == "programmatic_tool_calling" or server_type == "programmatic-tool-calling":
                server_cfg = get_programmatic_tool_calling_stdio_config(**params)
            elif server_type == "claim_done":
                server_cfg = get_claim_done_stdio_config(**params)
            elif server_type == "memory":
                server_cfg = get_memory_stdio_config(**params)
            elif server_type == "memory_tool" or server_type == "memory-tool":
                server_cfg = get_memory_tool_stdio_config(**params)
            elif server_type == "filesystem":
                server_cfg = get_filesystem_stdio_config(**params)
            elif server_type == "terminal":
                server_cfg = get_terminal_stdio_config(**params)
            elif server_type == "google_cloud":
                server_cfg = get_google_cloud_stdio_config(**params)
            elif server_type == "google_sheet" or server_type == "google-sheet":
                server_cfg = get_google_sheet_stdio_config(**params)
            elif server_type == "pdf_tools" or server_type == "pdf-tools":
                server_cfg = get_pdf_tools_stdio_config(**params)
            elif server_type == "calendar":
                server_cfg = get_calendar_stdio_config(**params)
            elif server_type == "woocommerce":
                server_cfg = get_woocommerce_stdio_config(**params)
            elif server_type == "snowflake":
                server_cfg = get_snowflake_stdio_config(**params)
            else:
                raise ValueError(f"Unknown MCP server type: {server_type}")
        
        config["mcpServers"].update(server_cfg)
    
    return config

def convert_tools_to_claude_format(
    openai_tools: List[Dict],
    add_cache_control: bool = False,
    include_memory_tool: bool = False,
    memory_tool_prefix: str = "memory_tool",
    include_code_execution: bool = False,
    enable_programmatic_tool_calling: bool = False,
) -> List[Dict]:
    """Convert OpenAI tool format to Claude API tool format.

    Args:
        openai_tools: List of tools in OpenAI format
        add_cache_control: If True, add cache_control to the last tool for prompt caching
        include_memory_tool: If True, add Claude's native memory_20250818 tool and filter out
                            MCP memory tools (they will be called via the native tool interface)
        memory_tool_prefix: Prefix for MCP memory tools to filter out (default: "memory_tool")
        include_code_execution: If True, add Claude's native code_execution_20250825 tool
        enable_programmatic_tool_calling: If True, add allowed_callers field to tools so they
                            can be called programmatically from within code execution

    Returns:
        List of tools in Claude API format
    """
    claude_tools = []

    # MCP memory tool names that should be filtered when using native memory tool
    memory_tool_names = {
        f"{memory_tool_prefix}_view",
        f"{memory_tool_prefix}_create",
        f"{memory_tool_prefix}_str_replace",
        f"{memory_tool_prefix}_insert",
        f"{memory_tool_prefix}_delete",
        f"{memory_tool_prefix}_rename",
    }

    filtered_count = 0
    for tool in openai_tools:
        if tool.get("type") == "function":
            function = tool.get("function", {})
            tool_name = function.get("name")

            # Skip MCP memory tools when using native memory tool
            # (Claude will use the native memory_20250818 tool instead)
            if include_memory_tool and tool_name in memory_tool_names:
                filtered_count += 1
                print(f"  [DEBUG] Filtering out MCP memory tool: {tool_name}")
                continue

            claude_tool = {
                "name": tool_name,
                "description": function.get("description", ""),
                "input_schema": function.get("parameters", {})
            }
            # Add allowed_callers for programmatic tool calling
            # When enabled, tools can be called from within code execution
            if enable_programmatic_tool_calling:
                claude_tool["allowed_callers"] = ["code_execution_20250825"]
            claude_tools.append(claude_tool)

    if include_memory_tool and filtered_count > 0:
        print(f"  [DEBUG] Filtered out {filtered_count} MCP memory tools")

    # Add Claude's native memory tool if requested
    if include_memory_tool:
        print(f"  [DEBUG] Adding native memory_20250818 tool (name='memory')")
        claude_tools.append({
            "type": "memory_20250818",
            "name": "memory"
        })

    # Add Claude's native code execution tool if requested
    if include_code_execution:
        print(f"  [DEBUG] Adding native code_execution_20250825 tool (name='code_execution')")
        claude_tools.append({
            "type": "code_execution_20250825",
            "name": "code_execution"
        })

    # Add cache_control to the last tool to cache all tool definitions
    if add_cache_control and claude_tools:
        claude_tools[-1]["cache_control"] = {"type": "ephemeral"}

    return claude_tools


def convert_memory_tool_call_to_mcp(tool_input: Dict[str, Any], server_name: str = "memory_tool") -> Dict[str, Any]:
    """Convert Claude's memory tool call to MCP tool call format.

    Claude's memory_20250818 tool uses a unified interface with a 'command' parameter,
    while MCP server exposes individual tools with server_name prefix (e.g., memory_tool_view).

    Args:
        tool_input: Input from Claude's memory tool call, e.g.:
            {"command": "view", "path": "/memories"}
            {"command": "create", "path": "/memories/notes.txt", "file_text": "..."}
        server_name: The MCP server name prefix (default: "memory_tool")

    Returns:
        Dict with 'tool_name' and 'arguments' for MCP tool call
    """
    command = tool_input.get("command")

    if command == "view":
        return {
            "tool_name": f"{server_name}_view",
            "arguments": {
                "path": tool_input.get("path"),
                "view_range": tool_input.get("view_range")
            }
        }
    elif command == "create":
        return {
            "tool_name": f"{server_name}_create",
            "arguments": {
                "path": tool_input.get("path"),
                "file_text": tool_input.get("file_text", "")
            }
        }
    elif command == "str_replace":
        return {
            "tool_name": f"{server_name}_str_replace",
            "arguments": {
                "path": tool_input.get("path"),
                "old_str": tool_input.get("old_str"),
                "new_str": tool_input.get("new_str", "")
            }
        }
    elif command == "insert":
        return {
            "tool_name": f"{server_name}_insert",
            "arguments": {
                "path": tool_input.get("path"),
                "insert_line": tool_input.get("insert_line"),
                "insert_text": tool_input.get("insert_text", "")
            }
        }
    elif command == "delete":
        return {
            "tool_name": f"{server_name}_delete",
            "arguments": {
                "path": tool_input.get("path")
            }
        }
    elif command == "rename":
        return {
            "tool_name": f"{server_name}_rename",
            "arguments": {
                "old_path": tool_input.get("old_path"),
                "new_path": tool_input.get("new_path")
            }
        }
    else:
        raise ValueError(f"Unknown memory tool command: {command}")


def extract_tool_calls_for_env(claude_message: anthropic.types.Message) -> Dict[str, Any]:
    """Extract tool calls from Claude message for env.step_openai().

    This is a minimal extraction - only extracts what env.step_openai needs.
    The original Claude message is preserved separately.

    Server tools (like code_execution, bash_code_execution, text_editor_code_execution)
    are handled internally by Claude and their results appear in the same response.
    These do NOT require external execution and are skipped.

    Programmatic tool calls (from code execution) have a 'caller' field with
    type='code_execution_20250825'. These require tool results to be returned
    so code execution can continue.

    Args:
        claude_message: Message from Claude API

    Returns:
        Dictionary with type and data for env.step_openai
        - type: "tool" for normal/programmatic tool calls
        - type: "programmatic_tool" for programmatic calls (requires tool_result only response)
        - type: "server_tool_only" for internal server tools
        - type: "pause_turn" for paused turns
        - type: "normal" for regular text responses
    """
    stop_reason = claude_message.stop_reason

    # Server tool types that are executed internally by Claude
    # These do not require external tool execution
    server_tool_types = {
        "server_tool_use",  # Generic server tool use marker
    }

    # Server tool result types (these appear in the same response)
    server_tool_result_types = {
        "bash_code_execution_tool_result",
        "text_editor_code_execution_tool_result",
    }

    # Helper function to extract tool calls from content blocks
    def extract_tool_calls_from_content(content_blocks):
        """Extract tool calls and programmatic tool calls from content blocks."""
        tool_calls = []
        programmatic_tool_calls = []

        for block in content_blocks:
            if block.type == "tool_use":
                # Check if this is a programmatic tool call (from code execution)
                caller = getattr(block, 'caller', None)
                is_programmatic = False
                if caller:
                    caller_type = getattr(caller, 'type', None)
                    if caller_type == "code_execution_20250825":
                        is_programmatic = True

                tool_call_info = {
                    "id": block.id,
                    "type": "function",
                    "function": {
                        "name": block.name,
                        "arguments": json.dumps(block.input)
                    }
                }

                if is_programmatic:
                    # Track the code execution tool_id for reference
                    tool_call_info["caller_tool_id"] = getattr(caller, 'tool_id', None)
                    programmatic_tool_calls.append(tool_call_info)
                else:
                    tool_calls.append(tool_call_info)

        return tool_calls, programmatic_tool_calls

    if stop_reason == "tool_use":
        tool_calls, programmatic_tool_calls = extract_tool_calls_from_content(claude_message.content)

        # If we have programmatic tool calls, they take precedence
        # (code execution is waiting for these results)
        if programmatic_tool_calls:
            return {"type": "programmatic_tool", "data": programmatic_tool_calls}

        # If we have regular tool calls, return them
        if tool_calls:
            return {"type": "tool", "data": tool_calls}

        # If only server tools were used (no external tool calls), return special type
        # This indicates Claude used internal tools (code_execution) and we should NOT call env.step()
        # Instead, we continue the loop to let Claude proceed with its turn
        # Check if there were any server tool uses in this response
        has_server_tools = any(
            getattr(block, 'type', None) == 'server_tool_use'
            for block in claude_message.content
        )
        content_text = ""
        for block in claude_message.content:
            if block.type == "text":
                content_text += block.text

        if has_server_tools:
            # Server tools were used - don't call env.step(), continue loop
            return {"type": "server_tool_only", "data": [content_text]}
        else:
            # No tools at all, treat as normal response
            return {"type": "normal", "data": [content_text]}
    elif stop_reason == "pause_turn":
        # pause_turn indicates a long-running turn was paused by the API
        # IMPORTANT: Even with pause_turn, there might be programmatic tool calls
        # that need to be processed. Check for them first!
        tool_calls, programmatic_tool_calls = extract_tool_calls_from_content(claude_message.content)

        # If we have programmatic tool calls, they take precedence
        # (code execution is waiting for these results)
        if programmatic_tool_calls:
            return {"type": "programmatic_tool", "data": programmatic_tool_calls}

        # If we have regular tool calls, return them
        if tool_calls:
            return {"type": "tool", "data": tool_calls}

        # No tool calls, treat as regular pause_turn
        content_text = ""
        for block in claude_message.content:
            if block.type == "text":
                content_text += block.text
        return {"type": "pause_turn", "data": [content_text]}
    else:
        # For non-tool responses, still check for programmatic tool calls
        # (in case stop_reason is something unexpected but content has tool_use)
        tool_calls, programmatic_tool_calls = extract_tool_calls_from_content(claude_message.content)

        if programmatic_tool_calls:
            return {"type": "programmatic_tool", "data": programmatic_tool_calls}

        if tool_calls:
            return {"type": "tool", "data": tool_calls}

        # Extract text content for normal response
        content_text = ""
        for block in claude_message.content:
            if block.type == "text":
                content_text += block.text
        return {"type": "normal", "data": [content_text]}


def convert_tool_results_to_claude(tool_results_json: str) -> List[Dict[str, Any]]:
    """Convert env.step_openai tool results to Claude tool_result format.

    Args:
        tool_results_json: JSON string from env.step_openai, e.g.:
            '[{"role": "tool", "tool_call_id": "...", "content": "..."}]'

    Returns:
        List of Claude tool_result content blocks
    """
    try:
        tool_results = json.loads(tool_results_json)
    except (json.JSONDecodeError, TypeError):
        return []

    claude_tool_results = []
    for result in tool_results:
        if result.get("role") == "tool":
            claude_tool_results.append({
                "type": "tool_result",
                "tool_use_id": result.get("tool_call_id"),
                "content": result.get("content", "")
            })
    return claude_tool_results


def claude_message_to_dict(claude_message: anthropic.types.Message) -> Dict[str, Any]:
    """Convert Claude API message to a serializable dict for storage.

    Uses model_dump() to preserve the original Claude message structure.

    Args:
        claude_message: Message from Claude API

    Returns:
        Serializable dictionary representation
    """
    return {
        "role": "assistant",
        "content": [block.model_dump(exclude_none=True) for block in claude_message.content]
    }


def add_cache_control_to_messages(
    claude_messages: List[Dict],
    cache_first_user: bool = True,
    cache_breakpoint_indices: Optional[List[int]] = None
) -> None:
    """Add cache_control markers to Claude messages in-place.

    Prompt Caching Strategy:
        - cache_first_user=True: Add cache_control to the first user message
        - cache_breakpoint_indices: Additional message indices for cache breakpoints

    Args:
        claude_messages: List of messages in Claude format (modified in-place)
        cache_first_user: If True, add cache_control to the first user message
        cache_breakpoint_indices: List of message indices for additional cache breakpoints
    """
    def add_cache_to_message(idx: int):
        if idx < 0 or idx >= len(claude_messages):
            return
        content = claude_messages[idx].get("content")
        if isinstance(content, list) and len(content) > 0:
            last_block = content[-1]
            if isinstance(last_block, dict):
                last_block["cache_control"] = {"type": "ephemeral"}
        elif isinstance(content, str):
            claude_messages[idx]["content"] = [
                {
                    "type": "text",
                    "text": content,
                    "cache_control": {"type": "ephemeral"}
                }
            ]

    # Add cache_control to the first user message
    if cache_first_user and claude_messages:
        for i in range(len(claude_messages)):
            if claude_messages[i].get("role") == "user":
                add_cache_to_message(i)
                break

    # Add cache_control to specified breakpoint indices
    if cache_breakpoint_indices:
        for idx in cache_breakpoint_indices:
            add_cache_to_message(idx)


def trim_claude_messages(
    claude_messages: List[Dict],
    claude_tools: List[Dict],
    max_context_size: int,
    max_tokens: int,
    cache_breakpoint_indices: List[int],
    programmatic_message_indices: set,
    task_label: str = "",
) -> Dict[str, Any]:
    """Trim Claude messages if they exceed max_context_size.
    
    This function removes assistant and user (tool_result) messages from the beginning
    of the conversation until the total tokens fit within max_context_size - max_tokens.
    
    IMPORTANT: When messages are removed, cache_breakpoint_indices and 
    programmatic_message_indices are updated to reflect the new indices.
    
    Args:
        claude_messages: List of messages in Claude format (will be modified in-place)
        claude_tools: List of tools in Claude format (for token estimation)
        max_context_size: Maximum context size in tokens
        max_tokens: Maximum tokens to reserve for output
        cache_breakpoint_indices: List of message indices with cache_control (will be modified)
        programmatic_message_indices: Set of message indices for programmatic tool calls (will be modified)
        task_label: Label for logging
        
    Returns:
        Dictionary with trim info if trimming occurred, or empty dict if no trimming needed
    """
    import copy
    
    # Try to use tiktoken for token estimation
    try:
        import tiktoken
        tokenizer = tiktoken.get_encoding("cl100k_base")
        
        def estimate_tokens(obj):
            obj_str = json.dumps(obj, ensure_ascii=False)
            return len(tokenizer.encode(obj_str, disallowed_special=()))
    except ImportError:
        # Fallback: estimate ~4 chars per token
        def estimate_tokens(obj):
            obj_str = json.dumps(obj, ensure_ascii=False)
            return len(obj_str) // 4
    
    # Calculate current token usage
    messages_tokens = estimate_tokens(claude_messages)
    tools_tokens = estimate_tokens(claude_tools) if claude_tools else 0
    total_estimated_tokens = messages_tokens + tools_tokens
    available_context = max_context_size - max_tokens
    
    print(f"[{task_label}] 📊 Estimated tokens - Messages: {messages_tokens:,}, Tools: {tools_tokens:,}, Total: {total_estimated_tokens:,}")
    
    # Check if trimming is needed
    if total_estimated_tokens <= available_context:
        return {}  # No trimming needed
    
    print(f"[{task_label}] ⚠️  Total tokens ({total_estimated_tokens:,}) exceeds available context ({available_context:,} = {max_context_size:,} - {max_tokens:,}). Trimming messages...")
    
    original_message_count = len(claude_messages)
    original_cache_breakpoints = cache_breakpoint_indices.copy()
    original_programmatic_indices = programmatic_message_indices.copy()
    
    removed_count = 0
    removed_indices = []  # Track which indices were removed
    
    # Strategy: Remove assistant and user messages from the beginning (after first user message)
    # Keep the first user message (contains the task prompt)
    while len(claude_messages) > 1:  # Keep at least the first message
        # Calculate current token count
        current_tokens = estimate_tokens(claude_messages)
        current_total = current_tokens + tools_tokens
        
        # If we fit within the limit, we're done
        if current_total <= available_context:
            break
        
        # Find the first assistant or tool_result user message to remove (after first user message)
        removed_any = False
        for i in range(1, len(claude_messages)):  # Start from index 1 to keep first user message
            msg_role = claude_messages[i].get('role')
            
            if msg_role == 'assistant':
                # Remove assistant message
                removed_msg = claude_messages.pop(i)
                removed_count += 1
                removed_indices.append(i)
                removed_any = True
                
                # Check if this assistant message has tool_use blocks
                content = removed_msg.get('content', [])
                if isinstance(content, list):
                    tool_use_ids = set()
                    for block in content:
                        if isinstance(block, dict) and block.get('type') == 'tool_use':
                            tool_use_ids.add(block.get('id'))
                    
                    # If there are tool_use blocks, remove corresponding tool_result messages
                    if tool_use_ids:
                        j = i  # Start from where we just removed
                        while j < len(claude_messages):
                            next_msg = claude_messages[j]
                            if next_msg.get('role') == 'user':
                                next_content = next_msg.get('content', [])
                                if isinstance(next_content, list):
                                    # Check if this user message has matching tool_result blocks
                                    has_matching_tool_result = any(
                                        isinstance(block, dict) and 
                                        block.get('type') == 'tool_result' and
                                        block.get('tool_use_id') in tool_use_ids
                                        for block in next_content
                                    )
                                    if has_matching_tool_result:
                                        claude_messages.pop(j)
                                        removed_count += 1
                                        removed_indices.append(j)
                                        continue  # Don't increment j
                            j += 1
                break
            
            elif msg_role == 'user':
                # Check if this is a tool_result user message (without corresponding assistant)
                content = claude_messages[i].get('content', [])
                if isinstance(content, list) and any(
                    isinstance(block, dict) and block.get('type') == 'tool_result'
                    for block in content
                ):
                    # This is an orphaned tool_result message, remove it
                    claude_messages.pop(i)
                    removed_count += 1
                    removed_indices.append(i)
                    removed_any = True
                    break
        
        # If no assistant or tool_result message found to remove, we can't trim further
        if not removed_any:
            break
    
    # Update cache_breakpoint_indices to reflect new positions
    # Messages were removed from the beginning, so all indices shift down
    new_cache_breakpoints = []
    for old_idx in cache_breakpoint_indices:
        # Count how many removed indices were before this index
        shift = sum(1 for removed_idx in sorted(removed_indices) if removed_idx < old_idx)
        new_idx = old_idx - shift
        # Only keep if the index is still valid and wasn't removed
        if new_idx >= 0 and old_idx not in removed_indices and new_idx < len(claude_messages):
            new_cache_breakpoints.append(new_idx)
    
    cache_breakpoint_indices.clear()
    cache_breakpoint_indices.extend(new_cache_breakpoints)
    
    # Update programmatic_message_indices similarly
    new_programmatic_indices = set()
    for old_idx in programmatic_message_indices:
        shift = sum(1 for removed_idx in sorted(removed_indices) if removed_idx < old_idx)
        new_idx = old_idx - shift
        if new_idx >= 0 and old_idx not in removed_indices and new_idx < len(claude_messages):
            new_programmatic_indices.add(new_idx)
    
    programmatic_message_indices.clear()
    programmatic_message_indices.update(new_programmatic_indices)
    
    # Recalculate final token count
    final_messages_tokens = estimate_tokens(claude_messages)
    final_total_tokens = final_messages_tokens + tools_tokens
    
    print(f"[{task_label}] ✂️  Trimmed messages: {original_message_count} -> {len(claude_messages)} messages (removed {removed_count} messages)")
    print(f"[{task_label}] 📊 After trimming - Messages: {final_messages_tokens:,}, Tools: {tools_tokens:,}, Total: {final_total_tokens:,}")
    print(f"[{task_label}] 📦 Cache breakpoints updated: {original_cache_breakpoints} -> {cache_breakpoint_indices}")
    if original_programmatic_indices:
        print(f"[{task_label}] 🔧 Programmatic indices updated: {original_programmatic_indices} -> {programmatic_message_indices}")
    
    # Check if we still exceed the limit after trimming
    if final_total_tokens > available_context:
        print(f"[{task_label}] ⚠️  Warning: Still exceeds context after trimming ({final_total_tokens:,} > {available_context:,})")
    
    # Return trim info
    trim_info = {
        'original_message_count': original_message_count,
        'trimmed_message_count': len(claude_messages),
        'removed_count': removed_count,
        'original_total_tokens': total_estimated_tokens,
        'trimmed_total_tokens': final_total_tokens,
        'messages_tokens': final_messages_tokens,
        'tools_tokens': tools_tokens,
        'max_context_size': max_context_size,
        'max_tokens': max_tokens,
        'available_context': available_context,
        'original_cache_breakpoints': original_cache_breakpoints,
        'new_cache_breakpoints': list(cache_breakpoint_indices),
        'original_programmatic_indices': list(original_programmatic_indices),
        'new_programmatic_indices': list(programmatic_message_indices),
    }
    
    return trim_info


def run_single_task(
    task_id: int,
    config_id: int,
    run_id: int,
    base_task_dir: str,
    output_dir: str,
    env_class: str,
    env_params: Dict[str, Any],
    mcp_configs: Dict[str, Any],
    api_key: str,
    base_url: Optional[str] = None,
    model: str = "claude-sonnet-4-5",
    max_tool_uses: int = 100,
    max_tokens: int = 4096,
    # Extended thinking parameters
    enable_thinking: bool = False,
    thinking_budget_tokens: int = 10000,
    # Context management parameters
    use_clear_tool_uses: bool = False,
    clear_trigger_tokens: int = 180000,
    clear_keep_tool_uses: int = 3,
    clear_at_least_tokens: int = 5000,
    use_clear_thinking: bool = False,
    clear_keep_thinking_turns: int = 2,
    # Code execution parameters
    enable_code_execution: bool = False,
    # Programmatic tool calling parameters
    enable_programmatic_tool_calling: bool = False,
    # Context trimming parameters
    max_context_size: Optional[int] = None,
    # Unified output naming
    config_name: str = "",
):
    """Run a single task with Claude API.

    Extended Thinking:
        When enable_thinking=True, Claude will use extended thinking to reason through
        complex tasks. Thinking blocks are automatically preserved when using tool use,
        maintaining reasoning continuity across multiple tool calls.

    Args:
        task_id: Global unique identifier for this task instance
        config_id: Configuration group ID
        run_id: Run number within this configuration
        base_task_dir: Base directory for task data
        output_dir: Directory to save results
        env_class: Full path to environment class
        env_params: Parameters for environment initialization
        mcp_configs: MCP server configurations
        api_key: Anthropic API key
        base_url: Anthropic-compatible base URL (default: provider/library default)
        model: Claude model name
        max_tool_uses: Maximum number of tool uses
        max_tokens: Maximum tokens per generation
        enable_thinking: Enable extended thinking mode (adds thinking blocks to responses)
        thinking_budget_tokens: Maximum tokens for thinking budget (default: 10000)
        use_clear_tool_uses: Enable clear_tool_uses_20250919 feature
        clear_trigger_tokens: Token threshold to trigger clearing (default: 180000)
        clear_keep_tool_uses: Number of tool uses to keep after clearing (default: 3)
        clear_at_least_tokens: Minimum tokens to clear (default: 5000)
        use_clear_thinking: Enable clear_thinking_20251015 feature
        clear_keep_thinking_turns: Number of thinking turns to keep (default: 2)
        enable_code_execution: Enable code_execution_20250825 tool for Bash and file operations
        enable_programmatic_tool_calling: Enable Claude's official programmatic tool calling.
            When enabled, Claude can write Python code that calls your tools programmatically
            within a code execution container. This reduces latency for multi-tool workflows
            and allows Claude to filter/process data before it reaches the context window.
            Requires code_execution to be enabled (will auto-enable if not).
        max_context_size: Maximum context size in tokens. If set, messages will be trimmed
            from the beginning of the conversation to fit within this limit (reserving
            max_tokens for output). When trimming, cache breakpoint indices and programmatic
            message indices are updated to reflect the new message positions.

    Returns:
        Dictionary with task results including thinking_tracking and trim_events
    """
    task_label = f"Task{task_id}-Config{config_id}-Run{run_id}"
    print(f"[{task_label}] Starting...")
    print(f"[{task_label}] Environment: {env_class}")
    print(f"[{task_label}] Params: {env_params}")
    if base_url:
        print(f"[{task_label}] Anthropic base URL: {base_url}")

    # Print thinking configuration
    if enable_thinking:
        print(f"[{task_label}] Extended thinking: ENABLED")
        print(f"[{task_label}]   Budget tokens: {thinking_budget_tokens}")
    else:
        print(f"[{task_label}] Extended thinking: DISABLED")

    # Print code execution configuration
    if enable_code_execution:
        print(f"[{task_label}] Code execution: ENABLED")
    else:
        print(f"[{task_label}] Code execution: DISABLED")

    # Programmatic tool calling requires code execution - auto-enable if needed
    if enable_programmatic_tool_calling and not enable_code_execution:
        enable_code_execution = True
        print(f"[{task_label}] Programmatic tool calling: ENABLED (auto-enabled code_execution)")
    elif enable_programmatic_tool_calling:
        print(f"[{task_label}] Programmatic tool calling: ENABLED")
    else:
        print(f"[{task_label}] Programmatic tool calling: DISABLED")

    # Print context management configuration
    if use_clear_tool_uses or use_clear_thinking:
        print(f"[{task_label}] Context management: ENABLED")
        if use_clear_tool_uses:
            print(f"[{task_label}]   Clear tool uses: ON")
            print(f"[{task_label}]     Trigger: {clear_trigger_tokens} tokens")
            print(f"[{task_label}]     Keep: {clear_keep_tool_uses} tool uses")
            print(f"[{task_label}]     Clear at least: {clear_at_least_tokens} tokens")
        if use_clear_thinking:
            print(f"[{task_label}]   Clear thinking: ON")
            print(f"[{task_label}]     Keep: {clear_keep_thinking_turns} thinking turns")
    else:
        print(f"[{task_label}] Context management: DISABLED")

    # Print context trimming configuration
    if max_context_size is not None:
        print(f"[{task_label}] Context trimming: ENABLED")
        print(f"[{task_label}]   Max context size: {max_context_size:,} tokens")
    else:
        print(f"[{task_label}] Context trimming: DISABLED")

    # Create isolated directories for this task
    task_workspace = build_task_workspace(
        base_task_dir=base_task_dir,
        config_name=config_name,
        config_id=config_id,
        run_id=run_id,
    )
    task_workspace.mkdir(parents=True, exist_ok=True)

    local_db_dir = task_workspace / "local_db"
    agent_workspace = task_workspace / "agent_workspace"
    memory_dir = agent_workspace / "memory"

    # Ensure directories exist
    local_db_dir.mkdir(parents=True, exist_ok=True)
    agent_workspace.mkdir(parents=True, exist_ok=True)
    memory_dir.mkdir(parents=True, exist_ok=True)

    # Prepare output path and file
    if config_name:
        output_path = task_workspace
        save_file = task_workspace / "trajectory.json"
    else:
        output_path = Path(output_dir) / f"config_{config_id}"
        output_path.mkdir(parents=True, exist_ok=True)
        timestamp = int(time.time())
        save_file = output_path / f"config{config_id}_run{run_id}-episode-{timestamp}.json"

    episode = []
    full_messages_history = []
    usage_tracking = []  # Track per-step usage and cost
    context_management_events = []  # Track clear_tool_uses events
    thinking_tracking = []  # Track thinking block usage per step
    trim_events = []  # Track context trimming events

    # Cumulative tracking
    total_usage = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "total_cost_usd": 0.0,
    }

    try:
        # Dynamically import and instantiate environment class
        EnvClass = dynamic_import_class(env_class)

        # Prepare environment parameters with path replacements
        prepared_env_params = {}
        for key, value in env_params.items():
            if isinstance(value, str):
                value = value.replace("{task_workspace}", str(task_workspace))
                value = value.replace("{agent_workspace}", str(agent_workspace))
            prepared_env_params[key] = value

        # Add task_dir if not specified
        if "task_dir" not in prepared_env_params:
            prepared_env_params["task_dir"] = str(task_workspace)

        # Add random seed if not specified
        if "seed" not in prepared_env_params:
            prepared_env_params["seed"] = random.randint(0, 1000000)

        # Create environment
        env = EnvClass(**prepared_env_params)
        print(f"[{task_label}] Environment created successfully")

        # Setup MCP servers
        mcp_config = setup_mcp_servers(mcp_configs, task_workspace, agent_workspace)

        # Create tool - use ProgrammaticToolCallingTool if programmatic_tool_calling is enabled
        has_programmatic = any(
            config.get("type") in ["programmatic_tool_calling", "programmatic-tool-calling"]
            and config.get("enabled", True)
            for config in mcp_configs.values()
        )

        # Check if memory_tool is enabled - we'll use Claude's native memory tool
        has_memory_tool = any(
            config.get("type") in ["memory_tool", "memory-tool"]
            and config.get("enabled", True)
            for config in mcp_configs.values()
        )

        if has_programmatic:
            tool = ProgrammaticToolCallingTool(mcp_config, validate_on_init=False)
        else:
            tool = MCPTool(mcp_config, validate_on_init=False)

        env = ToolEnvWrapperOpenAI(env, tools=[tool], max_tool_uses=max_tool_uses)

        # Reset environment
        obs, info, user_prompt, tools = env.reset()

        # Save tools information for later storage
        tools_info = tools[0] if tools else None

        # Note: When memory_tool is enabled, we use Claude's native memory_20250818 tool
        # The MCP memory tools (view, create, str_replace, etc.) are filtered out from Claude's view
        # Claude calls the native 'memory' tool, which we convert to MCP format for execution
        if has_memory_tool:
            print(f"[{task_label}] Memory tool enabled - using Claude's native memory_20250818 tool")
            print(f"[{task_label}]   MCP memory tools will be filtered out, native 'memory' tool will be added")

        print(f"[{task_label}] Environment initialized")
        print(f"[{task_label}] Initial observation length: {len(obs)}")
        print(f"[{task_label}] User prompt length: {len(user_prompt)}")

        # Debug: Print original tool names before filtering
        if tools_info:
            original_tool_names = [t.get("function", {}).get("name") for t in tools_info if t.get("type") == "function"]
            print(f"[{task_label}] Original tools ({len(original_tool_names)}): {original_tool_names}")

        # Convert tools to Claude format with cache_control on the last tool
        claude_tools = convert_tools_to_claude_format(
            tools_info,
            add_cache_control=True,
            include_memory_tool=has_memory_tool,
            include_code_execution=enable_code_execution,
            enable_programmatic_tool_calling=enable_programmatic_tool_calling
        )

        # Debug: Print converted tool names after filtering
        converted_tool_names = [t.get("name") for t in claude_tools if t.get("name")]
        print(f"[{task_label}] Converted tools ({len(claude_tools)}): {converted_tool_names}")
        print(f"[{task_label}] has_memory_tool={has_memory_tool}, enable_code_execution={enable_code_execution}, programmatic_tool_calling={enable_programmatic_tool_calling}")

        # Initialize Claude client
        if base_url:
            client = anthropic.Anthropic(api_key=api_key, base_url=base_url)
        else:
            client = anthropic.Anthropic(api_key=api_key)

        # Initialize messages in Claude native format (no more format conversion!)
        claude_messages = [{"role": "user", "content": user_prompt}]

        # Run interaction loop
        done = False
        step_count = 0

        # Track cache breakpoint indices (Claude message indices where we added cache_control)
        cache_breakpoint_indices = []

        # Track container ID for programmatic tool calling
        # Container is reused across requests to maintain state
        container_id = None

        # Track message indices involved in programmatic tool calling
        # These cannot have cache_control as they are not rendered in Claude's context
        # Includes both: assistant messages with programmatic tool_use, and user messages with tool_results
        programmatic_message_indices = set()

        while not done:
            step_count += 1
            print(f"[{task_label}] Step {step_count}")

            # Periodically extend cache to include more context as conversation grows
            # IMPORTANT: Claude API allows maximum 4 cache breakpoints total
            # We reserve 1 for tools, so we can only have 3 cache breakpoints in messages
            should_extend_cache = step_count in [10, 20, 40, 80] or (step_count > 80 and step_count % 40 == 0)
            MAX_MESSAGE_CACHE_BREAKPOINTS = 3

            if should_extend_cache:
                # Find a valid cache breakpoint index (not a programmatic message)
                candidate_idx = len(claude_messages) - 1
                # Skip programmatic message indices - they cannot have cache_control
                while candidate_idx > 0 and candidate_idx in programmatic_message_indices:
                    candidate_idx -= 1

                if candidate_idx not in cache_breakpoint_indices and candidate_idx > 0:
                    total_breakpoints = 1 + len(cache_breakpoint_indices)

                    if total_breakpoints < MAX_MESSAGE_CACHE_BREAKPOINTS:
                        cache_breakpoint_indices.append(candidate_idx)
                        print(f"[{task_label}] 📦 Extending cache at step {step_count}, adding breakpoint at message index {candidate_idx}")
                    else:
                        removed_idx = cache_breakpoint_indices.pop(0)
                        cache_breakpoint_indices.append(candidate_idx)
                        print(f"[{task_label}] 📦 Extending cache at step {step_count}, replacing breakpoint at {removed_idx} with {candidate_idx}")

            # Trim messages if max_context_size is set and we exceed the limit
            # IMPORTANT: Trim BEFORE adding cache control, as trimming modifies cache_breakpoint_indices
            if max_context_size is not None:
                trim_info = trim_claude_messages(
                    claude_messages=claude_messages,
                    claude_tools=claude_tools,
                    max_context_size=max_context_size,
                    max_tokens=max_tokens,
                    cache_breakpoint_indices=cache_breakpoint_indices,
                    programmatic_message_indices=programmatic_message_indices,
                    task_label=task_label,
                )
                if trim_info:
                    # Record trim event
                    trim_event = {
                        'step': step_count,
                        'trim_info': trim_info,
                    }
                    trim_events.append(trim_event)
                    print(f"[{task_label}] Trim event recorded: removed {trim_info['removed_count']} messages")

            # Create a copy for API call and add cache control (do not modify original)
            import copy
            api_messages = copy.deepcopy(claude_messages)
            add_cache_control_to_messages(api_messages, cache_first_user=True, cache_breakpoint_indices=cache_breakpoint_indices)

            print(f"[{task_label}] Calling Claude API with {len(api_messages)} messages")

            # Call Claude API with streaming to avoid timeout errors
            try:
                # Build API call parameters
                api_params = {
                    "model": model,
                    "max_tokens": max_tokens,
                    "messages": api_messages,  # Use api_messages with cache control
                    "tools": claude_tools,
                }

                # Add extended thinking if enabled
                if enable_thinking:
                    api_params["thinking"] = {
                        "type": "enabled",
                        "budget_tokens": thinking_budget_tokens
                    }

                # Determine if we need beta API (memory tool, context management, code execution, or programmatic tool calling)
                needs_beta = has_memory_tool or use_clear_tool_uses or use_clear_thinking or enable_code_execution or enable_programmatic_tool_calling

                if needs_beta:
                    # Build list of beta headers needed
                    betas = []
                    if has_memory_tool or use_clear_tool_uses or use_clear_thinking:
                        betas.append("context-management-2025-06-27")
                    if enable_code_execution:
                        betas.append("code-execution-2025-08-25")
                    # Add programmatic tool calling beta header
                    if enable_programmatic_tool_calling:
                        betas.append("advanced-tool-use-2025-11-20")
                    api_params["betas"] = betas

                # Add container ID for programmatic tool calling if available
                if enable_programmatic_tool_calling and container_id:
                    api_params["container"] = container_id

                # Add context management edits if enabled
                if use_clear_tool_uses or use_clear_thinking:
                    edits = []

                    # Add clear_thinking_20251015 first (must be before clear_tool_uses)
                    if use_clear_thinking:
                        edits.append({
                            "type": "clear_thinking_20251015",
                            "keep": {
                                "type": "thinking_turns",
                                "value": clear_keep_thinking_turns
                            }
                        })

                    # Add clear_tool_uses_20250919
                    if use_clear_tool_uses:
                        edits.append({
                            "type": "clear_tool_uses_20250919",
                            "trigger": {
                                "type": "input_tokens",
                                "value": clear_trigger_tokens
                            },
                            "keep": {
                                "type": "tool_uses",
                                "value": clear_keep_tool_uses
                            },
                            "clear_at_least": {
                                "type": "input_tokens",
                                "value": clear_at_least_tokens
                            }
                        })

                    api_params["context_management"] = {"edits": edits}

                # Use beta API if needed (memory tool or context management)
                if needs_beta:
                    with client.beta.messages.stream(**api_params) as stream:
                        message = stream.get_final_message()
                else:
                    # Use streaming mode to avoid 10-minute timeout limit
                    with client.messages.stream(**api_params) as stream:
                        # Get the final message after streaming completes
                        message = stream.get_final_message()

                print(f"[{task_label}] Claude API response - stop_reason: {message.stop_reason}")

                # Extract container ID for programmatic tool calling
                # Container is returned in response and should be reused for subsequent requests
                if enable_programmatic_tool_calling and hasattr(message, 'container') and message.container:
                    new_container_id = getattr(message.container, 'id', None)
                    if new_container_id:
                        if container_id != new_container_id:
                            print(f"[{task_label}] 📦 Container ID: {new_container_id}")
                            if hasattr(message.container, 'expires_at'):
                                print(f"[{task_label}]   Expires at: {message.container.expires_at}")
                        container_id = new_container_id

                # Log and track thinking blocks if present
                thinking_count = sum(1 for block in message.content if block.type in ["thinking", "redacted_thinking"])
                if thinking_count > 0:
                    thinking_types = [block.type for block in message.content if block.type in ["thinking", "redacted_thinking"]]
                    print(f"[{task_label}] Response contains {thinking_count} thinking block(s): {thinking_types}")

                    # Track thinking details
                    thinking_info = {
                        "step": step_count,
                        "thinking_blocks_count": thinking_count,
                        "thinking_types": thinking_types,
                        "has_redacted": any(t == "redacted_thinking" for t in thinking_types)
                    }
                    thinking_tracking.append(thinking_info)

                # Check for context_management events (clear_tool_uses)
                if hasattr(message, 'context_management') and message.context_management:
                    context_mgmt = message.context_management
                    if hasattr(context_mgmt, 'applied_edits') and context_mgmt.applied_edits:
                        for edit in context_mgmt.applied_edits:
                            edit_dict = {
                                "step": step_count,
                                "type": getattr(edit, 'type', 'unknown'),
                            }
                            # Extract fields based on edit type
                            if hasattr(edit, 'cleared_tool_uses'):
                                edit_dict["cleared_tool_uses"] = edit.cleared_tool_uses
                            if hasattr(edit, 'cleared_input_tokens'):
                                edit_dict["cleared_input_tokens"] = edit.cleared_input_tokens
                            if hasattr(edit, 'cleared_thinking_turns'):
                                edit_dict["cleared_thinking_turns"] = edit.cleared_thinking_turns

                            context_management_events.append(edit_dict)

                            # Print the event
                            print(f"[{task_label}] 🧹 CONTEXT MANAGEMENT: {edit_dict['type']}")
                            if 'cleared_tool_uses' in edit_dict:
                                print(f"[{task_label}]   Cleared tool uses: {edit_dict['cleared_tool_uses']}")
                            if 'cleared_input_tokens' in edit_dict:
                                print(f"[{task_label}]   Cleared input tokens: {edit_dict['cleared_input_tokens']:,}")
                            if 'cleared_thinking_turns' in edit_dict:
                                print(f"[{task_label}]   Cleared thinking turns: {edit_dict['cleared_thinking_turns']}")

                # Extract usage information
                input_tokens = message.usage.input_tokens
                output_tokens = message.usage.output_tokens
                cache_creation_tokens = getattr(message.usage, 'cache_creation_input_tokens', 0) or 0
                cache_read_tokens = getattr(message.usage, 'cache_read_input_tokens', 0) or 0

                # Calculate cost for this step
                step_cost = calculate_cost(message.usage, model)

                # Update cumulative tracking
                total_usage["input_tokens"] += input_tokens
                total_usage["output_tokens"] += output_tokens
                total_usage["cache_creation_input_tokens"] += cache_creation_tokens
                total_usage["cache_read_input_tokens"] += cache_read_tokens
                total_usage["total_cost_usd"] += step_cost

                # Record per-step usage
                step_usage_data = {
                    "step": step_count,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cache_creation_input_tokens": cache_creation_tokens,
                    "cache_read_input_tokens": cache_read_tokens,
                    "step_cost_usd": step_cost,
                    "cumulative_cost_usd": total_usage["total_cost_usd"],
                }
                usage_tracking.append(step_usage_data)

                # Print detailed usage including cache tokens and cost
                usage_str = f"input: {input_tokens}, output: {output_tokens}"
                if cache_creation_tokens:
                    usage_str += f", cache_creation: {cache_creation_tokens}"
                if cache_read_tokens:
                    usage_str += f", cache_read: {cache_read_tokens}"
                usage_str += f", cost: ${step_cost:.6f}, cumulative: ${total_usage['total_cost_usd']:.6f}"
                print(f"[{task_label}] Usage - {usage_str}")

            except Exception as e:
                print(f"[{task_label}] Error calling Claude API: {e}")
                raise

            # ===== SIMPLIFIED: Direct Claude message handling =====
            # No more conversion to OpenAI format and back!

            # 1. Convert Claude response to dict and append to message history
            assistant_msg = claude_message_to_dict(message)
            claude_messages.append(assistant_msg)
            full_messages_history.append(copy.deepcopy(assistant_msg))

            # IMMEDIATELY check if this message contains any programmatic tool_use blocks
            # This ensures we track ALL such messages regardless of env_response type
            # (including pause_turn, server_tool_only, etc.)
            for block in message.content:
                if block.type == "tool_use":
                    caller = getattr(block, 'caller', None)
                    if caller and getattr(caller, 'type', None) == "code_execution_20250825":
                        programmatic_message_indices.add(len(claude_messages) - 1)
                        print(f"[{task_label}] Tracking message {len(claude_messages) - 1} as programmatic (contains code_execution tool calls)")
                        break

            print(f"[{task_label}] Response type: {message.stop_reason}")

            # 2. Extract tool calls for env.step_openai (minimal conversion, only for env interaction)
            env_response = extract_tool_calls_for_env(message)

            # 3. Handle memory tool - convert native memory calls to MCP format for execution
            if has_memory_tool and env_response['type'] == 'tool':
                mcp_tool_calls = []
                for tool_call in env_response['data']:
                    if tool_call.get('function', {}).get('name') == 'memory':
                        try:
                            tool_input = json.loads(tool_call['function']['arguments'])
                            mcp_call = convert_memory_tool_call_to_mcp(tool_input)
                            converted_tool_call = {
                                "id": tool_call['id'],
                                "type": "function",
                                "function": {
                                    "name": mcp_call['tool_name'],
                                    "arguments": json.dumps(mcp_call['arguments'])
                                }
                            }
                            mcp_tool_calls.append(converted_tool_call)
                            print(f"[{task_label}] Converted memory tool call: {tool_input.get('command')} -> {mcp_call['tool_name']}")
                        except Exception as e:
                            print(f"[{task_label}] Error converting memory tool call: {e}")
                            mcp_tool_calls.append(tool_call)  # Keep original on error
                    else:
                        mcp_tool_calls.append(tool_call)
                env_response['data'] = mcp_tool_calls

            # 4. Handle pause_turn and server_tool_only specially
            # These cases involve Claude's internal server tools - no external tool execution needed
            # We just continue the loop to let Claude proceed with its turn
            if env_response['type'] == 'pause_turn':
                print(f"[{task_label}] Received pause_turn - Claude's code execution paused, continuing...")
                # For pause_turn, we need to continue without adding a user message
                # Claude will resume its turn in the next API call
                # Record this as a special step
                episode.append({
                    "observation": "",
                    "action": {
                        "type": "pause_turn",
                        "stop_reason": message.stop_reason,
                        "content": assistant_msg['content'],
                    },
                    "reward": 0.0,
                    "info": {"pause_turn": True},
                })
                continue  # Continue loop without adding user message

            if env_response['type'] == 'server_tool_only':
                print(f"[{task_label}] Server tools only (code_execution) - no external tool call needed, continuing...")
                # Claude used only internal server tools (like code_execution)
                # The results are already in Claude's response - no need to call env.step_openai
                # Record this as a special step and continue the loop
                episode.append({
                    "observation": "",
                    "action": {
                        "type": "server_tool_only",
                        "stop_reason": message.stop_reason,
                        "content": assistant_msg['content'],
                    },
                    "reward": 0.0,
                    "info": {"server_tool_only": True},
                })
                continue  # Continue loop without calling env.step_openai

            # 5. Step environment (for normal and tool responses)
            # For programmatic tool calls, we need to convert the type to 'tool' for env.step_openai
            # but keep track of the original type for proper response formatting
            original_type = env_response['type']
            if original_type == 'programmatic_tool':
                # Create a copy with type='tool' so env.step_openai can process it
                env_response_for_step = {'type': 'tool', 'data': env_response['data']}
                print(f"[{task_label}] Processing {len(env_response['data'])} programmatic tool call(s)")
                # Note: assistant message is already tracked in programmatic_message_indices
                # (done immediately after appending above)
            else:
                env_response_for_step = env_response

            next_obs, reward, terminated, truncated, info = env.step_openai(env_response_for_step, verbose=True)

            print(f"[{task_label}] Reward: {reward}, Terminated: {terminated}, Truncated: {truncated}")

            # Update state
            done = terminated or truncated

            # 6. Convert tool results to Claude format and append
            tool_result_blocks = []
            if not done and original_type in ['tool', 'programmatic_tool']:
                tool_result_blocks = convert_tool_results_to_claude(next_obs)

                # CRITICAL: For programmatic tool calls, we MUST always return tool_results
                # even if conversion failed. Otherwise Claude will error with "tool_use without tool_result"
                if not tool_result_blocks and original_type == 'programmatic_tool':
                    print(f"[{task_label}] WARNING: No tool results from conversion!")
                    print(f"[{task_label}] DEBUG next_obs type: {type(next_obs)}")
                    print(f"[{task_label}] DEBUG next_obs content (first 500 chars): {str(next_obs)[:500]}")

                    # Try to understand why conversion failed and use actual content
                    fallback_content = str(next_obs) if next_obs else "Tool execution returned empty result"

                    # Generate tool_results using the actual next_obs content
                    for tool_call in env_response['data']:
                        tool_id = tool_call.get('id')
                        tool_name = tool_call.get('function', {}).get('name', 'unknown')
                        tool_result_blocks.append({
                            "type": "tool_result",
                            "tool_use_id": tool_id,
                            "content": fallback_content,
                            "is_error": True
                        })
                    print(f"[{task_label}] Generated {len(tool_result_blocks)} fallback tool results with actual content")

                if tool_result_blocks:
                    # For programmatic tool calls, ONLY include tool_result blocks (no text)
                    # This is required by Claude's Programmatic Tool Calling specification
                    if original_type == 'programmatic_tool':
                        print(f"[{task_label}] Returning {len(tool_result_blocks)} tool results for programmatic tool calling")
                    claude_messages.append({"role": "user", "content": tool_result_blocks})
                    full_messages_history.append({"role": "user", "content": copy.deepcopy(tool_result_blocks)})
                    # Track programmatic tool result indices - these cannot have cache_control
                    # as they are not rendered in Claude's context
                    if original_type == 'programmatic_tool':
                        programmatic_message_indices.add(len(claude_messages) - 1)

            obs = next_obs

            # Record episode data (store serializable response info)
            # Include detailed debug info for troubleshooting programmatic tool calling
            # Check if any tool_result has is_error=True (fallback error results)
            has_fallback_errors = any(
                isinstance(block, dict) and block.get('is_error', False)
                for block in tool_result_blocks
            )

            step_debug_info = {
                "step": step_count,
                "stop_reason": message.stop_reason,
                "env_response_type": env_response['type'],
                "original_type": original_type,
                "num_tool_calls": len(env_response.get('data', [])) if env_response['type'] in ['tool', 'programmatic_tool'] else 0,
                "tool_call_ids": [tc.get('id') for tc in env_response.get('data', [])] if env_response['type'] in ['tool', 'programmatic_tool'] else [],
                "tool_names": [tc.get('function', {}).get('name') for tc in env_response.get('data', [])] if env_response['type'] in ['tool', 'programmatic_tool'] else [],
                "num_tool_results": len(tool_result_blocks),
                "has_fallback_error_results": has_fallback_errors,
                "claude_messages_count": len(claude_messages),
                "is_programmatic": original_type == 'programmatic_tool',
                "has_server_tool_use": any(
                    isinstance(block, dict) and block.get('type') == 'server_tool_use'
                    for block in assistant_msg['content']
                ) if isinstance(assistant_msg['content'], list) else False,
                "has_code_execution_result": any(
                    isinstance(block, dict) and block.get('type') == 'code_execution_tool_result'
                    for block in assistant_msg['content']
                ) if isinstance(assistant_msg['content'], list) else False,
                "content_block_types": [
                    block.get('type') if isinstance(block, dict) else type(block).__name__
                    for block in assistant_msg['content']
                ] if isinstance(assistant_msg['content'], list) else [],
            }

            episode.append({
                "observation": obs,
                "action": {
                    "type": env_response['type'],
                    "stop_reason": message.stop_reason,
                    "content": assistant_msg['content'],
                },
                "reward": reward,
                "info": info,
                "debug": step_debug_info,
            })

            # Save current progress after each step
            episode_data = {
                "steps": episode,
                "claude_messages": claude_messages,  # Now the primary format!
                "full_messages_history": full_messages_history,
                "cache_breakpoint_indices": cache_breakpoint_indices.copy(),
                "usage_tracking": usage_tracking,
                "total_usage": total_usage.copy(),
                "context_management_events": context_management_events,
                "thinking_tracking": thinking_tracking,
                "trim_events": trim_events,
                "tools": tools_info,
                "accuracy": reward,
                "total_steps": step_count,
                "completed": done,
            }

            envelope = make_base_envelope(
                backend="claude_api",
                task={
                    "task_id": task_id,
                    "config_id": config_id,
                    "run_id": run_id,
                    "config_name": config_name,
                    "env_class": env_class,
                    "env_params": env_params,
                },
            )
            attach_conversation(
                envelope,
                claude_messages=claude_messages,
                full_messages_history=full_messages_history,
            )
            attach_events(
                envelope,
                context_management=context_management_events,
                thinking_tracking=thinking_tracking,
                trim=trim_events,
                cache_breakpoint_indices=cache_breakpoint_indices.copy(),
            )
            attach_metrics(
                envelope,
                accuracy=reward,
                total_steps=step_count,
                completed=done,
                total_usage=total_usage.copy(),
            )
            attach_provider_payload(
                envelope,
                model=model,
                tools=tools_info,
                usage_tracking=usage_tracking,
            )
            write_trajectory_file(
                save_file,
                envelope=envelope,
                legacy_payload=episode_data,
                indent=4,
            )

            print(f"[{task_label}] Progress saved to: {save_file}")

        # Final episode data already saved in the loop above
        # Just print completion message

        print(f"[{task_label}] Completed successfully!")
        print(f"[{task_label}] Episode saved to: {save_file}")
        print(f"[{task_label}] Total steps: {step_count}")
        print(f"[{task_label}] Final reward (accuracy): {reward}")
        print(f"[{task_label}] Total cost: ${total_usage['total_cost_usd']:.6f}")
        print(f"[{task_label}] Total tokens - Input: {total_usage['input_tokens']:,}, "
              f"Output: {total_usage['output_tokens']:,}, "
              f"Cache creation: {total_usage['cache_creation_input_tokens']:,}, "
              f"Cache read: {total_usage['cache_read_input_tokens']:,}")

        # Print context management summary
        if context_management_events:
            print(f"[{task_label}] Context management events: {len(context_management_events)}")
            total_cleared_tools = sum(e.get('cleared_tool_uses', 0) for e in context_management_events)
            total_cleared_tokens = sum(e.get('cleared_input_tokens', 0) for e in context_management_events)
            print(f"[{task_label}]   Total cleared tool uses: {total_cleared_tools}")
            print(f"[{task_label}]   Total cleared input tokens: {total_cleared_tokens:,}")
            for event in context_management_events:
                print(f"[{task_label}]   Step {event['step']}: {event['type']} - "
                      f"tools={event.get('cleared_tool_uses', 0)}, "
                      f"tokens={event.get('cleared_input_tokens', 0):,}")

        # Print trim events summary
        if trim_events:
            print(f"[{task_label}] Trim events: {len(trim_events)}")
            total_trimmed = sum(e['trim_info']['removed_count'] for e in trim_events)
            print(f"[{task_label}]   Total trimmed messages: {total_trimmed}")
            for event in trim_events:
                info = event['trim_info']
                print(f"[{task_label}]   Step {event['step']}: removed {info['removed_count']} messages "
                      f"({info['original_message_count']} -> {info['trimmed_message_count']})")

        # Print thinking summary
        if thinking_tracking:
            print(f"[{task_label}] Extended thinking usage:")
            print(f"[{task_label}]   Steps with thinking: {len(thinking_tracking)}/{step_count}")
            total_thinking_blocks = sum(t.get('thinking_blocks_count', 0) for t in thinking_tracking)
            print(f"[{task_label}]   Total thinking blocks: {total_thinking_blocks}")
            redacted_count = sum(1 for t in thinking_tracking if t.get('has_redacted', False))
            if redacted_count > 0:
                print(f"[{task_label}]   Steps with redacted thinking: {redacted_count}")

        # Write eval.json alongside trajectory when using config_name
        if config_name:
            write_eval_file(
                task_workspace=task_workspace,
                status="success",
                accuracy=reward,
                steps=step_count,
                feedback=str(info) if info else "",
            )

        return {
            "task_id": task_id,
            "config_id": config_id,
            "run_id": run_id,
            "config_name": config_name,
            "status": "success",
            "steps": step_count,
            "final_reward": reward,
            "accuracy": reward,
            "save_file": str(save_file),
            "env_class": env_class,
            "env_params": env_params,
            # Usage and cost information
            "total_cost_usd": total_usage["total_cost_usd"],
            "total_input_tokens": total_usage["input_tokens"],
            "total_output_tokens": total_usage["output_tokens"],
            "cache_creation_input_tokens": total_usage["cache_creation_input_tokens"],
            "cache_read_input_tokens": total_usage["cache_read_input_tokens"],
        }

    except Exception as e:
        print(f"[{task_label}] Error: {e}")
        import traceback
        traceback.print_exc()

        # Save partial episode on error
        if episode:
            if config_name:
                error_save_file = task_workspace / "trajectory.json"
            else:
                output_path = Path(output_dir) / f"config_{config_id}"
                output_path.mkdir(parents=True, exist_ok=True)
                timestamp = int(time.time())
                error_save_file = output_path / f"config{config_id}_run{run_id}-episode-error-{timestamp}.json"

            # Create error episode data
            episode_data = {
                "steps": episode,
                "error": str(e),
                "total_steps": len(episode),
            }

            envelope = make_base_envelope(
                backend="claude_api",
                task={
                    "task_id": task_id,
                    "config_id": config_id,
                    "run_id": run_id,
                    "config_name": config_name,
                    "env_class": env_class,
                    "env_params": env_params,
                },
            )
            attach_conversation(
                envelope,
                full_messages_history=full_messages_history,
            )
            attach_metrics(
                envelope,
                accuracy=0,
                total_steps=len(episode),
                completed=False,
            )
            attach_provider_payload(
                envelope,
                model=model,
                error=str(e),
            )
            write_trajectory_file(
                error_save_file,
                envelope=envelope,
                legacy_payload=episode_data,
                indent=4,
            )

            print(f"[{task_label}] Partial episode saved to: {error_save_file}")

        # Write eval.json for error case when using config_name
        if config_name:
            write_eval_file(
                task_workspace=task_workspace,
                status="error",
                accuracy=0,
                steps=len(episode),
                feedback=str(e),
            )

        return {
            "task_id": task_id,
            "config_id": config_id,
            "run_id": run_id,
            "config_name": config_name,
            "status": "error",
            "error": str(e),
            "steps": len(episode),
            "env_class": env_class,
            "env_params": env_params,
        }


def normalize_config_for_grouping(config: Dict[str, Any]) -> tuple:
    """Create a normalized representation of a config for grouping purposes.

    Configs are considered the same if they differ only in the 'seed' parameter.
    """
    env_params = config.get("env_params", {}).copy()
    seed = env_params.pop("seed", None)

    normalized = {
        "env_class": config.get("env_class"),
        "env_params": tuple(sorted(env_params.items())),
        "mcp_servers": json.dumps(config.get("mcp_servers", {}), sort_keys=True)
    }

    return (normalized["env_class"], normalized["env_params"], normalized["mcp_servers"])


def group_configs_by_similarity(configs: List[Dict[str, Any]]) -> Dict[int, List[int]]:
    """Group configurations that differ only by seed."""
    groups = {}
    config_to_group = {}

    for idx, config in enumerate(configs):
        normalized = normalize_config_for_grouping(config)

        if normalized not in config_to_group:
            group_id = len(config_to_group)
            config_to_group[normalized] = group_id
            groups[group_id] = []

        group_id = config_to_group[normalized]
        groups[group_id].append(idx)

    return groups


def run_config_combinations(
    config_file: str,
    runs_per_config: int = 1,
    base_task_dir: str = "",
    output_dir: str = "",
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: str = "claude-sonnet-4-5",
    max_tool_uses: int = 100,
    max_tokens: int = 4096,
    max_workers: Optional[int] = None,
    group_by_seed: bool = True,
    # Extended thinking parameters
    enable_thinking: bool = False,
    thinking_budget_tokens: int = 10000,
    # Context management parameters
    use_clear_tool_uses: bool = False,
    clear_trigger_tokens: int = 180000,
    clear_keep_tool_uses: int = 3,
    clear_at_least_tokens: int = 5000,
    use_clear_thinking: bool = False,
    clear_keep_thinking_turns: int = 2,
    # Code execution parameters
    enable_code_execution: bool = False,
    # Programmatic tool calling parameters
    enable_programmatic_tool_calling: bool = False,
    # Context trimming parameters
    max_context_size: Optional[int] = None,
):
    """Run multiple configurations in parallel with Claude API.

    Extended Thinking:
        When enable_thinking=True, Claude uses extended thinking for enhanced reasoning.
        Thinking blocks are automatically preserved across tool use interactions.
        Results include thinking_tracking with per-step thinking usage statistics.

    Args:
        config_file: Path to JSON configuration file
        runs_per_config: Number of runs per configuration
        base_task_dir: Base directory for task workspaces
        output_dir: Directory to save episode results
        api_key: Anthropic API key (if None, will use ANTHROPIC_API_KEY from env)
        base_url: Anthropic-compatible base URL (if None, will use env fallback)
        model: Claude model name (must support extended thinking if enable_thinking=True)
        max_tool_uses: Maximum tool uses per episode
        max_tokens: Maximum tokens per generation (includes thinking budget)
        max_workers: Maximum parallel workers
        group_by_seed: If True, group configs that differ only by seed as same config
        enable_thinking: Enable extended thinking mode
        thinking_budget_tokens: Token budget for thinking (default: 10000, min: 1024)
        use_clear_tool_uses: Enable clear_tool_uses_20250919 feature
        clear_trigger_tokens: Token threshold to trigger clearing (default: 180000)
        clear_keep_tool_uses: Number of tool uses to keep after clearing (default: 3)
        clear_at_least_tokens: Minimum tokens to clear (default: 5000)
        use_clear_thinking: Enable clear_thinking_20251015 feature
        clear_keep_thinking_turns: Number of thinking turns to keep (default: 2)
        enable_code_execution: Enable code_execution_20250825 tool for Bash and file operations
        enable_programmatic_tool_calling: Enable Claude's official programmatic tool calling.
            Allows Claude to write Python code that calls tools programmatically within
            a code execution container. Requires code_execution (auto-enabled if not set).
        max_context_size: Maximum context size in tokens. If set, messages will be trimmed
            from the beginning of the conversation to fit within this limit (reserving
            max_tokens for output). When trimming, cache breakpoint indices are updated
            to reflect the new message positions.
    """
    # Handle string "True"/"False" from command line properly
    def str_to_bool(val):
        if isinstance(val, bool):
            return val
        if isinstance(val, str):
            return val.lower() in ('true', '1', 'yes')
        return bool(val)

    _enable_thinking = str_to_bool(enable_thinking)
    _use_clear_tool_uses = str_to_bool(use_clear_tool_uses)
    _use_clear_thinking = str_to_bool(use_clear_thinking)
    _group_by_seed = str_to_bool(group_by_seed)
    _enable_code_execution = str_to_bool(enable_code_execution)
    _enable_programmatic_tool_calling = str_to_bool(enable_programmatic_tool_calling)

    # Load configurations
    with open(config_file, "r") as f:
        config_data = json.load(f)

    configs = config_data.get("configurations", [])
    print(f"Loaded {len(configs)} configurations from {config_file}")

    # Get API key from environment if not provided
    if api_key is None:
        api_key = os.environ.get("LOCA_ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("API key not provided and LOCA_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY not set in environment")
    if base_url is None:
        base_url = os.environ.get("LOCA_ANTHROPIC_BASE_URL") or os.environ.get("ANTHROPIC_BASE_URL")

    # Group configurations if group_by_seed is enabled
    if _group_by_seed:
        config_groups = group_configs_by_similarity(configs)
        print(f"\nGrouping enabled: Found {len(config_groups)} unique configuration groups")
        for group_id, config_indices in config_groups.items():
            if len(config_indices) > 1:
                print(f"  Group {group_id}: {len(config_indices)} configs with different seeds")
    else:
        config_groups = {i: [i] for i in range(len(configs))}
        print(f"Grouping disabled: Treating each config separately")

    # Create base directories
    Path(base_task_dir).mkdir(parents=True, exist_ok=True)
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    # Calculate total tasks
    if _group_by_seed:
        total_tasks = sum(max(len(indices), runs_per_config) for indices in config_groups.values())
    else:
        total_tasks = len(configs) * runs_per_config

    # Set default max_workers
    if max_workers is None:
        max_workers = min(total_tasks, os.cpu_count() or 4)

    print("=" * 80)
    print("CLAUDE API PARALLEL INFERENCE")
    print("=" * 80)
    print(f"Total configurations: {len(configs)}")
    print(f"Unique config groups: {len(config_groups)}")
    print(f"Runs per configuration: {runs_per_config}")
    print(f"Total tasks: {total_tasks}")
    print(f"Max workers: {max_workers}")
    print(f"Model: {model}")
    if base_url:
        print(f"Anthropic base URL: {base_url}")
    print(f"Base task directory: {base_task_dir}")
    print(f"Output directory: {output_dir}")
    if _enable_thinking:
        print(f"Extended thinking: ENABLED")
        print(f"  Budget tokens: {thinking_budget_tokens}")
    else:
        print(f"Extended thinking: DISABLED")
    if _use_clear_tool_uses or _use_clear_thinking:
        print(f"Context management: ENABLED")
        if _use_clear_tool_uses:
            print(f"  Clear tool uses: ON")
            print(f"    Trigger tokens: {clear_trigger_tokens}")
            print(f"    Keep tool uses: {clear_keep_tool_uses}")
            print(f"    Clear at least tokens: {clear_at_least_tokens}")
        if _use_clear_thinking:
            print(f"  Clear thinking: ON")
            print(f"    Keep thinking turns: {clear_keep_thinking_turns}")
    else:
        print(f"Context management: DISABLED")
    if _enable_code_execution:
        print(f"Code execution: ENABLED")
    else:
        print(f"Code execution: DISABLED")
    if _enable_programmatic_tool_calling:
        print(f"Programmatic tool calling: ENABLED")
    else:
        print(f"Programmatic tool calling: DISABLED")
    if max_context_size is not None:
        print(f"Context trimming: ENABLED (max_context_size: {max_context_size:,} tokens)")
    else:
        print(f"Context trimming: DISABLED")
    print("=" * 80)

    # Prepare task arguments
    task_args = []
    task_id = 0

    # Build group_id -> config_name mapping for results aggregation
    group_id_to_name = {}

    if _group_by_seed:
        for group_id, config_indices in sorted(config_groups.items()):
            run_id = 0
            template_config = configs[config_indices[0]]
            total_runs_for_group = max(len(config_indices), runs_per_config)

            # Derive config_name: use 'name' field, or extract class name from env_class
            cfg_name = template_config.get("name", "")
            if not cfg_name:
                env_cls = template_config.get("env_class", "")
                cfg_name = env_cls.rsplit(".", 1)[-1] if "." in env_cls else f"config_{group_id}"
            group_id_to_name[group_id] = cfg_name

            for i in range(total_runs_for_group):
                if i < len(config_indices):
                    config = configs[config_indices[i]]
                else:
                    config = template_config

                task_args.append((
                    task_id,
                    group_id,
                    run_id,
                    base_task_dir,
                    output_dir,
                    config["env_class"],
                    config["env_params"],
                    config["mcp_servers"],
                    api_key,
                    base_url,
                    model,
                    max_tool_uses,
                    max_tokens,
                    _enable_thinking,
                    thinking_budget_tokens,
                    _use_clear_tool_uses,
                    clear_trigger_tokens,
                    clear_keep_tool_uses,
                    clear_at_least_tokens,
                    _use_clear_thinking,
                    clear_keep_thinking_turns,
                    _enable_code_execution,
                    _enable_programmatic_tool_calling,
                    max_context_size,
                    cfg_name,
                ))
                task_id += 1
                run_id += 1
    else:
        for config_id, config in enumerate(configs):
            # Derive config_name for non-grouped mode
            cfg_name = config.get("name", "")
            if not cfg_name:
                env_cls = config.get("env_class", "")
                cfg_name = env_cls.rsplit(".", 1)[-1] if "." in env_cls else f"config_{config_id}"
            group_id_to_name[config_id] = cfg_name

            for run_id in range(runs_per_config):
                task_args.append((
                    task_id,
                    config_id,
                    run_id,
                    base_task_dir,
                    output_dir,
                    config["env_class"],
                    config["env_params"],
                    config["mcp_servers"],
                    api_key,
                    base_url,
                    model,
                    max_tool_uses,
                    max_tokens,
                    _enable_thinking,
                    thinking_budget_tokens,
                    _use_clear_tool_uses,
                    clear_trigger_tokens,
                    clear_keep_tool_uses,
                    clear_at_least_tokens,
                    _use_clear_thinking,
                    clear_keep_thinking_turns,
                    _enable_code_execution,
                    _enable_programmatic_tool_calling,
                    max_context_size,
                    cfg_name,
                ))
                task_id += 1

    # Run tasks in parallel
    start_time = time.time()
    results = []

    with ProcessPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(run_single_task, *args): (args[0], args[1], args[2])
            for args in task_args
        }

        for future in as_completed(futures):
            task_id, config_id, run_id = futures[future]
            try:
                result = future.result()
                results.append(result)
                print(f"\n{'=' * 80}")
                print(f"Task {task_id} (Config {config_id}, Run {run_id}) finished: {result['status']}")
                if result['status'] == 'success':
                    print(f"  Steps: {result['steps']}, Accuracy: {result.get('accuracy', result['final_reward'])}")
                print(f"{'=' * 80}\n")
            except Exception as e:
                print(f"\n{'=' * 80}")
                print(f"Task {task_id} (Config {config_id}, Run {run_id}) raised an exception: {e}")
                print(f"{'=' * 80}\n")
                results.append({
                    "task_id": task_id,
                    "config_id": config_id,
                    "run_id": run_id,
                    "status": "exception",
                    "error": str(e),
                })

    elapsed_time = time.time() - start_time

    # Analyze results by configuration
    config_stats = {}
    for result in results:
        config_id = result.get("config_id", 0)
        if config_id not in config_stats:
            config_stats[config_id] = {
                "total": 0,
                "success": 0,
                "error": 0,
                "accuracies": [],
                "steps": [],
                # Usage tracking
                "costs": [],
                "input_tokens": [],
                "output_tokens": [],
                "cache_creation_tokens": [],
                "cache_read_tokens": [],
            }

        config_stats[config_id]["total"] += 1
        if result["status"] == "success":
            config_stats[config_id]["success"] += 1
            accuracy = result.get("accuracy", result["final_reward"])
            config_stats[config_id]["accuracies"].append(accuracy)
            config_stats[config_id]["steps"].append(result["steps"])
            # Track usage
            if result.get("total_cost_usd") is not None:
                config_stats[config_id]["costs"].append(result["total_cost_usd"])
            config_stats[config_id]["input_tokens"].append(result.get("total_input_tokens", 0))
            config_stats[config_id]["output_tokens"].append(result.get("total_output_tokens", 0))
            config_stats[config_id]["cache_creation_tokens"].append(result.get("cache_creation_input_tokens", 0))
            config_stats[config_id]["cache_read_tokens"].append(result.get("cache_read_input_tokens", 0))
        else:
            config_stats[config_id]["error"] += 1

    # Print summary
    print("\n" + "=" * 80)
    print("CLAUDE API PARALLEL INFERENCE SUMMARY")
    print("=" * 80)
    print(f"Total configurations: {len(configs)}")
    print(f"Unique config groups: {len(config_groups)}")
    print(f"Runs per configuration: {runs_per_config}")
    print(f"Total tasks: {total_tasks}")
    print(f"Total time: {elapsed_time:.2f} seconds")
    print(f"Average time per task: {elapsed_time / total_tasks:.2f} seconds")

    total_success = sum(1 for r in results if r["status"] == "success")
    total_error = sum(1 for r in results if r["status"] in ["error", "exception"])

    print(f"\nOverall Success: {total_success}/{total_tasks}")
    print(f"Overall Failed: {total_error}/{total_tasks}")

    # Calculate total cost and token usage
    total_cost = sum(r.get("total_cost_usd", 0) or 0 for r in results if r["status"] == "success")
    total_input = sum(r.get("total_input_tokens", 0) for r in results if r["status"] == "success")
    total_output = sum(r.get("total_output_tokens", 0) for r in results if r["status"] == "success")
    total_cache_creation = sum(r.get("cache_creation_input_tokens", 0) for r in results if r["status"] == "success")
    total_cache_read = sum(r.get("cache_read_input_tokens", 0) for r in results if r["status"] == "success")
    print(f"\nTotal Cost: ${total_cost:.6f}")
    print(f"Total Tokens - Input: {total_input:,}, Output: {total_output:,}")
    print(f"Cache - Creation: {total_cache_creation:,}, Read: {total_cache_read:,}")

    # Print per-configuration statistics
    if _group_by_seed:
        print("\nPer-Group Results:")
        for group_id in sorted(config_stats.keys()):
            stats = config_stats[group_id]
            config_indices = config_groups.get(group_id, [group_id])
            config_idx = config_indices[0] if config_indices else group_id
            if config_idx < len(configs):
                config = configs[config_idx]
                print(f"\n  Group {group_id}:")
                print(f"    Environment: {config['env_class']}")
                print(f"    Config indices: {config_indices}")
                print(f"    Success: {stats['success']}/{stats['total']}")
                if stats['accuracies']:
                    avg_accuracy = sum(stats['accuracies']) / len(stats['accuracies'])
                    avg_steps = sum(stats['steps']) / len(stats['steps'])
                    print(f"    Avg Accuracy: {avg_accuracy:.4f}")
                    print(f"    Avg Steps: {avg_steps:.2f}")
                    print(f"    Accuracies: {stats['accuracies']}")
                if stats['costs']:
                    avg_cost = sum(stats['costs']) / len(stats['costs'])
                    total_group_cost = sum(stats['costs'])
                    print(f"    Avg Cost: ${avg_cost:.6f}, Total: ${total_group_cost:.6f}")
                if stats['input_tokens']:
                    avg_input = sum(stats['input_tokens']) / len(stats['input_tokens'])
                    avg_output = sum(stats['output_tokens']) / len(stats['output_tokens'])
                    avg_cache_creation = sum(stats['cache_creation_tokens']) / len(stats['cache_creation_tokens'])
                    avg_cache_read = sum(stats['cache_read_tokens']) / len(stats['cache_read_tokens'])
                    print(f"    Avg Tokens: input={int(avg_input):,}, output={int(avg_output):,}")
                    print(f"    Avg Cache: creation={int(avg_cache_creation):,}, read={int(avg_cache_read):,}")
    else:
        print("\nPer-Configuration Results:")
        for config_id in sorted(config_stats.keys()):
            stats = config_stats[config_id]
            if config_id < len(configs):
                config = configs[config_id]
                print(f"\n  Config {config_id}:")
                print(f"    Environment: {config['env_class']}")
                print(f"    Success: {stats['success']}/{stats['total']}")
                if stats['accuracies']:
                    avg_accuracy = sum(stats['accuracies']) / len(stats['accuracies'])
                    avg_steps = sum(stats['steps']) / len(stats['steps'])
                    print(f"    Avg Accuracy: {avg_accuracy:.4f}")
                    print(f"    Avg Steps: {avg_steps:.2f}")
                    print(f"    Accuracies: {stats['accuracies']}")
                if stats['costs']:
                    avg_cost = sum(stats['costs']) / len(stats['costs'])
                    total_group_cost = sum(stats['costs'])
                    print(f"    Avg Cost: ${avg_cost:.6f}, Total: ${total_group_cost:.6f}")
                if stats['input_tokens']:
                    avg_input = sum(stats['input_tokens']) / len(stats['input_tokens'])
                    avg_output = sum(stats['output_tokens']) / len(stats['output_tokens'])
                    avg_cache_creation = sum(stats['cache_creation_tokens']) / len(stats['cache_creation_tokens'])
                    avg_cache_read = sum(stats['cache_read_tokens']) / len(stats['cache_read_tokens'])
                    print(f"    Avg Tokens: input={int(avg_input):,}, output={int(avg_output):,}")
                    print(f"    Avg Cache: creation={int(avg_cache_creation):,}, read={int(avg_cache_read):,}")

    # Save summary
    summary_file = Path(output_dir) / f"summary-{int(time.time())}.json"
    summary = {
        "total_configs": len(configs),
        "unique_config_groups": len(config_groups),
        "group_by_seed": _group_by_seed,
        "runs_per_config": runs_per_config,
        "total_tasks": total_tasks,
        "max_workers": max_workers,
        "model": model,
        "elapsed_time": elapsed_time,
        "total_success": total_success,
        "total_error": total_error,
        # Context management settings
        "use_clear_tool_uses": _use_clear_tool_uses,
        "clear_trigger_tokens": clear_trigger_tokens if _use_clear_tool_uses else None,
        "clear_keep_tool_uses": clear_keep_tool_uses if _use_clear_tool_uses else None,
        "clear_at_least_tokens": clear_at_least_tokens if _use_clear_tool_uses else None,
        # Overall usage summary
        "total_cost_usd": total_cost,
        "total_input_tokens": total_input,
        "total_output_tokens": total_output,
        "total_cache_creation_tokens": total_cache_creation,
        "total_cache_read_tokens": total_cache_read,
        "configurations": configs,
        "config_groups": {str(k): v for k, v in config_groups.items()} if _group_by_seed else None,
        "config_stats": {
            str(k): {
                "total": v["total"],
                "success": v["success"],
                "error": v["error"],
                "avg_accuracy": sum(v["accuracies"]) / len(v["accuracies"]) if v["accuracies"] else None,
                "avg_steps": sum(v["steps"]) / len(v["steps"]) if v["steps"] else None,
                "accuracies": v["accuracies"],
                "steps": v["steps"],
                # Usage stats
                "avg_cost_usd": sum(v["costs"]) / len(v["costs"]) if v["costs"] else None,
                "total_cost_usd": sum(v["costs"]) if v["costs"] else None,
                "avg_input_tokens": sum(v["input_tokens"]) / len(v["input_tokens"]) if v["input_tokens"] else None,
                "avg_output_tokens": sum(v["output_tokens"]) / len(v["output_tokens"]) if v["output_tokens"] else None,
                "avg_cache_creation_tokens": sum(v["cache_creation_tokens"]) / len(v["cache_creation_tokens"]) if v["cache_creation_tokens"] else None,
                "avg_cache_read_tokens": sum(v["cache_read_tokens"]) / len(v["cache_read_tokens"]) if v["cache_read_tokens"] else None,
                "costs": v["costs"],
                "input_tokens": v["input_tokens"],
                "output_tokens": v["output_tokens"],
                "cache_creation_tokens": v["cache_creation_tokens"],
                "cache_read_tokens": v["cache_read_tokens"],
            }
            for k, v in config_stats.items()
        },
        "results": results,
    }

    write_summary_file(summary_file, summary, indent=4)

    print(f"\nSummary saved to: {summary_file}")

    # Save results.json (use task names as keys when available)
    results_file = Path(output_dir) / "results.json"
    per_config_data = {}
    for k, v in config_stats.items():
        key = group_id_to_name.get(k, str(k))
        per_config_data[key] = {
            "success": v["success"],
            "error": v["error"],
            "avg_accuracy": round(sum(v["accuracies"]) / len(v["accuracies"]), 4) if v["accuracies"] else None,
            "avg_steps": round(sum(v["steps"]) / len(v["steps"]), 2) if v["steps"] else None,
            "avg_cost_usd": round(sum(v["costs"]) / len(v["costs"]), 6) if v["costs"] else None,
            "avg_input_tokens": round(sum(v["input_tokens"]) / len(v["input_tokens"]), 0) if v["input_tokens"] else None,
            "avg_output_tokens": round(sum(v["output_tokens"]) / len(v["output_tokens"]), 0) if v["output_tokens"] else None,
        }

    all_accuracies = [r.get("accuracy", r.get("final_reward", 0)) for r in results if r["status"] == "success"]
    all_steps = [r["steps"] for r in results if r["status"] == "success"]
    results_data = {
        "metadata": {
            "model": model,
            "timestamp": int(time.time()),
            "elapsed_seconds": round(elapsed_time, 2),
            "total_tasks": len(task_args),
        },
        "summary": {
            "total_success": total_success,
            "total_error": total_error,
            "avg_accuracy": round(sum(all_accuracies) / len(all_accuracies), 4) if all_accuracies else None,
            "avg_steps": round(sum(all_steps) / len(all_steps), 2) if all_steps else None,
            "total_cost_usd": round(total_cost, 6),
            "total_input_tokens": total_input,
            "total_output_tokens": total_output,
        },
        "per_config": per_config_data,
    }
    write_results_file(
        path=results_file,
        metadata=results_data["metadata"],
        summary=results_data["summary"],
        per_config=results_data["per_config"],
        indent=2,
    )

    # Build and save aggregated all_trajectories.json
    all_traj_file = write_all_trajectories_file(
        base_task_dir=base_task_dir,
        output_dir=output_dir,
        results=results,
        group_id_to_name=group_id_to_name,
    )

    print(f"Results saved to: {results_file}")
    print(f"Aggregated trajectories saved to: {all_traj_file}")
    print("=" * 80)


def main():
    """Main entry point.

    Example usage:
        python run_claude_api.py --config_file example_config.json --runs_per_config 3
    """
    fire.Fire(run_config_combinations)


if __name__ == "__main__":
    main()
