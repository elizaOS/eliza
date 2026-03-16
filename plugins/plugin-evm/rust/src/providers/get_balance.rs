//! Token balance provider for EVM chains

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::WalletProvider;
use crate::types::SupportedChain;

/// Provider context for token balance queries.
#[derive(Debug, Clone, Default)]
pub struct ProviderContext {
    /// The user message text
    pub message_text: String,
    /// The chain to query
    pub chain: Option<SupportedChain>,
    /// The token symbol to query
    pub token: Option<String>,
}

/// Result from parsing the LLM response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedResponse {
    /// Token symbol
    pub token: Option<String>,
    /// Chain name
    pub chain: Option<String>,
    /// Error flag
    pub error: Option<bool>,
}

/// Provider result structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderResult {
    /// Human-readable text
    pub text: String,
    /// Structured data
    pub data: Value,
    /// Key-value pairs
    pub values: Value,
}

impl Default for ProviderResult {
    fn default() -> Self {
        Self {
            text: String::new(),
            data: serde_json::json!({}),
            values: serde_json::json!({}),
        }
    }
}

/// Token balance provider
pub struct TokenBalanceProvider;

impl TokenBalanceProvider {
    /// Provider name
    pub const NAME: &'static str = "TOKEN_BALANCE";

    /// Provider description
    pub const DESCRIPTION: &'static str =
        "Token balance for ERC20 tokens when onchain actions are requested";

    /// Whether this provider is dynamic
    pub const DYNAMIC: bool = true;

    /// Parse simple XML key-value pairs from LLM response
    #[allow(dead_code)]
    fn parse_key_value_xml(xml_str: &str) -> ParsedResponse {
        use regex::Regex;

        let mut response = ParsedResponse {
            token: None,
            chain: None,
            error: None,
        };

        // Find token
        if let Ok(re) = Regex::new(r"<token>([^<]*)</token>") {
            if let Some(caps) = re.captures(xml_str) {
                response.token = caps.get(1).map(|m| m.as_str().trim().to_string());
            }
        }

        // Find chain
        if let Ok(re) = Regex::new(r"<chain>([^<]*)</chain>") {
            if let Some(caps) = re.captures(xml_str) {
                response.chain = caps.get(1).map(|m| m.as_str().trim().to_string());
            }
        }

        // Find error
        if let Ok(re) = Regex::new(r"<error>([^<]*)</error>") {
            if let Some(caps) = re.captures(xml_str) {
                response.error = caps.get(1).map(|m| m.as_str().trim() == "true");
            }
        }

        response
    }

    /// Get token balance (requires LLM and wallet integration)
    pub fn get(
        &self,
        context: &ProviderContext,
        wallet_provider: &WalletProvider,
    ) -> ProviderResult {
        // If token and chain are provided directly, use them
        let (token, chain) = match (&context.token, &context.chain) {
            (Some(t), Some(c)) => (t.to_uppercase(), *c),
            _ => {
                // Would need LLM integration to parse from message_text
                return ProviderResult::default();
            }
        };

        // Check if chain is configured
        if !wallet_provider.has_chain(chain) {
            return ProviderResult {
                text: format!("Chain {:?} is not configured", chain),
                data: serde_json::json!({
                    "error": format!("Chain {:?} is not configured", chain)
                }),
                values: serde_json::json!({}),
            };
        }

        let address = wallet_provider.address();

        // Note: Actual balance query would require web3 integration
        // This is a structural placeholder that matches TypeScript functionality
        let balance = "0";
        let has_balance = false;

        ProviderResult {
            text: format!(
                "{} balance on {:?} for {}: {}",
                token, chain, address, balance
            ),
            data: serde_json::json!({
                "token": token,
                "chain": format!("{:?}", chain),
                "balance": balance,
                "address": address.to_string(),
                "hasBalance": has_balance,
            }),
            values: serde_json::json!({
                "token": token,
                "chain": format!("{:?}", chain),
                "balance": balance,
                "hasBalance": has_balance.to_string(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_xml_success() {
        let xml = "<response><token>ETH</token><chain>ethereum</chain></response>";
        let parsed = TokenBalanceProvider::parse_key_value_xml(xml);
        assert_eq!(parsed.token, Some("ETH".to_string()));
        assert_eq!(parsed.chain, Some("ethereum".to_string()));
        assert!(parsed.error.is_none());
    }

    #[test]
    fn test_parse_xml_error() {
        let xml = "<response><error>true</error></response>";
        let parsed = TokenBalanceProvider::parse_key_value_xml(xml);
        assert!(parsed.token.is_none());
        assert!(parsed.chain.is_none());
        assert_eq!(parsed.error, Some(true));
    }

    #[test]
    fn test_provider_metadata() {
        assert_eq!(TokenBalanceProvider::NAME, "TOKEN_BALANCE");
        assert!(TokenBalanceProvider::DYNAMIC);
    }
}
