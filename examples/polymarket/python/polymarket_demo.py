from __future__ import annotations

import argparse
import asyncio
import pathlib
import os
import re
import sys
import time
from dataclasses import dataclass

HERE = pathlib.Path(__file__).resolve()
REPO_ROOT = HERE.parents[3]

# Allow running from the repo without installing packages.
for rel in ("packages/python", "plugins/plugin-evm/python", "plugins/plugin-polymarket/python"):
    p = REPO_ROOT / rel
    if p.exists():
        sys.path.insert(0, str(p))

from elizaos_plugin_evm.providers.wallet import EVMWalletProvider  # noqa: E402
from elizaos_plugin_polymarket.providers.clob import ClobClientProvider  # noqa: E402


_PRIVATE_KEY_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")


@dataclass(frozen=True)
class Options:
    command: str
    network: bool
    execute: bool
    iterations: int
    interval_ms: int
    order_size: float
    max_pages: int
    private_key: str | None
    clob_api_url: str | None


def _normalize_private_key(raw: str) -> str:
    key = raw.strip()
    if not key.startswith("0x"):
        key = f"0x{key}"
    if not _PRIVATE_KEY_RE.match(key):
        raise ValueError("Invalid private key format (expected 0x + 64 hex chars)")
    return key


def _load_private_key() -> str:
    raw = (
        os.getenv("EVM_PRIVATE_KEY")
        or os.getenv("POLYMARKET_PRIVATE_KEY")
        or os.getenv("WALLET_PRIVATE_KEY")
        or os.getenv("PRIVATE_KEY")
    )
    if raw is None:
        raise ValueError("Missing private key. Set EVM_PRIVATE_KEY (recommended).")
    return _normalize_private_key(raw)


def _has_creds() -> bool:
    key = os.getenv("CLOB_API_KEY")
    secret = os.getenv("CLOB_API_SECRET") or os.getenv("CLOB_SECRET")
    passphrase = os.getenv("CLOB_API_PASSPHRASE") or os.getenv("CLOB_PASS_PHRASE")
    return bool(key and secret and passphrase)


def _parse_args() -> Options:
    parser = argparse.ArgumentParser(prog="polymarket_demo.py", add_help=True)
    parser.add_argument("command", choices=["verify", "once", "run"])
    parser.add_argument("--network", action="store_true", help="Perform network calls (CLOB API)")
    parser.add_argument("--execute", action="store_true", help="Place orders (requires CLOB creds)")
    parser.add_argument("--iterations", type=int, default=10)
    parser.add_argument("--interval-ms", type=int, default=30_000)
    parser.add_argument("--order-size", type=float, default=1.0)
    parser.add_argument("--max-pages", type=int, default=1)
    parser.add_argument(
        "--private-key",
        type=str,
        default=None,
        help="Private key (overrides env vars; accepts with/without 0x).",
    )
    parser.add_argument(
        "--clob-api-url",
        type=str,
        default=None,
        help="CLOB API URL (overrides env var).",
    )
    args = parser.parse_args()

    return Options(
        command=str(args.command),
        network=bool(args.network),
        execute=bool(args.execute),
        iterations=int(args.iterations),
        interval_ms=int(args.interval_ms),
        order_size=float(args.order_size),
        max_pages=int(args.max_pages),
        private_key=str(args.private_key) if args.private_key is not None else None,
        clob_api_url=str(args.clob_api_url) if args.clob_api_url is not None else None,
    )


def verify(opts: Options) -> None:
    private_key = _normalize_private_key(opts.private_key) if opts.private_key else _load_private_key()
    os.environ["EVM_PRIVATE_KEY"] = private_key
    os.environ["POLYMARKET_PRIVATE_KEY"] = private_key
    if opts.clob_api_url:
        os.environ["CLOB_API_URL"] = opts.clob_api_url

    evm = EVMWalletProvider(private_key)
    poly = ClobClientProvider()
    addr_poly = poly.get_wallet_address()
    if addr_poly.lower() != evm.address.lower():
        raise RuntimeError(
            f"Wallet mismatch: plugin-polymarket={addr_poly} plugin-evm={evm.address}"
        )

    print("✅ wallet address (plugin-evm):       ", evm.address)
    print("✅ wallet address (plugin-polymarket):", addr_poly)
    print("✅ clob api url:", os.getenv("CLOB_API_URL") or "https://clob.polymarket.com")
    print("✅ execute enabled:", str(opts.execute))
    print("✅ creds present:", str(_has_creds()))

    if opts.network:
        client = poly.get_client()
        # py-clob-client is untyped for mypy in this repo, so keep usage minimal.
        markets_resp = getattr(client, "get_markets")()
        data = getattr(markets_resp, "data", None)
        count = len(data) if isinstance(data, list) else 0
        print("🌐 network ok: fetched markets =", str(count))


def _pick_first_active_market(client: object, max_pages: int) -> tuple[str, str, float]:
    cursor: str | None = None
    for _ in range(max_pages):
        resp = getattr(client, "get_markets")(cursor)
        markets = getattr(resp, "data", None)
        if not isinstance(markets, list):
            continue
        for m in markets:
            active = bool(getattr(m, "active", False))
            closed = bool(getattr(m, "closed", False))
            if not active or closed:
                continue
            tokens = getattr(m, "tokens", None)
            if not isinstance(tokens, list) or len(tokens) < 1:
                continue
            tok0 = tokens[0]
            token_id = str(getattr(tok0, "token_id", "")).strip()
            if not token_id:
                continue
            question = str(getattr(m, "question", "")).strip()
            condition_id = str(getattr(m, "condition_id", "")).strip()
            label = question if question else condition_id
            tick_raw = getattr(m, "minimum_tick_size", None)
            try:
                tick = float(tick_raw) if tick_raw is not None else 0.001
            except (TypeError, ValueError):
                tick = 0.001
            return token_id, label, tick if tick > 0 else 0.001
        cursor_val = getattr(resp, "next_cursor", None)
        cursor = str(cursor_val) if cursor_val else None
    raise RuntimeError("No active market found")


def once(opts: Options) -> None:
    if not opts.network:
        raise RuntimeError("The 'once' command requires --network (it fetches markets + order book).")

    private_key = _normalize_private_key(opts.private_key) if opts.private_key else _load_private_key()
    os.environ["EVM_PRIVATE_KEY"] = private_key
    os.environ["POLYMARKET_PRIVATE_KEY"] = private_key
    if opts.clob_api_url:
        os.environ["CLOB_API_URL"] = opts.clob_api_url

    provider = ClobClientProvider()
    public_client = provider.get_client()

    token_id, label, tick = _pick_first_active_market(public_client, opts.max_pages)
    book = getattr(public_client, "get_order_book")(token_id)
    bids = getattr(book, "bids", [])
    asks = getattr(book, "asks", [])

    best_bid = float(getattr(bids[0], "price")) if isinstance(bids, list) and bids else None
    best_ask = float(getattr(asks[0], "price")) if isinstance(asks, list) and asks else None
    if best_bid is None or best_ask is None:
        print("No usable bid/ask; skipping:", token_id)
        return

    spread = best_ask - best_bid
    midpoint = (best_ask + best_bid) / 2.0
    price = max(0.01, min(0.99, midpoint - tick))

    print("🎯 market:", label)
    print("🔑 token:", token_id)
    print(f"📈 bestBid: {best_bid:.4f} bestAsk: {best_ask:.4f}")
    print(f"📏 spread: {spread:.4f} midpoint: {midpoint:.4f}")
    print(f"🧪 decision: BUY {opts.order_size} at {price:.4f}")

    if not opts.execute:
        print("🧊 dry-run: not placing order (pass --execute to place)")
        return

    if not _has_creds():
        raise RuntimeError(
            "Missing CLOB API credentials for --execute. "
            "Set CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE."
        )

    from elizaos_plugin_polymarket.actions.orders import place_order as place_order_action
    from elizaos_plugin_polymarket.types import OrderParams, OrderSide, OrderType

    result = asyncio.run(
        place_order_action(
            OrderParams(
                token_id=token_id,
                side=OrderSide.BUY,
                price=price,
                size=float(opts.order_size),
                fee_rate_bps=0,
                order_type=OrderType.GTC,
            )
        )
    )
    print("✅ order response:", result)


def run(opts: Options) -> None:
    for i in range(opts.iterations):
        once(opts)
        if i + 1 < opts.iterations:
            time.sleep(max(0.1, opts.interval_ms / 1000.0))


def main() -> None:
    opts = _parse_args()
    if opts.execute and not _has_creds():
        raise RuntimeError(
            "Missing CLOB API credentials for --execute. "
            "Set CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE."
        )

    if opts.command == "verify":
        verify(opts)
        return
    if opts.command == "once":
        once(opts)
        return
    if opts.command == "run":
        run(opts)
        return
    raise RuntimeError(f"Unknown command: {opts.command}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        raise SystemExit(str(e)) from e

