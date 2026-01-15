use anyhow::Result;
#[derive(Debug, Clone)]
pub struct EnvConfig {
    pub private_key: String,
    pub clob_api_url: String,
    pub gamma_api_url: String,
    pub creds: Option<ApiCreds>,
}

#[derive(Debug, Clone)]
pub struct ApiCreds {
    pub key: String,
    pub secret: String,
    pub passphrase: String,
}

pub fn normalize_private_key(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    let key = if trimmed.starts_with("0x") {
        trimmed.to_string()
    } else {
        format!("0x{trimmed}")
    };

    // 0x + 64 hex
    if key.len() != 66 {
        anyhow::bail!("Invalid private key length (expected 0x + 64 hex chars)");
    }
    if !key
        .chars()
        .skip(2)
        .all(|c| c.is_ascii_hexdigit())
    {
        anyhow::bail!("Invalid private key hex (expected 0-9a-fA-F)");
    }
    Ok(key)
}

pub fn load_env_config(execute: bool) -> Result<EnvConfig> {
    let private_key_raw = std::env::var("EVM_PRIVATE_KEY")
        .ok()
        .or_else(|| std::env::var("POLYMARKET_PRIVATE_KEY").ok())
        .or_else(|| std::env::var("WALLET_PRIVATE_KEY").ok())
        .or_else(|| std::env::var("PRIVATE_KEY").ok())
        .ok_or_else(|| anyhow::anyhow!("Missing private key. Set EVM_PRIVATE_KEY (recommended)."))?;

    let private_key = normalize_private_key(&private_key_raw)?;

    let clob_api_url = std::env::var("CLOB_API_URL").unwrap_or_else(|_| "https://clob.polymarket.com".to_string());
    let gamma_api_url =
        std::env::var("GAMMA_API_URL").unwrap_or_else(|_| "https://gamma-api.polymarket.com".to_string());

    let key = std::env::var("CLOB_API_KEY").ok();
    let secret = std::env::var("CLOB_API_SECRET")
        .ok()
        .or_else(|| std::env::var("CLOB_SECRET").ok());
    let passphrase = std::env::var("CLOB_API_PASSPHRASE")
        .ok()
        .or_else(|| std::env::var("CLOB_PASS_PHRASE").ok());

    let creds = match (key, secret, passphrase) {
        (Some(k), Some(s), Some(p)) if !k.trim().is_empty() && !s.trim().is_empty() && !p.trim().is_empty() => {
            Some(ApiCreds {
                key: k,
                secret: s,
                passphrase: p,
            })
        }
        _ => None,
    };

    if execute && creds.is_none() {
        anyhow::bail!(
            "Missing CLOB API credentials for --execute. Set CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE."
        );
    }

    Ok(EnvConfig {
        private_key,
        clob_api_url,
        gamma_api_url,
        creds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use elizaos_plugin_evm::providers::wallet::{WalletProvider, WalletProviderConfig};
    use elizaos_plugin_evm::types::SupportedChain;
    use elizaos_plugin_polymarket::client::ClobClient;

    #[test]
    fn normalize_adds_prefix() {
        let raw = "11".repeat(32);
        let out = normalize_private_key(&raw).unwrap();
        assert_eq!(out, format!("0x{raw}"));
    }

    #[test]
    fn normalize_rejects_bad_len() {
        assert!(normalize_private_key("0x1234").is_err());
    }

    #[tokio::test]
    async fn wallet_derivation_matches() {
        let key = format!("0x{}", "22".repeat(32));
        let wallet = WalletProvider::new(
            WalletProviderConfig::new(key.clone()).with_chain(SupportedChain::Polygon, None),
        )
        .await
        .unwrap();

        let poly = ClobClient::new(Some("https://clob.polymarket.com"), &key)
            .await
            .unwrap();

        assert_eq!(wallet.address(), poly.address());
    }
}

