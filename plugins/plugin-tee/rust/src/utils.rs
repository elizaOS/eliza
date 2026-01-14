#![allow(missing_docs)]

use crate::error::{Result, TeeError};
use sha2::{Digest, Sha256};

pub fn hex_to_bytes(hex_str: &str) -> Result<Vec<u8>> {
    let hex_str = hex_str.trim().trim_start_matches("0x");
    if hex_str.is_empty() {
        return Err(TeeError::config(
            "Invalid hex string: empty after stripping prefix",
        ));
    }
    if !hex_str.len().is_multiple_of(2) {
        return Err(TeeError::config(
            "Invalid hex string: odd number of characters",
        ));
    }
    hex::decode(hex_str).map_err(TeeError::from)
}

pub fn bytes_to_hex(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

pub fn calculate_sha256(data: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().to_vec()
}

pub fn calculate_keccak256(data: &[u8]) -> Vec<u8> {
    use sha3::Keccak256;
    let mut hasher = Keccak256::new();
    hasher.update(data);
    hasher.finalize().to_vec()
}

pub fn get_tee_endpoint(mode: &str) -> Result<Option<String>> {
    match mode.to_uppercase().as_str() {
        "LOCAL" => Ok(Some("http://localhost:8090".to_string())),
        "DOCKER" => Ok(Some("http://host.docker.internal:8090".to_string())),
        "PRODUCTION" => Ok(None),
        _ => Err(TeeError::InvalidMode(mode.to_string())),
    }
}

pub fn current_timestamp_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards")
        .as_millis() as u64
}

pub fn format_evm_address(bytes: &[u8]) -> String {
    format!("0x{}", bytes_to_hex(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hex_to_bytes() {
        let result = hex_to_bytes("0102030405").unwrap();
        assert_eq!(result, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn test_hex_to_bytes_with_prefix() {
        let result = hex_to_bytes("0x0102030405").unwrap();
        assert_eq!(result, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn test_hex_to_bytes_empty() {
        assert!(hex_to_bytes("").is_err());
        assert!(hex_to_bytes("0x").is_err());
    }

    #[test]
    fn test_hex_to_bytes_odd_length() {
        assert!(hex_to_bytes("0x123").is_err());
    }

    #[test]
    fn test_bytes_to_hex() {
        let result = bytes_to_hex(&[1, 2, 3, 4, 5]);
        assert_eq!(result, "0102030405");
    }

    #[test]
    fn test_calculate_sha256() {
        let result = calculate_sha256(b"hello");
        assert_eq!(result.len(), 32);
    }

    #[test]
    fn test_get_tee_endpoint() {
        assert_eq!(
            get_tee_endpoint("LOCAL").unwrap(),
            Some("http://localhost:8090".to_string())
        );
        assert_eq!(
            get_tee_endpoint("DOCKER").unwrap(),
            Some("http://host.docker.internal:8090".to_string())
        );
        assert_eq!(get_tee_endpoint("PRODUCTION").unwrap(), None);
        assert!(get_tee_endpoint("INVALID").is_err());
    }
}
