#![allow(missing_docs)]

use crate::client::ClobClient;
use crate::error::Result;
use crate::types::{Market, MarketFilters, MarketsResponse, SimplifiedMarketsResponse};

pub async fn get_markets(
    client: &ClobClient,
    filters: Option<MarketFilters>,
) -> Result<MarketsResponse> {
    let cursor = filters.as_ref().and_then(|f| f.next_cursor.as_deref());
    let mut response = client.get_markets(cursor).await?;

    if let Some(filters) = filters {
        if let Some(category) = &filters.category {
            response
                .data
                .retain(|m| m.category.eq_ignore_ascii_case(category));
        }
        if let Some(active) = filters.active {
            response.data.retain(|m| m.active == active);
        }
        if let Some(limit) = filters.limit {
            response.data.truncate(limit as usize);
        }
        response.count = response.data.len() as u32;
    }

    Ok(response)
}

pub async fn get_simplified_markets(
    client: &ClobClient,
    next_cursor: Option<&str>,
) -> Result<SimplifiedMarketsResponse> {
    client.get_simplified_markets(next_cursor).await
}

pub async fn get_sampling_markets(
    client: &ClobClient,
    next_cursor: Option<&str>,
) -> Result<SimplifiedMarketsResponse> {
    client.get_sampling_markets(next_cursor).await
}

pub async fn get_market_details(client: &ClobClient, condition_id: &str) -> Result<Market> {
    client.get_market(condition_id).await
}
pub async fn get_open_markets(
    client: &ClobClient,
    next_cursor: Option<&str>,
    limit: Option<u32>,
) -> Result<MarketsResponse> {
    let mut response = client.get_markets(next_cursor).await?;

    // Filter for open markets (active = true, closed = false)
    response.data.retain(|m| m.active && !m.closed);

    // Apply limit if provided
    if let Some(limit) = limit {
        response.data.truncate(limit as usize);
    }

    response.count = response.data.len() as u32;
    Ok(response)
}

/// Get CLOB markets (direct API call with pagination)
///
/// # Arguments
///
/// * `client` - The CLOB client
/// * `next_cursor` - Optional pagination cursor
///
/// # Errors
///
/// Returns an error if the API request fails
pub async fn get_clob_markets(
    client: &ClobClient,
    next_cursor: Option<&str>,
) -> Result<MarketsResponse> {
    client.get_markets(next_cursor).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_market_filters_default() {
        let filters = MarketFilters::default();
        assert!(filters.category.is_none());
        assert!(filters.active.is_none());
        assert!(filters.limit.is_none());
    }
}
