"""
Tests for the crypto module.
"""

import pytest
from elizaos_plugin_secrets_manager import (
    KeyManager,
    generate_salt,
    generate_key,
    derive_key_pbkdf2,
    derive_key_from_agent_id,
    encrypt,
    decrypt,
    is_encrypted_secret,
)
from elizaos_plugin_secrets_manager.types import EncryptedSecret


class TestSaltGeneration:
    """Test salt generation."""

    def test_generates_unique_salts(self):
        """Should generate unique salts."""
        salt1 = generate_salt(16)
        salt2 = generate_salt(16)
        assert salt1 != salt2

    def test_correct_length(self):
        """Should generate salt of correct length."""
        salt = generate_salt(16)
        assert len(salt) == 32  # Hex encoded


class TestKeyGeneration:
    """Test key generation."""

    def test_generates_unique_keys(self):
        """Should generate unique keys."""
        key1 = generate_key()
        key2 = generate_key()
        assert key1 != key2

    def test_correct_length(self):
        """Should generate 32-byte key."""
        key = generate_key()
        assert len(key) == 32


class TestKeyDerivation:
    """Test key derivation."""

    def test_derive_key_pbkdf2(self):
        """Should derive consistent keys."""
        key1 = derive_key_pbkdf2("password", "salt")
        key2 = derive_key_pbkdf2("password", "salt")
        assert key1 == key2

    def test_different_password_different_key(self):
        """Different passwords should produce different keys."""
        key1 = derive_key_pbkdf2("password1", "salt")
        key2 = derive_key_pbkdf2("password2", "salt")
        assert key1 != key2

    def test_derive_from_agent_id(self):
        """Should derive consistent keys from agent ID."""
        key1 = derive_key_from_agent_id("agent-123", "salt")
        key2 = derive_key_from_agent_id("agent-123", "salt")
        assert key1 == key2

    def test_different_agent_different_key(self):
        """Different agents should produce different keys."""
        key1 = derive_key_from_agent_id("agent-123", "salt")
        key2 = derive_key_from_agent_id("agent-456", "salt")
        assert key1 != key2


class TestEncryption:
    """Test encryption/decryption."""

    def test_encrypt_decrypt_roundtrip(self):
        """Should encrypt and decrypt successfully."""
        key = generate_key()
        plaintext = "my secret value"

        encrypted = encrypt(plaintext, key)
        decrypted = decrypt(encrypted, key)

        assert decrypted == plaintext

    def test_different_ciphertext_same_plaintext(self):
        """Same plaintext should produce different ciphertext."""
        key = generate_key()
        plaintext = "my secret value"

        encrypted1 = encrypt(plaintext, key)
        encrypted2 = encrypt(plaintext, key)

        assert encrypted1.ciphertext != encrypted2.ciphertext

    def test_wrong_key_fails(self):
        """Decryption with wrong key should fail."""
        key1 = generate_key()
        key2 = generate_key()
        plaintext = "my secret value"

        encrypted = encrypt(plaintext, key1)

        with pytest.raises(Exception):
            decrypt(encrypted, key2)

    def test_special_characters(self):
        """Should handle special characters."""
        key = generate_key()
        plaintext = "!@#$%^&*()_+-=[]{}|;:,.<>?/~`"

        encrypted = encrypt(plaintext, key)
        decrypted = decrypt(encrypted, key)

        assert decrypted == plaintext

    def test_unicode(self):
        """Should handle unicode."""
        key = generate_key()
        plaintext = "日本語-émojis-🔐🔑"

        encrypted = encrypt(plaintext, key)
        decrypted = decrypt(encrypted, key)

        assert decrypted == plaintext

    def test_empty_string(self):
        """Should handle empty string."""
        key = generate_key()
        plaintext = ""

        encrypted = encrypt(plaintext, key)
        decrypted = decrypt(encrypted, key)

        assert decrypted == plaintext


class TestIsEncryptedSecret:
    """Test encrypted secret detection."""

    def test_detects_encrypted(self):
        """Should detect encrypted secrets."""
        encrypted = EncryptedSecret(
            ciphertext="abc123",
            iv="def456",
            key_id="default",
            algorithm="aes-256-gcm",
            version=1,
        )
        assert is_encrypted_secret(encrypted.to_dict()) is True

    def test_rejects_plain_string(self):
        """Should reject plain strings."""
        assert is_encrypted_secret("plain string") is False

    def test_rejects_incomplete_object(self):
        """Should reject incomplete objects."""
        assert is_encrypted_secret({"ciphertext": "abc"}) is False


class TestKeyManager:
    """Test KeyManager class."""

    def test_initialize_from_agent_id(self):
        """Should initialize from agent ID."""
        manager = KeyManager()
        manager.initialize_from_agent_id("agent-123", "salt")

        assert manager.key_count == 1
        assert manager.primary_key_id == "default"

    def test_add_key(self):
        """Should add keys."""
        manager = KeyManager()
        key = generate_key()
        manager.add_key("my-key", key)

        assert manager.key_count == 1
        assert manager.get_key("my-key") is not None

    def test_primary_key(self):
        """Should track primary key."""
        manager = KeyManager()
        key1 = generate_key()
        key2 = generate_key()

        manager.add_key("key1", key1)
        manager.add_key("key2", key2)

        # First key becomes primary
        assert manager.primary_key_id == "key1"

        # Can change primary
        manager.set_primary_key("key2")
        assert manager.primary_key_id == "key2"

    def test_encrypt_decrypt(self):
        """Should encrypt and decrypt with key manager."""
        manager = KeyManager()
        manager.initialize_from_agent_id("agent-123", "salt")

        encrypted = manager.encrypt("secret value")
        decrypted = manager.decrypt(encrypted)

        assert decrypted == "secret value"

    def test_remove_key(self):
        """Should remove keys."""
        manager = KeyManager()
        key = generate_key()
        manager.add_key("my-key", key)

        assert manager.key_count == 1
        manager.remove_key("my-key")
        assert manager.key_count == 0

    def test_clear(self):
        """Should clear all keys."""
        manager = KeyManager()
        manager.add_key("key1", generate_key())
        manager.add_key("key2", generate_key())

        assert manager.key_count == 2
        manager.clear()
        assert manager.key_count == 0
        assert manager.primary_key_id is None
