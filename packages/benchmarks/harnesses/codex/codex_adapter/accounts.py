"""Multi-account CODEX_HOME selection for the Codex benchmark harness (#10193/#10199).

The elizaOS runtime materializes a credential generation for each authenticated
OpenAI-Codex account so a spawned ``codex`` subprocess authenticates AS that
account instead of the machine's single ``~/.codex`` login. The TS side
(``packages/app-core/src/services/coding-account-bridge.ts``) writes::

    <stateDir>/auth/_codex-home/<accountId>/
        active-home                         # relative, non-secret pointer
        generations/<refresh-token-hash>/
            auth.json                       # chatgpt-mode tokens
            config.toml                     # pinned model

where ``<stateDir>`` is ``$ELIZA_HOME`` (or the resolved per-user state dir,
default ``~/.local/state/eliza``). This module is the **offline-testable**
counterpart the benchmark runner needs: given the ``--accounts`` flag value, it
enumerates the materialized homes and yields the ``CODEX_HOME`` to point each
run at, round-robining turns across accounts. It performs **no** network, no
model call, and no OAuth — it only resolves directories on disk. Materializing
the homes (the OAuth + token write) is the TS runtime's job; a live run is
credential-gated on those homes already existing.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path


ACTIVE_HOME_FILE = "active-home"
GENERATION_NAME = re.compile(r"^[a-f0-9]{24}$")


def default_state_dir() -> Path:
    """Resolve the per-user state root the TS runtime writes Codex homes under.

    Mirrors the TS ``resolveStateDir`` precedence closely enough for the
    benchmark runner: explicit ``ELIZA_HOME`` wins, then the documented state
    dir overrides (``ELIZA_STATE_DIR`` / ``ELIZA_STATE_DIR``), then the default
    ``~/.local/state/eliza``.
    """
    for env_name in ("ELIZA_HOME", "ELIZA_STATE_DIR", "ELIZA_STATE_DIR"):
        value = os.environ.get(env_name, "").strip()
        if value:
            return Path(value).expanduser()
    return Path.home() / ".local" / "state" / "eliza"


def codex_homes_root(state_dir: Path | None = None) -> Path:
    """The directory containing one subdir per authenticated Codex account."""
    root = state_dir if state_dir is not None else default_state_dir()
    return root / "auth" / "_codex-home"


def _active_codex_home(account_root: Path) -> Path:
    """Resolve the generation the runtime published for one account.

    Homes created before generation isolation remain valid at the account root,
    represented by no pointer or ``.``. Any other pointer is a strict protocol
    boundary: only ``generations/<24 lowercase hex>`` is accepted, and broken
    or escaping targets fail instead of silently selecting stale credentials.
    """
    pointer_path = account_root / ACTIVE_HOME_FILE
    if not os.path.lexists(pointer_path):
        return account_root
    try:
        relative_text = pointer_path.read_text(encoding="utf-8").strip()
    except OSError as cause:
        # error-policy:J2 active-home is an on-disk protocol boundary; retain
        # the filesystem cause while naming the account state that is invalid.
        raise ValueError(
            f"cannot read Codex active-home pointer: {pointer_path}"
        ) from cause

    if relative_text == ".":
        return account_root.resolve()

    relative = Path(relative_text)
    if (
        relative.is_absolute()
        or len(relative.parts) != 2
        or relative.parts[0] != "generations"
        or GENERATION_NAME.fullmatch(relative.parts[1]) is None
    ):
        raise ValueError(
            f"invalid Codex active-home pointer {pointer_path}: {relative_text!r}"
        )

    account_root_resolved = account_root.resolve()
    try:
        active_home = (account_root / relative).resolve()
    except (OSError, RuntimeError) as cause:
        # error-policy:J2 symlink and filesystem resolution failures identify
        # the corrupt pointer without hiding the underlying OS error.
        raise ValueError(
            f"cannot resolve Codex active-home pointer: {pointer_path}"
        ) from cause
    if (
        not active_home.is_relative_to(account_root_resolved)
        or not active_home.is_dir()
    ):
        raise ValueError(
            f"Codex active-home pointer target is unavailable: {pointer_path} -> {active_home}"
        )
    return active_home


@dataclass(frozen=True)
class CodexAccount:
    """A single materialized per-account ``CODEX_HOME``."""

    account_id: str
    codex_home: Path

    @property
    def is_authenticated(self) -> bool:
        """True only when the account's ``auth.json`` exists on disk.

        The runner uses this to fail loudly on a live run when no credential was
        materialized — never to silently skip an account.
        """
        return (self.codex_home / "auth.json").is_file()


def discover_codex_accounts(state_dir: Path | None = None) -> list[CodexAccount]:
    """List every materialized per-account ``CODEX_HOME``, sorted by account id.

    Returns an empty list when the homes root does not exist yet (no accounts
    materialized). Only real directories under ``_codex-home`` are considered.
    """
    root = codex_homes_root(state_dir)
    if not root.is_dir():
        return []
    accounts = [
        CodexAccount(account_id=child.name, codex_home=_active_codex_home(child))
        for child in sorted(root.iterdir(), key=lambda p: p.name)
        if child.is_dir()
    ]
    return accounts


def _parse_accounts_spec(spec: str | int | None) -> tuple[int | None, list[str]]:
    """Parse the ``--accounts`` value into ``(count, explicit_ids)``.

    Accepts three shapes, matching the CLI contract:

    - an integer ``N`` (or the string ``"3"``): select the first ``N`` accounts;
    - a comma-separated id list (``"acct-a,acct-b"``): select exactly those ids,
      in the given order;
    - ``None`` / ``""``: select all discovered accounts.

    Returns ``(count, ids)`` where at most one is populated; ``(None, [])`` means
    "all".
    """
    if spec is None:
        return None, []
    if isinstance(spec, int):
        if spec < 0:
            raise ValueError("--accounts count must be >= 0")
        return spec, []
    raw = str(spec).strip()
    if not raw:
        return None, []
    if "," in raw or not _looks_like_int(raw):
        ids = [part.strip() for part in raw.split(",") if part.strip()]
        if not ids:
            return None, []
        return None, ids
    count = int(raw)
    if count < 0:
        raise ValueError("--accounts count must be >= 0")
    return count, []


def _looks_like_int(raw: str) -> bool:
    return raw.isdigit() or (raw.startswith("-") and raw[1:].isdigit())


def select_codex_accounts(
    spec: str | int | None,
    *,
    state_dir: Path | None = None,
    discovered: list[CodexAccount] | None = None,
) -> list[CodexAccount]:
    """Resolve ``--accounts`` against the materialized homes.

    Raises ``ValueError`` (never silently returns fewer) when an explicit id is
    not materialized, when a requested count exceeds what exists, or when no
    accounts are materialized at all. The runner surfaces this as a loud failure
    on a live run rather than proceeding with a half-satisfied account set.
    """
    accounts = (
        discovered if discovered is not None else discover_codex_accounts(state_dir)
    )
    count, explicit_ids = _parse_accounts_spec(spec)

    if not accounts:
        raise ValueError(
            "no Codex accounts materialized under "
            f"{codex_homes_root(state_dir)}. Authenticate at least one "
            "OpenAI-Codex account so the runtime writes its CODEX_HOME "
            "(auth/_codex-home/<accountId>/active-home)."
        )

    by_id = {account.account_id: account for account in accounts}

    if explicit_ids:
        missing = [account_id for account_id in explicit_ids if account_id not in by_id]
        if missing:
            raise ValueError(
                f"requested Codex account id(s) not materialized: {missing}. "
                f"available: {sorted(by_id)}"
            )
        return [by_id[account_id] for account_id in explicit_ids]

    if count is None:
        return list(accounts)

    if count == 0:
        return []
    if count > len(accounts):
        raise ValueError(
            f"--accounts requested {count} accounts but only {len(accounts)} "
            f"are materialized ({sorted(by_id)})"
        )
    return accounts[:count]


def account_for_turn(accounts: list[CodexAccount], turn_index: int) -> CodexAccount:
    """Round-robin the selected accounts across turns.

    Turn ``i`` uses ``accounts[i % len(accounts)]``. Raises ``IndexError`` when
    the selection is empty — the runner must select at least one account before
    iterating turns.
    """
    if not accounts:
        raise IndexError("no Codex accounts selected; cannot pick one for a turn")
    if turn_index < 0:
        raise IndexError(f"turn_index must be >= 0, got {turn_index}")
    return accounts[turn_index % len(accounts)]


def iter_turn_accounts(accounts: list[CodexAccount], turns: int):
    """Yield the ``CodexAccount`` for each of ``turns`` sequential turns."""
    if turns < 0:
        raise ValueError(f"turns must be >= 0, got {turns}")
    for turn_index in range(turns):
        yield account_for_turn(accounts, turn_index)
