//! Token-based authentication for webhook endpoints.
//!
//! Supports three methods (in priority order):
//!   1. `Authorization: Bearer <token>`
//!   2. `x-otto-token: <token>`
//!   3. `?token=<token>` (deprecated, logs a warning)

use log::warn;
use std::collections::HashMap;

/// A minimal representation of an HTTP request used for token extraction.
#[derive(Debug, Default)]
pub struct RequestParts {
    /// HTTP headers. Values may be a single string or a list of strings
    /// encoded as the first element of a vec.
    pub headers: HashMap<String, Vec<String>>,
    /// Parsed query-string parameters.
    pub query: HashMap<String, String>,
    /// The raw request URL (used as a fallback for query-param extraction).
    pub url: Option<String>,
}

impl RequestParts {
    /// Get the first header value for a given key (case-sensitive lookup).
    fn header(&self, key: &str) -> Option<&str> {
        self.headers
            .get(key)
            .and_then(|v| v.first())
            .map(|s| s.as_str())
    }
}

/// Extract an authentication token from a request.
///
/// Checks (in priority order):
///   1. `Authorization: Bearer <token>` header
///   2. `x-otto-token` header
///   3. `?token=<token>` query parameter (deprecated)
pub fn extract_token(req: &RequestParts) -> Option<String> {
    // 1. Authorization: Bearer <token>
    let auth = req
        .header("authorization")
        .or_else(|| req.header("Authorization"));
    if let Some(auth_str) = auth {
        if let Some(token) = auth_str.strip_prefix("Bearer ") {
            let trimmed = token.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    // 2. x-otto-token header
    let otto = req
        .header("x-otto-token")
        .or_else(|| req.header("X-Otto-Token"));
    if let Some(otto_str) = otto {
        let trimmed = otto_str.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    // 3. Query parameter (deprecated)
    if let Some(qt) = req.query.get("token") {
        let trimmed = qt.trim();
        if !trimmed.is_empty() {
            warn!(
                "[Webhooks] Query-param token auth is deprecated; \
                 use Authorization header instead"
            );
            return Some(trimmed.to_string());
        }
    }

    // Fallback: parse from URL
    if let Some(url) = &req.url {
        if let Some(query_start) = url.find('?') {
            let query_str = &url[query_start + 1..];
            for pair in query_str.split('&') {
                let mut parts = pair.splitn(2, '=');
                if let (Some(key), Some(value)) = (parts.next(), parts.next()) {
                    if key == "token" {
                        let trimmed = value.trim();
                        if !trimmed.is_empty() {
                            warn!(
                                "[Webhooks] Query-param token auth is deprecated; \
                                 use Authorization header instead"
                            );
                            return Some(trimmed.to_string());
                        }
                    }
                }
            }
        }
    }

    None
}

/// Validate an incoming request token against the expected value.
///
/// Uses constant-time comparison to prevent timing attacks.
pub fn validate_token(req: &RequestParts, expected_token: &str) -> bool {
    let provided = match extract_token(req) {
        Some(t) => t,
        None => return false,
    };

    constant_time_eq(provided.as_bytes(), expected_token.as_bytes())
}

/// Constant-time byte-slice comparison.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ── Unit tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn req_with_header(key: &str, value: &str) -> RequestParts {
        let mut headers = HashMap::new();
        headers.insert(key.to_string(), vec![value.to_string()]);
        RequestParts {
            headers,
            ..Default::default()
        }
    }

    #[test]
    fn extracts_from_bearer_header() {
        let req = req_with_header("authorization", "Bearer my-secret-token");
        assert_eq!(extract_token(&req), Some("my-secret-token".into()));
    }

    #[test]
    fn extracts_from_x_otto_token_header() {
        let req = req_with_header("x-otto-token", "my-token");
        assert_eq!(extract_token(&req), Some("my-token".into()));
    }

    #[test]
    fn extracts_from_query_param() {
        let req = RequestParts {
            url: Some("http://localhost/hooks/wake?token=query-tok".into()),
            ..Default::default()
        };
        assert_eq!(extract_token(&req), Some("query-tok".into()));
    }

    #[test]
    fn prefers_authorization_over_x_otto_token() {
        let mut headers = HashMap::new();
        headers.insert(
            "authorization".to_string(),
            vec!["Bearer bearer-tok".to_string()],
        );
        headers.insert("x-otto-token".to_string(), vec!["header-tok".to_string()]);
        let req = RequestParts {
            headers,
            ..Default::default()
        };
        assert_eq!(extract_token(&req), Some("bearer-tok".into()));
    }

    #[test]
    fn returns_none_when_no_token_present() {
        let req = RequestParts::default();
        assert_eq!(extract_token(&req), None);
    }

    #[test]
    fn validate_returns_true_for_matching_token() {
        let req = req_with_header("authorization", "Bearer correct-token");
        assert!(validate_token(&req, "correct-token"));
    }

    #[test]
    fn validate_returns_false_for_wrong_token() {
        let req = req_with_header("authorization", "Bearer wrong-token");
        assert!(!validate_token(&req, "correct-token"));
    }

    #[test]
    fn validate_returns_false_for_missing_token() {
        let req = RequestParts::default();
        assert!(!validate_token(&req, "any-token"));
    }

    #[test]
    fn validate_returns_false_for_different_length_token() {
        let req = req_with_header("authorization", "Bearer short");
        assert!(!validate_token(&req, "much-longer-expected-token"));
    }

    #[test]
    fn extracts_from_query_dict() {
        let mut query = HashMap::new();
        query.insert("token".to_string(), "dict-tok".to_string());
        let req = RequestParts {
            query,
            ..Default::default()
        };
        assert_eq!(extract_token(&req), Some("dict-tok".into()));
    }

    #[test]
    fn trims_whitespace() {
        let req = req_with_header("authorization", "Bearer   padded-token  ");
        assert_eq!(extract_token(&req), Some("padded-token".into()));
    }
}
