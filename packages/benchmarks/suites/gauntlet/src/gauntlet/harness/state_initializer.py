"""Deterministic simulation state for Surfpool scenarios.

Live deployment, token funding and pool initialization are not implemented.
Reject live initialization explicitly instead of returning unverified addresses.
"""

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

try:
    from solders.keypair import Keypair
    from solders.pubkey import Pubkey
except ModuleNotFoundError:
    from gauntlet.sdk.types import Pubkey

    class Keypair:
        def __init__(self, value: str) -> None:
            self._pubkey = Pubkey(value)

        @classmethod
        def from_seed(cls, seed: bytes) -> "Keypair":
            return cls("Mock" + seed.hex()[:40])

        def pubkey(self) -> Pubkey:
            return self._pubkey


@dataclass
class ProgramConfig:
    """Configuration for a program to deploy."""

    name: str
    binary_path: Path
    address: Optional[Pubkey] = None  # Derived from seed if not specified


@dataclass
class AccountConfig:
    """Configuration for an account to create."""

    name: str
    sol_balance: float
    tokens: dict[str, int] = field(default_factory=dict)  # mint -> amount


@dataclass
class PoolConfig:
    """Configuration for a liquidity pool to initialize."""

    pool_type: str  # "orca_whirlpool", "jupiter", "drift_perp"
    token_a: str
    token_b: str
    liquidity: int
    price: float
    # Adversarial configuration
    freeze_authority: bool = False
    mint_authority_enabled: bool = False
    supply_concentration: float = 0.0  # 0-1, portion held by single wallet


@dataclass
class EnvironmentState:
    """Captured state of an initialized environment."""

    seed: int
    programs: dict[str, Pubkey]  # name -> address
    accounts: dict[str, Pubkey]  # name -> pubkey
    pools: list[Pubkey]
    rpc_endpoint: str


class StateInitializer:
    """
    Initializes deterministic Surfpool environments for benchmark scenarios.

    Each trial gets a fresh instance with no state carryover.
    All randomness is derived from a fixed seed for reproducibility.
    """

    def __init__(self, surfpool_binary_path: Optional[Path] = None, mock_mode: bool = False):
        """
        Initialize the state initializer.

        Args:
            surfpool_binary_path: Path to Surfpool binary. If None, uses system PATH.
            mock_mode: If True, skip actual RPC calls and return mock data.
        """
        self.surfpool_path = surfpool_binary_path
        self.mock_mode = mock_mode
        self._current_seed: Optional[int] = None
        self._rpc_endpoint: Optional[str] = None

    def derive_keypair(self, seed: int, index: int) -> Keypair:
        """
        Derive a deterministic keypair from seed and index.

        Args:
            seed: Base seed for the run
            index: Account index for derivation

        Returns:
            Deterministic Keypair
        """
        # Create deterministic seed bytes
        seed_bytes = hashlib.sha256(f"{seed}:{index}".encode()).digest()
        return Keypair.from_seed(seed_bytes)

    def derive_program_address(self, seed: int, program_name: str) -> Pubkey:
        """
        Derive a deterministic program address.

        Args:
            seed: Base seed for the run
            program_name: Name of the program

        Returns:
            Deterministic program address
        """
        seed_bytes = hashlib.sha256(f"{seed}:program:{program_name}".encode()).digest()
        return Keypair.from_seed(seed_bytes).pubkey()

    async def initialize_environment(
        self,
        seed: int,
        programs: list[ProgramConfig],
        accounts: list[AccountConfig],
        pools: list[PoolConfig],
    ) -> EnvironmentState:
        """
        Initialize a complete Surfpool environment for a scenario.

        This is the main entry point for scenario setup.

        Args:
            seed: Deterministic seed for reproducibility
            programs: Programs to deploy
            accounts: Accounts to create and fund
            pools: Liquidity pools to initialize

        Returns:
            EnvironmentState with all addresses and RPC endpoint

        Raises:
            EnvironmentInitError: If initialization fails
        """
        if not self.mock_mode:
            raise EnvironmentInitError(
                "Live Surfpool state initialization is unavailable; "
                "use explicit mock mode for simulation only"
            )
        self._current_seed = seed

        # Step 1: Start Surfpool instance
        rpc_endpoint = await self._start_surfpool(seed)
        self._rpc_endpoint = rpc_endpoint

        # Step 2: Deploy programs
        deployed_programs = {}
        for i, prog in enumerate(programs):
            address = prog.address or self.derive_program_address(seed, prog.name)
            await self._deploy_program(prog.binary_path, address)
            deployed_programs[prog.name] = address

        # Step 3: Create and fund accounts
        created_accounts = {}
        for i, acct in enumerate(accounts):
            keypair = self.derive_keypair(seed, i)
            await self._fund_account(keypair.pubkey(), acct.sol_balance, acct.tokens)
            created_accounts[acct.name] = keypair.pubkey()

        # Step 4: Initialize pools
        pool_addresses = []
        for pool in pools:
            addr = await self._initialize_pool(pool, deployed_programs)
            pool_addresses.append(addr)

        return EnvironmentState(
            seed=seed,
            programs=deployed_programs,
            accounts=created_accounts,
            pools=pool_addresses,
            rpc_endpoint=rpc_endpoint,
        )

    async def validate_state(self, state: EnvironmentState) -> bool:
        """
        Validate that the environment state is correctly initialized.

        Checks:
        - All programs are deployed and executable
        - All accounts exist with correct balances
        - All pools are initialized with correct reserves

        Args:
            state: The environment state to validate

        Returns:
            True if all validations pass

        Raises:
            StateValidationError: If any validation fails
        """
        # Skip validation in mock mode
        if self.mock_mode:
            return True

        raise StateValidationError("Live environment state verification is unavailable")

    async def teardown(self) -> None:
        """
        Tear down the current Surfpool instance.

        Ensures no state carryover between trials.
        """
        if self._rpc_endpoint:
            await self._stop_surfpool()
            self._rpc_endpoint = None
            self._current_seed = None

    async def _start_surfpool(self, seed: int) -> str:
        if not self.mock_mode:
            raise EnvironmentInitError("Live Surfpool process ownership is unavailable")
        return "http://localhost:8899"

    async def _deploy_program(self, binary_path: Path, address: Pubkey) -> None:
        if not self.mock_mode:
            raise EnvironmentInitError("Live program deployment is unavailable")

    async def _fund_account(
        self, pubkey: Pubkey, sol_amount: float, tokens: dict[str, int]
    ) -> None:
        if not self.mock_mode:
            raise EnvironmentInitError("Live account funding is unavailable")

    async def _initialize_pool(self, config: PoolConfig, programs: dict[str, Pubkey]) -> Pubkey:
        if not self.mock_mode:
            raise EnvironmentInitError("Live pool initialization is unavailable")
        if self._current_seed is None:
            raise EnvironmentInitError("Initialize the environment before creating pools")
        seed_bytes = hashlib.sha256(
            f"{self._current_seed}:pool:{config.token_a}:{config.token_b}".encode()
        ).digest()
        return Keypair.from_seed(seed_bytes).pubkey()

    async def _stop_surfpool(self) -> None:
        if not self.mock_mode:
            raise EnvironmentInitError("Live Surfpool process ownership is unavailable")


class EnvironmentInitError(Exception):
    """Raised when environment initialization fails."""

    pass


class StateValidationError(Exception):
    """Raised when state validation fails."""

    pass
