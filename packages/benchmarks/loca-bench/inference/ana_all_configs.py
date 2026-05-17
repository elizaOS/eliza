import json
import numpy as np
import os
import glob
import tiktoken
import csv
import argparse
import sys

# Initialize tokenizer
def get_tokenizer(model_name="gpt-4o"):
    """Get tokenizer"""
    try:
        return tiktoken.encoding_for_model(model_name)
    except:
        return tiktoken.get_encoding("cl100k_base")

def count_tokens_tiktoken(text, tokenizer):
    """Count tokens using tiktoken"""
    if isinstance(text, str):
        try:
            return len(tokenizer.encode(text, disallowed_special=()))
        except Exception as e:
            print(f"Warning: tiktoken encoding failed: {e}")
            return len(text.split())
    return 0

def count_tokens_simple(text):
    """Simple token counting method (split by whitespace)"""
    if isinstance(text, str):
        return len(text.split())
    return 0

def count_characters(text):
    """Count characters"""
    if isinstance(text, str):
        return len(text)
    return 0

def load_summary_file(base_dir):
    """Load summary file and get grouping information"""
    # Find summary file
    summary_files = glob.glob(os.path.join(base_dir, "summary-*.json"))
    
    if not summary_files:
        return None
    
    # Use the latest summary file
    summary_file = max(summary_files, key=os.path.getmtime)
    
    try:
        with open(summary_file, 'r') as f:
            summary_data = json.load(f)
        
        print(f"✅ Found summary file: {os.path.basename(summary_file)}")

        # Check if grouping is enabled
        group_by_seed = summary_data.get('group_by_seed', False)
        config_groups = summary_data.get('config_groups', None)
        
        if group_by_seed and config_groups:
            print(f"✅ Detected config grouping (group_by_seed=True)")
            print(f"   Total {len(config_groups)} config groups")
            return {
                'group_by_seed': True,
                'config_groups': {int(k): v for k, v in config_groups.items()},
                'summary_data': summary_data
            }
        else:
            print(f"   Config grouping not enabled (group_by_seed=False or no grouping info)")
            return {
                'group_by_seed': False,
                'config_groups': None,
                'summary_data': summary_data
            }
    except Exception as e:
        print(f"⚠️  Failed to read summary file: {e}")
        return None

def extract_text_from_content(content):
    """Extract text from Claude Agent SDK content format"""
    if isinstance(content, str):
        return content
    elif isinstance(content, list):
        text_parts = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "TextBlock":
                    text_parts.append(item.get("text", ""))
                elif item.get("type") == "text":
                    # text format inside ToolResultBlock: {"type": "text", "text": "..."}
                    text_parts.append(item.get("text", ""))
                elif item.get("type") == "ToolUseBlock":
                    # Convert tool use to JSON string for token counting
                    try:
                        text_parts.append(json.dumps(item, ensure_ascii=False))
                    except:
                        pass
                elif item.get("type") == "ToolResultBlock":
                    # Content of tool result
                    result_content = item.get("content", "")
                    if isinstance(result_content, str):
                        text_parts.append(result_content)
                    elif isinstance(result_content, list):
                        # Recursively process nested content
                        text_parts.append(extract_text_from_content(result_content))
            elif isinstance(item, str):
                text_parts.append(item)
        return "\n".join(text_parts)
    return ""

def analyze_config_file(json_path, tokenizer):
    """Analyze a single config file (single run)"""
    try:
        with open(json_path, "r") as f:
            data = json.load(f)

        stats = {
            'total_messages': 0,
            'tool_calls': 0,
            'user_messages': 0,
            'assistant_messages': 0,
            'tool_content_chars': 0,
            'tool_content_words': 0,
            'tool_content_tokens': 0,
            'all_content_chars': 0,
            'all_content_words': 0,
            'all_content_tokens': 0,
            'tool_content_list': [],
            'api_total_tokens': 0,  # Total tokens from API calls
            'api_prompt_tokens': 0,
            'api_completion_tokens': 0,
            'api_total_cost': 0.0,  # Total cost from API calls
            'accuracy': 0.0,  # Accuracy
            'total_steps': 0,  # Total steps
            'completed': False,  # Whether completed
            'has_context_length_error': False,  # Whether context length error occurred
            'proper_ending': False,  # Whether ended properly (accuracy=1.0 or last assistant message contains claim_done_claim_done)
            'reset_count': 0,  # Number of reset events
            'summary_count': 0,  # Number of summary events
            'trim_count': 0,  # Number of trim events
            'thinking_reset_count': 0,  # Number of thinking_reset events
            'tokens_before_each_assistant': [],  # Record cumulative tokens before each assistant reply
            'trimmed_tokens_total': 0,  # Total tokens trimmed
            'reset_tokens_total': 0,  # Total tokens reset
            'thinking_reset_tokens_total': 0,  # Total tokens from thinking_reset
            'summary_tokens_total': 0,  # Total tokens from summary
            'has_error': False,  # Whether contains error type action (for excluding from token statistics)
        }
        
        # Check if there are error type actions in steps
        if "steps" in data:
            for step in data["steps"]:
                if "action" in step and isinstance(step["action"], dict):
                    if step["action"].get("type") == "error":
                        stats['has_error'] = True
                        break

        # Extract accuracy, total_steps, completed
        # Support both new format (metrics dict) and old format (top-level fields)
        if "metrics" in data:
            # New trajectory.json format: metrics dict
            metrics = data["metrics"]
            stats['accuracy'] = metrics.get('accuracy', 0.0) or 0.0
            stats['total_steps'] = metrics.get('total_steps', 0) or 0
            stats['completed'] = metrics.get('completed', False) or False
        else:
            # Old format: top-level fields
            # Use or to ensure None values are converted to default values
            stats['accuracy'] = data.get('accuracy', 0.0) or 0.0
            stats['total_steps'] = data.get('total_steps', 0) or 0
            stats['completed'] = data.get('completed', False) or False

        # Count reset, summary, trim, and thinking_reset events (compatible with multiple formats)
        # New trajectory.json format: events is a dict like {"reset": [], "summary": [], "trim": [...], ...}
        if "events" in data and isinstance(data["events"], dict):
            events = data["events"]
            stats['reset_count'] = len(events.get('reset', []))
            stats['summary_count'] = len(events.get('summary', []))
            stats['trim_count'] = len(events.get('trim', []))
            stats['thinking_reset_count'] = len(events.get('thinking_reset', []))
        elif "events" in data and isinstance(data["events"], list) and len(data["events"]) > 0:
            events = data["events"]
            if isinstance(events[0], str):
                # Format: list of event type strings
                stats['reset_count'] = events.count('reset')
                stats['summary_count'] = events.count('summary')
                stats['trim_count'] = events.count('trim')
                stats['thinking_reset_count'] = events.count('thinking_reset')
            else:
                # Format with event dicts
                stats['reset_count'] = len([e for e in events if e.get('type') == 'reset'])
                stats['summary_count'] = len([e for e in events if e.get('type') == 'summary'])
                stats['trim_count'] = len([e for e in events if e.get('type') == 'trim'])
                stats['thinking_reset_count'] = len([e for e in events if e.get('type') == 'thinking_reset'])
        else:
            # Old format: reset_events, summary_events, etc.
            stats['reset_count'] = len(data.get('reset_events', []))
            stats['summary_count'] = len(data.get('summary_events', []))
            stats['trim_count'] = len(data.get('trim_events', []))
            stats['thinking_reset_count'] = len(data.get('thinking_reset_events', []))

        # Calculate total tokens trimmed
        # Support both new format (events dict) and old format (trim_events list)
        if "events" in data and isinstance(data["events"], dict):
            trim_events = data["events"].get('trim', [])
        else:
            trim_events = data.get('trim_events', [])
        for trim_event in trim_events:
            trim_info = trim_event.get('trim_info', {})
            original_tokens = trim_info.get('original_total_tokens', 0)
            trimmed_tokens = trim_info.get('trimmed_total_tokens', 0)
            stats['trimmed_tokens_total'] += (original_tokens - trimmed_tokens)

        # Calculate total tokens reset
        # Support both new format (events dict) and old format (reset_events list)
        if "events" in data and isinstance(data["events"], dict):
            reset_events = data["events"].get('reset', [])
        else:
            reset_events = data.get('reset_events', [])
        
        # Build step to usage mapping for most accurate estimation
        step_usage_map = {}
        if "steps" in data:
            for step in data["steps"]:
                step_info = step.get("info", {})
                tool_use_counter = step_info.get("tool_use_counter", 0)
                if tool_use_counter > 0:
                    usage = step.get("action", {}).get("raw_response", {}).get("usage", {})
                    step_usage_map[tool_use_counter] = usage
        
        for reset_event in reset_events:
            tokens_before = reset_event.get('tokens_before_reset', 0)
            tokens_after = reset_event.get('tokens_after_reset', 0)
            # Backward compatibility: if no tokens_before_reset, try using total_tokens
            if tokens_before == 0:
                tokens_before = reset_event.get('total_tokens', 0)
            
            # If tokens_after_reset is not available, try to estimate
            if tokens_after == 0 and tokens_before > 0:
                # Most accurate method: use prompt_tokens from the step after reset
                reset_step = reset_event.get('step', 0)
                next_step_num = reset_step + 1
                if next_step_num in step_usage_map:
                    next_usage = step_usage_map[next_step_num]
                    tokens_after = next_usage.get('prompt_tokens', 0)

                # If the most accurate method fails, estimate using message count ratio
                if tokens_after == 0:
                    messages_before = reset_event.get('messages_before_count', 0)
                    messages_after = reset_event.get('messages_after_count', 0)
                    if messages_before > 0 and messages_after > 0:
                        tokens_after = int(tokens_before * (messages_after / messages_before))
                    else:
                        # Fallback: estimate based on removed message pair ratio
                        reset_info = reset_event.get('reset_info', {})
                        num_pairs_removed = reset_info.get('num_pairs_removed', 0)
                        total_pairs = reset_info.get('total_pairs', 0)
                        if total_pairs > 0 and num_pairs_removed > 0:
                            tokens_after = int(tokens_before * (1 - num_pairs_removed / total_pairs))
            
            if tokens_before and tokens_after:
                stats['reset_tokens_total'] += (tokens_before - tokens_after)

        # Calculate total tokens removed by thinking_reset
        # Support both new format (events dict) and old format (thinking_reset_events list)
        if "events" in data and isinstance(data["events"], dict):
            thinking_reset_events = data["events"].get('thinking_reset', [])
        else:
            thinking_reset_events = data.get('thinking_reset_events', [])
        for thinking_reset_event in thinking_reset_events:
            tokens_before = thinking_reset_event.get('tokens_before_reset', 0)
            tokens_after = thinking_reset_event.get('tokens_after_reset', 0)
            # Backward compatibility: if tokens_before_reset is not available, try using total_tokens
            if tokens_before == 0:
                tokens_before = thinking_reset_event.get('total_tokens', 0)

            # If tokens_after_reset is not available, try to estimate
            if tokens_after == 0 and tokens_before > 0:
                # Most accurate method: use prompt_tokens from the step after thinking_reset
                reset_step = thinking_reset_event.get('step', 0)
                next_step_num = reset_step + 1
                if next_step_num in step_usage_map:
                    next_usage = step_usage_map[next_step_num]
                    tokens_after = next_usage.get('prompt_tokens', 0)

                # If the most accurate method fails, estimate using thinking_reset_info
                if tokens_after == 0:
                    thinking_reset_info = thinking_reset_event.get('thinking_reset_info', {})
                    total_reasoning_length = thinking_reset_info.get('total_reasoning_content_length', 0)
                    # Rough estimate: 1 char ≈ 0.25 tokens (English)
                    if total_reasoning_length > 0:
                        estimated_reasoning_tokens = int(total_reasoning_length * 0.25)
                        tokens_after = tokens_before - estimated_reasoning_tokens
            
            if tokens_before and tokens_after:
                stats['thinking_reset_tokens_total'] += (tokens_before - tokens_after)

        # Calculate total tokens removed by summary
        # Support both new format (events dict) and old format (summary_events list)
        if "events" in data and isinstance(data["events"], dict):
            summary_events = data["events"].get('summary', [])
        else:
            summary_events = data.get('summary_events', [])
        for summary_event in summary_events:
            tokens_before = summary_event.get('tokens_before_summary', 0)
            tokens_after = summary_event.get('tokens_after_summary', 0)
            # Backward compatibility: if tokens_before_summary is not available, try using total_tokens
            if tokens_before == 0:
                tokens_before = summary_event.get('total_tokens', 0)

            # If tokens_after_summary is not available, try to estimate
            if tokens_after == 0 and tokens_before > 0:
                # Most accurate method: use prompt_tokens from the step after summary
                summary_step = summary_event.get('step', 0)
                next_step_num = summary_step + 1
                if next_step_num in step_usage_map:
                    next_usage = step_usage_map[next_step_num]
                    tokens_after = next_usage.get('prompt_tokens', 0)

                # If the most accurate method fails, estimate using message count ratio
                if tokens_after == 0:
                    messages_before = summary_event.get('messages_before_count', 0)
                    messages_after = summary_event.get('messages_after_count', 0)
                    if messages_before > 0 and messages_after > 0:
                        tokens_after = int(tokens_before * (messages_after / messages_before))
            
            if tokens_before and tokens_after:
                stats['summary_tokens_total'] += (tokens_before - tokens_after)

        # 2. Claude Agent SDK format: clear_tool_results_events and compact_events
        stats['reset_count'] += len(data.get('clear_tool_results_events', []))
        stats['summary_count'] += len(data.get('compact_events', []))

        # 3. run_claude_api.py format: extract from context_management_events
        if 'context_management_events' in data:
            for event in data['context_management_events']:
                event_type = event.get('type', '')
                if 'clear_tool_uses' in event_type:
                    stats['reset_count'] += 1
                elif 'clear_thinking' in event_type:
                    stats['thinking_reset_count'] += 1

        # First check accuracy: if accuracy is 1.0, consider it a proper ending by default
        if stats['accuracy'] == 1.0:
            stats['proper_ending'] = True

        # Extract API usage info - compatible with multiple formats
        # First try loading token_stats.json (or legacy stats.json) saved alongside trajectory.json
        stats_file = os.path.join(os.path.dirname(json_path), "token_stats.json")
        if not os.path.exists(stats_file):
            # Fallback to legacy name for older runs
            stats_file = os.path.join(os.path.dirname(json_path), "stats.json")
        if os.path.exists(stats_file):
            try:
                with open(stats_file, "r") as sf:
                    stats_data = json.load(sf)
                for step_usage in stats_data.get("usage_tracking", []):
                    step_total = step_usage.get("total_tokens", 0)
                    if step_total > stats['api_total_tokens']:
                        stats['api_total_tokens'] = step_total
                        stats['api_prompt_tokens'] = step_usage.get("prompt_tokens", 0)
                    # completion_tokens are per-step output (not cumulative), so sum them
                    stats['api_completion_tokens'] += step_usage.get("completion_tokens", 0)
            except Exception as e:
                print(f"  Warning: Failed to load token_stats.json: {e}")

        # Prioritize run_claude_api.py format (total_usage field)
        elif "total_usage" in data:
            # run_claude_api.py format: extract directly from total_usage
            total_usage = data["total_usage"]
            stats['api_prompt_tokens'] = total_usage.get("input_tokens", 0)
            stats['api_completion_tokens'] = total_usage.get("output_tokens", 0)
            stats['api_total_cost'] = total_usage.get("total_cost_usd", 0.0) or 0.0

            # api_total_tokens extracted from the last step's usage_tracking (includes all token types)
            # Formula: input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens
            if "usage_tracking" in data and len(data["usage_tracking"]) > 0:
                last_step = data["usage_tracking"][-1]
                stats['api_total_tokens'] = (
                    last_step.get("input_tokens", 0) +
                    last_step.get("cache_creation_input_tokens", 0) +
                    last_step.get("cache_read_input_tokens", 0) +
                    last_step.get("output_tokens", 0)
                )
            else:
                # If usage_tracking is not available, fall back to simple calculation
                stats['api_total_tokens'] = stats['api_prompt_tokens'] + stats['api_completion_tokens']

        elif "steps" in data and len(data["steps"]) > 0:
            try:
                # Detect if this is Claude Agent SDK format
                first_step = data["steps"][0]
                is_claude_agent_format = "message" in first_step and "message_type" in first_step

                if is_claude_agent_format:
                    # Claude Agent SDK format: extract from usage_summary or usage field in steps
                    if "usage_summary" in data:
                        usage_summary = data["usage_summary"]
                        # Total input tokens = input_tokens + cache_read + cache_creation
                        input_tokens = usage_summary.get("total_input_tokens", 0)
                        cache_read = usage_summary.get("cache_read_input_tokens", 0)
                        cache_creation = usage_summary.get("cache_creation_input_tokens", 0)
                        output_tokens = usage_summary.get("total_output_tokens", 0)

                        stats['api_prompt_tokens'] = input_tokens + cache_read + cache_creation
                        stats['api_completion_tokens'] = output_tokens
                        stats['api_total_tokens'] = stats['api_prompt_tokens'] + stats['api_completion_tokens']
                        stats['api_total_cost'] = usage_summary.get("total_cost_usd", 0.0) or 0.0
                    else:
                        # Accumulate usage from steps
                        for step in data["steps"]:
                            if "usage" in step:
                                usage = step["usage"]
                                stats['api_prompt_tokens'] += usage.get("input_tokens", 0)
                                stats['api_completion_tokens'] += usage.get("output_tokens", 0)
                        stats['api_total_tokens'] = stats['api_prompt_tokens'] + stats['api_completion_tokens']
                else:
                    # Original format: extract from action.raw_response.usage
                    for step in data["steps"]:
                        if "action" in step and "raw_response" in step["action"]:
                            usage = step["action"]["raw_response"].get("usage", {})

                            # Accumulate tokens (from each step)
                            step_total_tokens = usage.get("total_tokens", 0)
                            step_prompt_tokens = usage.get("prompt_tokens", 0)
                            step_completion_tokens = usage.get("completion_tokens", 0)

                            # For tokens, only use the last valid value (since API may return cumulative values)
                            if step_total_tokens > stats['api_total_tokens']:
                                stats['api_total_tokens'] = step_total_tokens
                                stats['api_prompt_tokens'] = step_prompt_tokens
                                stats['api_completion_tokens'] = step_completion_tokens

                            # Accumulate cost (cost from each step needs to be added)
                            step_cost = usage.get("cost", 0.0)
                            if step_cost > 0:
                                stats['api_total_cost'] += step_cost

            except Exception as e:
                print(f"  Warning: Unable to extract usage info: {e}")
        
        # Count messages - compatible with multiple formats
        messages = []
        is_claude_agent_format = False
        is_run_claude_api_format = False
        is_new_trajectory_format = False

        # Detect format type
        # 0. New trajectory.json format: top-level "messages" list with "metrics" dict
        if "messages" in data and "metrics" in data:
            is_new_trajectory_format = True
        # 1. Prioritize run_claude_api.py format (has full_messages_history or claude_messages)
        elif "full_messages_history" in data and data["full_messages_history"]:
            is_run_claude_api_format = True
        # 2. Detect if this is Claude Agent SDK format
        elif "steps" in data and len(data["steps"]) > 0:
            first_step = data["steps"][0]
            is_claude_agent_format = "message" in first_step and "message_type" in first_step

        if is_new_trajectory_format:
            # New trajectory.json format: use top-level messages list directly
            messages = data.get("messages", [])

        elif is_run_claude_api_format:
            # run_claude_api.py format: use full_messages_history
            # full_messages_history contains complete message history
            messages = data.get("full_messages_history", [])

            # If full_messages_history is empty, try using claude_messages
            if not messages and "claude_messages" in data:
                messages = data["claude_messages"]

        elif is_claude_agent_format:
            # Claude Agent SDK format: extract messages from steps
            # Convert user_prompt to user message
            if "user_prompt" in data:
                messages.append({
                    "role": "user",
                    "content": data["user_prompt"]
                })

            # Extract assistant/tool messages from steps
            for step in data["steps"]:
                message = step.get("message", {})
                message_type = step.get("message_type", "")

                if message_type == "AssistantMessage":
                    messages.append({
                        "role": "assistant",
                        "content": message.get("content", []),
                        "tool_calls": []  # Extract from ToolUseBlock in content
                    })
                elif message_type == "UserMessage":
                    # UserMessage may contain ToolResultBlock
                    content = message.get("content", [])
                    # Check if it contains ToolResultBlock
                    has_tool_result = False
                    if isinstance(content, list):
                        for item in content:
                            if isinstance(item, dict) and item.get("type") == "ToolResultBlock":
                                has_tool_result = True
                                break

                    if has_tool_result:
                        # This is a tool result message
                        messages.append({
                            "role": "tool",
                            "content": content
                        })
                    else:
                        # This is a regular user message
                        messages.append({
                            "role": "user",
                            "content": content
                        })
        else:
            # Original format: use full_messages_history or final_messages
            if "full_messages_history" in data:
                full_history = data["full_messages_history"]

                # Check if the first message is from user, if not, get the first user message from final_messages
                if full_history and len(full_history) > 0:
                    first_message = full_history[0]
                    if first_message.get("role") != "user":
                        # Find the first user message from final_messages
                        if "final_messages" in data:
                            final_messages = data["final_messages"]
                            for msg in final_messages:
                                if msg.get("role") == "user":
                                    # Add the first user message to the beginning of messages
                                    messages.append(msg)
                                    break
                        # Then add all messages from full_messages_history
                        messages.extend(full_history)
                    else:
                        # If the first message is already from user, use full_messages_history directly
                        messages = full_history
                else:
                    messages = full_history
            elif "final_messages" in data:
                # If full_messages_history is not available, fall back to using final_messages
                messages = data["final_messages"]
        
        if messages:
            stats['total_messages'] = len(messages)
            
            for item in messages:
                role = item.get("role", "")
                
                # If encountering an assistant message, record the current cumulative tokens (before processing this assistant message)
                if role == "assistant":
                    stats['tokens_before_each_assistant'].append({
                        'assistant_index': stats['assistant_messages'],  # Which assistant message
                        'cumulative_tokens': stats['all_content_tokens']  # Cumulative token count
                    })

                # Collect all content of this message for statistics
                all_text_parts = []

                # Process content for different roles
                if role == "tool":
                    stats['tool_calls'] += 1
                    content = item.get("content", "")
                    # Use extract_text_from_content to process content
                    content_text = extract_text_from_content(content)
                    if content_text:
                        all_text_parts.append(content_text)
                        # Count tool content separately
                        char_count = count_characters(content_text)
                        word_count = count_tokens_simple(content_text)
                        token_count = count_tokens_tiktoken(content_text, tokenizer)

                        stats['tool_content_chars'] += char_count
                        stats['tool_content_words'] += word_count
                        stats['tool_content_tokens'] += token_count
                        stats['tool_content_list'].append({
                            'chars': char_count,
                            'words': word_count,
                            'tokens': token_count
                        })

                elif role == "user":
                    stats['user_messages'] += 1
                    # Claude API format: user message content may contain tool_result
                    content = item.get("content", "")
                    if isinstance(content, list):
                        has_tool_result = False
                        for content_item in content:
                            if isinstance(content_item, dict) and content_item.get("type") == "tool_result":
                                has_tool_result = True
                                # Count tool_result as tool call (Claude format)
                                stats['tool_calls'] += 1
                                tool_result_content = content_item.get("content", "")
                                if tool_result_content:
                                    tool_content_text = extract_text_from_content(tool_result_content)
                                    if tool_content_text:
                                        all_text_parts.append(tool_content_text)
                                        # Count tool content separately
                                        char_count = count_characters(tool_content_text)
                                        word_count = count_tokens_simple(tool_content_text)
                                        token_count = count_tokens_tiktoken(tool_content_text, tokenizer)

                                        stats['tool_content_chars'] += char_count
                                        stats['tool_content_words'] += word_count
                                        stats['tool_content_tokens'] += token_count
                                        stats['tool_content_list'].append({
                                            'chars': char_count,
                                            'words': word_count,
                                            'tokens': token_count
                                        })
                            else:
                                # Content that is not tool_result (e.g., plain text)
                                content_text = extract_text_from_content(content_item)
                                if content_text:
                                    all_text_parts.append(content_text)
                    else:
                        # Case where content is a string
                        content_text = extract_text_from_content(content)
                        if content_text:
                            all_text_parts.append(content_text)

                elif role == "assistant":
                    stats['assistant_messages'] += 1
                    # For assistant, need to count: content, reasoning_content, tool_calls
                    content = item.get("content", "")
                    content_text = extract_text_from_content(content)
                    if content_text:
                        all_text_parts.append(content_text)

                    reasoning_content = item.get("reasoning_content", "")
                    if reasoning_content:
                        all_text_parts.append(extract_text_from_content(reasoning_content))

                    tool_calls = item.get("tool_calls", [])
                    if tool_calls:
                        # Convert tool_calls to JSON string to calculate tokens
                        try:
                            tool_calls_str = json.dumps(tool_calls, ensure_ascii=False)
                            all_text_parts.append(tool_calls_str)
                        except:
                            pass

                else:
                    # Other roles, count content
                    content = item.get("content", "")
                    content_text = extract_text_from_content(content)
                    if content_text:
                        all_text_parts.append(content_text)
                
                # Add this message's total content to all_content
                if all_text_parts:
                    combined_text = "\n".join(all_text_parts)
                    char_count = count_characters(combined_text)
                    word_count = count_tokens_simple(combined_text)
                    token_count = count_tokens_tiktoken(combined_text, tokenizer)
                    
                    stats['all_content_chars'] += char_count
                    stats['all_content_words'] += word_count
                    stats['all_content_tokens'] += token_count
        
        # Check if the last message contains context length error and whether it ended properly
        if messages and len(messages) > 0:
            last_message = messages[-1]
            if last_message.get("role") == "assistant":
                content = last_message.get("content", "")
                content_text = extract_text_from_content(content)
                # Check context length error
                if "maximum context length" in content_text or "context length" in content_text.lower():
                    stats['has_context_length_error'] = True

                # Additional check for claim_done tool call (may end properly even if accuracy is not 1.0)
                tool_calls = last_message.get("tool_calls", [])
                if tool_calls:
                    for tool_call in tool_calls:
                        if isinstance(tool_call, dict):
                            function_info = tool_call.get("function", {})
                            if isinstance(function_info, dict):
                                function_name = function_info.get("name", "")
                                if function_name == "claim_done_claim_done":
                                    stats['proper_ending'] = True
                                    break

                # Claude Agent SDK format: check ToolUseBlock in content
                if isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and item.get("type") == "ToolUseBlock":
                            tool_name = item.get("name", "")
                            if "claim_done" in tool_name:
                                stats['proper_ending'] = True
                                break
        
        return stats
    except Exception as e:
        print(f"Error processing {json_path}: {e}")
        return None

# Parse command line arguments
parser = argparse.ArgumentParser(description='Analyze benchmark configuration file statistics')
parser.add_argument('--input', '-i', type=str, required=False,
                    help='Input directory path (benchmark directory containing config_* subdirectories)')
parser.add_argument('--output', '-o', type=str, required=False,
                    help='Output directory path (directory to save analysis results, defaults to parent of input directory)')
args = parser.parse_args()

def analyze_config_dir(config_path, tokenizer):
    """Analyze the entire config directory (all runs)"""
    # Find all JSON files under this config
    # New structure: config_*/run_*/trajectory.json
    # Old structure: config_*/*.json

    # First try new structure (run_*/trajectory.json)
    json_files = sorted(glob.glob(os.path.join(config_path, "run_*", "trajectory.json")))

    if not json_files:
        # Try state-based structure (state*/trajectory.json)
        json_files = sorted(glob.glob(os.path.join(config_path, "state*", "trajectory.json")))

    if not json_files:
        # Fall back to old structure (*.json directly in config_*)
        json_files = sorted(glob.glob(os.path.join(config_path, "*.json")))

    # Filter out error files (files containing "-error-" are intermediate error states and should not be counted)
    original_count = len(json_files)
    json_files = [f for f in json_files if '-error-' not in os.path.basename(f)]
    filtered_count = original_count - len(json_files)
    if filtered_count > 0:
        print(f"  Filtered out {filtered_count} error files")

    if not json_files:
        print(f"  Warning: No JSON files found")
        return None

    # Store statistics for all runs
    all_runs = []
    
    for json_path in json_files:
        stats = analyze_config_file(json_path, tokenizer)
        if stats:
            all_runs.append(stats)
    
    if not all_runs:
        return None

    # Filter out runs with errors for token statistics
    valid_runs_for_tokens = [r for r in all_runs if not r.get('has_error', False)]
    error_runs_count = len(all_runs) - len(valid_runs_for_tokens)
    if error_runs_count > 0:
        print(f"  Skipping token statistics for {error_runs_count} runs with errors")
    
    # Aggregate statistics
    config_summary = {
        'total_runs': len(all_runs),
        'success_runs': sum(1 for r in all_runs if r['completed']),
        'error_runs': sum(1 for r in all_runs if not r['completed']),
        'error_action_runs': error_runs_count,  # Number of runs containing error action
        'valid_runs_for_tokens': len(valid_runs_for_tokens),  # Number of valid runs for token statistics
        'context_length_error_runs': sum(1 for r in all_runs if r.get('has_context_length_error', False)),
        'context_length_error_rate': sum(1 for r in all_runs if r.get('has_context_length_error', False)) / len(all_runs) if len(all_runs) > 0 else 0,
        'improper_ending_runs': sum(1 for r in all_runs if not r.get('proper_ending', False)),
        'improper_ending_rate': sum(1 for r in all_runs if not r.get('proper_ending', False)) / len(all_runs) if len(all_runs) > 0 else 0,
        
        # Accuracy and steps statistics (using all runs)
        'accuracies': [r['accuracy'] for r in all_runs],
        'steps': [r['total_steps'] for r in all_runs],
        'avg_accuracy': sum(r['accuracy'] for r in all_runs) / len(all_runs),
        'avg_steps': sum(r['total_steps'] for r in all_runs) / len(all_runs),
        
        # Reset, summary, trim and thinking_reset event statistics (using all runs)
        'total_reset_count': sum(r['reset_count'] for r in all_runs),
        'total_summary_count': sum(r['summary_count'] for r in all_runs),
        'total_trim_count': sum(r['trim_count'] for r in all_runs),
        'total_thinking_reset_count': sum(r['thinking_reset_count'] for r in all_runs),
        'avg_reset_count': sum(r['reset_count'] for r in all_runs) / len(all_runs),
        'avg_summary_count': sum(r['summary_count'] for r in all_runs) / len(all_runs),
        'avg_trim_count': sum(r['trim_count'] for r in all_runs) / len(all_runs),
        'avg_thinking_reset_count': sum(r['thinking_reset_count'] for r in all_runs) / len(all_runs),
        
        # Token statistics (only using runs without errors)
        'total_tool_calls': sum(r['tool_calls'] for r in valid_runs_for_tokens),
        'total_tool_content_tokens': sum(r['tool_content_tokens'] for r in valid_runs_for_tokens),
        'total_all_content_tokens': sum(r['all_content_tokens'] for r in valid_runs_for_tokens),
        'total_api_tokens': sum(r['api_total_tokens'] for r in valid_runs_for_tokens),
        'total_api_prompt_tokens': sum(r['api_prompt_tokens'] for r in valid_runs_for_tokens),
        'total_api_completion_tokens': sum(r['api_completion_tokens'] for r in valid_runs_for_tokens),
        'total_api_cost': sum(r['api_total_cost'] for r in valid_runs_for_tokens),
        'total_trimmed_tokens': sum(r['trimmed_tokens_total'] for r in valid_runs_for_tokens),  # Total trimmed tokens
        'total_reset_tokens': sum(r['reset_tokens_total'] for r in valid_runs_for_tokens),  # Total reset tokens
        'total_thinking_reset_tokens': sum(r['thinking_reset_tokens_total'] for r in valid_runs_for_tokens),  # Total thinking_reset tokens
        'total_summary_tokens': sum(r['summary_tokens_total'] for r in valid_runs_for_tokens),  # Total summary tokens
        'total_api_tokens_with_trimmed': sum(r['api_total_tokens'] + r['trimmed_tokens_total'] for r in valid_runs_for_tokens),  # Including trimmed tokens
        'total_api_tokens_with_trimmed_and_reset': sum(r['api_total_tokens'] + r['trimmed_tokens_total'] + r['reset_tokens_total'] for r in valid_runs_for_tokens),  # Including trimmed and reset tokens
        'total_api_tokens_with_all_removed': sum(r['api_total_tokens'] + r['trimmed_tokens_total'] + r['reset_tokens_total'] + r['thinking_reset_tokens_total'] + r['summary_tokens_total'] for r in valid_runs_for_tokens),  # Including trimmed, reset, thinking_reset and summary tokens
        
        # Average per run statistics (only using runs without errors)
        'avg_tool_calls': sum(r['tool_calls'] for r in valid_runs_for_tokens) / len(valid_runs_for_tokens) if len(valid_runs_for_tokens) > 0 else 0,
        'avg_tool_content_tokens': sum(r['tool_content_tokens'] for r in valid_runs_for_tokens) / len(valid_runs_for_tokens) if len(valid_runs_for_tokens) > 0 else 0,
        'avg_all_content_tokens': sum(r['all_content_tokens'] for r in valid_runs_for_tokens) / len(valid_runs_for_tokens) if len(valid_runs_for_tokens) > 0 else 0,
        'avg_api_tokens': sum(r['api_total_tokens'] for r in valid_runs_for_tokens) / len(valid_runs_for_tokens) if len(valid_runs_for_tokens) > 0 else 0,
        'avg_api_prompt_tokens': sum(r['api_prompt_tokens'] for r in valid_runs_for_tokens) / len(valid_runs_for_tokens) if len(valid_runs_for_tokens) > 0 else 0,
        'avg_api_completion_tokens': sum(r['api_completion_tokens'] for r in valid_runs_for_tokens) / len(valid_runs_for_tokens) if len(valid_runs_for_tokens) > 0 else 0,
        'avg_api_cost': sum(r['api_total_cost'] for r in valid_runs_for_tokens) / len(valid_runs_for_tokens) if len(valid_runs_for_tokens) > 0 else 0,
        'avg_trimmed_tokens': sum(r['trimmed_tokens_total'] for r in valid_runs_for_tokens) / len(valid_runs_for_tokens) if len(valid_runs_for_tokens) > 0 else 0,  # Average trimmed tokens per run
        'avg_reset_tokens': sum(r['reset_tokens_total'] for r in valid_runs_for_tokens) / len(valid_runs_for_tokens) if len(valid_runs_for_tokens) > 0 else 0,  # Average reset tokens per run
        'avg_thinking_reset_tokens': sum(r['thinking_reset_tokens_total'] for r in valid_runs_for_tokens) / len(valid_runs_for_tokens) if len(valid_runs_for_tokens) > 0 else 0,  # Average thinking_reset tokens per run
        'avg_summary_tokens': sum(r['summary_tokens_total'] for r in valid_runs_for_tokens) / len(valid_runs_for_tokens) if len(valid_runs_for_tokens) > 0 else 0,  # Average summary tokens per run
        'avg_api_tokens_with_trimmed': sum(r['api_total_tokens'] + r['trimmed_tokens_total'] for r in valid_runs_for_tokens) / len(valid_runs_for_tokens) if len(valid_runs_for_tokens) > 0 else 0,  # Average tokens including trimmed
        'avg_api_tokens_with_trimmed_and_reset': sum(r['api_total_tokens'] + r['trimmed_tokens_total'] + r['reset_tokens_total'] for r in valid_runs_for_tokens) / len(valid_runs_for_tokens) if len(valid_runs_for_tokens) > 0 else 0,  # Average tokens including trimmed and reset
        'avg_api_tokens_with_all_removed': sum(r['api_total_tokens'] + r['trimmed_tokens_total'] + r['reset_tokens_total'] + r['thinking_reset_tokens_total'] + r['summary_tokens_total'] for r in valid_runs_for_tokens) / len(valid_runs_for_tokens) if len(valid_runs_for_tokens) > 0 else 0,  # Average tokens including trimmed, reset, thinking_reset and summary
        
        # Detailed information for all runs
        'runs': all_runs
    }

    # Calculate average tokens per tool call
    if config_summary['total_tool_calls'] > 0:
        config_summary['avg_tokens_per_tool_call'] = config_summary['total_tool_content_tokens'] / config_summary['total_tool_calls']
    else:
        config_summary['avg_tokens_per_tool_call'] = 0
    
    return config_summary

# Main directory path
if args.input:
    base_dir = args.input
else:
    print("Error: --input argument is required to specify input directory")
    print("Usage: python ana_all_configs.py --input /path/to/benchmark/dir")
    sys.exit(1)

# Verify input directory exists
if not os.path.exists(base_dir):
    print(f"Error: Input directory does not exist: {base_dir}")
    sys.exit(1)

if not os.path.isdir(base_dir):
    print(f"Error: Input path is not a directory: {base_dir}")
    sys.exit(1)

# Output directory path
if args.output:
    output_dir = args.output
else:
    # Default to parent directory of input directory
    output_dir = os.path.dirname(base_dir)

# Create output directory if it doesn't exist
os.makedirs(output_dir, exist_ok=True)

print(f"Input directory: {base_dir}")
print(f"Output directory: {output_dir}")
print("=" * 100)

# Try to load summary file to get grouping information
print("\nChecking grouping information...")
summary_info = load_summary_file(base_dir)
group_by_seed = False
config_groups = None

if summary_info:
    group_by_seed = summary_info.get('group_by_seed', False)
    config_groups = summary_info.get('config_groups', None)

    if group_by_seed and config_groups:
        print("\nGrouped statistics mode")
        print(f"   Number of config groups: {len(config_groups)}")
        for group_id, config_indices in sorted(config_groups.items()):
            print(f"   Group {group_id}: contains config_{config_indices} ({len(config_indices)} runs)")
    else:
        print("\nIndependent config mode")
else:
    print("   Summary file not found, using independent config mode")

print("=" * 100)

# Initialize tokenizer
print("\nInitializing tokenizer...")
tokenizer = get_tokenizer()

# Store statistics for all configs
all_configs_stats = {}

# Iterate through all config directories
# New structure: base_dir/tasks/config_*, Old structure: base_dir/config_*
tasks_subdir = os.path.join(base_dir, "tasks")
if os.path.isdir(tasks_subdir):
    config_base_dir = tasks_subdir
    print(f"Using new output structure: {tasks_subdir}")
else:
    config_base_dir = base_dir
    print(f"Using legacy output structure: {base_dir}")

config_dirs = sorted([d for d in os.listdir(config_base_dir)
                       if os.path.isdir(os.path.join(config_base_dir, d))])

print(f"\nFound {len(config_dirs)} config directories\n")
print("=" * 100)

for config_dir in config_dirs:
    config_path = os.path.join(config_base_dir, config_dir)

    # Extract config_id (handle both numeric and non-numeric suffixes)
    config_id_str = config_dir.split('_', 1)[1] if '_' in config_dir else config_dir
    try:
        config_id = int(config_id_str)
    except ValueError:
        # Non-numeric config_id, use hash for grouping purposes
        config_id = hash(config_id_str) % 10000

    # If in grouped mode, display grouping information
    group_info = ""
    if group_by_seed and config_groups:
        # Check which group this config_id belongs to
        for group_id, member_configs in config_groups.items():
            if config_id in member_configs:
                group_info = f" [Group {group_id}]"
                if len(member_configs) > 1:
                    group_info += f" (grouped with config_{[c for c in member_configs if c != config_id]})"
                break

    print(f"\nAnalyzing {config_dir}{group_info}...")
    
    stats = analyze_config_dir(config_path, tokenizer)
    
    if stats:
        all_configs_stats[config_dir] = stats

        print(f"  Total Runs: {stats['total_runs']}")
        print(f"  Successful Runs: {stats['success_runs']}")
        print(f"  Failed Runs: {stats['error_runs']}")
        print(f"  Context Length Errors: {stats['context_length_error_runs']} ({stats['context_length_error_rate']*100:.1f}%)")
        print(f"  Improper Endings: {stats['improper_ending_runs']} ({stats['improper_ending_rate']*100:.1f}%)")
        print(f"  === Task Metrics ===")
        print(f"  Average Accuracy: {stats['avg_accuracy']:.4f}")
        print(f"  Average Steps: {stats['avg_steps']:.2f}")
        print(f"  Accuracy List: {stats['accuracies']}")
        print(f"  Steps List: {stats['steps']}")
        print(f"  === Reset & Summary & Trim & Thinking Reset Statistics ===")
        print(f"  Total Reset Count: {stats['total_reset_count']}")
        print(f"  Total Summary Count: {stats['total_summary_count']}")
        print(f"  Total Trim Count: {stats['total_trim_count']}")
        print(f"  Total Thinking Reset Count: {stats['total_thinking_reset_count']}")
        print(f"  Average Reset per Run: {stats['avg_reset_count']:.2f}")
        print(f"  Average Summary per Run: {stats['avg_summary_count']:.2f}")
        print(f"  Average Trim per Run: {stats['avg_trim_count']:.2f}")
        print(f"  Average Thinking Reset per Run: {stats['avg_thinking_reset_count']:.2f}")
        print(f"  === API Usage (all runs combined) ===")
        print(f"  Total API Cost: ${stats['total_api_cost']:.6f}")
        print(f"  Average API Cost per Run: ${stats['avg_api_cost']:.6f}")
        print(f"  Total API Tokens: {stats['total_api_tokens']:,}")
        print(f"  Average API Tokens per Run: {stats['avg_api_tokens']:,.2f}")
        print(f"  Total API Prompt Tokens: {stats['total_api_prompt_tokens']:,}")
        print(f"  Total API Completion Tokens: {stats['total_api_completion_tokens']:,}")
        print(f"  === Tool Content Statistics (all runs combined) ===")
        print(f"  Total Tool Calls: {stats['total_tool_calls']}")
        print(f"  Total Tool Content Tokens: {stats['total_tool_content_tokens']:,}")
        print(f"  Average Tokens per Tool Call: {stats['avg_tokens_per_tool_call']:.2f}")
        print(f"  Total All Content Tokens: {stats['total_all_content_tokens']:,}")
        
        # Display token progression statistics
        if stats['runs'] and any(run.get('tokens_before_each_assistant') for run in stats['runs']):
            all_progressions = []
            for run in stats['runs']:
                progression = run.get('tokens_before_each_assistant', [])
                if progression and len(progression) > 0:
                    all_progressions.append(progression)

            if all_progressions:
                print(f"  === Token Progression ===")
                # Calculate average number of assistant responses per run
                avg_assistants = sum(len(p) for p in all_progressions) / len(all_progressions)
                print(f"  Average Assistant Responses per Run: {avg_assistants:.1f}")

                # If all runs have the same number of assistant responses, show average token progression
                if len(set(len(p) for p in all_progressions)) == 1:
                    num_steps = len(all_progressions[0])
                    print(f"  Average Token Growth Trajectory (before each assistant response):")
                    for step in range(num_steps):
                        avg_tokens = sum(p[step]['cumulative_tokens'] for p in all_progressions) / len(all_progressions)
                        print(f"    Assistant #{step}: {avg_tokens:,.0f} tokens")

print("\n" + "=" * 100)
print("\n=== Summary Statistics ===\n")

# Display grouping mode information
if group_by_seed and config_groups:
    print(f"Grouped Statistics Mode")
    print(f"   Actual config groups: {len(config_groups)}")
    print(f"   Total config directories: {len(config_dirs)}")
    print(f"\nConfig Group Details:")
    for group_id, member_configs in sorted(config_groups.items()):
        config_names = [f"config_{c}" for c in member_configs]
        print(f"   Group {group_id}: {', '.join(config_names)} ({len(member_configs)} runs)")
    print()
else:
    print(f"Independent Config Mode")
    print(f"   Total configs: {len(config_dirs)}\n")

print("=" * 50)

# Aggregate statistics
total_runs = sum(s['total_runs'] for s in all_configs_stats.values())
total_success = sum(s['success_runs'] for s in all_configs_stats.values())
total_error = sum(s['error_runs'] for s in all_configs_stats.values())
total_context_length_errors = sum(s['context_length_error_runs'] for s in all_configs_stats.values())
total_improper_endings = sum(s['improper_ending_runs'] for s in all_configs_stats.values())
total_reset_events = sum(s['total_reset_count'] for s in all_configs_stats.values())
total_summary_events = sum(s['total_summary_count'] for s in all_configs_stats.values())
total_trim_events = sum(s['total_trim_count'] for s in all_configs_stats.values())
total_thinking_reset_events = sum(s['total_thinking_reset_count'] for s in all_configs_stats.values())

total_tool_calls = sum(s['total_tool_calls'] for s in all_configs_stats.values())
total_tool_tokens = sum(s['total_tool_content_tokens'] for s in all_configs_stats.values())
total_all_tokens = sum(s['total_all_content_tokens'] for s in all_configs_stats.values())
total_api_tokens = sum(s['total_api_tokens'] for s in all_configs_stats.values())
total_api_prompt_tokens = sum(s['total_api_prompt_tokens'] for s in all_configs_stats.values())
total_api_completion_tokens = sum(s['total_api_completion_tokens'] for s in all_configs_stats.values())
total_api_cost = sum(s['total_api_cost'] for s in all_configs_stats.values())
total_trimmed_tokens = sum(s['total_trimmed_tokens'] for s in all_configs_stats.values())
total_reset_tokens = sum(s['total_reset_tokens'] for s in all_configs_stats.values())
total_thinking_reset_tokens = sum(s['total_thinking_reset_tokens'] for s in all_configs_stats.values())
total_summary_tokens = sum(s['total_summary_tokens'] for s in all_configs_stats.values())
total_api_tokens_with_trimmed = sum(s['total_api_tokens_with_trimmed'] for s in all_configs_stats.values())
total_api_tokens_with_trimmed_and_reset = sum(s['total_api_tokens_with_trimmed_and_reset'] for s in all_configs_stats.values())
total_api_tokens_with_all_removed = sum(s['total_api_tokens_with_all_removed'] for s in all_configs_stats.values())

# Collect statistics lists for each config
avg_accuracy_list = [s['avg_accuracy'] for s in all_configs_stats.values()]
avg_steps_list = [s['avg_steps'] for s in all_configs_stats.values()]
tool_tokens_list = [s['total_tool_content_tokens'] for s in all_configs_stats.values()]
all_tokens_list = [s['total_all_content_tokens'] for s in all_configs_stats.values()]
avg_tokens_per_call_list = [s['avg_tokens_per_tool_call'] for s in all_configs_stats.values()]
api_tokens_list = [s['total_api_tokens'] for s in all_configs_stats.values()]
api_prompt_tokens_list = [s['total_api_prompt_tokens'] for s in all_configs_stats.values()]
api_completion_tokens_list = [s['total_api_completion_tokens'] for s in all_configs_stats.values()]
avg_api_tokens_per_run_list = [s['avg_api_tokens'] for s in all_configs_stats.values()]
api_cost_list = [s['total_api_cost'] for s in all_configs_stats.values()]
avg_api_cost_per_run_list = [s['avg_api_cost'] for s in all_configs_stats.values()]
trimmed_tokens_list = [s['total_trimmed_tokens'] for s in all_configs_stats.values()]
avg_trimmed_tokens_per_run_list = [s['avg_trimmed_tokens'] for s in all_configs_stats.values()]
reset_tokens_list = [s['total_reset_tokens'] for s in all_configs_stats.values()]
avg_reset_tokens_per_run_list = [s['avg_reset_tokens'] for s in all_configs_stats.values()]
thinking_reset_tokens_list = [s['total_thinking_reset_tokens'] for s in all_configs_stats.values()]
avg_thinking_reset_tokens_per_run_list = [s['avg_thinking_reset_tokens'] for s in all_configs_stats.values()]
summary_tokens_list = [s['total_summary_tokens'] for s in all_configs_stats.values()]
avg_summary_tokens_per_run_list = [s['avg_summary_tokens'] for s in all_configs_stats.values()]
api_tokens_with_trimmed_list = [s['total_api_tokens_with_trimmed'] for s in all_configs_stats.values()]
avg_api_tokens_with_trimmed_per_run_list = [s['avg_api_tokens_with_trimmed'] for s in all_configs_stats.values()]
api_tokens_with_trimmed_and_reset_list = [s['total_api_tokens_with_trimmed_and_reset'] for s in all_configs_stats.values()]
avg_api_tokens_with_trimmed_and_reset_per_run_list = [s['avg_api_tokens_with_trimmed_and_reset'] for s in all_configs_stats.values()]
api_tokens_with_all_removed_list = [s['total_api_tokens_with_all_removed'] for s in all_configs_stats.values()]
avg_api_tokens_with_all_removed_per_run_list = [s['avg_api_tokens_with_all_removed'] for s in all_configs_stats.values()]

total_error_action_runs = sum(s.get('error_action_runs', 0) for s in all_configs_stats.values())
total_valid_runs_for_tokens = sum(s.get('valid_runs_for_tokens', s['total_runs']) for s in all_configs_stats.values())

# Filter out configs where all runs have 0 tokens (for calculating average tokens of valid configs)
valid_configs_for_tokens = {k: v for k, v in all_configs_stats.items() if v.get('valid_runs_for_tokens', v['total_runs']) > 0}
excluded_configs_for_tokens = {k: v for k, v in all_configs_stats.items() if v.get('valid_runs_for_tokens', v['total_runs']) == 0}
num_excluded_configs = len(excluded_configs_for_tokens)

# Recalculate token-related statistics lists for valid configs
if valid_configs_for_tokens:
    valid_config_names = sorted(valid_configs_for_tokens.keys(), key=lambda x: (int(x.split('_')[1]) if x.startswith('config_') and x.split('_')[1].isdigit() else float('inf'), x))
    valid_api_tokens_list = [valid_configs_for_tokens[k]['total_api_tokens'] for k in valid_config_names]
    valid_avg_api_tokens_per_run_list = [valid_configs_for_tokens[k]['avg_api_tokens'] for k in valid_config_names]
    valid_api_cost_list = [valid_configs_for_tokens[k]['total_api_cost'] for k in valid_config_names]
    valid_avg_api_cost_per_run_list = [valid_configs_for_tokens[k]['avg_api_cost'] for k in valid_config_names]
    valid_api_tokens_with_all_removed_list = [valid_configs_for_tokens[k]['total_api_tokens_with_all_removed'] for k in valid_config_names]
    valid_avg_api_tokens_with_all_removed_per_run_list = [valid_configs_for_tokens[k]['avg_api_tokens_with_all_removed'] for k in valid_config_names]
    valid_tool_tokens_list = [valid_configs_for_tokens[k]['total_tool_content_tokens'] for k in valid_config_names]
    valid_avg_tokens_per_call_list = [valid_configs_for_tokens[k]['avg_tokens_per_tool_call'] for k in valid_config_names]
    # Tool calls related statistics
    valid_tool_calls_list = [valid_configs_for_tokens[k]['total_tool_calls'] for k in valid_config_names]
    valid_avg_tool_calls_per_run_list = [valid_configs_for_tokens[k]['avg_tool_calls'] for k in valid_config_names]
    valid_avg_tool_content_tokens_per_run_list = [valid_configs_for_tokens[k]['avg_tool_content_tokens'] for k in valid_config_names]
else:
    valid_config_names = []
    valid_api_tokens_list = []
    valid_avg_api_tokens_per_run_list = []
    valid_api_cost_list = []
    valid_avg_api_cost_per_run_list = []
    valid_api_tokens_with_all_removed_list = []
    valid_avg_api_tokens_with_all_removed_per_run_list = []
    valid_tool_tokens_list = []
    valid_avg_tokens_per_call_list = []
    valid_tool_calls_list = []
    valid_avg_tool_calls_per_run_list = []
    valid_avg_tool_content_tokens_per_run_list = []

print(f"Total Configs: {len(all_configs_stats)}")
print(f"Total Runs: {total_runs}")
print(f"Total Successes: {total_success}")
print(f"Total Failures: {total_error}")
print(f"Overall Success Rate: {total_success / total_runs * 100:.2f}%")
print(f"Runs with Error Actions: {total_error_action_runs} (token statistics excluded for these runs)")
print(f"Valid Runs for Token Statistics: {total_valid_runs_for_tokens}")
print(f"Configs Excluded (all runs have errors): {num_excluded_configs}")
if num_excluded_configs > 0:
    print(f"  Excluded Configs: {', '.join(sorted(excluded_configs_for_tokens.keys(), key=lambda x: (int(x.split('_')[1]) if x.startswith('config_') and x.split('_')[1].isdigit() else float('inf'), x)))}")
print(f"Valid Configs for Token Statistics: {len(valid_configs_for_tokens)}")
print(f"Total Context Length Errors: {total_context_length_errors} ({total_context_length_errors / total_runs * 100:.2f}%)")
print(f"Total Improper Endings: {total_improper_endings} ({total_improper_endings / total_runs * 100:.2f}%)")
print(f"Total Reset Events: {total_reset_events} (avg per run: {total_reset_events / total_runs:.2f})")
print(f"Total Summary Events: {total_summary_events} (avg per run: {total_summary_events / total_runs:.2f})")
print(f"Total Trim Events: {total_trim_events} (avg per run: {total_trim_events / total_runs:.2f})")
print(f"Total Thinking Reset Events: {total_thinking_reset_events} (avg per run: {total_thinking_reset_events / total_runs:.2f})")

print(f"\n{'='*50}")
print(f"--- Task Metrics Statistics ---")
print(f"{'='*50}")
print(f"Average Accuracy (all configs): {np.mean(avg_accuracy_list):.4f}")
print(f"Accuracy Median: {np.median(avg_accuracy_list):.4f}")
print(f"Accuracy Max: {max(avg_accuracy_list):.4f} ({config_dirs[avg_accuracy_list.index(max(avg_accuracy_list))]})")
print(f"Accuracy Min: {min(avg_accuracy_list):.4f} ({config_dirs[avg_accuracy_list.index(min(avg_accuracy_list))]})")
print(f"Accuracy Std Dev: {np.std(avg_accuracy_list):.4f}")
print(f"\nAverage Steps (all configs): {np.mean(avg_steps_list):.2f}")
print(f"Steps Median: {np.median(avg_steps_list):.2f}")
print(f"Steps Max: {max(avg_steps_list):.2f} ({config_dirs[avg_steps_list.index(max(avg_steps_list))]})")
print(f"Steps Min: {min(avg_steps_list):.2f} ({config_dirs[avg_steps_list.index(min(avg_steps_list))]})")
print(f"Steps Std Dev: {np.std(avg_steps_list):.2f}")

print(f"\n{'='*50}")
print(f"--- API Usage Statistics ---")
print(f"{'='*50}")
print(f"Total API Cost (all runs): ${total_api_cost:.6f}")
print(f"Average API Cost per Config (all runs combined): ${np.mean(api_cost_list):.6f}")
print(f"Average API Cost per Run: ${np.mean(avg_api_cost_per_run_list):.6f}")
print(f"API Cost Median per Config: ${np.median(api_cost_list):.6f}")
print(f"API Cost Max per Config: ${max(api_cost_list):.6f} ({config_dirs[api_cost_list.index(max(api_cost_list))]})")
print(f"API Cost Min per Config: ${min(api_cost_list):.6f} ({config_dirs[api_cost_list.index(min(api_cost_list))]})")
print(f"API Cost Std Dev per Config: ${np.std(api_cost_list):.6f}")
print(f"\nTotal API Tokens (all runs): {total_api_tokens:,}")
print(f"Total API Prompt Tokens: {total_api_prompt_tokens:,}")
print(f"Total API Completion Tokens: {total_api_completion_tokens:,}")
print(f"\nAverage API Tokens per Config (all runs combined): {np.mean(api_tokens_list):,.2f}")
print(f"Average API Tokens per Run: {np.mean(avg_api_tokens_per_run_list):,.2f}")
print(f"API Tokens Median per Config: {np.median(api_tokens_list):,.2f}")
print(f"API Tokens Max per Config: {max(api_tokens_list):,} ({config_dirs[api_tokens_list.index(max(api_tokens_list))]})")
print(f"API Tokens Min per Config: {min(api_tokens_list):,} ({config_dirs[api_tokens_list.index(min(api_tokens_list))]})")
print(f"API Tokens Std Dev per Config: {np.std(api_tokens_list):,.2f}")

print(f"\n--- Trimmed Tokens Statistics (tokens that were trimmed) ---")
print(f"Total Trimmed Tokens (all runs): {total_trimmed_tokens:,}")
print(f"Average Trimmed Tokens per Run: {np.mean(avg_trimmed_tokens_per_run_list):,.2f}")

print(f"\n--- Reset Tokens Statistics (tokens that were reset) ---")
print(f"Total Reset Tokens (all runs): {total_reset_tokens:,}")
print(f"Average Reset Tokens per Run: {np.mean(avg_reset_tokens_per_run_list):,.2f}")

print(f"\n--- Thinking Reset Tokens Statistics (tokens that were thinking_reset) ---")
print(f"Total Thinking Reset Tokens (all runs): {total_thinking_reset_tokens:,}")
print(f"Average Thinking Reset Tokens per Run: {np.mean(avg_thinking_reset_tokens_per_run_list):,.2f}")

print(f"\n--- Summary Tokens Statistics (tokens that were summarized) ---")
print(f"Total Summary Tokens (all runs): {total_summary_tokens:,}")
print(f"Average Summary Tokens per Run: {np.mean(avg_summary_tokens_per_run_list):,.2f}")

print(f"\n--- API Tokens (including trimmed) ---")
print(f"Total API Tokens (including trimmed, all runs): {total_api_tokens_with_trimmed:,}")
print(f"Average API Tokens per Run (including trimmed): {np.mean(avg_api_tokens_with_trimmed_per_run_list):,.2f}")
print(f"API Tokens (including trimmed) Median per Config: {np.median(api_tokens_with_trimmed_list):,.2f}")
if api_tokens_with_trimmed_list:
    print(f"API Tokens (including trimmed) Max per Config: {max(api_tokens_with_trimmed_list):,} ({config_dirs[api_tokens_with_trimmed_list.index(max(api_tokens_with_trimmed_list))]})")
    print(f"API Tokens (including trimmed) Min per Config: {min(api_tokens_with_trimmed_list):,} ({config_dirs[api_tokens_with_trimmed_list.index(min(api_tokens_with_trimmed_list))]})")
print(f"API Tokens (including trimmed) Std Dev per Config: {np.std(api_tokens_with_trimmed_list):,.2f}")

print(f"\n--- API Tokens (including trimmed and reset) ---")
print(f"Total API Tokens (including trimmed+reset, all runs): {total_api_tokens_with_trimmed_and_reset:,}")
print(f"Average API Tokens per Run (including trimmed+reset): {np.mean(avg_api_tokens_with_trimmed_and_reset_per_run_list):,.2f}")
print(f"API Tokens (including trimmed+reset) Median per Config: {np.median(api_tokens_with_trimmed_and_reset_list):,.2f}")
if api_tokens_with_trimmed_and_reset_list:
    print(f"API Tokens (including trimmed+reset) Max per Config: {max(api_tokens_with_trimmed_and_reset_list):,} ({config_dirs[api_tokens_with_trimmed_and_reset_list.index(max(api_tokens_with_trimmed_and_reset_list))]})")
    print(f"API Tokens (including trimmed+reset) Min per Config: {min(api_tokens_with_trimmed_and_reset_list):,} ({config_dirs[api_tokens_with_trimmed_and_reset_list.index(min(api_tokens_with_trimmed_and_reset_list))]})")
print(f"API Tokens (including trimmed+reset) Std Dev per Config: {np.std(api_tokens_with_trimmed_and_reset_list):,.2f}")

print(f"\n--- API Tokens (including trimmed, reset and thinking_reset) ---")
print(f"Total API Tokens (including trimmed+reset+thinking_reset, all runs): {total_api_tokens_with_all_removed:,}")
print(f"Average API Tokens per Run (including trimmed+reset+thinking_reset): {np.mean(avg_api_tokens_with_all_removed_per_run_list):,.2f}")
print(f"API Tokens (including all_removed) Median per Config: {np.median(api_tokens_with_all_removed_list):,.2f}")
if api_tokens_with_all_removed_list:
    print(f"API Tokens (including all_removed) Max per Config: {max(api_tokens_with_all_removed_list):,} ({config_dirs[api_tokens_with_all_removed_list.index(max(api_tokens_with_all_removed_list))]})")
    print(f"API Tokens (including all_removed) Min per Config: {min(api_tokens_with_all_removed_list):,} ({config_dirs[api_tokens_with_all_removed_list.index(min(api_tokens_with_all_removed_list))]})")
print(f"API Tokens (including all_removed) Std Dev per Config: {np.std(api_tokens_with_all_removed_list):,.2f}")

# Token statistics for valid configs only (excluding configs where all runs have errors)
print(f"\n{'='*50}")
print(f"--- Token Statistics for Valid Configs Only (excluding {num_excluded_configs} all-error configs) ---")
print(f"{'='*50}")
if valid_configs_for_tokens:
    print(f"Valid Config Count: {len(valid_configs_for_tokens)}")
    print(f"Valid Configs Total API Tokens: {sum(valid_api_tokens_list):,}")
    print(f"Valid Configs Average API Tokens per Config: {np.mean(valid_api_tokens_list):,.2f}")
    print(f"Valid Configs Average API Tokens per Run: {np.mean(valid_avg_api_tokens_per_run_list):,.2f}")
    print(f"Valid Configs API Tokens Median: {np.median(valid_api_tokens_list):,.2f}")
    print(f"Valid Configs API Tokens Std Dev: {np.std(valid_api_tokens_list):,.2f}")
    print(f"\nValid Configs Total API Cost: ${sum(valid_api_cost_list):.6f}")
    print(f"Valid Configs Average API Cost per Config: ${np.mean(valid_api_cost_list):.6f}")
    print(f"Valid Configs Average API Cost per Run: ${np.mean(valid_avg_api_cost_per_run_list):.6f}")
    print(f"\nValid Configs API Tokens (including all_removed) Total: {sum(valid_api_tokens_with_all_removed_list):,}")
    print(f"Valid Configs Average API Tokens (including all_removed) per Config: {np.mean(valid_api_tokens_with_all_removed_list):,.2f}")
    print(f"Valid Configs Average API Tokens (including all_removed) per Run: {np.mean(valid_avg_api_tokens_with_all_removed_per_run_list):,.2f}")

    # Tool calls related statistics
    print(f"\n--- Valid Configs Tool Calls Statistics ---")
    print(f"Valid Configs Total Tool Calls: {sum(valid_tool_calls_list):,}")
    print(f"Valid Configs Average Tool Calls per Config: {np.mean(valid_tool_calls_list):,.2f}")
    print(f"Valid Configs Average Tool Calls per Run: {np.mean(valid_avg_tool_calls_per_run_list):,.2f}")

    # Tool content tokens related statistics
    print(f"\n--- Valid Configs Tool Content Tokens Statistics ---")
    print(f"Valid Configs Total Tool Content Tokens: {sum(valid_tool_tokens_list):,}")
    print(f"Valid Configs Average Tool Content Tokens per Config: {np.mean(valid_tool_tokens_list):,.2f}")
    print(f"Valid Configs Average Tool Content Tokens per Run: {np.mean(valid_avg_tool_content_tokens_per_run_list):,.2f}")
    if sum(valid_tool_calls_list) > 0:
        print(f"Valid Configs Average Tokens per Tool Call: {sum(valid_tool_tokens_list) / sum(valid_tool_calls_list):,.2f}")
else:
    print(f"Warning: No valid configs for token statistics (all runs in all configs have errors)")

print(f"\n{'='*50}")
print(f"--- Tool Content Statistics ---")
print(f"{'='*50}")
print(f"Total Tool Calls (all runs): {total_tool_calls:,}")
print(f"Total Tool Content Tokens (all runs): {total_tool_tokens:,}")
if total_tool_calls > 0:
    print(f"Global Average Tokens per Tool Call: {total_tool_tokens / total_tool_calls:.2f}")
else:
    print(f"Global Average Tokens per Tool Call: N/A (no tool calls)")
print(f"\nAverage Tool Tokens per Config (all runs combined): {np.mean(tool_tokens_list):,.2f}")
print(f"Tool Tokens Median: {np.median(tool_tokens_list):,.2f}")
print(f"Tool Tokens Max: {max(tool_tokens_list):,} ({config_dirs[tool_tokens_list.index(max(tool_tokens_list))]})")
print(f"Tool Tokens Min: {min(tool_tokens_list):,} ({config_dirs[tool_tokens_list.index(min(tool_tokens_list))]})")
print(f"Tool Tokens Std Dev: {np.std(tool_tokens_list):,.2f}")
print(f"\n--- Average Tokens per Tool Call Statistics ---")
print(f"Average Tokens per Tool Call across Configs - Mean: {np.mean(avg_tokens_per_call_list):,.2f}")
print(f"Average Tokens per Tool Call across Configs - Median: {np.median(avg_tokens_per_call_list):,.2f}")
print(f"Average Tokens per Tool Call across Configs - Max: {max(avg_tokens_per_call_list):,.2f} ({config_dirs[avg_tokens_per_call_list.index(max(avg_tokens_per_call_list))]})")
print(f"Average Tokens per Tool Call across Configs - Min: {min(avg_tokens_per_call_list):,.2f} ({config_dirs[avg_tokens_per_call_list.index(min(avg_tokens_per_call_list))]})")
print(f"Average Tokens per Tool Call across Configs - Std Dev: {np.std(avg_tokens_per_call_list):,.2f}")

print(f"\n--- All Content Statistics ---")
print(f"Total All Content Tokens (all runs): {total_all_tokens:,}")
print(f"\nAverage Total Tokens per Config (all runs combined): {np.mean(all_tokens_list):,.2f}")
print(f"Total Tokens Median: {np.median(all_tokens_list):,.2f}")
print(f"Total Tokens Max: {max(all_tokens_list):,} ({config_dirs[all_tokens_list.index(max(all_tokens_list))]})")
print(f"Total Tokens Min: {min(all_tokens_list):,} ({config_dirs[all_tokens_list.index(min(all_tokens_list))]})")
print(f"Total Tokens Std Dev: {np.std(all_tokens_list):,.2f}")

# Display sorted by Reset count
print(f"\n{'='*80}")
print(f"--- Configs Sorted by Reset Count ---")
print(f"{'='*80}")
sorted_configs_reset = sorted(all_configs_stats.items(), key=lambda x: x[1]['total_reset_count'], reverse=True)
for i, (config_name, stats) in enumerate(sorted_configs_reset, 1):
    print(f"{i:2d}. {config_name:12s}: Reset: {stats['total_reset_count']:3d} times (avg {stats['avg_reset_count']:.2f}/run) | Summary: {stats['total_summary_count']:3d} times (avg {stats['avg_summary_count']:.2f}/run) | Trim: {stats['total_trim_count']:3d} times (avg {stats['avg_trim_count']:.2f}/run) | Thinking Reset: {stats['total_thinking_reset_count']:3d} times (avg {stats['avg_thinking_reset_count']:.2f}/run) | Accuracy: {stats['avg_accuracy']:.4f}")

# Display sorted by Summary count
print(f"\n{'='*80}")
print(f"--- Configs Sorted by Summary Count ---")
print(f"{'='*80}")
sorted_configs_summary = sorted(all_configs_stats.items(), key=lambda x: x[1]['total_summary_count'], reverse=True)
for i, (config_name, stats) in enumerate(sorted_configs_summary, 1):
    print(f"{i:2d}. {config_name:12s}: Summary: {stats['total_summary_count']:3d} times (avg {stats['avg_summary_count']:.2f}/run) | Reset: {stats['total_reset_count']:3d} times (avg {stats['avg_reset_count']:.2f}/run) | Trim: {stats['total_trim_count']:3d} times (avg {stats['avg_trim_count']:.2f}/run) | Thinking Reset: {stats['total_thinking_reset_count']:3d} times (avg {stats['avg_thinking_reset_count']:.2f}/run) | Accuracy: {stats['avg_accuracy']:.4f}")

# Display sorted by Trim count
print(f"\n{'='*80}")
print(f"--- Configs Sorted by Trim Count ---")
print(f"{'='*80}")
sorted_configs_trim = sorted(all_configs_stats.items(), key=lambda x: x[1]['total_trim_count'], reverse=True)
for i, (config_name, stats) in enumerate(sorted_configs_trim, 1):
    print(f"{i:2d}. {config_name:12s}: Trim: {stats['total_trim_count']:3d} times (avg {stats['avg_trim_count']:.2f}/run) | Reset: {stats['total_reset_count']:3d} times (avg {stats['avg_reset_count']:.2f}/run) | Summary: {stats['total_summary_count']:3d} times (avg {stats['avg_summary_count']:.2f}/run) | Thinking Reset: {stats['total_thinking_reset_count']:3d} times (avg {stats['avg_thinking_reset_count']:.2f}/run) | Accuracy: {stats['avg_accuracy']:.4f}")

# Display sorted by Thinking Reset count
print(f"\n{'='*80}")
print(f"--- Configs Sorted by Thinking Reset Count ---")
print(f"{'='*80}")
sorted_configs_thinking_reset = sorted(all_configs_stats.items(), key=lambda x: x[1]['total_thinking_reset_count'], reverse=True)
for i, (config_name, stats) in enumerate(sorted_configs_thinking_reset, 1):
    print(f"{i:2d}. {config_name:12s}: Thinking Reset: {stats['total_thinking_reset_count']:3d} times (avg {stats['avg_thinking_reset_count']:.2f}/run) | Reset: {stats['total_reset_count']:3d} times (avg {stats['avg_reset_count']:.2f}/run) | Summary: {stats['total_summary_count']:3d} times (avg {stats['avg_summary_count']:.2f}/run) | Trim: {stats['total_trim_count']:3d} times (avg {stats['avg_trim_count']:.2f}/run) | Accuracy: {stats['avg_accuracy']:.4f}")

# Display sorted by Improper Ending Rate
print(f"\n{'='*80}")
print(f"--- Configs Sorted by Improper Ending Rate ---")
print(f"{'='*80}")
sorted_configs_improper = sorted(all_configs_stats.items(), key=lambda x: x[1]['improper_ending_rate'], reverse=True)
for i, (config_name, stats) in enumerate(sorted_configs_improper, 1):
    print(f"{i:2d}. {config_name:12s}: Improper Endings: {stats['improper_ending_runs']}/{stats['total_runs']} ({stats['improper_ending_rate']*100:.1f}%) | Accuracy: {stats['avg_accuracy']:.4f} | Avg Steps: {stats['avg_steps']:6.2f}")

# Display sorted by Context Length Error Rate
print(f"\n{'='*80}")
print(f"--- Configs Sorted by Context Length Error Rate ---")
print(f"{'='*80}")
sorted_configs_ctx_err = sorted(all_configs_stats.items(), key=lambda x: x[1]['context_length_error_rate'], reverse=True)
for i, (config_name, stats) in enumerate(sorted_configs_ctx_err, 1):
    print(f"{i:2d}. {config_name:12s}: Context Length Error: {stats['context_length_error_runs']}/{stats['total_runs']} ({stats['context_length_error_rate']*100:.1f}%) | Accuracy: {stats['avg_accuracy']:.4f} | Avg Steps: {stats['avg_steps']:6.2f}")

# Display sorted by accuracy
print(f"\n{'='*80}")
print(f"--- Configs Sorted by Average Accuracy ---")
print(f"{'='*80}")
sorted_configs_acc = sorted(all_configs_stats.items(), key=lambda x: x[1]['avg_accuracy'], reverse=True)
for i, (config_name, stats) in enumerate(sorted_configs_acc, 1):
    ctx_err_str = f"CtxErr: {stats['context_length_error_runs']}/{stats['total_runs']} ({stats['context_length_error_rate']*100:.1f}%)"
    improper_str = f"Improper Endings: {stats['improper_ending_runs']}/{stats['total_runs']} ({stats['improper_ending_rate']*100:.1f}%)"
    reset_summary_trim_str = f"Reset: {stats['total_reset_count']} times | Summary: {stats['total_summary_count']} times | Trim: {stats['total_trim_count']} times | Thinking Reset: {stats['total_thinking_reset_count']} times"
    print(f"{i:2d}. {config_name:12s}: Accuracy: {stats['avg_accuracy']:.4f} | Avg Steps: {stats['avg_steps']:6.2f} | Success/Total: {stats['success_runs']}/{stats['total_runs']} | {improper_str} | {ctx_err_str} | {reset_summary_trim_str} | API cost: ${stats['total_api_cost']:.6f}")

# Display sorted by API Total Cost
print(f"\n{'='*80}")
print(f"--- Configs Sorted by API Total Cost ---")
print(f"{'='*80}")
sorted_configs_cost = sorted(all_configs_stats.items(), key=lambda x: x[1]['total_api_cost'], reverse=True)
for i, (config_name, stats) in enumerate(sorted_configs_cost, 1):
    print(f"{i:2d}. {config_name:12s}: Total API cost: ${stats['total_api_cost']:9.6f} | Avg per run: ${stats['avg_api_cost']:9.6f} | API tokens: {stats['total_api_tokens']:8,} | Tool calls: {stats['total_tool_calls']:3d} times")

# Display sorted by API Total Tokens
print(f"\n{'='*80}")
print(f"--- Configs Sorted by API Total Tokens ---")
print(f"{'='*80}")
sorted_configs_api = sorted(all_configs_stats.items(), key=lambda x: x[1]['total_api_tokens'], reverse=True)
for i, (config_name, stats) in enumerate(sorted_configs_api, 1):
    print(f"{i:2d}. {config_name:12s}: Total API tokens: {stats['total_api_tokens']:8,} | Avg per run: {stats['avg_api_tokens']:8,.2f} | Prompt: {stats['total_api_prompt_tokens']:8,} | Completion: {stats['total_api_completion_tokens']:7,} | Tool calls: {stats['total_tool_calls']:3d} times")

# Display sorted by Tool Content Tokens
print(f"\n{'='*80}")
print(f"--- Configs Sorted by Tool Content Tokens ---")
print(f"{'='*80}")
sorted_configs = sorted(all_configs_stats.items(), key=lambda x: x[1]['total_tool_content_tokens'], reverse=True)
for i, (config_name, stats) in enumerate(sorted_configs, 1):
    print(f"{i:2d}. {config_name:12s}: Tool Content: {stats['total_tool_content_tokens']:8,} tokens (avg per call: {stats['avg_tokens_per_tool_call']:7.2f}) | Tool calls: {stats['total_tool_calls']:3d} times")

# Display sorted by average tokens per tool call
print(f"\n{'='*80}")
print(f"--- Configs Sorted by Average Tokens per Tool Call ---")
print(f"{'='*80}")
sorted_configs_avg = sorted(all_configs_stats.items(), key=lambda x: x[1]['avg_tokens_per_tool_call'], reverse=True)
for i, (config_name, stats) in enumerate(sorted_configs_avg, 1):
    print(f"{i:2d}. {config_name:12s}: Avg {stats['avg_tokens_per_tool_call']:7.2f} tokens/call | Total Tool Content tokens: {stats['total_tool_content_tokens']:8,} | Tool calls: {stats['total_tool_calls']:3d} times")

print("\n" + "=" * 100)

# Save results to file
import datetime
output_filename = f"analysis_results_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
output_path = os.path.join(output_dir, output_filename)

# Prepare data to save (remove large content from runs details, keep only key metrics)
save_data = {
    "analysis_time": datetime.datetime.now().isoformat(),
    "base_directory": base_dir,
    "grouping_info": {
        "group_by_seed": group_by_seed,
        "config_groups": {str(k): v for k, v in config_groups.items()} if config_groups else None,
        "num_groups": len(config_groups) if config_groups else len(all_configs_stats)
    },
    "summary": {
        "total_configs": len(all_configs_stats),
        "total_runs": total_runs,
        "total_success": total_success,
        "total_error": total_error,
        "total_error_action_runs": sum(s.get('error_action_runs', 0) for s in all_configs_stats.values()),  # Number of runs containing error action
        "total_valid_runs_for_tokens": sum(s.get('valid_runs_for_tokens', s['total_runs']) for s in all_configs_stats.values()),  # Number of valid runs for token statistics
        "success_rate": total_success / total_runs if total_runs > 0 else 0,
        "total_context_length_errors": total_context_length_errors,
        "context_length_error_rate": total_context_length_errors / total_runs if total_runs > 0 else 0,
        "total_improper_endings": total_improper_endings,
        "improper_ending_rate": total_improper_endings / total_runs if total_runs > 0 else 0,
        "total_reset_events": total_reset_events,
        "total_summary_events": total_summary_events,
        "total_trim_events": total_trim_events,
        "total_thinking_reset_events": total_thinking_reset_events,
        "avg_reset_per_run": total_reset_events / total_runs if total_runs > 0 else 0,
        "avg_summary_per_run": total_summary_events / total_runs if total_runs > 0 else 0,
        "avg_trim_per_run": total_trim_events / total_runs if total_runs > 0 else 0,
        "avg_thinking_reset_per_run": total_thinking_reset_events / total_runs if total_runs > 0 else 0,
        
        # Task metrics
        "avg_accuracy": float(np.mean(avg_accuracy_list)),
        "median_accuracy": float(np.median(avg_accuracy_list)),
        "avg_steps": float(np.mean(avg_steps_list)),
        "median_steps": float(np.median(avg_steps_list)),
        
        # API tokens
        "total_api_tokens": total_api_tokens,
        "total_api_prompt_tokens": total_api_prompt_tokens,
        "total_api_completion_tokens": total_api_completion_tokens,
        "avg_api_tokens_per_config": float(np.mean(api_tokens_list)),
        "avg_api_tokens_per_run": float(np.mean(avg_api_tokens_per_run_list)),
        
        # API cost
        "total_api_cost": float(total_api_cost),
        "avg_api_cost_per_config": float(np.mean(api_cost_list)),
        "avg_api_cost_per_run": float(np.mean(avg_api_cost_per_run_list)),
        
        # Tool content
        "total_tool_calls": total_tool_calls,
        "total_tool_content_tokens": total_tool_tokens,
        "avg_tokens_per_tool_call": total_tool_tokens / total_tool_calls if total_tool_calls > 0 else 0,
        "total_all_content_tokens": total_all_tokens,
        
        # Trimmed tokens
        "total_trimmed_tokens": total_trimmed_tokens,
        "avg_trimmed_tokens_per_run": float(np.mean(avg_trimmed_tokens_per_run_list)),
        "total_api_tokens_with_trimmed": total_api_tokens_with_trimmed,
        "avg_api_tokens_with_trimmed_per_run": float(np.mean(avg_api_tokens_with_trimmed_per_run_list)),
        
        # Reset tokens
        "total_reset_tokens": total_reset_tokens,
        "avg_reset_tokens_per_run": float(np.mean(avg_reset_tokens_per_run_list)),
        "total_api_tokens_with_trimmed_and_reset": total_api_tokens_with_trimmed_and_reset,
        "avg_api_tokens_with_trimmed_and_reset_per_run": float(np.mean(avg_api_tokens_with_trimmed_and_reset_per_run_list)),
        
        # Thinking reset tokens
        "total_thinking_reset_tokens": total_thinking_reset_tokens,
        "avg_thinking_reset_tokens_per_run": float(np.mean(avg_thinking_reset_tokens_per_run_list)),
        
        # Summary tokens
        "total_summary_tokens": total_summary_tokens,
        "avg_summary_tokens_per_run": float(np.mean(avg_summary_tokens_per_run_list)),
        
        "total_api_tokens_with_all_removed": total_api_tokens_with_all_removed,
        "avg_api_tokens_with_all_removed_per_run": float(np.mean(avg_api_tokens_with_all_removed_per_run_list)),
        
        # Statistics for valid configs only (excluding configs where all runs have errors)
        "num_excluded_configs_for_tokens": num_excluded_configs,
        "excluded_configs_for_tokens": list(excluded_configs_for_tokens.keys()) if excluded_configs_for_tokens else [],
        "num_valid_configs_for_tokens": len(valid_configs_for_tokens),
        "valid_configs_total_api_tokens": sum(valid_api_tokens_list) if valid_api_tokens_list else 0,
        "valid_configs_avg_api_tokens_per_config": float(np.mean(valid_api_tokens_list)) if valid_api_tokens_list else 0,
        "valid_configs_avg_api_tokens_per_run": float(np.mean(valid_avg_api_tokens_per_run_list)) if valid_avg_api_tokens_per_run_list else 0,
        "valid_configs_total_api_cost": sum(valid_api_cost_list) if valid_api_cost_list else 0,
        "valid_configs_avg_api_cost_per_config": float(np.mean(valid_api_cost_list)) if valid_api_cost_list else 0,
        "valid_configs_avg_api_cost_per_run": float(np.mean(valid_avg_api_cost_per_run_list)) if valid_avg_api_cost_per_run_list else 0,
        "valid_configs_total_api_tokens_with_all_removed": sum(valid_api_tokens_with_all_removed_list) if valid_api_tokens_with_all_removed_list else 0,
        "valid_configs_avg_api_tokens_with_all_removed_per_config": float(np.mean(valid_api_tokens_with_all_removed_list)) if valid_api_tokens_with_all_removed_list else 0,
        "valid_configs_avg_api_tokens_with_all_removed_per_run": float(np.mean(valid_avg_api_tokens_with_all_removed_per_run_list)) if valid_avg_api_tokens_with_all_removed_per_run_list else 0,
        
        # Valid configs Tool Calls statistics
        "valid_configs_total_tool_calls": sum(valid_tool_calls_list) if valid_tool_calls_list else 0,
        "valid_configs_avg_tool_calls_per_config": float(np.mean(valid_tool_calls_list)) if valid_tool_calls_list else 0,
        "valid_configs_avg_tool_calls_per_run": float(np.mean(valid_avg_tool_calls_per_run_list)) if valid_avg_tool_calls_per_run_list else 0,
        
        # Valid configs Tool Content Tokens statistics
        "valid_configs_total_tool_content_tokens": sum(valid_tool_tokens_list) if valid_tool_tokens_list else 0,
        "valid_configs_avg_tool_content_tokens_per_config": float(np.mean(valid_tool_tokens_list)) if valid_tool_tokens_list else 0,
        "valid_configs_avg_tool_content_tokens_per_run": float(np.mean(valid_avg_tool_content_tokens_per_run_list)) if valid_avg_tool_content_tokens_per_run_list else 0,
        "valid_configs_avg_tokens_per_tool_call": sum(valid_tool_tokens_list) / sum(valid_tool_calls_list) if valid_tool_calls_list and sum(valid_tool_calls_list) > 0 else 0,
    },
    "configs": {}
}

# Add summary data for each config (including detailed information for each run)
for config_name, stats in all_configs_stats.items():
    # Extract key metrics for each run
    runs_detail = []
    for idx, run in enumerate(stats['runs']):
        run_info = {
            "run_index": idx,
            "accuracy": run['accuracy'],
            "total_steps": run['total_steps'],
            "completed": run['completed'],
            "has_context_length_error": run.get('has_context_length_error', False),
            "proper_ending": run.get('proper_ending', False),
            "has_error": run.get('has_error', False),  # Whether contains error action (used to exclude from token statistics)
            "reset_count": run.get('reset_count', 0),
            "summary_count": run.get('summary_count', 0),
            "trim_count": run.get('trim_count', 0),
            "thinking_reset_count": run.get('thinking_reset_count', 0),
            "total_messages": run['total_messages'],
            "tool_calls": run['tool_calls'],
            "user_messages": run['user_messages'],
            "assistant_messages": run['assistant_messages'],
            "tool_content_tokens": run['tool_content_tokens'],
            "all_content_tokens": run['all_content_tokens'],
            "api_total_tokens": run['api_total_tokens'],
            "api_prompt_tokens": run['api_prompt_tokens'],
            "api_completion_tokens": run['api_completion_tokens'],
            "api_total_cost": run['api_total_cost'],
            "trimmed_tokens_total": run.get('trimmed_tokens_total', 0),  # Total trimmed tokens
            "reset_tokens_total": run.get('reset_tokens_total', 0),  # Total reset tokens
            "thinking_reset_tokens_total": run.get('thinking_reset_tokens_total', 0),  # Total thinking_reset tokens
            "summary_tokens_total": run.get('summary_tokens_total', 0),  # Total summary tokens
            "api_total_tokens_with_trimmed": run['api_total_tokens'] + run.get('trimmed_tokens_total', 0),  # Including trimmed tokens
            "api_total_tokens_with_trimmed_and_reset": run['api_total_tokens'] + run.get('trimmed_tokens_total', 0) + run.get('reset_tokens_total', 0),  # Including trimmed and reset tokens
            "api_total_tokens_with_all_removed": run['api_total_tokens'] + run.get('trimmed_tokens_total', 0) + run.get('reset_tokens_total', 0) + run.get('thinking_reset_tokens_total', 0) + run.get('summary_tokens_total', 0),  # Including all removed tokens
            "tokens_before_each_assistant": run.get('tokens_before_each_assistant', []),  # Cumulative tokens before each assistant response
        }
        runs_detail.append(run_info)
    
    save_data["configs"][config_name] = {
        "total_runs": stats['total_runs'],
        "success_runs": stats['success_runs'],
        "error_runs": stats['error_runs'],
        "error_action_runs": stats.get('error_action_runs', 0),  # Number of runs containing error action
        "valid_runs_for_tokens": stats.get('valid_runs_for_tokens', stats['total_runs']),  # Number of valid runs for token statistics
        "context_length_error_runs": stats['context_length_error_runs'],
        "context_length_error_rate": stats['context_length_error_rate'],
        "improper_ending_runs": stats['improper_ending_runs'],
        "improper_ending_rate": stats['improper_ending_rate'],
        "total_reset_count": stats['total_reset_count'],
        "total_summary_count": stats['total_summary_count'],
        "total_trim_count": stats['total_trim_count'],
        "total_thinking_reset_count": stats['total_thinking_reset_count'],
        "avg_reset_count": stats['avg_reset_count'],
        "avg_summary_count": stats['avg_summary_count'],
        "avg_trim_count": stats['avg_trim_count'],
        "avg_thinking_reset_count": stats['avg_thinking_reset_count'],
        "avg_accuracy": stats['avg_accuracy'],
        "avg_steps": stats['avg_steps'],
        "accuracies": stats['accuracies'],
        "steps": stats['steps'],
        "total_tool_calls": stats['total_tool_calls'],
        "total_tool_content_tokens": stats['total_tool_content_tokens'],
        "total_all_content_tokens": stats['total_all_content_tokens'],
        "total_api_tokens": stats['total_api_tokens'],
        "total_api_prompt_tokens": stats['total_api_prompt_tokens'],
        "total_api_completion_tokens": stats['total_api_completion_tokens'],
        "total_api_cost": stats['total_api_cost'],
        "avg_tool_calls": stats['avg_tool_calls'],
        "avg_tool_content_tokens": stats['avg_tool_content_tokens'],
        "avg_all_content_tokens": stats['avg_all_content_tokens'],
        "avg_api_tokens": stats['avg_api_tokens'],
        "avg_api_prompt_tokens": stats['avg_api_prompt_tokens'],
        "avg_api_completion_tokens": stats['avg_api_completion_tokens'],
        "avg_api_cost": stats['avg_api_cost'],
        "avg_tokens_per_tool_call": stats['avg_tokens_per_tool_call'],
        "total_trimmed_tokens": stats['total_trimmed_tokens'],
        "avg_trimmed_tokens": stats['avg_trimmed_tokens'],
        "total_reset_tokens": stats['total_reset_tokens'],
        "avg_reset_tokens": stats['avg_reset_tokens'],
        "total_thinking_reset_tokens": stats['total_thinking_reset_tokens'],
        "avg_thinking_reset_tokens": stats['avg_thinking_reset_tokens'],
        "total_summary_tokens": stats['total_summary_tokens'],
        "avg_summary_tokens": stats['avg_summary_tokens'],
        "total_api_tokens_with_trimmed": stats['total_api_tokens_with_trimmed'],
        "avg_api_tokens_with_trimmed": stats['avg_api_tokens_with_trimmed'],
        "total_api_tokens_with_trimmed_and_reset": stats['total_api_tokens_with_trimmed_and_reset'],
        "avg_api_tokens_with_trimmed_and_reset": stats['avg_api_tokens_with_trimmed_and_reset'],
        "total_api_tokens_with_all_removed": stats['total_api_tokens_with_all_removed'],
        "avg_api_tokens_with_all_removed": stats['avg_api_tokens_with_all_removed'],
        "runs": runs_detail  # Add detailed metrics for each run
    }

# Save to file
with open(output_path, 'w', encoding='utf-8') as f:
    json.dump(save_data, f, indent=2, ensure_ascii=False)

print(f"\nAnalysis results saved to: {output_path}")

# Save CSV file
csv_filename = f"analysis_summary_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
csv_path = os.path.join(output_dir, csv_filename)

# Sort by config number
sorted_config_names = sorted(all_configs_stats.keys(), key=lambda x: (int(x.split('_')[1]) if x.startswith('config_') and x.split('_')[1].isdigit() else float('inf'), x))

# Prepare CSV data
csv_data = []
metrics = [
    ('avg_accuracy', 'Average Accuracy'),
    ('avg_steps', 'Average Steps'),
    ('improper_ending_rate', 'Improper Ending Rate'),
    ('improper_ending_runs', 'Improper Ending Count'),
    ('context_length_error_rate', 'Context Length Error Rate'),
    ('context_length_error_runs', 'Context Length Error Count'),
    ('total_reset_count', 'Total Reset Count'),
    ('avg_reset_count', 'Average Reset Count'),
    ('total_summary_count', 'Total Summary Count'),
    ('avg_summary_count', 'Average Summary Count'),
    ('total_trim_count', 'Total Trim Count'),
    ('avg_trim_count', 'Average Trim Count'),
    ('total_thinking_reset_count', 'Total Thinking Reset Count'),
    ('avg_thinking_reset_count', 'Average Thinking Reset Count'),
    ('avg_tool_calls', 'Average Tool Calls'),
    ('total_tool_content_tokens', 'Total Tool Content Tokens'),
    ('avg_tool_content_tokens', 'Average Tool Content Tokens'),
    ('total_all_content_tokens', 'Total All Content Tokens'),
    ('avg_all_content_tokens', 'Average All Content Tokens'),
    ('total_api_tokens', 'Total API Tokens'),
    ('avg_api_tokens', 'Average API Tokens'),
    ('total_api_cost', 'Total API Cost ($)'),
    ('avg_api_cost', 'Average API Cost ($)'),
    ('total_trimmed_tokens', 'Total Trimmed Tokens'),
    ('avg_trimmed_tokens', 'Average Trimmed Tokens'),
    ('total_reset_tokens', 'Total Reset Tokens'),
    ('avg_reset_tokens', 'Average Reset Tokens'),
    ('total_thinking_reset_tokens', 'Total Thinking Reset Tokens'),
    ('avg_thinking_reset_tokens', 'Average Thinking Reset Tokens'),
    ('total_summary_tokens', 'Total Summary Tokens'),
    ('avg_summary_tokens', 'Average Summary Tokens'),
    ('total_api_tokens_with_trimmed', 'Total API Tokens (incl. Trimmed)'),
    ('avg_api_tokens_with_trimmed', 'Average API Tokens (incl. Trimmed)'),
    ('total_api_tokens_with_trimmed_and_reset', 'Total API Tokens (incl. Trimmed+Reset)'),
    ('avg_api_tokens_with_trimmed_and_reset', 'Average API Tokens (incl. Trimmed+Reset)'),
    ('total_api_tokens_with_all_removed', 'Total API Tokens (incl. All Removed)'),
    ('avg_api_tokens_with_all_removed', 'Average API Tokens (incl. All Removed)')
]

# Write CSV
with open(csv_path, 'w', newline='', encoding='utf-8') as f:
    writer = csv.writer(f)

    # If grouping information exists, write grouping explanation
    if group_by_seed and config_groups:
        writer.writerow(['# Grouping Mode: Enabled'])
        writer.writerow(['# Config Groups:'])
        for group_id, member_configs in sorted(config_groups.items()):
            config_names = [f"config_{c}" for c in member_configs]
            writer.writerow([f"# Group {group_id}:", ', '.join(config_names)])
        writer.writerow([])  # Empty line separator
    else:
        writer.writerow(['# Grouping Mode: Disabled'])
        writer.writerow([])  # Empty line separator

    # Write header
    header = ['Metric'] + sorted_config_names
    writer.writerow(header)

    # Write row for each metric
    for metric_key, metric_name in metrics:
        row = [metric_name]
        for config_name in sorted_config_names:
            value = all_configs_stats[config_name][metric_key]
            # Format values based on metric type
            if metric_key == 'avg_accuracy':
                row.append(f"{value:.4f}")
            elif metric_key == 'avg_steps':
                row.append(f"{value:.2f}")
            elif metric_key == 'improper_ending_rate':
                row.append(f"{value:.4f}")
            elif metric_key == 'improper_ending_runs':
                row.append(f"{int(value)}")
            elif metric_key == 'context_length_error_rate':
                row.append(f"{value:.4f}")
            elif metric_key == 'context_length_error_runs':
                row.append(f"{int(value)}")
            elif metric_key in ['total_reset_count', 'total_summary_count', 'total_trim_count', 'total_thinking_reset_count']:
                row.append(f"{int(value)}")
            elif metric_key in ['avg_reset_count', 'avg_summary_count', 'avg_trim_count', 'avg_thinking_reset_count']:
                row.append(f"{value:.2f}")
            elif metric_key in ['total_tool_content_tokens', 'total_all_content_tokens', 'total_api_tokens', 'total_trimmed_tokens', 'total_reset_tokens', 'total_thinking_reset_tokens', 'total_summary_tokens', 'total_api_tokens_with_trimmed', 'total_api_tokens_with_trimmed_and_reset', 'total_api_tokens_with_all_removed']:
                row.append(f"{int(value)}")  # Total tokens displayed as integer
            elif metric_key in ['avg_tool_content_tokens', 'avg_all_content_tokens', 'avg_api_tokens', 'avg_trimmed_tokens', 'avg_reset_tokens', 'avg_thinking_reset_tokens', 'avg_summary_tokens', 'avg_api_tokens_with_trimmed', 'avg_api_tokens_with_trimmed_and_reset', 'avg_api_tokens_with_all_removed']:
                row.append(f"{value:.2f}")  # Average tokens keep 2 decimal places
            elif metric_key in ['avg_api_cost', 'total_api_cost']:
                row.append(f"{value:.8f}")  # Cost keeps more decimal places
            else:
                row.append(f"{value:.2f}")
        writer.writerow(row)

print(f"CSV summary file saved to: {csv_path}")

# Save tokens progression CSV file
tokens_progression_filename = f"tokens_progression_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
tokens_progression_path = os.path.join(output_dir, tokens_progression_filename)

with open(tokens_progression_path, 'w', newline='', encoding='utf-8') as f:
    writer = csv.writer(f)

    # Write header
    writer.writerow(['# Tokens Progression Before Each Assistant Response'])
    writer.writerow(['# This file shows the cumulative token count before each assistant message in each run'])
    writer.writerow([])

    # Write data for each config
    for config_name in sorted_config_names:
        stats = all_configs_stats[config_name]

        writer.writerow([f'### {config_name} ###'])
        writer.writerow(['Run Index', 'Assistant Index', 'Cumulative Tokens Before Assistant'])

        # Iterate through each run
        for run_idx, run in enumerate(stats['runs']):
            tokens_progression = run.get('tokens_before_each_assistant', [])

            if tokens_progression:
                for item in tokens_progression:
                    assistant_idx = item['assistant_index']
                    cumulative_tokens = item['cumulative_tokens']
                    writer.writerow([run_idx, assistant_idx, cumulative_tokens])
            else:
                # If no data, write a note
                writer.writerow([run_idx, 'N/A', 'No data'])

        writer.writerow([])  # Empty line separator between configs

print(f"Tokens progression file saved to: {tokens_progression_path}")
print("=" * 100)

