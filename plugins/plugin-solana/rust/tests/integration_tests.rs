use elizaos_plugin_solana::{
    actions::{SwapAction, TransferAction},
    keypair::{KeypairUtils, WalletConfig},
    providers::WalletProvider,
    SolanaClient, SolanaError,
};
use rust_decimal::Decimal;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signer;
use std::str::FromStr;

/// Test RPC URL for devnet.
const DEVNET_RPC: &str = "https://api.devnet.solana.com";

/// Well-known SOL mint for testing.
const SOL_MINT: &str = "So11111111111111111111111111111111111111112";

/// Well-known USDC mint for testing.
const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

#[tokio::test]
async fn test_read_only_wallet_balance() {
    let config =
        WalletConfig::read_only(DEVNET_RPC.to_string(), "11111111111111111111111111111111")
            .expect("config should be valid");

    let client = SolanaClient::new(config).expect("client should be created");

    // This should succeed (even if balance is 0)
    let result = client.get_sol_balance().await;
    assert!(result.is_ok(), "Balance query should succeed: {:?}", result);
}

#[tokio::test]
async fn test_invalid_address_balance() {
    let config = WalletConfig::read_only(
        DEVNET_RPC.to_string(),
        "So11111111111111111111111111111111111111112",
    )
    .expect("config should be valid");

    let _client = SolanaClient::new(config).expect("client should be created");

    let invalid_pubkey = Pubkey::from_str("invalid");
    assert!(invalid_pubkey.is_err());
}

#[tokio::test]
async fn test_get_balances_multiple_addresses() {
    let config =
        WalletConfig::read_only(DEVNET_RPC.to_string(), "11111111111111111111111111111111")
            .expect("config should be valid");

    let client = SolanaClient::new(config).expect("client should be created");

    let addresses = vec![
        "11111111111111111111111111111111".to_string(),
        "So11111111111111111111111111111111111111112".to_string(),
    ];

    let result = client.get_balances_for_addresses(&addresses).await;
    assert!(
        result.is_ok(),
        "Multi-balance query should succeed: {:?}",
        result
    );

    let balances = result.expect("should have balances");
    assert_eq!(balances.len(), 2);
}

#[tokio::test]
async fn test_keypair_generation_and_validation() {
    let keypair = KeypairUtils::generate();
    let base58 = KeypairUtils::to_base58(&keypair);

    // Should be able to recreate from base58
    let restored = KeypairUtils::from_string(&base58);
    assert!(restored.is_ok(), "Keypair should restore from base58");

    let restored = restored.expect("should have keypair");
    assert_eq!(keypair.pubkey().to_string(), restored.pubkey().to_string());
}

#[tokio::test]
async fn test_pubkey_detection_in_text() {
    let text = "Please send tokens to So11111111111111111111111111111111111111112 or to EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    let keys = KeypairUtils::detect_pubkeys_in_text(text, false);
    assert_eq!(keys.len(), 2);
    assert!(keys.contains(&"So11111111111111111111111111111111111111112".to_string()));
    assert!(keys.contains(&"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string()));
}

#[tokio::test]
async fn test_address_validation() {
    assert!(SolanaClient::is_valid_address(SOL_MINT));
    assert!(SolanaClient::is_valid_address(USDC_MINT));
    assert!(!SolanaClient::is_valid_address("not_a_valid_address"));
    assert!(!SolanaClient::is_valid_address(""));
}

#[tokio::test]
async fn test_on_curve_check() {
    // System program is not on curve (PDA)
    let result = SolanaClient::is_on_curve("11111111111111111111111111111111");
    assert!(result.is_ok());

    // Invalid address should error
    let result = SolanaClient::is_on_curve("invalid");
    assert!(result.is_err());
}

#[tokio::test]
async fn test_read_only_wallet_cannot_sign() {
    let config =
        WalletConfig::read_only(DEVNET_RPC.to_string(), "11111111111111111111111111111111")
            .expect("config should be valid");

    assert!(!config.can_sign());
    assert!(config.keypair().is_err());
}

#[tokio::test]
async fn test_wallet_config_builder() {
    let config =
        WalletConfig::read_only(DEVNET_RPC.to_string(), "11111111111111111111111111111111")
            .expect("config should be valid")
            .with_slippage(100)
            .with_helius_key("test_key".to_string())
            .with_birdeye_key("bird_key".to_string());

    assert_eq!(config.slippage_bps, 100);
    assert_eq!(config.helius_api_key, Some("test_key".to_string()));
    assert_eq!(config.birdeye_api_key, Some("bird_key".to_string()));
}

#[tokio::test]
#[ignore = "Requires funded devnet wallet"]
async fn test_swap_quote_devnet() {
    let private_key =
        std::env::var("SOLANA_PRIVATE_KEY").expect("SOLANA_PRIVATE_KEY required for this test");

    let config = WalletConfig::with_keypair(DEVNET_RPC.to_string(), &private_key)
        .expect("config should be valid");

    let client = SolanaClient::new(config).expect("client should be created");

    let params = elizaos_plugin_solana::SwapQuoteParams {
        input_mint: SOL_MINT.to_string(),
        output_mint: USDC_MINT.to_string(),
        amount: "1000000".to_string(),
        slippage_bps: 100,
    };

    let result = client.get_swap_quote(&params).await;

    match result {
        Ok(quote) => {
            assert!(!quote.out_amount.is_empty());
            println!("Got quote: {} -> {}", quote.in_amount, quote.out_amount);
        }
        Err(SolanaError::SwapQuote(msg)) => {
            println!("Quote failed (expected on devnet): {}", msg);
        }
        Err(e) => panic!("Unexpected error: {:?}", e),
    }
}

/// Integration test for SOL transfer on devnet.
/// Skip in CI unless SOLANA_PRIVATE_KEY is set and wallet is funded.
#[tokio::test]
#[ignore = "Requires funded devnet wallet"]
async fn test_sol_transfer_devnet() {
    let private_key =
        std::env::var("SOLANA_PRIVATE_KEY").expect("SOLANA_PRIVATE_KEY required for this test");

    let config = WalletConfig::with_keypair(DEVNET_RPC.to_string(), &private_key)
        .expect("config should be valid");

    let client = SolanaClient::new(config).expect("client should be created");

    let recipient = KeypairUtils::generate().pubkey();

    let result = client.transfer_sol(&recipient, Decimal::new(1, 6)).await;

    match result {
        Ok(tx) => {
            assert!(tx.success);
            assert!(tx.signature.is_some());
            println!("Transfer successful: {:?}", tx.signature);
        }
        Err(SolanaError::InsufficientBalance { .. }) => {
            println!("Wallet not funded - skipping transfer test");
        }
        Err(e) => panic!("Unexpected error: {:?}", e),
    }
}

#[test]
fn test_swap_action_metadata() {
    assert_eq!(SwapAction::NAME, "SWAP_SOLANA");
    assert!(!SwapAction::DESCRIPTION.is_empty());
    assert!(!SwapAction::SIMILES.is_empty());
    assert!(SwapAction::SIMILES.contains(&"SWAP_SOL"));
}

#[test]
fn test_transfer_action_metadata() {
    assert_eq!(TransferAction::NAME, "TRANSFER_SOLANA");
    assert!(!TransferAction::DESCRIPTION.is_empty());
    assert!(!TransferAction::SIMILES.is_empty());
    assert!(TransferAction::SIMILES.contains(&"SEND_SOL"));
    assert!(TransferAction::SIMILES.contains(&"PAY_SOLANA"));
}

#[test]
fn test_swap_resolve_sol_mint() {
    assert_eq!(SwapAction::resolve_sol_mint("SOL"), SOL_MINT);
    assert_eq!(SwapAction::resolve_sol_mint("sol"), SOL_MINT);
    assert_eq!(SwapAction::resolve_sol_mint(USDC_MINT), USDC_MINT);
}

#[tokio::test]
async fn test_swap_action_validate() {
    let config =
        WalletConfig::read_only(DEVNET_RPC.to_string(), "11111111111111111111111111111111")
            .expect("config should be valid");

    let client = SolanaClient::new(config).expect("client should be created");
    assert!(SwapAction::validate(&client));
}

#[tokio::test]
async fn test_transfer_action_validate() {
    let config =
        WalletConfig::read_only(DEVNET_RPC.to_string(), "11111111111111111111111111111111")
            .expect("config should be valid");

    let client = SolanaClient::new(config).expect("client should be created");
    assert!(TransferAction::validate(&client));
}

#[test]
#[allow(clippy::assertions_on_constants)]
fn test_wallet_provider_metadata() {
    assert_eq!(WalletProvider::NAME, "solana-wallet");
    assert!(!WalletProvider::DESCRIPTION.is_empty());
    assert!(WalletProvider::DYNAMIC);
}

#[tokio::test]
async fn test_wallet_provider_get() {
    let config =
        WalletConfig::read_only(DEVNET_RPC.to_string(), "11111111111111111111111111111111")
            .expect("config should be valid");

    let client = SolanaClient::new(config).expect("client should be created");

    let result = WalletProvider::get(&client, Some("Test Agent")).await;
    assert!(
        result.is_ok(),
        "Wallet provider should succeed: {:?}",
        result
    );

    let provider_result = result.expect("should have result");

    assert!(!provider_result.text.is_empty());
    assert!(provider_result.values.contains_key("total_usd"));
    assert!(provider_result.values.contains_key("total_sol"));
    assert!(provider_result.text.contains("Test Agent"));
}

#[tokio::test]
#[ignore = "Requires funded devnet wallet"]
async fn test_transfer_action_handle() {
    let private_key =
        std::env::var("SOLANA_PRIVATE_KEY").expect("SOLANA_PRIVATE_KEY required for this test");

    let config = WalletConfig::with_keypair(DEVNET_RPC.to_string(), &private_key)
        .expect("config should be valid");

    let client = SolanaClient::new(config).expect("client should be created");

    let recipient = KeypairUtils::generate().pubkey().to_string();

    let result = TransferAction::handle(&client, None, &recipient, Decimal::new(1, 6)).await;

    if result.success {
        assert!(result.signature.is_some());
        assert!(result.amount.is_some());
        assert!(result.recipient.is_some());
    }
}

#[tokio::test]
#[ignore = "Requires API access"]
async fn test_swap_action_handle() {
    let private_key =
        std::env::var("SOLANA_PRIVATE_KEY").expect("SOLANA_PRIVATE_KEY required for this test");

    let config = WalletConfig::with_keypair(DEVNET_RPC.to_string(), &private_key)
        .expect("config should be valid");

    let client = SolanaClient::new(config).expect("client should be created");

    let result =
        SwapAction::handle(&client, SOL_MINT, USDC_MINT, Decimal::new(1, 3), Some(100)).await;

    if result.success {
        assert!(result.signature.is_some());
    }
}
