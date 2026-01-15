//! Order placement and management actions for Polymarket.
//!
//! This module provides functions for creating, signing, and placing orders
//! on Polymarket's CLOB (Central Limit Order Book) using EIP-712 signatures.

use crate::client::ClobClient;
use crate::constants::{CTF_EXCHANGE_ADDRESS, NEG_RISK_CTF_EXCHANGE_ADDRESS, POLYGON_CHAIN_ID};
use crate::error::{PolymarketError, Result};
use crate::types::{OrderParams, OrderResponse, OrderSide};
use alloy::primitives::{keccak256, Address, Bytes, U256};
use alloy::signers::local::PrivateKeySigner;
use alloy::signers::Signer;
use serde::{Deserialize, Serialize};

// =============================================================================
// EIP-712 Constants and Types
// =============================================================================

/// EIP-712 domain name for Polymarket CTF Exchange
const DOMAIN_NAME: &str = "Polymarket CTF Exchange";

/// EIP-712 domain version
const DOMAIN_VERSION: &str = "1";

/// Signature type for EOA (Externally Owned Account)
const SIGNATURE_TYPE_EOA: u8 = 0;

/// Signature type for Polymarket Proxy
#[allow(dead_code)]
const SIGNATURE_TYPE_POLY_PROXY: u8 = 1;

/// Signature type for Polymarket Gnosis Safe
#[allow(dead_code)]
const SIGNATURE_TYPE_POLY_GNOSIS_SAFE: u8 = 2;

/// EIP-712 type hash for the Order struct
/// keccak256("Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)")
fn order_type_hash() -> [u8; 32] {
    keccak256(
        b"Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)"
    ).into()
}

/// EIP-712 type hash for the domain
/// keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
fn domain_type_hash() -> [u8; 32] {
    keccak256(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    ).into()
}

/// Signed order ready for submission to CLOB API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedOrder {
    pub salt: String,
    pub maker: String,
    pub signer: String,
    pub taker: String,
    #[serde(rename = "tokenId")]
    pub token_id: String,
    #[serde(rename = "makerAmount")]
    pub maker_amount: String,
    #[serde(rename = "takerAmount")]
    pub taker_amount: String,
    pub expiration: String,
    pub nonce: String,
    #[serde(rename = "feeRateBps")]
    pub fee_rate_bps: String,
    pub side: String,
    #[serde(rename = "signatureType")]
    pub signature_type: u8,
    pub signature: String,
}

/// Order builder for creating and signing orders
pub struct OrderBuilder {
    signer: PrivateKeySigner,
    chain_id: u64,
    neg_risk: bool,
}

impl OrderBuilder {
    /// Create a new order builder
    ///
    /// # Arguments
    ///
    /// * `private_key` - The private key for signing orders
    /// * `neg_risk` - Whether to use the neg-risk exchange (for negative risk markets)
    pub fn new(private_key: &str, neg_risk: bool) -> Result<Self> {
        let key = private_key.strip_prefix("0x").unwrap_or(private_key);
        let signer: PrivateKeySigner = key
            .parse()
            .map_err(|e| PolymarketError::config_error(format!("Invalid private key: {e}")))?;

        Ok(Self {
            signer,
            chain_id: POLYGON_CHAIN_ID,
            neg_risk,
        })
    }

    /// Get the exchange address based on neg_risk setting
    fn exchange_address(&self) -> Address {
        if self.neg_risk {
            NEG_RISK_CTF_EXCHANGE_ADDRESS
                .parse()
                .expect("Invalid neg risk exchange address")
        } else {
            CTF_EXCHANGE_ADDRESS
                .parse()
                .expect("Invalid exchange address")
        }
    }

    /// Compute the EIP-712 domain separator
    fn domain_separator(&self) -> [u8; 32] {
        let domain_type = domain_type_hash();
        let name_hash = keccak256(DOMAIN_NAME.as_bytes());
        let version_hash = keccak256(DOMAIN_VERSION.as_bytes());
        let chain_id = U256::from(self.chain_id);
        let exchange_addr = self.exchange_address();

        // Encode: domainTypeHash || nameHash || versionHash || chainId || verifyingContract
        let mut data = Vec::with_capacity(160);
        data.extend_from_slice(&domain_type);
        data.extend_from_slice(name_hash.as_slice());
        data.extend_from_slice(version_hash.as_slice());
        data.extend_from_slice(&chain_id.to_be_bytes::<32>());
        data.extend_from_slice(exchange_addr.as_slice());

        keccak256(&data).into()
    }

    /// Compute the struct hash for an order
    fn struct_hash(&self, order: &OrderData) -> [u8; 32] {
        let type_hash = order_type_hash();

        // Encode all order fields
        let mut data = Vec::with_capacity(384);
        data.extend_from_slice(&type_hash);
        data.extend_from_slice(&order.salt.to_be_bytes::<32>());
        data.extend_from_slice(&[0u8; 12]); // pad address to 32 bytes
        data.extend_from_slice(order.maker.as_slice());
        data.extend_from_slice(&[0u8; 12]);
        data.extend_from_slice(order.signer.as_slice());
        data.extend_from_slice(&[0u8; 12]);
        data.extend_from_slice(order.taker.as_slice());
        data.extend_from_slice(&order.token_id.to_be_bytes::<32>());
        data.extend_from_slice(&order.maker_amount.to_be_bytes::<32>());
        data.extend_from_slice(&order.taker_amount.to_be_bytes::<32>());
        data.extend_from_slice(&order.expiration.to_be_bytes::<32>());
        data.extend_from_slice(&order.nonce.to_be_bytes::<32>());
        data.extend_from_slice(&order.fee_rate_bps.to_be_bytes::<32>());
        data.extend_from_slice(&[0u8; 31]);
        data.push(order.side);
        data.extend_from_slice(&[0u8; 31]);
        data.push(order.signature_type);

        keccak256(&data).into()
    }

    /// Compute the EIP-712 hash for signing
    fn eip712_hash(&self, order: &OrderData) -> [u8; 32] {
        let domain_separator = self.domain_separator();
        let struct_hash = self.struct_hash(order);

        // EIP-712: keccak256("\x19\x01" || domainSeparator || structHash)
        let mut data = Vec::with_capacity(66);
        data.push(0x19);
        data.push(0x01);
        data.extend_from_slice(&domain_separator);
        data.extend_from_slice(&struct_hash);

        keccak256(&data).into()
    }

    /// Create and sign an order
    ///
    /// # Arguments
    ///
    /// * `params` - Order parameters (tokenId, side, price, size, etc.)
    ///
    /// # Returns
    ///
    /// A signed order ready for submission to the CLOB API
    pub async fn create_and_sign_order(&self, params: &OrderParams) -> Result<SignedOrder> {
        let maker = self.signer.address();
        let signer = maker; // For EOA, maker and signer are the same

        // Generate random salt
        let salt = U256::from(rand_salt());

        // Parse token ID as U256
        let token_id: U256 = params
            .token_id
            .parse()
            .map_err(|_| PolymarketError::invalid_token("Invalid token ID format"))?;

        // Calculate maker and taker amounts based on price and size
        // Price is between 0 and 1, size is the number of shares
        let price_decimal = params.price;
        let size_decimal = params.size;

        // Convert to basis points for precision
        // maker_amount = size * 10^6 (USDC has 6 decimals)
        // taker_amount depends on side
        let usdc_decimals = 1_000_000u64; // 10^6
        let ctf_decimals = 1_000_000u64; // CTF tokens also use 6 decimals

        let (maker_amount, taker_amount) = match params.side {
            OrderSide::Buy => {
                // Buying outcome tokens: paying USDC, receiving CTF
                // maker_amount = price * size * 10^6 (USDC to pay)
                // taker_amount = size * 10^6 (CTF to receive)
                let usdc_amount =
                    (price_decimal.to_string().parse::<f64>().unwrap_or(0.0)
                        * size_decimal.to_string().parse::<f64>().unwrap_or(0.0)
                        * usdc_decimals as f64) as u64;
                let ctf_amount =
                    (size_decimal.to_string().parse::<f64>().unwrap_or(0.0) * ctf_decimals as f64)
                        as u64;
                (U256::from(usdc_amount), U256::from(ctf_amount))
            }
            OrderSide::Sell => {
                // Selling outcome tokens: paying CTF, receiving USDC
                // maker_amount = size * 10^6 (CTF to pay)
                // taker_amount = price * size * 10^6 (USDC to receive)
                let ctf_amount =
                    (size_decimal.to_string().parse::<f64>().unwrap_or(0.0) * ctf_decimals as f64)
                        as u64;
                let usdc_amount =
                    (price_decimal.to_string().parse::<f64>().unwrap_or(0.0)
                        * size_decimal.to_string().parse::<f64>().unwrap_or(0.0)
                        * usdc_decimals as f64) as u64;
                (U256::from(ctf_amount), U256::from(usdc_amount))
            }
        };

        // Set expiration (default: 30 days from now)
        let expiration = params.expiration.map(U256::from).unwrap_or_else(|| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            U256::from(now + 30 * 24 * 60 * 60) // 30 days
        });

        // Generate nonce
        let nonce = params.nonce.map(U256::from).unwrap_or_else(|| U256::from(rand_salt()));

        // Fee rate in basis points
        let fee_rate_bps = U256::from(params.fee_rate_bps);

        // Side: 0 = BUY, 1 = SELL
        let side: u8 = match params.side {
            OrderSide::Buy => 0,
            OrderSide::Sell => 1,
        };

        // Create order data for signing
        let order_data = OrderData {
            salt,
            maker,
            signer,
            taker: Address::ZERO, // Open order (any taker)
            token_id,
            maker_amount,
            taker_amount,
            expiration,
            nonce,
            fee_rate_bps,
            side,
            signature_type: SIGNATURE_TYPE_EOA,
        };

        // Compute EIP-712 hash
        let hash = self.eip712_hash(&order_data);

        // Sign the hash
        let signature = self
            .signer
            .sign_hash(&hash.into())
            .await
            .map_err(|e| PolymarketError::api_error(format!("Failed to sign order: {e}")))?;

        // Convert signature to bytes
        let sig_bytes: Bytes = signature.as_bytes().into();

        Ok(SignedOrder {
            salt: salt.to_string(),
            maker: format!("{:?}", maker),
            signer: format!("{:?}", signer),
            taker: format!("{:?}", Address::ZERO),
            token_id: token_id.to_string(),
            maker_amount: maker_amount.to_string(),
            taker_amount: taker_amount.to_string(),
            expiration: expiration.to_string(),
            nonce: nonce.to_string(),
            fee_rate_bps: fee_rate_bps.to_string(),
            side: side.to_string(),
            signature_type: SIGNATURE_TYPE_EOA,
            signature: format!("0x{}", hex::encode(sig_bytes.as_ref())),
        })
    }
}

/// Internal order data structure for EIP-712 encoding
struct OrderData {
    salt: U256,
    maker: Address,
    signer: Address,
    taker: Address,
    token_id: U256,
    maker_amount: U256,
    taker_amount: U256,
    expiration: U256,
    nonce: U256,
    fee_rate_bps: U256,
    side: u8,
    signature_type: u8,
}

/// Generate a random salt value
fn rand_salt() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap();
    duration.as_nanos() as u64 ^ (duration.as_secs() << 32)
}

// =============================================================================
// Order Placement Action
// =============================================================================

/// Place an order on Polymarket.
///
/// Creates, signs, and submits an order to the CLOB API.
///
/// # Arguments
///
/// * `client` - Authenticated CLOB client
/// * `params` - Order parameters
/// * `private_key` - Private key for signing (required for order creation)
/// * `neg_risk` - Whether this is a neg-risk market
///
/// # Returns
///
/// Order response with order ID and status
pub async fn place_order(
    client: &ClobClient,
    params: &OrderParams,
    private_key: &str,
    neg_risk: bool,
) -> Result<OrderResponse> {
    // Validate parameters
    let price_f64 = params.price.to_string().parse::<f64>().unwrap_or(0.0);
    let size_f64 = params.size.to_string().parse::<f64>().unwrap_or(0.0);

    if price_f64 <= 0.0 || price_f64 > 1.0 {
        return Err(PolymarketError::invalid_order(
            "Price must be between 0 and 1",
        ));
    }

    if size_f64 <= 0.0 {
        return Err(PolymarketError::invalid_order("Size must be positive"));
    }

    // Create order builder and sign the order
    let builder = OrderBuilder::new(private_key, neg_risk)?;
    let signed_order = builder.create_and_sign_order(params).await?;

    // Submit to CLOB API
    client.post_order(&signed_order).await
}

/// Cancel an order.
///
/// # Arguments
///
/// * `client` - Authenticated CLOB client
/// * `order_id` - The order ID to cancel
///
/// # Returns
///
/// `true` if the order was successfully cancelled
pub async fn cancel_order(client: &ClobClient, order_id: &str) -> Result<bool> {
    if !client.has_credentials() {
        return Err(PolymarketError::auth_error(
            "API credentials required to cancel orders",
        ));
    }

    client.cancel_order(order_id).await
}
