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
