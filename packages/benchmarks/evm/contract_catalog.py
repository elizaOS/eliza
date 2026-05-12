"""
EVM contract catalog: known contracts, function selectors, and difficulty ratings.

Reward key: (contract_address, function_selector_4bytes).
EVM precompiles have fixed addresses (0x01-0x09).
User-deployed contracts get deterministic addresses from Anvil's default account.

Function selectors are the first 4 bytes of keccak256(function_signature).
"""

from dataclasses import dataclass, field
from enum import Enum


class Difficulty(Enum):
    TRIVIAL = 0      # No prerequisites, always works
    EASY = 1         # Simple setup (deploy a contract first)
    MEDIUM = 2       # Multiple prerequisites or state setup
    HARD = 3         # Complex state, external dependencies
    VERY_HARD = 4    # May require specific chain state


@dataclass
class FunctionInfo:
    name: str
    selector: str            # 4-byte hex string, e.g. "0xa9059cbb"
    signature: str           # Full signature, e.g. "transfer(address,uint256)"
    difficulty: Difficulty
    prerequisites: list[str] = field(default_factory=list)
    notes: str = ""


@dataclass
class ContractInfo:
    name: str
    address: str             # Fixed address or placeholder
    functions: list[FunctionInfo]
    is_precompile: bool = False
    deploy_in_template: str = ""  # Which template deploys this contract

    @property
    def unique_selectors(self) -> set[str]:
        return {fn.selector for fn in self.functions}

    @property
    def total_unique(self) -> int:
        return len(self.unique_selectors)


# =========================================================================
# EVM Precompiles (fixed addresses, available on all EVM chains)
# =========================================================================

# NOTE: Precompiles process raw bytes, not ABI-encoded calls. They have no
# function selectors. The "selector" recorded in the reward key is the first
# 4 bytes of whatever input data the template sends. The selectors below
# match what our deterministic templates actually send.

PRECOMPILE_ECRECOVER = ContractInfo(
    name="ecRecover",
    address="0x0000000000000000000000000000000000000001",
    is_precompile=True,
    functions=[
        FunctionInfo("ecRecover", "0xea83cdcd", "ecRecover(raw_input)",
                     Difficulty.EASY, notes="First 4 bytes of keccak256(msg) input"),
    ],
)

PRECOMPILE_SHA256 = ContractInfo(
    name="SHA-256",
    address="0x0000000000000000000000000000000000000002",
    is_precompile=True,
    functions=[
        FunctionInfo("sha256", "0x48656c6c", "sha256(raw_input)",
                     Difficulty.TRIVIAL, notes="First 4 bytes of 'Hello World' hex"),
    ],
)

PRECOMPILE_RIPEMD160 = ContractInfo(
    name="RIPEMD-160",
    address="0x0000000000000000000000000000000000000003",
    is_precompile=True,
    functions=[
        FunctionInfo("ripemd160", "0x48656c6c", "ripemd160(raw_input)",
                     Difficulty.TRIVIAL, notes="First 4 bytes of 'Hello World' hex"),
    ],
)

PRECOMPILE_IDENTITY = ContractInfo(
    name="Identity (datacopy)",
    address="0x0000000000000000000000000000000000000004",
    is_precompile=True,
    functions=[
        FunctionInfo("identity", "0x48656c6c", "identity(raw_input)",
                     Difficulty.TRIVIAL, notes="First 4 bytes of 'Hello World' hex"),
    ],
)

PRECOMPILE_MODEXP = ContractInfo(
    name="ModExp",
    address="0x0000000000000000000000000000000000000005",
    is_precompile=True,
    functions=[
        FunctionInfo("modexp", "0x00000000", "modexp(raw_input)",
                     Difficulty.MEDIUM, notes="First 4 bytes of Bsize=1 padded to 32"),
    ],
)

PRECOMPILE_ECADD = ContractInfo(
    name="ecAdd (BN256)",
    address="0x0000000000000000000000000000000000000006",
    is_precompile=True,
    functions=[
        FunctionInfo("ecAdd", "0x00000000", "ecAdd(raw_input)",
                     Difficulty.MEDIUM, notes="First 4 bytes of x1=1 padded to 32"),
    ],
)

PRECOMPILE_ECMUL = ContractInfo(
    name="ecMul (BN256)",
    address="0x0000000000000000000000000000000000000007",
    is_precompile=True,
    functions=[
        FunctionInfo("ecMul", "0x00000000", "ecMul(raw_input)",
                     Difficulty.MEDIUM, notes="First 4 bytes of x=1 padded to 32"),
    ],
)

PRECOMPILE_ECPAIRING = ContractInfo(
    name="ecPairing (BN256)",
    address="0x0000000000000000000000000000000000000008",
    is_precompile=True,
    functions=[
        FunctionInfo("ecPairing", "0x", "ecPairing(empty)",
                     Difficulty.HARD, notes="Empty input for trivial pairing check"),
    ],
)

PRECOMPILE_BLAKE2F = ContractInfo(
    name="Blake2f",
    address="0x0000000000000000000000000000000000000009",
    is_precompile=True,
    functions=[
        FunctionInfo("blake2f", "0x0000000c", "blake2f(raw_input)",
                     Difficulty.MEDIUM, notes="First 4 bytes = rounds (12)"),
    ],
)


# =========================================================================
# ERC20 Token Contract
# =========================================================================

ERC20_CONTRACT = ContractInfo(
    name="ERC20 Token",
    address="DEPLOY:erc20",  # Deployed in template
    deploy_in_template="deploy_erc20",
    functions=[
        FunctionInfo("name", "0x06fdde03", "name()", Difficulty.TRIVIAL),
        FunctionInfo("symbol", "0x95d89b41", "symbol()", Difficulty.TRIVIAL),
        FunctionInfo("decimals", "0x313ce567", "decimals()", Difficulty.TRIVIAL),
        FunctionInfo("totalSupply", "0x18160ddd", "totalSupply()", Difficulty.TRIVIAL),
        FunctionInfo("balanceOf", "0x70a08231", "balanceOf(address)", Difficulty.TRIVIAL),
        FunctionInfo("allowance", "0xdd62ed3e", "allowance(address,address)", Difficulty.TRIVIAL),
        FunctionInfo("transfer", "0xa9059cbb", "transfer(address,uint256)",
                     Difficulty.EASY, ["funded_account"]),
        FunctionInfo("approve", "0x095ea7b3", "approve(address,uint256)", Difficulty.EASY),
        FunctionInfo("transferFrom", "0x23b872dd", "transferFrom(address,address,uint256)",
                     Difficulty.EASY, ["approved_allowance"]),
        FunctionInfo("mint", "0x40c10f19", "mint(address,uint256)",
                     Difficulty.EASY, notes="Owner-only minting"),
        FunctionInfo("burn", "0x42966c68", "burn(uint256)",
                     Difficulty.EASY, ["funded_account"]),
        FunctionInfo("increaseAllowance", "0x39509351", "increaseAllowance(address,uint256)",
                     Difficulty.EASY),
        FunctionInfo("decreaseAllowance", "0xa457c2d7", "decreaseAllowance(address,uint256)",
                     Difficulty.EASY, ["existing_allowance"]),
    ],
)


# =========================================================================
# ERC721 NFT Contract
# =========================================================================

ERC721_CONTRACT = ContractInfo(
    name="ERC721 NFT",
    address="DEPLOY:erc721",
    deploy_in_template="deploy_erc721",
    functions=[
        FunctionInfo("name", "0x06fdde03", "name()", Difficulty.TRIVIAL),
        FunctionInfo("symbol", "0x95d89b41", "symbol()", Difficulty.TRIVIAL),
        FunctionInfo("balanceOf", "0x70a08231", "balanceOf(address)", Difficulty.TRIVIAL),
        FunctionInfo("ownerOf", "0x6352211e", "ownerOf(uint256)",
                     Difficulty.EASY, ["minted_token"]),
        FunctionInfo("tokenURI", "0xc87b56dd", "tokenURI(uint256)",
                     Difficulty.EASY, ["minted_token"]),
        FunctionInfo("approve", "0x095ea7b3", "approve(address,uint256)",
                     Difficulty.EASY, ["owned_token"]),
        FunctionInfo("getApproved", "0x081812fc", "getApproved(uint256)",
                     Difficulty.EASY, ["minted_token"]),
        FunctionInfo("setApprovalForAll", "0xa22cb465", "setApprovalForAll(address,bool)",
                     Difficulty.EASY),
        FunctionInfo("isApprovedForAll", "0xe985e9c5", "isApprovedForAll(address,address)",
                     Difficulty.TRIVIAL),
        FunctionInfo("transferFrom", "0x23b872dd", "transferFrom(address,address,uint256)",
                     Difficulty.EASY, ["owned_token"]),
        FunctionInfo("safeTransferFrom", "0x42842e0e", "safeTransferFrom(address,address,uint256)",
                     Difficulty.EASY, ["owned_token"]),
        FunctionInfo("safeMint", "0xa1448194", "safeMint(address,uint256)",
                     Difficulty.EASY, notes="Owner-only minting"),
        FunctionInfo("supportsInterface", "0x01ffc9a7", "supportsInterface(bytes4)",
                     Difficulty.TRIVIAL),
    ],
)


# =========================================================================
# WETH (Wrapped ETH)
# =========================================================================

WETH_CONTRACT = ContractInfo(
    name="WETH9",
    address="DEPLOY:weth",
    deploy_in_template="deploy_weth",
    functions=[
        FunctionInfo("deposit", "0xd0e30db0", "deposit()",
                     Difficulty.TRIVIAL, notes="Payable, wraps ETH"),
        FunctionInfo("withdraw", "0x2e1a7d4d", "withdraw(uint256)",
                     Difficulty.EASY, ["wrapped_eth"]),
        FunctionInfo("totalSupply", "0x18160ddd", "totalSupply()", Difficulty.TRIVIAL),
        FunctionInfo("balanceOf", "0x70a08231", "balanceOf(address)", Difficulty.TRIVIAL),
        FunctionInfo("transfer", "0xa9059cbb", "transfer(address,uint256)",
                     Difficulty.EASY, ["wrapped_eth"]),
        FunctionInfo("approve", "0x095ea7b3", "approve(address,uint256)", Difficulty.EASY),
        FunctionInfo("transferFrom", "0x23b872dd", "transferFrom(address,address,uint256)",
                     Difficulty.EASY, ["approved_allowance"]),
        FunctionInfo("allowance", "0xdd62ed3e", "allowance(address,address)", Difficulty.TRIVIAL),
        FunctionInfo("name", "0x06fdde03", "name()", Difficulty.TRIVIAL),
        FunctionInfo("symbol", "0x95d89b41", "symbol()", Difficulty.TRIVIAL),
        FunctionInfo("decimals", "0x313ce567", "decimals()", Difficulty.TRIVIAL),
    ],
)


# =========================================================================
# Multicall3
# =========================================================================

MULTICALL3_CONTRACT = ContractInfo(
    name="Multicall3",
    address="DEPLOY:multicall3",
    deploy_in_template="deploy_multicall3",
    functions=[
        FunctionInfo("aggregate", "0x252dba42", "aggregate((address,bytes)[])",
                     Difficulty.MEDIUM, notes="Batch multiple calls"),
        FunctionInfo("tryAggregate", "0xbce38bd7", "tryAggregate(bool,(address,bytes)[])",
                     Difficulty.MEDIUM, notes="Batch with failure tolerance"),
        FunctionInfo("aggregate3", "0x82ad56cb",
                     "aggregate3((address,bool,bytes)[])",
                     Difficulty.MEDIUM, notes="Batch with per-call failure flags"),
        FunctionInfo("getBlockNumber", "0x42cbb15c", "getBlockNumber()", Difficulty.TRIVIAL),
        FunctionInfo("getBlockHash", "0xee82ac5e", "getBlockHash(uint256)", Difficulty.TRIVIAL),
        FunctionInfo("getCurrentBlockTimestamp", "0x0f28c97d",
                     "getCurrentBlockTimestamp()", Difficulty.TRIVIAL),
        FunctionInfo("getEthBalance", "0x4d2301cc", "getEthBalance(address)", Difficulty.TRIVIAL),
        FunctionInfo("getChainId", "0x3408e470", "getChainId()", Difficulty.TRIVIAL),
    ],
)


# =========================================================================
# Native ETH Operations (pseudo-contract for tracking)
# =========================================================================

NATIVE_ETH = ContractInfo(
    name="Native ETH",
    address="0x0000000000000000000000000000000000000000",
    functions=[
        FunctionInfo("deploy", "0x60c06040", "deploy()",
                     Difficulty.EASY, notes="Contract deployment; selector = first 4 bytes of Forge-compiled bytecode"),
    ],
)

# NOTE: Native ETH transfers go to the RECIPIENT address with selector "0x" (empty).
# They don't hit the zero address. Each unique recipient is a separate reward.


# =========================================================================
# CREATE2 Factory
# =========================================================================

CREATE2_FACTORY = ContractInfo(
    name="CREATE2 Factory",
    address="DEPLOY:create2factory",
    deploy_in_template="deploy_create2factory",
    functions=[
        FunctionInfo("deploy", "0x66cfa057", "deploy(bytes32,bytes)",
                     Difficulty.MEDIUM, notes="Deploy contract with CREATE2"),
        FunctionInfo("computeAddress", "0x56299481", "computeAddress(bytes32,bytes32)",
                     Difficulty.TRIVIAL),
    ],
)


# =========================================================================
# ERC1155 Multi-Token
# =========================================================================

ERC1155_CONTRACT = ContractInfo(
    name="ERC1155 Multi-Token",
    address="DEPLOY:erc1155",
    deploy_in_template="deploy_erc1155",
    functions=[
        FunctionInfo("balanceOf", "0x00fdd58e", "balanceOf(address,uint256)", Difficulty.TRIVIAL),
        FunctionInfo("balanceOfBatch", "0x4e1273f4",
                     "balanceOfBatch(address[],uint256[])", Difficulty.TRIVIAL),
        FunctionInfo("setApprovalForAll", "0xa22cb465",
                     "setApprovalForAll(address,bool)", Difficulty.EASY),
        FunctionInfo("isApprovedForAll", "0xe985e9c5",
                     "isApprovedForAll(address,address)", Difficulty.TRIVIAL),
        FunctionInfo("safeTransferFrom", "0xf242432a",
                     "safeTransferFrom(address,address,uint256,uint256,bytes)",
                     Difficulty.EASY, ["minted_token"]),
        FunctionInfo("safeBatchTransferFrom", "0x2eb2c2d6",
                     "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)",
                     Difficulty.MEDIUM, ["minted_tokens"]),
        FunctionInfo("mint", "0x731133e9", "mint(address,uint256,uint256,bytes)",
                     Difficulty.EASY, notes="Owner-only minting"),
        FunctionInfo("uri", "0x0e89341c", "uri(uint256)", Difficulty.TRIVIAL),
        FunctionInfo("supportsInterface", "0x01ffc9a7", "supportsInterface(bytes4)",
                     Difficulty.TRIVIAL),
    ],
)


# =========================================================================
# Hyperliquid EVM-specific contracts (added when targeting HL)
# =========================================================================

# Hyperliquid EVM contracts - verified from official docs:
# https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore
#
# Read precompiles (0x800-0x807): Raw precompiles, ABI-encoded input (no selectors).
# Write contract (0x3333...3333): CoreWriter.sendRawAction(bytes).

HL_READ_POSITIONS = ContractInfo(
    name="Hyperliquid Read: Positions",
    address="0x0000000000000000000000000000000000000800",
    is_precompile=True,
    functions=[
        FunctionInfo("readPosition", "0x00000000",
                     "staticcall(abi.encode(address,uint16))",
                     Difficulty.EASY, notes="Read perp position"),
    ],
)

HL_READ_ORACLE = ContractInfo(
    name="Hyperliquid Read: Oracle Prices",
    address="0x0000000000000000000000000000000000000807",
    is_precompile=True,
    functions=[
        FunctionInfo("readOraclePrice", "0x00000000",
                     "staticcall(abi.encode(uint256))",
                     Difficulty.EASY, notes="Read perp oracle price by index"),
    ],
)

HL_CORE_WRITER = ContractInfo(
    name="Hyperliquid CoreWriter",
    address="0x3333333333333333333333333333333333333333",
    functions=[
        FunctionInfo("sendRawAction", "0x17938e13",
                     "sendRawAction(bytes)",
                     Difficulty.MEDIUM, notes="Send action to L1 via CoreWriter"),
    ],
)


# =========================================================================
# Aggregated catalog
# =========================================================================

# Contracts exercised by deterministic templates (verified working)
DETERMINISTIC_CONTRACTS: list[ContractInfo] = [
    PRECOMPILE_ECRECOVER,
    PRECOMPILE_SHA256,
    PRECOMPILE_RIPEMD160,
    PRECOMPILE_IDENTITY,
    PRECOMPILE_MODEXP,
    PRECOMPILE_ECADD,
    PRECOMPILE_ECMUL,
    PRECOMPILE_ECPAIRING,
    PRECOMPILE_BLAKE2F,
    NATIVE_ETH,
    ERC20_CONTRACT,
    WETH_CONTRACT,
]

# Additional contracts available for LLM phase (no deterministic templates yet)
LLM_DISCOVERY_CONTRACTS: list[ContractInfo] = [
    ERC721_CONTRACT,
    ERC1155_CONTRACT,
    MULTICALL3_CONTRACT,
    CREATE2_FACTORY,
]

# All general EVM contracts (deterministic + LLM-discoverable)
GENERAL_CONTRACTS: list[ContractInfo] = DETERMINISTIC_CONTRACTS + LLM_DISCOVERY_CONTRACTS

# Hyperliquid EVM-specific contracts
HYPERLIQUID_CONTRACTS: list[ContractInfo] = [
    HL_READ_POSITIONS,
    HL_READ_ORACLE,
    HL_CORE_WRITER,
]

ALL_CONTRACTS: list[ContractInfo] = GENERAL_CONTRACTS + HYPERLIQUID_CONTRACTS

CONTRACT_BY_ADDRESS: dict[str, ContractInfo] = {
    c.address: c for c in ALL_CONTRACTS if not c.address.startswith("DEPLOY:")
}


def get_contracts_for_chain(chain: str = "general") -> list[ContractInfo]:
    """Get contracts available for a given chain configuration."""
    if chain == "hyperliquid":
        return GENERAL_CONTRACTS + HYPERLIQUID_CONTRACTS
    return GENERAL_CONTRACTS


def get_total_unique_pairs(chain: str = "general") -> int:
    """Total unique (address, selector) pairs for a chain."""
    contracts = get_contracts_for_chain(chain)
    return sum(c.total_unique for c in contracts)


def get_functions_by_difficulty(
    max_difficulty: Difficulty = Difficulty.MEDIUM,
    chain: str = "general",
) -> list[tuple[ContractInfo, FunctionInfo]]:
    """Get all functions up to a given difficulty level."""
    contracts = get_contracts_for_chain(chain)
    return [
        (contract, fn)
        for contract in contracts
        for fn in contract.functions
        if fn.difficulty.value <= max_difficulty.value
    ]


def summarize_catalog(chain: str = "general") -> str:
    """Human-readable catalog summary."""
    contracts = get_contracts_for_chain(chain)
    lines = [f"=== EVM CONTRACT CATALOG ({chain}) ===\n"]
    total = 0
    for contract in contracts:
        n = contract.total_unique
        total += n
        addr_display = contract.address[:10] + "..." if len(contract.address) > 14 else contract.address
        lines.append(f"  {contract.name} ({addr_display}): {n} unique selectors")
    lines.append(f"\n  TOTAL: {total} unique (address, selector) pairs")
    return "\n".join(lines)


if __name__ == "__main__":
    print(summarize_catalog())
    print()
    print(summarize_catalog("hyperliquid"))
