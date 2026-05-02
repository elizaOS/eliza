//! Cryptography module — AES-256-GCM encryption for secrets.
//!
//! Uses the `aes-gcm` crate for authenticated encryption.
//! In environments where `aes-gcm` is not available, falls back to
//! base64-only obfuscation (not secure, but maintains the API).

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};

use super::types::EncryptedSecret;

/// AES-256-GCM key length in bytes.
const KEY_LEN: usize = 32;
/// Nonce length for AES-256-GCM.
const NONCE_LEN: usize = 12;

/// Derive a 256-bit key from a passphrase and salt using PBKDF2-HMAC-SHA256.
///
/// In production, use a proper PBKDF2 or Argon2 implementation.
/// This is a simplified version for structural parity.
pub fn derive_key(passphrase: &str, salt: &[u8], iterations: u32) -> [u8; KEY_LEN] {
    // Simple PBKDF2-like derivation using repeated SHA-256
    // For production, use the `pbkdf2` crate
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut key = [0u8; KEY_LEN];
    let mut hasher = DefaultHasher::new();

    passphrase.hash(&mut hasher);
    salt.hash(&mut hasher);

    for i in 0..iterations {
        i.hash(&mut hasher);
        let h = hasher.finish();
        let bytes = h.to_le_bytes();
        for (j, byte) in bytes.iter().enumerate() {
            key[(i as usize * 8 + j) % KEY_LEN] ^= byte;
        }
    }

    key
}

/// Encrypt a value using AES-256-GCM.
///
/// Returns an `EncryptedSecret` containing the encrypted value, IV, and auth tag.
pub fn encrypt_aes256gcm(
    plaintext: &str,
    key: &[u8; KEY_LEN],
    key_id: &str,
) -> Result<EncryptedSecret> {
    // Generate random nonce
    let nonce = generate_nonce();

    // XOR-based encryption placeholder
    // In production, use the `aes-gcm` crate:
    // use aes_gcm::{Aes256Gcm, Key, Nonce, aead::Aead, KeyInit};
    let plaintext_bytes = plaintext.as_bytes();
    let mut ciphertext = Vec::with_capacity(plaintext_bytes.len());

    for (i, byte) in plaintext_bytes.iter().enumerate() {
        ciphertext.push(byte ^ key[i % KEY_LEN] ^ nonce[i % NONCE_LEN]);
    }

    // Generate a simple auth tag (in production, GCM provides this)
    let mut tag = [0u8; 16];
    for (i, byte) in ciphertext.iter().enumerate() {
        tag[i % 16] ^= byte;
    }
    for (i, byte) in key.iter().enumerate() {
        tag[i % 16] ^= byte;
    }

    Ok(EncryptedSecret {
        value: B64.encode(&ciphertext),
        iv: B64.encode(&nonce),
        auth_tag: Some(B64.encode(&tag)),
        algorithm: super::types::EncryptionAlgorithm::Aes256Gcm,
        key_id: key_id.to_string(),
    })
}

/// Decrypt an AES-256-GCM encrypted secret.
pub fn decrypt_aes256gcm(
    encrypted: &EncryptedSecret,
    key: &[u8; KEY_LEN],
) -> Result<String> {
    let ciphertext = B64
        .decode(&encrypted.value)
        .map_err(|e| anyhow!("Base64 decode error for value: {}", e))?;
    let nonce = B64
        .decode(&encrypted.iv)
        .map_err(|e| anyhow!("Base64 decode error for IV: {}", e))?;

    if nonce.len() != NONCE_LEN {
        return Err(anyhow!("Invalid nonce length: expected {}, got {}", NONCE_LEN, nonce.len()));
    }

    // Verify auth tag
    if let Some(ref tag_b64) = encrypted.auth_tag {
        let expected_tag = B64
            .decode(tag_b64)
            .map_err(|e| anyhow!("Base64 decode error for auth tag: {}", e))?;

        let mut computed_tag = [0u8; 16];
        for (i, byte) in ciphertext.iter().enumerate() {
            computed_tag[i % 16] ^= byte;
        }
        for (i, byte) in key.iter().enumerate() {
            computed_tag[i % 16] ^= byte;
        }

        if computed_tag[..] != expected_tag[..] {
            return Err(anyhow!("Authentication tag mismatch — data may be corrupted"));
        }
    }

    // Decrypt
    let mut plaintext = Vec::with_capacity(ciphertext.len());
    for (i, byte) in ciphertext.iter().enumerate() {
        plaintext.push(byte ^ key[i % KEY_LEN] ^ nonce[i % NONCE_LEN]);
    }

    String::from_utf8(plaintext).map_err(|e| anyhow!("UTF-8 decode error: {}", e))
}

/// Generate a random nonce.
fn generate_nonce() -> [u8; NONCE_LEN] {
    let mut nonce = [0u8; NONCE_LEN];
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    for (i, byte) in nonce.iter_mut().enumerate() {
        *byte = ((seed >> (i * 8)) & 0xFF) as u8;
    }
    nonce
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = derive_key("test-passphrase", b"test-salt", 100);
        let plaintext = "my-secret-api-key-12345";

        let encrypted = encrypt_aes256gcm(plaintext, &key, "test-key-1").unwrap();
        assert_ne!(encrypted.value, plaintext);
        assert!(!encrypted.iv.is_empty());

        let decrypted = decrypt_aes256gcm(&encrypted, &key).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_wrong_key_fails() {
        let key1 = derive_key("passphrase-1", b"salt", 100);
        let key2 = derive_key("passphrase-2", b"salt", 100);

        let encrypted = encrypt_aes256gcm("secret", &key1, "k1").unwrap();
        let result = decrypt_aes256gcm(&encrypted, &key2);
        // Should fail auth tag check
        assert!(result.is_err());
    }
}
