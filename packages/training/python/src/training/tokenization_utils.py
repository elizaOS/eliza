"""
Token Masking Utilities for GRPO Training

Provides proper label values for training data. The key requirement is:
- Prompt tokens: labels=-100 (ignored in loss calculation, model doesn't learn from them)
- Completion tokens: labels=token_id (included in loss calculation, model learns from them)

Note: These are LABEL values for CrossEntropyLoss, not attention masks.
PyTorch's CrossEntropyLoss uses ignore_index=-100 by default, so setting
labels=-100 for prompt tokens effectively excludes them from the loss.

This is critical for GRPO because we only want to update policy on the
model's own completions, not on the prompts.

The online environment (BabylonOnlineEnv) uses Atropos managed_server which
handles this automatically. This module provides utilities for:
1. Offline/historical data where masking wasn't applied correctly
2. Testing and validation of masking logic
3. Custom tokenization scenarios
"""

import logging
from dataclasses import dataclass
from typing import Dict, List, Optional, Protocol, Tuple

logger = logging.getLogger(__name__)

class ChatTokenizer(Protocol):
    """Minimal tokenizer interface needed by the masking utilities.

    This intentionally avoids importing heavy optional deps (e.g. `transformers`)
    at import time so the module can be used in lightweight environments.
    """

    def apply_chat_template(
        self,
        messages: List[Dict[str, str]],
        return_tensors: Optional[object] = None,
        add_generation_prompt: bool = False,
    ) -> List[int]: ...

    def encode(self, text: str, add_special_tokens: bool = True) -> List[int]: ...


@dataclass
class TokenizationResult:
    """Result of tokenization with masks"""
    tokens: List[int]
    masks: List[int]
    prompt_length: int
    completion_length: int
    total_length: int


def tokenize_for_trainer(
    tokenizer: ChatTokenizer,
    messages: List[Dict[str, str]],
    add_generation_prompt: bool = False,
) -> TokenizationResult:
    """
    Tokenize chat messages with proper masking for GRPO training.
    
    Creates masks where:
    - mask=-100 for prompt tokens (ignored in loss calculation)
    - mask=token_id for completion tokens (trained on)
    
    This format is required by the GRPO trainer which uses:
        mask = (labels != -100).float()
    
    The last assistant message is treated as the completion.
    All prior messages are treated as prompt.
    
    Args:
        tokenizer: HuggingFace tokenizer with chat template support
        messages: List of chat messages [{"role": "...", "content": "..."}]
        add_generation_prompt: Whether to add generation prompt for prompt-only tokenization
    
    Returns:
        TokenizationResult with tokens, masks, and length info
    """
    if not messages:
        return TokenizationResult(
            tokens=[],
            masks=[],
            prompt_length=0,
            completion_length=0,
            total_length=0,
        )
    
    # Find the last assistant message
    last_assistant_idx = None
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "assistant":
            last_assistant_idx = i
            break
    
    if last_assistant_idx is None:
        # No assistant message - treat all as prompt
        full_tokens = tokenizer.apply_chat_template(
            messages,
            return_tensors=None,
            add_generation_prompt=add_generation_prompt,
        )
        
        return TokenizationResult(
            tokens=full_tokens,
            masks=[-100] * len(full_tokens),  # All masked (prompt only)
            prompt_length=len(full_tokens),
            completion_length=0,
            total_length=len(full_tokens),
        )
    
    # Split into prompt (before last assistant) and completion (last assistant)
    prompt_messages = messages[:last_assistant_idx]
    completion_message = messages[last_assistant_idx]
    
    # Tokenize prompt with generation prompt to get exact split point
    prompt_tokens = tokenizer.apply_chat_template(
        prompt_messages,
        return_tensors=None,
        add_generation_prompt=True,
    )
    
    # Tokenize full conversation
    full_tokens = tokenizer.apply_chat_template(
        messages,
        return_tensors=None,
        add_generation_prompt=False,
    )
    
    # Calculate completion length
    prompt_length = len(prompt_tokens)
    completion_length = len(full_tokens) - prompt_length
    
    # Handle edge case where tokenization differs
    if completion_length < 0:
        # Tokenizer may add different special tokens
        # Fall back to tokenizing completion separately
        completion_content = completion_message.get("content", "")
        completion_tokens_only = tokenizer.encode(completion_content, add_special_tokens=False)
        completion_length = len(completion_tokens_only)
        prompt_length = len(full_tokens) - completion_length
    
    # Create masks: -100 for prompt (ignore), actual token IDs for completion (train)
    # CRITICAL: GRPO trainer checks (labels != -100) to determine trainable tokens
    masks = [-100] * prompt_length + full_tokens[prompt_length:]
    
    # Ensure masks match tokens length
    if len(masks) != len(full_tokens):
        logger.warning(
            f"Mask length mismatch: {len(masks)} vs {len(full_tokens)} tokens. "
            "Adjusting masks."
        )
        if len(masks) < len(full_tokens):
            # Pad with actual token IDs (assume extra tokens are completion)
            masks.extend(full_tokens[len(masks):])
        else:
            # Truncate
            masks = masks[:len(full_tokens)]
    
    return TokenizationResult(
        tokens=full_tokens,
        masks=masks,
        prompt_length=prompt_length,
        completion_length=completion_length,
        total_length=len(full_tokens),
    )


def tokenize_conversation_for_trainer(
    tokenizer: ChatTokenizer,
    messages: List[Dict[str, str]],
) -> TokenizationResult:
    """
    Tokenize a multi-turn conversation for training.
    
    Masks all user/system messages (-100) and unmasks all assistant messages
    (actual token IDs). This is useful for training on conversations where
    we want to learn from all assistant responses.
    
    Args:
        tokenizer: HuggingFace tokenizer with chat template support
        messages: List of chat messages
    
    Returns:
        TokenizationResult with tokens and masks
    """
    if not messages:
        return TokenizationResult(
            tokens=[],
            masks=[],
            prompt_length=0,
            completion_length=0,
            total_length=0,
        )
    
    full_tokens = tokenizer.apply_chat_template(
        messages,
        return_tensors=None,
        add_generation_prompt=False,
    )
    
    # Build masks by tracking message boundaries
    masks: List[int] = []
    current_position = 0
    
    for i, message in enumerate(messages):
        # Tokenize up to and including this message
        partial_messages = messages[:i + 1]
        
        partial_tokens = tokenizer.apply_chat_template(
            partial_messages,
            return_tensors=None,
            add_generation_prompt=False,
        )
        
        # Calculate tokens for this message
        message_end = len(partial_tokens)
        message_length = message_end - current_position
        
        # Mask based on role: -100 for ignore, token ID for train
        if message["role"] == "assistant":
            # Train on assistant - use actual token IDs
            masks.extend(full_tokens[current_position:message_end])
        else:
            # Don't train on user/system - use -100
            masks.extend([-100] * message_length)
        
        current_position = message_end
    
    # Ensure masks match tokens length
    if len(masks) != len(full_tokens):
        logger.warning(
            f"Conversation mask length mismatch: {len(masks)} vs {len(full_tokens)}. "
            "Falling back to simple masking."
        )
        # Fall back to simpler approach
        return tokenize_for_trainer(tokenizer, messages)
    
    # Calculate prompt/completion lengths
    prompt_length = sum(1 for m in masks if m == -100)
    completion_length = sum(1 for m in masks if m != -100)
    
    return TokenizationResult(
        tokens=full_tokens,
        masks=masks,
        prompt_length=prompt_length,
        completion_length=completion_length,
        total_length=len(full_tokens),
    )


def validate_masks(
    tokens: List[int],
    masks: List[int],
    tokenizer: ChatTokenizer,
) -> Tuple[bool, List[str]]:
    """
    Validate that masks are correctly applied for GRPO training.
    
    Checks:
    1. Masks and tokens have same length
    2. Masked tokens (prompt) use -100
    3. Unmasked tokens (completion) use actual token IDs
    4. There are some masked (prompt) tokens
    5. There are some unmasked (completion) tokens
    
    Returns:
        (is_valid, list_of_issues)
    """
    issues = []
    
    if len(tokens) != len(masks):
        issues.append(f"Length mismatch: {len(tokens)} tokens vs {len(masks)} masks")
    
    # Check for proper mask format
    has_prompt = any(m == -100 for m in masks)
    has_completion = any(m != -100 for m in masks)
    
    if not has_prompt:
        issues.append("No masked tokens (no prompt) - should have -100 values")
    
    if not has_completion:
        issues.append("No unmasked tokens (no completion) - should have token ID values")
    
    # Check that non-(-100) masks match corresponding tokens
    for i, (token, mask) in enumerate(zip(tokens, masks)):
        if mask != -100 and mask != token:
            issues.append(
                f"Mask mismatch at position {i}: mask={mask} but token={token}. "
                "Trainable tokens should have mask=token_id."
            )
            break  # Only report first occurrence
    
    # Detect legacy 0/1 mask format (WRONG)
    unique_masks = set(masks)
    if unique_masks == {0, 1} or unique_masks == {0} or unique_masks == {1}:
        issues.append(
            "LEGACY MASK FORMAT DETECTED: Using 0/1 instead of -100/token_id. "
            "This will train on ALL tokens incorrectly!"
        )
    
    is_valid = len(issues) == 0
    return is_valid, issues


def create_masks_from_response_start(
    tokens: List[int],
    response_start_position: int,
) -> List[int]:
    """
    Create masks given the starting position of the response.
    
    Simple utility when you already know where the response starts.
    
    Args:
        tokens: Full token sequence
        response_start_position: Index where response (completion) starts
    
    Returns:
        List of masks (-100 before response, token IDs from response onwards)
    """
    if response_start_position < 0:
        response_start_position = 0
    if response_start_position > len(tokens):
        response_start_position = len(tokens)
    
    # -100 for prompt, actual token IDs for completion
    return [-100] * response_start_position + tokens[response_start_position:]


def fix_historical_masks(
    tokens: List[int],
    masks: List[int],
    tokenizer: ChatTokenizer,
    messages: List[Dict[str, str]],
) -> List[int]:
    """
    Fix incorrectly applied masks from historical data.
    
    Historical data from BabylonRLAIFEnv used [1]*len(tokens) or [0,1] binary
    masks which incorrectly trains on prompt tokens. This function recalculates
    proper masks using -100 for prompt and token IDs for completion.
    
    Args:
        tokens: Token sequence
        masks: Original (possibly incorrect) masks
        tokenizer: Tokenizer for re-tokenization
        messages: Original messages to determine prompt boundary
    
    Returns:
        Corrected mask sequence with -100 for prompt, token IDs for completion
    """
    # Check if masks look incorrect
    # Red flags: all 1s, all 0s, or only 0/1 values (legacy format)
    unique_masks = set(masks)
    is_legacy_format = unique_masks.issubset({0, 1})
    is_all_same = len(unique_masks) <= 1
    
    if is_legacy_format or is_all_same:
        logger.info(
            f"Detected legacy mask format (unique values: {unique_masks}), "
            "recalculating with proper -100/token_id format"
        )
        result = tokenize_for_trainer(tokenizer, messages)
        return result.masks
    
    # Validate current masks
    is_valid, issues = validate_masks(tokens, masks, tokenizer)
    if is_valid:
        return masks
    
    logger.warning(f"Invalid masks detected: {issues[:3]}. Recalculating.")
    result = tokenize_for_trainer(tokenizer, messages)
    
    # Ensure length matches
    if len(result.masks) == len(tokens):
        return result.masks
    
    # Last resort: find assistant turn manually
    # Look for common assistant turn markers in token sequence
    assistant_markers = [
        tokenizer.encode("assistant", add_special_tokens=False),
        tokenizer.encode("<|assistant|>", add_special_tokens=False),
        tokenizer.encode("<|im_start|>assistant", add_special_tokens=False),
    ]
    
    for marker_tokens in assistant_markers:
        if not marker_tokens:
            continue
        
        # Find last occurrence of marker
        for i in range(len(tokens) - len(marker_tokens), -1, -1):
            if tokens[i:i + len(marker_tokens)] == marker_tokens:
                # Start masking from after this marker
                response_start = i + len(marker_tokens)
                return create_masks_from_response_start(tokens, response_start)
    
    # If all else fails, return original masks with warning
    logger.error("Could not fix masks, returning original")
    return masks

