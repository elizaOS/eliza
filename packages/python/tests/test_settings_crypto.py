import secrets

import pytest
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7

from elizaos import AgentRuntime, Character
from elizaos.settings import (
    _derive_key,
    decrypt_string_value,
    encrypt_string_value,
    get_salt,
    migrate_encrypted_string_value,
)


class TestSettingsCrypto:
    def test_get_salt_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("SECRET_SALT", raising=False)
        assert get_salt() == "secretsalt"

    def test_encrypt_decrypt_roundtrip(self) -> None:
        salt = "test-salt-value"
        plaintext = "sensitive-data"

        encrypted = encrypt_string_value(plaintext, salt)
        assert isinstance(encrypted, str)
        assert encrypted != plaintext
        assert ":" in encrypted

        decrypted = decrypt_string_value(encrypted, salt)
        assert decrypted == plaintext

    def test_encrypt_is_idempotent_for_encrypted_values(self) -> None:
        salt = "test-salt-value"
        plaintext = "hello"
        encrypted = encrypt_string_value(plaintext, salt)
        assert isinstance(encrypted, str)
        encrypted2 = encrypt_string_value(encrypted, salt)
        assert encrypted2 == encrypted

    def test_decrypt_non_encrypted_returns_original(self) -> None:
        salt = "test-salt-value"
        assert decrypt_string_value("not-encrypted", salt) == "not-encrypted"

    def test_decrypt_legacy_v1_aes_cbc_value(self) -> None:
        salt = "test-salt-value"
        plaintext = "legacy-secret"

        key = _derive_key(salt)
        iv = secrets.token_bytes(16)

        padder = PKCS7(128).padder()
        padded = padder.update(plaintext.encode("utf-8")) + padder.finalize()

        cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
        encryptor = cipher.encryptor()
        ciphertext = encryptor.update(padded) + encryptor.finalize()

        legacy = f"{iv.hex()}:{ciphertext.hex()}"
        assert decrypt_string_value(legacy, salt) == plaintext

    def test_migrate_legacy_v1_to_v2(self) -> None:
        salt = "test-salt-value"
        plaintext = "legacy-migrate"

        key = _derive_key(salt)
        iv = secrets.token_bytes(16)
        padder = PKCS7(128).padder()
        padded = padder.update(plaintext.encode("utf-8")) + padder.finalize()
        cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
        encryptor = cipher.encryptor()
        ciphertext = encryptor.update(padded) + encryptor.finalize()
        legacy = f"{iv.hex()}:{ciphertext.hex()}"

        migrated = migrate_encrypted_string_value(legacy, salt)
        assert isinstance(migrated, str)
        assert migrated.startswith("v2:")
        assert decrypt_string_value(migrated, salt) == plaintext

    def test_runtime_get_setting_decrypts_secret_strings(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        salt = "test-salt-value"
        monkeypatch.setenv("SECRET_SALT", salt)

        encrypted_api_key = encrypt_string_value("super-secret", salt)
        assert isinstance(encrypted_api_key, str)

        character = Character(
            name="TestAgent",
            bio="Test",
            secrets={"API_KEY": encrypted_api_key},
        )
        runtime = AgentRuntime(character=character)
        assert runtime.get_setting("API_KEY") == "super-secret"

    def test_runtime_get_setting_coerces_true_false_strings(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        salt = "test-salt-value"
        monkeypatch.setenv("SECRET_SALT", salt)

        encrypted_true = encrypt_string_value("true", salt)
        encrypted_false = encrypt_string_value("false", salt)
        assert isinstance(encrypted_true, str)
        assert isinstance(encrypted_false, str)

        character = Character(
            name="TestAgent",
            bio="Test",
            secrets={"FLAG_TRUE": encrypted_true, "FLAG_FALSE": encrypted_false},
        )
        runtime = AgentRuntime(character=character)
        assert runtime.get_setting("FLAG_TRUE") is True
        assert runtime.get_setting("FLAG_FALSE") is False
