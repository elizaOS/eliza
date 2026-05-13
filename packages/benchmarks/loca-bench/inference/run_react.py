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

"""Flexible parallel inference runner with configurable environments and tools."""

import contextlib
import io
import json
import os
import signal
import sys
import time
import importlib
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
                "run_react.py command-line entrypoint."
            )

    fire = _MissingFire()
import requests
from dotenv import load_dotenv
import random
from requests.exceptions import RequestException, HTTPError

# Suppress npm update notices
os.environ["npm_config_update_notifier"] = "false"
os.environ["NO_UPDATE_NOTIFIER"] = "true"
os.environ["NPM_CONFIG_UPDATE_NOTIFIER"] = "false"
os.environ["npm_config_loglevel"] = "error"
os.environ["NPM_CONFIG_LOGLEVEL"] = "error"

# Suppress FastMCP banner
os.environ["FASTMCP_SHOW_CLI_BANNER"] = "false"

# Suppress MCP server verbose output by default (can be overridden)
os.environ.setdefault("LOCA_QUIET", "1")

# Suppress MCP/FastMCP logging output
import logging
# Set root logger to WARNING to suppress INFO messages
logging.basicConfig(level=logging.WARNING, force=True)
logging.getLogger().setLevel(logging.WARNING)
# Suppress specific noisy loggers
for logger_name in ["mcp", "fastmcp", "mcp.server", "mcp.client", "httpx", "httpcore", "asyncio"]:
    logging.getLogger(logger_name).setLevel(logging.WARNING)

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
    write_json_file,
    write_results_file,
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


SUMMARY_MIN_STEPS_BETWEEN_EVENTS = 4
SUMMARY_MIN_MESSAGES_SINCE_LAST = 8


def should_generate_context_summary(
    *,
    total_tokens: int,
    reset_size: int,
    messages_count: int,
    step_count: int,
    messages_tokens: int = 0,
    tools_tokens: int = 0,
    last_summary_event: Optional[Dict[str, Any]] = None,
    max_context_size: Optional[int] = None,
    max_tokens: int = 4096,
) -> tuple[bool, str]:
    """Decide whether summary compaction can help this turn.

    LOCA counts static tool schemas in ``total_tokens``. Summarizing the
    conversation cannot shrink that static overhead, so a small reset threshold
    can otherwise cause summary-on-every-turn thrash. A hard context limit still
    bypasses the cooldown because the next provider call may fail without a
    compaction attempt.
    """

    if total_tokens <= reset_size:
        return False, "under_reset_size"

    hard_limit = max_context_size - max_tokens if max_context_size is not None else None
    if hard_limit is not None and total_tokens >= hard_limit:
        return True, "hard_context_limit"

    if tools_tokens >= int(reset_size * 0.7):
        return False, "static_overhead_dominated"

    if not last_summary_event:
        return True, "first_over_reset_size"

    last_step = int(last_summary_event.get("step", -10**9) or -10**9)
    if step_count - last_step < SUMMARY_MIN_STEPS_BETWEEN_EVENTS:
        return False, "summary_cooldown_steps"

    messages_after = int(last_summary_event.get("messages_after_count", 0) or 0)
    if messages_after and messages_count - messages_after < SUMMARY_MIN_MESSAGES_SINCE_LAST:
        return False, "summary_cooldown_messages"

    return True, "over_reset_size"


def select_summary_tail(messages: List[Dict[str, Any]], max_messages: int = 8) -> List[Dict[str, Any]]:
    """Keep a recent tail after summary without split tool-call blocks."""

    if max_messages <= 0:
        return []
    start = max(0, len(messages) - max_messages)

    def produced_call_ids(candidate: List[Dict[str, Any]]) -> set[str]:
        ids: set[str] = set()
        for message in candidate:
            if not isinstance(message, dict):
                continue
            for call in message.get("tool_calls", []) or []:
                if isinstance(call, dict) and call.get("id"):
                    ids.add(str(call["id"]))
        return ids

    while True:
        tail = [dict(message) for message in messages[start:]]
        producer_ids = produced_call_ids(tail)
        missing_tool_call_ids = [
            str(message.get("tool_call_id"))
            for message in tail
            if isinstance(message, dict)
            and message.get("role") == "tool"
            and message.get("tool_call_id")
            and str(message.get("tool_call_id")) not in producer_ids
        ]
        if not missing_tool_call_ids:
            return tail

        moved = False
        for index in range(start - 1, -1, -1):
            message = messages[index]
            if not isinstance(message, dict):
                continue
            call_ids = {
                str(call["id"])
                for call in message.get("tool_calls", []) or []
                if isinstance(call, dict) and call.get("id")
            }
            if call_ids.intersection(missing_tool_call_ids):
                start = index
                moved = True
                break
        if not moved:
            while tail and tail[0].get("role") == "tool":
                tail.pop(0)
            return tail


def compute_api_token_metrics(usage_tracking: List[Dict[str, Any]]) -> Dict[str, int]:
    """Aggregate provider usage for a run."""

    api_prompt_tokens = 0
    api_completion_tokens = 0
    api_total_tokens = 0
    api_max_prompt_tokens = 0
    api_max_total_tokens = 0

    for usage in usage_tracking or []:
        prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
        completion_tokens = int(usage.get("completion_tokens", 0) or 0)
        total_tokens = int(usage.get("total_tokens", 0) or 0)

        api_prompt_tokens += prompt_tokens
        api_completion_tokens += completion_tokens
        api_total_tokens += total_tokens
        api_max_prompt_tokens = max(api_max_prompt_tokens, prompt_tokens)
        api_max_total_tokens = max(api_max_total_tokens, total_tokens)

    return {
        "api_prompt_tokens": api_prompt_tokens,
        "api_completion_tokens": api_completion_tokens,
        "api_total_tokens": api_total_tokens,
        "api_max_prompt_tokens": api_max_prompt_tokens,
        "api_max_total_tokens": api_max_total_tokens,
    }


def extract_stop_reason(response: Dict[str, Any]) -> Optional[str]:
    """Return the provider stop/finish reason when present."""

    stop_reason = response.get("stop_reason")
    if stop_reason:
        return str(stop_reason)

    raw_response = response.get("raw_response", {})
    choices = raw_response.get("choices", []) if isinstance(raw_response, dict) else []
    if choices and isinstance(choices[0], dict):
        finish_reason = choices[0].get("finish_reason")
        if finish_reason is not None:
            return str(finish_reason)
    return None


def reward_clearly_successful(reward: Any) -> bool:
    """Treat only unambiguous full-credit rewards as successful."""

    if reward is True:
        return True
    try:
        return float(reward) >= 1.0
    except (TypeError, ValueError):
        return False


def determine_final_status(*, terminated: bool, truncated: bool, reward: Any) -> str:
    """Map environment termination flags to the persisted run status."""

    if terminated and not truncated:
        return "success"
    if reward_clearly_successful(reward):
        return "success"
    if truncated:
        return "truncated"
    return "error"


def build_run_metrics(
    *,
    accuracy: Any,
    total_steps: int,
    completed: bool,
    terminated: bool,
    truncated: bool,
    stop_reason: Optional[str],
    status: Optional[str] = None,
) -> Dict[str, Any]:
    metrics = {
        "accuracy": accuracy,
        "total_steps": total_steps,
        "completed": completed,
        "terminated": bool(terminated),
        "truncated": bool(truncated),
        "stop_reason": stop_reason,
    }
    if status is not None:
        metrics["status"] = status
    return metrics


@contextlib.contextmanager
def suppress_stdout():
    """Context manager to suppress stdout output from preprocessing scripts."""
    old_stdout = sys.stdout
    sys.stdout = io.StringIO()
    try:
        yield
    finally:
        sys.stdout = old_stdout


@contextlib.contextmanager
def suppress_all_output():
    """Suppress all stdout/stderr at both Python and OS file-descriptor levels.

    This catches output that the Python-level sys.stdout replacement misses:
    - Loggers whose StreamHandlers captured the original stream object
    - C extensions writing directly to fd 1/2
    - Subprocess output inherited from the parent
    """
    # Save Python-level streams
    old_stdout = sys.stdout
    old_stderr = sys.stderr

    # Save OS-level file descriptors
    fd_ok = True
    try:
        stdout_fd = old_stdout.fileno()
        stderr_fd = old_stderr.fileno()
        saved_stdout_fd = os.dup(stdout_fd)
        saved_stderr_fd = os.dup(stderr_fd)
    except (io.UnsupportedOperation, AttributeError, OSError):
        fd_ok = False

    # Redirect OS-level fds to /dev/null
    if fd_ok:
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, stdout_fd)
        os.dup2(devnull, stderr_fd)
        os.close(devnull)

    # Replace Python-level streams
    sys.stdout = io.StringIO()
    sys.stderr = io.StringIO()

    # Suppress logging at INFO level and below
    prev_disable = logging.root.manager.disable
    logging.disable(logging.INFO)

    try:
        yield
    finally:
        # Restore logging
        logging.disable(prev_disable)

        # Restore Python-level streams
        sys.stdout = old_stdout
        sys.stderr = old_stderr

        # Restore OS-level file descriptors
        if fd_ok:
            os.dup2(saved_stdout_fd, stdout_fd)
            os.dup2(saved_stderr_fd, stderr_fd)
            os.close(saved_stdout_fd)
            os.close(saved_stderr_fd)


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
        params = dict(server_config.get("params", {}))
        
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


def _is_cerebras_endpoint(api_url: str) -> bool:
    return "api.cerebras.ai" in api_url


def chat_completions_url(base_url: str) -> str:
    """Normalize a base URL or a full chat-completions URL."""

    trimmed = base_url.rstrip("/")
    if trimmed.endswith("/chat/completions"):
        return trimmed
    return f"{trimmed}/chat/completions"


def _extract_text_field(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(part for part in parts if part)
    return str(value)


def extract_assistant_text(message: Dict[str, Any]) -> str:
    """Return visible assistant text across OpenAI-compatible response shapes.

    Cerebras ``gpt-oss-120b`` can put the final text in ``message.reasoning``
    while leaving ``message.content`` empty. LOCA's runner treats empty content
    as a retryable failure, which turns a valid response into repeated retries.
    Normalize that provider shape here and keep the rest of the runner provider
    agnostic.
    """

    for key in ("content", "reasoning", "reasoning_content"):
        text = _extract_text_field(message.get(key))
        if text.strip():
            return text
    extra = message.get("model_extra")
    if isinstance(extra, dict):
        for key in ("content", "reasoning", "reasoning_content"):
            text = _extract_text_field(extra.get(key))
            if text.strip():
                return text
    return ""


def normalize_assistant_message_for_history(message: Dict[str, Any]) -> Dict[str, Any]:
    """Remove provider-private reasoning fields before reusing a message.

    OpenAI-compatible APIs generally accept prior assistant reasoning only when
    it is folded into regular assistant content. Resending provider-specific
    fields such as ``reasoning`` or ``reasoning_content`` makes later turns
    fail on Cerebras and several other providers.
    """

    normalized = dict(message)
    text = extract_assistant_text(normalized)
    if text.strip():
        normalized["content"] = text
    normalized.pop("reasoning", None)
    normalized.pop("reasoning_content", None)
    normalized.pop("reasoning_details", None)
    normalized.pop("model_extra", None)
    return normalized


def make_aihubmix_api_request(
    messages: List[Dict],
    model_name: str,
    aihubmix_api_keys: str,
    aihubmix_api_url: str = "https://aihubmix.com/v1/chat/completions",
    tools: Optional[List] = None,
    tool_choice: Optional[str] = None,
    max_retries: int = 200,
    request_timeout: int = 60,
    initial_retry_delay: float = 1.0,
    temperature: float = 1.0,
    top_p: float = 1.0,
    max_tokens: int = 4096,
    max_context_size: Optional[int] = None,
    context_awareness: bool = False,
    reasoning_effort: Optional[str] = None,
    reasoning_max_tokens: Optional[int] = None,
    reasoning_enabled: bool = True,
    reasoning_exclude: bool = False,
):
    """Make AIHubMix API request with retry logic.

    Args:
        messages: The messages to send to the API
        model_name: Name of the model to use
        aihubmix_api_keys: API key(s) for AIHubMix (comma-separated)
        aihubmix_api_url: The AIHubMix API endpoint URL
        tools: Optional list of tools to include in the request
        tool_choice: Optional tool choice parameter
        max_retries: Maximum number of retry attempts
        temperature: Sampling temperature
        top_p: Top-p sampling parameter
        max_tokens: Maximum number of tokens to generate
        max_context_size: Maximum context size in tokens (if set, will trim messages to fit)
        context_awareness: If True, will also remove token usage user messages when trimming

    Returns:
        Processed response object with type and data
    """
    verbose = False
    # Determine API keys to use
    api_keys = []
    if isinstance(aihubmix_api_keys, list):
        api_keys = aihubmix_api_keys
    elif isinstance(aihubmix_api_keys, str) and ',' in aihubmix_api_keys:
        api_keys = aihubmix_api_keys.split(',')
    else:
        api_keys = [aihubmix_api_keys]
    
    # Randomly select an API key for this request
    current_api_key = random.choice(api_keys)
    
    # Prepare headers for API request
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + str(current_api_key)
    }

    if verbose:
        print(f"Headers: {headers}")
    
    # Track whether messages were trimmed
    trimmed_messages = None
    trim_info = None  # Store trim information
    original_message_count = len(messages)
    
    # Prepare request data
    json_data = {
        "model": model_name,
        "messages": messages,
        "temperature": temperature,
        "top_p": top_p,
        "max_tokens": max_tokens
    }

    # Add reasoning control parameters for OpenAI models that support reasoning
    # Convert empty strings to None for proper handling
    if reasoning_effort == "":
        reasoning_effort = None
    if reasoning_max_tokens == "":
        reasoning_max_tokens = None

    if _is_cerebras_endpoint(aihubmix_api_url):
        # Cerebras follows the OpenAI-compatible top-level field for effort.
        # The nested ``reasoning`` object used by some aggregators is rejected
        # by Cerebras and can make LOCA retry a request that will never work.
        if reasoning_effort is not None:
            json_data["reasoning_effort"] = reasoning_effort
    elif reasoning_effort is not None or reasoning_max_tokens is not None:
        reasoning_config = {}

        # Set reasoning effort or max_tokens
        if reasoning_effort is not None:
            reasoning_config["effort"] = reasoning_effort
        elif reasoning_max_tokens is not None:
            reasoning_config["max_tokens"] = reasoning_max_tokens

        # Set enabled flag (default: inferred from effort or max_tokens)
        reasoning_config["enabled"] = reasoning_enabled

        # Set exclude flag (default: false)
        reasoning_config["exclude"] = reasoning_exclude

        json_data["reasoning"] = reasoning_config
    
    # Estimate tokens before making the API call
    try:
        import tiktoken
        # Get tokenizer
        try:
            tokenizer = tiktoken.encoding_for_model(model_name)
        except:
            tokenizer = tiktoken.get_encoding("cl100k_base")
        
        # Calculate tokens for messages
        messages_tokens = 0
        messages_str = json.dumps(messages, ensure_ascii=False)
        messages_tokens = len(tokenizer.encode(messages_str, disallowed_special=()))
        
        # Calculate tokens for tools if provided
        tools_tokens = 0
        if tools:
            tools_str = json.dumps(tools, ensure_ascii=False)
            tools_tokens = len(tokenizer.encode(tools_str, disallowed_special=()))
        
        total_estimated_tokens = messages_tokens + tools_tokens
        if verbose:
            print(f"📊 Estimated tokens - Messages: {messages_tokens:,}, Tools: {tools_tokens:,}, Total: {total_estimated_tokens:,}")

        # Trim messages if exceeding max_context_size - max_tokens (reserve space for output)
        if max_context_size is not None and total_estimated_tokens > max_context_size - max_tokens:
            available_context = max_context_size - max_tokens
            if verbose:
                print(f"⚠️  Total tokens ({total_estimated_tokens:,}) exceeds available context ({available_context:,} = {max_context_size:,} - {max_tokens:,}). Trimming messages...")
            
            original_message_count = len(messages)
            
            # Strategy: Remove assistant and tool messages from the beginning until we fit
            # Keep removing messages one by one from the start
            current_messages = messages.copy()
            removed_count = 0
            
            while len(current_messages) > 0:
                # Calculate current token count
                current_messages_str = json.dumps(current_messages, ensure_ascii=False)
                current_tokens = len(tokenizer.encode(current_messages_str, disallowed_special=()))
                current_total = current_tokens + tools_tokens
                
                # If we fit within the limit (available_context = max_context_size - max_tokens), we're done
                if current_total <= available_context:
                    messages = current_messages
                    break
                
                # Otherwise, try to remove the first assistant or tool message
                # If assistant has tool_calls, also remove all corresponding tool results
                # If context_awareness is enabled, also remove paired token usage user messages
                removed_any = False
                for i in range(len(current_messages)):
                    msg_role = current_messages[i].get('role')

                    # Remove assistant messages
                    if msg_role == 'assistant':
                        msg = current_messages.pop(i)
                        removed_count += 1
                        removed_any = True

                        # If this assistant message has tool_calls, remove all corresponding tool results
                        if 'tool_calls' in msg and msg['tool_calls']:
                            tool_call_ids = {tc['id'] for tc in msg['tool_calls']}

                            # Find and remove all tool messages with matching tool_call_id
                            j = 0
                            while j < len(current_messages):
                                if current_messages[j].get('role') == 'tool':
                                    if current_messages[j].get('tool_call_id') in tool_call_ids:
                                        current_messages.pop(j)
                                        removed_count += 1
                                        # Don't increment j since we just removed an element
                                        continue
                                j += 1

                            # If context_awareness is enabled, remove the token usage message
                            # that comes after all the tool results
                            if context_awareness:
                                # Look for the next user message with token usage starting from position i
                                j = i
                                while j < len(current_messages):
                                    if current_messages[j].get('role') == 'user':
                                        content = current_messages[j].get('content', '')
                                        if isinstance(content, str) and '<system_warning>Token usage:' in content:
                                            current_messages.pop(j)
                                            removed_count += 1
                                            break
                                    j += 1

                            # Also remove memory warning messages if present after tool results
                            j = i
                            while j < len(current_messages):
                                if current_messages[j].get('role') == 'user':
                                    content = current_messages[j].get('content', '')
                                    if isinstance(content, str) and '**You are nearing the context window limit.**' in content:
                                        current_messages.pop(j)
                                        removed_count += 1
                                        break
                                j += 1
                        break

                    # Remove standalone tool messages
                    elif msg_role == 'tool':
                        current_messages.pop(i)
                        removed_count += 1
                        removed_any = True

                        # If context_awareness is enabled, check if next message is token usage
                        if context_awareness and i < len(current_messages):
                            next_msg = current_messages[i]
                            if next_msg.get('role') == 'user':
                                next_content = next_msg.get('content', '')
                                if isinstance(next_content, str) and '<system_warning>Token usage:' in next_content:
                                    current_messages.pop(i)
                                    removed_count += 1

                        # Also remove memory warning messages if present
                        # Check if next message is memory warning
                        if i < len(current_messages):
                            next_msg = current_messages[i]
                            if next_msg.get('role') == 'user':
                                next_content = next_msg.get('content', '')
                                if isinstance(next_content, str) and '**You are nearing the context window limit.**' in next_content:
                                    current_messages.pop(i)
                                    removed_count += 1
                        break

                # If no assistant or tool message found to remove, we can't trim further
                if not removed_any:
                    # Keep what we have and break
                    messages = current_messages
                    break
            
            # Recalculate final token count
            final_messages_str = json.dumps(messages, ensure_ascii=False)
            final_messages_tokens = len(tokenizer.encode(final_messages_str, disallowed_special=()))
            final_total_tokens = final_messages_tokens + tools_tokens
            
            if verbose:
                print(f"✂️  Trimmed messages: {original_message_count} -> {len(messages)} messages (removed {removed_count} assistant/tool messages)")
                print(f"📊 After trimming - Messages: {final_messages_tokens:,}, Tools: {tools_tokens:,}, Total: {final_total_tokens:,}")
                print(f"📊 Available context for output: {max_tokens:,} tokens (reserved from {max_context_size:,} total)")

            # Check if trimming removed all assistant/tool messages (only user messages left)
            has_non_user_messages = any(msg.get('role') in ['assistant', 'tool'] for msg in messages)

            if not has_non_user_messages and removed_count > 0:
                # All assistant/tool messages were removed, only user messages remain
                error_msg = (
                    f"ERROR: Context trimming removed all {removed_count} assistant/tool messages. "
                    f"Only user messages remain ({len(messages)} messages, {final_messages_tokens:,} tokens). "
                    f"The conversation context has been lost. "
                    f"Current total: {final_total_tokens:,} tokens (max available: {available_context:,} = {max_context_size:,} - {max_tokens:,}). "
                    f"Please increase max_context_size or reduce conversation length."
                )
                if verbose:
                    print(f"🚨 {error_msg}")
                return {
                    'type': 'error',
                    'data': [error_msg],
                    'call_messages': {
                        'role': 'assistant',
                        'content': error_msg
                    }
                }
            
            # Check if we still exceed the limit after trimming
            if final_total_tokens > available_context:
                error_msg = (
                    f"ERROR: Cannot fit messages within available context ({available_context:,} = {max_context_size:,} - {max_tokens:,} tokens). "
                    f"After removing {removed_count} assistant/tool messages, "
                    f"still have {final_total_tokens:,} tokens (Messages: {final_messages_tokens:,}, Tools: {tools_tokens:,}). "
                    f"Cannot trim further without losing user messages. "
                    f"Please increase max_context_size."
                )
                if verbose:
                    print(f"🚨 {error_msg}")
                return {
                    'type': 'error',
                    'data': [error_msg],
                    'call_messages': {
                        'role': 'assistant',
                        'content': error_msg
                    }
                }

            # Update json_data with trimmed messages
            json_data["messages"] = messages
            trimmed_messages = messages  # Save trimmed messages to return to caller

            # Create trim info to return to caller
            import copy
            trim_info = {
                'original_message_count': original_message_count,
                'trimmed_message_count': len(messages),
                'removed_count': removed_count,
                'original_total_tokens': total_estimated_tokens,
                'trimmed_total_tokens': final_total_tokens,
                'messages_tokens': final_messages_tokens,
                'tools_tokens': tools_tokens,
                'max_context_size': max_context_size,
                'max_tokens': max_tokens,
                'available_context': available_context,
                'messages_after_trim_sample': copy.deepcopy(messages)  # Sample of messages after trimming
            }

    except Exception as e:
        if verbose:
            print(f"⚠️  Token estimation failed: {e}")

    only_setting = []  # Default
    if "moonshotai" in model_name:
        only_setting = ['moonshotai']
        json_data["provider"] = {
        "only": only_setting
    }
    elif "z-ai" in model_name:
        only_setting = ['z-ai']
        json_data["provider"] = {
        "only": only_setting
    }
    elif "gemini" in model_name:
        only_setting = ['google-vertex']
        json_data["provider"] = {
        "only": only_setting
    }
    # elif "minimax" in model_name:
    #     only_setting = ['minimax/fp8']
    #     json_data["provider"] = {
    #     "only": only_setting
    # }
    elif "openai" in model_name:
        only_setting = ['azure']
        json_data["provider"] = {
        "only": only_setting
    }
    elif "qwen" in model_name:
        only_setting = ['alibaba/opensource']
        json_data["provider"] = {
        "only": only_setting
    }
    elif "claude" in model_name:
        #only_setting = ['anthropic']
        pass
    else:
        pass

    if verbose:
        print(f"JSON data: {json_data}")

    # Add tools if provided
    if tools:
        json_data["tools"] = tools
    if tool_choice:
        json_data["tool_choice"] = tool_choice

    # Track retry attempts
    times = 0

    while times < max_retries:
        try:
            # Make API request
            if verbose:
                print(f"Making API request to: {aihubmix_api_url}")
            response = requests.post(
                aihubmix_api_url,
                headers=headers,
                json=json_data,
                timeout=request_timeout
            )
            if verbose:
                print(f"Response status: {response.status_code}")
            
            if response.status_code == 200:
                try:
                    res = json.loads(response.text)
                    
                    # Extract token usage information if available
                    if "usage" in res:
                        usage = res.get("usage", {})
                        prompt_tokens = usage.get("prompt_tokens", 0)
                        completion_tokens = usage.get("completion_tokens", 0)
                        total_tokens = usage.get("total_tokens", 0)
                        if verbose:
                            print(f"Token usage: prompt_tokens={prompt_tokens}, completion_tokens={completion_tokens}, total_tokens={total_tokens}")

                    # Process response
                    result = []
                    is_tool = False
                    should_retry = False

                    for choice in res['choices']:
                        finish_reason = choice.get('finish_reason', '')
                        if verbose:
                            print(f"Finish reason: {finish_reason}")

                        if finish_reason == 'error':
                            if verbose:
                                print(f"Received error finish reason. Retrying request...")
                            should_retry = True
                            break
                        elif finish_reason == 'length':
                            if verbose:
                                print(f"WARNING: Response truncated due to max_tokens limit!")
                                print(f"Current max_tokens: {max_tokens}")
                                print(f"Retrying request to get complete response...")
                            should_retry = True
                            break
                        elif finish_reason is None:
                            if verbose:
                                print(f"Received None finish reason. Retrying request...")
                            should_retry = True
                            break
                        else:
                            # Check for tool_calls in the message first
                            # Some providers (e.g., Google Gemini) return finish_reason="stop" even with tool_calls
                            message = choice.get('message', {})
                            has_tool_calls = 'tool_calls' in message and message['tool_calls']

                            if has_tool_calls:
                                # Handle tool calls regardless of finish_reason
                                message = normalize_assistant_message_for_history(message)
                                result.extend(message.get('tool_calls', []))
                                is_tool = True
                                if verbose:
                                    print(f"Detected tool_calls in message with finish_reason={finish_reason}")
                            else:
                                # Normal content response
                                content = extract_assistant_text(message)

                                # Check if content is empty and no tool_calls
                                if not content or not content.strip():
                                    if verbose:
                                        print(f"Received empty content without tool_calls. Retrying request...")
                                    should_retry = True
                                    break
                                message["content"] = content
                                message = normalize_assistant_message_for_history(message)
                                result.append(content)
                    
                    # If we should retry, continue to the next iteration
                    if should_retry:
                        times += 1
                        # Switch to a random API key for the retry
                        current_api_key = random.choice(api_keys)
                        headers["Authorization"] = "Bearer " + str(current_api_key)
                        if verbose:
                            print(f"Switched to random API key for error retry")

                        # Simple backoff with some randomness
                        sleep_time = initial_retry_delay + random.random()
                        if verbose:
                            print(f"Retrying in {sleep_time:.2f} seconds...")
                        time.sleep(sleep_time)
                        continue
                    
                    # Return the content based on type
                    if is_tool:
                        return {
                            'type': 'tool',
                            'data': result,
                            'call_messages': normalize_assistant_message_for_history(res['choices'][0]['message']),
                            'raw_response': res,
                            'stop_reason': res['choices'][0].get('finish_reason'),
                            'trimmed_messages': trimmed_messages,  # Return trimmed messages if any
                            'trim_info': trim_info  # Return trim information if any
                        }
                    else:
                        return {
                            'type': 'normal',
                            'data': result,
                            'call_messages': normalize_assistant_message_for_history(res['choices'][0]['message']),
                            'raw_response': res,
                            'stop_reason': res['choices'][0].get('finish_reason'),
                            'trimmed_messages': trimmed_messages,  # Return trimmed messages if any
                            'trim_info': trim_info  # Return trim information if any
                        }
                    
                except (KeyError, json.JSONDecodeError) as e:
                    if verbose:
                        print(f"Error parsing API response: {e}")
                        print(f"Response text: {response.text}")

            # Handle rate limiting
            if response.status_code == 429:
                import re
                # Extract retry time if available
                pattern_milliseconds = re.compile(r'(?<=Please retry after )\d+(?= milliseconds)')
                milliseconds = pattern_milliseconds.findall(str(response.text))
                if milliseconds:
                    wait_time = int(milliseconds[0])/1000
                else:
                    wait_time = initial_retry_delay + random.random()

                if verbose:
                    print(f"Rate limited. Retrying after {wait_time} seconds.")
                time.sleep(wait_time)
                times += 1

                # Select a different random API key for the next attempt
                current_api_key = random.choice(api_keys)
                headers["Authorization"] = "Bearer " + str(current_api_key)
                if verbose:
                    print(f"Switching to a random API key")
                continue

            # Handle authentication errors - use a different random API key
            if response.status_code == 401:
                if verbose:
                    print("Authentication error. Trying a different API key.")
                # Remove the failed key from the list if we have multiple keys
                if len(api_keys) > 1:
                    api_keys = [key for key in api_keys if key != current_api_key]

                # Select a new random key
                current_api_key = random.choice(api_keys)
                headers["Authorization"] = "Bearer " + str(current_api_key)
                if verbose:
                    print(f"Switched to random API key")
                times += 1
                continue

            # Handle 400 errors
            if response.status_code == 400:
                # Print the actual error response
                if verbose:
                    print(f"API request failed with status 400: {response.text}")

                # Try to parse error message to determine if it's a parameter error
                try:
                    error_data = response.json()
                    error_msg = error_data.get("error", {}).get("message", "")
                    error_code = error_data.get("error", {}).get("code", "")

                    # Check if it's a parameter format error (non-retriable)
                    if "InvalidParameter" in error_msg or "invalid_parameter_error" in error_code:
                        if verbose:
                            print(f"Parameter format error detected. This is non-retriable.")
                        return {
                            "type": "error", 
                            "data": [f"Error: Invalid parameter format. Response: {response.text}"],
                            "call_messages": {"role": "assistant", "content": f"Error: Invalid parameter format. Response: {response.text}"}
                        }
                except:
                    pass
                
                # For other 400 errors (e.g., high risk content), reduce max retries
                #reduced_max_retries = max(1, max_retries // 10)

                reduced_max_retries = max_retries
                if times >= reduced_max_retries:
                    if verbose:
                        print(f"Reached reduced retry limit ({reduced_max_retries}) for 400 error. Giving up.")
                    return {
                        "type": "error",
                        "data": [f"Error: Request failed with 400 status. Response: {response.text}"],
                        "call_messages": {"role": "assistant", "content": f"Error: Request failed with 400 status. Response: {response.text}"}
                    }
                if verbose:
                    print(f"400 error detected. Using reduced retry limit: {reduced_max_retries}")
            # For other errors
            else:
                if verbose:
                    print(f"API request failed with status {response.status_code}: {response.text}")
                    print(f"Response: {response}")

            # Switch to a random API key after several failures
            if times % 3 == 2:  # Every 3rd attempt
                current_api_key = random.choice(api_keys)
                headers["Authorization"] = "Bearer " + str(current_api_key)
                if verbose:
                    print(f"Switched to random API key")

        except requests.exceptions.Timeout:
            if verbose:
                print(f"Request timed out. Retrying {times+1}/{max_retries}...")
            # Try a different random API key on timeout
            current_api_key = random.choice(api_keys)
            headers["Authorization"] = "Bearer " + str(current_api_key)
            if verbose:
                print(f"Switched to random API key after timeout")
        except requests.exceptions.ConnectionError:
            if verbose:
                print(f"Connection error. Retrying {times+1}/{max_retries}...")
            # Try a different random API key on connection error
            current_api_key = random.choice(api_keys)
            headers["Authorization"] = "Bearer " + str(current_api_key)
            if verbose:
                print(f"Switched to random API key after connection error")
        except Exception as e:
            if verbose:
                print(f"Request error: {e}")

        # Simple backoff with some randomness
        sleep_time = initial_retry_delay + random.random()
        if verbose:
            print(f"Retrying in {sleep_time:.2f} seconds...")
        time.sleep(sleep_time)
        times += 1
    
    return {
        "type": "error", 
        "data": ["Error: Failed to get response after multiple retries."],
        "call_messages": {"role": "assistant", "content": "Error: Failed to get response after multiple retries."}
    }


def perform_thinking_reset(messages: List[Dict], keep_thinking: int = 1) -> tuple:
    """
    Remove reasoning content from assistant messages to reduce token usage.

    This function clears reasoning/thinking content from assistant messages by:
    - Setting 'reasoning_content' or 'reasoning' to empty string ""
    - Removing 'reasoning_details' field entirely (if present)

    Args:
        messages: List of message dictionaries
        keep_thinking: Number of most recent assistant messages to keep reasoning_content for (default: 1)

    Returns:
        Tuple of (new_messages, reset_info)
    """
    # Find all assistant message indices
    assistant_indices = []

    for i, msg in enumerate(messages):
        if msg.get('role') == 'assistant':
            assistant_indices.append(i)

    if len(assistant_indices) == 0:
        return messages, None

    # Determine which assistant messages to clear reasoning_content from
    # Keep the last 'keep_thinking' assistant messages
    if keep_thinking > 0 and len(assistant_indices) > keep_thinking:
        # Clear all except the last 'keep_thinking' assistant messages
        indices_to_clear = assistant_indices[:-keep_thinking]
    elif keep_thinking == 0:
        # Clear all assistant messages
        indices_to_clear = assistant_indices
    else:
        # keep_thinking >= total assistants, don't clear any
        return messages, None

    if len(indices_to_clear) == 0:
        return messages, None

    # Create new messages list with cleared reasoning_content
    new_messages = []
    cleared_count = 0
    total_reasoning_content_length = 0

    for i, msg in enumerate(messages):
        if i in indices_to_clear:
            # Check if this assistant message has reasoning fields
            # Support both 'reasoning' and 'reasoning_content' field names
            has_reasoning_content = 'reasoning_content' in msg and msg['reasoning_content']
            has_reasoning = 'reasoning' in msg and msg['reasoning']
            has_reasoning_details = 'reasoning_details' in msg and msg['reasoning_details']

            if has_reasoning_content or has_reasoning or has_reasoning_details:
                # Track the length of removed content
                if has_reasoning_content:
                    total_reasoning_content_length += len(str(msg['reasoning_content']))
                if has_reasoning:
                    total_reasoning_content_length += len(str(msg['reasoning']))
                if has_reasoning_details:
                    total_reasoning_content_length += len(str(msg['reasoning_details']))

                # Create a copy of the message and clear reasoning fields
                new_msg = msg.copy()

                # Clear reasoning_content (set to empty string)
                if 'reasoning_content' in new_msg:
                    new_msg['reasoning_content'] = ""

                # Clear reasoning (set to empty string)
                if 'reasoning' in new_msg:
                    new_msg['reasoning'] = ""

                # Remove reasoning_details entirely
                if 'reasoning_details' in new_msg:
                    del new_msg['reasoning_details']

                new_messages.append(new_msg)
                cleared_count += 1
            else:
                # No reasoning content to clear
                new_messages.append(msg)
        else:
            new_messages.append(msg)

    # Create reset info
    reset_info = {
        'num_cleared': cleared_count,
        'total_assistants': len(assistant_indices),
        'cleared_indices': sorted(indices_to_clear),
        'keep_thinking': keep_thinking,
        'total_reasoning_content_length': total_reasoning_content_length
    }

    return new_messages, reset_info


def perform_context_reset(messages: List[Dict], reset_ratio: float, keep_last_tool_call: bool = True) -> tuple:
    """
    Remove reset_ratio of tool calls and corresponding tool results from messages.

    Args:
        messages: List of message dictionaries
        reset_ratio: Ratio of tool calls to remove (0.0 to 1.0)
        keep_last_tool_call: If True, always keep the most recent assistant tool_calls (default: True)

    Returns:
        Tuple of (new_messages, reset_info)
    """
    # Find all assistant messages with tool_calls and their corresponding tool results
    tool_call_pairs = []
    
    i = 0
    while i < len(messages):
        msg = messages[i]
        if msg.get('role') == 'assistant' and 'tool_calls' in msg and msg['tool_calls']:
            # This is an assistant message with tool calls
            tool_call_ids = [tc['id'] for tc in msg['tool_calls']]
            
            # Look for tool results after this message
            j = i + 1
            tool_results_indices = []
            while j < len(messages):
                if messages[j].get('role') == 'tool':
                    if messages[j].get('tool_call_id') in tool_call_ids:
                        tool_results_indices.append(j)
                j += 1
            
            tool_call_pairs.append({
                'assistant_idx': i,
                'tool_result_indices': tool_results_indices,
                'num_tool_calls': len(msg['tool_calls'])
            })
        i += 1
    
    # If keep_last_tool_call is True and we have tool call pairs,
    # exclude the last pair from removal consideration
    if keep_last_tool_call and len(tool_call_pairs) > 0:
        # Only consider the pairs except the last one for removal
        pairs_available_for_removal = tool_call_pairs[:-1]
        num_to_remove = int(len(pairs_available_for_removal) * reset_ratio)
    else:
        pairs_available_for_removal = tool_call_pairs
        num_to_remove = int(len(tool_call_pairs) * reset_ratio)
    
    if num_to_remove == 0:
        return messages, None
    
    # Remove from the earliest tool calls (FIFO), excluding the last one if keep_last_tool_call is True
    pairs_to_remove = pairs_available_for_removal[:num_to_remove]
    
    # Collect indices to remove and modify
    tool_indices_to_remove = set()
    assistant_indices_to_modify = set()
    
    # Collect tool_call_ids that will be removed (for filtering reasoning_details)
    tool_call_ids_to_remove = set()
    
    for pair in pairs_to_remove:
        assistant_indices_to_modify.add(pair['assistant_idx'])
        tool_indices_to_remove.update(pair['tool_result_indices'])
        # Collect the tool_call_ids from the assistant message
        assistant_msg = messages[pair['assistant_idx']]
        if 'tool_calls' in assistant_msg:
            for tc in assistant_msg['tool_calls']:
                tool_call_ids_to_remove.add(tc['id'])
    
    # Create new messages list
    new_messages = []
    reset_info = {
        'num_pairs_removed': num_to_remove,
        'total_pairs': len(tool_call_pairs),
        'removed_assistant_indices': sorted(list(assistant_indices_to_modify)),
        'removed_tool_indices': sorted(list(tool_indices_to_remove)),
        'reset_ratio': reset_ratio,
        'kept_last_tool_call': keep_last_tool_call and len(tool_call_pairs) > 0
    }
    
    for i, msg in enumerate(messages):
        # Skip tool result messages that should be removed
        if i in tool_indices_to_remove:
            continue
        
        # If this is an assistant message that should have tool_calls removed
        if i in assistant_indices_to_modify:
            # Remove tool_calls but keep the rest (like content)
            new_msg = {k: v for k, v in msg.items() if k != 'tool_calls'}
            # Also remove corresponding reasoning_details entries if present
            if 'reasoning_details' in new_msg and new_msg['reasoning_details']:
                new_msg['reasoning_details'] = [
                    rd for rd in new_msg['reasoning_details']
                    if rd.get('id') not in tool_call_ids_to_remove
                ]
                # If reasoning_details is now empty, remove it entirely
                if not new_msg['reasoning_details']:
                    del new_msg['reasoning_details']
            new_messages.append(new_msg)
        else:
            new_messages.append(msg)
    
    return new_messages, reset_info


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
    base_url: str,
    model: str,
    max_tool_uses: int,
    max_tokens: int,
    timeout: int,
    max_retries: int = 5,
    initial_retry_delay: float = 2.0,
    reset_size: Optional[int] = None,
    reset_ratio: float = 0.5,
    context_reset: bool = False,
    context_summary: bool = False,
    context_awareness: bool = False,
    max_context_size: Optional[int] = None,
    memory_warning_threshold: float = 0.8,
    thinking_reset: bool = False,
    keep_thinking: int = 1,
    reasoning_effort: Optional[str] = None,
    reasoning_max_tokens: Optional[int] = None,
    reasoning_enabled: bool = True,
    reasoning_exclude: bool = False,
    config_name: str = "",
    max_steps: Optional[int] = None,
):
    """Run a single task with configurable environment and tools.

    Args:
        task_id: Global unique identifier for this task instance
        config_id: Configuration group ID
        run_id: Run number within this configuration
        base_task_dir: Base directory for task data
        output_dir: Directory to save results
        env_class: Full path to environment class
        env_params: Parameters for environment initialization
        mcp_configs: MCP server configurations
        api_key: API key for the model
        base_url: Base URL for the API
        model: Model name to use
        max_tool_uses: Maximum number of tool uses
        max_tokens: Maximum tokens for generation
        timeout: Request timeout in seconds
        max_retries: Maximum API retry attempts
        initial_retry_delay: Initial delay for retry in seconds
        reset_size: Token threshold for context management (None to disable all management)
        reset_ratio: Ratio of tool calls to remove during reset (0.0 to 1.0)
        context_reset: If True, remove old tool calls when exceeding token limit
        context_summary: If True, generate summary when exceeding token limit
        context_awareness: If True, inform the model about token budget and usage at each step
        max_context_size: Maximum context size in tokens (if set, will trim messages to fit)
        memory_warning_threshold: Threshold ratio (0.0-1.0) for memory warning when memory_tool is enabled.
                                  Warning is issued when total_tokens >= reset_size * threshold and < reset_size.
        thinking_reset: If True, clear reasoning_content from assistant messages when exceeding token limit
        keep_thinking: Number of most recent assistant messages to keep reasoning_content for (default: 1)
        max_steps: Maximum model interaction steps before marking the run truncated.

        Note: context_reset and context_summary are mutually exclusive.
              If both are False, no context management is performed even if reset_size is set.

    Returns:
        Dictionary with task results
    """
    verbose = False
    task_label = f"{config_name}-State{run_id}" if config_name else f"Config{config_id}-Run{run_id}"
    if verbose:
        print(f"[Task {task_id} | {task_label}] Starting...")
        print(f"[Task {task_id} | {task_label}] Environment: {env_class}")
        print(f"[Task {task_id} | {task_label}] Params: {env_params}")

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
    
    episode = []
    full_messages_history = []  # Store complete message history including reset messages
    reset_events = []  # Store information about reset events
    summary_events = []  # Store information about summary events
    summary_skip_events = []  # Store suppressed summary attempts for audit
    trim_events = []  # Store information about trim/truncation events
    thinking_reset_events = []  # Store information about thinking reset events
    usage_tracking = []  # Store per-step API usage
    initial_user_message = None  # Store the initial user message for summary mode
    memory_warning_issued = False  # Track if memory warning has been issued
    tool = None  # Initialize tool to None for cleanup in finally block
    messages = []
    reward = 0.0
    terminated = False
    truncated = False
    stop_reason = None
    info = {}

    if max_steps is None:
        max_steps = max(1, int(max_tool_uses or 0) + 1)
    elif int(max_steps) <= 0:
        max_steps = None
    else:
        max_steps = int(max_steps)

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

        # Always suppress preprocessing output in runner mode.
        with suppress_all_output():
            env = EnvClass(**prepared_env_params)
        if verbose:
            print(f"[Task {task_id} | {task_label}] Environment created successfully")

        # Setup MCP servers
        mcp_config = setup_mcp_servers(mcp_configs, task_workspace, agent_workspace)

        # Create tool - use ProgrammaticToolCallingTool if programmatic_tool_calling is enabled
        has_programmatic = any(
            config.get("type") in ["programmatic_tool_calling", "programmatic-tool-calling"]
            and config.get("enabled", True)
            for config in mcp_configs.values()
        )

        # Fix schemas for OpenAI-compatible providers, not just model names
        # containing "openai". Cerebras gpt-oss uses the same tool schema
        # strictness even though the model id is provider-specific.
        fix_schema = (
            "openai" in model.lower()
            or "gpt-oss" in model.lower()
            or "api.cerebras.ai" in base_url
        )

        if has_programmatic:
            tool = ProgrammaticToolCallingTool(mcp_config, validate_on_init=False, execution_timeout=120.0, fix_schema_for_openai=fix_schema)
        else:
            tool = MCPTool(mcp_config, validate_on_init=False, execution_timeout=120.0, fix_schema_for_openai=fix_schema)

        env = ToolEnvWrapperOpenAI(env, tools=[tool], max_tool_uses=max_tool_uses)

        # Always suppress preprocessing output in runner mode.
        with suppress_all_output():
            obs, info, user_prompt, tools = env.reset()

        # Save tools information for later storage
        tools_info = tools[0] if tools else None

        if verbose:
            print(f"[Task {task_id} | {task_label}] Environment initialized")
            print(f"[Task {task_id} | {task_label}] Initial observation length: {len(obs)}")

        # Check if memory_tool is included in mcp_configs
        has_memory_tool = any(
            config.get("type") in ["memory_tool", "memory-tool"] and config.get("enabled", True)
            for config in mcp_configs.values()
        )

        # Build the user prompt with optional enhancements
        enhanced_user_prompt = user_prompt

        # Add memory protocol if memory_tool is included
        if has_memory_tool:
            memory_protocol = (
                "\n\n"
                "IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE.\n"
                "MEMORY PROTOCOL:\n"
                "1. Use the `view` command of your `memory_tool` to check for earlier progress.\n"
                "2. ... (work on the task) ...\n"
                "     - As you make progress, record status / progress / thoughts etc in your memory.\n"
                "ASSUME INTERRUPTION: Your context window might be reset at any moment, so you risk losing any progress that is not recorded in your memory directory."
            )
            enhanced_user_prompt += memory_protocol
            if verbose:
                print(f"[Task {task_id} | {task_label}] Memory tool detected: Added MEMORY PROTOCOL to user prompt")

        # Add context awareness if enabled
        if context_awareness and max_context_size is not None:
            # Determine the context size to display based on whether context_reset or context_summary is enabled
            # When context_reset or context_summary is enabled with reset_size, use reset_size instead of max_context_size
            #display_context_size = reset_size if (reset_size is not None and (context_reset or context_summary)) else max_context_size
            display_context_size = max_context_size

            context_notice = (
                "\n\n"
                f"You need to complete the task within the following context window size:\n"
                f"<budget:token_budget>{display_context_size}</budget:token_budget>\n\n"
                f"Your context window will be automatically compacted as it approaches its limit, "
                f"allowing you to continue working indefinitely from where you left off. "
                f"Therefore, do not stop tasks early due to token budget concerns."
            )
            enhanced_user_prompt += context_notice
            if verbose:
                print(f"[Task {task_id} | {task_label}] Context awareness enabled: Added token budget ({display_context_size}) and context management notice to user prompt")

        messages = [{"role": "user", "content": enhanced_user_prompt}]
        initial_user_message = {"role": "user", "content": enhanced_user_prompt}  # Save for context_summary
        full_messages_history.append(initial_user_message.copy())  # Add initial user prompt to full history
        
        # Prepare output path - save trajectory in task workspace
        save_file = task_workspace / "trajectory.json"
        
        # Run interaction loop
        done = False
        step_count = 0
        
        while not done:
            step_count += 1
            if verbose:
                print(f"[Task {task_id} | {task_label}] Step {step_count}")
            
            # Add cache control for Claude models at specific steps
            if "claude" in model.lower() and step_count in [2, 4, 8, 16]: # claude is too cost, qwq
                if verbose:
                    print(f"[Task {task_id} | {task_label}] Adding cache control at step {step_count}")
                cache_message = {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "function called",
                            "cache_control": {"type": "ephemeral"}
                        }
                    ]
                }
                messages.append(cache_message)
            
            # Make API request
            response = make_aihubmix_api_request(
                messages=messages,
                model_name=model,
                aihubmix_api_keys=api_key,
                aihubmix_api_url=chat_completions_url(base_url),
                tools=tools[0] if tools else None,
                max_retries=max_retries,
                request_timeout=timeout,
                initial_retry_delay=initial_retry_delay,
                temperature=1.0,
                top_p=1.0,
                max_tokens=max_tokens,
                max_context_size=max_context_size,
                context_awareness=context_awareness,
                reasoning_effort=reasoning_effort,
                reasoning_max_tokens=reasoning_max_tokens,
                reasoning_enabled=reasoning_enabled,
                reasoning_exclude=reasoning_exclude,
            )
            stop_reason = extract_stop_reason(response) or stop_reason

            # Track API usage per step
            raw_resp = response.get('raw_response', {})
            if raw_resp and 'usage' in raw_resp:
                usage = raw_resp['usage']
                usage_tracking.append({
                    'step': step_count,
                    'prompt_tokens': usage.get('prompt_tokens', 0),
                    'completion_tokens': usage.get('completion_tokens', 0),
                    'total_tokens': usage.get('total_tokens', 0),
                    'prompt_cache_hit_tokens': usage.get('prompt_cache_hit_tokens', 0),
                    'prompt_cache_miss_tokens': usage.get('prompt_cache_miss_tokens', 0),
                })

            # Update messages if they were trimmed
            if 'trimmed_messages' in response and response['trimmed_messages'] is not None:
                original_count = len(messages)
                original_messages = messages  # Save original messages for comparison
                messages = response['trimmed_messages']
                if verbose:
                    print(f"[Task {task_id} | {task_label}] Messages updated after trimming: {original_count} -> {len(messages)}")

                # Check if memory warning was trimmed away
                if memory_warning_issued:
                    # Check if memory warning existed in original but not in trimmed
                    had_memory_warning = any(
                        msg.get('role') == 'user' and
                        isinstance(msg.get('content', ''), str) and
                        '**You are nearing the context window limit.**' in msg.get('content', '')
                        for msg in original_messages
                    )
                    has_memory_warning = any(
                        msg.get('role') == 'user' and
                        isinstance(msg.get('content', ''), str) and
                        '**You are nearing the context window limit.**' in msg.get('content', '')
                        for msg in messages
                    )
                    if had_memory_warning and not has_memory_warning:
                        memory_warning_issued = False
                        if verbose:
                            print(f"[Task {task_id} | {task_label}] Memory warning was trimmed away, resetting memory_warning_issued flag")

                # Record trim event if trim_info is available
                if 'trim_info' in response and response['trim_info'] is not None:
                    import copy
                    trim_event = {
                        'step': step_count,
                        'trim_info': copy.deepcopy(response['trim_info']),
                        'context': 'main_api_call'  # Distinguish from summary trim
                    }
                    trim_events.append(trim_event)
                    if verbose:
                        print(f"[Task {task_id} | {task_label}] Trim event recorded: removed {response['trim_info']['removed_count']} messages")

            if response.get('type') == 'error':
                error_text = "\n".join(str(item) for item in response.get('data', []))
                if not error_text:
                    error_text = "Error: provider returned an error response."
                token_metrics = compute_api_token_metrics(usage_tracking)
                call_messages = response.get('call_messages') or {
                    "role": "assistant",
                    "content": error_text,
                }
                call_messages = normalize_assistant_message_for_history(call_messages)
                messages.append(call_messages)
                full_messages_history.append(call_messages.copy())
                episode.append({
                    "observation": obs,
                    "action": response,
                    "reward": 0.0,
                    "info": {"error": error_text},
                })

                episode_data = {
                    "error": error_text,
                    "episode": episode,
                    "messages": messages,
                    "events": {
                        "reset": reset_events or [],
                        "summary": summary_events or [],
                        "summary_skip": summary_skip_events or [],
                        "trim": trim_events or [],
                        "thinking_reset": thinking_reset_events or [],
                    },
                    "metrics": build_run_metrics(
                        accuracy=0.0,
                        total_steps=step_count,
                        completed=False,
                        terminated=False,
                        truncated=False,
                        stop_reason=stop_reason,
                        status="error",
                    ),
                }
                envelope = make_base_envelope(
                    backend="openai",
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
                    reset=reset_events or [],
                    summary=summary_events or [],
                    summary_skip=summary_skip_events or [],
                    trim=trim_events or [],
                    thinking_reset=thinking_reset_events or [],
                )
                attach_metrics(
                    envelope,
                    **episode_data["metrics"],
                )
                attach_provider_payload(
                    envelope,
                    model=model,
                    usage_tracking=usage_tracking,
                    error=error_text,
                    response=response,
                )
                write_trajectory_file(
                    save_file,
                    envelope=envelope,
                    legacy_payload=episode_data,
                    indent=2,
                )
                write_json_file(
                    save_file.parent / "token_stats.json",
                    {"usage_tracking": usage_tracking},
                    indent=2,
                )
                write_eval_file(
                    task_workspace=save_file.parent,
                    status="error",
                    accuracy=0.0,
                    steps=step_count,
                    feedback=error_text,
                )
                return {
                    "task_id": task_id,
                    "config_id": config_id,
                    "run_id": run_id,
                    "config_name": config_name,
                    "status": "error",
                    "error": error_text,
                    "steps": step_count,
                    "final_reward": 0.0,
                    "accuracy": 0.0,
                    "save_file": str(save_file),
                    "env_class": env_class,
                    "env_params": env_params,
                    "tool_calls": 0,
                    "terminated": False,
                    "truncated": False,
                    "stop_reason": stop_reason,
                    **token_metrics,
                    "trimmed_tokens": 0,
                    "reset_tokens": 0,
                    "thinking_reset_tokens": 0,
                    "summary_tokens": 0,
                }

            # Check if response has call_messages (defensive check)
            if 'call_messages' not in response:
                print(f"ERROR: Response missing 'call_messages' key. Response: {response}")
                # Create a default error message
                call_messages = {
                    "role": "assistant", 
                    "content": f"Error: Invalid response format - {response.get('type', 'unknown')}: {response.get('data', ['Unknown error'])}"
                }
            else:
                call_messages = response['call_messages']
            call_messages = normalize_assistant_message_for_history(call_messages)
            
            # Ensure all tool_calls have arguments field (fix for consistency)
            if 'tool_calls' in call_messages and call_messages['tool_calls']:
                for tool_call in call_messages['tool_calls']:
                    if 'function' in tool_call:
                        if 'arguments' not in tool_call['function']:
                            # If no arguments key, add empty dict
                            tool_call['function']['arguments'] = "{}"
                        elif tool_call['function']['arguments'] == "":
                            # If arguments is empty string, convert to empty dict JSON
                            tool_call['function']['arguments'] = "{}"
                        # elif isinstance(tool_call['function']['arguments'], str):
                        #     # If arguments is a JSON string, parse it
                        #     try:
                        #         tool_call['function']['arguments'] = json.loads(tool_call['function']['arguments'])
                        #     except json.JSONDecodeError:
                        #         # If parsing fails, use empty dict
                        #         tool_call['function']['arguments'] = "{}"

            # Add assistant's message to conversation
            messages.append(call_messages)
            
            # Save a copy of messages to full history before potential reset
            full_messages_history.append(call_messages.copy())

            if verbose:
                print("response", response)

            with suppress_all_output():
                next_obs, reward, terminated, truncated, info = env.step_openai(response, verbose=False)

            if verbose:
                print("next_obs", next_obs)
                print("reward", reward)
                print("terminated", terminated)
                print("truncated", truncated)
                print("info", info)

            # If the model produced tool calls, preserve the paired tool
            # results even when the run is about to stop for max_steps. Without
            # this, truncated trajectories contain an assistant tool_call with
            # no tool result, which makes them invalid for compaction replay.
            tool_results = None
            if call_messages.get("tool_calls"):
                try:
                    parsed_tool_results = json.loads(next_obs)
                    if isinstance(parsed_tool_results, list):
                        tool_results = parsed_tool_results
                        messages.extend(tool_results)
                        full_messages_history.extend(
                            [
                                dict(item) if isinstance(item, dict) else item
                                for item in tool_results
                            ]
                        )
                except (TypeError, json.JSONDecodeError):
                    tool_results = None
            
            # Update state
            done = terminated or truncated
            if not done and max_steps is not None and step_count >= max_steps:
                truncated = True
                done = True
                stop_reason = "max_steps"
                if info is None:
                    info = {}
                info["max_steps_exceeded"] = True
                info["max_steps"] = max_steps

            if not done:
                try:
                    if tool_results is None:
                        tool_results = json.loads(next_obs)
                        messages.extend(tool_results)
                        # Also add to full history
                        full_messages_history.extend(tool_results)

                    # Add token usage information if context_awareness is enabled
                    if context_awareness and max_context_size is not None:
                        # Calculate current token usage
                        try:
                            import tiktoken
                            # Get tokenizer
                            try:
                                tokenizer = tiktoken.encoding_for_model(model)
                            except:
                                tokenizer = tiktoken.get_encoding("cl100k_base")

                            # Calculate tokens for messages
                            messages_str = json.dumps(messages, ensure_ascii=False)
                            messages_tokens = len(tokenizer.encode(messages_str, disallowed_special=()))

                            # Calculate tokens for tools if provided
                            tools_tokens = 0
                            if tools:
                                tools_str = json.dumps(tools, ensure_ascii=False)
                                tools_tokens = len(tokenizer.encode(tools_str, disallowed_special=()))

                            current_tokens = messages_tokens + tools_tokens

                            # Determine the context size to display based on whether context_reset or context_summary is enabled
                            # When context_reset or context_summary is enabled with reset_size, use reset_size instead of max_context_size
                            #display_context_size = reset_size if (reset_size is not None and (context_reset or context_summary)) else max_context_size
                            display_context_size = max_context_size
                            remaining_tokens = display_context_size - current_tokens

                            # Add token usage warning message
                            token_usage_message = {
                                "role": "user",
                                "content": f"Current token usage:\n<system_warning>Token usage: {current_tokens}/{display_context_size}; {remaining_tokens} remaining</system_warning>"
                            }
                            messages.append(token_usage_message)
                            full_messages_history.append(token_usage_message)

                            if verbose:
                                print(f"[Task {task_id} | {task_label}] Context awareness: Token usage {current_tokens}/{display_context_size} ({remaining_tokens} remaining)")
                        except Exception as e:
                            print(f"[Task {task_id} | {task_label}] Warning: Failed to calculate tokens for context awareness: {e}", file=sys.stderr)

                except (json.JSONDecodeError, TypeError) as e:
                    print(f"[Task {task_id} | {task_label}] Warning: Failed to parse next_obs as JSON, skipping. Error: {e}", file=sys.stderr)
                    if verbose:
                        print(f"[Task {task_id} | {task_label}] next_obs content: {next_obs[:200]}...")
            obs = next_obs
            
            # Check if context RESET is needed (must be done AFTER tool results)
            if context_reset and reset_size is not None and 'raw_response' in response:
                # Calculate total_tokens using tiktoken (same method as in call_openai_with_tools)
                try:
                    import tiktoken
                    # Get tokenizer
                    try:
                        tokenizer = tiktoken.encoding_for_model(model)
                    except:
                        tokenizer = tiktoken.get_encoding("cl100k_base")

                    # Calculate tokens for messages
                    messages_str = json.dumps(messages, ensure_ascii=False)
                    messages_tokens = len(tokenizer.encode(messages_str, disallowed_special=()))

                    # Calculate tokens for tools if provided
                    tools_tokens = 0
                    if tools:
                        tools_str = json.dumps(tools, ensure_ascii=False)
                        tools_tokens = len(tokenizer.encode(tools_str, disallowed_special=()))

                    total_tokens = messages_tokens + tools_tokens
                except Exception as e:
                    print(f"[Task {task_id} | {task_label}] Warning: Failed to calculate tokens using tiktoken: {e}", file=sys.stderr)
                    # Fallback to usage from API response
                    usage = response.get('raw_response', {}).get('usage', {})
                    total_tokens = usage.get('total_tokens', 0)

                # Check if memory warning should be issued (when memory_tool is enabled)
                memory_warning_threshold_tokens = reset_size * memory_warning_threshold
                if has_memory_tool and not memory_warning_issued and total_tokens >= memory_warning_threshold_tokens and total_tokens < reset_size:
                    if verbose:
                        print(f"[Task {task_id} | {task_label}] Memory warning threshold reached ({total_tokens} >= {memory_warning_threshold_tokens:.0f}). Inserting memory warning message...")

                    # Calculate remaining tokens
                    remaining_tokens = reset_size - total_tokens if reset_size else max_context_size - total_tokens

                    # Insert memory warning message
                    memory_warning_message = {
                        "role": "user",
                        "content": (
                            "<system_warning>\n\n"
                            "**You are nearing the context window limit.**\n\n"
                            "Your context will be automatically compacted soon.\n\n"
                            "Please save any important information from tool results into memory files before it is removed from the context. "
                            f"Token usage: {total_tokens}/{reset_size if reset_size else max_context_size}; {remaining_tokens} remaining"
                            "</system_warning>"
                        )
                    }
                    messages.append(memory_warning_message)
                    memory_warning_issued = True  # Mark warning as issued to prevent duplicates
                    if verbose:
                        print(f"[Task {task_id} | {task_label}] Memory warning message inserted into conversation")

                if total_tokens > reset_size:
                    # Use context reset approach
                    if verbose:
                        print(f"[Task {task_id} | {task_label}] Token usage ({total_tokens}) exceeds reset_size ({reset_size}). Performing context reset...")
                    
                    # Perform context reset
                    messages_before_reset = messages.copy()
                    tokens_before_reset = total_tokens  # Record tokens before reset
                    new_messages, reset_info = perform_context_reset(messages, reset_ratio)
                    
                    if reset_info is not None:
                        messages = new_messages
                        
                        # Calculate tokens after reset
                        try:
                            messages_str_after = json.dumps(messages, ensure_ascii=False)
                            messages_tokens_after = len(tokenizer.encode(messages_str_after, disallowed_special=()))
                            tokens_after_reset = messages_tokens_after + tools_tokens
                        except Exception as e:
                            print(f"[Task {task_id} | {task_label}] Warning: Failed to calculate tokens after reset: {e}", file=sys.stderr)
                            tokens_after_reset = None

                        # Save the complete messages after reset for inspection
                        # Deep copy to preserve the exact state at this moment
                        import copy
                        messages_after_reset_sample = copy.deepcopy(messages)

                        # Record reset event
                        reset_event = {
                            'step': step_count,
                            'total_tokens': total_tokens,
                            'tokens_before_reset': tokens_before_reset,
                            'tokens_after_reset': tokens_after_reset,
                            'reset_size': reset_size,
                            'reset_info': reset_info,
                            'messages_before_count': len(messages_before_reset),
                            'messages_after_count': len(messages),
                            'messages_after_reset_sample': messages_after_reset_sample
                        }
                        reset_events.append(reset_event)

                        if verbose:
                            print(f"[Task {task_id} | {task_label}] Context reset completed:")
                            print(f"  - Removed {reset_info['num_pairs_removed']}/{reset_info['total_pairs']} tool call pairs")
                            if reset_info.get('kept_last_tool_call'):
                                print(f"  - Kept the most recent tool call pair")
                            print(f"  - Messages count: {len(messages_before_reset)} -> {len(messages)}")
                            print(f"  - Tokens: {tokens_before_reset} -> {tokens_after_reset}")

                        # Reset memory warning flag after context reset
                        memory_warning_issued = False

            # Check if thinking RESET is needed (must be done AFTER tool results and potentially after context_reset)
            if thinking_reset and reset_size is not None and 'raw_response' in response:
                # Calculate total_tokens using tiktoken (same method as in call_openai_with_tools)
                try:
                    import tiktoken
                    # Get tokenizer
                    try:
                        tokenizer = tiktoken.encoding_for_model(model)
                    except:
                        tokenizer = tiktoken.get_encoding("cl100k_base")

                    # Calculate tokens for messages
                    messages_str = json.dumps(messages, ensure_ascii=False)
                    messages_tokens = len(tokenizer.encode(messages_str, disallowed_special=()))

                    # Calculate tokens for tools if provided
                    tools_tokens = 0
                    if tools:
                        tools_str = json.dumps(tools, ensure_ascii=False)
                        tools_tokens = len(tokenizer.encode(tools_str, disallowed_special=()))

                    total_tokens = messages_tokens + tools_tokens
                except Exception as e:
                    print(f"[Task {task_id} | {task_label}] Warning: Failed to calculate tokens using tiktoken: {e}", file=sys.stderr)
                    # Fallback to usage from API response
                    usage = response.get('raw_response', {}).get('usage', {})
                    total_tokens = usage.get('total_tokens', 0)

                # Check if memory warning should be issued (when memory_tool is enabled) for thinking_reset
                thinking_memory_warning_threshold_tokens = reset_size * memory_warning_threshold
                if has_memory_tool and not memory_warning_issued and total_tokens >= thinking_memory_warning_threshold_tokens and total_tokens < reset_size:
                    if verbose:
                        print(f"[Task {task_id} | {task_label}] Thinking memory warning threshold reached ({total_tokens} >= {thinking_memory_warning_threshold_tokens:.0f}). Inserting memory warning message...")

                    # Calculate remaining tokens
                    remaining_tokens = reset_size - total_tokens

                    # Insert memory warning message
                    thinking_memory_warning_message = {
                        "role": "user",
                        "content": (
                            "<system_warning>\n\n"
                            "**You are nearing the context window limit.**\n\n"
                            "Your context will be automatically compacted soon.\n\n"
                            "Please save any important reasoning information from your thinking process into memory files before it is removed from the context. "
                            f"Token usage: {total_tokens}/{reset_size}; {remaining_tokens} remaining"
                            "</system_warning>"
                        )
                    }
                    messages.append(thinking_memory_warning_message)
                    memory_warning_issued = True  # Mark warning as issued to prevent duplicates
                    if verbose:
                        print(f"[Task {task_id} | {task_label}] Thinking memory warning message inserted into conversation")

                if total_tokens > reset_size:
                    # Use thinking reset approach
                    if verbose:
                        print(f"[Task {task_id} | {task_label}] Token usage ({total_tokens}) exceeds reset_size ({reset_size}). Performing thinking reset...")

                    # Perform thinking reset
                    messages_before_thinking_reset = messages.copy()
                    tokens_before_thinking_reset = total_tokens  # Record tokens before reset
                    new_messages, thinking_reset_info = perform_thinking_reset(messages, keep_thinking)

                    if thinking_reset_info is not None:
                        messages = new_messages

                        # Calculate tokens after thinking reset
                        try:
                            messages_str_after = json.dumps(messages, ensure_ascii=False)
                            messages_tokens_after = len(tokenizer.encode(messages_str_after, disallowed_special=()))
                            tokens_after_thinking_reset = messages_tokens_after + tools_tokens
                        except Exception as e:
                            print(f"[Task {task_id} | {task_label}] Warning: Failed to calculate tokens after thinking reset: {e}", file=sys.stderr)
                            tokens_after_thinking_reset = None

                        # Save the complete messages after thinking reset for inspection
                        # Deep copy to preserve the exact state at this moment
                        import copy
                        messages_after_thinking_reset_sample = copy.deepcopy(messages)

                        # Record thinking reset event
                        thinking_reset_event = {
                            'step': step_count,
                            'total_tokens': total_tokens,
                            'tokens_before_reset': tokens_before_thinking_reset,
                            'tokens_after_reset': tokens_after_thinking_reset,
                            'reset_size': reset_size,
                            'thinking_reset_info': thinking_reset_info,
                            'messages_before_count': len(messages_before_thinking_reset),
                            'messages_after_count': len(messages),
                            'messages_after_thinking_reset_sample': messages_after_thinking_reset_sample
                        }
                        thinking_reset_events.append(thinking_reset_event)

                        if verbose:
                            print(f"[Task {task_id} | {task_label}] Thinking reset completed:")
                            print(f"  - Cleared reasoning_content from {thinking_reset_info['num_cleared']}/{thinking_reset_info['total_assistants']} assistant messages")
                            print(f"  - Kept reasoning_content for last {keep_thinking} assistant message(s)")
                            print(f"  - Total reasoning_content length removed: {thinking_reset_info['total_reasoning_content_length']}")
                            print(f"  - Tokens: {tokens_before_thinking_reset} -> {tokens_after_thinking_reset}")

                        # Reset memory warning flag after thinking reset
                        memory_warning_issued = False

            # Check if context SUMMARY is needed (must be done AFTER tool results)
            if context_summary and reset_size is not None and 'raw_response' in response:
                # Calculate total_tokens using tiktoken (same method as in call_openai_with_tools)
                messages_tokens = 0
                tools_tokens = 0
                try:
                    import tiktoken
                    # Get tokenizer
                    try:
                        tokenizer = tiktoken.encoding_for_model(model)
                    except:
                        tokenizer = tiktoken.get_encoding("cl100k_base")

                    # Calculate tokens for messages
                    messages_str = json.dumps(messages, ensure_ascii=False)
                    messages_tokens = len(tokenizer.encode(messages_str, disallowed_special=()))

                    # Calculate tokens for tools if provided
                    tools_tokens = 0
                    if tools:
                        tools_str = json.dumps(tools, ensure_ascii=False)
                        tools_tokens = len(tokenizer.encode(tools_str, disallowed_special=()))

                    total_tokens = messages_tokens + tools_tokens
                except Exception as e:
                    print(f"[Task {task_id} | {task_label}] Warning: Failed to calculate tokens using tiktoken: {e}", file=sys.stderr)
                    # Fallback to usage from API response
                    usage = response.get('raw_response', {}).get('usage', {})
                    total_tokens = usage.get('total_tokens', 0)

                # Check if memory warning should be issued (when memory_tool is enabled)
                memory_warning_threshold_tokens = reset_size * memory_warning_threshold
                if has_memory_tool and not memory_warning_issued and total_tokens >= memory_warning_threshold_tokens and total_tokens < reset_size:
                    if verbose:
                        print(f"[Task {task_id} | {task_label}] Memory warning threshold reached ({total_tokens} >= {memory_warning_threshold_tokens:.0f}). Inserting memory warning message...")

                    # Calculate remaining tokens
                    remaining_tokens = reset_size - total_tokens if reset_size else max_context_size - total_tokens

                    # Insert memory warning message
                    memory_warning_message = {
                        "role": "user",
                        "content": (
                            "<system_warning>\n\n"
                            "**You are nearing the context window limit.**\n\n"
                            "Your context will be automatically compacted soon.\n\n"
                            "Please save any important information from tool results into memory files before it is removed from the context. "
                            f"Token usage: {total_tokens}/{reset_size if reset_size else max_context_size}; {remaining_tokens} remaining"
                            "</system_warning>"
                        )
                    }
                    messages.append(memory_warning_message)
                    memory_warning_issued = True  # Mark warning as issued to prevent duplicates
                    if verbose:
                        print(f"[Task {task_id} | {task_label}] Memory warning message inserted into conversation")

                should_summarize, summary_trigger_reason = should_generate_context_summary(
                    total_tokens=total_tokens,
                    reset_size=reset_size,
                    messages_count=len(messages),
                    step_count=step_count,
                    messages_tokens=messages_tokens,
                    tools_tokens=tools_tokens,
                    last_summary_event=summary_events[-1] if summary_events else None,
                    max_context_size=max_context_size,
                    max_tokens=max_tokens,
                )

                if total_tokens > reset_size and not should_summarize:
                    skip_event = {
                        "step": step_count,
                        "total_tokens": total_tokens,
                        "reset_size": reset_size,
                        "messages_count": len(messages),
                        "reason": summary_trigger_reason,
                        "last_summary_step": (
                            summary_events[-1].get("step") if summary_events else None
                        ),
                    }
                    summary_skip_events.append(skip_event)
                    if verbose:
                        print(
                            f"[Task {task_id} | {task_label}] Token usage ({total_tokens}) exceeds reset_size "
                            f"({reset_size}) but context summary is deferred: {summary_trigger_reason}"
                        )

                if should_summarize:
                    # Use context summary approach
                    if verbose:
                        print(
                            f"[Task {task_id} | {task_label}] Token usage ({total_tokens}) exceeds reset_size "
                            f"({reset_size}). Generating context summary ({summary_trigger_reason})..."
                        )

                    # Add summary request message
                    summary_request_message = {
                        "role": "user",
                        "content": (
                            "You are approaching the context window's length limit. To continue the task, produce a concise, factual summary of the "
                            "overflowing conversation trajectory. This summary will be transferred into a fresh context window together with the user's "
                            "original task description. The full conversation history will no longer be accessible.\n\n"
                            "Preserve the original task semantics exactly. Do not add new requirements, relax requirements, or infer that existing "
                            "example/template rows in workspace files must be preserved unless the original user explicitly required preservation or "
                            "source-of-truth data confirms those rows satisfy the final criteria. For file-editing tasks, distinguish clearly between "
                            "examples/placeholders, observed source-of-truth data, files already written, and remaining work.\n\n"
                            "For structured-output tasks such as CSV editing, preserve exact file names, headers, identifiers, dates, and every known "
                            "field value required by the final output. If final rows have already been determined, include the exact intended rows or "
                            "the exact source facts needed to reconstruct every column. Do not replace known values with 'unknown' or blanks.\n\n"
                            "For tool-driven research tasks, explicitly record coverage: which source files, APIs, course IDs, object IDs, pages, or "
                            "records have already been queried, and which required sources remain unqueried. Never infer that data is absent merely "
                            "because the source has not been queried yet; mark it as remaining work instead.\n\n"
                            "If any required output field has not been copied exactly from a source result, mark it uncertain and instruct the next "
                            "context to re-query the source before writing. Do not invent plausible defaults or simplified names for required fields.\n\n"
                            "Include only load-bearing information needed to continue: user goal, source facts already discovered, decisions made, "
                            "files modified and their intended final contents, unresolved uncertainty, and the next concrete action."
                        )
                    }
                    messages_before_summary_request = messages.copy()
                    messages.append(summary_request_message)
                    import copy
                    full_messages_history.append(copy.deepcopy(summary_request_message))

                    # Call API to get summary
                    if verbose:
                        print(f"[Task {task_id} | {task_label}] Requesting summary from model...")
                    summary_response = make_aihubmix_api_request(
                        messages=messages,
                        model_name=model,
                        aihubmix_api_keys=api_key,
                        aihubmix_api_url=chat_completions_url(base_url),
                        tools=None,  # Don't allow tool calls for summary
                        max_retries=max_retries,
                        request_timeout=timeout,
                        initial_retry_delay=initial_retry_delay,
                        temperature=0.0,
                        top_p=1.0,
                        max_tokens=min(max_tokens, 2048),
                        max_context_size=max_context_size,
                        context_awareness=context_awareness,
                        reasoning_effort=reasoning_effort,
                        reasoning_max_tokens=reasoning_max_tokens,
                        reasoning_enabled=reasoning_enabled,
                        reasoning_exclude=reasoning_exclude,
                    )
                    
                    # Update messages if they were trimmed (before generating summary)
                    if 'trimmed_messages' in summary_response and summary_response['trimmed_messages'] is not None:
                        messages_before_trim = len(messages)
                        messages = summary_response['trimmed_messages']
                        if verbose:
                            print(f"[Task {task_id} | {task_label}] Messages trimmed before summary: {messages_before_trim} -> {len(messages)}")

                        # Record trim event for summary call
                        if 'trim_info' in summary_response and summary_response['trim_info'] is not None:
                            import copy
                            trim_event = {
                                'step': step_count,
                                'trim_info': copy.deepcopy(summary_response['trim_info']),
                                'context': 'summary_api_call'  # Distinguish from main trim
                            }
                            trim_events.append(trim_event)
                            if verbose:
                                print(f"[Task {task_id} | {task_label}] Trim event recorded (summary): removed {summary_response['trim_info']['removed_count']} messages")
                    
                    summary_failed = summary_response.get("type") == "error"

                    # Get summary message
                    if 'call_messages' in summary_response and not summary_failed:
                        summary_message = summary_response['call_messages']
                        full_messages_history.append(copy.deepcopy(summary_message))
                        
                        # Extract summary content and create a new user message
                        summary_text = summary_message.get('content', '')
                        if isinstance(summary_text, str) and summary_text.strip() and not summary_text.lstrip().startswith("Error:"):
                            summary_content = "You previously worked on this task in an earlier context window. This is a new context window, and the text provided here is a summary of the portion you completed before.\n\n" + summary_message['content']
                            
                            # Create a new user message with the summary
                            summary_user_message = {
                                "role": "user",
                                "content": summary_content
                            }
                            full_messages_history.append(copy.deepcopy(summary_user_message))
                            summary_tail = select_summary_tail(messages_before_summary_request)
                            
                            # Reset messages to initial + summary plus a recent raw tail.
                            messages_before_summary = messages.copy()
                            messages = [initial_user_message, summary_user_message] + summary_tail
                        
                            # Record summary event
                            summary_event = {
                                'step': step_count,
                                'total_tokens': total_tokens,
                                'reset_size': reset_size,
                                'messages_before_count': len(messages_before_summary),
                                'messages_after_count': len(messages),
                                'summary_tail_count': len(summary_tail),
                                'summary_request': summary_request_message,
                                'summary_response_original': copy.deepcopy(summary_message),  # Original assistant response
                                'summary_user_message': copy.deepcopy(summary_user_message),  # Converted to user message
                                'summary_tail': copy.deepcopy(summary_tail),
                                'messages_before_summary': copy.deepcopy(messages_before_summary),
                                'trigger_reason': summary_trigger_reason,
                                'messages_tokens': messages_tokens,
                                'tools_tokens': tools_tokens,
                            }
                            summary_events.append(summary_event)

                            if verbose:
                                print(f"[Task {task_id} | {task_label}] Context summary completed:")
                                print(f"  - Messages count: {len(messages_before_summary)} -> {len(messages)}")
                                print(f"  - Summary converted to user message and context reset to initial + summary")

                            # Reset memory warning flag after context summary
                            memory_warning_issued = False
                        else:
                            print(f"[Task {task_id} | {task_label}] ERROR: Summary response has no content", file=sys.stderr)
                            messages = messages_before_summary_request
                            summary_skip_events.append(
                                {
                                    "step": step_count,
                                    "total_tokens": total_tokens,
                                    "reset_size": reset_size,
                                    "messages_count": len(messages),
                                    "reason": "summary_generation_empty",
                                }
                            )
                    else:
                        print(f"[Task {task_id} | {task_label}] ERROR: Failed to get summary response", file=sys.stderr)
                        messages = messages_before_summary_request
                        summary_skip_events.append(
                            {
                                "step": step_count,
                                "total_tokens": total_tokens,
                                "reset_size": reset_size,
                                "messages_count": len(messages),
                                "reason": "summary_generation_failed",
                                "error": "\n".join(str(item) for item in summary_response.get('data', [])),
                            }
                        )
            
            # Record episode data (without messages to save space)
            episode.append({
                "observation": obs,
                "action": response,
                "reward": reward,
                "info": info,
            })

            # Save current progress after each step (simplified format)
            episode_data = {
                "episode": episode,
                "messages": messages,
                "events": {
                    "reset": reset_events or [],
                    "summary": summary_events or [],
                    "summary_skip": summary_skip_events or [],
                    "trim": trim_events or [],
                    "thinking_reset": thinking_reset_events or [],
                },
                "metrics": build_run_metrics(
                    accuracy=reward,
                    total_steps=step_count,
                    completed=done,
                    terminated=terminated,
                    truncated=truncated,
                    stop_reason=stop_reason,
                    status=determine_final_status(
                        terminated=terminated,
                        truncated=truncated,
                        reward=reward,
                    ) if done else None,
                ),
            }

            envelope = make_base_envelope(
                backend="openai",
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
                reset=reset_events or [],
                summary=summary_events or [],
                summary_skip=summary_skip_events or [],
                trim=trim_events or [],
                thinking_reset=thinking_reset_events or [],
            )
            attach_metrics(
                envelope,
                **episode_data["metrics"],
            )
            attach_provider_payload(
                envelope,
                model=model,
                usage_tracking=usage_tracking,
            )
            write_trajectory_file(
                save_file,
                envelope=envelope,
                legacy_payload=episode_data,
                indent=2,
            )

            # Save stats.json with API usage tracking (progress)
            stats_data = {"usage_tracking": usage_tracking}
            stats_file = save_file.parent / "token_stats.json"
            write_json_file(stats_file, stats_data, indent=2)

            if verbose:
                print(f"[Task {task_id} | {task_label}] Progress saved to: {save_file}")

        final_status = determine_final_status(
            terminated=terminated,
            truncated=truncated,
            reward=reward,
        )

        # Update final episode data (simplified format)
        episode_data = {
            "episode": episode,
            "messages": messages,
            "events": {
                "reset": reset_events or [],
                "summary": summary_events or [],
                "summary_skip": summary_skip_events or [],
                "trim": trim_events or [],
                "thinking_reset": thinking_reset_events or [],
            },
            "metrics": build_run_metrics(
                accuracy=reward,
                total_steps=step_count,
                completed=done,
                terminated=terminated,
                truncated=truncated,
                stop_reason=stop_reason,
                status=final_status,
            ),
        }

        envelope = make_base_envelope(
            backend="openai",
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
            reset=reset_events or [],
            summary=summary_events or [],
            summary_skip=summary_skip_events or [],
            trim=trim_events or [],
            thinking_reset=thinking_reset_events or [],
        )
        attach_metrics(
            envelope,
            **episode_data["metrics"],
        )
        attach_provider_payload(
            envelope,
            model=model,
            usage_tracking=usage_tracking,
        )
        write_trajectory_file(
            save_file,
            envelope=envelope,
            legacy_payload=episode_data,
            indent=2,
        )

        # Save token_stats.json with API usage tracking
        stats_data = {"usage_tracking": usage_tracking}
        stats_file = save_file.parent / "token_stats.json"
        write_json_file(stats_file, stats_data, indent=2)

        # Save eval.json alongside trajectory.json
        feedback = info.get("env_observation", "") if info else ""
        write_eval_file(
            task_workspace=save_file.parent,
            status=final_status,
            accuracy=reward,
            steps=step_count,
            feedback=feedback,
        )

        if verbose:
            print(f"[Task {task_id} | {task_label}] Completed successfully!")
            print(f"[Task {task_id} | {task_label}] Episode saved to: {save_file}")
            print(f"[Task {task_id} | {task_label}] Total steps: {step_count}")
            print(f"[Task {task_id} | {task_label}] Final reward (accuracy): {reward}")
            if reset_events:
                print(f"[Task {task_id} | {task_label}] Total context resets: {len(reset_events)}")
            if summary_events:
                print(f"[Task {task_id} | {task_label}] Total context summaries: {len(summary_events)}")
            if trim_events:
                total_trimmed = sum(event['trim_info']['removed_count'] for event in trim_events)
                print(f"[Task {task_id} | {task_label}] Total trim events: {len(trim_events)} (removed {total_trimmed} messages total)")
            if thinking_reset_events:
                total_cleared = sum(event['thinking_reset_info']['num_cleared'] for event in thinking_reset_events)
                total_length = sum(event['thinking_reset_info']['total_reasoning_content_length'] for event in thinking_reset_events)
                print(f"[Task {task_id} | {task_label}] Total thinking resets: {len(thinking_reset_events)} (cleared {total_cleared} assistant messages, {total_length} characters total)")

        token_metrics = compute_api_token_metrics(usage_tracking)

        # Tokens removed by trim events
        trimmed_tokens = sum(
            e.get('trim_info', {}).get('original_total_tokens', 0) - e.get('trim_info', {}).get('trimmed_total_tokens', 0)
            for e in (trim_events or [])
        )
        # Tokens removed by context reset events
        reset_tokens = sum(
            e.get('tokens_before_reset', 0) - e.get('tokens_after_reset', 0)
            for e in (reset_events or [])
            if e.get('tokens_before_reset', 0) and e.get('tokens_after_reset', 0)
        )
        # Tokens removed by thinking reset events
        thinking_reset_tokens = sum(
            e.get('tokens_before_reset', 0) - e.get('tokens_after_reset', 0)
            for e in (thinking_reset_events or [])
            if e.get('tokens_before_reset', 0) and e.get('tokens_after_reset', 0)
        )
        # Tokens removed by summary events (estimate based on message ratio)
        summary_tokens = sum(
            e.get('total_tokens', 0) - int(e.get('total_tokens', 0) * (e.get('messages_after_count', 1) / max(e.get('messages_before_count', 1), 1)))
            for e in (summary_events or [])
            if e.get('total_tokens', 0)
        )

        return {
            "task_id": task_id,
            "config_id": config_id,
            "run_id": run_id,
            "config_name": config_name,
            "status": final_status,
            "steps": step_count,
            "final_reward": reward,
            "accuracy": reward,  # Final reward as accuracy
            "save_file": str(save_file),
            "env_class": env_class,
            "env_params": env_params,
            "tool_calls": info.get("tool_use_counter", 0) if info else 0,
            "terminated": terminated,
            "truncated": truncated,
            "stop_reason": stop_reason,
            **token_metrics,
            "trimmed_tokens": trimmed_tokens,
            "reset_tokens": reset_tokens,
            "thinking_reset_tokens": thinking_reset_tokens,
            "summary_tokens": summary_tokens,
        }
        
    except Exception as e:
        # Always print errors to stderr
        print(f"[Task {task_id} | {task_label}] Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        token_metrics = compute_api_token_metrics(usage_tracking)

        error_save_file = task_workspace / "trajectory.json"
        error_save_file.parent.mkdir(parents=True, exist_ok=True)

        episode_data = {
            "error": str(e),
            "episode": episode,
            "messages": messages,
            "events": {
                "reset": reset_events or [],
                "summary": summary_events or [],
                "summary_skip": summary_skip_events or [],
                "trim": trim_events or [],
                "thinking_reset": thinking_reset_events or [],
            },
            "metrics": build_run_metrics(
                accuracy=0.0,
                total_steps=len(episode),
                completed=False,
                terminated=terminated,
                truncated=truncated,
                stop_reason=stop_reason,
                status="error",
            ),
        }

        envelope = make_base_envelope(
            backend="openai",
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
            reset=reset_events or [],
            summary=summary_events or [],
            summary_skip=summary_skip_events or [],
            trim=trim_events or [],
            thinking_reset=thinking_reset_events or [],
        )
        attach_metrics(
            envelope,
            **episode_data["metrics"],
        )
        attach_provider_payload(
            envelope,
            model=model,
            usage_tracking=usage_tracking,
            error=str(e),
        )
        write_trajectory_file(
            error_save_file,
            envelope=envelope,
            legacy_payload=episode_data,
            indent=2,
        )
        write_json_file(
            error_save_file.parent / "token_stats.json",
            {"usage_tracking": usage_tracking},
            indent=2,
        )

        write_eval_file(
            task_workspace=error_save_file.parent,
            status="error",
            accuracy=0.0,
            steps=len(episode),
            feedback=str(e),
        )

        if verbose:
            print(f"[Task {task_id} | {task_label}] Partial episode saved to: {error_save_file}")

        return {
            "task_id": task_id,
            "config_id": config_id,
            "run_id": run_id,
            "config_name": config_name,
            "status": "error",
            "error": str(e),
            "steps": len(episode),
            "final_reward": 0.0,
            "accuracy": 0.0,
            "save_file": str(error_save_file),
            "env_class": env_class,
            "env_params": env_params,
            "terminated": terminated,
            "truncated": truncated,
            "stop_reason": stop_reason,
            **token_metrics,
        }

    finally:
        # Always clean up the tool to prevent ghost MCP server processes
        if tool is not None:
            try:
                tool.close()
                if verbose:
                    print(f"[Task {task_id} | {task_label}] Tool closed successfully")
            except Exception as cleanup_error:
                print(f"[Task {task_id} | {task_label}] Warning: Error closing tool: {cleanup_error}", file=sys.stderr)


def normalize_config_for_grouping(config: Dict[str, Any]) -> tuple:
    """Create a normalized representation of a config for grouping purposes.
    
    Configs are considered the same if they differ only in the 'seed' parameter.
    
    Args:
        config: Configuration dictionary
    
    Returns:
        Tuple representing the normalized config (hashable)
    """
    # Create a copy of env_params without seed
    env_params = config.get("env_params", {}).copy()
    seed = env_params.pop("seed", None)
    
    # Create a normalized representation
    normalized = {
        "env_class": config.get("env_class"),
        "env_params": tuple(sorted(env_params.items())),
        "mcp_servers": json.dumps(config.get("mcp_servers", {}), sort_keys=True)
    }
    
    return (normalized["env_class"], normalized["env_params"], normalized["mcp_servers"])


def group_configs_by_similarity(configs: List[Dict[str, Any]]) -> Dict[int, List[int]]:
    """Group configurations that differ only by seed.
    
    Args:
        configs: List of configuration dictionaries
    
    Returns:
        Dictionary mapping group_id to list of original config indices
    """
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


def check_episode_needs_resume(episode_file: Path) -> bool:
    """Check if an episode file indicates a failed run that needs to be resumed.
    
    An episode needs resume if:
    1. The file exists and can be parsed
    2. The last message in final_messages is an error message
    
    Args:
        episode_file: Path to the episode JSON file
        
    Returns:
        True if the episode needs to be resumed, False otherwise
    """
    try:
        with open(episode_file, 'r') as f:
            episode_data = json.load(f)
        
        final_messages = episode_data.get('final_messages', [])
        if not final_messages:
            return True  # No messages means incomplete
        
        last_message = final_messages[-1]
        content = last_message.get('content', '')
        
        # Check for error patterns
        error_patterns = [
            "Error: Failed to get response after multiple retries.",
            "Error: Invalid parameter format.",
            "Error: Request failed with 400 status.",
            "ERROR: Context trimming removed all",
            "ERROR: Cannot fit messages within available context",
        ]
        
        for pattern in error_patterns:
            if pattern in content:
                return True
        
        # Also check if completed flag is False or missing
        if not episode_data.get('completed', False):
            return True
            
        return False
        
    except (json.JSONDecodeError, FileNotFoundError, KeyError) as e:
        print(f"Warning: Could not parse episode file {episode_file}: {e}")
        return True  # If we can't read it, assume it needs resume


def scan_resume_directory(resume_dir: str, delete_failed: bool = True) -> Dict[int, List[int]]:
    """Scan a resume directory to find which configs/runs need to be re-run.

    Supports both old-style (config_N/run_N) and new-style (TaskName/stateN) layouts.
    For new-style, reads task_mapping.json to map task names back to group IDs.

    Args:
        resume_dir: Path to the existing output directory
        delete_failed: If True, delete the failed episode files that will be resumed

    Returns:
        Dictionary mapping config_id to list of run_ids that need to be resumed
    """
    resume_path = Path(resume_dir)
    if not resume_path.exists():
        print(f"Resume directory does not exist: {resume_dir}")
        return {}

    # Task files are stored under tasks/ subdirectory
    tasks_path = resume_path / "tasks"
    if not tasks_path.exists():
        # Fall back to scanning resume_path directly for backward compatibility
        tasks_path = resume_path

    configs_to_resume = {}
    files_to_delete = []  # Track files to delete

    # Try to load task_mapping.json for new-style directories
    task_mapping = {}
    task_mapping_file = tasks_path / "task_mapping.json"
    if task_mapping_file.exists():
        try:
            with open(task_mapping_file, 'r') as f:
                task_mapping = json.load(f)
        except (json.JSONDecodeError, IOError):
            pass

    # Scan for task/config directories
    for config_dir in tasks_path.iterdir():
        if not config_dir.is_dir():
            continue

        # Determine config_id based on directory naming style
        if config_dir.name.startswith('config_'):
            # Old-style: config_N
            try:
                config_id = int(config_dir.name.split('_')[1])
            except (IndexError, ValueError):
                continue
        elif config_dir.name in task_mapping:
            # New-style: TaskName mapped via task_mapping.json
            config_id = task_mapping[config_dir.name]
        else:
            continue

        # Check for new-style state directories (stateN/trajectory.json)
        state_dirs = [d for d in config_dir.iterdir() if d.is_dir() and d.name.startswith('state')]
        if state_dirs:
            for state_dir in state_dirs:
                try:
                    run_id = int(state_dir.name.replace('state', ''))
                except ValueError:
                    continue
                traj_file = state_dir / "trajectory.json"
                eval_file = state_dir / "eval.json"
                if traj_file.exists():
                    # Check eval.json for status
                    needs_resume = True
                    if eval_file.exists():
                        try:
                            with open(eval_file, 'r') as f:
                                eval_data = json.load(f)
                            if eval_data.get("status") == "success":
                                needs_resume = False
                        except (json.JSONDecodeError, IOError):
                            pass
                    if not needs_resume:
                        # Also verify trajectory completeness
                        try:
                            with open(traj_file, 'r') as f:
                                traj_data = json.load(f)
                            if traj_data.get("metrics", {}).get("completed", False):
                                needs_resume = False
                        except (json.JSONDecodeError, IOError):
                            needs_resume = True

                    if needs_resume:
                        if config_id not in configs_to_resume:
                            configs_to_resume[config_id] = []
                        configs_to_resume[config_id].append(run_id)
                        files_to_delete.append(traj_file)
                        if eval_file.exists():
                            files_to_delete.append(eval_file)
                        print(f"  {config_dir.name} state{run_id}: needs resume")
                    else:
                        print(f"  {config_dir.name} state{run_id}: completed successfully")
                else:
                    # No trajectory file means this run was never started
                    if config_id not in configs_to_resume:
                        configs_to_resume[config_id] = []
                    configs_to_resume[config_id].append(run_id)
                    print(f"  {config_dir.name} state{run_id}: no trajectory found, will re-run")
            continue

        # Old-style: check for episode files in config_N directories
        episode_files = list(config_dir.glob('config*_run*-episode-*.json'))

        if not episode_files:
            # No episode files means this config was never started
            print(f"  Config {config_id}: no episode files found, will run all runs")
            if config_id not in configs_to_resume:
                configs_to_resume[config_id] = [-1]  # -1 indicates all runs need to be done
            continue

        # Group episode files by run_id
        runs_found = {}
        for episode_file in episode_files:
            filename = episode_file.name
            try:
                run_part = filename.split('_run')[1].split('-')[0]
                run_id = int(run_part)
                if run_id not in runs_found or episode_file.stat().st_mtime > runs_found[run_id].stat().st_mtime:
                    runs_found[run_id] = episode_file
            except (IndexError, ValueError):
                continue

        # Check each run's latest episode file
        for run_id, episode_file in runs_found.items():
            if check_episode_needs_resume(episode_file):
                if config_id not in configs_to_resume:
                    configs_to_resume[config_id] = []
                configs_to_resume[config_id].append(run_id)
                files_to_delete.append(episode_file)
                print(f"  Config {config_id} Run {run_id}: needs resume (file: {episode_file.name})")
            else:
                print(f"  Config {config_id} Run {run_id}: completed successfully")

    # Delete failed episode files if requested
    if delete_failed and files_to_delete:
        print(f"\nDeleting {len(files_to_delete)} failed episode files...")
        for file_path in files_to_delete:
            try:
                file_path.unlink()
                print(f"  Deleted: {file_path.name}")
            except Exception as e:
                print(f"  Warning: Failed to delete {file_path.name}: {e}")

    return configs_to_resume


def run_config_combinations(
    config_file: str,
    runs_per_config: int = 1,
    base_task_dir: str = "",
    output_dir: str = "",
    api_key: str = "",
    base_url: str="",
    model: str = "gpt-5-nano",
    max_tool_uses: int = 500,
    max_tokens: int = 32768,
    timeout: int = 600,
    max_workers: Optional[int] = None,
    max_retries: int = 50,
    initial_retry_delay: float = 2.0,
    reset_size: Optional[int] = None,
    reset_ratio: float = 0.5,
    context_reset: bool = False,
    context_summary: bool = False,
    context_awareness: bool = False,
    group_by_seed: bool = True,
    max_context_size: Optional[int] = None,
    memory_warning_threshold: float = 0.8,
    thinking_reset: bool = False,
    keep_thinking: int = 1,
    reasoning_effort: Optional[str] = None,
    reasoning_max_tokens: Optional[int] = None,
    reasoning_enabled: bool = True,
    reasoning_exclude: bool = False,
    resume_dir: Optional[str] = None,
    max_steps: Optional[int] = None,
):
    """Run multiple configurations in parallel with flexible environment and tool setup.

    Args:
        config_file: Path to JSON configuration file
        runs_per_config: Number of runs per configuration
        base_task_dir: Base directory for task workspaces
        output_dir: Directory to save episode results
        api_key: API key (if None, will use from env)
        base_url: API base URL
        model: Model name
        max_tool_uses: Maximum tool uses per episode
        max_tokens: Maximum tokens per generation
        timeout: API request timeout
        max_workers: Maximum parallel workers
        max_retries: Maximum API retry attempts
        initial_retry_delay: Initial delay between retries in seconds
        reset_size: Token threshold for context management (None to disable all)
        reset_ratio: Ratio of tool calls to remove during reset (0.0 to 1.0)
        context_reset: If True, remove old tool calls when exceeding token limit
        context_summary: If True, generate summary when exceeding token limit
        context_awareness: If True, inform the model about token budget and usage at each step
        group_by_seed: If True, group configs that differ only by seed as same config
        max_context_size: Maximum context size in tokens (if set, will trim messages to fit)
        memory_warning_threshold: Threshold ratio (0.0-1.0) for memory warning when memory_tool is enabled
        thinking_reset: If True, clear reasoning_content from assistant messages when exceeding token limit
        keep_thinking: Number of most recent assistant messages to keep reasoning_content for (default: 1)
        reasoning_effort: The reasoning effort level for OpenAI models that support reasoning.
                         Supported values: "none", "minimal", "low", "medium", "high", "xhigh".
                         If set, takes precedence over reasoning_max_tokens.
        reasoning_max_tokens: Specific token limit for reasoning (Anthropic-style). Used if reasoning_effort is not set.
        reasoning_enabled: Whether to enable reasoning (default: True). Automatically inferred from effort or max_tokens.
        reasoning_exclude: Set to True to exclude reasoning tokens from response (default: False).
        resume_dir: Path to existing output directory to resume from. If provided, only failed runs will be re-executed.
        max_steps: Maximum model interaction steps per run. Defaults to max_tool_uses + 1.

        Note: context_reset and context_summary are mutually exclusive.
              If both are False, no context management is performed.
    """
    verbose = False
    # Runner mode is always quiet.
    os.environ["LOCA_QUIET"] = "1"
    logging.getLogger().setLevel(logging.WARNING)

    # Check for resume mode
    configs_to_resume = None
    if resume_dir:
        if verbose:
            print(f"\n{'=' * 80}")
            print("RESUME MODE ENABLED")
            print(f"{'=' * 80}")
            print(f"Scanning resume directory: {resume_dir}")
        configs_to_resume = scan_resume_directory(resume_dir)

        if not configs_to_resume:
            if verbose:
                print("\nNo configs need to be resumed. All runs completed successfully!")
                print(f"{'=' * 80}\n")
            return

        if verbose:
            total_to_resume = 0
            for runs in configs_to_resume.values():
                if -1 in runs:
                    total_to_resume += 1  # Will be updated based on actual runs later
                else:
                    total_to_resume += len(runs)
            print(f"\nFound runs to resume across {len(configs_to_resume)} configs:")
            for config_id, run_ids in sorted(configs_to_resume.items()):
                if -1 in run_ids:
                    print(f"  Config {config_id}: all runs (no episode files found)")
                else:
                    print(f"  Config {config_id}: runs {run_ids}")
            print(f"{'=' * 80}\n")

        # Use the resume directory as output directory
        output_dir = resume_dir
        # Note: base_task_dir remains unchanged (new task workspace)
        # This means each resume run starts with a fresh task workspace
        if verbose:
            print(f"Resume mode: Results will be saved to: {output_dir}")
            print(f"Resume mode: Using new task workspace: {base_task_dir}")
    
    # Load configurations
    with open(config_file, "r") as f:
        config_data = json.load(f)

    configs = config_data.get("configurations", [])
    if verbose:
        print(f"Loaded {len(configs)} configurations from {config_file}")

    # Group configurations if group_by_seed is enabled
    if group_by_seed:
        config_groups = group_configs_by_similarity(configs)
        if verbose:
            print(f"\nGrouping enabled: Found {len(config_groups)} unique configuration groups")
            for group_id, config_indices in config_groups.items():
                if len(config_indices) > 1:
                    print(f"  Group {group_id}: {len(config_indices)} configs with different seeds (indices: {config_indices})")
    else:
        # No grouping - each config is its own group
        config_groups = {i: [i] for i in range(len(configs))}
        if verbose:
            print(f"Grouping disabled: Treating each config separately")
    
    # # Get API key from environment if not provided
    # if api_key is None:
    #     api_key = os.environ.get("OPENAI_API_KEY")
    #     if not api_key:
    #         raise ValueError("API key not provided and OPENAI_API_KEY not set in environment")
    
    # Create base directories
    Path(base_task_dir).mkdir(parents=True, exist_ok=True)
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    
    # Calculate total tasks based on grouping and resume mode
    if configs_to_resume is not None:
        # Resume mode: count only the tasks that need to be resumed
        # -1 in runs list means all runs need to be done
        total_tasks = 0
        for config_id, runs in configs_to_resume.items():
            if -1 in runs:
                # All runs need to be done for this config
                if group_by_seed and config_id in config_groups:
                    total_tasks += max(len(config_groups[config_id]), runs_per_config)
                else:
                    total_tasks += runs_per_config
            else:
                total_tasks += len(runs)
    elif group_by_seed:
        # For each group: max(configs in group, runs_per_config)
        total_tasks = sum(max(len(indices), runs_per_config) for indices in config_groups.values())
    else:
        total_tasks = len(configs) * runs_per_config
    
    # Set default max_workers
    if max_workers is None:
        max_workers = min(total_tasks, os.cpu_count() or 4) if total_tasks > 0 else 1
    
    if verbose:
        print("=" * 80)
        print("FLEXIBLE PARALLEL INFERENCE")
        print("=" * 80)
        print(f"Total configurations: {len(configs)}")
        print(f"Unique config groups: {len(config_groups)}")
        print(f"Runs per configuration: {runs_per_config}")
        print(f"Total tasks: {total_tasks}")
        print(f"Max workers: {max_workers}")
        print(f"Model: {model}")
        print(f"Base task directory: {base_task_dir}")
        print(f"Output directory: {output_dir}")
        if max_context_size is not None:
            print(f"Max context size: {max_context_size:,} tokens (messages will be trimmed if exceeded)")
        if context_awareness:
            print(f"Context awareness enabled:")
            print(f"  - Model will be informed about token budget: {max_context_size:,} tokens" if max_context_size else "  - Warning: max_context_size not set")
            print(f"  - Token usage will be reported after each tool call")
        if reset_size is not None:
            if context_summary:
                print(f"Context summary enabled:")
                print(f"  - Reset size: {reset_size} tokens")
                print(f"  - Will generate summary when exceeding token limit")
            elif context_reset:
                print(f"Context reset enabled:")
                print(f"  - Reset size: {reset_size} tokens")
                print(f"  - Reset ratio: {reset_ratio}")
            else:
                print(f"Context monitoring enabled (no management):")
                print(f"  - Reset size: {reset_size} tokens")
                print(f"  - Will only log when exceeding token limit")

        if group_by_seed:
            print("\nConfiguration Groups:")
            for group_id in sorted(config_groups.keys()):
                config_indices = config_groups[group_id]
                print(f"  Group {group_id}: {len(config_indices)} configs")
                for idx in config_indices:
                    config = configs[idx]
                    seed = config.get('env_params', {}).get('seed', 'N/A')
                    print(f"    - Config index {idx}: seed={seed}")
                # Show details for first config in group
                config = configs[config_indices[0]]
                print(f"    Environment: {config.get('env_class', 'N/A')}")
                print(f"    Params (excluding seed): {{{', '.join(f'{k}: {v}' for k, v in config.get('env_params', {}).items() if k != 'seed')}}}")
                print(f"    MCP Servers: {list(config.get('mcp_servers', {}).keys())}")
        else:
            print("\nConfigurations:")
            for i, config in enumerate(configs):
                print(f"  Config {i}:")
                print(f"    Environment: {config.get('env_class', 'N/A')}")
                print(f"    Params: {config.get('env_params', {})}")
                print(f"    MCP Servers: {list(config.get('mcp_servers', {}).keys())}")
        print("=" * 80)

        # Display reasoning configuration if any parameters are set
        reasoning_configured = reasoning_effort is not None or reasoning_max_tokens is not None
        if reasoning_configured:
            print("\nReasoning Configuration:")
            if reasoning_effort is not None:
                print(f"  - Reasoning effort: {reasoning_effort}")
            if reasoning_max_tokens is not None:
                print(f"  - Reasoning max tokens: {reasoning_max_tokens}")
            print(f"  - Reasoning enabled: {reasoning_enabled}")
            print(f"  - Reasoning exclude: {reasoning_exclude}")
        print("\n" + "=" * 80)

    # Prepare task arguments based on grouping
    task_args = []
    task_id = 0
    skipped_count = 0

    # Build group_id -> config_name mapping for results aggregation
    group_id_to_name = {}

    if group_by_seed:
        # Group configs together - each config in a group becomes a separate run
        for group_id, config_indices in sorted(config_groups.items()):
            run_id = 0

            # Use first config as template
            template_config = configs[config_indices[0]]

            # Derive config_name: use 'name' field, or extract class name from env_class
            config_name = template_config.get("name", "")
            if not config_name:
                env_cls = template_config.get("env_class", "")
                config_name = env_cls.rsplit(".", 1)[-1] if "." in env_cls else f"config_{group_id}"
            group_id_to_name[group_id] = config_name
            
            # Determine total runs for this group
            total_runs_for_group = max(len(config_indices), runs_per_config)
            
            for i in range(total_runs_for_group):
                # Check if we should skip this run (resume mode)
                if configs_to_resume is not None:
                    # -1 in the list means all runs need to be done
                    if group_id not in configs_to_resume:
                        # This config doesn't need to be resumed at all, skip
                        run_id += 1
                        skipped_count += 1
                        continue
                    elif -1 not in configs_to_resume[group_id] and run_id not in configs_to_resume[group_id]:
                        # This specific run doesn't need to be resumed, skip it
                        run_id += 1
                        skipped_count += 1
                        continue
                
                # Use the specific config if available, otherwise use template
                if i < len(config_indices):
                    config = configs[config_indices[i]]
                else:
                    # Use template config for additional runs
                    config = template_config
                
                # Check if config provides specific reasoning settings
                config_reasoning_effort = config.get('reasoning_effort', reasoning_effort)
                config_reasoning_max_tokens = config.get('reasoning_max_tokens', reasoning_max_tokens)
                config_reasoning_enabled = config.get('reasoning_enabled', reasoning_enabled)
                config_reasoning_exclude = config.get('reasoning_exclude', reasoning_exclude)
                config_max_steps = config.get('max_steps', max_steps)

                # Convert empty strings to None
                if config_reasoning_effort == "":
                    config_reasoning_effort = None
                if config_reasoning_max_tokens == "":
                    config_reasoning_max_tokens = None
                if config_max_steps == "":
                    config_max_steps = None

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
                    timeout,
                    max_retries,
                    initial_retry_delay,
                    reset_size,
                    reset_ratio,
                    context_reset,
                    context_summary,
                    context_awareness,
                    max_context_size,
                    memory_warning_threshold,
                    thinking_reset,
                    keep_thinking,
                    config_reasoning_effort,
                    config_reasoning_max_tokens,
                    config_reasoning_enabled,
                    config_reasoning_exclude,
                    config_name,
                    config_max_steps,
                ))
                task_id += 1
                run_id += 1
    else:
        # No grouping - original behavior
        for config_id, config in enumerate(configs):
            # Derive config_name for non-grouped mode
            cfg_name = config.get("name", "")
            if not cfg_name:
                env_cls = config.get("env_class", "")
                cfg_name = env_cls.rsplit(".", 1)[-1] if "." in env_cls else f"config_{config_id}"
            group_id_to_name[config_id] = cfg_name

            for run_id in range(runs_per_config):
                # Check if we should skip this run (resume mode)
                if configs_to_resume is not None:
                    # -1 in the list means all runs need to be done
                    if config_id not in configs_to_resume:
                        # This config doesn't need to be resumed at all, skip
                        skipped_count += 1
                        continue
                    elif -1 not in configs_to_resume[config_id] and run_id not in configs_to_resume[config_id]:
                        # This specific run doesn't need to be resumed, skip it
                        skipped_count += 1
                        continue

                # Check if config provides specific reasoning settings
                config_reasoning_effort = config.get('reasoning_effort', reasoning_effort)
                config_reasoning_max_tokens = config.get('reasoning_max_tokens', reasoning_max_tokens)
                config_reasoning_enabled = config.get('reasoning_enabled', reasoning_enabled)
                config_reasoning_exclude = config.get('reasoning_exclude', reasoning_exclude)
                config_max_steps = config.get('max_steps', max_steps)

                # Convert empty strings to None
                if config_reasoning_effort == "":
                    config_reasoning_effort = None
                if config_reasoning_max_tokens == "":
                    config_reasoning_max_tokens = None
                if config_max_steps == "":
                    config_max_steps = None

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
                    timeout,
                    max_retries,
                    initial_retry_delay,
                    reset_size,
                    reset_ratio,
                    context_reset,
                    context_summary,
                    context_awareness,
                    max_context_size,
                    memory_warning_threshold,
                    thinking_reset,
                    keep_thinking,
                    config_reasoning_effort,
                    config_reasoning_max_tokens,
                    config_reasoning_enabled,
                    config_reasoning_exclude,
                    cfg_name,
                    config_max_steps,
                ))
                task_id += 1

    # Save task_mapping.json for resume support
    task_mapping = {name: gid for gid, name in group_id_to_name.items()}
    task_mapping_file = Path(base_task_dir) / "task_mapping.json"
    task_mapping_file.parent.mkdir(parents=True, exist_ok=True)
    with open(task_mapping_file, "w") as f:
        json.dump(task_mapping, f, indent=2)

    # Print resume mode summary if applicable
    if configs_to_resume is not None and verbose:
        print(f"Resume mode: {skipped_count} runs skipped (already completed), {len(task_args)} runs to execute")

    # Check if there are any tasks to run
    if not task_args:
        if verbose:
            print("\nNo tasks to run. All runs completed successfully!")
        return

    # Run tasks in parallel
    start_time = time.time()
    results = []
    executor = None

    # Signal handler for graceful shutdown
    def signal_handler(signum, frame):
        import multiprocessing
        print("\n\nReceived interrupt signal. Shutting down...", file=sys.stderr)

        # First, shutdown the executor to prevent new tasks
        if executor is not None:
            executor.shutdown(wait=False, cancel_futures=True)

        # Kill all child processes (worker processes and their MCP server children)
        try:
            # Get all active child processes from multiprocessing
            children = multiprocessing.active_children()
            for child in children:
                try:
                    # Terminate the child process
                    child.terminate()
                except Exception:
                    pass

            # Also try to kill any remaining processes in the process group of each worker
            # This catches MCP server subprocesses that may have been spawned
            if executor is not None and hasattr(executor, '_processes'):
                for pid in list(executor._processes.keys()):
                    try:
                        # Kill the entire process group of each worker
                        os.killpg(os.getpgid(pid), signal.SIGTERM)
                    except (ProcessLookupError, PermissionError, OSError):
                        pass
                    try:
                        # Also send SIGKILL to ensure termination
                        os.kill(pid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError, OSError):
                        pass

            # Wait briefly for processes to terminate
            for child in children:
                try:
                    child.join(timeout=0.5)
                except Exception:
                    pass

        except Exception as e:
            print(f"Warning: Error during process cleanup: {e}", file=sys.stderr)

        sys.exit(130)  # 128 + SIGINT(2)

    # Set up signal handlers
    original_sigint = signal.signal(signal.SIGINT, signal_handler)
    original_sigterm = signal.signal(signal.SIGTERM, signal_handler)

    # Progress tracking for Rich display
    completed_count = 0
    success_count = 0
    error_count = 0
    total_accuracy = 0.0
    accuracy_count = 0

    try:
        with ProcessPoolExecutor(max_workers=max_workers) as executor:
            # Submit all tasks
            futures = {
                executor.submit(run_single_task, *args): (args[0], args[1], args[2])
                for args in task_args
            }

            from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn, TimeElapsedColumn
            from rich.console import Console

            console = Console()

            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                BarColumn(),
                TaskProgressColumn(),
                TimeElapsedColumn(),
                console=console,
                transient=False,
            ) as progress:
                task_progress = progress.add_task(
                    f"[cyan]Running {len(task_args)} tasks ({max_workers} workers)",
                    total=len(task_args)
                )

                for future in as_completed(futures):
                    task_id, config_id, run_id = futures[future]
                    try:
                        result = future.result()
                        results.append(result)
                        completed_count += 1
                        if result['status'] == 'success':
                            success_count += 1
                            acc = result.get('accuracy', result.get('final_reward', 0))
                            if acc is not None:
                                total_accuracy += acc
                                accuracy_count += 1
                        else:
                            error_count += 1

                        # Print per-task completion line
                        task_name = result.get("config_name", f"config_{config_id}")
                        state = f"state{run_id}"
                        r_acc = result.get('accuracy', 0)
                        r_steps = result.get('steps', '?')
                        r_tokens = result.get('api_total_tokens', 0)
                        r_trimmed = result.get('trimmed_tokens', 0)
                        r_tokens_incl = r_tokens + r_trimmed
                        tok_str = f"{r_tokens:,} tok" if r_trimmed == 0 else f"{r_tokens:,} tok ({r_tokens_incl:,} incl. trimmed)"
                        if result['status'] == 'success' and r_acc > 0:
                            progress.console.print(f"  [green]\u2713[/green] {task_name} {state} \u2014 passed (acc: {r_acc}, {r_steps} steps, {tok_str})")
                        else:
                            progress.console.print(f"  [red]\u2717[/red] {task_name} {state} \u2014 failed (acc: {r_acc}, {r_steps} steps, {tok_str})")
                    except Exception as e:
                        results.append({
                            "task_id": task_id,
                            "config_id": config_id,
                            "run_id": run_id,
                            "status": "exception",
                            "error": str(e),
                        })
                        completed_count += 1
                        error_count += 1
                        progress.console.print(f"  [red]\u2717[/red] config_{config_id} state{run_id} \u2014 exception: {e}")

                    # Update progress bar description with stats
                    avg_acc = total_accuracy / accuracy_count if accuracy_count > 0 else 0
                    progress.update(
                        task_progress,
                        advance=1,
                        description=f"[cyan]Tasks: {completed_count}/{len(task_args)} | Success: {success_count} | Errors: {error_count} | Avg Acc: {avg_acc:.2%}"
                    )

    finally:
        # Restore original signal handlers
        signal.signal(signal.SIGINT, original_sigint)
        signal.signal(signal.SIGTERM, original_sigterm)
    
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
                "tool_calls": [],
                "api_total_tokens": [],
                "api_max_prompt_tokens": [],
                "api_max_total_tokens": [],
                "trimmed_tokens": [],
                "reset_tokens": [],
                "thinking_reset_tokens": [],
                "summary_tokens": [],
            }

        config_stats[config_id]["total"] += 1
        if result["status"] == "success":
            config_stats[config_id]["success"] += 1
            accuracy = result.get("accuracy", result["final_reward"])
            config_stats[config_id]["accuracies"].append(accuracy)
            config_stats[config_id]["steps"].append(result["steps"])
            config_stats[config_id]["tool_calls"].append(result.get("tool_calls", 0))
            config_stats[config_id]["api_total_tokens"].append(result.get("api_total_tokens", 0))
            config_stats[config_id]["api_max_prompt_tokens"].append(result.get("api_max_prompt_tokens", 0))
            config_stats[config_id]["api_max_total_tokens"].append(result.get("api_max_total_tokens", 0))
            config_stats[config_id]["trimmed_tokens"].append(result.get("trimmed_tokens", 0))
            config_stats[config_id]["reset_tokens"].append(result.get("reset_tokens", 0))
            config_stats[config_id]["thinking_reset_tokens"].append(result.get("thinking_reset_tokens", 0))
            config_stats[config_id]["summary_tokens"].append(result.get("summary_tokens", 0))
        else:
            config_stats[config_id]["error"] += 1
    
    total_success = sum(1 for r in results if r["status"] == "success")
    total_error = sum(1 for r in results if r["status"] != "success")

    # Calculate overall averages
    all_accuracies = []
    all_steps = []
    all_tool_calls = []
    all_api_total_tokens = []
    all_api_max_prompt_tokens = []
    all_api_max_total_tokens = []
    all_trimmed_tokens = []
    all_reset_tokens = []
    all_thinking_reset_tokens = []
    all_summary_tokens = []
    for stats in config_stats.values():
        all_accuracies.extend(stats['accuracies'])
        all_steps.extend(stats['steps'])
        all_tool_calls.extend(stats['tool_calls'])
        all_api_total_tokens.extend(stats['api_total_tokens'])
        all_api_max_prompt_tokens.extend(stats['api_max_prompt_tokens'])
        all_api_max_total_tokens.extend(stats['api_max_total_tokens'])
        all_trimmed_tokens.extend(stats['trimmed_tokens'])
        all_reset_tokens.extend(stats['reset_tokens'])
        all_thinking_reset_tokens.extend(stats['thinking_reset_tokens'])
        all_summary_tokens.extend(stats['summary_tokens'])
    avg_accuracy = sum(all_accuracies) / len(all_accuracies) if all_accuracies else None
    avg_steps = sum(all_steps) / len(all_steps) if all_steps else None
    avg_tool_calls = sum(all_tool_calls) / len(all_tool_calls) if all_tool_calls else None
    total_api_tokens_all = sum(all_api_total_tokens)
    avg_api_tokens = sum(all_api_total_tokens) / len(all_api_total_tokens) if all_api_total_tokens else None
    max_api_prompt_tokens = max(all_api_max_prompt_tokens) if all_api_max_prompt_tokens else 0
    max_api_total_tokens = max(all_api_max_total_tokens) if all_api_max_total_tokens else 0
    # Compute per-run "inclusive" token sums, then average
    all_tokens_incl_trimmed = [a + t for a, t in zip(all_api_total_tokens, all_trimmed_tokens)]
    all_tokens_incl_reset = [a + t + r for a, t, r in zip(all_api_total_tokens, all_trimmed_tokens, all_reset_tokens)]
    all_tokens_incl_all = [a + t + r + th + s for a, t, r, th, s in zip(all_api_total_tokens, all_trimmed_tokens, all_reset_tokens, all_thinking_reset_tokens, all_summary_tokens)]
    avg_tokens_incl_trimmed = sum(all_tokens_incl_trimmed) / len(all_tokens_incl_trimmed) if all_tokens_incl_trimmed else None
    avg_tokens_incl_reset = sum(all_tokens_incl_reset) / len(all_tokens_incl_reset) if all_tokens_incl_reset else None
    avg_tokens_incl_all = sum(all_tokens_incl_all) / len(all_tokens_incl_all) if all_tokens_incl_all else None

    # Save results.json (use task names as keys when available)
    results_file = Path(output_dir) / "results.json"
    per_config_data = {}
    for k, v in config_stats.items():
        key = group_id_to_name.get(k, str(k))
        n = len(v["api_total_tokens"]) or 1
        cfg_incl_trimmed = [a + t for a, t in zip(v["api_total_tokens"], v["trimmed_tokens"])]
        cfg_incl_reset = [a + t + r for a, t, r in zip(v["api_total_tokens"], v["trimmed_tokens"], v["reset_tokens"])]
        cfg_incl_all = [a + t + r + th + s for a, t, r, th, s in zip(v["api_total_tokens"], v["trimmed_tokens"], v["reset_tokens"], v["thinking_reset_tokens"], v["summary_tokens"])]
        per_config_data[key] = {
            "success": v["success"],
            "error": v["error"],
            "avg_accuracy": round(sum(v["accuracies"]) / len(v["accuracies"]), 4) if v["accuracies"] else None,
            "avg_steps": round(sum(v["steps"]) / len(v["steps"]), 2) if v["steps"] else None,
            "avg_tool_calls": round(sum(v["tool_calls"]) / len(v["tool_calls"]), 2) if v["tool_calls"] else None,
            "total_api_tokens": sum(v["api_total_tokens"]),
            "avg_api_tokens": round(sum(v["api_total_tokens"]) / n, 0) if v["api_total_tokens"] else None,
            "api_max_prompt_tokens": max(v["api_max_prompt_tokens"]) if v["api_max_prompt_tokens"] else 0,
            "api_max_total_tokens": max(v["api_max_total_tokens"]) if v["api_max_total_tokens"] else 0,
            "avg_api_tokens_incl_trimmed": round(sum(cfg_incl_trimmed) / n, 0) if cfg_incl_trimmed else None,
            "avg_api_tokens_incl_reset": round(sum(cfg_incl_reset) / n, 0) if cfg_incl_reset else None,
            "avg_api_tokens_incl_all": round(sum(cfg_incl_all) / n, 0) if cfg_incl_all else None,
        }

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
            "avg_accuracy": round(avg_accuracy, 4) if avg_accuracy is not None else None,
            "avg_steps": round(avg_steps, 2) if avg_steps is not None else None,
            "avg_tool_calls": round(avg_tool_calls, 2) if avg_tool_calls is not None else None,
            "total_api_tokens": total_api_tokens_all,
            "avg_api_tokens": round(avg_api_tokens, 0) if avg_api_tokens is not None else None,
            "api_max_prompt_tokens": max_api_prompt_tokens,
            "api_max_total_tokens": max_api_total_tokens,
            "avg_api_tokens_incl_trimmed": round(avg_tokens_incl_trimmed, 0) if avg_tokens_incl_trimmed is not None else None,
            "avg_api_tokens_incl_reset": round(avg_tokens_incl_reset, 0) if avg_tokens_incl_reset is not None else None,
            "avg_api_tokens_incl_all": round(avg_tokens_incl_all, 0) if avg_tokens_incl_all is not None else None,
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

    # Print summary table.
    from rich.console import Console as _SummaryConsole
    _sc = _SummaryConsole()
    _line = "=" * 50
    _sc.print(f"\n[bold]{_line}[/bold]")
    _sc.print(f"[bold]  LOCA Benchmark Summary[/bold]")
    _sc.print(f"[bold]{_line}[/bold]")
    _sc.print(f"  Total Tasks:              {len(task_args)}")
    _sc.print(f"  Success / Error:          {total_success} / {total_error}")
    _sc.print(f"  Average Accuracy:         {avg_accuracy:.4f}" if avg_accuracy is not None else "  Average Accuracy:         N/A")
    _sc.print(f"  Average Steps:            {avg_steps:.2f}" if avg_steps is not None else "  Average Steps:            N/A")
    _sc.print(f"  Average Tool Calls:       {avg_tool_calls:.1f}" if avg_tool_calls is not None else "  Average Tool Calls:       N/A")
    _sc.print(f"  Total API Tokens:         {total_api_tokens_all}")
    _sc.print(f"  Average API Tokens:       {int(avg_api_tokens)}" if avg_api_tokens is not None else "  Average API Tokens:       N/A")
    _sc.print(f"  Avg API Tokens (+Trim):   {int(avg_tokens_incl_trimmed)}" if avg_tokens_incl_trimmed is not None else "  Avg API Tokens (+Trim):   N/A")
    _sc.print(f"  Avg API Tokens (+Reset):  {int(avg_tokens_incl_reset)}" if avg_tokens_incl_reset is not None else "  Avg API Tokens (+Reset):  N/A")
    _sc.print(f"  Avg API Tokens (+All):    {int(avg_tokens_incl_all)}" if avg_tokens_incl_all is not None else "  Avg API Tokens (+All):    N/A")
    _sc.print(f"  Elapsed Time:             {int(elapsed_time)}s")
    _sc.print(f"[bold]{_line}[/bold]")
    _sc.print(f"  Results: {results_file}")
    _sc.print(f"[bold]{_line}[/bold]\n")


def main():
    """Main entry point.
    
    Example usage:
        python -m gem.inference.run_multi_openai_v2 --config_file example_flexible_config.json --runs_per_config 3
    """
    fire.Fire(run_config_combinations)


if __name__ == "__main__":
    main()
