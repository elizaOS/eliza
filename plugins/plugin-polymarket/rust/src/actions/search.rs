//! Search Markets Action
//!
//! Search for Polymarket prediction markets using the Gamma API public-search endpoint.
//! Supports searching for markets by keywords like "miami heat", "epstein", "bitcoin", etc.

use crate::constants::GAMMA_API_URL;
use crate::error::{PolymarketError, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

// =============================================================================
// Type Definitions for Gamma API Search Response
// =============================================================================

/// Market from Gamma API search response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GammaMarket {
    pub id: String,
    pub question: String,
    #[serde(rename = "conditionId")]
    pub condition_id: String,
    pub slug: String,
    pub description: String,
    pub outcomes: String,
    #[serde(rename = "outcomePrices")]
    pub outcome_prices: String,
    pub volume: String,
    pub liquidity: String,
    pub active: bool,
    pub closed: bool,
    #[serde(rename = "endDate")]
    pub end_date: String,
    pub archived: Option<bool>,
    pub image: Option<String>,
    pub icon: Option<String>,
    #[serde(rename = "clobTokenIds")]
    pub clob_token_ids: Option<String>,
    #[serde(rename = "volume24hr")]
    pub volume_24hr: Option<f64>,
    #[serde(rename = "bestBid")]
    pub best_bid: Option<f64>,
    #[serde(rename = "bestAsk")]
    pub best_ask: Option<f64>,
    #[serde(rename = "lastTradePrice")]
    pub last_trade_price: Option<f64>,
}

/// Event from Gamma API search response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GammaEvent {
    pub id: String,
    pub title: String,
    pub slug: String,
    pub description: String,
    pub active: bool,
    pub closed: bool,
    pub markets: Vec<GammaMarket>,
    pub volume: Option<f64>,
    pub liquidity: Option<f64>,
    pub image: Option<String>,
    pub icon: Option<String>,
}

/// Tag from Gamma API search response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GammaTag {
    pub id: String,
    pub label: String,
    pub slug: String,
    pub event_count: Option<i32>,
}

/// Profile from Gamma API search response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GammaProfile {
    pub id: String,
    pub name: String,
    pub pseudonym: Option<String>,
}

/// Pagination info from Gamma API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GammaPagination {
    #[serde(rename = "hasMore")]
    pub has_more: bool,
    #[serde(rename = "totalResults")]
    pub total_results: i32,
}

/// Gamma API search response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GammaSearchResponse {
    pub events: Vec<GammaEvent>,
    pub tags: Vec<GammaTag>,
    pub profiles: Vec<GammaProfile>,
    pub pagination: Option<GammaPagination>,
}

/// Search result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub query: String,
    pub total_results: usize,
    pub displayed_results: usize,
    pub has_more: bool,
    pub markets: Vec<GammaMarket>,
    pub tags: Vec<GammaTag>,
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Parse outcomes JSON string to list
pub fn parse_outcomes(outcomes_str: &str) -> Vec<String> {
    serde_json::from_str(outcomes_str).unwrap_or_default()
}

/// Parse outcome prices JSON string to list of floats
pub fn parse_outcome_prices(prices_str: &str) -> Vec<f64> {
    let parsed: std::result::Result<Vec<String>, _> = serde_json::from_str(prices_str);
    match parsed {
        Ok(strings) => strings
            .iter()
            .filter_map(|s| s.parse::<f64>().ok())
            .collect(),
        Err(_) => vec![],
    }
}

/// Format price as percentage
pub fn format_price(price: f64) -> String {
    format!("{:.1}%", price * 100.0)
}

/// Format volume with appropriate suffix
pub fn format_volume(volume: f64) -> String {
    if volume >= 1_000_000.0 {
        format!("${:.2}M", volume / 1_000_000.0)
    } else if volume >= 1_000.0 {
        format!("${:.1}K", volume / 1_000.0)
    } else {
        format!("${:.0}", volume)
    }
}

// =============================================================================
// Search Markets Action
// =============================================================================

/// Search for Polymarket prediction markets by keyword.
///
/// Uses the Gamma API public-search endpoint to find markets matching
/// the search query. No authentication required.
///
/// # Arguments
///
/// * `query` - Search term to look up
/// * `limit` - Maximum number of results to return (default: 10, max: 25)
/// * `active_only` - If true, only return active (non-closed) markets
///
/// # Returns
///
/// SearchResult with matching markets and metadata
pub async fn search_markets(
    query: &str,
    limit: Option<usize>,
    active_only: bool,
) -> Result<SearchResult> {
    let limit = limit.unwrap_or(10).min(25);

    // URL encode the query manually (simple implementation)
    let encoded_query: String = query
        .chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '&' => "%26".to_string(),
            '=' => "%3D".to_string(),
            '?' => "%3F".to_string(),
            '#' => "%23".to_string(),
            '+' => "%2B".to_string(),
            _ if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~' => {
                c.to_string()
            }
            _ => format!("%{:02X}", c as u32),
        })
        .collect();

    let mut url = format!(
        "{}/public-search?q={}&limit_per_type={}",
        GAMMA_API_URL, encoded_query, limit
    );

    if active_only {
        url.push_str("&events_status=active");
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| PolymarketError::network_error(format!("Failed to create HTTP client: {e}")))?;

    let response = client.get(&url).send().await.map_err(|e| {
        PolymarketError::network_error(format!("Failed to search markets: {e}"))
    })?;

    if !response.status().is_success() {
        return Err(PolymarketError::api_error(format!(
            "Search API returned error: {}",
            response.status()
        )));
    }

    let search_response: GammaSearchResponse = response.json().await.map_err(|e| {
        PolymarketError::api_error(format!("Failed to parse search response: {e}"))
    })?;

    // Extract all markets from events
    let mut all_markets: Vec<GammaMarket> = Vec::new();

    for event in search_response.events {
        for market in event.markets {
            // Apply active filter if requested
            if active_only && (!market.active || market.closed) {
                continue;
            }
            all_markets.push(market);
        }
    }

    // Limit results
    let limited_markets: Vec<GammaMarket> = all_markets.iter().take(limit).cloned().collect();

    Ok(SearchResult {
        query: query.to_string(),
        total_results: all_markets.len(),
        displayed_results: limited_markets.len(),
        has_more: all_markets.len() > limit,
        markets: limited_markets,
        tags: search_response.tags,
    })
}

/// Format search results for display
pub fn format_search_results(result: &SearchResult) -> String {
    let mut lines = vec![format!(
        "🔍 **Search Results for \"{}\"**\n",
        result.query
    )];

    if result.markets.is_empty() {
        lines.push(format!("No markets found matching \"{}\".", result.query));
        lines.push("\n💡 *Try different keywords or check the spelling.*".to_string());
        return lines.join("\n");
    }

    lines.push(format!("Found {} market(s):\n", result.total_results));

    for (i, market) in result.markets.iter().enumerate() {
        let status_emoji = if market.active && !market.closed {
            "🟢"
        } else {
            "🔴"
        };
        lines.push(format!(
            "**{}. {}** {}",
            i + 1,
            market.question,
            status_emoji
        ));

        // Parse and show outcomes and prices
        let outcomes = parse_outcomes(&market.outcomes);
        let prices = parse_outcome_prices(&market.outcome_prices);

        if !outcomes.is_empty() && !prices.is_empty() {
            let price_parts: Vec<String> = outcomes
                .iter()
                .zip(prices.iter())
                .map(|(outcome, price)| format!("{}: {}", outcome, format_price(*price)))
                .collect();
            lines.push(format!("   📊 {}", price_parts.join(" | ")));
        }

        if let Ok(vol) = market.volume.parse::<f64>() {
            let mut vol_str = format!("   💰 Volume: {}", format_volume(vol));
            if let Some(vol_24h) = market.volume_24hr {
                vol_str.push_str(&format!(" (24h: {})", format_volume(vol_24h)));
            }
            lines.push(vol_str);
        }

        if !market.end_date.is_empty() {
            lines.push(format!("   ⏰ Ends: {}", &market.end_date[..10.min(market.end_date.len())]));
        }

        if !market.condition_id.is_empty() {
            lines.push(format!(
                "   🔑 ID: `{}...`",
                &market.condition_id[..16.min(market.condition_id.len())]
            ));
        }

        if market.clob_token_ids.is_some() {
            lines.push("   🏷️ Token IDs available for trading".to_string());
        }

        lines.push(String::new());
    }

    if result.has_more {
        lines.push(format!(
            "\n📄 *Showing {} of {} results. Increase limit to see more.*",
            result.displayed_results, result.total_results
        ));
    }

    if !result.tags.is_empty() {
        let tag_labels: Vec<&str> = result.tags.iter().take(5).map(|t| t.label.as_str()).collect();
        lines.push(format!("\n🏷️ *Related tags: {}*", tag_labels.join(", ")));
    }

    lines.join("\n")
}
