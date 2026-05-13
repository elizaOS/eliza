// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! `notifications:write` handler.
//!
//! Posts a desktop notification. The cap-bus tries two transports in
//! order:
//!
//!   1. Shell out to `notify-send` if the binary is present. This lights
//!      up the swaync / mako / dunst surface running under sway.
//!   2. Otherwise POST a JSON body to elizad's `/api/notify` endpoint,
//!      which surfaces the message as a chat line — *"Your calendar
//!      said: <message>"* — so users without a notification daemon still
//!      see the event in their conversation with Eliza.
//!
//! Request shape:
//!
//! ```json
//! { "title": "Calendar", "message": "Standup in 5 minutes" }
//! ```
//!
//! Response shape (success):
//!
//! ```json
//! { "ok": true, "transport": "notify-send" }
//! // or
//! { "ok": true, "transport": "elizad-chat" }
//! ```

use std::time::Duration;

use serde::Deserialize;
use tracing::warn;

use crate::{Response, error_code};

use super::{rpc_error, rpc_ok};

/// Body for the `notifications:write` request.
#[derive(Debug, Deserialize)]
struct NotifyParams {
    /// Short summary line (the bold first line of the toast).
    title: String,
    /// Body text. Capped at 4 KB by the handler to keep the chat
    /// fallback from posting unbounded payloads through the agent HTTP
    /// surface.
    message: String,
}

/// Configuration the broker hands to the notifications handler.
///
/// Both fields are optional and have env-var fallbacks so the handler
/// is fully exercisable from unit tests without touching the host's
/// real notification daemon.
#[derive(Debug, Clone, Default)]
pub struct NotifyConfig {
    /// Absolute path to a `notify-send`-shaped binary. When `None`,
    /// the handler reads `USBELIZA_NOTIFY_SEND` from the environment;
    /// when that's unset, it tries `which notify-send`.
    pub notify_send: Option<String>,
    /// URL the chat-fallback transport POSTs to. When `None`, the
    /// handler reads `USBELIZA_NOTIFY_URL` from the environment;
    /// otherwise defaults to `http://127.0.0.1:41337/api/notify`.
    pub notify_url: Option<String>,
}

/// Async entry point — broker calls this when the method is
/// `notifications:write`. The slug is passed so the chat-fallback can
/// label the message ("Your calendar said: ..." for the calendar app,
/// etc).
pub async fn write(
    cfg: &NotifyConfig,
    slug: &str,
    id: serde_json::Value,
    params: Option<serde_json::Value>,
) -> Response {
    let Some(params) = params else {
        return rpc_error(id, error_code::INVALID_PARAMS, "missing params");
    };
    let mut params: NotifyParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(e) => return rpc_error(id, error_code::INVALID_PARAMS, &format!("bad params: {e}")),
    };
    if params.title.is_empty() {
        return rpc_error(id, error_code::INVALID_PARAMS, "title must not be empty");
    }
    // Cap message at 4 KB. Generated apps that try to post a megabyte
    // here are probably doing something the user didn't intend.
    if params.message.len() > 4096 {
        params.message.truncate(4096);
    }

    // Path 1: notify-send if available.
    if let Some(bin) = resolve_notify_send(cfg) {
        if try_notify_send(&bin, &params.title, &params.message).await {
            return rpc_ok(
                id,
                serde_json::json!({ "ok": true, "transport": "notify-send" }),
            );
        }
        warn!(slug, "notify-send invocation failed; falling back to elizad chat");
    }

    // Path 2: POST to elizad's /api/notify.
    let url = resolve_notify_url(cfg);
    match post_to_elizad(&url, slug, &params.title, &params.message).await {
        Ok(()) => rpc_ok(
            id,
            serde_json::json!({ "ok": true, "transport": "elizad-chat" }),
        ),
        Err(e) => rpc_error(
            id,
            error_code::INTERNAL_ERROR,
            &format!("notify failed: {e}"),
        ),
    }
}

fn resolve_notify_send(cfg: &NotifyConfig) -> Option<String> {
    if let Some(p) = &cfg.notify_send
        && !p.is_empty()
    {
        return Some(p.clone());
    }
    if let Ok(v) = std::env::var("USBELIZA_NOTIFY_SEND")
        && !v.is_empty()
    {
        return Some(v);
    }
    // Look for notify-send on PATH.
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            if dir.is_empty() {
                continue;
            }
            let candidate = std::path::Path::new(dir).join("notify-send");
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn resolve_notify_url(cfg: &NotifyConfig) -> String {
    if let Some(url) = &cfg.notify_url
        && !url.is_empty()
    {
        return url.clone();
    }
    if let Ok(v) = std::env::var("USBELIZA_NOTIFY_URL")
        && !v.is_empty()
    {
        return v;
    }
    "http://127.0.0.1:41337/api/notify".to_owned()
}

async fn try_notify_send(bin: &str, title: &str, message: &str) -> bool {
    let result = tokio::process::Command::new(bin)
        .arg("--")
        .arg(title)
        .arg(message)
        .status()
        .await;
    matches!(result, Ok(s) if s.success())
}

async fn post_to_elizad(url: &str, slug: &str, title: &str, message: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;
    let body = serde_json::json!({
        "slug": slug,
        "title": title,
        "message": message,
        // The phrasing elizad uses for the chat line, prebuilt so
        // future protocol-only consumers can render identically.
        "chat_line": format!("Your {slug} said: {message}"),
    });
    let response = client.post(url).json(&body).send().await?;
    if !response.status().is_success() {
        return Err(anyhow::anyhow!(
            "elizad /api/notify returned HTTP {}",
            response.status()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_params_returns_invalid_params() {
        let cfg = NotifyConfig::default();
        let resp = tokio_test_block(write(&cfg, "calendar", serde_json::json!(1), None));
        assert_eq!(resp.error.unwrap().code, error_code::INVALID_PARAMS);
    }

    #[test]
    fn empty_title_is_rejected() {
        let cfg = NotifyConfig::default();
        let resp = tokio_test_block(write(
            &cfg,
            "calendar",
            serde_json::json!(1),
            Some(serde_json::json!({ "title": "", "message": "hi" })),
        ));
        assert_eq!(resp.error.unwrap().code, error_code::INVALID_PARAMS);
    }

    #[test]
    fn shells_out_to_fake_notify_send_when_present() {
        // Build a tiny shell script that writes its argv to a file,
        // point the handler at it, and assert success + payload.
        let dir = mktemp("ns-success");
        let stub_path = dir.join("notify-send");
        let log_path = dir.join("argv.log");
        std::fs::write(
            &stub_path,
            format!(
                "#!/bin/sh\n# stub notify-send for tests\nprintf '%s\\n' \"$@\" > {log:?}\nexit 0\n",
                log = log_path
            ),
        )
        .unwrap();
        chmod_exec(&stub_path);

        let cfg = NotifyConfig {
            notify_send: Some(stub_path.to_string_lossy().into_owned()),
            notify_url: None,
        };
        let resp = tokio_test_block(write(
            &cfg,
            "calendar",
            serde_json::json!(1),
            Some(serde_json::json!({ "title": "T", "message": "M" })),
        ));
        assert!(resp.error.is_none(), "got error: {:?}", resp.error);
        assert_eq!(
            resp.result.unwrap()["transport"].as_str(),
            Some("notify-send")
        );
        let recorded = std::fs::read_to_string(&log_path).expect("argv log written");
        assert!(recorded.contains('T'));
        assert!(recorded.contains('M'));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn falls_back_to_elizad_when_notify_send_fails() {
        // Stub notify-send that exits non-zero; configured URL points
        // at a fake HTTP server that records the POST.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let url = format!("http://{addr}/api/notify");

            let received = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<u8>::new()));
            let received_clone = std::sync::Arc::clone(&received);
            tokio::spawn(async move {
                if let Ok((mut stream, _)) = listener.accept().await {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    received_clone.lock().await.extend_from_slice(&buf[..n]);
                    let _ = stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                        .await;
                }
            });

            let dir = mktemp("ns-fallback");
            let stub_path = dir.join("notify-send");
            std::fs::write(&stub_path, "#!/bin/sh\nexit 1\n").unwrap();
            chmod_exec(&stub_path);

            let cfg = NotifyConfig {
                notify_send: Some(stub_path.to_string_lossy().into_owned()),
                notify_url: Some(url),
            };
            let resp = write(
                &cfg,
                "calendar",
                serde_json::json!(1),
                Some(serde_json::json!({ "title": "T", "message": "Standup in 5 minutes" })),
            )
            .await;
            assert!(resp.error.is_none(), "fallback error: {:?}", resp.error);
            assert_eq!(
                resp.result.unwrap()["transport"].as_str(),
                Some("elizad-chat")
            );

            let body = String::from_utf8_lossy(&received.lock().await).to_string();
            assert!(body.contains("Standup in 5 minutes"));
            assert!(body.contains("Your calendar said:"));
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    // ─── helpers ───────────────────────────────────────────────────

    fn tokio_test_block<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    fn mktemp(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let dir = std::env::temp_dir().join(format!(
            "capbus-notify-{label}-{}-{nanos:x}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn chmod_exec(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).unwrap();
    }
}
