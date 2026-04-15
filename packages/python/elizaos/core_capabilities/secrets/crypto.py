"""Encryption module for secrets management.

Provides AES-256-GCM encryption with secure key derivation using the
``cryptography`` library.  Ported from plugin-secrets-manager TypeScript
encryption module.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
from typing import Any

from .types import EncryptedSecret, EncryptionError, KeyDerivationParams

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

KEY_LENGTH = 32  # 256 bits
IV_LENGTH = 12  # 96 bits for AES-GCM nonce
DEFAULT_SALT_LENGTH = 32
DEFAULT_PBKDF2_ITERATIONS = 100_000

# ---------------------------------------------------------------------------
# Key derivation
# ---------------------------------------------------------------------------


def generate_salt(length: int = DEFAULT_SALT_LENGTH) -> str:
    """Generate a cryptographically secure random salt (base64-encoded)."""
    return base64.b64encode(os.urandom(length)).decode()


def generate_key() -> bytes:
    """Generate a random 256-bit encryption key."""
    return os.urandom(KEY_LENGTH)


def derive_key_pbkdf2(
    password: str,
    salt: str | bytes,
    iterations: int = DEFAULT_PBKDF2_ITERATIONS,
) -> bytes:
    """Derive an encryption key from a password using PBKDF2-HMAC-SHA256."""
    try:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    except ImportError as exc:
        raise ImportError(
            "The 'cryptography' package is required for secrets encryption. "
            "Install it with: pip install cryptography"
        ) from exc

    salt_bytes = base64.b64decode(salt) if isinstance(salt, str) else salt
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=KEY_LENGTH,
        salt=salt_bytes,
        iterations=iterations,
    )
    return kdf.derive(password.encode("utf-8"))


def derive_key_from_agent_id(agent_id: str, salt: str = "default-salt") -> bytes:
    """Derive a key from agent ID and salt (backward-compatible approach)."""
    return hashlib.sha256((agent_id + salt).encode("utf-8")).digest()


def create_key_derivation_params(
    salt: str | None = None,
    iterations: int = DEFAULT_PBKDF2_ITERATIONS,
) -> KeyDerivationParams:
    """Create key derivation parameters for storage."""
    return KeyDerivationParams(
        salt=salt or generate_salt(),
        iterations=iterations,
        algorithm="pbkdf2-sha256",
        key_length=KEY_LENGTH,
    )


# ---------------------------------------------------------------------------
# Encryption / Decryption
# ---------------------------------------------------------------------------


def encrypt_gcm(
    plaintext: str,
    key: bytes,
    key_id: str = "default",
) -> EncryptedSecret:
    """Encrypt a value using AES-256-GCM.

    GCM provides both confidentiality and authenticity.
    """
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:
        raise ImportError(
            "The 'cryptography' package is required for secrets encryption. "
            "Install it with: pip install cryptography"
        ) from exc

    if len(key) != KEY_LENGTH:
        raise EncryptionError(f"Invalid key length: expected {KEY_LENGTH}, got {len(key)}")

    nonce = os.urandom(IV_LENGTH)
    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)

    # AESGCM.encrypt returns ciphertext + auth_tag concatenated
    # The auth tag is the last 16 bytes
    encrypted_data = ciphertext[:-16]
    auth_tag = ciphertext[-16:]

    return EncryptedSecret(
        value=base64.b64encode(encrypted_data).decode(),
        iv=base64.b64encode(nonce).decode(),
        auth_tag=base64.b64encode(auth_tag).decode(),
        algorithm="aes-256-gcm",
        key_id=key_id,
    )


def decrypt_gcm(encrypted: EncryptedSecret, key: bytes) -> str:
    """Decrypt a value encrypted with AES-256-GCM."""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:
        raise ImportError(
            "The 'cryptography' package is required for secrets encryption. "
            "Install it with: pip install cryptography"
        ) from exc

    if len(key) != KEY_LENGTH:
        raise EncryptionError(f"Invalid key length: expected {KEY_LENGTH}, got {len(key)}")

    if encrypted.algorithm != "aes-256-gcm":
        raise EncryptionError(
            f"Algorithm mismatch: expected aes-256-gcm, got {encrypted.algorithm}"
        )

    if not encrypted.auth_tag:
        raise EncryptionError("Missing authentication tag for GCM decryption")

    nonce = base64.b64decode(encrypted.iv)
    ciphertext = base64.b64decode(encrypted.value)
    auth_tag = base64.b64decode(encrypted.auth_tag)

    # Reconstruct the full ciphertext (data + auth_tag) as expected by AESGCM
    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(nonce, ciphertext + auth_tag, None)
    return plaintext.decode("utf-8")


def encrypt(
    plaintext: str,
    key: bytes,
    key_id: str = "default",
) -> EncryptedSecret:
    """Encrypt a value using the default algorithm (AES-256-GCM)."""
    return encrypt_gcm(plaintext, key, key_id)


def decrypt(encrypted: EncryptedSecret | str, key: bytes) -> str:
    """Decrypt a value.  Passes through plain strings for backward compat."""
    if isinstance(encrypted, str):
        return encrypted
    if encrypted.algorithm == "aes-256-gcm":
        return decrypt_gcm(encrypted, key)
    raise EncryptionError(f"Unsupported algorithm: {encrypted.algorithm}")


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------


def is_encrypted_secret(value: Any) -> bool:
    """Check if a value appears to be an encrypted secret."""
    if not isinstance(value, dict):
        return False
    return (
        isinstance(value.get("value"), str)
        and isinstance(value.get("iv"), str)
        and value.get("algorithm") in ("aes-256-gcm", "aes-256-cbc")
    )


def generate_secure_token(length: int = 32) -> str:
    """Generate a secure random hex token."""
    return os.urandom(length).hex()


def hash_value(value: str, algorithm: str = "sha256") -> str:
    """Hash a value for comparison or fingerprinting."""
    h = hashlib.new(algorithm)
    h.update(value.encode("utf-8"))
    return h.hexdigest()


def secure_compare(a: str, b: str) -> bool:
    """Constant-time string comparison to prevent timing attacks."""
    return hmac.compare_digest(a.encode(), b.encode())


# ---------------------------------------------------------------------------
# KeyManager
# ---------------------------------------------------------------------------


class KeyManager:
    """Manages encryption keys with support for rotation and multiple key IDs."""

    def __init__(
        self,
        primary_key: bytes | None = None,
        primary_key_id: str | None = None,
        derivation_params: KeyDerivationParams | None = None,
    ) -> None:
        self._keys: dict[str, bytes] = {}
        self._current_key_id: str = "default"
        self._derivation_params: KeyDerivationParams | None = derivation_params

        if primary_key is not None:
            kid = primary_key_id or "default"
            self._keys[kid] = primary_key
            self._current_key_id = kid

    def initialize_from_password(self, password: str, salt: str | None = None) -> None:
        """Initialize with a password-derived key."""
        self._derivation_params = create_key_derivation_params(salt)
        key = derive_key_pbkdf2(
            password, self._derivation_params.salt, self._derivation_params.iterations
        )
        self._keys["default"] = key
        self._current_key_id = "default"

    def initialize_from_agent_id(self, agent_id: str, salt: str | None = None) -> None:
        """Initialize with an agent-ID-derived key."""
        key = derive_key_from_agent_id(agent_id, salt or "default-salt")
        self._keys["default"] = key
        self._current_key_id = "default"

    def add_key(self, key_id: str, key: bytes) -> None:
        self._keys[key_id] = key

    def set_current_key(self, key_id: str) -> None:
        if key_id not in self._keys:
            raise EncryptionError(f"Key not found: {key_id}")
        self._current_key_id = key_id

    @property
    def current_key_id(self) -> str:
        return self._current_key_id

    def get_key(self, key_id: str) -> bytes | None:
        return self._keys.get(key_id)

    def get_current_key(self) -> bytes:
        key = self._keys.get(self._current_key_id)
        if key is None:
            raise EncryptionError("No encryption key configured")
        return key

    @property
    def derivation_params(self) -> KeyDerivationParams | None:
        return self._derivation_params

    def encrypt(self, plaintext: str) -> EncryptedSecret:
        return encrypt_gcm(plaintext, self.get_current_key(), self._current_key_id)

    def decrypt(self, encrypted: EncryptedSecret | str) -> str:
        if isinstance(encrypted, str):
            return encrypted
        key = self._keys.get(encrypted.key_id)
        if key is None:
            raise EncryptionError(f"Key not found for decryption: {encrypted.key_id}")
        return decrypt(encrypted, key)

    def reencrypt(self, encrypted: EncryptedSecret) -> EncryptedSecret:
        """Re-encrypt with the current key (for key rotation)."""
        plaintext = self.decrypt(encrypted)
        return self.encrypt(plaintext)

    def clear(self) -> None:
        """Securely clear all keys from memory."""
        for key_id in list(self._keys):
            k = self._keys[key_id]
            # Overwrite the bytearray to mitigate memory exposure
            ba = bytearray(k)
            for i in range(len(ba)):
                ba[i] = 0
            del self._keys[key_id]
        self._keys.clear()
