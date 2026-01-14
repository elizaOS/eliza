import base64
import re

import base58
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from elizaos_plugin_solana.errors import InvalidKeypairError


class KeypairUtils:
    @staticmethod
    def from_string(s: str) -> Keypair:
        try:
            key_bytes = base58.b58decode(s)
            if len(key_bytes) == 64:
                return Keypair.from_bytes(key_bytes)
        except Exception:
            pass

        # Try Base64
        try:
            key_bytes = base64.b64decode(s)
            if len(key_bytes) == 64:
                return Keypair.from_bytes(key_bytes)
        except Exception:
            pass

        raise InvalidKeypairError(
            "Invalid private key format - expected 64-byte Base58 or Base64 encoded key"
        )

    @staticmethod
    def generate() -> Keypair:
        return Keypair()

    @staticmethod
    def to_base58(keypair: Keypair) -> str:
        return base58.b58encode(bytes(keypair)).decode("utf-8")

    @staticmethod
    def is_valid_pubkey(pubkey_str: str) -> bool:
        try:
            Pubkey.from_string(pubkey_str)
            return True
        except Exception:
            return False

    @staticmethod
    def is_on_curve(pubkey_str: str) -> bool | None:
        try:
            pubkey = Pubkey.from_string(pubkey_str)
            return pubkey.is_on_curve()
        except Exception:
            return None

    @staticmethod
    def detect_pubkeys_in_text(text: str, check_curve: bool = False) -> list[str]:
        results: list[str] = []
        # Base58 pattern for Solana public keys (32-44 chars)
        pattern = r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b"

        for match in re.finditer(pattern, text):
            candidate = match.group(0)
            try:
                key_bytes = base58.b58decode(candidate)
                if len(key_bytes) == 32:
                    if check_curve:
                        pubkey = Pubkey.from_bytes(key_bytes)
                        if pubkey.is_on_curve():
                            results.append(candidate)
                    else:
                        results.append(candidate)
            except Exception:
                pass

        return results

    @staticmethod
    def detect_private_keys_in_text(text: str) -> list[dict[str, str]]:
        results: list[dict[str, str]] = []

        # Base58 private key pattern (86-90 chars for 64 bytes)
        base58_pattern = r"\b[1-9A-HJ-NP-Za-km-z]{86,90}\b"
        for match in re.finditer(base58_pattern, text):
            candidate = match.group(0)
            try:
                key_bytes = base58.b58decode(candidate)
                if len(key_bytes) == 64:
                    results.append({"format": "base58", "match": candidate})
            except Exception:
                pass

        # Hex private key pattern (128 hex chars for 64 bytes)
        hex_pattern = r"\b[a-fA-F0-9]{128}\b"
        for match in re.finditer(hex_pattern, text):
            candidate = match.group(0)
            try:
                key_bytes = bytes.fromhex(candidate)
                if len(key_bytes) == 64:
                    results.append({"format": "hex", "match": candidate})
            except Exception:
                pass

        return results
