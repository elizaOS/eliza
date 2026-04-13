"""
Solana instruction catalog: all known programs, discriminator bytes, and difficulty.

Reward key: (program_id, first_byte_of_instruction_data).
Native programs use u32 LE index as first bytes. Token/Token-2022 use u8.
Memo uses raw bytes. Compute Budget uses u8.
"""

from dataclasses import dataclass, field
from enum import Enum


class Difficulty(Enum):
    TRIVIAL = 0      # No prerequisites, deterministic
    EASY = 1         # Simple prerequisites (create account first)
    MEDIUM = 2       # Multiple prerequisites or complex setup
    HARD = 3         # Requires external state (existing pools, etc.)
    VERY_HARD = 4    # May not work in Surfpool


@dataclass
class InstructionInfo:
    name: str
    discriminator: int
    difficulty: Difficulty
    prerequisites: list[str] = field(default_factory=list)
    notes: str = ""


@dataclass
class ProgramInfo:
    name: str
    program_id: str
    instructions: list[InstructionInfo]

    @property
    def unique_discriminators(self) -> set[int]:
        return {ix.discriminator for ix in self.instructions}

    @property
    def total_unique(self) -> int:
        return len(self.unique_discriminators)


SYSTEM_PROGRAM = ProgramInfo(
    name="System Program",
    program_id="11111111111111111111111111111111",
    instructions=[
        InstructionInfo("CreateAccount", 0, Difficulty.EASY, ["new_keypair_partialsign"]),
        InstructionInfo("Assign", 1, Difficulty.EASY, ["existing_account"]),
        InstructionInfo("Transfer", 2, Difficulty.TRIVIAL),
        InstructionInfo("CreateAccountWithSeed", 3, Difficulty.EASY),
        InstructionInfo("AdvanceNonceAccount", 4, Difficulty.MEDIUM, ["initialized_nonce_account"]),
        InstructionInfo("WithdrawNonceAccount", 5, Difficulty.MEDIUM, ["initialized_nonce_account"]),
        InstructionInfo("InitializeNonceAccount", 6, Difficulty.EASY, ["rent_exempt_account"]),
        InstructionInfo("AuthorizeNonceAccount", 7, Difficulty.MEDIUM, ["initialized_nonce_account"]),
        InstructionInfo("Allocate", 8, Difficulty.EASY, ["existing_account_no_data"]),
        InstructionInfo("AllocateWithSeed", 9, Difficulty.EASY),
        InstructionInfo("AssignWithSeed", 10, Difficulty.EASY),
        InstructionInfo("TransferWithSeed", 11, Difficulty.MEDIUM, ["account_with_seed"]),
        InstructionInfo("UpgradeNonceAccount", 12, Difficulty.HARD, ["old_nonce_account"]),
    ],
)

TOKEN_PROGRAM = ProgramInfo(
    name="Token Program",
    program_id="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    instructions=[
        InstructionInfo("InitializeMint", 0, Difficulty.EASY, ["new_mint_account"]),
        InstructionInfo("InitializeAccount", 1, Difficulty.EASY, ["mint", "new_token_account"]),
        InstructionInfo("InitializeMultisig", 2, Difficulty.MEDIUM, ["new_multisig_account"]),
        InstructionInfo("Transfer", 3, Difficulty.EASY, ["funded_token_account", "dest_token_account"]),
        InstructionInfo("Approve", 4, Difficulty.EASY, ["token_account"]),
        InstructionInfo("Revoke", 5, Difficulty.EASY, ["token_account_with_delegate"]),
        InstructionInfo("SetAuthority", 6, Difficulty.EASY, ["mint_or_token_account"]),
        InstructionInfo("MintTo", 7, Difficulty.EASY, ["mint", "token_account"]),
        InstructionInfo("Burn", 8, Difficulty.EASY, ["funded_token_account"]),
        InstructionInfo("CloseAccount", 9, Difficulty.EASY, ["empty_token_account"]),
        InstructionInfo("FreezeAccount", 10, Difficulty.MEDIUM, ["token_account", "mint_with_freeze_authority"]),
        InstructionInfo("ThawAccount", 11, Difficulty.MEDIUM, ["frozen_token_account"]),
        InstructionInfo("TransferChecked", 12, Difficulty.EASY, ["funded_token_account", "dest_token_account", "mint"]),
        InstructionInfo("ApproveChecked", 13, Difficulty.EASY, ["token_account", "mint"]),
        InstructionInfo("MintToChecked", 14, Difficulty.EASY, ["mint", "token_account"]),
        InstructionInfo("BurnChecked", 15, Difficulty.EASY, ["funded_token_account", "mint"]),
        InstructionInfo("InitializeAccount2", 16, Difficulty.EASY, ["mint", "new_token_account"]),
        InstructionInfo("SyncNative", 17, Difficulty.MEDIUM, ["wrapped_sol_account"]),
        InstructionInfo("InitializeAccount3", 18, Difficulty.EASY, ["mint", "new_token_account"]),
        InstructionInfo("InitializeMultisig2", 19, Difficulty.MEDIUM, ["new_multisig_account"]),
        InstructionInfo("InitializeMint2", 20, Difficulty.EASY, ["new_mint_account"]),
    ],
)

TOKEN_2022_PROGRAM = ProgramInfo(
    name="Token-2022 Program",
    program_id="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    instructions=[
        # Base (same ops as Token Program, different program_id = different rewards)
        InstructionInfo("InitializeMint", 0, Difficulty.EASY, ["new_mint_account_token2022"]),
        InstructionInfo("InitializeAccount", 1, Difficulty.EASY, ["token2022_mint", "new_token_account_token2022"]),
        InstructionInfo("InitializeMultisig", 2, Difficulty.MEDIUM, ["new_multisig_account_token2022"]),
        InstructionInfo("Transfer", 3, Difficulty.EASY, ["funded_token2022_account", "dest_token2022_account"]),
        InstructionInfo("Approve", 4, Difficulty.EASY, ["token2022_account"]),
        InstructionInfo("Revoke", 5, Difficulty.EASY, ["token2022_account_with_delegate"]),
        InstructionInfo("SetAuthority", 6, Difficulty.EASY, ["token2022_mint_or_account"]),
        InstructionInfo("MintTo", 7, Difficulty.EASY, ["token2022_mint", "token2022_account"]),
        InstructionInfo("Burn", 8, Difficulty.EASY, ["funded_token2022_account"]),
        InstructionInfo("CloseAccount", 9, Difficulty.EASY, ["empty_token2022_account"]),
        InstructionInfo("FreezeAccount", 10, Difficulty.MEDIUM, ["token2022_account", "token2022_mint_with_freeze"]),
        InstructionInfo("ThawAccount", 11, Difficulty.MEDIUM, ["frozen_token2022_account"]),
        InstructionInfo("TransferChecked", 12, Difficulty.EASY, ["funded_token2022_account", "dest_token2022_account"]),
        InstructionInfo("ApproveChecked", 13, Difficulty.EASY, ["token2022_account", "token2022_mint"]),
        InstructionInfo("MintToChecked", 14, Difficulty.EASY, ["token2022_mint", "token2022_account"]),
        InstructionInfo("BurnChecked", 15, Difficulty.EASY, ["funded_token2022_account", "token2022_mint"]),
        InstructionInfo("InitializeAccount2", 16, Difficulty.EASY, ["token2022_mint", "new_token_account_token2022"]),
        InstructionInfo("SyncNative", 17, Difficulty.MEDIUM, ["wrapped_sol_token2022"]),
        InstructionInfo("InitializeAccount3", 18, Difficulty.EASY, ["token2022_mint", "new_token_account_token2022"]),
        InstructionInfo("InitializeMultisig2", 19, Difficulty.MEDIUM, ["new_multisig_account_token2022"]),
        InstructionInfo("InitializeMint2", 20, Difficulty.EASY, ["new_mint_account_token2022"]),
        # Token-2022 extensions
        InstructionInfo("GetAccountDataSize", 21, Difficulty.EASY, ["token2022_mint"]),
        InstructionInfo("InitializeImmutableOwner", 22, Difficulty.EASY, ["uninitialized_token2022_account"]),
        InstructionInfo("AmountToUiAmount", 23, Difficulty.EASY, ["token2022_mint"]),
        InstructionInfo("UiAmountToAmount", 24, Difficulty.EASY, ["token2022_mint"]),
        InstructionInfo("InitializeMintCloseAuthority", 25, Difficulty.EASY, ["uninitialized_mint_token2022"],
                        notes="Before InitializeMint2"),
        InstructionInfo("TransferFeeExtension", 26, Difficulty.MEDIUM, ["uninitialized_mint_token2022"],
                        notes="Before InitializeMint2"),
        InstructionInfo("ConfidentialTransferExtension", 27, Difficulty.VERY_HARD,
                        notes="Requires ElGamal keys"),
        InstructionInfo("DefaultAccountState", 28, Difficulty.EASY, ["uninitialized_mint_token2022"],
                        notes="Before InitializeMint2"),
        InstructionInfo("Reallocate", 29, Difficulty.MEDIUM, ["token2022_account"]),
        InstructionInfo("MemoTransferExtension", 30, Difficulty.EASY, ["token2022_account"]),
        InstructionInfo("CreateNativeMint", 31, Difficulty.HARD, notes="May fail if exists"),
        InstructionInfo("InitializeNonTransferableMint", 32, Difficulty.EASY, ["uninitialized_mint_token2022"],
                        notes="Before InitializeMint2"),
        InstructionInfo("InterestBearingMintExtension", 33, Difficulty.EASY, ["uninitialized_mint_token2022"],
                        notes="Before InitializeMint2"),
        InstructionInfo("CpiGuardExtension", 34, Difficulty.EASY, ["token2022_account"]),
        InstructionInfo("InitializePermanentDelegate", 35, Difficulty.EASY, ["uninitialized_mint_token2022"],
                        notes="Before InitializeMint2"),
        InstructionInfo("TransferHookExtension", 36, Difficulty.MEDIUM, ["uninitialized_mint_token2022"],
                        notes="Before InitializeMint2"),
        InstructionInfo("ConfidentialTransferFeeExtension", 37, Difficulty.VERY_HARD),
        InstructionInfo("WithdrawExcessLamports", 38, Difficulty.MEDIUM, ["token2022_mint_or_account"]),
        InstructionInfo("MetadataPointerExtension", 39, Difficulty.EASY, ["uninitialized_mint_token2022"],
                        notes="Before InitializeMint2"),
        InstructionInfo("TokenMetadataExtension", 40, Difficulty.MEDIUM, ["token2022_mint_with_metadata_pointer"]),
        InstructionInfo("GroupPointerExtension", 41, Difficulty.EASY, ["uninitialized_mint_token2022"],
                        notes="Before InitializeMint2"),
        InstructionInfo("TokenGroupExtension", 42, Difficulty.MEDIUM, ["token2022_mint_with_group_pointer"]),
        InstructionInfo("GroupMemberPointerExtension", 43, Difficulty.EASY, ["uninitialized_mint_token2022"],
                        notes="Before InitializeMint2"),
        InstructionInfo("TokenGroupMemberExtension", 44, Difficulty.MEDIUM, ["token2022_mint_with_member_pointer"]),
    ],
)

# Memo program: data IS the memo. First byte varies → 256 theoretical discriminators,
# but only 179 reachable (0-127 ASCII + 51 multi-byte UTF-8 starters).
MEMO_PROGRAM = ProgramInfo(
    name="Memo Program",
    program_id="MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    instructions=[InstructionInfo(f"Memo_byte_{i}", i, Difficulty.TRIVIAL) for i in range(256)],
)

COMPUTE_BUDGET_PROGRAM = ProgramInfo(
    name="Compute Budget Program",
    program_id="ComputeBudget111111111111111111111111111111",
    instructions=[
        InstructionInfo("RequestUnitsDeprecated", 0, Difficulty.TRIVIAL),
        InstructionInfo("RequestHeapFrame", 1, Difficulty.TRIVIAL),
        InstructionInfo("SetComputeUnitLimit", 2, Difficulty.TRIVIAL),
        InstructionInfo("SetComputeUnitPrice", 3, Difficulty.TRIVIAL),
        InstructionInfo("SetLoadedAccountsDataSizeLimit", 4, Difficulty.TRIVIAL),
    ],
)

ATA_PROGRAM = ProgramInfo(
    name="Associated Token Account Program",
    program_id="ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    instructions=[
        InstructionInfo("Create", 0, Difficulty.EASY, ["mint"]),
        InstructionInfo("CreateIdempotent", 1, Difficulty.EASY, ["mint"]),
        InstructionInfo("RecoverNested", 2, Difficulty.HARD, ["nested_ata"]),
    ],
)

STAKE_PROGRAM = ProgramInfo(
    name="Stake Program",
    program_id="Stake11111111111111111111111111111111111111",
    instructions=[
        InstructionInfo("Initialize", 0, Difficulty.EASY, ["new_stake_account"]),
        InstructionInfo("Authorize", 1, Difficulty.MEDIUM, ["initialized_stake_account"]),
        InstructionInfo("DelegateStake", 2, Difficulty.HARD, ["initialized_stake_account", "vote_account"]),
        InstructionInfo("Split", 3, Difficulty.MEDIUM, ["funded_stake_account", "new_stake_account"]),
        InstructionInfo("Withdraw", 4, Difficulty.MEDIUM, ["stake_account"]),
        InstructionInfo("Deactivate", 5, Difficulty.HARD, ["delegated_stake_account"]),
        InstructionInfo("SetLockup", 6, Difficulty.MEDIUM, ["stake_account_with_lockup"]),
        InstructionInfo("Merge", 7, Difficulty.HARD, ["two_stake_accounts"]),
        InstructionInfo("AuthorizeWithSeed", 8, Difficulty.MEDIUM, ["stake_account_with_seed"]),
        InstructionInfo("InitializeChecked", 9, Difficulty.EASY, ["new_stake_account"]),
        InstructionInfo("AuthorizeChecked", 10, Difficulty.MEDIUM, ["initialized_stake_account"]),
        InstructionInfo("AuthorizeCheckedWithSeed", 11, Difficulty.MEDIUM, ["stake_account_with_seed"]),
        InstructionInfo("SetLockupChecked", 12, Difficulty.MEDIUM, ["stake_account_with_lockup"]),
        InstructionInfo("GetMinimumDelegation", 13, Difficulty.TRIVIAL),
        InstructionInfo("DeactivateDelinquent", 14, Difficulty.VERY_HARD, ["delinquent_validator_stake"]),
        InstructionInfo("Redelegate", 15, Difficulty.VERY_HARD, ["delegated_stake_account", "new_vote_account"]),
    ],
)

ADDRESS_LOOKUP_TABLE_PROGRAM = ProgramInfo(
    name="Address Lookup Table Program",
    program_id="AddressLookupTab1e1111111111111111111111111",
    instructions=[
        InstructionInfo("CreateLookupTable", 0, Difficulty.EASY),
        InstructionInfo("FreezeLookupTable", 1, Difficulty.MEDIUM, ["active_lookup_table"]),
        InstructionInfo("ExtendLookupTable", 2, Difficulty.EASY, ["active_lookup_table"]),
        InstructionInfo("DeactivateLookupTable", 3, Difficulty.MEDIUM, ["active_lookup_table"]),
        InstructionInfo("CloseLookupTable", 4, Difficulty.MEDIUM, ["deactivated_lookup_table"]),
    ],
)

ALL_PROGRAMS: list[ProgramInfo] = [
    SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, MEMO_PROGRAM,
    COMPUTE_BUDGET_PROGRAM, ATA_PROGRAM, STAKE_PROGRAM, ADDRESS_LOOKUP_TABLE_PROGRAM,
]

PROGRAM_BY_ID: dict[str, ProgramInfo] = {p.program_id: p for p in ALL_PROGRAMS}


def get_total_unique_pairs() -> int:
    return sum(p.total_unique for p in ALL_PROGRAMS)


def get_instructions_by_difficulty(max_difficulty: Difficulty = Difficulty.MEDIUM) -> list[tuple[ProgramInfo, InstructionInfo]]:
    return [
        (prog, ix) for prog in ALL_PROGRAMS for ix in prog.instructions
        if ix.difficulty.value <= max_difficulty.value
    ]


def summarize_catalog() -> str:
    lines = ["=== SOLANA INSTRUCTION CATALOG ===\n"]
    total = 0
    for prog in ALL_PROGRAMS:
        n = prog.total_unique
        total += n
        lines.append(f"  {prog.name} ({prog.program_id[:8]}...): {n} unique")
    lines.append(f"\n  TOTAL: {total} unique (program, discriminator) pairs")
    return "\n".join(lines)


if __name__ == "__main__":
    print(summarize_catalog())
