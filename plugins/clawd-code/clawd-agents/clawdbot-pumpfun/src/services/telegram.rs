use reqwest::Client;

pub struct TelegramNotifier;

impl TelegramNotifier {
    /// Send a Telegram message using TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from env.
    /// If variables are missing, this is a no-op.
    pub async fn send_message(message: impl Into<String>) -> Result<(), String> {
        let token = std::env::var("TELEGRAM_BOT_TOKEN").unwrap_or_default();
        let chat_id = std::env::var("TELEGRAM_CHAT_ID").unwrap_or_default();

        if token.is_empty() || chat_id.is_empty() {
            eprintln!("[TELEGRAM] Skipping send: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set");
            return Ok(());
        }

        let url = format!("https://api.telegram.org/bot{}/sendMessage", token);
        let text = message.into();

        let client = Client::new();
        eprintln!("[TELEGRAM] Sending message to chat {}", chat_id);
        let resp = client
            .post(&url)
            .json(&serde_json::json!({
                "chat_id": chat_id,
                "text": text
            }))
            .send()
            .await
            .map_err(|e| format!("Telegram send error: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            eprintln!("[TELEGRAM] Send failed: status={} body={}", status, body);
            return Err(format!("Telegram send failed with status {}", status));
        }
        eprintln!("[TELEGRAM] Message sent successfully");

        Ok(())
    }
}


