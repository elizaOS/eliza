//! Comprehensive integration tests for the EVM plugin.
//!
//! Tests marked `#[ignore]` require credentials (TEST_PRIVATE_KEY, SEPOLIA_RPC_URL).
//! All other tests run without any RPC connection or wallet keys.

use alloy::primitives::{address, Address, Bytes, FixedBytes, U256};
use elizaos_plugin_evm::actions::bridge::BridgeStatusType;
use elizaos_plugin_evm::actions::{
    BridgeAction, BridgeParams, BridgeStatus, ExecuteParams, ProposeParams, QueueParams,
    SwapAction, SwapParams, SwapQuote, TransferAction, TransferParams, VoteParams, VoteSupport,
};
use elizaos_plugin_evm::constants::*;
use elizaos_plugin_evm::error::{EVMError, EVMErrorCode};
use elizaos_plugin_evm::providers::{ProviderContext, ProviderResult, TokenBalanceProvider};
use elizaos_plugin_evm::service::{EVMService, EvmWalletChainData, EvmWalletData};
use elizaos_plugin_evm::types::{
    format_amount, parse_amount, ChainConfig, SupportedChain, TokenInfo, TokenWithBalance,
    Transaction, TransactionReceipt, VoteType, WalletBalance,
};
use elizaos_plugin_evm::{WalletProvider, WalletProviderConfig};
use std::env;

// ─── Constants Tests ─────────────────────────────────────────────────────────

#[test]
fn test_cache_constants() {
    assert_eq!(EVM_WALLET_DATA_CACHE_KEY, "evm/wallet/data");
    assert_eq!(EVM_SERVICE_NAME, "evmService");
    assert_eq!(CACHE_REFRESH_INTERVAL_SECS, 60);
}

#[test]
fn test_gas_constants() {
    assert!(GAS_BUFFER_MULTIPLIER > 1.0);
    assert_eq!(GAS_BUFFER_MULTIPLIER, 1.2);
    assert!(GAS_PRICE_MULTIPLIER > 1.0);
    assert_eq!(GAS_PRICE_MULTIPLIER, 1.1);
}

#[test]
fn test_slippage_constants() {
    assert_eq!(MAX_SLIPPAGE_PERCENT, 0.05);
    assert_eq!(DEFAULT_SLIPPAGE_PERCENT, 0.01);
    assert!(DEFAULT_SLIPPAGE_PERCENT < MAX_SLIPPAGE_PERCENT);
    assert_eq!(MAX_PRICE_IMPACT, 0.4);
}

#[test]
fn test_timeout_constants() {
    assert_eq!(TX_CONFIRMATION_TIMEOUT_SECS, 60);
    assert_eq!(BRIDGE_POLL_INTERVAL_SECS, 5);
    assert_eq!(MAX_BRIDGE_POLL_ATTEMPTS, 60);
}

#[test]
fn test_token_constants() {
    assert_eq!(NATIVE_TOKEN_ADDRESS, Address::ZERO);
    assert_eq!(DEFAULT_DECIMALS, 18);
}

#[test]
fn test_api_urls() {
    assert_eq!(LIFI_API_URL, "https://li.quest/v1");
    assert_eq!(BEBOP_API_URL, "https://api.bebop.xyz/router");
    assert!(LIFI_API_URL.starts_with("https://"));
    assert!(BEBOP_API_URL.starts_with("https://"));
}

#[test]
fn test_default_chains() {
    assert_eq!(DEFAULT_CHAINS, &["mainnet", "base"]);
    assert_eq!(DEFAULT_CHAINS.len(), 2);
}

// ─── SupportedChain Tests ────────────────────────────────────────────────────

#[test]
fn test_all_chain_ids() {
    assert_eq!(SupportedChain::Mainnet.chain_id(), 1);
    assert_eq!(SupportedChain::Sepolia.chain_id(), 11155111);
    assert_eq!(SupportedChain::Base.chain_id(), 8453);
    assert_eq!(SupportedChain::BaseSepolia.chain_id(), 84532);
    assert_eq!(SupportedChain::Arbitrum.chain_id(), 42161);
    assert_eq!(SupportedChain::Optimism.chain_id(), 10);
    assert_eq!(SupportedChain::Polygon.chain_id(), 137);
    assert_eq!(SupportedChain::Avalanche.chain_id(), 43114);
    assert_eq!(SupportedChain::Bsc.chain_id(), 56);
    assert_eq!(SupportedChain::Gnosis.chain_id(), 100);
    assert_eq!(SupportedChain::Fantom.chain_id(), 250);
    assert_eq!(SupportedChain::Linea.chain_id(), 59144);
    assert_eq!(SupportedChain::Scroll.chain_id(), 534352);
    assert_eq!(SupportedChain::Zksync.chain_id(), 324);
}

#[test]
fn test_all_native_symbols() {
    assert_eq!(SupportedChain::Mainnet.native_symbol(), "ETH");
    assert_eq!(SupportedChain::Sepolia.native_symbol(), "ETH");
    assert_eq!(SupportedChain::Base.native_symbol(), "ETH");
    assert_eq!(SupportedChain::BaseSepolia.native_symbol(), "ETH");
    assert_eq!(SupportedChain::Arbitrum.native_symbol(), "ETH");
    assert_eq!(SupportedChain::Optimism.native_symbol(), "ETH");
    assert_eq!(SupportedChain::Polygon.native_symbol(), "MATIC");
    assert_eq!(SupportedChain::Avalanche.native_symbol(), "AVAX");
    assert_eq!(SupportedChain::Bsc.native_symbol(), "BNB");
    assert_eq!(SupportedChain::Gnosis.native_symbol(), "xDAI");
    assert_eq!(SupportedChain::Fantom.native_symbol(), "FTM");
    assert_eq!(SupportedChain::Linea.native_symbol(), "ETH");
    assert_eq!(SupportedChain::Scroll.native_symbol(), "ETH");
    assert_eq!(SupportedChain::Zksync.native_symbol(), "ETH");
}

#[test]
fn test_all_default_rpcs_are_https() {
    let chains = [
        SupportedChain::Mainnet,
        SupportedChain::Sepolia,
        SupportedChain::Base,
        SupportedChain::BaseSepolia,
        SupportedChain::Arbitrum,
        SupportedChain::Optimism,
        SupportedChain::Polygon,
        SupportedChain::Avalanche,
        SupportedChain::Bsc,
        SupportedChain::Gnosis,
        SupportedChain::Fantom,
        SupportedChain::Linea,
        SupportedChain::Scroll,
        SupportedChain::Zksync,
    ];

    for chain in chains {
        assert!(
            chain.default_rpc().starts_with("https://"),
            "{} default RPC should start with https://",
            chain
        );
    }
}

#[test]
fn test_testnet_identification() {
    assert!(SupportedChain::Sepolia.is_testnet());
    assert!(SupportedChain::BaseSepolia.is_testnet());

    // All other chains are not testnets
    assert!(!SupportedChain::Mainnet.is_testnet());
    assert!(!SupportedChain::Base.is_testnet());
    assert!(!SupportedChain::Arbitrum.is_testnet());
    assert!(!SupportedChain::Optimism.is_testnet());
    assert!(!SupportedChain::Polygon.is_testnet());
    assert!(!SupportedChain::Avalanche.is_testnet());
    assert!(!SupportedChain::Bsc.is_testnet());
    assert!(!SupportedChain::Gnosis.is_testnet());
    assert!(!SupportedChain::Fantom.is_testnet());
    assert!(!SupportedChain::Linea.is_testnet());
    assert!(!SupportedChain::Scroll.is_testnet());
    assert!(!SupportedChain::Zksync.is_testnet());
}

#[test]
fn test_chain_from_str_standard() {
    assert_eq!("mainnet".parse::<SupportedChain>().unwrap(), SupportedChain::Mainnet);
    assert_eq!("sepolia".parse::<SupportedChain>().unwrap(), SupportedChain::Sepolia);
    assert_eq!("base".parse::<SupportedChain>().unwrap(), SupportedChain::Base);
    assert_eq!("arbitrum".parse::<SupportedChain>().unwrap(), SupportedChain::Arbitrum);
    assert_eq!("optimism".parse::<SupportedChain>().unwrap(), SupportedChain::Optimism);
    assert_eq!("polygon".parse::<SupportedChain>().unwrap(), SupportedChain::Polygon);
    assert_eq!("avalanche".parse::<SupportedChain>().unwrap(), SupportedChain::Avalanche);
    assert_eq!("bsc".parse::<SupportedChain>().unwrap(), SupportedChain::Bsc);
    assert_eq!("gnosis".parse::<SupportedChain>().unwrap(), SupportedChain::Gnosis);
    assert_eq!("fantom".parse::<SupportedChain>().unwrap(), SupportedChain::Fantom);
    assert_eq!("linea".parse::<SupportedChain>().unwrap(), SupportedChain::Linea);
    assert_eq!("scroll".parse::<SupportedChain>().unwrap(), SupportedChain::Scroll);
    assert_eq!("zksync".parse::<SupportedChain>().unwrap(), SupportedChain::Zksync);
}

#[test]
fn test_chain_from_str_aliases() {
    assert_eq!("ethereum".parse::<SupportedChain>().unwrap(), SupportedChain::Mainnet);
    assert_eq!("eth".parse::<SupportedChain>().unwrap(), SupportedChain::Mainnet);
    assert_eq!("arb".parse::<SupportedChain>().unwrap(), SupportedChain::Arbitrum);
    assert_eq!("op".parse::<SupportedChain>().unwrap(), SupportedChain::Optimism);
    assert_eq!("matic".parse::<SupportedChain>().unwrap(), SupportedChain::Polygon);
    assert_eq!("avax".parse::<SupportedChain>().unwrap(), SupportedChain::Avalanche);
    assert_eq!("bnb".parse::<SupportedChain>().unwrap(), SupportedChain::Bsc);
    assert_eq!("xdai".parse::<SupportedChain>().unwrap(), SupportedChain::Gnosis);
    assert_eq!("ftm".parse::<SupportedChain>().unwrap(), SupportedChain::Fantom);
    assert_eq!("era".parse::<SupportedChain>().unwrap(), SupportedChain::Zksync);
}

#[test]
fn test_chain_from_str_case_insensitive() {
    assert_eq!("MAINNET".parse::<SupportedChain>().unwrap(), SupportedChain::Mainnet);
    assert_eq!("Ethereum".parse::<SupportedChain>().unwrap(), SupportedChain::Mainnet);
    assert_eq!("BASE".parse::<SupportedChain>().unwrap(), SupportedChain::Base);
}

#[test]
fn test_chain_from_str_base_sepolia_variants() {
    assert_eq!("basesepolia".parse::<SupportedChain>().unwrap(), SupportedChain::BaseSepolia);
    assert_eq!("base_sepolia".parse::<SupportedChain>().unwrap(), SupportedChain::BaseSepolia);
    assert_eq!("base-sepolia".parse::<SupportedChain>().unwrap(), SupportedChain::BaseSepolia);
}

#[test]
fn test_chain_from_str_invalid() {
    assert!("invalid".parse::<SupportedChain>().is_err());
    assert!("".parse::<SupportedChain>().is_err());
    assert!("solana".parse::<SupportedChain>().is_err());
}

#[test]
fn test_chain_display() {
    assert_eq!(SupportedChain::Mainnet.to_string(), "mainnet");
    assert_eq!(SupportedChain::BaseSepolia.to_string(), "baseSepolia");
    assert_eq!(SupportedChain::Polygon.to_string(), "polygon");
    assert_eq!(SupportedChain::Zksync.to_string(), "zksync");
}

#[test]
fn test_chain_serde_roundtrip() {
    let chain = SupportedChain::Mainnet;
    let json = serde_json::to_string(&chain).unwrap();
    assert_eq!(json, "\"mainnet\"");
    let deserialized: SupportedChain = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized, chain);
}

#[test]
fn test_chain_serde_all() {
    let chains = [
        (SupportedChain::Mainnet, "\"mainnet\""),
        (SupportedChain::Sepolia, "\"sepolia\""),
        (SupportedChain::Base, "\"base\""),
        (SupportedChain::Polygon, "\"polygon\""),
        (SupportedChain::Bsc, "\"bsc\""),
    ];
    for (chain, expected_json) in chains {
        let json = serde_json::to_string(&chain).unwrap();
        assert_eq!(json, expected_json, "Serialization failed for {:?}", chain);
        let deserialized: SupportedChain = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, chain, "Deserialization failed for {:?}", chain);
    }
}

// ─── Amount Parsing Tests ────────────────────────────────────────────────────

#[test]
fn test_parse_amount_whole_number_18_decimals() {
    let result = parse_amount("1", 18).unwrap();
    assert_eq!(result, U256::from(1_000_000_000_000_000_000u128));
}

#[test]
fn test_parse_amount_with_decimals_18() {
    let result = parse_amount("1.5", 18).unwrap();
    assert_eq!(result, U256::from(1_500_000_000_000_000_000u128));
}

#[test]
fn test_parse_amount_small_value_18() {
    let result = parse_amount("0.001", 18).unwrap();
    assert_eq!(result, U256::from(1_000_000_000_000_000u128));
}

#[test]
fn test_parse_amount_6_decimals() {
    let result = parse_amount("100", 6).unwrap();
    assert_eq!(result, U256::from(100_000_000u64));
}

#[test]
fn test_parse_amount_6_decimals_with_fraction() {
    let result = parse_amount("1.5", 6).unwrap();
    assert_eq!(result, U256::from(1_500_000u64));
}

#[test]
fn test_parse_amount_0_decimals() {
    let result = parse_amount("42", 0).unwrap();
    assert_eq!(result, U256::from(42u64));
}

#[test]
fn test_parse_amount_truncates_extra_decimals() {
    // "1.123456789" with 6 decimals should truncate to "1.123456"
    let result = parse_amount("1.123456789", 6).unwrap();
    assert_eq!(result, U256::from(1_123_456u64));
}

#[test]
fn test_parse_amount_invalid_format() {
    assert!(parse_amount("1.2.3", 18).is_err());
}

#[test]
fn test_format_amount_whole_number() {
    let amount = U256::from(1_000_000_000_000_000_000u128);
    assert_eq!(format_amount(amount, 18), "1");
}

#[test]
fn test_format_amount_with_decimals() {
    let amount = U256::from(1_500_000_000_000_000_000u128);
    assert_eq!(format_amount(amount, 18), "1.5");
}

#[test]
fn test_format_amount_6_decimals() {
    let amount = U256::from(100_000_000u64);
    assert_eq!(format_amount(amount, 6), "100");
}

#[test]
fn test_format_amount_zero() {
    assert_eq!(format_amount(U256::ZERO, 18), "0");
}

#[test]
fn test_format_amount_small() {
    let amount = U256::from(1_000_000_000_000_000u128); // 0.001 ETH
    assert_eq!(format_amount(amount, 18), "0.001");
}

// ─── Type Construction Tests ─────────────────────────────────────────────────

#[test]
fn test_transaction_construction() {
    let tx = Transaction {
        hash: FixedBytes::ZERO,
        from: Address::ZERO,
        to: address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        value: U256::from(1_000_000_000_000_000_000u128),
        data: None,
        chain_id: Some(1),
    };
    assert_eq!(tx.chain_id, Some(1));
    assert!(tx.data.is_none());
}

#[test]
fn test_transaction_with_data() {
    let tx = Transaction {
        hash: FixedBytes::ZERO,
        from: Address::ZERO,
        to: Address::ZERO,
        value: U256::ZERO,
        data: Some(Bytes::from(vec![0xde, 0xad, 0xbe, 0xef])),
        chain_id: None,
    };
    assert!(tx.data.is_some());
    assert!(tx.chain_id.is_none());
}

#[test]
fn test_transaction_serialization() {
    let tx = Transaction {
        hash: FixedBytes::ZERO,
        from: Address::ZERO,
        to: Address::ZERO,
        value: U256::ZERO,
        data: None,
        chain_id: Some(1),
    };
    let json = serde_json::to_string(&tx).unwrap();
    assert!(json.contains("\"chain_id\":1"));
    // data is None and should be skipped
    assert!(!json.contains("\"data\""));
}

#[test]
fn test_transaction_receipt_construction() {
    let receipt = TransactionReceipt {
        hash: FixedBytes::ZERO,
        block_number: 12345678,
        gas_used: U256::from(21000u64),
        status: true,
    };
    assert!(receipt.status);
    assert_eq!(receipt.block_number, 12345678);
}

#[test]
fn test_token_info_construction() {
    let info = TokenInfo {
        address: address!("A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        symbol: "USDC".to_string(),
        name: "USD Coin".to_string(),
        decimals: 6,
        chain_id: 1,
        logo_uri: Some("https://example.com/usdc.png".to_string()),
    };
    assert_eq!(info.symbol, "USDC");
    assert_eq!(info.decimals, 6);
    assert!(info.logo_uri.is_some());
}

#[test]
fn test_token_with_balance_construction() {
    let info = TokenInfo {
        address: Address::ZERO,
        symbol: "TKN".to_string(),
        name: "Token".to_string(),
        decimals: 18,
        chain_id: 1,
        logo_uri: None,
    };
    let twb = TokenWithBalance {
        token: info,
        balance: U256::from(1_000_000_000_000_000_000u128),
        formatted_balance: "1.0".to_string(),
        price_usd: Some("2500.00".to_string()),
        value_usd: Some("2500.00".to_string()),
    };
    assert_eq!(twb.formatted_balance, "1.0");
    assert!(twb.price_usd.is_some());
}

#[test]
fn test_wallet_balance_construction() {
    let wb = WalletBalance {
        chain: SupportedChain::Mainnet,
        address: address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        native_balance: "1.5".to_string(),
        tokens: vec![],
    };
    assert_eq!(wb.chain, SupportedChain::Mainnet);
    assert_eq!(wb.native_balance, "1.5");
    assert!(wb.tokens.is_empty());
}

#[test]
fn test_vote_type_values() {
    assert_eq!(VoteType::Against as u8, 0);
    assert_eq!(VoteType::For as u8, 1);
    assert_eq!(VoteType::Abstain as u8, 2);
}

#[test]
fn test_vote_type_from_u8() {
    assert_eq!(VoteType::from(0), VoteType::Against);
    assert_eq!(VoteType::from(1), VoteType::For);
    assert_eq!(VoteType::from(2), VoteType::Abstain);
    // Any other value maps to Abstain
    assert_eq!(VoteType::from(99), VoteType::Abstain);
}

#[test]
fn test_chain_config_default_rpc() {
    let config = ChainConfig::new(SupportedChain::Mainnet, None);
    assert_eq!(config.chain, SupportedChain::Mainnet);
    assert_eq!(config.rpc_url, "https://eth.llamarpc.com");
    assert!(config.explorer_url.is_none());
}

#[test]
fn test_chain_config_custom_rpc() {
    let config = ChainConfig::new(
        SupportedChain::Mainnet,
        Some("https://my-rpc.example.com".to_string()),
    );
    assert_eq!(config.rpc_url, "https://my-rpc.example.com");
}

#[test]
fn test_chain_config_with_explorer() {
    let config = ChainConfig::new(SupportedChain::Mainnet, None)
        .with_explorer("https://etherscan.io".to_string());
    assert_eq!(config.explorer_url, Some("https://etherscan.io".to_string()));
}

// ─── Transfer Params Validation ──────────────────────────────────────────────

#[test]
fn test_transfer_params_native_valid() {
    let params = TransferParams::native(
        SupportedChain::Sepolia,
        address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        "1.0",
    );
    assert!(params.validate().is_ok());
    assert!(params.token.is_none());
}

#[test]
fn test_transfer_params_erc20_valid() {
    let params = TransferParams::erc20(
        SupportedChain::Mainnet,
        address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        address!("A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        "100",
    );
    assert!(params.validate().is_ok());
    assert!(params.token.is_some());
}

#[test]
fn test_transfer_params_with_data() {
    let params = TransferParams::native(
        SupportedChain::Mainnet,
        address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        "1.0",
    )
    .with_data(Bytes::from(vec![0xde, 0xad]));
    assert!(params.validate().is_ok());
    assert!(params.data.is_some());
}

#[test]
fn test_transfer_params_negative_amount_rejected() {
    let params = TransferParams::native(
        SupportedChain::Sepolia,
        address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        "-1.0",
    );
    let err = params.validate().unwrap_err();
    assert_eq!(err.code, EVMErrorCode::InvalidParams);
}

#[test]
fn test_transfer_params_zero_amount_rejected() {
    let params = TransferParams::native(
        SupportedChain::Sepolia,
        address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        "0",
    );
    let err = params.validate().unwrap_err();
    assert_eq!(err.code, EVMErrorCode::InvalidParams);
}

#[test]
fn test_transfer_params_zero_address_rejected() {
    let params = TransferParams::native(SupportedChain::Sepolia, Address::ZERO, "1.0");
    let err = params.validate().unwrap_err();
    assert_eq!(err.code, EVMErrorCode::InvalidParams);
    assert!(err.message.contains("zero"));
}

#[test]
fn test_transfer_params_invalid_amount_string() {
    let params = TransferParams::native(
        SupportedChain::Sepolia,
        address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        "not_a_number",
    );
    assert!(params.validate().is_err());
}

#[test]
fn test_transfer_params_serialization() {
    let params = TransferParams::native(
        SupportedChain::Mainnet,
        address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        "1.5",
    );
    let json = serde_json::to_string(&params).unwrap();
    assert!(json.contains("\"amount\":\"1.5\""));
    assert!(json.contains("\"from_chain\":\"mainnet\""));
}

// ─── Swap Params Validation ──────────────────────────────────────────────────

#[test]
fn test_swap_params_valid() {
    let params = SwapParams::new(
        SupportedChain::Mainnet,
        address!("C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"), // WETH
        address!("A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"), // USDC
        "1000000000000000000",
    );
    assert!(params.validate().is_ok());
}

#[test]
fn test_swap_params_with_slippage() {
    let params = SwapParams::new(
        SupportedChain::Mainnet,
        address!("C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
        address!("A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        "1.0",
    )
    .with_slippage(0.03);
    assert_eq!(params.slippage, Some(0.03));
    assert!(params.validate().is_ok());
}

#[test]
fn test_swap_params_default_slippage() {
    let params = SwapParams::new(
        SupportedChain::Mainnet,
        address!("C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
        address!("A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        "1.0",
    );
    assert_eq!(params.slippage_or_default(), DEFAULT_SLIPPAGE_PERCENT);
}

#[test]
fn test_swap_params_same_token_rejected() {
    let weth = address!("C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    let params = SwapParams::new(SupportedChain::Mainnet, weth, weth, "1.0");
    let err = params.validate().unwrap_err();
    assert_eq!(err.code, EVMErrorCode::InvalidParams);
    assert!(err.message.contains("different"));
}

#[test]
fn test_swap_params_empty_amount_rejected() {
    let params = SwapParams::new(
        SupportedChain::Mainnet,
        address!("C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
        address!("A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        "",
    );
    assert!(params.validate().is_err());
}

#[test]
fn test_swap_params_serialization() {
    let params = SwapParams::new(
        SupportedChain::Mainnet,
        address!("C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
        address!("A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        "1.0",
    );
    let json = serde_json::to_string(&params).unwrap();
    assert!(json.contains("\"chain\":\"mainnet\""));
    assert!(json.contains("\"amount\":\"1.0\""));
}

#[test]
fn test_swap_quote_construction() {
    let quote = SwapQuote {
        aggregator: "lifi".to_string(),
        min_output_amount: "1000000".to_string(),
        to: address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        value: U256::from(1_000_000_000_000_000_000u128),
        data: Bytes::from(vec![0xde, 0xad]),
        gas_limit: Some(250000),
    };
    assert_eq!(quote.aggregator, "lifi");
    assert_eq!(quote.gas_limit, Some(250000));
}

// ─── Bridge Params Validation ────────────────────────────────────────────────

#[test]
fn test_bridge_params_valid() {
    let params = BridgeParams::new(
        SupportedChain::Mainnet,
        SupportedChain::Base,
        Address::ZERO,
        Address::ZERO,
        "1.0",
    );
    assert!(params.validate().is_ok());
    assert!(params.to_address.is_none());
}

#[test]
fn test_bridge_params_with_recipient() {
    let recipient = address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    let params = BridgeParams::new(
        SupportedChain::Mainnet,
        SupportedChain::Base,
        Address::ZERO,
        Address::ZERO,
        "1.0",
    )
    .with_recipient(recipient);
    assert_eq!(params.to_address, Some(recipient));
}

#[test]
fn test_bridge_params_same_chain_rejected() {
    let params = BridgeParams::new(
        SupportedChain::Mainnet,
        SupportedChain::Mainnet,
        Address::ZERO,
        Address::ZERO,
        "1.0",
    );
    let err = params.validate().unwrap_err();
    assert_eq!(err.code, EVMErrorCode::InvalidParams);
    assert!(err.message.contains("different"));
}

#[test]
fn test_bridge_params_empty_amount_rejected() {
    let params = BridgeParams::new(
        SupportedChain::Mainnet,
        SupportedChain::Base,
        Address::ZERO,
        Address::ZERO,
        "",
    );
    assert!(params.validate().is_err());
}

#[test]
fn test_bridge_params_various_chain_pairs() {
    let pairs = [
        (SupportedChain::Mainnet, SupportedChain::Arbitrum),
        (SupportedChain::Base, SupportedChain::Optimism),
        (SupportedChain::Polygon, SupportedChain::Bsc),
        (SupportedChain::Avalanche, SupportedChain::Fantom),
    ];
    for (from, to) in pairs {
        let params = BridgeParams::new(from, to, Address::ZERO, Address::ZERO, "1.0");
        assert!(params.validate().is_ok(), "Failed for {} -> {}", from, to);
    }
}

#[test]
fn test_bridge_status_types() {
    let pending = BridgeStatus {
        status: BridgeStatusType::Pending,
        substatus: None,
        source_tx_hash: "0xabc".to_string(),
        dest_tx_hash: None,
    };
    assert_eq!(pending.status, BridgeStatusType::Pending);

    let done = BridgeStatus {
        status: BridgeStatusType::Done,
        substatus: Some("COMPLETED".to_string()),
        source_tx_hash: "0xabc".to_string(),
        dest_tx_hash: Some("0xdef".to_string()),
    };
    assert_eq!(done.status, BridgeStatusType::Done);
    assert!(done.dest_tx_hash.is_some());

    let failed = BridgeStatus {
        status: BridgeStatusType::Failed,
        substatus: Some("SLIPPAGE".to_string()),
        source_tx_hash: "0xabc".to_string(),
        dest_tx_hash: None,
    };
    assert_eq!(failed.status, BridgeStatusType::Failed);
}

// ─── Governance Params Validation ────────────────────────────────────────────

#[test]
fn test_vote_params_construction() {
    let params = VoteParams {
        chain: SupportedChain::Mainnet,
        governor: address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        proposal_id: U256::from(42),
        support: VoteSupport::For,
    };
    assert!(params.validate().is_ok());
}

#[test]
fn test_vote_support_values() {
    assert_eq!(VoteSupport::Against as u8, 0);
    assert_eq!(VoteSupport::For as u8, 1);
    assert_eq!(VoteSupport::Abstain as u8, 2);
}

#[test]
fn test_propose_params_valid() {
    let params = ProposeParams {
        chain: SupportedChain::Mainnet,
        governor: address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        targets: vec![Address::ZERO],
        values: vec![U256::ZERO],
        calldatas: vec![Bytes::new()],
        description: "Test proposal".to_string(),
    };
    assert!(params.validate().is_ok());
}

#[test]
fn test_propose_params_empty_targets_rejected() {
    let params = ProposeParams {
        chain: SupportedChain::Mainnet,
        governor: address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        targets: vec![],
        values: vec![],
        calldatas: vec![],
        description: "Test".to_string(),
    };
    let err = params.validate().unwrap_err();
    assert!(err.message.contains("empty"));
}

#[test]
fn test_propose_params_mismatched_lengths_rejected() {
    let params = ProposeParams {
        chain: SupportedChain::Mainnet,
        governor: address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        targets: vec![Address::ZERO],
        values: vec![U256::ZERO, U256::ZERO], // mismatched
        calldatas: vec![Bytes::new()],
        description: "Test".to_string(),
    };
    let err = params.validate().unwrap_err();
    assert!(err.message.contains("same length"));
}

#[test]
fn test_propose_params_empty_description_rejected() {
    let params = ProposeParams {
        chain: SupportedChain::Mainnet,
        governor: address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        targets: vec![Address::ZERO],
        values: vec![U256::ZERO],
        calldatas: vec![Bytes::new()],
        description: String::new(),
    };
    let err = params.validate().unwrap_err();
    assert!(err.message.contains("Description"));
}

#[test]
fn test_queue_params_valid() {
    let params = QueueParams {
        chain: SupportedChain::Mainnet,
        governor: address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        targets: vec![Address::ZERO],
        values: vec![U256::ZERO],
        calldatas: vec![Bytes::new()],
        description_hash: FixedBytes::ZERO,
    };
    assert!(params.validate().is_ok());
}

#[test]
fn test_queue_params_empty_targets_rejected() {
    let params = QueueParams {
        chain: SupportedChain::Mainnet,
        governor: address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        targets: vec![],
        values: vec![],
        calldatas: vec![],
        description_hash: FixedBytes::ZERO,
    };
    assert!(params.validate().is_err());
}

#[test]
fn test_queue_params_mismatched_lengths_rejected() {
    let params = QueueParams {
        chain: SupportedChain::Mainnet,
        governor: address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        targets: vec![Address::ZERO],
        values: vec![],
        calldatas: vec![Bytes::new()],
        description_hash: FixedBytes::ZERO,
    };
    assert!(params.validate().is_err());
}

#[test]
fn test_execute_params_valid() {
    let params = ExecuteParams {
        chain: SupportedChain::Mainnet,
        governor: address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        targets: vec![Address::ZERO],
        values: vec![U256::ZERO],
        calldatas: vec![Bytes::new()],
        description_hash: FixedBytes::ZERO,
    };
    assert!(params.validate().is_ok());
}

#[test]
fn test_execute_params_empty_targets_rejected() {
    let params = ExecuteParams {
        chain: SupportedChain::Mainnet,
        governor: address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
        targets: vec![],
        values: vec![],
        calldatas: vec![],
        description_hash: FixedBytes::ZERO,
    };
    assert!(params.validate().is_err());
}

// ─── Error Types ─────────────────────────────────────────────────────────────

#[test]
fn test_error_code_display() {
    assert_eq!(EVMErrorCode::InsufficientFunds.to_string(), "INSUFFICIENT_FUNDS");
    assert_eq!(EVMErrorCode::UserRejected.to_string(), "USER_REJECTED");
    assert_eq!(EVMErrorCode::NetworkError.to_string(), "NETWORK_ERROR");
    assert_eq!(EVMErrorCode::ContractRevert.to_string(), "CONTRACT_REVERT");
    assert_eq!(EVMErrorCode::GasEstimationFailed.to_string(), "GAS_ESTIMATION_FAILED");
    assert_eq!(EVMErrorCode::InvalidParams.to_string(), "INVALID_PARAMS");
    assert_eq!(EVMErrorCode::ChainNotConfigured.to_string(), "CHAIN_NOT_CONFIGURED");
    assert_eq!(EVMErrorCode::WalletNotInitialized.to_string(), "WALLET_NOT_INITIALIZED");
    assert_eq!(EVMErrorCode::TransactionFailed.to_string(), "TRANSACTION_FAILED");
    assert_eq!(EVMErrorCode::TokenNotFound.to_string(), "TOKEN_NOT_FOUND");
    assert_eq!(EVMErrorCode::RouteNotFound.to_string(), "ROUTE_NOT_FOUND");
    assert_eq!(EVMErrorCode::ApprovalFailed.to_string(), "APPROVAL_FAILED");
}

#[test]
fn test_error_construction() {
    let err = EVMError::new(EVMErrorCode::InsufficientFunds, "Not enough ETH");
    assert_eq!(err.code, EVMErrorCode::InsufficientFunds);
    assert_eq!(err.message, "Not enough ETH");
    assert!(err.source.is_none());
}

#[test]
fn test_error_display_format() {
    let err = EVMError::new(EVMErrorCode::NetworkError, "Connection refused");
    let display = format!("{err}");
    assert!(display.contains("[NETWORK_ERROR]"));
    assert!(display.contains("Connection refused"));
}

#[test]
fn test_error_factory_methods() {
    let e1 = EVMError::insufficient_funds("low balance");
    assert_eq!(e1.code, EVMErrorCode::InsufficientFunds);

    let e2 = EVMError::chain_not_configured("solana");
    assert_eq!(e2.code, EVMErrorCode::ChainNotConfigured);
    assert!(e2.message.contains("solana"));

    let e3 = EVMError::invalid_params("bad address");
    assert_eq!(e3.code, EVMErrorCode::InvalidParams);

    let e4 = EVMError::wallet_not_initialized();
    assert_eq!(e4.code, EVMErrorCode::WalletNotInitialized);

    let e5 = EVMError::transaction_failed("reverted");
    assert_eq!(e5.code, EVMErrorCode::TransactionFailed);

    let e6 = EVMError::network_error("timeout");
    assert_eq!(e6.code, EVMErrorCode::NetworkError);
}

#[test]
fn test_error_implements_std_error() {
    let err = EVMError::new(EVMErrorCode::NetworkError, "test");
    let _: &dyn std::error::Error = &err;
}

// ─── Provider Output Format ──────────────────────────────────────────────────

#[test]
fn test_provider_result_default() {
    let result = ProviderResult::default();
    assert!(result.text.is_empty());
}

#[test]
fn test_provider_context_default() {
    let ctx = ProviderContext::default();
    assert!(ctx.message_text.is_empty());
    assert!(ctx.chain.is_none());
    assert!(ctx.token.is_none());
}

#[test]
fn test_provider_context_with_fields() {
    let ctx = ProviderContext {
        message_text: "What is my ETH balance?".to_string(),
        chain: Some(SupportedChain::Mainnet),
        token: Some("ETH".to_string()),
    };
    assert!(!ctx.message_text.is_empty());
    assert_eq!(ctx.chain, Some(SupportedChain::Mainnet));
}

#[test]
fn test_token_balance_provider_metadata() {
    assert_eq!(TokenBalanceProvider::NAME, "TOKEN_BALANCE");
    assert!(TokenBalanceProvider::DYNAMIC);
    assert!(!TokenBalanceProvider::DESCRIPTION.is_empty());
}

// ─── Service Data Types ──────────────────────────────────────────────────────

#[test]
fn test_evm_wallet_chain_data_construction() {
    let data = EvmWalletChainData {
        chain_name: "mainnet".to_string(),
        name: "mainnet".to_string(),
        balance: "1.5".to_string(),
        symbol: "ETH".to_string(),
        chain_id: 1,
    };
    assert_eq!(data.chain_name, "mainnet");
    assert_eq!(data.balance, "1.5");
    assert_eq!(data.chain_id, 1);
}

#[test]
fn test_evm_wallet_data_construction() {
    let chain_data = EvmWalletChainData {
        chain_name: "mainnet".to_string(),
        name: "mainnet".to_string(),
        balance: "1.5".to_string(),
        symbol: "ETH".to_string(),
        chain_id: 1,
    };
    let data = EvmWalletData {
        address: "0xabc123".to_string(),
        chains: vec![chain_data],
        timestamp: 1700000000000,
    };
    assert_eq!(data.chains.len(), 1);
    assert_eq!(data.timestamp, 1700000000000);
}

#[test]
fn test_evm_wallet_data_serialization() {
    let data = EvmWalletData {
        address: "0xabc".to_string(),
        chains: vec![],
        timestamp: 12345,
    };
    let json = serde_json::to_string(&data).unwrap();
    assert!(json.contains("\"address\":\"0xabc\""));
    assert!(json.contains("\"timestamp\":12345"));
}

#[test]
fn test_evm_service_type_constant() {
    assert_eq!(EVMService::SERVICE_TYPE, "evmService");
}

// ─── WalletProviderConfig Tests ──────────────────────────────────────────────

#[test]
fn test_wallet_provider_config_new() {
    let config = WalletProviderConfig::new("0xdeadbeef");
    assert_eq!(config.private_key, "0xdeadbeef");
    assert!(config.chains.is_empty());
}

#[test]
fn test_wallet_provider_config_with_chain() {
    let config = WalletProviderConfig::new("0xdeadbeef")
        .with_chain(SupportedChain::Mainnet, None);
    assert_eq!(config.chains.len(), 1);
    assert_eq!(config.chains[0].chain, SupportedChain::Mainnet);
}

#[test]
fn test_wallet_provider_config_with_chains() {
    let config = WalletProviderConfig::new("0xdeadbeef")
        .with_chains(&[SupportedChain::Mainnet, SupportedChain::Base, SupportedChain::Arbitrum]);
    assert_eq!(config.chains.len(), 3);
}

#[test]
fn test_wallet_provider_config_custom_rpc() {
    let config = WalletProviderConfig::new("0xdeadbeef")
        .with_chain(SupportedChain::Mainnet, Some("https://custom-rpc.example.com".to_string()));
    assert_eq!(config.chains[0].rpc_url, "https://custom-rpc.example.com");
}

#[tokio::test]
async fn test_wallet_provider_auto_generate() {
    let (_config, generated) = WalletProviderConfig::new_or_generate(None);
    assert!(generated.is_some(), "Should generate a key when None provided");

    let generated = generated.unwrap();
    assert!(generated.private_key.starts_with("0x"));
    assert_eq!(generated.private_key.len(), 66);
    assert!(!generated.address.is_zero());
}

#[tokio::test]
async fn test_wallet_provider_no_auto_generate_with_key() {
    let (_, generated) = WalletProviderConfig::new_or_generate(Some("0xdeadbeef".to_string()));
    assert!(generated.is_none(), "Should not generate when key provided");
}

#[tokio::test]
async fn test_wallet_provider_auto_generate_empty_string() {
    let (_, generated) = WalletProviderConfig::new_or_generate(Some(String::new()));
    assert!(generated.is_some(), "Should generate for empty string");
}

// ─── Action Name Constants ───────────────────────────────────────────────────

#[test]
fn test_action_names() {
    assert_eq!(TransferAction::NAME, "EVM_TRANSFER_TOKENS");
    assert_eq!(SwapAction::NAME, "EVM_SWAP_TOKENS");
    assert_eq!(BridgeAction::NAME, "EVM_BRIDGE_TOKENS");
}

// ─── Plugin Meta ─────────────────────────────────────────────────────────────

#[test]
fn test_plugin_name() {
    assert_eq!(elizaos_plugin_evm::PLUGIN_NAME, "evm");
}

#[test]
fn test_plugin_version() {
    assert!(!elizaos_plugin_evm::PLUGIN_VERSION.is_empty());
}

// ─── Live Integration Tests (require credentials) ────────────────────────────

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
    assert!(!address.is_zero());

    let balance = provider
        .get_formatted_balance(SupportedChain::Sepolia)
        .await;
    assert!(balance.is_ok(), "Should get balance: {:?}", balance.err());
}

#[tokio::test]
#[ignore = "requires TEST_PRIVATE_KEY environment variable"]
async fn test_wallet_provider_nonce() {
    let config = get_test_config().expect("TEST_PRIVATE_KEY not set");
    let provider = WalletProvider::new(config)
        .await
        .expect("Failed to create provider");

    let nonce = provider.get_nonce(SupportedChain::Sepolia).await;
    assert!(nonce.is_ok());
}
