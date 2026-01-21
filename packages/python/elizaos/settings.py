from __future__ import annotations

import hashlib
import os
import secrets
from collections.abc import Mapping

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.padding import PKCS7


def get_salt() -> str:
    salt = os.environ.get("SECRET_SALT", "secretsalt")
    node_env = os.environ.get("NODE_ENV", "").strip().lower()
    allow_default = os.environ.get("ELIZA_ALLOW_DEFAULT_SECRET_SALT", "").strip().lower() == "true"
    if node_env == "production" and salt == "secretsalt" and not allow_default:
        raise RuntimeError(
            "SECRET_SALT must be set to a non-default value in production. "
            "Set ELIZA_ALLOW_DEFAULT_SECRET_SALT=true to override (not recommended)."
        )
    return salt


def _derive_key(salt: str) -> bytes:
    return hashlib.sha256(salt.encode("utf-8")).digest()[:32]


def _looks_encrypted(value: str) -> bool:
    parts = value.split(":")
    # v2: v2:ivHex:ciphertextHex:tagHex
    if len(parts) == 4 and parts[0] == "v2":
        try:
            iv = bytes.fromhex(parts[1])
            tag = bytes.fromhex(parts[3])
        except ValueError:
            return False
        return len(iv) == 12 and len(tag) == 16

    # v1 legacy: ivHex:ciphertextHex
    if len(parts) != 2:
        return False
    try:
        iv = bytes.fromhex(parts[0])
    except ValueError:
        return False
    return len(iv) == 16


def encrypt_string_value(value: object, salt: str) -> object:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if not isinstance(value, str):
        return value

    if _looks_encrypted(value):
        return value

    # v2: AES-256-GCM with integrity tag
    key = _derive_key(salt)
    iv = secrets.token_bytes(12)
    aad = b"elizaos:settings:v2"
    aesgcm = AESGCM(key)
    ciphertext_and_tag = aesgcm.encrypt(iv, value.encode("utf-8"), aad)
    ciphertext = ciphertext_and_tag[:-16]
    tag = ciphertext_and_tag[-16:]
    return f"v2:{iv.hex()}:{ciphertext.hex()}:{tag.hex()}"


def decrypt_string_value(value: object, salt: str) -> object:
    if not isinstance(value, str):
        return value

    parts = value.split(":")
    if len(parts) == 4 and parts[0] == "v2":
        try:
            iv = bytes.fromhex(parts[1])
            ciphertext = bytes.fromhex(parts[2])
            tag = bytes.fromhex(parts[3])
        except ValueError:
            return value
        if len(iv) != 12 or len(tag) != 16:
            return value

        key = _derive_key(salt)
        aad = b"elizaos:settings:v2"
        aesgcm = AESGCM(key)
        try:
            plaintext_bytes = aesgcm.decrypt(iv, ciphertext + tag, aad)
        except Exception:
            return value
        try:
            return plaintext_bytes.decode("utf-8")
        except UnicodeDecodeError:
            return value

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
    result: dict[str, object] = {}
    for key, value in obj.items():
        if isinstance(value, str) and value:
            result[key] = encrypt_string_value(value, salt)
        else:
            result[key] = value
    return result


def decrypt_object_values(obj: Mapping[str, object], salt: str) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in obj.items():
        if isinstance(value, str) and value:
            result[key] = decrypt_string_value(value, salt)
        else:
            result[key] = value
    return result


def migrate_encrypted_string_value(value: object, salt: str) -> object:
    """
    Migrate a legacy v1 encrypted string (AES-CBC) to v2 (AES-GCM).

    - v2 values are returned unchanged
    - v1 values are decrypted then re-encrypted as v2
    - non-encrypted values are returned unchanged
    """
    if not isinstance(value, str):
        return value
    if value.startswith("v2:"):
        return value
    if not _looks_encrypted(value):
        return value

    decrypted = decrypt_string_value(value, salt)
    if decrypted == value:
        return value
    return encrypt_string_value(decrypted, salt)


def migrate_object_values(obj: Mapping[str, object], salt: str) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in obj.items():
        result[key] = migrate_encrypted_string_value(value, salt)
    return result


decrypt_secret = decrypt_string_value
