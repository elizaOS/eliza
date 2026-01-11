"""
Settings + secrets helpers for elizaOS (Python).

This module is intended to be wire-compatible with the TypeScript implementation in
`packages/typescript/src/settings.ts` and the Rust implementation in `packages/rust/src/settings.rs`.

Core behavior:
- `get_salt()` reads `SECRET_SALT` (defaulting to "secretsalt")
- `encrypt_string_value()` / `decrypt_string_value()` implement AES-256-CBC with a SHA-256 derived key
  and an IV stored alongside ciphertext in `ivHex:ciphertextHex` format.
- If the input already looks encrypted, `encrypt_string_value()` returns it unchanged.
- If the input does not look encrypted or decryption fails, `decrypt_string_value()` returns it unchanged.
"""

from __future__ import annotations

import hashlib
import os
import secrets
from collections.abc import Mapping

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7


def get_salt() -> str:
    """Get the salt used for encrypting/decrypting secrets (matches TS default behavior)."""

    return os.environ.get("SECRET_SALT", "secretsalt")


def _derive_key(salt: str) -> bytes:
    # SHA-256(salt) and take first 32 bytes (matches TS/Rust behavior)
    return hashlib.sha256(salt.encode("utf-8")).digest()[:32]


def _looks_encrypted(value: str) -> bool:
    parts = value.split(":")
    if len(parts) != 2:
        return False
    iv_hex = parts[0]
    try:
        iv = bytes.fromhex(iv_hex)
    except ValueError:
        return False
    return len(iv) == 16


def encrypt_string_value(value: object, salt: str) -> object:
    """
    Encrypt a string using AES-256-CBC.

    Output format: `ivHex:ciphertextHex`

    Matches TS behavior for non-strings:
    - None/bool/int/float are returned unchanged
    - other types are returned unchanged
    """

    if value is None or isinstance(value, (bool, int, float)):
        return value
    if not isinstance(value, str):
        return value

    if _looks_encrypted(value):
        return value

    key = _derive_key(salt)
    iv = secrets.token_bytes(16)

    padder = PKCS7(128).padder()  # AES block size = 128 bits
    padded = padder.update(value.encode("utf-8")) + padder.finalize()

    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
    encryptor = cipher.encryptor()
    ciphertext = encryptor.update(padded) + encryptor.finalize()

    return f"{iv.hex()}:{ciphertext.hex()}"


def decrypt_string_value(value: object, salt: str) -> object:
    """
    Decrypt a string in `ivHex:ciphertextHex` format using AES-256-CBC.

    If the input is not encrypted (or decryption fails), returns the original input unchanged.
    Matches TS/Rust behavior.
    """

    if not isinstance(value, str):
        return value

    parts = value.split(":")
    if len(parts) != 2:
        return value

    iv_hex, ciphertext_hex = parts
    try:
        iv = bytes.fromhex(iv_hex)
    except ValueError:
        return value
    if len(iv) != 16:
        return value

    try:
        ciphertext = bytes.fromhex(ciphertext_hex)
    except ValueError:
        return value

    key = _derive_key(salt)
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
    decryptor = cipher.decryptor()

    try:
        padded = decryptor.update(ciphertext) + decryptor.finalize()
    except Exception:
        return value

    try:
        unpadder = PKCS7(128).unpadder()
        plaintext_bytes = unpadder.update(padded) + unpadder.finalize()
    except ValueError:
        return value

    try:
        return plaintext_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return value


def encrypt_object_values(obj: Mapping[str, object], salt: str) -> dict[str, object]:
    """Encrypt all non-empty string values in an object (shallow)."""

    result: dict[str, object] = {}
    for key, value in obj.items():
        if isinstance(value, str) and value:
            result[key] = encrypt_string_value(value, salt)
        else:
            result[key] = value
    return result


def decrypt_object_values(obj: Mapping[str, object], salt: str) -> dict[str, object]:
    """Decrypt all string values in an object (shallow)."""

    result: dict[str, object] = {}
    for key, value in obj.items():
        if isinstance(value, str) and value:
            result[key] = decrypt_string_value(value, salt)
        else:
            result[key] = value
    return result


# TS exports decryptStringValue as decryptSecret; mirror that convenience alias.
decrypt_secret = decrypt_string_value



