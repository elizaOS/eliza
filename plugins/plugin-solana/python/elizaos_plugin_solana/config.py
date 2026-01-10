"""Wallet configuration for Solana client."""

import os
from dataclasses import dataclass, field
from typing import Optional

from solders.keypair import Keypair
from solders.pubkey import Pubkey

from elizaos_plugin_solana.errors import ConfigError, InvalidKeypairError, InvalidPublicKeyError
from elizaos_plugin_solana.keypair import KeypairUtils

DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com"


@dataclass
class WalletConfig:
    """Wallet configuration loaded from environment or settings.

    Attributes:
        rpc_url: Solana RPC URL.
        public_key: Public key (always available).
        slippage_bps: Slippage tolerance in basis points (default 50 = 0.5%).
        helius_api_key: Optional Helius API key for enhanced RPC.
        birdeye_api_key: Optional Birdeye API key for price data.
    """

    rpc_url: str
    public_key: Pubkey
    slippage_bps: int = 50
    helius_api_key: Optional[str] = None
    birdeye_api_key: Optional[str] = None
    _keypair: Optional[Keypair] = field(default=None, repr=False)

    @classmethod
    def read_only(cls, rpc_url: str, public_key: str) -> "WalletConfig":
        """Create a read-only wallet configuration.

        Args:
            rpc_url: Solana RPC endpoint URL.
            public_key: Base58-encoded public key.

        Returns:
            A read-only wallet configuration.

        Raises:
            InvalidPublicKeyError: If the public key is invalid.
        """
        try:
            pubkey = Pubkey.from_string(public_key)
        except Exception as e:
            raise InvalidPublicKeyError(f"Invalid public key: {e}") from e

        return cls(rpc_url=rpc_url, public_key=pubkey)

    @classmethod
    def with_keypair(cls, rpc_url: str, private_key: str) -> "WalletConfig":
        """Create a wallet configuration with a private key (full access).

        Args:
            rpc_url: Solana RPC endpoint URL.
            private_key: Base58 or Base64-encoded private key.

        Returns:
            A wallet configuration with signing capability.

        Raises:
            InvalidKeypairError: If the private key is invalid.
        """
        keypair = KeypairUtils.from_string(private_key)
        return cls(
            rpc_url=rpc_url,
            public_key=keypair.pubkey(),
            _keypair=keypair,
        )

    @classmethod
    def from_env(cls) -> "WalletConfig":
        """Load configuration from environment variables.

        Reads the following environment variables:
        - SOLANA_RPC_URL (optional, defaults to mainnet)
        - SOLANA_PRIVATE_KEY or WALLET_PRIVATE_KEY (optional)
        - SOLANA_PUBLIC_KEY or WALLET_PUBLIC_KEY (required if no private key)
        - SLIPPAGE (optional, defaults to 50 bps)
        - HELIUS_API_KEY (optional)
        - BIRDEYE_API_KEY (optional)

        Returns:
            A wallet configuration.

        Raises:
            ConfigError: If required variables are missing or invalid.
        """
        rpc_url = os.getenv("SOLANA_RPC_URL", DEFAULT_RPC_URL)

        # Try to get private key first
        private_key = os.getenv("SOLANA_PRIVATE_KEY") or os.getenv("WALLET_PRIVATE_KEY")

        if private_key:
            keypair = KeypairUtils.from_string(private_key)
            public_key = keypair.pubkey()
            _keypair: Optional[Keypair] = keypair
        else:
            # Fall back to public key only
            public_key_str = os.getenv("SOLANA_PUBLIC_KEY") or os.getenv(
                "WALLET_PUBLIC_KEY"
            )
            if not public_key_str:
                raise ConfigError(
                    "Either SOLANA_PRIVATE_KEY or SOLANA_PUBLIC_KEY is required"
                )
            try:
                public_key = Pubkey.from_string(public_key_str)
            except Exception as e:
                raise InvalidPublicKeyError(f"Invalid public key: {e}") from e
            _keypair = None

        slippage_str = os.getenv("SLIPPAGE", "50")
        try:
            slippage_bps = int(slippage_str)
        except ValueError:
            slippage_bps = 50

        return cls(
            rpc_url=rpc_url,
            public_key=public_key,
            slippage_bps=slippage_bps,
            helius_api_key=os.getenv("HELIUS_API_KEY"),
            birdeye_api_key=os.getenv("BIRDEYE_API_KEY"),
            _keypair=_keypair,
        )

    @property
    def can_sign(self) -> bool:
        """Check if this wallet can sign transactions."""
        return self._keypair is not None

    @property
    def keypair(self) -> Keypair:
        """Get the keypair if available.

        Raises:
            ConfigError: If no private key is configured.
        """
        if self._keypair is None:
            raise ConfigError("Private key not configured - read-only wallet")
        return self._keypair

    def with_slippage(self, slippage_bps: int) -> "WalletConfig":
        """Return a new config with the specified slippage."""
        return WalletConfig(
            rpc_url=self.rpc_url,
            public_key=self.public_key,
            slippage_bps=slippage_bps,
            helius_api_key=self.helius_api_key,
            birdeye_api_key=self.birdeye_api_key,
            _keypair=self._keypair,
        )

    def with_helius_key(self, key: str) -> "WalletConfig":
        """Return a new config with the specified Helius API key."""
        return WalletConfig(
            rpc_url=self.rpc_url,
            public_key=self.public_key,
            slippage_bps=self.slippage_bps,
            helius_api_key=key,
            birdeye_api_key=self.birdeye_api_key,
            _keypair=self._keypair,
        )

    def with_birdeye_key(self, key: str) -> "WalletConfig":
        """Return a new config with the specified Birdeye API key."""
        return WalletConfig(
            rpc_url=self.rpc_url,
            public_key=self.public_key,
            slippage_bps=self.slippage_bps,
            helius_api_key=self.helius_api_key,
            birdeye_api_key=key,
            _keypair=self._keypair,
        )


