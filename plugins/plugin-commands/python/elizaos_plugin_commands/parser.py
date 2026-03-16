"""Command parser - detects and parses commands from message text."""

from __future__ import annotations

import re

from elizaos_plugin_commands.types import ParsedCommand

# Pattern matching /command or !command at the start of text.
_COMMAND_PREFIX_RE = re.compile(r"^[/!]([a-zA-Z][a-zA-Z0-9_-]*)")


def is_command(text: str) -> bool:
    """Check whether *text* looks like a command (starts with ``/`` or ``!``
    followed by a word character).
    """
    trimmed = text.strip()
    if not trimmed:
        return False
    return bool(_COMMAND_PREFIX_RE.match(trimmed))


def parse_command(text: str) -> ParsedCommand | None:
    """Parse a command string into a :class:`ParsedCommand`.

    Supports:
    - ``/command arg1 arg2``
    - ``!command arg1 arg2``
    - ``/command:arg1 arg2`` (colon separator)
    - Quoted arguments: ``/cmd "multi word arg"``

    Returns ``None`` if the text is not a valid command.
    """
    trimmed = text.strip()
    if not trimmed:
        return None

    match = _COMMAND_PREFIX_RE.match(trimmed)
    if not match:
        return None

    name = normalize_command_name(match.group(1))
    remainder = trimmed[match.end() :]

    # Handle colon separator: /cmd:arg -> treat colon as space
    if remainder.startswith(":"):
        remainder = remainder[1:]

    args = extract_command_args(remainder)

    return ParsedCommand(name=name, args=args, raw_text=trimmed)


def normalize_command_name(name: str) -> str:
    """Normalize a command name to lowercase, trimmed, with hyphens replaced
    by underscores.
    """
    return name.strip().lower().replace("-", "_")


def extract_command_args(text: str) -> list[str]:
    """Extract arguments from the text after the command name.

    Supports quoted strings (double or single quotes) to allow multi-word arguments.
    """
    trimmed = text.strip()
    if not trimmed:
        return []

    args: list[str] = []
    current: list[str] = []
    in_quote = False
    quote_char = ""

    for ch in trimmed:
        if in_quote:
            if ch == quote_char:
                in_quote = False
                if current:
                    args.append("".join(current))
                    current = []
            else:
                current.append(ch)
        elif ch in ('"', "'"):
            in_quote = True
            quote_char = ch
        elif ch.isspace():
            if current:
                args.append("".join(current))
                current = []
        else:
            current.append(ch)

    if current:
        args.append("".join(current))

    return args
