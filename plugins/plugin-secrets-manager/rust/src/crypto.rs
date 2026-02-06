//! Cryptographic utilities for secret encryption.
//!
//! Provides AES-256-GCM encryption, key derivation, and key management.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

use crate::types::{EncryptedSecret, SecretsError, SecretsResult};

/// Algorithm identifier for AES-256-GCM.
pub const ALGORITHM_AES_GCM: &str = "aes-256-gcm";

/// Current encryption version.
pub const ENCRYPTION_VERSION: u32 = 1;

/// Generate a cryptographically secure random salt.
pub fn generate_salt(length: usize) -> String {
    let mut bytes = vec![0u8; length];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Generate a random 256-bit key.
pub fn generate_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    rand::rng().fill_bytes(&mut key);
    key
}

/// Derive a key from agent ID using SHA256.
///
/// This method is compatible with the TypeScript implementation
/// for cross-language interoperability.
pub fn derive_key_from_agent_id(agent_id: &str, salt: &str) -> [u8; 32] {
    let combined = format!("{}{}", agent_id, salt);
    let mut hasher = Sha256::new();
    hasher.update(combined.as_bytes());
    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    key
}

/// Encrypt plaintext using AES-256-GCM.
pub fn encrypt(plaintext: &str, key: &[u8; 32], key_id: &str) -> SecretsResult<EncryptedSecret> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| SecretsError::EncryptionFailed {
            reason: format!("Failed to create cipher: {}", e),
        })?;

    // Generate random 12-byte nonce
    let mut nonce_bytes = [0u8; 12];
    rand::rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    // Encrypt
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| SecretsError::EncryptionFailed {
            reason: format!("Encryption failed: {}", e),
        })?;

    // For AES-GCM, the auth tag is appended to the ciphertext
    // Split it out for explicit storage
    let tag_start = ciphertext.len() - 16;
    let (cipher_bytes, tag_bytes) = ciphertext.split_at(tag_start);

    Ok(EncryptedSecret {
        ciphertext: BASE64.encode(cipher_bytes),
        iv: BASE64.encode(nonce_bytes),
        auth_tag: Some(BASE64.encode(tag_bytes)),
        key_id: key_id.to_string(),
        algorithm: ALGORITHM_AES_GCM.to_string(),
        version: ENCRYPTION_VERSION,
    })
}

/// Decrypt an encrypted secret.
pub fn decrypt(encrypted: &EncryptedSecret, key: &[u8; 32]) -> SecretsResult<String> {
    if encrypted.algorithm != ALGORITHM_AES_GCM {
        return Err(SecretsError::DecryptionFailed {
            reason: format!("Unsupported algorithm: {}", encrypted.algorithm),
        });
    }

    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| SecretsError::DecryptionFailed {
            reason: format!("Failed to create cipher: {}", e),
        })?;

    let iv = BASE64
        .decode(&encrypted.iv)
        .map_err(|e| SecretsError::DecryptionFailed {
            reason: format!("Invalid IV: {}", e),
        })?;

    let nonce = Nonce::from_slice(&iv);

    let ciphertext = BASE64
        .decode(&encrypted.ciphertext)
        .map_err(|e| SecretsError::DecryptionFailed {
            reason: format!("Invalid ciphertext: {}", e),
        })?;

    // Reconstruct ciphertext with auth tag
    let auth_tag = encrypted
        .auth_tag
        .as_ref()
        .map(|t| BASE64.decode(t))
        .transpose()
        .map_err(|e| SecretsError::DecryptionFailed {
            reason: format!("Invalid auth tag: {}", e),
        })?;

    let full_ciphertext = if let Some(tag) = auth_tag {
        let mut combined = ciphertext;
        combined.extend(tag);
        combined
    } else {
        ciphertext
    };

    let plaintext = cipher
        .decrypt(nonce, full_ciphertext.as_ref())
        .map_err(|e| SecretsError::DecryptionFailed {
            reason: format!("Decryption failed: {}", e),
        })?;

    String::from_utf8(plaintext).map_err(|e| SecretsError::DecryptionFailed {
        reason: format!("Invalid UTF-8: {}", e),
    })
}

/// Check if a value appears to be an encrypted secret.
pub fn is_encrypted_secret(value: &serde_json::Value) -> bool {
    if let Some(obj) = value.as_object() {
        obj.contains_key("ciphertext")
            && obj.contains_key("iv")
            && obj.contains_key("keyId")
            && obj.contains_key("algorithm")
    } else {
        false
    }
}

/// Parse a JSON value into an EncryptedSecret.
pub fn parse_encrypted_secret(value: &serde_json::Value) -> Option<EncryptedSecret> {
    serde_json::from_value(value.clone()).ok()
}

/// Key manager for handling multiple encryption keys.
#[derive(Debug, Default)]
pub struct KeyManager {
    keys: HashMap<String, [u8; 32]>,
    primary_key_id: Option<String>,
}

impl KeyManager {
    /// Create a new key manager.
    pub fn new() -> Self {
        Self::default()
    }

    /// Initialize from an agent ID.
    pub fn initialize_from_agent_id(&mut self, agent_id: &str, salt: &str) {
        let key = derive_key_from_agent_id(agent_id, salt);
        self.add_key("default", key);
        self.primary_key_id = Some("default".to_string());
    }

    /// Add a key to the manager.
    pub fn add_key(&mut self, key_id: &str, key: [u8; 32]) {
        self.keys.insert(key_id.to_string(), key);
        if self.primary_key_id.is_none() {
            self.primary_key_id = Some(key_id.to_string());
        }
    }

    /// Get a key by ID.
    pub fn get_key(&self, key_id: &str) -> Option<&[u8; 32]> {
        self.keys.get(key_id)
    }

    /// Get the primary key.
    pub fn get_primary_key(&self) -> Option<(&str, &[u8; 32])> {
        self.primary_key_id
            .as_ref()
            .and_then(|id| self.keys.get(id).map(|k| (id.as_str(), k)))
    }

    /// Set the primary key ID.
    pub fn set_primary_key(&mut self, key_id: &str) -> bool {
        if self.keys.contains_key(key_id) {
            self.primary_key_id = Some(key_id.to_string());
            true
        } else {
            false
        }
    }

    /// Remove a key.
    pub fn remove_key(&mut self, key_id: &str) -> bool {
        if self.keys.remove(key_id).is_some() {
            if self.primary_key_id.as_deref() == Some(key_id) {
                self.primary_key_id = self.keys.keys().next().cloned();
            }
            true
        } else {
            false
        }
    }

    /// Clear all keys.
    pub fn clear(&mut self) {
        self.keys.clear();
        self.primary_key_id = None;
    }

    /// Get the number of keys.
    pub fn key_count(&self) -> usize {
        self.keys.len()
    }

    /// List all key IDs.
    pub fn list_key_ids(&self) -> Vec<&str> {
        self.keys.keys().map(|s| s.as_str()).collect()
    }

    /// Encrypt using the primary key.
    pub fn encrypt(&self, plaintext: &str) -> SecretsResult<EncryptedSecret> {
        let (key_id, key) = self.get_primary_key().ok_or(SecretsError::KeyNotFound {
            key_id: "primary".to_string(),
        })?;
        encrypt(plaintext, key, key_id)
    }

    /// Decrypt using the appropriate key.
    pub fn decrypt(&self, encrypted: &EncryptedSecret) -> SecretsResult<String> {
        let key = self.get_key(&encrypted.key_id).ok_or(SecretsError::KeyNotFound {
            key_id: encrypted.key_id.clone(),
        })?;
        decrypt(encrypted, key)
    }

    /// Re-encrypt a secret with the current primary key.
    pub fn re_encrypt(&self, encrypted: &EncryptedSecret) -> SecretsResult<EncryptedSecret> {
        let plaintext = self.decrypt(encrypted)?;
        self.encrypt(&plaintext)
    }
}

/// Securely compare two byte slices in constant time.
pub fn secure_compare(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut result = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        result |= x ^ y;
    }
    result == 0
}

/// Hash a value using SHA256.
pub fn hash_value(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

/// Mask a secret value for safe display.
pub fn mask_secret(value: &str, visible_chars: usize) -> String {
    if value.len() <= visible_chars * 2 {
        "*".repeat(value.len())
    } else {
        let start: String = value.chars().take(visible_chars).collect();
        let end: String = value.chars().rev().take(visible_chars).collect::<String>().chars().rev().collect();
        let mask_len = value.len().saturating_sub(visible_chars * 2);
        format!("{}{}{}", start, "*".repeat(mask_len), end)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_salt() {
        let salt1 = generate_salt(16);
        let salt2 = generate_salt(16);
        assert_eq!(salt1.len(), 32); // hex encoded
        assert_ne!(salt1, salt2);
    }

    #[test]
    fn test_generate_key() {
        let key1 = generate_key();
        let key2 = generate_key();
        assert_ne!(key1, key2);
    }

    #[test]
    fn test_derive_key_from_agent_id() {
        let key1 = derive_key_from_agent_id("agent-123", "salt1");
        let key2 = derive_key_from_agent_id("agent-123", "salt1");
        let key3 = derive_key_from_agent_id("agent-456", "salt1");

        assert_eq!(key1, key2);
        assert_ne!(key1, key3);
    }

    #[test]
    fn test_derive_key_cross_language_compatibility() {
        // Verify that derive_key_from_agent_id produces the same result as
        // TypeScript/Python: SHA-256 of (agent_id + salt) with NO separator.
        // This is the SHA-256 digest of "agent-123salt1".
        let key = derive_key_from_agent_id("agent-123", "salt1");

        let mut expected_hasher = Sha256::new();
        expected_hasher.update(b"agent-123salt1");
        let expected = expected_hasher.finalize();

        assert_eq!(
            key,
            <[u8; 32]>::try_from(expected.as_slice()).unwrap(),
            "Key derivation must match TypeScript/Python (no colon separator)"
        );
    }

    #[test]
    fn test_encrypt_decrypt() {
        let key = generate_key();
        let plaintext = "my secret value";

        let encrypted = encrypt(plaintext, &key, "test-key").unwrap();
        let decrypted = decrypt(&encrypted, &key).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_encrypt_different_ciphertext() {
        let key = generate_key();
        let plaintext = "my secret value";

        let encrypted1 = encrypt(plaintext, &key, "test-key").unwrap();
        let encrypted2 = encrypt(plaintext, &key, "test-key").unwrap();

        // Same plaintext should produce different ciphertext (different nonces)
        assert_ne!(encrypted1.ciphertext, encrypted2.ciphertext);
    }

    #[test]
    fn test_key_manager() {
        let mut manager = KeyManager::new();
        manager.initialize_from_agent_id("agent-123", "test-salt");

        assert_eq!(manager.key_count(), 1);
        assert!(manager.get_key("default").is_some());

        let encrypted = manager.encrypt("secret").unwrap();
        let decrypted = manager.decrypt(&encrypted).unwrap();
        assert_eq!(decrypted, "secret");
    }

    #[test]
    fn test_key_manager_multiple_keys() {
        let mut manager = KeyManager::new();

        let key1 = generate_key();
        let key2 = generate_key();

        manager.add_key("key1", key1);
        manager.add_key("key2", key2);
        manager.set_primary_key("key2");

        assert_eq!(manager.key_count(), 2);
        assert_eq!(manager.get_primary_key().unwrap().0, "key2");
    }

    #[test]
    fn test_secure_compare() {
        assert!(secure_compare(b"hello", b"hello"));
        assert!(!secure_compare(b"hello", b"world"));
        assert!(!secure_compare(b"hello", b"helloworld"));
    }

    #[test]
    fn test_hash_value() {
        let hash1 = hash_value("test");
        let hash2 = hash_value("test");
        let hash3 = hash_value("different");

        assert_eq!(hash1, hash2);
        assert_ne!(hash1, hash3);
        assert_eq!(hash1.len(), 64); // SHA256 hex
    }

    #[test]
    fn test_mask_secret() {
        assert_eq!(mask_secret("sk-abc123xyz789", 4), "sk-a******9789");
        assert_eq!(mask_secret("short", 4), "*****");
        assert_eq!(mask_secret("12345678", 4), "1234****5678");
    }
}
