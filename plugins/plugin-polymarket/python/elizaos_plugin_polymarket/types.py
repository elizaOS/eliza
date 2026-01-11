"""
Type definitions for the Polymarket plugin.

All types are designed for fail-fast validation using Pydantic.
"""

from enum import Enum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_validator


# =============================================================================
# Constants
# =============================================================================

POLYGON_CHAIN_ID = 137
DEFAULT_CLOB_API_URL = "https://clob.polymarket.com"
DEFAULT_CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/"


# =============================================================================
# Token Types
# =============================================================================


class Token(BaseModel):
    """Token representing a binary outcome in a prediction market."""

    model_config = ConfigDict(frozen=True)

    token_id: str = Field(description="ERC1155 token ID")
    outcome: str = Field(description="Human readable outcome (e.g., YES, NO)")


# =============================================================================
# Market Types
# =============================================================================


class Rewards(BaseModel):
    """Rewards configuration for a market."""

    model_config = ConfigDict(frozen=True)

    min_size: float = Field(description="Minimum size of an order to score rewards")
    max_spread: float = Field(description="Maximum spread from midpoint until order scores")
    event_start_date: str = Field(description="String date when event starts")
    event_end_date: str = Field(description="String date when event ends")
    in_game_multiplier: float = Field(description="Reward multiplier while game started")
    reward_epoch: int = Field(description="Current reward epoch")


class Market(BaseModel):
    """Market object representing a Polymarket prediction market."""

    model_config = ConfigDict(frozen=True)

    condition_id: str = Field(description="CTF condition ID")
    question_id: str = Field(description="CTF question ID")
    tokens: tuple[Token, Token] = Field(description="Binary token pair for market")
    rewards: Rewards = Field(description="Rewards related data")
    minimum_order_size: str = Field(description="Minimum limit order size")
    minimum_tick_size: str = Field(description="Minimum tick size in implied probability")
    category: str = Field(description="Market category")
    end_date_iso: str = Field(description="ISO string of market end date")
    game_start_time: str = Field(description="ISO string of game start time")
    question: str = Field(description="Market question")
    market_slug: str = Field(description="Slug of market")
    min_incentive_size: str = Field(description="Minimum resting order size for incentives")
    max_incentive_spread: str = Field(description="Max spread for incentive qualification")
    active: bool = Field(description="Whether market is active/live")
    closed: bool = Field(description="Whether market is closed")
    seconds_delay: int = Field(description="Seconds of match delay for in-game trade")
    icon: str = Field(description="Reference to market icon image")
    fpmm: str = Field(description="Address of associated FPMM on Polygon")


class SimplifiedMarket(BaseModel):
    """Simplified market with reduced fields."""

    model_config = ConfigDict(frozen=True)

    condition_id: str
    tokens: tuple[Token, Token]
    rewards: Rewards
    min_incentive_size: str
    max_incentive_spread: str
    active: bool
    closed: bool


# =============================================================================
# Order Types
# =============================================================================


class OrderSide(str, Enum):
    """Order side enumeration."""

    BUY = "BUY"
    SELL = "SELL"


class OrderType(str, Enum):
    """Order type enumeration."""

    GTC = "GTC"  # Good Till Cancelled
    FOK = "FOK"  # Fill Or Kill
    GTD = "GTD"  # Good Till Date
    FAK = "FAK"  # Fill And Kill


class OrderStatus(str, Enum):
    """Order status enumeration."""

    PENDING = "PENDING"
    OPEN = "OPEN"
    FILLED = "FILLED"
    PARTIALLY_FILLED = "PARTIALLY_FILLED"
    CANCELLED = "CANCELLED"
    EXPIRED = "EXPIRED"
    REJECTED = "REJECTED"


class OrderParams(BaseModel):
    """Parameters for creating orders."""

    model_config = ConfigDict(frozen=True)

    token_id: str = Field(min_length=1, description="Token ID to trade")
    side: OrderSide = Field(description="Order side (BUY or SELL)")
    price: float = Field(ge=0, le=1, description="Price per share (0-1.0)")
    size: float = Field(gt=0, description="Order size")
    order_type: OrderType = Field(default=OrderType.GTC, description="Order type")
    fee_rate_bps: str = Field(default="0", description="Fee rate in basis points")
    expiration: int | None = Field(default=None, description="Order expiration timestamp")
    nonce: int | None = Field(default=None, description="Order nonce")

    @field_validator("price")
    @classmethod
    def validate_price_range(cls, v: float) -> float:
        """Validate price is in valid range."""
        if not 0 <= v <= 1:
            raise ValueError("Price must be between 0 and 1")
        return v


class OrderResponse(BaseModel):
    """Order response from CLOB API."""

    model_config = ConfigDict(frozen=True)

    success: bool
    error_msg: str | None = None
    order_id: str | None = None
    order_hashes: list[str] | None = None
    status: str | None = None


class OpenOrder(BaseModel):
    """Open order details."""

    model_config = ConfigDict(frozen=True)

    order_id: str
    user_id: str
    market_id: str
    token_id: str
    side: OrderSide
    type: str
    status: str
    price: str
    size: str
    filled_size: str
    fees_paid: str
    created_at: str
    updated_at: str


# =============================================================================
# Order Book Types
# =============================================================================


class BookEntry(BaseModel):
    """Order book entry."""

    model_config = ConfigDict(frozen=True)

    price: str
    size: str


class OrderBook(BaseModel):
    """Order book data."""

    model_config = ConfigDict(frozen=True)

    market: str
    asset_id: str
    bids: list[BookEntry]
    asks: list[BookEntry]


# =============================================================================
# Trade Types
# =============================================================================


class TradeStatus(str, Enum):
    """Trade status enumeration."""

    MATCHED = "MATCHED"
    MINED = "MINED"
    CONFIRMED = "CONFIRMED"
    RETRYING = "RETRYING"
    FAILED = "FAILED"


class Trade(BaseModel):
    """Trade data."""

    model_config = ConfigDict(frozen=True)

    id: str
    market: str
    asset_id: str
    side: OrderSide
    price: str
    size: str
    timestamp: str
    status: TradeStatus


class TradeEntry(BaseModel):
    """Trade entry from history."""

    model_config = ConfigDict(frozen=True)

    trade_id: str
    order_id: str
    user_id: str
    market_id: str
    token_id: str
    side: OrderSide
    type: str
    price: str
    size: str
    fees_paid: str
    timestamp: str
    tx_hash: str


# =============================================================================
# Position Types
# =============================================================================


class Position(BaseModel):
    """User position in a market."""

    model_config = ConfigDict(frozen=True)

    market: str
    asset_id: str
    size: str
    average_price: str
    realized_pnl: str
    unrealized_pnl: str


class Balance(BaseModel):
    """User balance data."""

    model_config = ConfigDict(frozen=True)

    asset: str
    balance: str
    symbol: str
    decimals: int


# =============================================================================
# API Key Types
# =============================================================================


class ApiKeyType(str, Enum):
    """API key type."""

    READ_ONLY = "read_only"
    READ_WRITE = "read_write"


class ApiKeyStatus(str, Enum):
    """API key status."""

    ACTIVE = "active"
    REVOKED = "revoked"


class ApiKeyCreds(BaseModel):
    """API key credentials."""

    model_config = ConfigDict(frozen=True)

    key: str = Field(min_length=1)
    secret: str = Field(min_length=1)
    passphrase: str = Field(min_length=1)


class ApiKey(BaseModel):
    """API key details."""

    model_config = ConfigDict(frozen=True)

    key_id: str
    label: str
    type: ApiKeyType
    status: ApiKeyStatus
    created_at: str
    last_used_at: str | None
    is_cert_whitelisted: bool


# =============================================================================
# Response Types
# =============================================================================


class MarketsResponse(BaseModel):
    """Paginated response for markets API."""

    model_config = ConfigDict(frozen=True)

    limit: int
    count: int
    next_cursor: str
    data: list[Market]


class SimplifiedMarketsResponse(BaseModel):
    """Paginated response for simplified markets."""

    model_config = ConfigDict(frozen=True)

    limit: int
    count: int
    next_cursor: str
    data: list[SimplifiedMarket]


class TradesResponse(BaseModel):
    """Paginated response for trades."""

    model_config = ConfigDict(frozen=True)

    data: list[TradeEntry]
    next_cursor: str


# =============================================================================
# Filter Types
# =============================================================================


class MarketFilters(BaseModel):
    """Filter parameters for markets API."""

    model_config = ConfigDict(frozen=True)

    category: str | None = None
    active: bool | None = None
    limit: int | None = None
    next_cursor: str | None = None


class GetTradesParams(BaseModel):
    """Parameters for getting trades."""

    model_config = ConfigDict(frozen=True)

    user_address: str | None = None
    market_id: str | None = None
    token_id: str | None = None
    from_timestamp: int | None = None
    to_timestamp: int | None = None
    limit: int | None = None
    next_cursor: str | None = None


# =============================================================================
# Price Types
# =============================================================================


class TokenPrice(BaseModel):
    """Token price data."""

    model_config = ConfigDict(frozen=True)

    token_id: str
    price: str


class PriceHistoryEntry(BaseModel):
    """Price history entry."""

    model_config = ConfigDict(frozen=True)

    timestamp: str
    price: str
    volume: str | None = None


# =============================================================================
# Error Types
# =============================================================================


class PolymarketErrorCode(str, Enum):
    """Polymarket-specific error codes."""

    INVALID_MARKET = "INVALID_MARKET"
    INVALID_TOKEN = "INVALID_TOKEN"
    INVALID_ORDER = "INVALID_ORDER"
    INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS"
    MARKET_CLOSED = "MARKET_CLOSED"
    API_ERROR = "API_ERROR"
    WEBSOCKET_ERROR = "WEBSOCKET_ERROR"
    AUTH_ERROR = "AUTH_ERROR"
    CONFIG_ERROR = "CONFIG_ERROR"


class PolymarketError(Exception):
    """Polymarket-specific error."""

    def __init__(
        self,
        code: PolymarketErrorCode,
        message: str,
        cause: Exception | None = None,
    ) -> None:
        """Initialize error."""
        super().__init__(message)
        self.code = code
        self.cause = cause


