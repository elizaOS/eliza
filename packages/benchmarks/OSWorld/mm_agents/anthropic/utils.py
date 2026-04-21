"""
Utility functions for the Anthropic API.
"""
from typing import List, Union, cast
from enum import Enum
from anthropic import (
    Anthropic,
    AnthropicBedrock,
    AnthropicVertex,
    APIError,
    APIResponseValidationError,
    APIStatusError,
)
from anthropic.types.beta import (
    BetaCacheControlEphemeralParam,
    BetaContentBlockParam,
    BetaImageBlockParam,
    BetaMessage,
    BetaMessageParam,
    BetaTextBlock,
    BetaTextBlockParam,
    BetaToolResultBlockParam,
    BetaToolUseBlockParam,
)
from datetime import datetime

from .tools import ToolResult


COMPUTER_USE_BETA_FLAG = "computer-use-2025-01-24"
PROMPT_CACHING_BETA_FLAG = "prompt-caching-2024-07-31"


class APIProvider(Enum):
    ANTHROPIC = "anthropic"
    BEDROCK = "bedrock"
    VERTEX = "vertex"


PROVIDER_TO_DEFAULT_MODEL_NAME: dict[(APIProvider, str), str] = {
    (APIProvider.ANTHROPIC, "claude-3-5-sonnet-20241022"): "claude-3-5-sonnet-20241022",
    (APIProvider.BEDROCK, "claude-3-5-sonnet-20241022"): "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    (APIProvider.VERTEX, "claude-3-5-sonnet-20241022"): "claude-3-5-sonnet-v1@20241022",
    (APIProvider.ANTHROPIC, "claude-3-7-sonnet-20250219"): "claude-3-7-sonnet-20250219",
    (APIProvider.BEDROCK, "claude-3-7-sonnet-20250219"): "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
    (APIProvider.VERTEX, "claude-3-7-sonnet-20250219"): "claude-3-7-sonnet-v1@20250219",
    (APIProvider.ANTHROPIC, "claude-4-opus-20250514"): "claude-4-opus-20250514",
    (APIProvider.BEDROCK, "claude-4-opus-20250514"): "us.anthropic.claude-opus-4-20250514-v1:0",
    (APIProvider.VERTEX, "claude-4-opus-20250514"): "claude-4-opus-v1@20250514",
    # Add mapping for the alternative model name format
    (APIProvider.ANTHROPIC, "claude-opus-4-20250514"): "claude-opus-4-20250514",
    (APIProvider.ANTHROPIC, "claude-opus-4-1-20250805"): "claude-opus-4-1-20250805",
    (APIProvider.ANTHROPIC, "claude-4-sonnet-20250514"): "claude-4-sonnet-20250514",
    (APIProvider.ANTHROPIC, "claude-sonnet-4-20250514"): "claude-sonnet-4-20250514",
    (APIProvider.BEDROCK, "claude-4-sonnet-20250514"): "us.anthropic.claude-sonnet-4-20250514-v1:0",
    (APIProvider.VERTEX, "claude-4-sonnet-20250514"): "claude-sonnet-4-v1@20250514",
}


def get_model_name(provider: APIProvider, model_name: str) -> str:
    """
    Get the actual model name to use for API calls.
    
    Simply returns the model name as-is for direct API usage.
    """
    return model_name


# This system prompt is optimized for the Docker environment in this repository and
# specific tool combinations enabled.
# We encourage modifying this system prompt to ensure the model has context for the
# environment it is running in, and to provide any additional information that may be
# helpful for the task at hand.
SYSTEM_PROMPT = f"""<SYSTEM_CAPABILITY>
* You are utilising an Ubuntu virtual machine using x86_64 architecture with internet access.
* You can feel free to install Ubuntu applications with your bash tool. Use curl instead of wget.
* To open browser, please just click on the Chrome icon.  Note, Chrome is what is installed on your system.
* Using bash tool you can start GUI applications, but you need to set export DISPLAY=:1 and use a subshell. For example "(DISPLAY=:1 xterm &)". GUI apps run with bash tool will appear within your desktop environment, but they may take some time to appear. Take a screenshot to confirm it did.
* When using your bash tool with commands that are expected to output very large quantities of text, redirect into a tmp file and use str_replace_editor or `grep -n -B <lines before> -A <lines after> <query> <filename>` to confirm output.
* When viewing a page it can be helpful to zoom out so that you can see everything on the page.  Either that, or make sure you scroll down to see everything before deciding something isn't available.
* DO NOT ask users for clarification during task execution. DO NOT stop to request more information from users. Always take action using available tools.
* When using your computer function calls, they take a while to run and send back to you.  Where possible/feasible, try to chain multiple of these calls all into one function calls request.
* TASK FEASIBILITY: You can declare a task infeasible at any point during execution - whether at the beginning after taking a screenshot, or later after attempting some actions and discovering barriers. Carefully evaluate whether the task is feasible given the current system state, available applications, and task requirements. If you determine that a task cannot be completed due to:
  - Missing required applications or dependencies that cannot be installed
  - Insufficient permissions or system limitations
  - Contradictory or impossible requirements
  - Any other fundamental barriers that make completion impossible
  Then you MUST output exactly "[INFEASIBLE]" (including the square brackets) anywhere in your response to trigger the fail action. The system will automatically detect this pattern and terminate the task appropriately.
* The current date is {datetime.today().strftime('%A, %B %d, %Y')}.
* Home directory of this Ubuntu system is '/home/user'.
* If you need a password for sudo, the password of the computer is 'osworld-public-evaluation'. 
</SYSTEM_CAPABILITY>

<IMPORTANT>
* If the item you are looking at is a pdf, if after taking a single screenshot of the pdf it seems that you want to read the entire document instead of trying to continue to read the pdf from your screenshots + navigation, determine the URL, use curl to download the pdf, install and use pdftotext to convert it to a text file, and then read that text file directly with your StrReplaceEditTool.
</IMPORTANT>"""

SYSTEM_PROMPT_WINDOWS = f"""<SYSTEM_CAPABILITY>
* You are utilising a Windows virtual machine using x86_64 architecture with internet access.
* To open browser, please just click on the Chrome icon.  Note, Chrome is what is installed on your system.
* When viewing a page it can be helpful to zoom out so that you can see everything on the page.  Either that, or make sure you scroll down to see everything before deciding something isn't available.
* The current date is {datetime.today().strftime('%A, %B %d, %Y')}.
* Home directory of this Windows system is 'C:\\Users\\user'.
* When you want to open some applications on Windows, please use Double Click on it instead of clicking once.
* If you need a password for sudo, The password of the computer is 'osworld-public-evaluation'. 
</SYSTEM_CAPABILITY>"""



def _make_api_tool_result(
        result: ToolResult, tool_use_id: str
    ) -> BetaToolResultBlockParam:
        """Convert an agent ToolResult to an API ToolResultBlockParam."""
        tool_result_content: Union[List[Union[BetaTextBlockParam,
                                              BetaImageBlockParam]], str] = []
        is_error = False

        if not result or (result.get('error') is not None and result.get('error') != ""):
            is_error = True
            error_message = str(result.get('error', 'Unknown error occurred')) if result else 'No result received'
            tool_result_content = [{
                "type": "text",
                "text": _maybe_prepend_system_tool_result(result, error_message)
            }]
            
        else:
            if result.get('output'):
                tool_result_content.append({
                    "type": "text",
                    "text": _maybe_prepend_system_tool_result(
                        result,
                        str(result.get('output', '')
                            if result else '') 
                    ),
                })

            if result.get('base64_image'):
                tool_result_content.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": result.get('base64_image', ''),
                    },
                })
            
            if not tool_result_content:
                tool_result_content.append({
                    "type": "text",
                    "text": "Action completed successfully"
                })

        return {
            "type": "tool_result",
            "content": tool_result_content,
            "tool_use_id": tool_use_id,
            "is_error": is_error,
        }

def _maybe_prepend_system_tool_result(result: ToolResult, result_text: str):
    if not result:
        return result_text

    if result.get('system', False):
        result_text = f"<system>{result.get('system','')}</system>\n{result_text}"
    return result_text



def _inject_prompt_caching(
    messages: list[BetaMessageParam],
):
    """
    Set cache breakpoints for the 3 most recent turns
    one cache breakpoint is left for tools/system prompt, to be shared across sessions
    """

    breakpoints_remaining = 2  # Use full budget for recent messages
    messages_processed = 0
    
    for message in reversed(messages):
        if message["role"] == "user" and isinstance(
            content := message["content"], list
        ):
            messages_processed += 1
            # Check if this message would fit within the remaining budget
            if breakpoints_remaining >= len(content):
                # We have enough budget, spend it and add cache_control
                breakpoints_remaining -= len(content)
                # Use type ignore to bypass TypedDict check until SDK types are updated
                content[-1]["cache_control"] = BetaCacheControlEphemeralParam(  # type: ignore
                    {"type": "ephemeral"}
                )
            else:
                # Check if this is the first message (contains image + text with task description)
                is_first_message = messages_processed == len([msg for msg in messages if msg["role"] == "user"])
                
                if not is_first_message:
                    # Not enough budget, remove any existing cache_control from this message
                    content[-1].pop("cache_control", None)
                # Continue to clean up older messages that might have cache_control from previous turns


def _maybe_filter_to_n_most_recent_images(
    messages: list[BetaMessageParam],
    images_to_keep: int,
    min_removal_threshold: int,
):
    """
    With the assumption that images are screenshots that are of diminishing value as
    the conversation progresses, remove all but the final `images_to_keep` tool_result
    images in place, with a chunk of min_removal_threshold to reduce the amount we
    break the implicit prompt cache.
    """
    if images_to_keep is None:
        return messages

    tool_result_blocks = cast(
        list[BetaToolResultBlockParam],
        [
            item
            for message in messages
            for item in (
                message["content"] if isinstance(message["content"], list) else []
            )
            if isinstance(item, dict) and item.get("type") == "tool_result"
        ],
    )

    total_images = sum(
        1
        for tool_result in tool_result_blocks
        for content in tool_result.get("content", [])
        if isinstance(content, dict) and content.get("type") == "image"
    )

    images_to_remove = total_images - images_to_keep
    # for better cache behavior, we want to remove in chunks
    images_to_remove -= images_to_remove % min_removal_threshold

    for tool_result in tool_result_blocks:
        if isinstance(tool_result.get("content"), list):
            new_content = []
            for content in tool_result.get("content", []):
                if isinstance(content, dict) and content.get("type") == "image":
                    if images_to_remove > 0:
                        images_to_remove -= 1
                        continue
                new_content.append(content)
            tool_result["content"] = new_content


def validate_model_support(model_name: str, api_key: str = None, temperature: float = None, top_p: float = None, no_thinking: bool = False, use_isp: bool = False) -> bool:
    """
    Validate model support with the same API call pattern as the main agent.
    
    Args:
        model_name: The model name to validate
        api_key: Optional API key, defaults to ANTHROPIC_API_KEY env var
        temperature: Optional temperature parameter for testing
        top_p: Optional top_p parameter for testing
        no_thinking: Disable thinking mode (matches AnthropicAgent)
        use_isp: Use interleaved scratchpad mode (matches AnthropicAgent)
        
    Returns:
        True if model is supported and API call succeeds, False otherwise
    """
    print(f"🔍 Validating model support: {model_name}")
    
    try:
        from anthropic import Anthropic
        import os
        import time
        
        # Same client setup as main agent but with manual retry (max_retries=1 for faster feedback)
        client = Anthropic(
            api_key=api_key or os.environ.get("ANTHROPIC_API_KEY"), 
            max_retries=4
        ).with_options(default_headers={"anthropic-beta": COMPUTER_USE_BETA_FLAG})
        
        # Same message format as main agent - always use structured format with cache_control
        messages = [{"role": "user", "content": [{"type": "text", "text": "Respond with 'OK'", "cache_control": {"type": "ephemeral"}}]}]
        
        # Same betas configuration as main agent
        betas = [COMPUTER_USE_BETA_FLAG]
        if use_isp:
            betas.append("interleaved-thinking-2025-05-14")
            
        system = [{"type": "text", "text": "You are Claude. Respond with 'OK'."}]
        
        # Same tools configuration as main agent - use modern computer tool for all models
        tools = [{"name": "computer", "type": "computer_20250124", 
                 "display_width_px": 1280, "display_height_px": 720, "display_number": 1}]
        
        # Same thinking configuration as main agent
        max_tokens = 50  # Base validation max_tokens
        if no_thinking:
            extra_body = {}
            actual_max_tokens = max_tokens
        else:
            budget_tokens = 2048
            # Same logic as main agent: if max_tokens <= budget_tokens, increase it
            if max_tokens <= budget_tokens:
                actual_max_tokens = budget_tokens + 500
            else:
                actual_max_tokens = max_tokens
            extra_body = {
                "thinking": {"type": "enabled", "budget_tokens": budget_tokens}
            }
        
        # Sampling parameters (same logic as main agent)
        sampling_params = {}
        if temperature is not None:
            sampling_params['temperature'] = temperature
        if top_p is not None:
            sampling_params['top_p'] = top_p
        
        # Retry logic with 5 attempts, 5 second delays
        for attempt in range(5):
            try:
                # Same API call pattern as main agent
                client.beta.messages.create(
                    max_tokens=actual_max_tokens,
                    messages=messages,
                    model=get_model_name(APIProvider.ANTHROPIC, model_name),
                    system=system,
                    tools=tools,
                    betas=betas,
                    extra_body=extra_body,
                    **sampling_params
                )
                
                print(f"✅ Model {model_name} validated successfully")
                return True
            except Exception as e:
                if attempt < 4:  # Don't print error on final attempt
                    print(f"🔄 Validation attempt {attempt + 1}/5 failed: {e}")
                    print(f"⏳ Retrying in 5 seconds...")
                    time.sleep(5)
                else:
                    print(f"❌ All validation attempts failed. Final error: {e}")
        
        return False
        
    except ValueError:
        return False
    except Exception as e:
        print(f"❌ API validation setup failed: {e}")
        return False


def _response_to_params(
    response: BetaMessage,
) -> list[BetaContentBlockParam]:
    res: list[BetaContentBlockParam] = []
    if response.content:
        for block in response.content:
            if isinstance(block, BetaTextBlock):
                if block.text:
                    res.append(BetaTextBlockParam(type="text", text=block.text))
                elif getattr(block, "type", None) == "thinking":
                    # Handle thinking blocks - include signature field
                    thinking_block = {
                        "type": "thinking",
                        "thinking": getattr(block, "thinking", None),
                    }
                    if hasattr(block, "signature"):
                        thinking_block["signature"] = getattr(block, "signature", None)
                    res.append(cast(BetaContentBlockParam, thinking_block))
            else:
                # Handle tool use blocks normally
                res.append(cast(BetaToolUseBlockParam, block.model_dump()))
        return res
    else:
        return []