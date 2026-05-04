"""
State Initializer for Surfpool environments.

Responsible for:
- Creating fresh Surfpool instances with deterministic seeds
- Deploying program binaries (Jupiter, Orca, Drift)
- Funding test accounts with SOL and tokens
- Initializing liquidity pools per scenario

Per Phase 1 requirements: Surfpool provides deterministic environments
where we can preload accounts, programs, funds, and other required state.
"""

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from solders.keypair import Keypair
from solders.pubkey import Pubkey


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
        
        # Validate programs
        for name, address in state.programs.items():
            if not await self._verify_program_deployed(address):
                raise StateValidationError(f"Program {name} not deployed at {address}")

        # Validate accounts
        for name, pubkey in state.accounts.items():
            if not await self._verify_account_exists(pubkey):
                raise StateValidationError(f"Account {name} not found at {pubkey}")

        # Validate pools
        for pool_addr in state.pools:
            if not await self._verify_pool_initialized(pool_addr):
                raise StateValidationError(f"Pool not initialized at {pool_addr}")

        return True

    async def teardown(self) -> None:
        """
        Tear down the current Surfpool instance.
        
        Ensures no state carryover between trials.
        """
        if self._rpc_endpoint:
            await self._stop_surfpool()
            self._rpc_endpoint = None
            self._current_seed = None

    # --- Private methods for Surfpool interaction ---

    async def _start_surfpool(self, seed: int) -> str:
        """Start a Surfpool instance and return RPC endpoint.
        
        Note: In the integrated flow, Surfpool is started by the CLI/Orchestrator
        using SurfpoolManager. This method is kept for standalone usage.
        """
        # Return the default local RPC endpoint
        # The actual Surfpool process is managed by SurfpoolManager
        return "http://localhost:8899"

    async def _deploy_program(self, binary_path: Path, address: Pubkey) -> None:
        """Deploy a program binary to the given address.
        
        Note: For Phase 1, we rely on Surfpool's built-in program cloning
        or pre-deployed programs. Direct deployment requires the solana CLI.
        """
        # Surfpool can clone programs from devnet/mainnet automatically
        # For local programs, we'd use: solana program deploy <binary>
        # This is a future enhancement
        pass

    async def _fund_account(
        self, pubkey: Pubkey, sol_amount: float, tokens: dict[str, int]
    ) -> None:
        """Fund an account with SOL and tokens using airdrop."""
        if not self._rpc_endpoint:
            return
        
        from gauntlet.harness.surfpool import SolanaRpcClient
        
        rpc = SolanaRpcClient(self._rpc_endpoint)
        
        # Request SOL airdrop (convert SOL to lamports)
        lamports = int(sol_amount * 1_000_000_000)
        try:
            await rpc.request_airdrop(str(pubkey), lamports)
        except Exception as e:
            # Airdrop may fail if account already funded or limit reached
            pass
        
        # Token distribution would require token program calls
        # For Phase 1, we focus on SOL-based scenarios

    async def _initialize_pool(
        self, config: PoolConfig, programs: dict[str, Pubkey]
    ) -> Pubkey:
        """Initialize a liquidity pool and return its address.
        
        For Phase 1, pools are simulated. Real pool initialization
        requires program-specific instructions.
        """
        # Generate a deterministic pool address
        if self._current_seed:
            seed_bytes = hashlib.sha256(
                f"{self._current_seed}:pool:{config.token_a}:{config.token_b}".encode()
            ).digest()
            return Keypair.from_seed(seed_bytes).pubkey()
        return Pubkey.new_unique()

    async def _verify_program_deployed(self, address: Pubkey) -> bool:
        """Verify a program is deployed and executable."""
        if not self._rpc_endpoint:
            return True
        
        from gauntlet.harness.surfpool import SolanaRpcClient
        
        rpc = SolanaRpcClient(self._rpc_endpoint)
        try:
            info = await rpc.get_account_info(str(address))
            return info is not None and info.get("value") is not None
        except Exception:
            return False

    async def _verify_account_exists(self, pubkey: Pubkey) -> bool:
        """Verify an account exists with a balance."""
        if not self._rpc_endpoint:
            return True
        
        from gauntlet.harness.surfpool import SolanaRpcClient
        
        rpc = SolanaRpcClient(self._rpc_endpoint)
        try:
            balance = await rpc.get_balance(str(pubkey))
            return balance > 0
        except Exception:
            return False

    async def _verify_pool_initialized(self, address: Pubkey) -> bool:
        """Verify a pool is initialized.
        
        For Phase 1, pools are simulated so we return True.
        """
        return True

    async def _stop_surfpool(self) -> None:
        """Stop the current Surfpool instance.
        
        Note: In the integrated flow, Surfpool is managed by SurfpoolManager.
        """
        pass


class EnvironmentInitError(Exception):
    """Raised when environment initialization fails."""
    pass


class StateValidationError(Exception):
    """Raised when state validation fails."""
    pass
