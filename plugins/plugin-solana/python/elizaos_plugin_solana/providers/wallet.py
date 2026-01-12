"""Wallet Provider for Solana.

Provides wallet portfolio information including balances and token holdings.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from decimal import Decimal

from elizaos_plugin_solana.client import SolanaClient
from elizaos_plugin_solana.types import PortfolioItem, WalletPortfolio

logger = logging.getLogger(__name__)

WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112"


@dataclass
class WalletProviderResult:
    """Result of the wallet provider."""

    data: WalletPortfolio
    values: dict[str, str] = field(default_factory=dict)
    text: str = ""


async def get_wallet_portfolio(
    client: SolanaClient,
    agent_name: str | None = None,
) -> WalletProviderResult:
    """Get wallet portfolio information.

    Args:
        client: The Solana client.
        agent_name: Optional agent name for the text output.

    Returns:
        The wallet portfolio result.

    Raises:
        Exception: If fetching portfolio fails.
    """
    agent_name = agent_name or "The agent"
    pubkey = client.public_key
    pubkey_str = str(pubkey)

    logger.info("Fetching wallet portfolio for %s", pubkey_str)

    # Get SOL balance
    try:
        sol_balance = await client.get_sol_balance()
    except Exception as e:
        logger.exception("Failed to get SOL balance")
        raise RuntimeError(f"Failed to get SOL balance: {e}") from e

    # Get token accounts
    try:
        token_accounts = await client.get_token_accounts()
    except Exception:
        logger.warning("Failed to get token accounts, continuing with SOL only")
        token_accounts = []

    # Try to get prices (optional, don't fail if unavailable)
    sol_price: float | None = None
    try:
        prices = await client.get_token_prices([WRAPPED_SOL_MINT])
        sol_price = prices.get(WRAPPED_SOL_MINT)
    except Exception:
        logger.debug("Could not fetch SOL price")

    # Calculate SOL USD value
    sol_value_usd = (
        sol_balance * Decimal(str(sol_price)) if sol_price else Decimal(0)
    )

    # Build portfolio items
    items: list[PortfolioItem] = []

    # Add SOL as first item
    sol_balance_lamports = int(sol_balance * Decimal(1_000_000_000))
    items.append(
        PortfolioItem(
            name="Solana",
            symbol="SOL",
            address=WRAPPED_SOL_MINT,
            decimals=9,
            balance=str(sol_balance_lamports),
            ui_amount=str(sol_balance),
            price_usd=str(sol_price) if sol_price else "0",
            value_usd=str(sol_value_usd),
            value_sol=str(sol_balance),
        )
    )

    # Add token accounts
    for account in token_accounts:
        if account.ui_amount > Decimal(0):
            items.append(
                PortfolioItem(
                    name=account.mint,  # Would need token registry for names
                    symbol="TOKEN",  # Would need token registry for symbols
                    address=account.mint,
                    decimals=account.decimals,
                    balance=account.amount,
                    ui_amount=str(account.ui_amount),
                    price_usd="0",
                    value_usd="0",
                    value_sol=None,
                )
            )

    # Calculate total USD
    total_usd = sol_value_usd

    # Build portfolio
    portfolio = WalletPortfolio(
        total_usd=str(total_usd),
        total_sol=str(sol_balance),
        items=items,
        prices=None,  # Would need to fetch BTC/ETH prices
        last_updated=int(time.time() * 1000),
    )

    # Build values map
    values: dict[str, str] = {
        "total_usd": str(total_usd),
        "total_sol": str(sol_balance),
    }

    if sol_price is not None:
        values["sol_price"] = str(sol_price)

    # Add token values
    for idx, item in enumerate(items):
        values[f"token_{idx}_name"] = item.name
        values[f"token_{idx}_symbol"] = item.symbol
        values[f"token_{idx}_amount"] = str(item.ui_amount)
        values[f"token_{idx}_usd"] = str(item.value_usd)
        if item.value_sol:
            values[f"token_{idx}_sol"] = item.value_sol

    # Build text output
    text = f"\n\n{agent_name}'s Main Solana Wallet ({pubkey_str})\n"
    text += f"Total Value: ${total_usd} ({sol_balance} SOL)\n\n"
    text += "Token Balances:\n"

    if not items:
        text += "No tokens found with non-zero balance\n"
    else:
        for item in items:
            sol_str = f" | {item.value_sol} SOL" if item.value_sol else ""
            text += f"{item.name} ({item.symbol}): {item.ui_amount} (${item.value_usd}{sol_str})\n"

    if sol_price is not None:
        text += f"\nMarket Prices:\nSOL: ${sol_price:.2f}\n"

    return WalletProviderResult(
        data=portfolio,
        values=values,
        text=text,
    )


# Provider definition for elizaOS integration
WALLET_PROVIDER = {
    "name": "solana-wallet",
    "description": "your solana wallet information",
    "dynamic": True,
}
