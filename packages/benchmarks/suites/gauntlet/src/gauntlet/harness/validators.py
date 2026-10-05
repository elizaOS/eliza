"""Fail-closed intent validation for Solana Gauntlet live transactions.

Successful execution alone does not prove the requested trade or transfer.
No live instruction decoder is currently implemented by this suite.
"""

from typing import Any


def validate_transaction(
    tx_bytes: bytes, task_type: str, parameters: dict[str, Any]
) -> tuple[bool, str | None]:
    if not tx_bytes:
        return False, "Empty transaction"
    return False, f"Live transaction intent validation is unavailable for {task_type!r}"
