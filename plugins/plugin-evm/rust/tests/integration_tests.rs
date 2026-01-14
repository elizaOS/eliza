//! Integration tests for the EVM plugin
//!
//! These tests run against live testnets and require:
//! - SEPOLIA_RPC_URL: RPC endpoint for Sepolia
//! - TEST_PRIVATE_KEY: Funded test wallet private key
//!
//! Run with: cargo test --test integration_tests -- --ignored

use elizaos_plugin_evm::{
    BridgeParams, SupportedChain, SwapAction, SwapParams, TransferAction, TransferParams,
    WalletProvider, WalletProviderConfig,
};
use std::env;
use std::sync::Arc;

/// Get test configuration from environment
fn get_test_config() -> Option<WalletProviderConfig> {
    let private_key = env::var("TEST_PRIVATE_KEY").ok()?;
    let sepolia_rpc = env::var("SEPOLIA_RPC_URL")
        .unwrap_or_else(|_| "https://ethereum-sepolia-rpc.publicnode.com".to_string());

    Some(
        WalletProviderConfig::new(private_key)
            .with_chain(SupportedChain::Sepolia, Some(sepolia_rpc)),
    )
}

#[tokio::test]
#[ignore = "requires TEST_PRIVATE_KEY environment variable"]
async fn test_wallet_provider_balance() {
    let config = get_test_config().expect("TEST_PRIVATE_KEY not set");
    let provider = WalletProvider::new(config)
        .await
        .expect("Failed to create provider");

    let address = provider.address();
    println!("Wallet address: {address}");

    let balance = provider
        .get_formatted_balance(SupportedChain::Sepolia)
        .await;
    match balance {
        Ok(b) => println!("Sepolia balance: {b} ETH"),
        Err(e) => println!("Failed to get balance: {e}"),
    }
}

#[tokio::test]
#[ignore = "requires TEST_PRIVATE_KEY environment variable"]
async fn test_wallet_provider_nonce() {
    let config = get_test_config().expect("TEST_PRIVATE_KEY not set");
    let provider = WalletProvider::new(config)
        .await
        .expect("Failed to create provider");

    let nonce = provider.get_nonce(SupportedChain::Sepolia).await;
    match nonce {
        Ok(n) => println!("Current nonce: {n}"),
        Err(e) => println!("Failed to get nonce: {e}"),
    }
}

#[tokio::test]
#[ignore = "requires TEST_PRIVATE_KEY environment variable"]
async fn test_wallet_provider_gas_price() {
    let config = get_test_config().expect("TEST_PRIVATE_KEY not set");
    let provider = WalletProvider::new(config)
        .await
        .expect("Failed to create provider");

    let gas_price = provider.get_gas_price(SupportedChain::Sepolia).await;
    match gas_price {
        Ok(p) => println!("Gas price: {p} wei"),
        Err(e) => println!("Failed to get gas price: {e}"),
    }
}

#[tokio::test]
#[ignore = "requires TEST_PRIVATE_KEY environment variable and funds"]
async fn test_transfer_action() {
    let config = get_test_config().expect("TEST_PRIVATE_KEY not set");
    let provider = Arc::new(
        WalletProvider::new(config)
            .await
            .expect("Failed to create provider"),
    );

    // Check balance first
    let balance = provider
        .get_formatted_balance(SupportedChain::Sepolia)
        .await
        .expect("Failed to get balance");

    let balance_f: f64 = balance.parse().unwrap_or(0.0);
    if balance_f < 0.001 {
        println!("Insufficient balance for transfer test: {balance} ETH");
        return;
    }

    let transfer = TransferAction::new(provider.clone());

    // Create a self-transfer to test without losing funds
    let params = TransferParams::native(SupportedChain::Sepolia, provider.address(), "0.0001");

    match transfer.execute(params).await {
        Ok(tx) => {
            println!("Transfer successful!");
            println!("Transaction hash: {:?}", tx.hash);
        }
        Err(e) => {
            println!("Transfer failed: {e}");
        }
    }
}

#[tokio::test]
#[ignore = "requires TEST_PRIVATE_KEY environment variable"]
async fn test_swap_quote() {
    let config = get_test_config().expect("TEST_PRIVATE_KEY not set");
    let provider = Arc::new(
        WalletProvider::new(config)
            .await
            .expect("Failed to create provider"),
    );

    let swap = SwapAction::new(provider);

    // Get a quote for WETH -> USDC on Sepolia (if liquidity exists)
    let weth = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"
        .parse()
        .expect("Invalid WETH address");
    let usdc = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8"
        .parse()
        .expect("Invalid USDC address");

    let params = SwapParams::new(SupportedChain::Sepolia, weth, usdc, "0.01");

    match swap.get_quote(&params).await {
        Ok(quote) => {
            println!("Swap quote received!");
            println!("Aggregator: {}", quote.aggregator);
            println!("Min output: {}", quote.min_output_amount);
        }
        Err(e) => {
            println!("Failed to get quote (expected on testnet): {e}");
        }
    }
}

#[tokio::test]
async fn test_chain_parsing() {
    let chains = [
        ("mainnet", SupportedChain::Mainnet),
        ("ethereum", SupportedChain::Mainnet),
        ("base", SupportedChain::Base),
        ("arbitrum", SupportedChain::Arbitrum),
        ("optimism", SupportedChain::Optimism),
    ];

    for (name, expected) in chains {
        let parsed: SupportedChain = name.parse().expect("Failed to parse chain");
        assert_eq!(parsed, expected, "Chain {name} did not match expected");
    }
}

#[tokio::test]
async fn test_chain_ids() {
    assert_eq!(SupportedChain::Mainnet.chain_id(), 1);
    assert_eq!(SupportedChain::Sepolia.chain_id(), 11155111);
    assert_eq!(SupportedChain::Base.chain_id(), 8453);
    assert_eq!(SupportedChain::Arbitrum.chain_id(), 42161);
    assert_eq!(SupportedChain::Optimism.chain_id(), 10);
}

#[tokio::test]
async fn test_transfer_params_validation() {
    let valid = TransferParams::native(
        SupportedChain::Sepolia,
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
            .parse()
            .unwrap(),
        "1.0",
    );
    assert!(valid.validate().is_ok());

    let invalid_amount = TransferParams::native(
        SupportedChain::Sepolia,
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
            .parse()
            .unwrap(),
        "-1.0",
    );
    assert!(invalid_amount.validate().is_err());

    let zero_address = TransferParams::native(
        SupportedChain::Sepolia,
        alloy::primitives::Address::ZERO,
        "1.0",
    );
    assert!(zero_address.validate().is_err());
}

#[tokio::test]
async fn test_swap_params_validation() {
    let weth: alloy::primitives::Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
        .parse()
        .unwrap();
    let usdc: alloy::primitives::Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
        .parse()
        .unwrap();

    let valid = SwapParams::new(SupportedChain::Mainnet, weth, usdc, "1.0");
    assert!(valid.validate().is_ok());

    let same_token = SwapParams::new(SupportedChain::Mainnet, weth, weth, "1.0");
    assert!(same_token.validate().is_err());
}

#[tokio::test]
async fn test_bridge_params_validation() {
    let native = alloy::primitives::Address::ZERO;

    let valid = BridgeParams::new(
        SupportedChain::Mainnet,
        SupportedChain::Base,
        native,
        native,
        "1.0",
    );
    assert!(valid.validate().is_ok());

    let same_chain = BridgeParams::new(
        SupportedChain::Mainnet,
        SupportedChain::Mainnet,
        native,
        native,
        "1.0",
    );
    assert!(same_chain.validate().is_err());
}
