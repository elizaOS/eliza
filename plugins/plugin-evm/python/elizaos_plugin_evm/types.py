from enum import Enum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SupportedChain(str, Enum):
    MAINNET = "mainnet"
    SEPOLIA = "sepolia"
    BASE = "base"
    BASE_SEPOLIA = "baseSepolia"
    ARBITRUM = "arbitrum"
    OPTIMISM = "optimism"
    POLYGON = "polygon"
    AVALANCHE = "avalanche"
    BSC = "bsc"
    GNOSIS = "gnosis"
    FANTOM = "fantom"
    LINEA = "linea"
    SCROLL = "scroll"
    ZKSYNC = "zksync"

    @property
    def chain_id(self) -> int:
        chain_ids = {
            SupportedChain.MAINNET: 1,
            SupportedChain.SEPOLIA: 11155111,
            SupportedChain.BASE: 8453,
            SupportedChain.BASE_SEPOLIA: 84532,
            SupportedChain.ARBITRUM: 42161,
            SupportedChain.OPTIMISM: 10,
            SupportedChain.POLYGON: 137,
            SupportedChain.AVALANCHE: 43114,
            SupportedChain.BSC: 56,
            SupportedChain.GNOSIS: 100,
            SupportedChain.FANTOM: 250,
            SupportedChain.LINEA: 59144,
            SupportedChain.SCROLL: 534352,
            SupportedChain.ZKSYNC: 324,
        }
        return chain_ids[self]

    @property
    def native_symbol(self) -> str:
        symbols = {
            SupportedChain.MAINNET: "ETH",
            SupportedChain.SEPOLIA: "ETH",
            SupportedChain.BASE: "ETH",
            SupportedChain.BASE_SEPOLIA: "ETH",
            SupportedChain.ARBITRUM: "ETH",
            SupportedChain.OPTIMISM: "ETH",
            SupportedChain.POLYGON: "MATIC",
            SupportedChain.AVALANCHE: "AVAX",
            SupportedChain.BSC: "BNB",
            SupportedChain.GNOSIS: "xDAI",
            SupportedChain.FANTOM: "FTM",
            SupportedChain.LINEA: "ETH",
            SupportedChain.SCROLL: "ETH",
            SupportedChain.ZKSYNC: "ETH",
        }
        return symbols[self]

    @property
    def default_rpc(self) -> str:
        rpcs = {
            SupportedChain.MAINNET: "https://eth.llamarpc.com",
            SupportedChain.SEPOLIA: "https://ethereum-sepolia-rpc.publicnode.com",
            SupportedChain.BASE: "https://mainnet.base.org",
            SupportedChain.BASE_SEPOLIA: "https://sepolia.base.org",
            SupportedChain.ARBITRUM: "https://arb1.arbitrum.io/rpc",
            SupportedChain.OPTIMISM: "https://mainnet.optimism.io",
            SupportedChain.POLYGON: "https://polygon-rpc.com",
            SupportedChain.AVALANCHE: "https://api.avax.network/ext/bc/C/rpc",
            SupportedChain.BSC: "https://bsc-dataseed.binance.org",
            SupportedChain.GNOSIS: "https://rpc.gnosischain.com",
            SupportedChain.FANTOM: "https://rpc.ftm.tools",
            SupportedChain.LINEA: "https://rpc.linea.build",
            SupportedChain.SCROLL: "https://rpc.scroll.io",
            SupportedChain.ZKSYNC: "https://mainnet.era.zksync.io",
        }
        return rpcs[self]

    @property
    def is_testnet(self) -> bool:
        return self in {SupportedChain.SEPOLIA, SupportedChain.BASE_SEPOLIA}


# Type aliases
Address = Annotated[str, Field(pattern=r"^0x[a-fA-F0-9]{40}$")]
TxHash = Annotated[str, Field(pattern=r"^0x[a-fA-F0-9]{64}$")]
HexData = Annotated[str, Field(pattern=r"^0x[a-fA-F0-9]*$")]
PositiveAmount = Annotated[str, Field(pattern=r"^\d+\.?\d*$")]


class Transaction(BaseModel):
    model_config = ConfigDict(frozen=True)

    hash: TxHash
    from_address: Address = Field(alias="from")
    to_address: Address = Field(alias="to")
    value: int
    data: HexData | None = None
    chain_id: int | None = None


class TokenInfo(BaseModel):
    model_config = ConfigDict(frozen=True)

    address: Address
    symbol: str
    name: str
    decimals: int = Field(ge=0, le=18)
    chain_id: int
    logo_uri: str | None = None


class WalletBalance(BaseModel):
    model_config = ConfigDict(frozen=True)

    chain: SupportedChain
    address: Address
    native_balance: str
    tokens: list["TokenWithBalance"] = Field(default_factory=list)


class TokenWithBalance(BaseModel):
    model_config = ConfigDict(frozen=True)

    token: TokenInfo
    balance: int
    formatted_balance: str
    price_usd: str | None = None
    value_usd: str | None = None


class TransferParams(BaseModel):
    model_config = ConfigDict(frozen=True)

    from_chain: SupportedChain
    to_address: Address
    amount: PositiveAmount
    data: HexData | None = None
    token: Address | None = None

    @field_validator("amount")
    @classmethod
    def validate_amount_positive(cls, v: str) -> str:
        """Validate that amount is positive."""
        if float(v) <= 0:
            raise ValueError("Amount must be positive")
        return v

    @field_validator("to_address")
    @classmethod
    def validate_not_zero_address(cls, v: str) -> str:
        if v == "0x0000000000000000000000000000000000000000":
            raise ValueError("Recipient address cannot be zero")
        return v


class SwapParams(BaseModel):
    model_config = ConfigDict(frozen=True)

    chain: SupportedChain
    from_token: Address
    to_token: Address
    amount: PositiveAmount
    slippage: float | None = Field(default=None, ge=0, le=1)

    @field_validator("amount")
    @classmethod
    def validate_amount_positive(cls, v: str) -> str:
        if float(v) <= 0:
            raise ValueError("Amount must be positive")
        return v

    @field_validator("to_token")
    @classmethod
    def validate_different_tokens(cls, v: str, info) -> str:
        from_token = info.data.get("from_token")
        if from_token and v.lower() == from_token.lower():
            raise ValueError("From and to tokens must be different")
        return v


class SwapQuote(BaseModel):
    model_config = ConfigDict(frozen=True)

    aggregator: str
    min_output_amount: str
    to: Address
    value: int
    data: HexData
    gas_limit: int | None = None


class BridgeParams(BaseModel):
    model_config = ConfigDict(frozen=True)

    from_chain: SupportedChain
    to_chain: SupportedChain
    from_token: Address
    to_token: Address
    amount: PositiveAmount
    to_address: Address | None = None

    @field_validator("amount")
    @classmethod
    def validate_amount_positive(cls, v: str) -> str:
        if float(v) <= 0:
            raise ValueError("Amount must be positive")
        return v

    @field_validator("to_chain")
    @classmethod
    def validate_different_chains(cls, v: SupportedChain, info) -> SupportedChain:
        from_chain = info.data.get("from_chain")
        if from_chain and v == from_chain:
            raise ValueError("Source and destination chains must be different")
        return v


class BridgeStatusType(str, Enum):
    PENDING = "PENDING"
    DONE = "DONE"
    FAILED = "FAILED"


class BridgeStatus(BaseModel):
    model_config = ConfigDict(frozen=True)

    status: BridgeStatusType
    substatus: str | None = None
    source_tx_hash: TxHash
    dest_tx_hash: TxHash | None = None


class VoteType(int, Enum):
    AGAINST = 0
    FOR = 1
    ABSTAIN = 2


class VoteParams(BaseModel):
    model_config = ConfigDict(frozen=True)

    chain: SupportedChain
    governor: Address
    proposal_id: str
    support: int


class ProposeParams(BaseModel):
    model_config = ConfigDict(frozen=True)

    chain: SupportedChain
    governor: Address
    targets: list[str]
    values: list[int]
    calldatas: list[str]
    description: str


class QueueParams(BaseModel):
    model_config = ConfigDict(frozen=True)

    chain: SupportedChain
    governor: Address
    targets: list[str]
    values: list[int]
    calldatas: list[str]
    description_hash: str


class ExecuteParams(BaseModel):
    model_config = ConfigDict(frozen=True)

    chain: SupportedChain
    governor: Address
    targets: list[str]
    values: list[int]
    calldatas: list[str]
    description_hash: str
