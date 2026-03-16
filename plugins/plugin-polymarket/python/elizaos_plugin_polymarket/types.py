from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Token(BaseModel):
    model_config = ConfigDict(frozen=True)

    token_id: str
    outcome: str


class Rewards(BaseModel):
    model_config = ConfigDict(frozen=True)

    min_size: float
    max_spread: float
    event_start_date: str
    event_end_date: str
    in_game_multiplier: float
    reward_epoch: int


class Market(BaseModel):
    model_config = ConfigDict(frozen=True)

    condition_id: str
    question_id: str
    tokens: tuple[Token, Token]
    rewards: Rewards
    minimum_order_size: str
    minimum_tick_size: str
    category: str
    end_date_iso: str
    game_start_time: str
    question: str
    market_slug: str
    min_incentive_size: str
    max_incentive_spread: str
    active: bool
    closed: bool
    seconds_delay: int
    icon: str
    fpmm: str


class SimplifiedMarket(BaseModel):
    model_config = ConfigDict(frozen=True)

    condition_id: str
    tokens: tuple[Token, Token]
    rewards: Rewards
    min_incentive_size: str
    max_incentive_spread: str
    active: bool
    closed: bool


class OrderSide(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class OrderType(str, Enum):
    GTC = "GTC"
    FOK = "FOK"
    GTD = "GTD"
    FAK = "FAK"


class OrderStatus(str, Enum):
    MATCHED = "MATCHED"
    PENDING = "PENDING"
    OPEN = "OPEN"
    FILLED = "FILLED"
    PARTIALLY_FILLED = "PARTIALLY_FILLED"
    CANCELLED = "CANCELLED"
    EXPIRED = "EXPIRED"
    REJECTED = "REJECTED"


class OrderParams(BaseModel):
    model_config = ConfigDict(frozen=True)

    token_id: str = Field(min_length=1)
    side: OrderSide
    price: float = Field(ge=0, le=1)
    size: float = Field(gt=0)
    order_type: OrderType = Field(default=OrderType.GTC)
    fee_rate_bps: str = Field(default="0")
    expiration: int | None = Field(default=None)
    nonce: int | None = Field(default=None)

    @field_validator("price")
    @classmethod
    def validate_price_range(cls, v: float) -> float:
        if not 0 <= v <= 1:
            raise ValueError("Price must be between 0 and 1")
        return v


class OrderResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    success: bool
    error_msg: str | None = None
    order_id: str | None = None
    order_hashes: list[str] | None = None
    status: str | None = None


class OpenOrder(BaseModel):
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


class BookEntry(BaseModel):
    model_config = ConfigDict(frozen=True)

    price: str
    size: str


class OrderBook(BaseModel):
    model_config = ConfigDict(frozen=True)

    market: str
    asset_id: str
    bids: list[BookEntry]
    asks: list[BookEntry]


class TradeStatus(str, Enum):
    MATCHED = "MATCHED"
    MINED = "MINED"
    CONFIRMED = "CONFIRMED"
    RETRYING = "RETRYING"
    FAILED = "FAILED"


class Trade(BaseModel):
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


class Position(BaseModel):
    model_config = ConfigDict(frozen=True)

    market: str
    asset_id: str
    size: str
    average_price: str
    realized_pnl: str
    unrealized_pnl: str


class BalanceAllowance(BaseModel):
    model_config = ConfigDict(frozen=True)

    balance: str
    allowance: str


class Balance(BaseModel):
    model_config = ConfigDict(frozen=True)

    asset: str
    balance: str
    symbol: str
    decimals: int


class ApiKeyType(str, Enum):
    READ_ONLY = "read_only"
    READ_WRITE = "read_write"


class ApiKeyStatus(str, Enum):
    ACTIVE = "active"
    REVOKED = "revoked"


class ApiKeyCreds(BaseModel):
    model_config = ConfigDict(frozen=True)

    key: str = Field(min_length=1)
    secret: str = Field(min_length=1)
    passphrase: str = Field(min_length=1)


class ApiKey(BaseModel):
    model_config = ConfigDict(frozen=True)

    key_id: str
    label: str
    type: ApiKeyType
    status: ApiKeyStatus
    created_at: str
    last_used_at: str | None
    is_cert_whitelisted: bool


class MarketsResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    limit: int
    count: int
    next_cursor: str
    data: list[Market]


class SimplifiedMarketsResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    limit: int
    count: int
    next_cursor: str
    data: list[SimplifiedMarket]


class TradesResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    data: list[TradeEntry]
    next_cursor: str


class MarketFilters(BaseModel):
    model_config = ConfigDict(frozen=True)

    category: str | None = None
    active: bool | None = None
    limit: int | None = None
    next_cursor: str | None = None


class GetTradesParams(BaseModel):
    model_config = ConfigDict(frozen=True)

    user_address: str | None = None
    market_id: str | None = None
    token_id: str | None = None
    from_timestamp: int | None = None
    to_timestamp: int | None = None
    limit: int | None = None
    next_cursor: str | None = None


class TokenPrice(BaseModel):
    model_config = ConfigDict(frozen=True)

    token_id: str
    price: str


class PriceHistoryEntry(BaseModel):
    model_config = ConfigDict(frozen=True)

    timestamp: str
    price: str
    volume: str | None = None
