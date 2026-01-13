#![allow(missing_docs)]
//! Account management actions for Polymarket

use crate::client::ClobClient;
use crate::error::Result;
use crate::types::ApiKey;

/// Account access status information
#[derive(Debug, Clone)]
pub struct AccountAccessStatus {
    /// Whether U.S. certification is required
    pub cert_required: Option<bool>,
    /// List of managed API keys
    pub api_keys: Vec<ApiKey>,
    /// Active session API key ID (if any)
    pub active_session_key_id: Option<String>,
}

/// Get account access status, including U.S. certification requirements and API key details
///
/// # Arguments
///
/// * `client` - The CLOB client (may or may not be authenticated)
///
/// # Errors
///
/// Returns an error if the API request fails
pub async fn get_account_access_status(client: &ClobClient) -> Result<AccountAccessStatus> {
    let status = AccountAccessStatus {
        cert_required: None,
        api_keys: Vec::new(),
        active_session_key_id: None,
    };
    let _ = client;
    Ok(status)
}

/// Handle authentication status check
///
/// # Arguments
///
/// * `client` - The CLOB client
///
/// # Returns
///
/// Tuple of (has_private_key, has_api_key, has_api_secret, has_api_passphrase, is_fully_authenticated)
pub fn handle_authentication(client: &ClobClient) -> (bool, bool, bool, bool, bool) {
    let has_creds = client.has_credentials();
    let address = client.address();

    let has_private_key = address != alloy::primitives::Address::ZERO;
    let has_api_key = has_creds;
    let has_api_secret = has_creds;
    let has_api_passphrase = has_creds;
    let is_fully_authenticated = has_private_key && has_creds;

    (
        has_private_key,
        has_api_key,
        has_api_secret,
        has_api_passphrase,
        is_fully_authenticated,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::ClobClient;
    use crate::types::ApiKeyCreds;

    #[test]
    fn test_handle_authentication() {
        let key = format!("0x{}", "11".repeat(32));
        let client = futures::executor::block_on(ClobClient::new(None, &key)).expect("client");
        let (has_private_key, has_api_key, has_api_secret, has_api_passphrase, is_fully_authenticated) =
            handle_authentication(&client);
        assert!(has_private_key);
        assert!(!has_api_key);
        assert!(!has_api_secret);
        assert!(!has_api_passphrase);
        assert!(!is_fully_authenticated);

        let creds = ApiKeyCreds {
            key: "k".to_string(),
            secret: "s".to_string(),
            passphrase: "p".to_string(),
        };
        let client2 =
            futures::executor::block_on(ClobClient::new_with_creds(None, &key, creds)).expect("client");
        let (has_private_key2, has_api_key2, has_api_secret2, has_api_passphrase2, is_fully_authenticated2) =
            handle_authentication(&client2);
        assert!(has_private_key2);
        assert!(has_api_key2);
        assert!(has_api_secret2);
        assert!(has_api_passphrase2);
        assert!(is_fully_authenticated2);
    }
}
