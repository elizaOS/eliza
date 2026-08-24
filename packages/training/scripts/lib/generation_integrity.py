"""Reject incomplete model generations before evaluation or training admission.

Providers use several finish-reason spellings for output-budget exhaustion. This
module centralizes that boundary and carries an explicit attempted/accepted
denominator so callers cannot silently score or persist a returned prefix.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


LENGTH_FINISH_REASONS = frozenset(
    {
        "length",
        "max_length",
        "max_output_tokens",
        "max_tokens",
        "model_length",
        "token_limit",
    }
)


@dataclass(frozen=True)
class GenerationRejection:
    """Structured admission failure suitable for logs and run manifests."""

    code: str
    source: str
    finish_reason: str
    attempted: int = 1
    accepted: int = 0

    def as_dict(self) -> dict[str, str | int]:
        return {
            "code": self.code,
            "source": self.source,
            "finish_reason": self.finish_reason,
            "attempted": self.attempted,
            "accepted": self.accepted,
        }


class IncompleteGenerationError(RuntimeError):
    """Raised when a provider returned only a capped generation prefix."""

    code = "TRAINING_GENERATION_LENGTH_STOPPED"

    def __init__(self, source: str, finish_reason: object) -> None:
        reason = str(finish_reason).strip().lower()
        self.rejection = GenerationRejection(self.code, source, reason)
        super().__init__(
            f"{self.code}: {source} returned an incomplete generation "
            f"(finish_reason={reason}; attempted=1 accepted=0)"
        )


class UnknownModelOutputLimitError(ValueError):
    """Raised when a required provider ceiling is not known for a model."""

    code = "TRAINING_MODEL_OUTPUT_LIMIT_UNKNOWN"

    def __init__(self, provider: str, model: str) -> None:
        super().__init__(
            f"{self.code}: no documented {provider} output limit is registered "
            f"for model {model!r}; add the provider's hard limit before dispatch"
        )


class PromptExceedsContextError(ValueError):
    """Raised before dispatch when a complete prompt cannot fit the context."""

    code = "TRAINING_PROMPT_EXCEEDS_CONTEXT"

    def __init__(self, source: str, prompt_tokens: int, context_tokens: int) -> None:
        super().__init__(
            f"{self.code}: {source} requires {prompt_tokens} prompt tokens, but "
            f"the configured context supports {context_tokens}; prompt was not truncated"
        )


class ModelContextLimitUnknownError(ValueError):
    """Raised when local generation cannot prove the model's real context size."""

    code = "TRAINING_MODEL_CONTEXT_LIMIT_UNKNOWN"

    def __init__(self, source: str) -> None:
        super().__init__(
            f"{self.code}: {source} exposes no supported context-length field; "
            "generation was not dispatched"
        )


def model_context_tokens(model: object, tokenizer: object, *, source: str) -> int:
    """Read a finite context boundary from common model/tokenizer contracts."""

    owners = (
        getattr(model, "config", None),
        getattr(model, "args", None),
        model,
        tokenizer,
    )
    attributes = (
        "max_position_embeddings",
        "max_target_positions",
        "max_sequence_length",
        "seq_length",
        "context_length",
        "model_max_length",
    )
    for owner in owners:
        if owner is None:
            continue
        for attribute in attributes:
            value = getattr(owner, attribute, None)
            if isinstance(value, int) and 0 < value <= 100_000_000:
                return value
    raise ModelContextLimitUnknownError(source)


def remaining_model_context_tokens(
    model: object,
    tokenizer: object,
    *,
    prompt_tokens: int,
    source: str,
) -> int:
    """Return full local generation capacity or reject an oversized prompt."""

    context_tokens = model_context_tokens(model, tokenizer, source=source)
    remaining = context_tokens - prompt_tokens
    if remaining <= 0:
        raise PromptExceedsContextError(source, prompt_tokens, context_tokens)
    return remaining


def anthropic_max_output_tokens(model: str) -> int:
    """Return Anthropic's documented synchronous Messages API output maximum."""

    normalized = model.strip().lower()
    if normalized.startswith("claude-opus-4-7"):
        return 128_000
    if normalized.startswith(("claude-sonnet-4-", "claude-haiku-4-5")):
        return 64_000
    raise UnknownModelOutputLimitError("Anthropic", model)


def finish_reason_from_choice(choice: object) -> object | None:
    """Read common finish-reason fields from mapping or SDK response objects."""

    if isinstance(choice, dict):
        for key in ("finish_reason", "finishReason", "stop_reason", "stopReason"):
            if key in choice:
                return choice[key]
        return None
    for key in ("finish_reason", "finishReason", "stop_reason", "stopReason"):
        if hasattr(choice, key):
            return getattr(choice, key)
    return None


def require_complete_generation(choice: Any, *, source: str) -> Any:
    """Return a complete choice or reject a recognized output-length stop."""

    reason = finish_reason_from_choice(choice)
    if reason is not None and str(reason).strip().lower() in LENGTH_FINISH_REASONS:
        raise IncompleteGenerationError(source, reason)
    return choice


def require_complete_finish_reasons(
    finish_reasons: list[object], *, source: str
) -> None:
    """Reject a multi-sample result if any member stopped at a length boundary."""

    for index, reason in enumerate(finish_reasons):
        if str(reason).strip().lower() in LENGTH_FINISH_REASONS:
            raise IncompleteGenerationError(f"{source}[{index}]", reason)


def require_complete_generated_tokens(
    generated_token_ids: object,
    *,
    max_new_tokens: int,
    source: str,
    terminal_token_ids: object = None,
) -> None:
    """Reject local generation that exhausted its output budget without EOS."""

    values = (
        generated_token_ids.tolist()
        if hasattr(generated_token_ids, "tolist")
        else list(generated_token_ids)  # type: ignore[arg-type]
    )
    while values and isinstance(values[0], list):
        values = values[0]
    terminals: set[object]
    if terminal_token_ids is None:
        terminals = set()
    elif isinstance(terminal_token_ids, (list, tuple, set, frozenset)):
        terminals = set(terminal_token_ids)
    else:
        terminals = {terminal_token_ids}
    if len(values) >= max_new_tokens and (not values or values[-1] not in terminals):
        raise IncompleteGenerationError(source, "max_tokens")
