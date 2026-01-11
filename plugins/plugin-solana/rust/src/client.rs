#![allow(missing_docs)]
//! Solana client for RPC operations.

use crate::{
    error::{SolanaError, SolanaResult},
    keypair::WalletConfig,
    types::*,
};
use rust_decimal::Decimal;
use rust_decimal::prelude::*;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
#[allow(deprecated)]
use solana_sdk::system_instruction;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    message::VersionedMessage,
    pubkey::Pubkey,
    signature::Signer,
    transaction::VersionedTransaction,
};
use spl_associated_token_account::get_associated_token_address;
use spl_token::instruction as token_instruction;
use std::{collections::HashMap, str::FromStr, sync::Arc};
use tracing::{debug, info};

/// Lamports per SOL constant.
const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

/// Jupiter API base URL.
const JUPITER_API_URL: &str = "https://quote-api.jup.ag/v6";

/// Birdeye API base URL.
const BIRDEYE_API_URL: &str = "https://public-api.birdeye.so";

/// Solana client for blockchain operations.
pub struct SolanaClient {
    /// RPC client.
    rpc: Arc<RpcClient>,
    /// HTTP client for external APIs.
    http: reqwest::Client,
    /// Wallet configuration.
    config: WalletConfig,
}

impl SolanaClient {
    /// Create a new Solana client with the given configuration.
    ///
    /// # Errors
    /// Returns an error if the configuration is invalid.
    pub fn new(config: WalletConfig) -> SolanaResult<Self> {
        let rpc = RpcClient::new_with_commitment(
            config.rpc_url.clone(),
            CommitmentConfig::confirmed(),
        );

        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| SolanaError::Internal(e.to_string()))?;

        Ok(Self {
            rpc: Arc::new(rpc),
            http,
            config,
        })
    }

    /// Get the wallet's public key.
    #[must_use]
    pub fn public_key(&self) -> &Pubkey {
        &self.config.public_key
    }

    /// Get SOL balance for the configured wallet.
    ///
    /// # Returns
    /// Balance in SOL (not lamports).
    pub async fn get_sol_balance(&self) -> SolanaResult<Decimal> {
        self.get_sol_balance_for(&self.config.public_key).await
    }

    /// Get SOL balance for any address.
    ///
    /// # Arguments
    /// * `pubkey` - The public key to query
    ///
    /// # Returns
    /// Balance in SOL (not lamports).
    pub async fn get_sol_balance_for(&self, pubkey: &Pubkey) -> SolanaResult<Decimal> {
        let lamports = self
            .rpc
            .get_balance(pubkey)
            .await
            .map_err(|e| SolanaError::Rpc(e.to_string()))?;

        Ok(lamports_to_sol(lamports))
    }

    /// Get SOL balances for multiple addresses.
    ///
    /// # Arguments
    /// * `addresses` - List of Base58-encoded addresses
    ///
    /// # Returns
    /// Map of address to balance in SOL.
    pub async fn get_balances_for_addresses(
        &self,
        addresses: &[String],
    ) -> SolanaResult<HashMap<String, Decimal>> {
        let mut result = HashMap::new();

        for addr in addresses {
            let pubkey = Pubkey::from_str(addr)?;
            let balance = self.get_sol_balance_for(&pubkey).await?;
            result.insert(addr.clone(), balance);
        }

        Ok(result)
    }

    /// Get token accounts for the configured wallet.
    pub async fn get_token_accounts(&self) -> SolanaResult<Vec<TokenAccountInfo>> {
        self.get_token_accounts_for(&self.config.public_key).await
    }

    /// Get token accounts for any address.
    pub async fn get_token_accounts_for(
        &self,
        owner: &Pubkey,
    ) -> SolanaResult<Vec<TokenAccountInfo>> {
        use solana_rpc_client_api::request::TokenAccountsFilter;

        let accounts = self
            .rpc
            .get_token_accounts_by_owner(owner, TokenAccountsFilter::ProgramId(spl_token::id()))
            .await
            .map_err(|e| SolanaError::Rpc(e.to_string()))?;

        let mut result = Vec::new();

        for account in accounts {
            // Parse the account data
            if let Some(data) = account.account.data.decode() {
                if data.len() >= 72 {
                    let mint = Pubkey::try_from(&data[0..32])
                        .map(|p| p.to_string())
                        .unwrap_or_default();
                    let owner_key = Pubkey::try_from(&data[32..64])
                        .map(|p| p.to_string())
                        .unwrap_or_default();

                    // Parse amount (u64 at offset 64)
                    let amount = u64::from_le_bytes(
                        data[64..72]
                            .try_into()
                            .unwrap_or([0u8; 8]),
                    );

                    // Get decimals from mint (would need separate call in production)
                    // For now, assume 9 decimals (SOL standard)
                    let decimals = 9u8;
                    let ui_amount = Decimal::from(amount) / Decimal::from(10u64.pow(u32::from(decimals)));

                    result.push(TokenAccountInfo {
                        mint,
                        owner: owner_key,
                        amount: amount.to_string(),
                        decimals,
                        ui_amount,
                    });
                }
            }
        }

        Ok(result)
    }

    /// Transfer SOL to another address.
    ///
    /// # Arguments
    /// * `recipient` - Recipient's public key
    /// * `amount_sol` - Amount in SOL to transfer
    ///
    /// # Returns
    /// Transaction signature if successful.
    pub async fn transfer_sol(
        &self,
        recipient: &Pubkey,
        amount_sol: Decimal,
    ) -> SolanaResult<TransferResult> {
        let keypair = self.config.keypair()?;
        let lamports = sol_to_lamports(amount_sol);

        // Check balance
        let balance = self
            .rpc
            .get_balance(&keypair.pubkey())
            .await
            .map_err(|e| SolanaError::Rpc(e.to_string()))?;

        if balance < lamports {
            return Err(SolanaError::InsufficientBalance {
                required: lamports,
                available: balance,
            });
        }

        // Create transfer instruction
        let instruction = system_instruction::transfer(&keypair.pubkey(), recipient, lamports);

        // Get recent blockhash
        let blockhash = self
            .rpc
            .get_latest_blockhash()
            .await
            .map_err(|e| SolanaError::Rpc(e.to_string()))?;

        // Create and sign transaction
        let message = solana_sdk::message::Message::new(&[instruction], Some(&keypair.pubkey()));
        let transaction = solana_sdk::transaction::Transaction::new(&[keypair], message, blockhash);

        // Send transaction
        let signature = self
            .rpc
            .send_and_confirm_transaction(&transaction)
            .await
            .map_err(|e| SolanaError::Transaction(e.to_string()))?;

        info!("SOL transfer successful: {}", signature);

        Ok(TransferResult {
            success: true,
            signature: Some(signature.to_string()),
            amount: amount_sol.to_string(),
            recipient: recipient.to_string(),
            error: None,
        })
    }

    /// Transfer SPL tokens to another address.
    ///
    /// # Arguments
    /// * `mint` - Token mint address
    /// * `recipient` - Recipient's public key
    /// * `amount` - Amount in token units (will be multiplied by 10^decimals)
    ///
    /// # Returns
    /// Transaction signature if successful.
    pub async fn transfer_token(
        &self,
        mint: &Pubkey,
        recipient: &Pubkey,
        amount: Decimal,
    ) -> SolanaResult<TransferResult> {
        let keypair = self.config.keypair()?;

        // Get mint info for decimals
        let mint_info = self
            .rpc
            .get_account(mint)
            .await
            .map_err(|e| SolanaError::Rpc(e.to_string()))?;

        // Parse decimals from mint account (offset 44 in SPL Token mint layout)
        let decimals = if mint_info.data.len() >= 45 {
            mint_info.data[44]
        } else {
            9 // Default to 9 if we can't parse
        };

        let raw_amount = (amount * Decimal::from(10u64.pow(u32::from(decimals))))
            .to_u64()
            .ok_or_else(|| SolanaError::Internal("Amount overflow".to_string()))?;

        // Get source and destination ATAs
        let source_ata = get_associated_token_address(&keypair.pubkey(), mint);
        let dest_ata = get_associated_token_address(recipient, mint);

        let mut instructions = Vec::new();

        // Check if destination ATA exists, if not create it
        let dest_account = self.rpc.get_account(&dest_ata).await;
        if dest_account.is_err() {
            instructions.push(
                spl_associated_token_account::instruction::create_associated_token_account(
                    &keypair.pubkey(),
                    recipient,
                    mint,
                    &spl_token::id(),
                ),
            );
        }

        // Add transfer instruction
        instructions.push(
            token_instruction::transfer(
                &spl_token::id(),
                &source_ata,
                &dest_ata,
                &keypair.pubkey(),
                &[],
                raw_amount,
            )
            .map_err(|e| SolanaError::Transaction(e.to_string()))?,
        );

        // Get recent blockhash
        let blockhash = self
            .rpc
            .get_latest_blockhash()
            .await
            .map_err(|e| SolanaError::Rpc(e.to_string()))?;

        // Create and sign transaction
        let message = solana_sdk::message::Message::new(&instructions, Some(&keypair.pubkey()));
        let transaction = solana_sdk::transaction::Transaction::new(&[keypair], message, blockhash);

        // Send transaction
        let signature = self
            .rpc
            .send_and_confirm_transaction(&transaction)
            .await
            .map_err(|e| SolanaError::Transaction(e.to_string()))?;

        info!("Token transfer successful: {}", signature);

        Ok(TransferResult {
            success: true,
            signature: Some(signature.to_string()),
            amount: amount.to_string(),
            recipient: recipient.to_string(),
            error: None,
        })
    }

    /// Get a swap quote from Jupiter.
    ///
    /// # Arguments
    /// * `params` - Quote parameters
    ///
    /// # Returns
    /// Swap quote from Jupiter.
    pub async fn get_swap_quote(&self, params: &SwapQuoteParams) -> SolanaResult<SwapQuote> {
        let url = format!(
            "{}/quote?inputMint={}&outputMint={}&amount={}&slippageBps={}&dynamicSlippage=true",
            JUPITER_API_URL,
            params.input_mint,
            params.output_mint,
            params.amount,
            params.slippage_bps
        );

        debug!("Fetching Jupiter quote: {}", url);

        let response = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| SolanaError::SwapQuote(e.to_string()))?;

        if !response.status().is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(SolanaError::SwapQuote(format!(
                "Jupiter API error: {}",
                text
            )));
        }

        response
            .json::<SwapQuote>()
            .await
            .map_err(|e| SolanaError::SwapQuote(e.to_string()))
    }

    /// Execute a swap using Jupiter.
    ///
    /// # Arguments
    /// * `quote` - The quote to execute
    ///
    /// # Returns
    /// Swap result with transaction signature.
    pub async fn execute_swap(&self, quote: &SwapQuote) -> SolanaResult<SwapResult> {
        let keypair = self.config.keypair()?;

        // Get swap transaction from Jupiter
        let swap_request = serde_json::json!({
            "quoteResponse": quote,
            "userPublicKey": keypair.pubkey().to_string(),
            "wrapAndUnwrapSol": true,
            "dynamicComputeUnitLimit": true,
            "prioritizationFeeLamports": {
                "priorityLevelWithMaxLamports": {
                    "maxLamports": 4000000,
                    "priorityLevel": "veryHigh"
                }
            }
        });

        let response = self
            .http
            .post(format!("{}/swap", JUPITER_API_URL))
            .json(&swap_request)
            .send()
            .await
            .map_err(|e| SolanaError::SwapExecution(e.to_string()))?;

        if !response.status().is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(SolanaError::SwapExecution(format!(
                "Jupiter swap API error: {}",
                text
            )));
        }

        let swap_tx: SwapTransaction = response
            .json()
            .await
            .map_err(|e| SolanaError::SwapExecution(e.to_string()))?;

        // Decode and sign the transaction
        let tx_bytes = bs58::decode(&swap_tx.swap_transaction)
            .into_vec()
            .or_else(|_| {
                // Try base64 if base58 fails
                base64_decode(&swap_tx.swap_transaction)
                    .map_err(|_| SolanaError::SwapExecution("Invalid transaction encoding".to_string()))
            })?;

        let mut transaction: VersionedTransaction = bincode::deserialize(&tx_bytes)
            .map_err(|e: bincode::Error| SolanaError::SwapExecution(e.to_string()))?;

        // Sign the transaction
        transaction.signatures[0] = keypair.sign_message(
            match &transaction.message {
                VersionedMessage::Legacy(m) => m.serialize(),
                VersionedMessage::V0(m) => m.serialize(),
            }
            .as_slice(),
        );

        // Send transaction
        let signature = self
            .rpc
            .send_and_confirm_transaction(&transaction)
            .await
            .map_err(|e| SolanaError::SwapExecution(e.to_string()))?;

        info!("Swap successful: {}", signature);

        Ok(SwapResult {
            success: true,
            signature: Some(signature.to_string()),
            in_amount: Some(quote.in_amount.clone()),
            out_amount: Some(quote.out_amount.clone()),
            error: None,
        })
    }

    /// Get token prices from Birdeye.
    ///
    /// # Arguments
    /// * `mints` - List of token mint addresses
    ///
    /// # Returns
    /// Map of mint address to price in USD.
    pub async fn get_token_prices(&self, mints: &[String]) -> SolanaResult<HashMap<String, f64>> {
        let api_key = self.config.birdeye_api_key.as_ref().ok_or_else(|| {
            SolanaError::Config("BIRDEYE_API_KEY required for price data".to_string())
        })?;

        let mut prices = HashMap::new();

        for mint in mints {
            let url = format!("{}/defi/price?address={}", BIRDEYE_API_URL, mint);

            let response = self
                .http
                .get(&url)
                .header("X-API-KEY", api_key)
                .header("x-chain", "solana")
                .send()
                .await;

            if let Ok(resp) = response {
                if let Ok(data) = resp.json::<BirdeyePriceResponse>().await {
                    if data.success {
                        prices.insert(mint.clone(), data.data.value);
                    }
                }
            }
        }

        Ok(prices)
    }

    /// Validate a Solana address.
    pub fn is_valid_address(address: &str) -> bool {
        Pubkey::from_str(address).is_ok()
    }

    /// Check if an address is on the Ed25519 curve (wallet vs PDA).
    pub fn is_on_curve(address: &str) -> SolanaResult<bool> {
        let pubkey = Pubkey::from_str(address)?;
        Ok(pubkey.is_on_curve())
    }
}

/// Convert lamports to SOL.
fn lamports_to_sol(lamports: u64) -> Decimal {
    Decimal::from(lamports) / Decimal::from(LAMPORTS_PER_SOL)
}

/// Convert SOL to lamports.
fn sol_to_lamports(sol: Decimal) -> u64 {
    (sol * Decimal::from(LAMPORTS_PER_SOL))
        .to_u64()
        .unwrap_or(0)
}

/// Simple Base64 decoder.
fn base64_decode(s: &str) -> Result<Vec<u8>, SolanaError> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    fn decode_char(c: u8) -> Option<u8> {
        ALPHABET.iter().position(|&x| x == c).map(|i| i as u8)
    }

    let s = s.trim_end_matches('=');
    let mut result = Vec::with_capacity(s.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0;

    for c in s.bytes() {
        if let Some(val) = decode_char(c) {
            buffer = (buffer << 6) | u32::from(val);
            bits += 6;

            if bits >= 8 {
                bits -= 8;
                result.push((buffer >> bits) as u8);
                buffer &= (1 << bits) - 1;
            }
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lamports_to_sol() {
        assert_eq!(lamports_to_sol(1_000_000_000), Decimal::ONE);
        assert_eq!(lamports_to_sol(500_000_000), Decimal::new(5, 1));
    }

    #[test]
    fn test_sol_to_lamports() {
        assert_eq!(sol_to_lamports(Decimal::ONE), 1_000_000_000);
        assert_eq!(sol_to_lamports(Decimal::new(5, 1)), 500_000_000);
    }

    #[test]
    fn test_is_valid_address() {
        assert!(SolanaClient::is_valid_address(
            "So11111111111111111111111111111111111111112"
        ));
        assert!(!SolanaClient::is_valid_address("invalid"));
    }
}

