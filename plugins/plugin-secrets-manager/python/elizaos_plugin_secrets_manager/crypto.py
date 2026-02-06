"""
Encryption module for secrets management.

Provides AES-256-GCM encryption with secure key derivation.
"""

import os
import base64
import hashlib
import secrets
from typing import Optional, Union

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.backends import default_backend

from .types import EncryptedSecret, EncryptionError


# Constants
KEY_LENGTH = 32  # 256 bits
IV_LENGTH = 16  # 128 bits
AUTH_TAG_LENGTH = 16  # 128 bits
DEFAULT_SALT_LENGTH = 32
DEFAULT_PBKDF2_ITERATIONS = 100000


def generate_salt(length: int = DEFAULT_SALT_LENGTH) -> str:
    """Generate a cryptographically secure random salt."""
    return base64.b64encode(os.urandom(length)).decode("utf-8")


def generate_key() -> bytes:
    """Generate a random encryption key."""
    return os.urandom(KEY_LENGTH)


def derive_key_pbkdf2(
    password: str,
    salt: Union[str, bytes],
    iterations: int = DEFAULT_PBKDF2_ITERATIONS,
) -> bytes:
    """
    Derive an encryption key from a password using PBKDF2.
    
    Args:
        password: The password to derive from
        salt: Salt value (base64 string or bytes)
        iterations: Number of PBKDF2 iterations
        
    Returns:
        Derived key as bytes
    """
    salt_bytes = base64.b64decode(salt) if isinstance(salt, str) else salt
    
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=KEY_LENGTH,
        salt=salt_bytes,
        iterations=iterations,
        backend=default_backend(),
    )
    
    return kdf.derive(password.encode("utf-8"))


def derive_key_from_agent_id(agent_id: str, salt: str = "default-salt") -> bytes:
    """
    Derive a key from agent ID and salt.
    
    This provides compatibility with the TypeScript implementation.
    
    Args:
        agent_id: The agent's unique identifier
        salt: Optional salt value
        
    Returns:
        Derived key as bytes
    """
    combined = agent_id + salt
    return hashlib.sha256(combined.encode("utf-8")).digest()


def encrypt(
    plaintext: str,
    key: bytes,
    key_id: str = "default",
) -> EncryptedSecret:
    """
    Encrypt a value using AES-256-GCM.
    
    Args:
        plaintext: The value to encrypt
        key: The encryption key (32 bytes)
        key_id: Identifier for the key
        
    Returns:
        EncryptedSecret container
    """
    if len(key) != KEY_LENGTH:
        raise EncryptionError(
            f"Invalid key length: expected {KEY_LENGTH}, got {len(key)}"
        )
    
    # Generate random IV
    iv = os.urandom(IV_LENGTH)
    
    # Create cipher
    cipher = Cipher(
        algorithms.AES(key),
        modes.GCM(iv),
        backend=default_backend(),
    )
    encryptor = cipher.encryptor()
    
    # Encrypt
    ciphertext = encryptor.update(plaintext.encode("utf-8")) + encryptor.finalize()
    
    return EncryptedSecret(
        value=base64.b64encode(ciphertext).decode("utf-8"),
        iv=base64.b64encode(iv).decode("utf-8"),
        auth_tag=base64.b64encode(encryptor.tag).decode("utf-8"),
        algorithm="aes-256-gcm",
        key_id=key_id,
    )


def decrypt(
    encrypted: Union[EncryptedSecret, str, dict],
    key: bytes,
) -> str:
    """
    Decrypt a value.
    
    Args:
        encrypted: EncryptedSecret, dict, or plain string (for backward compat)
        key: The decryption key (32 bytes)
        
    Returns:
        Decrypted plaintext
    """
    # Handle plain string (backward compatibility)
    if isinstance(encrypted, str):
        return encrypted
    
    # Handle dict
    if isinstance(encrypted, dict):
        encrypted = EncryptedSecret.from_dict(encrypted)
    
    if len(key) != KEY_LENGTH:
        raise EncryptionError(
            f"Invalid key length: expected {KEY_LENGTH}, got {len(key)}"
        )
    
    if encrypted.algorithm != "aes-256-gcm":
        raise EncryptionError(
            f"Unsupported algorithm: {encrypted.algorithm}"
        )
    
    if not encrypted.auth_tag:
        raise EncryptionError("Missing authentication tag for GCM decryption")
    
    # Decode from base64
    iv = base64.b64decode(encrypted.iv)
    auth_tag = base64.b64decode(encrypted.auth_tag)
    ciphertext = base64.b64decode(encrypted.value)
    
    # Create cipher
    cipher = Cipher(
        algorithms.AES(key),
        modes.GCM(iv, auth_tag),
        backend=default_backend(),
    )
    decryptor = cipher.decryptor()
    
    # Decrypt
    plaintext = decryptor.update(ciphertext) + decryptor.finalize()
    
    return plaintext.decode("utf-8")


def is_encrypted_secret(value) -> bool:
    """Check if a value appears to be an encrypted secret."""
    if not isinstance(value, (dict, EncryptedSecret)):
        return False
    
    if isinstance(value, EncryptedSecret):
        return True
    
    return (
        isinstance(value.get("value"), str)
        and isinstance(value.get("iv"), str)
        and isinstance(value.get("algorithm"), str)
        and value.get("algorithm") in ("aes-256-gcm", "aes-256-cbc")
    )


def generate_secure_token(length: int = 32) -> str:
    """Generate a secure random token."""
    return secrets.token_hex(length)


def hash_value(value: str, algorithm: str = "sha256") -> str:
    """Hash a value for comparison or fingerprinting."""
    if algorithm == "sha256":
        return hashlib.sha256(value.encode("utf-8")).hexdigest()
    elif algorithm == "sha512":
        return hashlib.sha512(value.encode("utf-8")).hexdigest()
    else:
        raise ValueError(f"Unsupported hash algorithm: {algorithm}")


def secure_compare(a: str, b: str) -> bool:
    """Securely compare two strings in constant time."""
    return secrets.compare_digest(a, b)


class KeyManager:
    """
    Manages encryption keys with support for rotation and multiple key IDs.
    """
    
    def __init__(
        self,
        primary_key: Optional[bytes] = None,
        primary_key_id: str = "default",
    ):
        self._keys: dict[str, bytes] = {}
        self._current_key_id = primary_key_id
        
        if primary_key:
            self._keys[primary_key_id] = primary_key
    
    def initialize_from_password(self, password: str, salt: Optional[str] = None) -> None:
        """Initialize with a password-derived key."""
        actual_salt = salt or generate_salt()
        key = derive_key_pbkdf2(password, actual_salt)
        self._keys["default"] = key
        self._current_key_id = "default"
    
    def initialize_from_agent_id(self, agent_id: str, salt: Optional[str] = None) -> None:
        """Initialize with an agent ID (compatible with TypeScript)."""
        key = derive_key_from_agent_id(agent_id, salt or "default-salt")
        self._keys["default"] = key
        self._current_key_id = "default"
    
    def add_key(self, key_id: str, key: bytes) -> None:
        """Add a key for decryption (supports key rotation)."""
        self._keys[key_id] = key
    
    def set_current_key(self, key_id: str) -> None:
        """Set the current key for encryption."""
        if key_id not in self._keys:
            raise EncryptionError(f"Key not found: {key_id}")
        self._current_key_id = key_id
    
    def get_current_key_id(self) -> str:
        """Get the current key ID."""
        return self._current_key_id
    
    def get_key(self, key_id: str) -> Optional[bytes]:
        """Get a key by ID."""
        return self._keys.get(key_id)
    
    def get_current_key(self) -> bytes:
        """Get the current encryption key."""
        key = self._keys.get(self._current_key_id)
        if not key:
            raise EncryptionError("No encryption key configured")
        return key
    
    def encrypt(self, plaintext: str) -> EncryptedSecret:
        """Encrypt a value with the current key."""
        return encrypt(plaintext, self.get_current_key(), self._current_key_id)
    
    def decrypt(self, encrypted: Union[EncryptedSecret, str, dict]) -> str:
        """Decrypt a value (automatically selects the correct key)."""
        if isinstance(encrypted, str):
            return encrypted
        
        if isinstance(encrypted, dict):
            encrypted = EncryptedSecret.from_dict(encrypted)
        
        key_id = encrypted.key_id
        key = self._keys.get(key_id)
        if not key:
            raise EncryptionError(f"Key not found for decryption: {key_id}")
        
        return decrypt(encrypted, key)
    
    def reencrypt(self, encrypted: EncryptedSecret) -> EncryptedSecret:
        """Re-encrypt a value with the current key (for key rotation)."""
        plaintext = self.decrypt(encrypted)
        return self.encrypt(plaintext)
    
    def clear(self) -> None:
        """Clear all keys from memory."""
        # Zero out keys before clearing
        for key_id in list(self._keys.keys()):
            self._keys[key_id] = b"\x00" * len(self._keys[key_id])
        self._keys.clear()
