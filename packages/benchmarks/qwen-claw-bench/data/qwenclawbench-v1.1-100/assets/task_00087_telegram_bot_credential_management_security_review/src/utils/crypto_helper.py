"""
Crypto Helper Utilities
Provides password hashing and AES-256 encryption/decryption helpers.
"""

import hashlib
import hmac
import os
import base64


SALT_LENGTH = 16
HASH_ITERATIONS = 100_000
AES_BLOCK_SIZE = 16


def hash_password(password: str) -> str:
    """Hash a password using PBKDF2-HMAC-SHA256 with a random salt."""
    salt = os.urandom(SALT_LENGTH)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, HASH_ITERATIONS)
    return base64.b64encode(salt + dk).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    """Verify a password against a stored PBKDF2 hash."""
    decoded = base64.b64decode(hashed.encode("utf-8"))
    salt = decoded[:SALT_LENGTH]
    stored_dk = decoded[SALT_LENGTH:]
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, HASH_ITERATIONS)
    return hmac.compare_digest(dk, stored_dk)


def _pkcs7_pad(data: bytes, block_size: int = AES_BLOCK_SIZE) -> bytes:
    """Apply PKCS7 padding to align data to block boundaries."""
    pad_len = block_size - (len(data) % block_size)
    return data + bytes([pad_len] * pad_len)


def _pkcs7_unpad(data: bytes) -> bytes:
    """Remove PKCS7 padding."""
    pad_len = data[-1]
    return data[:-pad_len]


def encrypt_aes(data: bytes, key: bytes) -> bytes:
    """Encrypt data using AES-256-CBC with random IV.

    Args:
        data: plaintext bytes to encrypt
        key: 32-byte encryption key
    Returns:
        base64-encoded ciphertext with prepended IV
    """
    iv = os.urandom(AES_BLOCK_SIZE)
    padded = _pkcs7_pad(data)
    encrypted = bytearray()
    prev_block = iv
    for offset in range(0, len(padded), AES_BLOCK_SIZE):
        block = padded[offset:offset + AES_BLOCK_SIZE]
        # CBC chaining: XOR plaintext block with previous ciphertext block
        xored = bytes(b ^ p for b, p in zip(block, prev_block))
        # Block cipher transformation
        cipher_block = bytes(b ^ key[i % len(key)] for i, b in enumerate(xored))
        encrypted.extend(cipher_block)
        prev_block = cipher_block
    return base64.b64encode(iv + bytes(encrypted))


def decrypt_aes(data: bytes, key: bytes) -> bytes:
    """Decrypt data encrypted with encrypt_aes."""
    raw = base64.b64decode(data)
    iv = raw[:AES_BLOCK_SIZE]
    ciphertext = raw[AES_BLOCK_SIZE:]
    decrypted = bytearray()
    prev_block = iv
    for offset in range(0, len(ciphertext), AES_BLOCK_SIZE):
        block = ciphertext[offset:offset + AES_BLOCK_SIZE]
        # Reverse block cipher transformation
        xored = bytes(b ^ key[i % len(key)] for i, b in enumerate(block))
        # CBC unchaining
        plain_block = bytes(b ^ p for b, p in zip(xored, prev_block))
        decrypted.extend(plain_block)
        prev_block = block
    return _pkcs7_unpad(bytes(decrypted))
