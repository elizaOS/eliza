// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! `elizad` — the Tauri shell process.
//!
//! Wires the chat UI to a supervised Bun-hosted `eliza-agent` subprocess.
//! Phase 0 milestone #10 covered: splash-chat boot path, agent supervisor,
//! calibration persistence (`~/.eliza/calibration.toml`), chat round-trip.
//! Sandbox launcher and per-app cap-bus broker land in milestone #11.

#![deny(missing_docs)]

mod agent_supervisor;
// calibration_store module deleted in v10 — the agent (Bun side) owns
// ~/.eliza/calibration.toml entirely now. Keep `eliza_types::CalibrationProfile`
// in the type crate so app launchers can still read the file as metadata.
mod cap_bus;
mod sandbox_launcher;

use std::sync::{Arc, Mutex};

use tauri::Manager;
use tracing_subscriber::{EnvFilter, fmt};

use crate::agent_supervisor::{AGENT_PORT, child_slot};
use crate::sandbox_launcher::{LaunchRegistry, registry as launch_registry};

/// State shared across Tauri commands. The agent-status mutex is the heart of
/// the splash-chat contract — the UI polls it (via the `agent_status` command)
/// to decide whether messages submit immediately or queue for replay.
pub struct AppState {
    /// Latest known agent state, written by the supervisor task. Wrapped in
    /// `Arc<Mutex<>>` so the supervisor can mutate it from outside Tauri's
    /// state machinery.
    pub agent_status: Arc<Mutex<AgentStatus>>,
    /// HTTP client reused for every chat round-trip; cheaper than rebuilding.
    pub http: reqwest::Client,
    /// Per-app launch registry: tracks the bubblewrap child + cap-bus server
    /// for each running generated app.
    pub launches: Arc<LaunchRegistry>,
}

impl AppState {
    fn new() -> Self {
        Self {
            agent_status: Arc::new(Mutex::new(AgentStatus::default())),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_mins(1))
                .build()
                .expect("build reqwest client"),
            launches: launch_registry(),
        }
    }
}

/// Coarse agent supervisor states surfaced to the UI.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    /// The Bun subprocess hasn't yet returned `/api/status` ready.
    #[default]
    Booting,
    /// Agent is up and accepting traffic on `127.0.0.1:41337`.
    Ready,
    /// Agent crashed; supervisor will restart with backoff.
    Crashed,
}

// ------- Tauri commands -------
//
// `tauri::State` is required by-value by the `#[tauri::command]` codegen.
// All commands return `Result<_, String>` because Tauri serializes the error
// straight into the UI; opaque error chains aren't useful to a JS caller.

/// Probe the agent supervisor's most recent state.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn agent_status(state: tauri::State<'_, AppState>) -> AgentStatus {
    let guard = state
        .agent_status
        .lock()
        .expect("agent_status lock poisoned");
    *guard
}

/// Send a chat message to the agent and return the full `ChatResponse`.
///
/// Forwards the agent's structured reply (with optional `launch`) straight
/// to the UI so it can react to launch hints without a second round-trip.
/// Errors are short, human-readable strings the UI surfaces verbatim.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
async fn chat(
    state: tauri::State<'_, AppState>,
    message: String,
) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{AGENT_PORT}/api/chat");
    let response = state
        .http
        .post(&url)
        .json(&serde_json::json!({ "message": message }))
        .send()
        .await
        .map_err(|e| format!("could not reach agent: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("agent returned HTTP {}", response.status()));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("agent reply was not JSON: {e}"))
}

// load_calibration / save_calibration Tauri commands deleted in v10. The
// agent (Bun, agent/src/onboarding/state.ts) is now the single source of
// truth for ~/.eliza/calibration.toml writes — it persists answers as the
// state machine advances. The UI never touches the file; it just renders
// chat turns. The on-disk shape is unchanged and `eliza_types::CalibrationProfile`
// is still used by the launcher to read pre-launch metadata for app windows.

/// Launch a generated app in a bubblewrap-sandboxed window.
///
/// Reads `~/.eliza/apps/<slug>/manifest.json`, validates it, spawns the
/// per-app cap-bus broker, and runs `bwrap … chromium --app=file://…`.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
async fn launch_app(state: tauri::State<'_, AppState>, slug: String) -> Result<(), String> {
    sandbox_launcher::launch(&state.launches, &slug)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Stop a running app and tear down its cap-bus.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
async fn stop_app(state: tauri::State<'_, AppState>, slug: String) -> Result<(), String> {
    sandbox_launcher::stop(&state.launches, &slug)
        .await
        .map_err(|e| format!("{e:#}"))
}

fn main() {
    fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_target(false)
        .compact()
        .init();

    tauri::Builder::default()
        .manage(AppState::new())
        .setup(|app| {
            let state = app.state::<AppState>();
            let status_arc = Arc::clone(&state.agent_status);
            let child = child_slot();
            tauri::async_runtime::spawn(async move {
                agent_supervisor::run(status_arc, child).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_status,
            chat,
            launch_app,
            stop_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_status_serializes_all_variants_as_lowercase_strings() {
        // Lock the wire shape so the chat UI's status check stays stable.
        for (status, expected) in [
            (AgentStatus::Booting, "\"booting\""),
            (AgentStatus::Ready, "\"ready\""),
            (AgentStatus::Crashed, "\"crashed\""),
        ] {
            assert_eq!(serde_json::to_string(&status).unwrap(), expected);
        }
    }

    #[test]
    fn app_state_default_status_is_booting() {
        let state = AppState::new();
        let status = *state.agent_status.lock().unwrap();
        assert_eq!(status, AgentStatus::Booting);
    }
}
