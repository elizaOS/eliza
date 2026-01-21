"""
Search Markets Action

Action for searching markets using the Polymarket Gamma API public-search endpoint.
Supports searching for markets by keywords like "miami heat", "epstein", "bitcoin", etc.
"""

from dataclasses import dataclass

import httpx

from elizaos_plugin_polymarket.constants import GAMMA_API_URL


@dataclass(frozen=True)
class GammaMarket:
    """Market from Gamma API search response."""

    id: str
    question: str
    condition_id: str
    slug: str
    description: str
    outcomes: list[str]
    outcome_prices: list[float]
    volume: str
    liquidity: str
    active: bool
    closed: bool
    end_date: str
    archived: bool = False
    image: str | None = None
    icon: str | None = None
    clob_token_ids: str | None = None
    volume_24hr: float | None = None
    best_bid: float | None = None
    best_ask: float | None = None
    last_trade_price: float | None = None


@dataclass(frozen=True)
class GammaEvent:
    """Event from Gamma API search response."""

    id: str
    title: str
    slug: str
    description: str
    active: bool
    closed: bool
    markets: list[GammaMarket]
    volume: float | None = None
    liquidity: float | None = None
    image: str | None = None
    icon: str | None = None


@dataclass(frozen=True)
class GammaTag:
    """Tag from Gamma API search response."""

    id: str
    label: str
    slug: str
    event_count: int | None = None


@dataclass(frozen=True)
class SearchResult:
    """Search result."""

    query: str
    total_results: int
    displayed_results: int
    has_more: bool
    markets: list[GammaMarket]
    tags: list[GammaTag]


def _parse_outcomes(outcomes_str: str) -> list[str]:
    """Parse outcomes JSON string to list."""
    import json

    try:
        parsed = json.loads(outcomes_str)
        return parsed if isinstance(parsed, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def _parse_outcome_prices(prices_str: str) -> list[float]:
    """Parse outcome prices JSON string to list of floats."""
    import json

    try:
        parsed = json.loads(prices_str)
        if isinstance(parsed, list):
            return [float(p) for p in parsed]
        return []
    except (json.JSONDecodeError, TypeError, ValueError):
        return []


def _format_price(price: float) -> str:
    """Format price as percentage."""
    return f"{price * 100:.1f}%"


def _format_volume(volume: str | float) -> str:
    """Format volume with appropriate suffix."""
    num = float(volume) if isinstance(volume, str) else volume
    if num >= 1_000_000:
        return f"${num / 1_000_000:.2f}M"
    if num >= 1_000:
        return f"${num / 1_000:.1f}K"
    return f"${num:.0f}"


def _market_from_dict(data: dict) -> GammaMarket:
    """Create GammaMarket from API response dict."""
    return GammaMarket(
        id=data.get("id", ""),
        question=data.get("question", ""),
        condition_id=data.get("conditionId", ""),
        slug=data.get("slug", ""),
        description=data.get("description", ""),
        outcomes=_parse_outcomes(data.get("outcomes", "[]")),
        outcome_prices=_parse_outcome_prices(data.get("outcomePrices", "[]")),
        volume=data.get("volume", "0"),
        liquidity=data.get("liquidity", "0"),
        active=data.get("active", False),
        closed=data.get("closed", False),
        end_date=data.get("endDate", ""),
        archived=data.get("archived", False),
        image=data.get("image"),
        icon=data.get("icon"),
        clob_token_ids=data.get("clobTokenIds"),
        volume_24hr=data.get("volume24hr"),
        best_bid=data.get("bestBid"),
        best_ask=data.get("bestAsk"),
        last_trade_price=data.get("lastTradePrice"),
    )


async def search_markets(
    query: str,
    limit: int = 10,
    active_only: bool = False,
    runtime: object | None = None,
) -> SearchResult:
    """
    Search for Polymarket prediction markets by keyword.

    Uses the Gamma API public-search endpoint to find markets matching
    the search query. No authentication required.

    Args:
        query: Search term to look up
        limit: Maximum number of results to return (default: 10, max: 25)
        active_only: If True, only return active (non-closed) markets
        runtime: Optional runtime for settings (not required for public API)

    Returns:
        SearchResult with matching markets and metadata

    Raises:
        httpx.HTTPError: If the API request fails
    """
    params: dict[str, str | int] = {
        "q": query,
        "limit_per_type": min(limit, 25),
    }

    if active_only:
        params["events_status"] = "active"

    search_url = f"{GAMMA_API_URL}/public-search"

    async with httpx.AsyncClient() as client:
        response = await client.get(search_url, params=params, timeout=30.0)
        response.raise_for_status()
        data = response.json()

    # Extract markets from events
    all_markets: list[GammaMarket] = []
    events = data.get("events", [])

    for event in events:
        event_markets = event.get("markets", [])
        for market_data in event_markets:
            market = _market_from_dict(market_data)
            # Apply active filter if requested
            if active_only and (not market.active or market.closed):
                continue
            all_markets.append(market)

    # Limit results
    limited_markets = all_markets[:limit]

    # Extract tags
    tags: list[GammaTag] = []
    for tag_data in data.get("tags", []):
        tags.append(
            GammaTag(
                id=tag_data.get("id", ""),
                label=tag_data.get("label", ""),
                slug=tag_data.get("slug", ""),
                event_count=tag_data.get("event_count"),
            )
        )

    return SearchResult(
        query=query,
        total_results=len(all_markets),
        displayed_results=len(limited_markets),
        has_more=len(all_markets) > limit,
        markets=limited_markets,
        tags=tags,
    )


def format_search_results(result: SearchResult) -> str:
    """Format search results for display."""
    lines = [f'🔍 **Search Results for "{result.query}"**\n']

    if not result.markets:
        lines.append(f'No markets found matching "{result.query}".')
        lines.append("\n💡 *Try different keywords or check the spelling.*")
        return "\n".join(lines)

    lines.append(f"Found {result.total_results} market(s):\n")

    for i, market in enumerate(result.markets, 1):
        status_emoji = "🟢" if market.active and not market.closed else "🔴"
        lines.append(f"**{i}. {market.question}** {status_emoji}")

        # Show outcomes and prices
        if market.outcomes and market.outcome_prices:
            price_parts = [
                f"{outcome}: {_format_price(price)}"
                for outcome, price in zip(market.outcomes, market.outcome_prices, strict=True)
            ]
            lines.append(f"   📊 {' | '.join(price_parts)}")

        if market.volume:
            volume_str = f"   💰 Volume: {_format_volume(market.volume)}"
            if market.volume_24hr:
                volume_str += f" (24h: {_format_volume(market.volume_24hr)})"
            lines.append(volume_str)

        if market.end_date:
            lines.append(f"   ⏰ Ends: {market.end_date[:10]}")

        if market.condition_id:
            lines.append(f"   🔑 ID: `{market.condition_id[:16]}...`")

        if market.clob_token_ids:
            lines.append("   🏷️ Token IDs available for trading")

        lines.append("")

    if result.has_more:
        lines.append(
            f"\n📄 *Showing {result.displayed_results} of {result.total_results} results. "
            "Increase limit to see more.*"
        )

    if result.tags:
        tag_labels = ", ".join(t.label for t in result.tags[:5])
        lines.append(f"\n🏷️ *Related tags: {tag_labels}*")

    return "\n".join(lines)
