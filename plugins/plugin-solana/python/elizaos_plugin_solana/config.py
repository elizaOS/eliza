import logging
import os
from collections.abc import Callable
from dataclasses import dataclass, field

from solders.keypair import Keypair
from solders.pubkey import Pubkey

from elizaos_plugin_solana.errors import ConfigError, InvalidPublicKeyError
from elizaos_plugin_solana.keypair import KeypairUtils

DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com"

logger = logging.getLogger(__name__)

SettingStorageCallback = Callable[[str, str, bool], None]


@dataclass
class WalletConfig:
    rpc_url: str
    public_key: Pubkey
    slippage_bps: int = 50
    helius_api_key: str | None = None
    birdeye_api_key: str | None = None
    _keypair: Keypair | None = field(default=None, repr=False)

    @classmethod
    def read_only(cls, rpc_url: str, public_key: str) -> "WalletConfig":
        try:
            pubkey = Pubkey.from_string(public_key)
        except Exception as e:
            raise InvalidPublicKeyError(f"Invalid public key: {e}") from e

        return cls(rpc_url=rpc_url, public_key=pubkey)

    @classmethod
    def with_keypair(cls, rpc_url: str, private_key: str) -> "WalletConfig":
        keypair = KeypairUtils.from_string(private_key)
        return cls(
            rpc_url=rpc_url,
            public_key=keypair.pubkey(),
            _keypair=keypair,
        )

    @classmethod
    def from_env(cls) -> "WalletConfig":
        rpc_url = os.getenv("SOLANA_RPC_URL", DEFAULT_RPC_URL)

        private_key = os.getenv("SOLANA_PRIVATE_KEY") or os.getenv("WALLET_PRIVATE_KEY")

        if private_key:
            keypair = KeypairUtils.from_string(private_key)
            public_key = keypair.pubkey()
            _keypair: Keypair | None = keypair
        else:
            public_key_str = os.getenv("SOLANA_PUBLIC_KEY") or os.getenv("WALLET_PUBLIC_KEY")
            if not public_key_str:
                raise ConfigError("Either SOLANA_PRIVATE_KEY or SOLANA_PUBLIC_KEY is required")
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

    @classmethod
    def from_env_or_generate(
        cls,
        store_callback: SettingStorageCallback | None = None,
    ) -> "WalletConfig":
        rpc_url = os.getenv("SOLANA_RPC_URL", DEFAULT_RPC_URL)

        private_key = os.getenv("SOLANA_PRIVATE_KEY") or os.getenv("WALLET_PRIVATE_KEY")

        if private_key:
            keypair = KeypairUtils.from_string(private_key)
            public_key = keypair.pubkey()
        else:
            public_key_str = os.getenv("SOLANA_PUBLIC_KEY") or os.getenv("WALLET_PUBLIC_KEY")
            if public_key_str:
                try:
                    public_key = Pubkey.from_string(public_key_str)
                    keypair = None
                except Exception as e:
                    raise InvalidPublicKeyError(f"Invalid public key: {e}") from e
            else:
                keypair = KeypairUtils.generate()
                public_key = keypair.pubkey()
                private_key_base58 = KeypairUtils.to_base58(keypair)
                public_key_base58 = str(public_key)

                if store_callback:
                    store_callback("SOLANA_PRIVATE_KEY", private_key_base58, True)
                    store_callback("SOLANA_PUBLIC_KEY", public_key_base58, False)

                logger.warning("No Solana wallet found. Generated new wallet automatically.")
                logger.warning(f"New Solana wallet address: {public_key_base58}")
                logger.warning("Private key stored in agent settings.")
                logger.warning("Fund this wallet to enable SOL and token transfers.")

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
            _keypair=keypair,
        )

    @property
    def can_sign(self) -> bool:
        return self._keypair is not None

    @property
    def keypair(self) -> Keypair:
        if self._keypair is None:
            raise ConfigError("Private key not configured - read-only wallet")
        return self._keypair

    def with_slippage(self, slippage_bps: int) -> "WalletConfig":
        return WalletConfig(
            rpc_url=self.rpc_url,
            public_key=self.public_key,
            slippage_bps=slippage_bps,
            helius_api_key=self.helius_api_key,
            birdeye_api_key=self.birdeye_api_key,
            _keypair=self._keypair,
        )

    def with_helius_key(self, key: str) -> "WalletConfig":
        return WalletConfig(
            rpc_url=self.rpc_url,
            public_key=self.public_key,
            slippage_bps=self.slippage_bps,
            helius_api_key=key,
            birdeye_api_key=self.birdeye_api_key,
            _keypair=self._keypair,
        )

    def with_birdeye_key(self, key: str) -> "WalletConfig":
        return WalletConfig(
            rpc_url=self.rpc_url,
            public_key=self.public_key,
            slippage_bps=self.slippage_bps,
            helius_api_key=self.helius_api_key,
            birdeye_api_key=key,
            _keypair=self._keypair,
        )
