"""Terminal-Bench Providers for ElizaOS."""

from .task_context import task_context_provider
from .terminal_state import terminal_state_provider

__all__ = [
    "task_context_provider",
    "terminal_state_provider",
    "TERMINAL_PROVIDERS",
]

TERMINAL_PROVIDERS = [
    task_context_provider,
    terminal_state_provider,
]
