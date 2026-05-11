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

"""Parallel inference runner using Claude Agent SDK with MCP tools."""

import json
import os
import sys
import time
import importlib
import asyncio
import random
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Optional, List, Dict, Any

import fire
from dotenv import load_dotenv

# Import Claude Agent SDK
from claude_agent_sdk import query, ClaudeAgentOptions, ClaudeSDKClient
from claude_agent_sdk.types import HookMatcher, SyncHookJSONOutput, HookContext

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


def setup_mcp_servers_for_claude_agent(
    mcp_configs: Dict[str, Any],
    task_workspace: Path,
    agent_workspace: Path,
) -> Dict[str, Any]:
    """Setup MCP servers configuration for Claude Agent SDK.

    Claude Agent SDK expects MCP servers in the format:
    {
        "server_name": {
            "type": "stdio",
            "command": "python",
            "args": ["script.py", "--arg1", "value1"],
            "env": {"ENV_VAR": "value"}
        }
    }

    Args:
        mcp_configs: Dictionary of MCP server configurations
        task_workspace: Path to task workspace
        agent_workspace: Path to agent workspace

    Returns:
        Dictionary with MCP servers configuration for Claude Agent SDK
    """
    # First get the standard config
    config = setup_mcp_servers(mcp_configs, task_workspace, agent_workspace)

    # Convert to Claude Agent SDK format
    claude_agent_mcp_servers = {}

    for server_name, server_config in config.get("mcpServers", {}).items():
        claude_agent_mcp_servers[server_name] = {
            "type": "stdio",
            "command": server_config.get("command", "python"),
            "args": server_config.get("args", []),
        }
        # Add env if present
        if "env" in server_config:
            claude_agent_mcp_servers[server_name]["env"] = server_config["env"]

    return claude_agent_mcp_servers


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


def extract_usage_from_obj(obj) -> Optional[Dict[str, Any]]:
    """Extract usage information from an object."""
    if obj is None:
        return None

    usage_dict = {}

    # Try to extract from __dict__
    if hasattr(obj, '__dict__'):
        for k, v in obj.__dict__.items():
            if not k.startswith('_'):
                usage_dict[k] = v
    elif isinstance(obj, dict):
        usage_dict = obj.copy()

    # Also try common attribute access patterns
    for attr in ['input_tokens', 'output_tokens', 'cache_read_input_tokens',
                 'cache_creation_input_tokens', 'cache_creation', 'cache_read']:
        if hasattr(obj, attr):
            usage_dict[attr] = getattr(obj, attr)

    return usage_dict if usage_dict else None


def message_to_dict(message) -> Dict[str, Any]:
    """Convert Claude Agent SDK message to serializable dictionary.

    Args:
        message: Message object from Claude Agent SDK

    Returns:
        Dictionary representation of the message
    """
    result = {
        "type": type(message).__name__,
    }

    # Handle different message types
    if hasattr(message, 'content'):
        content = message.content
        if isinstance(content, list):
            result["content"] = []
            for item in content:
                if hasattr(item, '__dict__'):
                    result["content"].append({
                        "type": type(item).__name__,
                        **{k: v for k, v in item.__dict__.items() if not k.startswith('_')}
                    })
                else:
                    result["content"].append(str(item))
        else:
            result["content"] = str(content)

    if hasattr(message, 'model'):
        result["model"] = message.model

    if hasattr(message, 'uuid'):
        result["uuid"] = message.uuid

    if hasattr(message, 'parent_tool_use_id'):
        result["parent_tool_use_id"] = message.parent_tool_use_id

    if hasattr(message, 'error') and message.error:
        result["error"] = str(message.error)

    # Extract per-step usage directly from AssistantMessage (after SDK modification)
    # These fields were added to AssistantMessage in types.py and message_parser.py
    if hasattr(message, 'message_id') and message.message_id:
        result["api_message_id"] = message.message_id

    if hasattr(message, 'usage') and message.usage:
        # For AssistantMessage, this is per-step usage
        step_usage = extract_usage_from_obj(message.usage)
        if step_usage and type(message).__name__ == 'AssistantMessage':
            result["step_usage"] = step_usage

    # Capture usage information from ResultMessage (final summary)
    if hasattr(message, 'total_cost_usd'):
        result["total_cost_usd"] = message.total_cost_usd

    # For ResultMessage, store usage in "usage" field (not step_usage)
    if hasattr(message, 'usage') and type(message).__name__ != 'AssistantMessage':
        usage = extract_usage_from_obj(message.usage)
        if usage:
            result["usage"] = usage

    if hasattr(message, 'modelUsage'):
        model_usage = message.modelUsage
        if isinstance(model_usage, dict):
            result["modelUsage"] = {}
            for model_name, usage_data in model_usage.items():
                if hasattr(usage_data, '__dict__'):
                    result["modelUsage"][model_name] = {
                        k: v for k, v in usage_data.__dict__.items() if not k.startswith('_')
                    }
                elif isinstance(usage_data, dict):
                    result["modelUsage"][model_name] = usage_data

    # Capture duration and turn count
    if hasattr(message, 'duration_ms'):
        result["duration_ms"] = message.duration_ms

    if hasattr(message, 'duration_api_ms'):
        result["duration_api_ms"] = message.duration_api_ms

    if hasattr(message, 'num_turns'):
        result["num_turns"] = message.num_turns

    if hasattr(message, 'subtype'):
        result["subtype"] = message.subtype

    return result


async def run_claude_agent_async(
    user_prompt: str,
    mcp_servers: Dict[str, Any],
    agent_workspace: Path,
    task_label: str = "",
    save_file: Optional[Path] = None,
    episode_data: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Run Claude Agent to solve the task asynchronously.

    Args:
        user_prompt: The task prompt to solve
        mcp_servers: MCP servers configuration for Claude Agent SDK
        agent_workspace: Path to agent workspace (used as working directory)
        task_label: Label for logging
        save_file: Path to save episode data (for incremental saves)
        episode_data: Episode data dictionary to update

    Returns:
        List of response messages from Claude Agent (as dictionaries)
    """
    print(f"[{task_label}] Starting Claude Agent...")
    print(f"[{task_label}] MCP Servers: {list(mcp_servers.keys())}")
    print(f"[{task_label}] Working directory: {agent_workspace}")

    messages = []
    episode = []  # Store step-by-step episode data like run_multi_openai_v2.py
    full_messages_history = []  # Store complete message history
    clear_tool_results_events = []  # Track when clear_tool_results API feature activates (detected by input_tokens drops)
    compact_events = []  # Track when SDK-side compaction triggers
    prev_input_tokens = 0  # Track previous input_tokens to detect clear_tool_results events

    # Create PreToolUse hook callback to log tool calls
    async def on_pre_tool_use(
        hook_input: dict,  # Using dict for flexibility
        tool_use_id: str | None,  # noqa: ARG001
        context: HookContext  # noqa: ARG001
    ) -> SyncHookJSONOutput:
        """Hook callback for PreToolUse events - logs tool calls."""
        tool_name = hook_input.get("tool_name", "unknown")
        print(f"[{task_label}] 🔧 Tool: {tool_name}")
        return {}  # Allow all tools

    # Create PreCompact hook callback to track compaction events
    async def on_pre_compact(
        hook_input: dict,  # Using dict for flexibility
        tool_use_id: str | None,  # noqa: ARG001
        context: HookContext  # noqa: ARG001
    ) -> SyncHookJSONOutput:
        """Hook callback for PreCompact events - tracks compaction."""
        trigger = hook_input.get("trigger", "unknown")  # "manual" or "auto"
        custom_instructions = hook_input.get("custom_instructions")
        timestamp = time.time()

        compact_event = {
            "step": len(episode) + 1,  # Current step count
            "timestamp": timestamp,
            "trigger": trigger,
            "custom_instructions": custom_instructions,
            "session_id": hook_input.get("session_id"),
            "cwd": hook_input.get("cwd"),
        }
        compact_events.append(compact_event)

        print(f"[{task_label}] 📦 COMPACT triggered (trigger={trigger})")
        if custom_instructions:
            print(f"[{task_label}]   Custom instructions: {custom_instructions[:100]}...")

        return {}  # Allow compaction to proceed

    # Build allowed_tools list for all MCP servers
    allowed_tools = []
    for server_name in mcp_servers.keys():
        allowed_tools.append(f"mcp__{server_name}__*")

    print(f"[{task_label}] Allowed tools patterns: {allowed_tools}")

    # Configure hooks for tool call logging and compaction tracking
    hooks_config = {
        "PreToolUse": [
            HookMatcher(
                matcher=None,  # Match all tools
                hooks=[on_pre_tool_use],
                timeout=30.0,
            )
        ],
        "PreCompact": [
            HookMatcher(
                matcher=None,  # Match all compact events
                hooks=[on_pre_compact],
                timeout=30.0,
            )
        ],
    }

    step_count = 0
    # Run Claude Agent with MCP tools and hooks
    # Use ClaudeSDKClient instead of query() to enable hooks (hooks require streaming mode)
    options = ClaudeAgentOptions(
        mcp_servers=mcp_servers,
        cwd=str(agent_workspace),
        allowed_tools=allowed_tools,
        permission_mode="bypassPermissions",
        hooks=hooks_config,
    )

    async with ClaudeSDKClient(options) as client:
        # Send the initial prompt
        await client.query(user_prompt)

        # Receive all messages until ResultMessage
        async for message in client.receive_response():
            step_count += 1
            message_dict = message_to_dict(message)
            message_dict["step"] = step_count
            message_dict["timestamp"] = time.time()
            messages.append(message_dict)
            full_messages_history.append(message_dict.copy())

            # Log message type and content summary
            msg_type = message_dict.get("type", "Unknown")
            content = message_dict.get("content", "")

            # Create content summary for logging
            if isinstance(content, list):
                content_summary = []
                for item in content:
                    if isinstance(item, dict):
                        item_type = item.get("type", "unknown")
                        if item_type == "TextBlock":
                            text = item.get("text", "")
                            content_summary.append(f"Text({len(text)} chars)")
                        elif item_type == "ToolUseBlock":
                            tool_name = item.get("name", "unknown")
                            content_summary.append(f"ToolUse({tool_name})")
                        elif item_type == "ToolResultBlock":
                            tool_id = item.get("tool_use_id", "unknown")[:8]
                            is_error = item.get("is_error", False)
                            content_summary.append(f"ToolResult({tool_id}..., error={is_error})")
                        else:
                            content_summary.append(f"{item_type}")
                    else:
                        content_summary.append(str(item)[:50])
                content_str = ", ".join(content_summary)
            else:
                content_str = str(content)[:100] if content else "empty"

            print(f"[{task_label}] Step {step_count}: {msg_type} - {content_str}")

            # Detect clear_tool_results events by monitoring total input_tokens drops
            # When clear_tool_results API feature triggers, total input_tokens drops significantly
            # Note: With prompt caching, we need to sum all input token types:
            #   total = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
            if "step_usage" in message_dict:
                step_usage = message_dict["step_usage"]
                # Calculate total input tokens (including cached tokens)
                current_input_tokens = (
                    step_usage.get("input_tokens", 0) +
                    step_usage.get("cache_read_input_tokens", 0) +
                    step_usage.get("cache_creation_input_tokens", 0)
                )
                if prev_input_tokens > 0 and current_input_tokens < prev_input_tokens:
                    tokens_dropped = prev_input_tokens - current_input_tokens
                    # Significant drop (>5000 tokens) indicates clear_tool_results triggered
                    if tokens_dropped > 5000:
                        print(f"[{task_label}] ⚠️  CLEAR_TOOL_RESULTS detected at step {step_count}!")
                        print(f"[{task_label}]   Total input tokens: {prev_input_tokens:,} → {current_input_tokens:,} (dropped {tokens_dropped:,})")
                        clear_tool_results_events.append({
                            "step": step_count,
                            "timestamp": message_dict["timestamp"],
                            "prev_input_tokens": prev_input_tokens,
                            "current_input_tokens": current_input_tokens,
                            "tokens_dropped": tokens_dropped,
                        })
                prev_input_tokens = current_input_tokens

            # Log usage information if this is a ResultMessage (final summary)
            if msg_type == "ResultMessage" or message_dict.get("subtype"):
                if "total_cost_usd" in message_dict:
                    print(f"[{task_label}] Total cost: ${message_dict['total_cost_usd']:.6f}")
                if "usage" in message_dict:
                    usage = message_dict["usage"]
                    input_tokens = usage.get("input_tokens", 0)
                    output_tokens = usage.get("output_tokens", 0)
                    cache_read = usage.get("cache_read_input_tokens", 0)
                    cache_creation = usage.get("cache_creation_input_tokens", 0)
                    print(f"[{task_label}] Token usage - Input: {input_tokens}, Output: {output_tokens}, "
                          f"Cache read: {cache_read}, Cache creation: {cache_creation}")
                if "modelUsage" in message_dict:
                    for model_name, model_usage in message_dict["modelUsage"].items():
                        model_cost = model_usage.get("costUSD", 0)
                        model_input = model_usage.get("inputTokens", 0)
                        model_output = model_usage.get("outputTokens", 0)
                        print(f"[{task_label}] Model {model_name}: ${model_cost:.6f}, "
                              f"input={model_input}, output={model_output}")

            # Record episode step data (similar to run_multi_openai_v2.py)
            episode_step = {
                "step": step_count,
                "message_type": msg_type,
                "message": message_dict,
                "timestamp": message_dict["timestamp"],
            }

            # Add per-step usage data to episode_step
            if "step_usage" in message_dict:
                step_usage = message_dict["step_usage"]
                episode_step["usage"] = {
                    "input_tokens": step_usage.get("input_tokens", 0),
                    "output_tokens": step_usage.get("output_tokens", 0),
                    "cache_read_input_tokens": step_usage.get("cache_read_input_tokens", 0),
                    "cache_creation_input_tokens": step_usage.get("cache_creation_input_tokens", 0),
                }

            # Add final result usage/cost to episode_step (for ResultMessage)
            if msg_type == "ResultMessage" or message_dict.get("subtype"):
                if "total_cost_usd" in message_dict:
                    episode_step["total_cost_usd"] = message_dict["total_cost_usd"]
                if "usage" in message_dict:
                    episode_step["final_usage"] = message_dict["usage"]
                if "modelUsage" in message_dict:
                    episode_step["model_usage"] = message_dict["modelUsage"]
                if "num_turns" in message_dict:
                    episode_step["num_turns"] = message_dict["num_turns"]
                if "duration_ms" in message_dict:
                    episode_step["duration_ms"] = message_dict["duration_ms"]
                if "duration_api_ms" in message_dict:
                    episode_step["duration_api_ms"] = message_dict["duration_api_ms"]

            episode.append(episode_step)

            # Save progress after each step if save_file is provided
            if save_file is not None and episode_data is not None:
                episode_data["steps"] = episode
                episode_data["messages"] = messages
                episode_data["full_messages_history"] = full_messages_history
                episode_data["clear_tool_results_events"] = clear_tool_results_events
                episode_data["compact_events"] = compact_events
                episode_data["total_steps"] = step_count
                episode_data["completed"] = False

                try:
                    envelope = make_base_envelope(
                        backend="claude_agent",
                        task={
                            "task_id": episode_data.get("task_id"),
                            "config_id": episode_data.get("config_id"),
                            "run_id": episode_data.get("run_id"),
                            "config_name": episode_data.get("config_name"),
                            "env_class": episode_data.get("env_class"),
                            "env_params": episode_data.get("env_params"),
                        },
                    )
                    attach_conversation(
                        envelope,
                        messages=messages,
                        full_messages_history=full_messages_history,
                    )
                    attach_events(
                        envelope,
                        clear_tool_results=clear_tool_results_events,
                        compact=compact_events,
                    )
                    attach_metrics(
                        envelope,
                        total_steps=step_count,
                        completed=False,
                    )
                    attach_provider_payload(
                        envelope,
                        task_label=task_label,
                    )
                    write_trajectory_file(
                        save_file,
                        envelope=envelope,
                        legacy_payload=episode_data,
                        indent=4,
                    )
                    print(f"[{task_label}] Progress saved to: {save_file}")
                except Exception as e:
                    print(f"[{task_label}] Warning: Failed to save progress: {e}")

    print(f"[{task_label}] Claude Agent completed with {len(messages)} messages")
    if clear_tool_results_events:
        print(f"[{task_label}] Total clear_tool_results events: {len(clear_tool_results_events)}")
        for event in clear_tool_results_events:
            print(f"[{task_label}]   Step {event['step']}: {event['prev_input_tokens']:,} → {event['current_input_tokens']:,} (dropped {event['tokens_dropped']:,})")
    if compact_events:
        print(f"[{task_label}] Total compact events: {len(compact_events)}")
        for event in compact_events:
            print(f"[{task_label}]   Step {event['step']}: trigger={event['trigger']}")

    # Return both messages and episode for final save
    return messages, episode, full_messages_history, clear_tool_results_events, compact_events


def run_single_task(
    task_id: int,
    config_id: int,
    run_id: int,
    base_task_dir: str,
    output_dir: str,
    env_class: str,
    env_params: Dict[str, Any],
    mcp_configs: Dict[str, Any],
    max_tool_uses: int = 100,
    config_name: str = "",
):
    """Run a single task with Claude Agent SDK.

    Args:
        task_id: Global unique identifier for this task instance
        config_id: Configuration group ID
        run_id: Run number within this configuration
        base_task_dir: Base directory for task data
        output_dir: Directory to save results
        env_class: Full path to environment class
        env_params: Parameters for environment initialization
        mcp_configs: MCP server configurations
        max_tool_uses: Maximum number of tool uses

    Returns:
        Dictionary with task results
    """
    task_label = f"Task{task_id}-Config{config_id}-Run{run_id}"
    print(f"[{task_label}] Starting...")
    print(f"[{task_label}] Environment: {env_class}")
    print(f"[{task_label}] Params: {env_params}")

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

    # Initialize episode data structure (similar to run_multi_openai_v2.py)
    episode_data = {
        "task_id": task_id,
        "config_id": config_id,
        "run_id": run_id,
        "env_class": env_class,
        "env_params": env_params,
        "steps": [],  # Step-by-step episode data
        "messages": [],  # All messages
        "full_messages_history": [],  # Complete message history
        "clear_tool_results_events": [],  # API-side context management events
        "compact_events": [],  # SDK-side compaction events
        "tools": None,
        "user_prompt": None,
        "initial_observation": None,
        "final_observation": None,
        "accuracy": None,
        "total_steps": 0,
        "completed": False,
        "terminated": False,
        "truncated": False,
        "step_info": None,
        "error": None,
        "start_time": time.time(),
        "end_time": None,
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

        # Setup MCP servers for Claude Agent SDK
        mcp_servers = setup_mcp_servers_for_claude_agent(
            mcp_configs, task_workspace, agent_workspace
        )
        print(f"[{task_label}] MCP servers configured: {list(mcp_servers.keys())}")

        # Also setup the ToolEnvWrapperOpenAI for getting user_prompt and evaluation
        mcp_config = setup_mcp_servers(mcp_configs, task_workspace, agent_workspace)
        tool = MCPTool(mcp_config, validate_on_init=False)
        env_wrapped = ToolEnvWrapperOpenAI(env, tools=[tool], max_tool_uses=max_tool_uses)

        # Reset environment to get the user_prompt
        obs, info, user_prompt, tools = env_wrapped.reset()

        # Save tools information
        tools_info = tools[0] if tools else None

        print(f"[{task_label}] Environment initialized")
        print(f"[{task_label}] User prompt length: {len(user_prompt)}")
        print(f"[{task_label}] Available tools: {len(tools_info) if tools_info else 0}")

        # Update episode data with initial info
        episode_data["config_name"] = config_name
        episode_data["user_prompt"] = user_prompt
        episode_data["tools"] = tools_info
        episode_data["initial_observation"] = obs
        episode_data["mcp_servers"] = list(mcp_servers.keys())

        # Save initial state
        envelope = make_base_envelope(
            backend="claude_agent",
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
            user_prompt=user_prompt,
        )
        attach_metrics(
            envelope,
            total_steps=0,
            completed=False,
        )
        attach_provider_payload(
            envelope,
            tools=tools_info,
            mcp_servers=list(mcp_servers.keys()),
        )
        write_trajectory_file(
            save_file,
            envelope=envelope,
            legacy_payload=episode_data,
            indent=4,
        )
        print(f"[{task_label}] Initial state saved to: {save_file}")

        # Run Claude Agent to solve the task (with incremental saving)
        messages, episode, full_messages_history, clear_tool_results_events, compact_events = asyncio.run(run_claude_agent_async(
            user_prompt=user_prompt,
            mcp_servers=mcp_servers,
            agent_workspace=agent_workspace,
            task_label=task_label,
            save_file=save_file,
            episode_data=episode_data,
        ))

        # Update episode data with final messages
        episode_data["steps"] = episode
        episode_data["messages"] = messages
        episode_data["full_messages_history"] = full_messages_history
        episode_data["clear_tool_results_events"] = clear_tool_results_events
        episode_data["compact_events"] = compact_events
        episode_data["total_steps"] = len(episode)

        # Extract usage information from the final ResultMessage
        usage_summary = {
            "total_cost_usd": None,
            "total_input_tokens": 0,
            "total_output_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
            "model_usage": {},
        }
        for msg in reversed(messages):
            if msg.get("subtype") in ["success", "error_during_execution", "error_max_turns"]:
                usage_summary["total_cost_usd"] = msg.get("total_cost_usd")
                if "usage" in msg:
                    usage_summary["total_input_tokens"] = msg["usage"].get("input_tokens", 0)
                    usage_summary["total_output_tokens"] = msg["usage"].get("output_tokens", 0)
                    usage_summary["cache_read_input_tokens"] = msg["usage"].get("cache_read_input_tokens", 0)
                    usage_summary["cache_creation_input_tokens"] = msg["usage"].get("cache_creation_input_tokens", 0)
                if "modelUsage" in msg:
                    usage_summary["model_usage"] = msg["modelUsage"]
                if "num_turns" in msg:
                    usage_summary["num_turns"] = msg["num_turns"]
                if "duration_ms" in msg:
                    usage_summary["sdk_duration_ms"] = msg["duration_ms"]
                if "duration_api_ms" in msg:
                    usage_summary["api_duration_ms"] = msg["duration_api_ms"]
                break

        episode_data["usage_summary"] = usage_summary
        print(f"[{task_label}] Usage summary: cost=${usage_summary['total_cost_usd']}, "
              f"input_tokens={usage_summary['total_input_tokens']}, "
              f"output_tokens={usage_summary['total_output_tokens']}")

        # Save progress after Claude Agent completes
        envelope = make_base_envelope(
            backend="claude_agent",
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
            messages=messages,
            full_messages_history=full_messages_history,
        )
        attach_events(
            envelope,
            clear_tool_results=clear_tool_results_events,
            compact=compact_events,
        )
        attach_metrics(
            envelope,
            accuracy=episode_data.get("accuracy"),
            total_steps=episode_data.get("total_steps"),
            completed=False,
        )
        attach_provider_payload(
            envelope,
            usage_summary=usage_summary,
            tools=tools_info,
            mcp_servers=list(mcp_servers.keys()),
        )
        write_trajectory_file(
            save_file,
            envelope=envelope,
            legacy_payload=episode_data,
            indent=4,
        )
        print(f"[{task_label}] Claude Agent completed, progress saved")

        # Evaluate the result using the environment
        # Call step with "claim_done" to get the final reward
        env_observation, env_reward, terminated, truncated, step_info = env_wrapped.env.step("claim_done")

        print(f"[{task_label}] Evaluation completed")
        print(f"[{task_label}] Reward (accuracy): {env_reward}")
        print(f"[{task_label}] Terminated: {terminated}")
        print(f"[{task_label}] Step info: {step_info}")

        # Update episode data with final results
        episode_data["accuracy"] = env_reward
        episode_data["final_observation"] = env_observation
        episode_data["terminated"] = terminated
        episode_data["truncated"] = truncated
        episode_data["step_info"] = step_info
        episode_data["completed"] = True
        episode_data["end_time"] = time.time()
        episode_data["duration"] = episode_data["end_time"] - episode_data["start_time"]

        # Save final episode data
        envelope = make_base_envelope(
            backend="claude_agent",
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
            messages=messages,
            full_messages_history=full_messages_history,
            final_observation=env_observation,
        )
        attach_events(
            envelope,
            clear_tool_results=clear_tool_results_events,
            compact=compact_events,
            step_info=step_info,
        )
        attach_metrics(
            envelope,
            accuracy=env_reward,
            total_steps=len(episode),
            completed=True,
            duration=episode_data["duration"],
            terminated=terminated,
            truncated=truncated,
        )
        attach_provider_payload(
            envelope,
            usage_summary=usage_summary,
            tools=tools_info,
            mcp_servers=list(mcp_servers.keys()),
        )
        write_trajectory_file(
            save_file,
            envelope=envelope,
            legacy_payload=episode_data,
            indent=4,
        )

        print(f"[{task_label}] Completed successfully!")
        print(f"[{task_label}] Episode saved to: {save_file}")
        print(f"[{task_label}] Total steps: {len(episode)}")
        print(f"[{task_label}] Total messages: {len(messages)}")
        print(f"[{task_label}] Final accuracy: {env_reward}")
        print(f"[{task_label}] Duration: {episode_data['duration']:.2f} seconds")

        # Write eval.json alongside trajectory when using config_name
        if config_name:
            write_eval_file(
                task_workspace=task_workspace,
                status="success",
                accuracy=env_reward,
                steps=len(episode),
                feedback=str(step_info) if step_info else "",
            )

        return {
            "task_id": task_id,
            "config_id": config_id,
            "run_id": run_id,
            "config_name": config_name,
            "status": "success",
            "steps": len(episode),
            "messages": len(messages),
            "final_reward": env_reward,
            "accuracy": env_reward,
            "save_file": str(save_file),
            "env_class": env_class,
            "env_params": env_params,
            "duration": episode_data["duration"],
            # Usage information
            "total_cost_usd": usage_summary.get("total_cost_usd"),
            "total_input_tokens": usage_summary.get("total_input_tokens", 0),
            "total_output_tokens": usage_summary.get("total_output_tokens", 0),
            "cache_read_input_tokens": usage_summary.get("cache_read_input_tokens", 0),
            "cache_creation_input_tokens": usage_summary.get("cache_creation_input_tokens", 0),
        }

    except Exception as e:
        print(f"[{task_label}] Error: {e}")
        import traceback
        traceback.print_exc()

        # Update episode data with error info
        episode_data["error"] = str(e)
        episode_data["error_traceback"] = traceback.format_exc()
        episode_data["completed"] = False
        episode_data["end_time"] = time.time()
        episode_data["duration"] = episode_data["end_time"] - episode_data["start_time"]

        # Save error episode data
        if config_name:
            error_save_file = task_workspace / "trajectory.json"
        else:
            error_save_file = output_path / f"config{config_id}_run{run_id}-episode-error-{timestamp}.json"
        envelope = make_base_envelope(
            backend="claude_agent",
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
            messages=episode_data.get("messages", []),
            full_messages_history=episode_data.get("full_messages_history", []),
        )
        attach_events(
            envelope,
            clear_tool_results=episode_data.get("clear_tool_results_events", []),
            compact=episode_data.get("compact_events", []),
            error_traceback=episode_data.get("error_traceback"),
        )
        attach_metrics(
            envelope,
            accuracy=0,
            total_steps=len(episode_data.get("steps", [])),
            completed=False,
            duration=episode_data.get("duration", 0),
        )
        attach_provider_payload(
            envelope,
            usage_summary=episode_data.get("usage_summary", {}),
            error=str(e),
        )
        write_trajectory_file(
            error_save_file,
            envelope=envelope,
            legacy_payload=episode_data,
            indent=4,
        )

        print(f"[{task_label}] Error episode saved to: {error_save_file}")

        # Write eval.json for error case when using config_name
        if config_name:
            write_eval_file(
                task_workspace=task_workspace,
                status="error",
                accuracy=0,
                steps=len(episode_data.get("steps", [])),
                feedback=str(e),
            )

        return {
            "task_id": task_id,
            "config_id": config_id,
            "run_id": run_id,
            "config_name": config_name,
            "status": "error",
            "error": str(e),
            "steps": len(episode_data.get("steps", [])),
            "messages": len(episode_data.get("messages", [])),
            "env_class": env_class,
            "env_params": env_params,
            "duration": episode_data.get("duration", 0),
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
    model: Optional[str] = None,
    max_tool_uses: int = 100,
    max_workers: Optional[int] = None,
    group_by_seed: bool = True,
    # Context management options (Claude Agent SDK)
    use_clear_tool_uses: bool = False,
    use_clear_tool_results: bool = False,
    api_max_input_tokens: int = 180000,
    api_target_input_tokens: int = 40000,
    # Prompt caching options
    disable_prompt_caching: bool = False,
    # Compaction options (SDK-side context management)
    disable_compact: bool = False,
    autocompact_pct: int = 80,
):
    """Run multiple configurations in parallel with Claude Agent SDK.

    Args:
        config_file: Path to JSON configuration file
        runs_per_config: Number of runs per configuration
        base_task_dir: Base directory for task workspaces
        output_dir: Directory to save episode results
        model: Model name for Claude Agent SDK / Anthropic-compatible endpoints.
               If None, falls back to ANTHROPIC_MODEL env var.
        max_tool_uses: Maximum tool uses per episode
        max_workers: Maximum parallel workers
        group_by_seed: If True, group configs that differ only by seed as same config
        use_clear_tool_uses: Enable clearing old tool uses when context exceeds threshold
        use_clear_tool_results: Enable clearing tool results with tool inputs
        api_max_input_tokens: Token threshold to trigger clearing (default: 180000)
        api_target_input_tokens: Target tokens to keep after clearing (default: 40000)
        disable_prompt_caching: Disable prompt caching (enabled by default)
        disable_compact: Disable SDK-side auto-compaction (default: False, i.e. enabled)
        autocompact_pct: Percentage of context to trigger compaction (default: 80)
    """
    # Handle string "True"/"False" from command line properly
    def str_to_bool(val):
        if isinstance(val, bool):
            return val
        if isinstance(val, str):
            return val.lower() in ('true', '1', 'yes')
        return bool(val)

    _disable_prompt_caching = str_to_bool(disable_prompt_caching)
    _use_clear_tool_uses = str_to_bool(use_clear_tool_uses)
    _use_clear_tool_results = str_to_bool(use_clear_tool_results)
    _group_by_seed = str_to_bool(group_by_seed)
    _disable_compact = str_to_bool(disable_compact)
    effective_model = model or os.environ.get("ANTHROPIC_MODEL")

    if effective_model:
        os.environ["ANTHROPIC_MODEL"] = effective_model

    # Set environment variables for Claude Agent SDK context management
    if _use_clear_tool_uses:
        os.environ["USE_API_CLEAR_TOOL_USES"] = "true"
    else:
        os.environ.pop("USE_API_CLEAR_TOOL_USES", None)

    if _use_clear_tool_results:
        os.environ["USE_API_CLEAR_TOOL_RESULTS"] = "true"
    else:
        os.environ.pop("USE_API_CLEAR_TOOL_RESULTS", None)

    os.environ["API_MAX_INPUT_TOKENS"] = str(api_max_input_tokens)
    os.environ["API_TARGET_INPUT_TOKENS"] = str(api_target_input_tokens)

    if _disable_prompt_caching:
        os.environ["DISABLE_PROMPT_CACHING"] = "true"
    else:
        os.environ.pop("DISABLE_PROMPT_CACHING", None)

    # Set compaction environment variables
    if _disable_compact:
        os.environ["DISABLE_COMPACT"] = "true"
    else:
        os.environ.pop("DISABLE_COMPACT", None)

    # Set autocompact percentage threshold (default is 80%)
    os.environ["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] = str(autocompact_pct)

    print(f"Context management: clear_tool_uses={_use_clear_tool_uses}, "
          f"clear_tool_results={_use_clear_tool_results}")
    print(f"Compaction: enabled={not _disable_compact}, autocompact_pct={autocompact_pct}%")
    print(f"Token thresholds: max={api_max_input_tokens}, target={api_target_input_tokens}")
    print(f"Prompt caching: {'disabled' if _disable_prompt_caching else 'enabled'}")
    if effective_model:
        print(f"Model: {effective_model}")
    # Load configurations
    with open(config_file, "r") as f:
        config_data = json.load(f)

    configs = config_data.get("configurations", [])
    print(f"Loaded {len(configs)} configurations from {config_file}")

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
    print("CLAUDE AGENT PARALLEL INFERENCE")
    print("=" * 80)
    print(f"Total configurations: {len(configs)}")
    print(f"Unique config groups: {len(config_groups)}")
    print(f"Runs per configuration: {runs_per_config}")
    print(f"Total tasks: {total_tasks}")
    print(f"Max workers: {max_workers}")
    print(f"Base task directory: {base_task_dir}")
    print(f"Output directory: {output_dir}")

    if _group_by_seed:
        print("\nConfiguration Groups:")
        for group_id in sorted(config_groups.keys()):
            config_indices = config_groups[group_id]
            print(f"  Group {group_id}: {len(config_indices)} configs")
            config = configs[config_indices[0]]
            print(f"    Environment: {config.get('env_class', 'N/A')}")
            print(f"    MCP Servers: {list(config.get('mcp_servers', {}).keys())}")
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
                    max_tool_uses,
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
                    max_tool_uses,
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
                    print(f"  Steps: {result['steps']}, Accuracy: {result.get('accuracy', 'N/A')}")
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

    # Analyze results
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
            }

        config_stats[config_id]["total"] += 1
        if result["status"] == "success":
            config_stats[config_id]["success"] += 1
            accuracy = result.get("accuracy", 0)
            config_stats[config_id]["accuracies"].append(accuracy)
            config_stats[config_id]["steps"].append(result["steps"])
            # Track usage
            if result.get("total_cost_usd") is not None:
                config_stats[config_id]["costs"].append(result["total_cost_usd"])
            config_stats[config_id]["input_tokens"].append(result.get("total_input_tokens", 0))
            config_stats[config_id]["output_tokens"].append(result.get("total_output_tokens", 0))
        else:
            config_stats[config_id]["error"] += 1

    # Print summary
    print("\n" + "=" * 80)
    print("CLAUDE AGENT PARALLEL INFERENCE SUMMARY")
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
    print(f"\nTotal Cost: ${total_cost:.6f}")
    print(f"Total Input Tokens: {total_input:,}")
    print(f"Total Output Tokens: {total_output:,}")

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
                    print(f"    Avg Tokens: input={int(avg_input):,}, output={int(avg_output):,}")
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
                    print(f"    Avg Tokens: input={int(avg_input):,}, output={int(avg_output):,}")

    # Save summary
    summary_file = Path(output_dir) / f"summary-{int(time.time())}.json"
    summary = {
        "total_configs": len(configs),
        "unique_config_groups": len(config_groups),
        "group_by_seed": _group_by_seed,
        "runs_per_config": runs_per_config,
        "total_tasks": total_tasks,
        "max_workers": max_workers,
        "model": effective_model or "claude-agent-sdk",
        "elapsed_time": elapsed_time,
        "total_success": total_success,
        "total_error": total_error,
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
                "costs": v["costs"],
                "input_tokens": v["input_tokens"],
                "output_tokens": v["output_tokens"],
            }
            for k, v in config_stats.items()
        },
        # Overall usage summary
        "total_cost_usd": total_cost,
        "total_input_tokens": total_input,
        "total_output_tokens": total_output,
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
            "model": effective_model or "claude-agent-sdk",
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
        python run_claude_agent.py --config_file example_config.json --runs_per_config 3
    """
    fire.Fire(run_config_combinations)


if __name__ == "__main__":
    main()
