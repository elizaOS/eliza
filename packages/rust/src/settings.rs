//! Settings and secret helpers for elizaOS

use aes::Aes256;
use cbc::{Decryptor, Encryptor};
use cipher::block_padding::Pkcs7;
use cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use sha2::{Digest, Sha256};

/// Get the salt used for encrypting/decrypting secrets
pub fn get_salt() -> String {
    std::env::var("SECRET_SALT").unwrap_or_else(|_| "secretsalt".to_string())
}

/// Encrypt a string value using AES-256-CBC
pub fn encrypt_string_value(value: &str, salt: &str) -> String {
    if looks_encrypted(value) {
        return value.to_string();
    }

    let key = derive_key(salt);
    let iv = uuid::Uuid::new_v4().into_bytes(); // 16 random bytes

    let cipher = Encryptor::<Aes256>::new_from_slices(&key, &iv).expect("valid key/iv");
    let plaintext = value.as_bytes();
    let msg_len = plaintext.len();

    // AES block size is 16 bytes. Allocate enough space for PKCS7 padding.
    let pad_len = 16 - (msg_len % 16);
    let mut buf = Vec::with_capacity(msg_len + pad_len);
    buf.extend_from_slice(plaintext);
    buf.resize(msg_len + pad_len, 0u8);

    let encrypted = cipher
        .encrypt_padded_mut::<Pkcs7>(&mut buf, msg_len)
        .expect("padding buffer sized correctly");

    format!("{}:{}", hex::encode(iv), hex::encode(encrypted))
}

/// Decrypt a string value using AES-256-CBC
pub fn decrypt_string_value(value: &str, salt: &str) -> String {
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

fn derive_key(salt: &str) -> [u8; 32] {
    let digest = Sha256::digest(salt.as_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest[..32]);
    key
}

fn looks_encrypted(value: &str) -> bool {
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

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let salt = "secretsalt";
        let plaintext = "hello world";
        let encrypted = encrypt_string_value(plaintext, salt);
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
}
