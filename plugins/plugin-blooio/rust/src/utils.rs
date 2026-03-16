use hmac::{Hmac, Mac};
use regex::Regex;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/// Validate an E.164 phone number (e.g. `+15551234567`).
pub fn validate_phone(phone: &str) -> bool {
    let re = Regex::new(r"^\+\d{1,15}$").unwrap();
    re.is_match(phone)
}

/// Validate an email address.
pub fn validate_email(email: &str) -> bool {
    let re = Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").unwrap();
    re.is_match(email)
}

/// Validate a Blooio group identifier (e.g. `grp_abc123`).
pub fn validate_group_id(id: &str) -> bool {
    let re = Regex::new(r"^grp_[A-Za-z0-9]+$").unwrap();
    re.is_match(id)
}

/// Validate a chat identifier which may be a comma-separated list of phones,
/// emails, or group IDs.
pub fn validate_chat_id(id: &str) -> bool {
    let parts: Vec<&str> = id
        .split(',')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();

    if parts.is_empty() {
        return false;
    }

    parts
        .iter()
        .all(|part| validate_phone(part) || validate_email(part) || validate_group_id(part))
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

/// Verify a Blooio webhook signature.
///
/// The `signature` can be in header format (`t=<timestamp>,v1=<hex>`) or a raw
/// hex HMAC-SHA256 digest.  The function computes the expected HMAC and performs
/// a constant-time comparison.
pub fn verify_webhook_signature(payload: &[u8], signature: &str, secret: &str) -> bool {
    let parsed = parse_signature_header(signature);
    let (msg_bytes, sig_hex) = match parsed {
        Some((ts, sig)) => {
            let msg = format!("{}.{}", ts, String::from_utf8_lossy(payload));
            (msg.into_bytes(), sig)
        }
        None => (payload.to_vec(), signature.to_string()),
    };

    let sig_bytes = match hex::decode(&sig_hex) {
        Ok(b) => b,
        Err(_) => return false,
    };

    let mut mac = match HmacSha256::new_from_slice(secret.as_bytes()) {
        Ok(m) => m,
        Err(_) => return false,
    };
    mac.update(&msg_bytes);
    mac.verify_slice(&sig_bytes).is_ok()
}

/// Parse a signature header of the form `t=<timestamp>,v1=<hex_signature>`.
fn parse_signature_header(header: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = header.split(',').map(|p| p.trim()).collect();
    let timestamp = parts
        .iter()
        .find(|p| p.starts_with("t="))?
        .strip_prefix("t=")?;
    let sig = parts
        .iter()
        .find(|p| p.starts_with("v1="))?
        .strip_prefix("v1=")?;
    if timestamp.is_empty() || sig.is_empty() {
        return None;
    }
    Some((timestamp.to_string(), sig.to_string()))
}

// ---------------------------------------------------------------------------
// URL extraction
// ---------------------------------------------------------------------------

/// Extract unique HTTP/HTTPS URLs from the given text.
pub fn extract_urls(text: &str) -> Vec<String> {
    let re = Regex::new(r"https?://[^\s)]+").unwrap();
    let mut urls: Vec<String> = Vec::new();
    for m in re.find_iter(text) {
        let url = m.as_str().to_string();
        if !urls.contains(&url) {
            urls.push(url);
        }
    }
    urls
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_basic() {
        assert!(validate_phone("+15551234567"));
        assert!(!validate_phone("15551234567"));
    }

    #[test]
    fn email_basic() {
        assert!(validate_email("a@b.c"));
        assert!(!validate_email("abc"));
    }

    #[test]
    fn group_basic() {
        assert!(validate_group_id("grp_abc123"));
        assert!(!validate_group_id("grp_"));
    }
}
