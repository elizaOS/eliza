use elizaos_plugin_tee::{
    bytes_to_hex, calculate_sha256, get_tee_endpoint, hex_to_bytes, TeeMode, TeeVendor,
};
use elizaos_plugin_tee::actions::remote_attestation::{
    RemoteAttestationAction, REMOTE_ATTESTATION_EXAMPLES,
};
use elizaos_plugin_tee::providers::{
    DeriveKeyProvider, PhalaDeriveKeyProvider, PhalaRemoteAttestationProvider,
};
use elizaos_plugin_tee::types::{
    DeriveKeyAttestationData, RemoteAttestationMessage, RemoteAttestationMessageContent,
    RemoteAttestationQuote, TdxQuoteHashAlgorithm, TeeServiceConfig,
};

// ===========================================================================
// Original utility tests
// ===========================================================================

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

// ===========================================================================
// RemoteAttestationAction metadata tests
// ===========================================================================

#[test]
fn test_remote_attestation_action_name() {
    assert_eq!(RemoteAttestationAction::NAME, "REMOTE_ATTESTATION");
}

#[test]
fn test_remote_attestation_action_description_mentions_tee() {
    let desc = RemoteAttestationAction::DESCRIPTION;
    assert!(desc.contains("TEE"));
    assert!(desc.to_lowercase().contains("attestation"));
}

#[test]
fn test_remote_attestation_action_similes_not_empty() {
    let similes = RemoteAttestationAction::SIMILES;
    assert!(!similes.is_empty());
    assert!(similes.contains(&"REMOTE_ATTESTATION"));
    assert!(similes.contains(&"TEE_ATTESTATION"));
    assert!(similes.contains(&"PROVE_TEE"));
    assert!(similes.contains(&"VERIFY_TEE"));
}

#[test]
fn test_remote_attestation_examples_not_empty() {
    assert!(!REMOTE_ATTESTATION_EXAMPLES.is_empty());
    // Each example should be a pair of messages
    for example in REMOTE_ATTESTATION_EXAMPLES {
        assert_eq!(example.len(), 2);
    }
}

// ===========================================================================
// RemoteAttestationAction handler error paths
// ===========================================================================

#[tokio::test]
async fn test_remote_attestation_handle_no_tee_mode() {
    let result = RemoteAttestationAction::handle(
        None,
        "agent-1",
        "entity-1",
        "room-1",
        "test content",
    )
    .await;

    assert!(!result.success);
    assert!(result.text.contains("TEE_MODE"));
}

// ===========================================================================
// PhalaRemoteAttestationProvider tests
// ===========================================================================

#[test]
fn test_ra_provider_creates_with_local_mode() {
    let provider = PhalaRemoteAttestationProvider::new("LOCAL");
    assert!(provider.is_ok());
}

#[test]
fn test_ra_provider_creates_with_docker_mode() {
    let provider = PhalaRemoteAttestationProvider::new("DOCKER");
    assert!(provider.is_ok());
}

#[test]
fn test_ra_provider_creates_with_production_mode() {
    let provider = PhalaRemoteAttestationProvider::new("PRODUCTION");
    assert!(provider.is_ok());
}

#[test]
fn test_ra_provider_rejects_invalid_mode() {
    let result = PhalaRemoteAttestationProvider::new("INVALID");
    assert!(result.is_err());
    match result {
        Err(e) => assert!(e.to_string().contains("Invalid TEE_MODE")),
        Ok(_) => panic!("Expected error for invalid mode"),
    }
}

// ===========================================================================
// PhalaDeriveKeyProvider tests
// ===========================================================================

#[test]
fn test_derive_key_provider_creates_with_valid_modes() {
    assert!(PhalaDeriveKeyProvider::new("LOCAL").is_ok());
    assert!(PhalaDeriveKeyProvider::new("DOCKER").is_ok());
    assert!(PhalaDeriveKeyProvider::new("PRODUCTION").is_ok());
}

#[test]
fn test_derive_key_provider_rejects_invalid_mode() {
    let result = PhalaDeriveKeyProvider::new("BOGUS");
    assert!(result.is_err());
    match result {
        Err(e) => assert!(e.to_string().contains("Invalid TEE_MODE")),
        Ok(_) => panic!("Expected error for invalid mode"),
    }
}

#[tokio::test]
async fn test_derive_key_raw_rejects_empty_path() {
    let provider = PhalaDeriveKeyProvider::new("LOCAL").unwrap();
    let result = provider.raw_derive_key("", "subject").await;
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.to_string().contains("Path and subject are required"));
}

#[tokio::test]
async fn test_derive_key_raw_rejects_empty_subject() {
    let provider = PhalaDeriveKeyProvider::new("LOCAL").unwrap();
    let result = provider.raw_derive_key("/path", "").await;
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.to_string().contains("Path and subject are required"));
}

#[tokio::test]
async fn test_derive_ed25519_rejects_empty_path() {
    let provider = PhalaDeriveKeyProvider::new("LOCAL").unwrap();
    let result = provider.derive_ed25519_keypair("", "subject", "agent-1").await;
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("Path and subject are required"));
}

#[tokio::test]
async fn test_derive_ed25519_rejects_empty_subject() {
    let provider = PhalaDeriveKeyProvider::new("LOCAL").unwrap();
    let result = provider.derive_ed25519_keypair("/path", "", "agent-1").await;
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("Path and subject are required"));
}

#[tokio::test]
async fn test_derive_ecdsa_rejects_empty_path() {
    let provider = PhalaDeriveKeyProvider::new("LOCAL").unwrap();
    let result = provider.derive_ecdsa_keypair("", "subject", "agent-1").await;
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("Path and subject are required"));
}

#[tokio::test]
async fn test_derive_ecdsa_rejects_empty_subject() {
    let provider = PhalaDeriveKeyProvider::new("LOCAL").unwrap();
    let result = provider.derive_ecdsa_keypair("/path", "", "agent-1").await;
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("Path and subject are required"));
}

// ===========================================================================
// Attestation-related type structure tests
// ===========================================================================

#[test]
fn test_remote_attestation_quote_structure() {
    let quote = RemoteAttestationQuote {
        quote: "deadbeef".to_string(),
        timestamp: 1700000000000,
    };
    assert_eq!(quote.quote, "deadbeef");
    assert_eq!(quote.timestamp, 1700000000000);

    // Verify JSON serialization
    let json = serde_json::to_string(&quote).unwrap();
    assert!(json.contains("deadbeef"));
    assert!(json.contains("1700000000000"));
}

#[test]
fn test_remote_attestation_message_serialization() {
    let msg = RemoteAttestationMessage {
        agent_id: "agent-1".to_string(),
        timestamp: 1234567890,
        message: RemoteAttestationMessageContent {
            entity_id: "entity-1".to_string(),
            room_id: "room-1".to_string(),
            content: "hello".to_string(),
        },
    };

    let json = serde_json::to_string(&msg).unwrap();
    // camelCase serialization
    assert!(json.contains("agentId"));
    assert!(json.contains("entityId"));
    assert!(json.contains("roomId"));
    assert!(json.contains("hello"));
}

#[test]
fn test_derive_key_attestation_data_serialization() {
    let data = DeriveKeyAttestationData {
        agent_id: "agent-1".to_string(),
        public_key: "pubkey123".to_string(),
        subject: Some("solana".to_string()),
    };

    let json = serde_json::to_string(&data).unwrap();
    assert!(json.contains("agentId"));
    assert!(json.contains("publicKey"));
    assert!(json.contains("solana"));
}

#[test]
fn test_derive_key_attestation_data_skips_none_subject() {
    let data = DeriveKeyAttestationData {
        agent_id: "agent-1".to_string(),
        public_key: "pk".to_string(),
        subject: None,
    };

    let json = serde_json::to_string(&data).unwrap();
    assert!(!json.contains("subject"));
}

#[test]
fn test_tee_service_config_defaults() {
    let config = TeeServiceConfig::default();
    assert_eq!(config.mode, TeeMode::Local);
    assert_eq!(config.vendor, TeeVendor::Phala);
    assert!(config.secret_salt.is_none());
}

#[test]
fn test_tdx_quote_hash_algorithms() {
    let algos = [
        TdxQuoteHashAlgorithm::Sha256,
        TdxQuoteHashAlgorithm::Sha384,
        TdxQuoteHashAlgorithm::Sha512,
        TdxQuoteHashAlgorithm::Raw,
    ];

    for algo in &algos {
        let json = serde_json::to_string(algo).unwrap();
        let deserialized: TdxQuoteHashAlgorithm = serde_json::from_str(&json).unwrap();
        assert_eq!(*algo, deserialized);
    }
}

// ===========================================================================
// Plugin metadata tests
// ===========================================================================

#[test]
fn test_plugin_name() {
    assert_eq!(elizaos_plugin_tee::PLUGIN_NAME, "tee");
}

#[test]
fn test_plugin_description_mentions_tee() {
    assert!(elizaos_plugin_tee::PLUGIN_DESCRIPTION.contains("TEE"));
}

#[test]
fn test_plugin_version_not_empty() {
    assert!(!elizaos_plugin_tee::PLUGIN_VERSION.is_empty());
}
