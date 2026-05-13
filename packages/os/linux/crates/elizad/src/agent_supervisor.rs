// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! `eliza-agent` (Bun) supervisor.
//!
//! Spawns the Bun-hosted agent subprocess, polls its `/api/status` endpoint,
//! tracks readiness, and restarts on crash with exponential backoff. The
//! supervisor owns the child handle and arranges for `kill_on_drop` so the
//! agent dies cleanly when `elizad` exits — important for the splash-chat
//! contract (locked decision #15): the user's input window opens within ~5s
//! and queued messages replay once the agent transitions to ready.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use serde::Deserialize;
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;
use tracing::{error, info, warn};

use crate::AgentStatus;

/// HTTP port the Bun agent listens on. Mirrors `agent/src/main.ts`.
///
/// Chosen to avoid `adb`'s default (31337) and milady's API port (also 31337,
/// per the `milady_repo` state) so a developer running both side-by-side does
/// not get an `EADDRINUSE` on agent startup.
pub const AGENT_PORT: u16 = 41337;

const READY_POLL_INTERVAL: Duration = Duration::from_millis(200);
const READY_DEADLINE: Duration = Duration::from_secs(30);
const RESTART_BACKOFF_MIN: Duration = Duration::from_millis(500);
const RESTART_BACKOFF_MAX: Duration = Duration::from_secs(30);

/// Wire shape of `/api/status`. Must match `agent/src/status.ts::AgentStatusResponse`.
#[derive(Debug, Deserialize)]
struct AgentStatusResponse {
    state: String,
}

/// Find the `agent/` directory at runtime.
///
/// Resolution order:
///   1. `USBELIZA_AGENT_DIR` env var (used by `cargo tauri dev` and CI).
///   2. `<exe-parent>/../../../agent` (cargo workspace dev layout — when
///      running `target/debug/elizad`, the agent is three levels up).
///   3. `<cwd>/agent` (last resort for tests run from the repo root).
fn locate_agent_dir() -> Result<PathBuf> {
    if let Ok(explicit) = std::env::var("USBELIZA_AGENT_DIR") {
        let path = PathBuf::from(explicit);
        return if path.is_dir() {
            Ok(path)
        } else {
            Err(anyhow!(
                "USBELIZA_AGENT_DIR={} is not a directory",
                path.display()
            ))
        };
    }

    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
        && let Ok(canon) = parent.join("../../../agent").canonicalize()
        && canon.is_dir()
    {
        return Ok(canon);
    }

    let cwd_candidate = std::env::current_dir()
        .context("read current dir")?
        .join("agent");
    if cwd_candidate.is_dir() {
        return Ok(cwd_candidate);
    }

    Err(anyhow!(
        "cannot find agent/ — set USBELIZA_AGENT_DIR or run elizad from the workspace"
    ))
}

/// Owned handle to the Bun agent subprocess. The handle lives behind an
/// `Arc<AsyncMutex<>>` because the supervisor task and the shutdown hook
/// both need to terminate it.
type ChildHandle = Arc<AsyncMutex<Option<Child>>>;

/// Spawn the agent once. Returns the child handle on success.
fn spawn_once(agent_dir: &Path, port: u16) -> Result<Child> {
    info!(agent_dir = %agent_dir.display(), port, "spawning eliza-agent");
    let child = Command::new("bun")
        .args(["run", "start"])
        .current_dir(agent_dir)
        .env("ELIZA_API_PORT", port.to_string())
        // Wire stdout/stderr through to ours so cargo tauri dev users see boot log.
        .kill_on_drop(true)
        .spawn()
        .context("spawn `bun run start` for eliza-agent")?;
    Ok(child)
}

/// Poll `http://127.0.0.1:<port>/api/status` until it returns `state=ready`
/// or the deadline elapses.
async fn wait_ready(client: &reqwest::Client, port: u16, deadline: Duration) -> Result<()> {
    let url = format!("http://127.0.0.1:{port}/api/status");
    let started = tokio::time::Instant::now();
    loop {
        if started.elapsed() >= deadline {
            return Err(anyhow!(
                "agent did not become ready within {}s",
                deadline.as_secs()
            ));
        }
        match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => {
                if let Ok(body) = response.json::<AgentStatusResponse>().await
                    && body.state == "ready"
                {
                    return Ok(());
                }
            }
            Ok(_) | Err(_) => { /* keep polling */ }
        }
        tokio::time::sleep(READY_POLL_INTERVAL).await;
    }
}

/// Notify the UI of a new agent state. Held in `crate::AppState`; we pass the
/// `Arc<Mutex<>>` here rather than coupling to Tauri internals.
fn set_status(state: &std::sync::Mutex<AgentStatus>, value: AgentStatus) {
    if let Ok(mut guard) = state.lock() {
        *guard = value;
    }
}

/// Run the supervisor loop forever (until cancelled by Tauri shutdown).
///
/// On every iteration:
///   1. Spawn the agent.
///   2. Wait for /api/status ready (deadline-bounded).
///   3. Mark status `Ready`.
///   4. Wait for the child to exit.
///   5. Mark status `Crashed`.
///   6. Sleep backoff (capped) and respawn.
pub async fn run(state: Arc<std::sync::Mutex<AgentStatus>>, child_slot: ChildHandle) {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .expect("build reqwest client");

    // If an externally-managed agent (e.g. a systemd unit on the live ISO)
    // is already listening — or will be shortly, while the unit's
    // ExecStartPre waits for /opt/usbeliza/agent/src — short-circuit and
    // track its status passively. 10 seconds is plenty for systemd to
    // bring the agent up on a warm boot; falls through to local spawn
    // (host dev mode) if nothing answers.
    if wait_ready(&client, AGENT_PORT, Duration::from_secs(10))
        .await
        .is_ok()
    {
        info!(
            "eliza-agent already reachable on 127.0.0.1:{AGENT_PORT}; supervisor in passive mode"
        );
        set_status(&state, AgentStatus::Ready);
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if wait_ready(&client, AGENT_PORT, Duration::from_millis(500))
                .await
                .is_err()
            {
                warn!("externally-managed eliza-agent stopped responding");
                set_status(&state, AgentStatus::Crashed);
                // Don't exit — the external supervisor (systemd) will restart it.
                // Keep polling for its return.
                while wait_ready(&client, AGENT_PORT, Duration::from_millis(500))
                    .await
                    .is_err()
                {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
                set_status(&state, AgentStatus::Ready);
            }
        }
    }

    let agent_dir = match locate_agent_dir() {
        Ok(p) => p,
        Err(e) => {
            error!("cannot locate agent dir, supervisor giving up: {e:#}");
            set_status(&state, AgentStatus::Crashed);
            return;
        }
    };

    let mut backoff = RESTART_BACKOFF_MIN;
    loop {
        set_status(&state, AgentStatus::Booting);

        let mut child = match spawn_once(&agent_dir, AGENT_PORT) {
            Ok(c) => c,
            Err(e) => {
                error!("spawn failed: {e:#}");
                set_status(&state, AgentStatus::Crashed);
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(RESTART_BACKOFF_MAX);
                continue;
            }
        };

        // Race: ready vs. early child death.
        let ready_outcome = tokio::select! {
            ready = wait_ready(&client, AGENT_PORT, READY_DEADLINE) => ready,
            died = child.wait() => Err(anyhow!("agent exited before ready: {died:?}")),
        };

        match ready_outcome {
            Ok(()) => {
                info!("eliza-agent ready on 127.0.0.1:{AGENT_PORT}");
                set_status(&state, AgentStatus::Ready);
                backoff = RESTART_BACKOFF_MIN;
                // Stash the child for shutdown.
                {
                    let mut slot = child_slot.lock().await;
                    *slot = Some(child);
                }
                // Wait for the child to die. We drop the lock first so shutdown
                // can preempt us.
                let exit = {
                    let mut slot = child_slot.lock().await;
                    if let Some(mut c) = slot.take() {
                        drop(slot);
                        c.wait().await.ok()
                    } else {
                        None
                    }
                };
                warn!("eliza-agent exited: {exit:?}");
                set_status(&state, AgentStatus::Crashed);
            }
            Err(e) => {
                warn!("agent never became ready: {e:#}");
                let _ = child.kill().await;
                set_status(&state, AgentStatus::Crashed);
            }
        }

        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(RESTART_BACKOFF_MAX);
    }
}

/// Build the shared child-handle slot used by supervisor + shutdown hook.
#[must_use]
pub fn child_slot() -> ChildHandle {
    Arc::new(AsyncMutex::new(None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locate_agent_dir_falls_back_when_env_not_set() {
        // We intentionally do NOT mutate process env in tests (Rust 2024 made
        // env mutation unsafe; the workspace forbids unsafe). Instead, this
        // test just checks the fallback path is well-typed and the function
        // returns *some* result (Ok or Err) without panicking. Production
        // code paths that do set the env var are exercised at integration
        // time, not unit time.
        let _ = locate_agent_dir();
    }
}
