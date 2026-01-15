"""
Balance actions for Polymarket.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable
from typing import Protocol, cast

from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode
from elizaos_plugin_polymarket.providers import get_clob_client
from elizaos_plugin_polymarket.types import BalanceAllowance


class RuntimeProtocol(Protocol):
    """Protocol for agent runtime."""

    def get_setting(self, key: str) -> str | None:
        """Get a setting value."""
        ...


def _coerce_str(value: object) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, int | float):
        return str(value)
    return None


def _resolve_asset_type(label: str) -> object:
    try:
        types_mod = importlib.import_module("py_clob_client.clob_types")
        asset_type = getattr(types_mod, "AssetType", None)
        if asset_type is not None:
            resolved = getattr(asset_type, label, None)
            if resolved is not None:
                return resolved
    except Exception:
        return label
    return label


def _get_balance_allowance(
    client: object,
    asset_type: object,
    token_id: str | None = None,
) -> BalanceAllowance:
    get_balance_allowance = getattr(client, "get_balance_allowance", None)
    if not callable(get_balance_allowance):
        get_balance_allowance = getattr(client, "getBalanceAllowance", None)
    if not callable(get_balance_allowance):
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            "get_balance_allowance method not available in CLOB client",
        )

    response_obj = cast(Callable[..., object], get_balance_allowance)(
        asset_type=asset_type, token_id=token_id
    )
    response = response_obj if isinstance(response_obj, dict) else {}
    balance = _coerce_str(response.get("balance")) or "0"
    allowance = _coerce_str(response.get("allowance")) or "0"
    return BalanceAllowance(balance=balance, allowance=allowance)


async def get_balances(
    token_ids: list[str] | None = None,
    include_collateral: bool = True,
    include_conditional: bool = True,
    max_tokens: int = 25,
    runtime: RuntimeProtocol | None = None,
) -> dict[str, object]:
    """
    Get collateral (USDC) and conditional token balances for a wallet.

    Args:
        token_ids: Optional list of token IDs for conditional balances
        include_collateral: Include collateral USDC balance
        include_conditional: Include conditional token balances
        max_tokens: Max number of token balances to fetch
        runtime: Optional agent runtime for settings

    Returns:
        Dictionary containing collateral balance and per-token balances

    Raises:
        PolymarketError: If fetching balances fails
    """
    if not include_collateral and not include_conditional:
        raise PolymarketError(
            PolymarketErrorCode.INVALID_ORDER,
            "At least one of include_collateral or include_conditional must be true",
        )

    try:
        client = get_clob_client(runtime)
        collateral: BalanceAllowance | None = None
        token_balances: dict[str, BalanceAllowance] = {}

        if include_collateral:
            asset_type = _resolve_asset_type("COLLATERAL")
            collateral = _get_balance_allowance(client, asset_type)

        if include_conditional:
            asset_type = _resolve_asset_type("CONDITIONAL")
            resolved_tokens = token_ids or []
            if max_tokens > 0:
                resolved_tokens = resolved_tokens[:max_tokens]
            for token_id in resolved_tokens:
                token_balances[token_id] = _get_balance_allowance(client, asset_type, token_id)

        return {
            "collateral": collateral,
            "token_balances": token_balances,
            "token_count": len(token_balances),
        }
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch balances: {e}",
            cause=e,
        ) from e
