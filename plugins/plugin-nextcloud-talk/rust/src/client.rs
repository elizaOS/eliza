use hmac::{Hmac, Mac};
use rand::Rng;
use sha2::Sha256;

use crate::error::{NextcloudTalkError, Result};
use crate::types::{
    NextcloudTalkInboundMessage, NextcloudTalkSendResult, NextcloudTalkWebhookHeaders,
    NextcloudTalkWebhookPayload,
};

type HmacSha256 = Hmac<Sha256>;

/// Verify the HMAC-SHA256 signature of an incoming webhook request.
/// Signature is calculated as: HMAC-SHA256(random + body, secret)
pub fn verify_signature(signature: &str, random: &str, body: &str, secret: &str) -> bool {
    if signature.is_empty() || random.is_empty() || secret.is_empty() {
        return false;
    }

    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC can take key of any size");
    mac.update(random.as_bytes());
    mac.update(body.as_bytes());

    let expected = hex::encode(mac.finalize().into_bytes());

    // Constant-time comparison
    if signature.len() != expected.len() {
        return false;
    }

    let mut result = 0u8;
    for (a, b) in signature.bytes().zip(expected.bytes()) {
        result |= a ^ b;
    }
    result == 0
}

/// Generate signature headers for an outbound request to Nextcloud Talk.
pub fn generate_signature(body: &str, secret: &str) -> (String, String) {
    let mut rng = rand::thread_rng();
    let random_bytes: [u8; 32] = rng.gen();
    let random = hex::encode(random_bytes);

    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC can take key of any size");
    mac.update(random.as_bytes());
    mac.update(body.as_bytes());
    let signature = hex::encode(mac.finalize().into_bytes());

    (random, signature)
}

/// Extract webhook headers from an HTTP request.
pub fn extract_webhook_headers(
    headers: &[(String, String)],
) -> Option<NextcloudTalkWebhookHeaders> {
    let mut signature = None;
    let mut random = None;
    let mut backend = None;

    for (key, value) in headers {
        let key_lower = key.to_lowercase();
        match key_lower.as_str() {
            "x-nextcloud-talk-signature" => signature = Some(value.clone()),
            "x-nextcloud-talk-random" => random = Some(value.clone()),
            "x-nextcloud-talk-backend" => backend = Some(value.clone()),
            _ => {}
        }
    }

    match (signature, random, backend) {
        (Some(sig), Some(rnd), Some(back)) => Some(NextcloudTalkWebhookHeaders {
            signature: sig,
            random: rnd,
            backend: back,
        }),
        _ => None,
    }
}

/// Parse the webhook payload into an inbound message.
pub fn parse_webhook_payload(payload: &NextcloudTalkWebhookPayload) -> NextcloudTalkInboundMessage {
    NextcloudTalkInboundMessage {
        message_id: payload.object.id.clone(),
        room_token: payload.target.id.clone(),
        room_name: payload.target.name.clone(),
        sender_id: payload.actor.id.clone(),
        sender_name: payload.actor.name.clone(),
        text: payload.object.content.clone(),
        media_type: payload.object.media_type.clone(),
        timestamp: chrono::Utc::now().timestamp(),
        is_group_chat: false, // Will be determined by service based on room info
    }
}

/// Send a message to a Nextcloud Talk room.
pub async fn send_message(
    base_url: &str,
    secret: &str,
    room_token: &str,
    message: &str,
    reply_to: Option<&str>,
) -> Result<NextcloudTalkSendResult> {
    if message.trim().is_empty() {
        return Err(NextcloudTalkError::InvalidArgument(
            "Message must be non-empty".to_string(),
        ));
    }

    let mut body = serde_json::json!({
        "message": message.trim()
    });

    if let Some(reply_id) = reply_to {
        body["replyTo"] = serde_json::Value::String(reply_id.to_string());
    }

    let body_str = body.to_string();
    let (random, signature) = generate_signature(&body_str, secret);

    let url = format!(
        "{}/ocs/v2.php/apps/spreed/api/v1/bot/{}/message",
        base_url, room_token
    );

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("OCS-APIRequest", "true")
        .header("X-Nextcloud-Talk-Bot-Random", &random)
        .header("X-Nextcloud-Talk-Bot-Signature", &signature)
        .body(body_str)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();

        let error_msg = match status.as_u16() {
            400 => format!("Bad request: {}", error_body),
            401 => "Authentication failed - check bot secret".to_string(),
            403 => "Forbidden - bot may not have permission in this room".to_string(),
            404 => format!("Room not found (token={})", room_token),
            _ => format!("Send failed ({}): {}", status, error_body),
        };

        return Err(NextcloudTalkError::ApiError(error_msg));
    }

    let mut message_id = "unknown".to_string();
    let mut timestamp = None;

    if let Ok(data) = response.json::<serde_json::Value>().await {
        if let Some(id) = data["ocs"]["data"]["id"].as_i64() {
            message_id = id.to_string();
        } else if let Some(id) = data["ocs"]["data"]["id"].as_str() {
            message_id = id.to_string();
        }
        if let Some(ts) = data["ocs"]["data"]["timestamp"].as_i64() {
            timestamp = Some(ts);
        }
    }

    Ok(NextcloudTalkSendResult {
        message_id,
        room_token: room_token.to_string(),
        timestamp,
    })
}

/// Send a reaction to a message in Nextcloud Talk.
pub async fn send_reaction(
    base_url: &str,
    secret: &str,
    room_token: &str,
    message_id: &str,
    reaction: &str,
) -> Result<()> {
    let body = serde_json::json!({
        "reaction": reaction
    });
    let body_str = body.to_string();

    let (random, signature) = generate_signature(&body_str, secret);

    let url = format!(
        "{}/ocs/v2.php/apps/spreed/api/v1/bot/{}/reaction/{}",
        base_url, room_token, message_id
    );

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("OCS-APIRequest", "true")
        .header("X-Nextcloud-Talk-Bot-Random", &random)
        .header("X-Nextcloud-Talk-Bot-Signature", &signature)
        .body(body_str)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();
        return Err(NextcloudTalkError::ApiError(format!(
            "Reaction failed: {} {}",
            status,
            error_body
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_verify_signature() {
        let secret = "test_secret";
        let body = r#"{"message":"Hello"}"#;
        let (random, signature) = generate_signature(body, secret);

        assert!(verify_signature(&signature, &random, body, secret));
        assert!(!verify_signature(&signature, &random, body, "wrong_secret"));
        assert!(!verify_signature(&signature, "wrong_random", body, secret));
    }

    #[test]
    fn test_generate_signature() {
        let secret = "test_secret";
        let body = r#"{"message":"Hello"}"#;

        let (random1, sig1) = generate_signature(body, secret);
        let (random2, sig2) = generate_signature(body, secret);

        // Random should be different each time
        assert_ne!(random1, random2);
        // Signatures should be different because random is different
        assert_ne!(sig1, sig2);

        // But both should verify correctly
        assert!(verify_signature(&sig1, &random1, body, secret));
        assert!(verify_signature(&sig2, &random2, body, secret));
    }

    #[test]
    fn test_extract_webhook_headers() {
        let headers = vec![
            (
                "X-Nextcloud-Talk-Signature".to_string(),
                "abc123".to_string(),
            ),
            ("X-Nextcloud-Talk-Random".to_string(), "random123".to_string()),
            (
                "X-Nextcloud-Talk-Backend".to_string(),
                "https://cloud.example.com".to_string(),
            ),
        ];

        let result = extract_webhook_headers(&headers);
        assert!(result.is_some());

        let headers = result.unwrap();
        assert_eq!(headers.signature, "abc123");
        assert_eq!(headers.random, "random123");
        assert_eq!(headers.backend, "https://cloud.example.com");
    }

    #[test]
    fn test_extract_webhook_headers_missing() {
        let headers = vec![("X-Nextcloud-Talk-Signature".to_string(), "abc123".to_string())];

        let result = extract_webhook_headers(&headers);
        assert!(result.is_none());
    }
}
