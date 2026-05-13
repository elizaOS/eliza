// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! `network:fetch` handler.
//!
//! Performs an HTTP(S) GET or POST against a host the app declared in
//! its manifest's `Capability::NetworkFetch { allowlist }`. The
//! allowlist is enforced by the cap-bus, *not* the app — even if the
//! app's URL is parsed correctly client-side, the broker re-validates
//! the host before opening a socket.
//!
//! Request shape:
//!
//! ```json
//! {
//!   "method": "GET",                        // optional, default "GET"
//!   "url": "https://api.example.com/v1/x",
//!   "headers": { "Accept": "application/json" },  // optional
//!   "body": "..."                           // optional, POST/PUT
//! }
//! ```
//!
//! Response (success):
//!
//! ```json
//! {
//!   "status": 200,
//!   "headers": { "content-type": "..." },
//!   "body_b64": "...",
//!   "body_len": 1234
//! }
//! ```
//!
//! Response body is base64 because cap-bus frames are JSON and many
//! responses are binary. `body_len` is the raw byte length pre-encoding.
//! Responses larger than [`MAX_BODY_BYTES`] are rejected with
//! `INTERNAL_ERROR` to keep generated apps from being weaponized into
//! traffic amplifiers.

use std::collections::HashMap;
use std::time::Duration;

use serde::Deserialize;

use crate::{Response, error_code};

use super::{rpc_error, rpc_ok};

/// Maximum response body the handler will deliver. Exceeding this
/// returns an INTERNAL_ERROR. 5 MiB matches the spec; tests pin this
/// at a smaller value via the config to avoid 5MB allocations.
pub const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;

/// Per-app `network:fetch` config — the allowlist comes straight from
/// the manifest's `Capability::NetworkFetch { allowlist }`.
#[derive(Debug, Clone, Default)]
pub struct NetworkConfig {
    /// Hostnames the app may reach. Matched exactly against
    /// `url::host_str()` — no subdomain wildcards, no IP fallback.
    pub allowlist: Vec<String>,
    /// Override `MAX_BODY_BYTES` for tests. Production leaves this
    /// `None` so the constant applies.
    pub max_body_bytes: Option<usize>,
    /// Request timeout. Defaults to 10 s when `None`.
    pub timeout: Option<Duration>,
}

#[derive(Debug, Deserialize)]
struct FetchParams {
    #[serde(default = "default_method")]
    method: String,
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: Option<String>,
}

fn default_method() -> String {
    "GET".to_owned()
}

/// Async entry point — broker calls this when the method is
/// `network:fetch`. Returns INVALID_PARAMS if the request shape is bad,
/// CAPABILITY_NOT_GRANTED if the host isn't allowlisted, INTERNAL_ERROR
/// for HTTP/network failures or oversized responses.
pub async fn fetch(
    cfg: &NetworkConfig,
    id: serde_json::Value,
    params: Option<serde_json::Value>,
) -> Response {
    let Some(params) = params else {
        return rpc_error(id, error_code::INVALID_PARAMS, "missing params");
    };
    let params: FetchParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(e) => return rpc_error(id, error_code::INVALID_PARAMS, &format!("bad params: {e}")),
    };

    // Parse url first so we can validate the host.
    let parsed = match reqwest::Url::parse(&params.url) {
        Ok(u) => u,
        Err(e) => return rpc_error(id, error_code::INVALID_PARAMS, &format!("bad url: {e}")),
    };
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return rpc_error(
            id,
            error_code::INVALID_PARAMS,
            "only http and https are allowed",
        );
    }
    let host = match parsed.host_str() {
        Some(h) => h,
        None => return rpc_error(id, error_code::INVALID_PARAMS, "url has no host"),
    };
    if !host_in_allowlist(host, &cfg.allowlist) {
        return rpc_error(
            id,
            error_code::CAPABILITY_NOT_GRANTED,
            &format!(
                "host {host:?} not in app manifest's network:fetch allowlist"
            ),
        );
    }

    // Build client + request.
    let timeout = cfg.timeout.unwrap_or_else(|| Duration::from_secs(10));
    let client = match reqwest::Client::builder().timeout(timeout).build() {
        Ok(c) => c,
        Err(e) => {
            return rpc_error(
                id,
                error_code::INTERNAL_ERROR,
                &format!("http client init failed: {e}"),
            );
        }
    };

    let method = params.method.to_uppercase();
    let mut req = match method.as_str() {
        "GET" => client.get(parsed),
        "POST" => client.post(parsed),
        "PUT" => client.put(parsed),
        "DELETE" => client.delete(parsed),
        "HEAD" => client.head(parsed),
        other => {
            return rpc_error(
                id,
                error_code::INVALID_PARAMS,
                &format!("unsupported method: {other}"),
            );
        }
    };
    for (k, v) in &params.headers {
        req = req.header(k, v);
    }
    if let Some(body) = params.body {
        req = req.body(body);
    }

    let response = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return rpc_error(
                id,
                error_code::INTERNAL_ERROR,
                &format!("http request failed: {e}"),
            );
        }
    };

    let status = response.status().as_u16();
    let mut headers: HashMap<String, String> = HashMap::new();
    for (k, v) in response.headers() {
        if let Ok(s) = v.to_str() {
            headers.insert(k.as_str().to_lowercase(), s.to_owned());
        }
    }

    // Pull the body, enforcing the max size pre-decode. reqwest's
    // `bytes()` allocates a single Vec, so we just check length.
    let bytes = match response.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return rpc_error(
                id,
                error_code::INTERNAL_ERROR,
                &format!("http body read failed: {e}"),
            );
        }
    };
    let max = cfg.max_body_bytes.unwrap_or(MAX_BODY_BYTES);
    if bytes.len() > max {
        return rpc_error(
            id,
            error_code::INTERNAL_ERROR,
            &format!(
                "response body {} bytes exceeds limit of {max}",
                bytes.len()
            ),
        );
    }

    rpc_ok(
        id,
        serde_json::json!({
            "status": status,
            "headers": headers,
            "body_b64": b64_encode(&bytes),
            "body_len": bytes.len(),
        }),
    )
}

/// Exact match against the allowlist; no wildcards or suffix matches.
#[must_use]
pub fn host_in_allowlist(host: &str, allowlist: &[String]) -> bool {
    allowlist.iter().any(|allowed| allowed == host)
}

/// Minimal base64 encoder. Pulling base64 as a dep just for the response
/// body is overkill; this is the standard RFC 4648 alphabet with `=`
/// padding.
fn b64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let chunks = bytes.chunks(3);
    for chunk in chunks {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };
        let n = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        out.push(ALPHABET[((n >> 18) & 0x3F) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((n >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(n & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn host_allowlist_is_exact_no_wildcards() {
        let allow = vec!["api.example.com".to_owned()];
        assert!(host_in_allowlist("api.example.com", &allow));
        assert!(!host_in_allowlist("evil.example.com", &allow));
        assert!(!host_in_allowlist("evil.api.example.com", &allow));
        assert!(!host_in_allowlist("example.com", &allow));
        // Empty allowlist denies everything.
        assert!(!host_in_allowlist("api.example.com", &[]));
    }

    #[test]
    fn b64_known_vectors() {
        assert_eq!(b64_encode(b""), "");
        assert_eq!(b64_encode(b"f"), "Zg==");
        assert_eq!(b64_encode(b"fo"), "Zm8=");
        assert_eq!(b64_encode(b"foo"), "Zm9v");
        assert_eq!(b64_encode(b"foob"), "Zm9vYg==");
    }

    #[tokio::test]
    async fn rejects_host_not_in_allowlist() {
        let cfg = NetworkConfig {
            allowlist: vec!["allowed.example.com".into()],
            max_body_bytes: None,
            timeout: None,
        };
        let resp = fetch(
            &cfg,
            serde_json::json!(1),
            Some(serde_json::json!({
                "url": "https://blocked.example.com/x"
            })),
        )
        .await;
        let err = resp.error.expect("error");
        assert_eq!(err.code, error_code::CAPABILITY_NOT_GRANTED);
    }

    #[tokio::test]
    async fn rejects_non_http_scheme() {
        let cfg = NetworkConfig {
            allowlist: vec!["evil".into()],
            ..NetworkConfig::default()
        };
        let resp = fetch(
            &cfg,
            serde_json::json!(1),
            Some(serde_json::json!({ "url": "file:///etc/passwd" })),
        )
        .await;
        let err = resp.error.expect("error");
        assert_eq!(err.code, error_code::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn rejects_missing_params() {
        let cfg = NetworkConfig::default();
        let resp = fetch(&cfg, serde_json::json!(1), None).await;
        assert_eq!(resp.error.unwrap().code, error_code::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn rejects_malformed_url() {
        let cfg = NetworkConfig {
            allowlist: vec!["x".into()],
            ..NetworkConfig::default()
        };
        let resp = fetch(
            &cfg,
            serde_json::json!(1),
            Some(serde_json::json!({ "url": "not a url" })),
        )
        .await;
        assert_eq!(resp.error.unwrap().code, error_code::INVALID_PARAMS);
    }

    /// Spin up a tiny TCP server that speaks just enough HTTP/1.1 to
    /// serve a canned body, run a real `fetch()` against it, and
    /// verify body_b64 round-trips.
    #[tokio::test]
    async fn fetches_allowlisted_host_against_local_http_server() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}/hello");

        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf).await;
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello",
                    )
                    .await;
            }
        });

        let cfg = NetworkConfig {
            allowlist: vec!["127.0.0.1".into()],
            max_body_bytes: None,
            timeout: Some(Duration::from_secs(5)),
        };
        let resp = fetch(
            &cfg,
            serde_json::json!(1),
            Some(serde_json::json!({ "url": url })),
        )
        .await;
        assert!(resp.error.is_none(), "fetch error: {:?}", resp.error);
        let result = resp.result.unwrap();
        assert_eq!(result["status"].as_u64(), Some(200));
        assert_eq!(result["body_len"].as_u64(), Some(5));
        assert_eq!(result["body_b64"].as_str(), Some("aGVsbG8="));
    }

    /// Send a body larger than the configured cap and assert
    /// INTERNAL_ERROR.
    #[tokio::test]
    async fn rejects_response_body_over_limit() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}/big");

        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf).await;
                let body = "x".repeat(200);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });

        let cfg = NetworkConfig {
            allowlist: vec!["127.0.0.1".into()],
            // Cap at 50 bytes so the 200-byte body trips the limit.
            max_body_bytes: Some(50),
            timeout: Some(Duration::from_secs(5)),
        };
        let resp = fetch(
            &cfg,
            serde_json::json!(1),
            Some(serde_json::json!({ "url": url })),
        )
        .await;
        let err = resp.error.expect("error");
        assert_eq!(err.code, error_code::INTERNAL_ERROR);
        assert!(err.message.contains("exceeds limit"));
    }
}
