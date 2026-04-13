use anyhow::Result;
use elizaos_plugin_polymarket::client::ClobClient;

#[tokio::test]
async fn live_markets_fetch_gated() -> Result<()> {
    if std::env::var("POLYMARKET_LIVE_TESTS").ok().as_deref() != Some("1") {
        return Ok(());
    }

    let key = format!("0x{}", "11".repeat(32));
    let client = ClobClient::new(Some("https://clob.polymarket.com"), &key).await?;
    let resp = client.get_markets(None).await?;
    assert!(!resp.data.is_empty(), "expected markets from live API");
    assert!(!resp.data[0].condition_id.trim().is_empty());
    Ok(())
}

