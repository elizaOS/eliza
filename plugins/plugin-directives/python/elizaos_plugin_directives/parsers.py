"""Directive parsers for extracting inline directives from message text."""

from __future__ import annotations

import re
from dataclasses import replace
from typing import Callable, TypeVar

from elizaos_plugin_directives.types import (
    DirectiveState,
    ElevatedLevel,
    ExecConfig,
    ModelConfig,
    ParsedDirectives,
    ReasoningLevel,
    ThinkLevel,
    VerboseLevel,
)

T = TypeVar("T")

# ============================================================================
# Internal helpers
# ============================================================================


class _DirectiveMatch:
    """Raw match result with position info and optional argument text."""

    __slots__ = ("start", "end", "raw_level")

    def __init__(self, start: int, end: int, raw_level: str | None) -> None:
        self.start = start
        self.end = end
        self.raw_level = raw_level


class _ExtractResult:
    """Internal extraction result carrying found-flag, typed level, and cleaned text."""

    __slots__ = ("found", "level", "cleaned")

    def __init__(self, found: bool, level: object, cleaned: str) -> None:
        self.found = found
        self.level = level
        self.cleaned = cleaned


def _find_directive_match(text: str, names: list[str]) -> _DirectiveMatch | None:
    """Locate a level-based directive in *text*.

    *names* must be sorted longest-first so that the regex alternation
    prefers the longest match (leftmost-first semantics).
    """
    name_pattern = "|".join(re.escape(n) for n in names)
    pattern = re.compile(rf"(?i)(?:^|\s)/(?:{name_pattern})(?=$|\s|:)")
    m = pattern.search(text)
    if m is None:
        return None

    # Character-by-character scan for optional colon + argument value,
    # mirroring the TypeScript ``matchLevelDirective`` logic.
    i = m.end()
    length = len(text)

    # skip whitespace
    while i < length and text[i].isspace():
        i += 1
    # optional colon
    if i < length and text[i] == ":":
        i += 1
        while i < length and text[i].isspace():
            i += 1
    # read argument word [A-Za-z0-9_-]+
    arg_start = i
    while i < length and (text[i].isalnum() or text[i] in ("-", "_")):
        i += 1

    raw_level = text[arg_start:i] if i > arg_start else None
    return _DirectiveMatch(start=m.start(), end=i, raw_level=raw_level)


def _clean_text(text: str, start: int, end: int) -> str:
    before = text[:start]
    after = text[end:] if end < len(text) else ""
    return " ".join(f"{before} {after}".split())


def _extract_level(
    text: str,
    names: list[str],
    normalize: Callable[[str], T | None],
) -> _ExtractResult:
    dm = _find_directive_match(text, names)
    if dm is None:
        return _ExtractResult(found=False, level=None, cleaned=text.strip())
    level = normalize(dm.raw_level) if dm.raw_level else None
    cleaned = _clean_text(text, dm.start, dm.end)
    return _ExtractResult(found=True, level=level, cleaned=cleaned)


# ============================================================================
# Normalizers
# ============================================================================


def normalize_think_level(raw: str | None) -> ThinkLevel | None:
    """Normalize a raw string to a :pydata:`ThinkLevel`."""
    if not raw:
        return None
    key = raw.lower()
    if key in ("off", "none", "disable", "disabled"):
        return "off"
    if key in ("on", "enable", "enabled", "concise", "min", "minimal", "low", "think"):
        return "concise"
    if key in (
        "verbose", "full", "high", "ultra", "max",
        "medium", "med", "mid", "xhigh", "x-high", "x_high", "harder", "hardest",
    ):
        return "verbose"
    return None


def normalize_verbose_level(raw: str | None) -> VerboseLevel | None:
    """Normalize a raw string to a :pydata:`VerboseLevel`."""
    if not raw:
        return None
    key = raw.lower()
    if key in ("off", "false", "no", "0", "disable", "disabled"):
        return "off"
    if key in ("on", "true", "yes", "1", "full", "all", "enable", "enabled", "everything"):
        return "on"
    return None


def normalize_reasoning_level(raw: str | None) -> ReasoningLevel | None:
    """Normalize a raw string to a :pydata:`ReasoningLevel`."""
    if not raw:
        return None
    key = raw.lower()
    if key in ("off", "false", "no", "0", "hide", "hidden", "disable", "disabled"):
        return "off"
    if key in ("on", "true", "yes", "1", "show", "visible", "enable", "enabled", "brief"):
        return "brief"
    if key in ("detailed", "stream", "streaming", "draft", "live", "full"):
        return "detailed"
    return None


def normalize_elevated_level(raw: str | None) -> ElevatedLevel | None:
    """Normalize a raw string to a :pydata:`ElevatedLevel`."""
    if not raw:
        return None
    key = raw.lower()
    if key in ("off", "false", "no", "0", "disable", "disabled"):
        return "off"
    if key in ("on", "true", "yes", "1", "full", "auto", "auto-approve", "autoapprove", "ask", "prompt"):
        return "on"
    return None


def normalize_exec(raw: str | None) -> ExecConfig | None:
    """Normalize a raw exec argument to an :class:`ExecConfig`."""
    if not raw:
        return None
    key = raw.lower()
    if key in ("off", "false", "no", "disable", "disabled"):
        return ExecConfig(enabled=False, auto_approve=False)
    if key in ("on", "true", "yes", "enable", "enabled"):
        return ExecConfig(enabled=True, auto_approve=False)
    if key in ("auto-approve", "auto_approve", "autoapprove", "approve", "auto"):
        return ExecConfig(enabled=True, auto_approve=True)
    return None


# ============================================================================
# Public extract functions
# ============================================================================


def extract_think_directive(text: str) -> ThinkLevel | None:
    """Extract a ``/think`` (or ``/thinking``, ``/t``) directive from *text*."""
    return _extract_level(text, ["thinking", "think", "t"], normalize_think_level).level  # type: ignore[return-value]


def extract_verbose_directive(text: str) -> VerboseLevel | None:
    """Extract a ``/verbose`` (or ``/v``) directive from *text*."""
    return _extract_level(text, ["verbose", "v"], normalize_verbose_level).level  # type: ignore[return-value]


def extract_reasoning_directive(text: str) -> ReasoningLevel | None:
    """Extract a ``/reasoning`` (or ``/reason``) directive from *text*."""
    return _extract_level(text, ["reasoning", "reason"], normalize_reasoning_level).level  # type: ignore[return-value]


def extract_elevated_directive(text: str) -> ElevatedLevel | None:
    """Extract an ``/elevated`` (or ``/elev``) directive from *text*."""
    return _extract_level(text, ["elevated", "elev"], normalize_elevated_level).level  # type: ignore[return-value]


def extract_exec_directive(text: str) -> ExecConfig | None:
    """Extract an ``/exec`` directive from *text*."""
    result = _extract_level(text, ["exec"], normalize_exec)
    if result.found and result.level is None:
        # Bare /exec without argument → enabled with no auto-approve
        return ExecConfig(enabled=True, auto_approve=False)
    return result.level  # type: ignore[return-value]


def extract_model_directive(text: str) -> ModelConfig | None:
    """Extract a ``/model`` directive from *text*.

    Model arguments allow ``/`` and ``.`` in the value (e.g.
    ``anthropic/claude-3.5-sonnet``).
    """
    result = _find_model_match(text)
    if result is None:
        return None
    return result[0]


def extract_status_directive(text: str) -> bool:
    """Return ``True`` if *text* contains a ``/status`` directive."""
    return _find_directive_match(text, ["status"]) is not None


# ============================================================================
# Model-specific matching (allows `/` and `.` in argument)
# ============================================================================


def _find_model_match(
    text: str,
) -> tuple[ModelConfig | None, int, int] | None:
    pattern = re.compile(r"(?i)(?:^|\s)/model(?=$|\s|:)")
    m = pattern.search(text)
    if m is None:
        return None

    i = m.end()
    length = len(text)

    while i < length and text[i].isspace():
        i += 1
    if i < length and text[i] == ":":
        i += 1
        while i < length and text[i].isspace():
            i += 1

    # Read model spec allowing / and .
    arg_start = i
    while i < length and (text[i].isalnum() or text[i] in ("-", "_", ".", "/")):
        i += 1

    if i > arg_start:
        raw = text[arg_start:i]
        parts = raw.split("/", maxsplit=1)
        if len(parts) == 2:
            config: ModelConfig | None = ModelConfig(
                provider=parts[0], model=parts[1]
            )
        else:
            config = ModelConfig(model=parts[0])
    else:
        config = None

    return config, m.start(), i


# ============================================================================
# Combined parser
# ============================================================================


def parse_all_directives(text: str) -> ParsedDirectives:
    """Parse **all** inline directives from *text*."""

    # 1. think
    think_res = _extract_level(text, ["thinking", "think", "t"], normalize_think_level)
    # 2. verbose
    verbose_res = _extract_level(think_res.cleaned, ["verbose", "v"], normalize_verbose_level)
    # 3. reasoning
    reasoning_res = _extract_level(
        verbose_res.cleaned, ["reasoning", "reason"], normalize_reasoning_level
    )
    # 4. elevated
    elevated_res = _extract_level(
        reasoning_res.cleaned, ["elevated", "elev"], normalize_elevated_level
    )
    # 5. exec
    exec_res = _extract_level(elevated_res.cleaned, ["exec"], normalize_exec)
    exec_found = exec_res.found
    exec_config: ExecConfig | None
    if exec_found and exec_res.level is None:
        exec_config = ExecConfig(enabled=True, auto_approve=False)
    else:
        exec_config = exec_res.level  # type: ignore[assignment]

    # 6. status
    status_dm = _find_directive_match(exec_res.cleaned, ["status"])
    if status_dm is not None:
        after_status = _clean_text(exec_res.cleaned, status_dm.start, status_dm.end)
        status_found = True
    else:
        after_status = exec_res.cleaned.strip()
        status_found = False

    # 7. model
    model_match = _find_model_match(after_status)
    if model_match is not None:
        model_config, mstart, mend = model_match
        after_model = _clean_text(after_status, mstart, mend)
        model_found = True
    else:
        model_config = None
        after_model = after_status.strip()
        model_found = False

    any_directive = (
        think_res.found
        or verbose_res.found
        or reasoning_res.found
        or elevated_res.found
        or exec_found
        or model_found
    )
    directives_only = any_directive and after_model.strip() == ""

    return ParsedDirectives(
        cleaned_text=after_model,
        directives_only=directives_only,
        has_think=think_res.found,
        think=think_res.level,  # type: ignore[arg-type]
        has_verbose=verbose_res.found,
        verbose=verbose_res.level,  # type: ignore[arg-type]
        has_reasoning=reasoning_res.found,
        reasoning=reasoning_res.level,  # type: ignore[arg-type]
        has_elevated=elevated_res.found,
        elevated=elevated_res.level,  # type: ignore[arg-type]
        has_exec=exec_found,
        exec=exec_config,
        has_model=model_found,
        model=model_config,
        has_status=status_found,
    )


def strip_directives(text: str) -> str:
    """Remove all recognised directive markers from *text*."""
    return parse_all_directives(text).cleaned_text


def format_directive_state(state: DirectiveState) -> str:
    """Build a human-readable summary of a :class:`DirectiveState`."""
    lines = [
        f"Thinking: {state.thinking}",
        f"Verbose: {state.verbose}",
        f"Reasoning: {state.reasoning}",
        f"Elevated: {state.elevated}",
    ]
    if state.model.provider or state.model.model:
        model_str = (
            f"{state.model.provider}/{state.model.model}"
            if state.model.provider
            else (state.model.model or "unknown")
        )
        lines.append(f"Model: {model_str}")
    if state.exec.enabled:
        lines.append(f"Exec: enabled (auto_approve={state.exec.auto_approve})")
    return "\n".join(lines)


def apply_directives(
    current: DirectiveState, directives: ParsedDirectives
) -> DirectiveState:
    """Apply parsed directives on top of an existing state, returning a new state."""
    updated = DirectiveState(
        thinking=current.thinking,
        verbose=current.verbose,
        reasoning=current.reasoning,
        elevated=current.elevated,
        exec=current.exec,
        model=current.model,
    )
    if directives.think is not None:
        updated.thinking = directives.think
    if directives.verbose is not None:
        updated.verbose = directives.verbose
    if directives.reasoning is not None:
        updated.reasoning = directives.reasoning
    if directives.elevated is not None:
        updated.elevated = directives.elevated
    if directives.exec is not None:
        updated.exec = directives.exec
    if directives.model is not None:
        updated.model = directives.model
    return updated
