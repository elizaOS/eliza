use elizaos_plugin_tee::{
    bytes_to_hex, calculate_sha256, get_tee_endpoint, hex_to_bytes, TeeMode, TeeVendor,
};

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

#[test]
fn test_tee_mode_parse() {
    assert_eq!(TeeMode::parse("LOCAL").unwrap(), TeeMode::Local);
    assert_eq!(TeeMode::parse("local").unwrap(), TeeMode::Local);
    assert_eq!(TeeMode::parse("DOCKER").unwrap(), TeeMode::Docker);
    assert_eq!(TeeMode::parse("PRODUCTION").unwrap(), TeeMode::Production);
    assert!(TeeMode::parse("INVALID").is_err());
}

#[test]
fn test_tee_vendor_parse() {
    assert_eq!(TeeVendor::parse("phala").unwrap(), TeeVendor::Phala);
    assert_eq!(TeeVendor::parse("PHALA").unwrap(), TeeVendor::Phala);
    assert!(TeeVendor::parse("invalid").is_err());
}
