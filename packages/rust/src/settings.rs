//! Settings and secret helpers for elizaOS

use aes::Aes256;
use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use cbc::Decryptor;
use cipher::block_padding::Pkcs7;
use cipher::{BlockDecryptMut, KeyIvInit};
use sha2::{Digest, Sha256};

/// Get the salt used for encrypting/decrypting secrets
pub fn get_salt() -> String {
    let salt = std::env::var("SECRET_SALT").unwrap_or_else(|_| "secretsalt".to_string());
    let node_env = std::env::var("NODE_ENV").unwrap_or_default().to_lowercase();
    let allow_default = std::env::var("ELIZA_ALLOW_DEFAULT_SECRET_SALT")
        .unwrap_or_default()
        .to_lowercase()
        == "true";
    if node_env == "production" && salt == "secretsalt" && !allow_default {
        panic!(
            "SECRET_SALT must be set to a non-default value in production. \
Set ELIZA_ALLOW_DEFAULT_SECRET_SALT=true to override (not recommended)."
        );
    }
    salt
}

/// Encrypt a string value using AES-256-CBC
pub fn encrypt_string_value(value: &str, salt: &str) -> String {
    if looks_encrypted(value) {
        return value.to_string();
    }

    // v2: AES-256-GCM with integrity tag
    let key = derive_key(salt);
    let iv_full = uuid::Uuid::new_v4().into_bytes(); // random bytes
    let iv: [u8; 12] = iv_full[..12].try_into().expect("slice has 12 bytes");
    let aad = b"elizaos:settings:v2";

    let gcm = Aes256Gcm::new_from_slice(&key).expect("valid key");
    let nonce = Nonce::from_slice(&iv);
    let encrypted = gcm
        .encrypt(
            nonce,
            Payload {
                msg: value.as_bytes(),
                aad,
            },
        )
        .expect("encryption must succeed");
    let split = encrypted.len().saturating_sub(16);
    let (ciphertext, tag) = encrypted.split_at(split);

    format!(
        "v2:{}:{}:{}",
        hex::encode(iv),
        hex::encode(ciphertext),
        hex::encode(tag)
    )
}

/// Decrypt a string value using AES-256-CBC
pub fn decrypt_string_value(value: &str, salt: &str) -> String {
    // v2: v2:ivHex:ciphertextHex:tagHex
    if let Some(rest) = value.strip_prefix("v2:") {
        let parts: Vec<&str> = rest.split(':').collect();
        if parts.len() == 3 {
            let iv = match hex::decode(parts[0]) {
                Ok(b) => b,
                Err(_) => return value.to_string(),
            };
            let ciphertext = match hex::decode(parts[1]) {
                Ok(b) => b,
                Err(_) => return value.to_string(),
            };
            let tag = match hex::decode(parts[2]) {
                Ok(b) => b,
                Err(_) => return value.to_string(),
            };
            if iv.len() != 12 || tag.len() != 16 {
                return value.to_string();
            }

            let mut combined = Vec::with_capacity(ciphertext.len() + tag.len());
            combined.extend_from_slice(&ciphertext);
            combined.extend_from_slice(&tag);

            let key = derive_key(salt);
            let aad = b"elizaos:settings:v2";
            let gcm = match Aes256Gcm::new_from_slice(&key) {
                Ok(c) => c,
                Err(_) => return value.to_string(),
            };
            let nonce = Nonce::from_slice(&iv);
            match gcm.decrypt(
                nonce,
                Payload {
                    msg: &combined,
                    aad,
                },
            ) {
                Ok(plaintext) => String::from_utf8(plaintext).unwrap_or_else(|_| value.to_string()),
                Err(_) => value.to_string(),
            }
        } else {
            value.to_string()
        }
    } else {
        let (iv_hex, encrypted_hex) = match value.split_once(':') {
            Some(parts) => parts,
            None => return value.to_string(),
        };

        let iv = match hex::decode(iv_hex) {
            Ok(b) => b,
            Err(_) => return value.to_string(),
        };
        if iv.len() != 16 {
            return value.to_string();
        }

        let ciphertext = match hex::decode(encrypted_hex) {
            Ok(b) => b,
            Err(_) => return value.to_string(),
        };

        let key = derive_key(salt);
        let cipher = match Decryptor::<Aes256>::new_from_slices(&key, &iv) {
            Ok(c) => c,
            Err(_) => return value.to_string(),
        };

        let mut buf = ciphertext;
        match cipher.decrypt_padded_mut::<Pkcs7>(&mut buf) {
            Ok(plaintext) => {
                String::from_utf8(plaintext.to_vec()).unwrap_or_else(|_| value.to_string())
            }
            Err(_) => value.to_string(),
        }
    }
}

/// Migrate legacy v1 encrypted strings (AES-CBC) to v2 (AES-GCM).
///
/// - v2 values are returned unchanged
/// - v1 values are decrypted then re-encrypted as v2
/// - non-encrypted values are returned unchanged
pub fn migrate_encrypted_string_value(value: &str, salt: &str) -> String {
    if value.starts_with("v2:") {
        return value.to_string();
    }
    if !looks_encrypted(value) {
        return value.to_string();
    }
    let decrypted = decrypt_string_value(value, salt);
    if decrypted == value {
        return value.to_string();
    }
    encrypt_string_value(&decrypted, salt)
}

fn derive_key(salt: &str) -> [u8; 32] {
    let digest = Sha256::digest(salt.as_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest[..32]);
    key
}

fn looks_encrypted(value: &str) -> bool {
    if let Some(rest) = value.strip_prefix("v2:") {
        let parts: Vec<&str> = rest.split(':').collect();
        if parts.len() == 3 {
            let iv_ok = hex::decode(parts[0])
                .map(|iv| iv.len() == 12)
                .unwrap_or(false);
            let tag_ok = hex::decode(parts[2])
                .map(|tag| tag.len() == 16)
                .unwrap_or(false);
            return iv_ok && tag_ok;
        }
        return false;
    }

    let (iv_hex, _encrypted_hex) = match value.split_once(':') {
        Some(parts) => parts,
        None => return false,
    };
    match hex::decode(iv_hex) {
        Ok(iv) => iv.len() == 16,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cbc::Encryptor;
    use cipher::BlockEncryptMut;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let salt = "secretsalt";
        let plaintext = "hello world";
        let encrypted = encrypt_string_value(plaintext, salt);
        assert!(encrypted.starts_with("v2:"));
        let decrypted = decrypt_string_value(&encrypted, salt);
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_decrypt_non_encrypted_returns_original() {
        let salt = "secretsalt";
        let plaintext = "not encrypted";
        let decrypted = decrypt_string_value(plaintext, salt);
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_decrypt_legacy_v1_aes_cbc_value() {
        let salt = "secretsalt";
        let plaintext = "legacy-secret";
        let key = derive_key(salt);
        let iv = uuid::Uuid::new_v4().into_bytes(); // 16 bytes

        let cipher = Encryptor::<Aes256>::new_from_slices(&key, &iv).expect("valid key/iv");
        let pt = plaintext.as_bytes();
        let msg_len = pt.len();

        let pad_len = 16 - (msg_len % 16);
        let mut buf = Vec::with_capacity(msg_len + pad_len);
        buf.extend_from_slice(pt);
        buf.resize(msg_len + pad_len, 0u8);

        let encrypted = cipher
            .encrypt_padded_mut::<Pkcs7>(&mut buf, msg_len)
            .expect("padding buffer sized correctly");
        let legacy = format!("{}:{}", hex::encode(iv), hex::encode(encrypted));

        let decrypted = decrypt_string_value(&legacy, salt);
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_migrate_legacy_v1_to_v2() {
        let salt = "secretsalt";
        let plaintext = "legacy-migrate";
        let key = derive_key(salt);
        let iv = uuid::Uuid::new_v4().into_bytes(); // 16 bytes

        let cipher = Encryptor::<Aes256>::new_from_slices(&key, &iv).expect("valid key/iv");
        let pt = plaintext.as_bytes();
        let msg_len = pt.len();
        let pad_len = 16 - (msg_len % 16);
        let mut buf = Vec::with_capacity(msg_len + pad_len);
        buf.extend_from_slice(pt);
        buf.resize(msg_len + pad_len, 0u8);
        let encrypted = cipher
            .encrypt_padded_mut::<Pkcs7>(&mut buf, msg_len)
            .expect("padding buffer sized correctly");
        let legacy = format!("{}:{}", hex::encode(iv), hex::encode(encrypted));

        let migrated = migrate_encrypted_string_value(&legacy, salt);
        assert!(migrated.starts_with("v2:"));
        assert_ne!(migrated, legacy);
        assert_eq!(decrypt_string_value(&migrated, salt), plaintext);
    }
}
