from decimal import Decimal

from pydantic import BaseModel, Field


class PriceInfo(BaseModel):
    usd: str = Field(description="Price in USD")


class Prices(BaseModel):
    """Price information for major cryptocurrencies."""

    solana: PriceInfo
    bitcoin: PriceInfo
    ethereum: PriceInfo


class PortfolioItem(BaseModel):
    name: str = Field(description="Token name")
    address: str = Field(description="Token mint address")
    symbol: str = Field(description="Token symbol")
    decimals: int = Field(ge=0, le=18, description="Token decimals")
    balance: str = Field(description="Raw balance as string")
    ui_amount: str = Field(alias="uiAmount", description="UI-friendly amount")
    price_usd: str = Field(alias="priceUsd", description="Price in USD")
    value_usd: str = Field(alias="valueUsd", description="Value in USD")
    value_sol: str | None = Field(default=None, alias="valueSol", description="Value in SOL")

    model_config = {"populate_by_name": True}


class WalletPortfolio(BaseModel):
    total_usd: str = Field(alias="totalUsd", description="Total value in USD")
    total_sol: str | None = Field(default=None, alias="totalSol", description="Total value in SOL")
    items: list[PortfolioItem] = Field(description="List of token holdings")
    prices: Prices | None = Field(default=None, description="Market prices")
    last_updated: int | None = Field(
        default=None, alias="lastUpdated", description="Last update timestamp in ms"
    )

    model_config = {"populate_by_name": True}


class TokenAccountInfo(BaseModel):
    mint: str = Field(description="Mint address")
    owner: str = Field(description="Owner address")
    amount: str = Field(description="Raw amount as string")
    decimals: int = Field(ge=0, le=18, description="Decimals")
    ui_amount: Decimal = Field(alias="uiAmount", description="UI amount")

    model_config = {"populate_by_name": True}


class TransferParams(BaseModel):
    recipient: str = Field(description="Recipient address")
    amount: Decimal = Field(gt=0, description="Amount to transfer")
    mint: str | None = Field(default=None, description="Token mint address (None for SOL)")


class TransferResult(BaseModel):
    success: bool = Field(description="Whether the transfer was successful")
    signature: str | None = Field(default=None, description="Transaction signature")
    amount: str = Field(description="Amount transferred")
    recipient: str = Field(description="Recipient address")
    error: str | None = Field(default=None, description="Error message if failed")


class SwapQuoteParams(BaseModel):
    input_mint: str = Field(alias="inputMint", description="Input token mint address")
    output_mint: str = Field(alias="outputMint", description="Output token mint address")
    amount: str = Field(description="Amount in base units")
    slippage_bps: int = Field(
        default=50,
        ge=0,
        le=10000,
        alias="slippageBps",
        description="Slippage in basis points (100 = 1%)",
    )

    model_config = {"populate_by_name": True}


class SwapInfo(BaseModel):
    amm_key: str = Field(alias="ammKey", description="AMM key")
    label: str = Field(description="DEX label")
    input_mint: str = Field(alias="inputMint", description="Input mint")
    output_mint: str = Field(alias="outputMint", description="Output mint")
    in_amount: str = Field(alias="inAmount", description="Input amount")
    out_amount: str = Field(alias="outAmount", description="Output amount")
    fee_amount: str = Field(alias="feeAmount", description="Fee amount")
    fee_mint: str = Field(alias="feeMint", description="Fee mint")

    model_config = {"populate_by_name": True}


class RoutePlanStep(BaseModel):
    swap_info: SwapInfo = Field(alias="swapInfo", description="Swap info for this step")
    percent: int = Field(ge=0, le=100, description="Percentage of input routed")

    model_config = {"populate_by_name": True}


class SwapQuote(BaseModel):
    input_mint: str = Field(alias="inputMint", description="Input token mint")
    in_amount: str = Field(alias="inAmount", description="Input amount in base units")
    output_mint: str = Field(alias="outputMint", description="Output token mint")
    out_amount: str = Field(alias="outAmount", description="Output amount in base units")
    other_amount_threshold: str = Field(
        alias="otherAmountThreshold", description="Minimum output after slippage"
    )
    swap_mode: str = Field(alias="swapMode", description="Swap mode (ExactIn or ExactOut)")
    slippage_bps: int = Field(alias="slippageBps", description="Slippage in basis points")
    price_impact_pct: str = Field(alias="priceImpactPct", description="Price impact percentage")
    route_plan: list[RoutePlanStep] = Field(alias="routePlan", description="Route plan")

    model_config = {"populate_by_name": True}


class SwapResult(BaseModel):
    success: bool = Field(description="Whether the swap was successful")
    signature: str | None = Field(default=None, description="Transaction signature")
    in_amount: str | None = Field(default=None, alias="inAmount", description="Input amount")
    out_amount: str | None = Field(default=None, alias="outAmount", description="Output amount")
    error: str | None = Field(default=None, description="Error message if failed")

    model_config = {"populate_by_name": True}


class SwapTransaction(BaseModel):
    swap_transaction: str = Field(
        alias="swapTransaction", description="Base64-encoded versioned transaction"
    )
    last_valid_block_height: int = Field(
        alias="lastValidBlockHeight", description="Last valid block height"
    )
    prioritization_fee_lamports: int = Field(
        default=0,
        alias="prioritizationFeeLamports",
        description="Prioritization fee in lamports",
    )

    model_config = {"populate_by_name": True}


class BirdeyePriceData(BaseModel):
    value: float = Field(description="Token price in USD")
    update_unix_time: int = Field(alias="updateUnixTime", description="Update timestamp")

    model_config = {"populate_by_name": True}


class BirdeyePriceResponse(BaseModel):
    success: bool = Field(description="Whether the request was successful")
    data: BirdeyePriceData = Field(description="Price data")
