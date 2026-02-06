//! ZCA CLI client wrapper.

use crate::config::{DEFAULT_TIMEOUT_MS, ZCA_BINARY};
use crate::error::{Result, ZaloUserError};
use crate::types::{ZaloFriend, ZaloGroup, ZaloMessage, ZaloUserInfo};
use regex::Regex;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::{timeout, Duration};

/// Options for running ZCA commands.
#[derive(Debug, Clone, Default)]
pub struct ZcaRunOptions {
    /// Profile to use.
    pub profile: Option<String>,
    /// Working directory.
    pub cwd: Option<String>,
    /// Timeout in milliseconds.
    pub timeout_ms: Option<u64>,
}

/// Result from a ZCA command execution.
#[derive(Debug, Clone)]
pub struct ZcaResult {
    /// Whether the command succeeded.
    pub ok: bool,
    /// Standard output.
    pub stdout: String,
    /// Standard error.
    pub stderr: String,
    /// Exit code.
    pub exit_code: i32,
}

/// Build command arguments with profile flag.
fn build_args(args: &[&str], options: &ZcaRunOptions) -> Vec<String> {
    let mut result = Vec::new();

    // Profile flag comes first
    if let Some(ref profile) = options.profile {
        result.push("--profile".to_string());
        result.push(profile.clone());
    } else if let Ok(profile) = std::env::var("ZCA_PROFILE") {
        result.push("--profile".to_string());
        result.push(profile);
    }

    result.extend(args.iter().map(|s| s.to_string()));
    result
}

/// Run a ZCA CLI command.
pub async fn run_zca(args: &[&str], options: ZcaRunOptions) -> ZcaResult {
    let full_args = build_args(args, &options);
    let timeout_ms = options.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);

    let mut cmd = Command::new(ZCA_BINARY);
    cmd.args(&full_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(ref cwd) = options.cwd {
        cmd.current_dir(cwd);
    }

    let result = timeout(Duration::from_millis(timeout_ms), async {
        match cmd.output().await {
            Ok(output) => ZcaResult {
                ok: output.status.success(),
                stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
                exit_code: output.status.code().unwrap_or(1),
            },
            Err(e) => ZcaResult {
                ok: false,
                stdout: String::new(),
                stderr: e.to_string(),
                exit_code: 1,
            },
        }
    })
    .await;

    match result {
        Ok(r) => r,
        Err(_) => ZcaResult {
            ok: false,
            stdout: String::new(),
            stderr: "Command timed out".to_string(),
            exit_code: 124,
        },
    }
}

/// Strip ANSI escape codes from a string.
fn strip_ansi(s: &str) -> String {
    let re = Regex::new(r"\x1B\[[0-9;]*[a-zA-Z]").unwrap();
    re.replace_all(s, "").to_string()
}

/// Parse JSON from ZCA output, handling ANSI codes and log prefixes.
pub fn parse_json_output<T: serde::de::DeserializeOwned>(stdout: &str) -> Option<T> {
    // Try direct parse first
    if let Ok(parsed) = serde_json::from_str(stdout) {
        return Some(parsed);
    }

    // Try with ANSI stripped
    let cleaned = strip_ansi(stdout);
    if let Ok(parsed) = serde_json::from_str(&cleaned) {
        return Some(parsed);
    }

    // Try to find JSON in output (may have log prefixes)
    for line in cleaned.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            if let Ok(parsed) = serde_json::from_str(trimmed) {
                return Some(parsed);
            }
            // Try from this line to end
            let idx = cleaned.find(trimmed)?;
            let json_candidate = cleaned[idx..].trim();
            if let Ok(parsed) = serde_json::from_str(json_candidate) {
                return Some(parsed);
            }
        }
    }

    None
}

/// Check if zca-cli is installed.
pub async fn check_zca_installed() -> bool {
    let result = run_zca(
        &["--version"],
        ZcaRunOptions {
            timeout_ms: Some(5000),
            ..Default::default()
        },
    )
    .await;
    result.ok
}

/// Check if authenticated for a profile.
pub async fn check_zca_authenticated(profile: Option<&str>) -> bool {
    let result = run_zca(
        &["auth", "status"],
        ZcaRunOptions {
            profile: profile.map(|s| s.to_string()),
            timeout_ms: Some(5000),
            ..Default::default()
        },
    )
    .await;
    result.ok
}

/// Get authenticated user info.
pub async fn get_zca_user_info(profile: Option<&str>) -> Option<ZaloUserInfo> {
    let result = run_zca(
        &["me", "info", "-j"],
        ZcaRunOptions {
            profile: profile.map(|s| s.to_string()),
            timeout_ms: Some(10000),
            ..Default::default()
        },
    )
    .await;

    if !result.ok {
        return None;
    }

    parse_json_output(&result.stdout)
}

/// List friends.
pub async fn list_friends(profile: Option<&str>, query: Option<&str>) -> Vec<ZaloFriend> {
    let args: Vec<&str> = if let Some(q) = query.filter(|s| !s.trim().is_empty()) {
        vec!["friend", "find", q]
    } else {
        vec!["friend", "list", "-j"]
    };

    let result = run_zca(
        &args,
        ZcaRunOptions {
            profile: profile.map(|s| s.to_string()),
            timeout_ms: Some(15000),
            ..Default::default()
        },
    )
    .await;

    if !result.ok {
        return Vec::new();
    }

    parse_json_output(&result.stdout).unwrap_or_default()
}

/// List groups.
pub async fn list_groups(profile: Option<&str>) -> Vec<ZaloGroup> {
    let result = run_zca(
        &["group", "list", "-j"],
        ZcaRunOptions {
            profile: profile.map(|s| s.to_string()),
            timeout_ms: Some(15000),
            ..Default::default()
        },
    )
    .await;

    if !result.ok {
        return Vec::new();
    }

    parse_json_output(&result.stdout).unwrap_or_default()
}

/// Send a text message.
pub async fn send_message(
    thread_id: &str,
    text: &str,
    profile: Option<&str>,
    is_group: bool,
) -> Result<Option<String>> {
    if thread_id.trim().is_empty() {
        return Err(ZaloUserError::InvalidArgument(
            "No thread ID provided".to_string(),
        ));
    }

    let truncated = if text.len() > 2000 { &text[..2000] } else { text };
    let mut args = vec!["msg", "send", thread_id.trim(), truncated];
    if is_group {
        args.push("-g");
    }

    let result = run_zca(
        &args,
        ZcaRunOptions {
            profile: profile.map(|s| s.to_string()),
            ..Default::default()
        },
    )
    .await;

    if result.ok {
        Ok(extract_message_id(&result.stdout))
    } else {
        Err(ZaloUserError::SendFailed(
            if result.stderr.is_empty() { "Unknown error".to_string() } else { result.stderr.clone() },
        ))
    }
}

/// Send an image message.
pub async fn send_image(
    thread_id: &str,
    image_url: &str,
    caption: Option<&str>,
    profile: Option<&str>,
    is_group: bool,
) -> Result<Option<String>> {
    let mut args = vec!["msg", "image", thread_id.trim(), "-u", image_url.trim()];
    
    let caption_string: String;
    if let Some(cap) = caption {
        caption_string = if cap.len() > 2000 {
            cap[..2000].to_string()
        } else {
            cap.to_string()
        };
        args.push("-m");
        args.push(&caption_string);
    }
    
    if is_group {
        args.push("-g");
    }

    let result = run_zca(
        &args,
        ZcaRunOptions {
            profile: profile.map(|s| s.to_string()),
            ..Default::default()
        },
    )
    .await;

    if result.ok {
        Ok(extract_message_id(&result.stdout))
    } else {
        Err(ZaloUserError::SendFailed(
            if result.stderr.is_empty() { "Failed to send image".to_string() } else { result.stderr.clone() },
        ))
    }
}

/// Send a link message.
pub async fn send_link(
    thread_id: &str,
    url: &str,
    profile: Option<&str>,
    is_group: bool,
) -> Result<Option<String>> {
    let mut args = vec!["msg", "link", thread_id.trim(), url.trim()];
    if is_group {
        args.push("-g");
    }

    let result = run_zca(
        &args,
        ZcaRunOptions {
            profile: profile.map(|s| s.to_string()),
            ..Default::default()
        },
    )
    .await;

    if result.ok {
        Ok(extract_message_id(&result.stdout))
    } else {
        Err(ZaloUserError::SendFailed(
            if result.stderr.is_empty() { "Failed to send link".to_string() } else { result.stderr.clone() },
        ))
    }
}

/// Extract message ID from ZCA output.
fn extract_message_id(stdout: &str) -> Option<String> {
    // Try to match message_id pattern
    let re = Regex::new(r"message[_\s]?id[:\s]+(\S+)").ok()?;
    if let Some(caps) = re.captures(stdout) {
        return caps.get(1).map(|m| m.as_str().to_string());
    }

    // Return first word if it looks like an ID
    let first_word = stdout.trim().split_whitespace().next()?;
    let id_re = Regex::new(r"^[a-zA-Z0-9_-]+$").ok()?;
    if id_re.is_match(first_word) {
        return Some(first_word.to_string());
    }

    None
}

/// Message listener callback type.
pub type MessageCallback = Box<dyn Fn(ZaloMessage) + Send + Sync>;

/// Start listening for messages (streaming).
pub async fn start_message_listener(
    profile: Option<&str>,
    on_message: MessageCallback,
) -> Result<tokio::task::JoinHandle<()>> {
    let full_args = build_args(
        &["listen", "-j"],
        &ZcaRunOptions {
            profile: profile.map(|s| s.to_string()),
            ..Default::default()
        },
    );

    let mut cmd = Command::new(ZCA_BINARY);
    cmd.args(&full_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| ZaloUserError::CommandFailed(e.to_string()))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ZaloUserError::CommandFailed("Failed to capture stdout".to_string()))?;

    let handle = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(msg) = parse_json_output::<ZaloMessage>(&line) {
                on_message(msg);
            }
        }
    });

    Ok(handle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_ansi() {
        let input = "\x1B[32mHello\x1B[0m World";
        assert_eq!(strip_ansi(input), "Hello World");
    }

    #[test]
    fn test_extract_message_id() {
        assert_eq!(
            extract_message_id("message_id: abc123"),
            Some("abc123".to_string())
        );
        assert_eq!(
            extract_message_id("msgid: xyz789"),
            None
        );
        assert_eq!(extract_message_id("abc123"), Some("abc123".to_string()));
    }

    #[test]
    fn test_build_args() {
        let options = ZcaRunOptions {
            profile: Some("test".to_string()),
            ..Default::default()
        };
        let args = build_args(&["auth", "status"], &options);
        assert_eq!(args, vec!["--profile", "test", "auth", "status"]);
    }
}
