"""Benchmark adapter for the Codex CLI agent harness (#10193/#10199).

Skeleton harness bridge, API-shaped like ``smithers_adapter``: a one-shot
per-turn ``codex exec`` subprocess authenticated AS a selected OpenAI-Codex
account by pointing ``CODEX_HOME`` at that account's materialized home. Select
it with ``--adapters codex`` and iterate accounts with ``--accounts <n|list>``.

The account-selection / round-robin logic (``codex_adapter.accounts``) is fully
offline-testable; a live model run is credential-gated on real authenticated
Codex homes and the gpt-5.5 model those accounts are entitled to.
"""

from __future__ import annotations

from codex_adapter.accounts import (
    CodexAccount,
    account_for_turn,
    codex_homes_root,
    default_state_dir,
    discover_codex_accounts,
    iter_turn_accounts,
    select_codex_accounts,
)
from codex_adapter.client import CodexClient, MessageResponse, resolve_codex_binary

__all__ = [
    "CodexAccount",
    "CodexClient",
    "MessageResponse",
    "account_for_turn",
    "codex_homes_root",
    "default_state_dir",
    "discover_codex_accounts",
    "iter_turn_accounts",
    "resolve_codex_binary",
    "select_codex_accounts",
]
