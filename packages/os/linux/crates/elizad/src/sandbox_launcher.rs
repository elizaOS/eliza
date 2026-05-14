// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! Bubblewrap launcher and per-app supervisor.
//!
//! `launch_app(slug)` is the Tauri command that:
//!   1. Reads `~/.eliza/apps/<slug>/manifest.json`.
//!   2. Validates via `eliza_sandbox::validate`.
//!   3. Spawns a `eliza_cap_bus::server` for this app on
//!      `/run/eliza/cap-<slug>.sock`.
//!   4. Builds the `bwrap` argv via `eliza_sandbox::launcher::build`.
//!   5. Spawns the sandboxed browser child process.
//!   6. Tracks the (cap-server-handle, child) pair so shutdown / `stop_app`
//!      can clean both up.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use eliza_cap_bus::{ServerConfig, ServerHandle, spawn as spawn_cap_bus};
use eliza_sandbox::{
    launcher::{LaunchContext, build as build_bwrap},
    validate as validate_manifest,
};
use eliza_types::{Capability, Manifest};
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;
use tracing::{info, warn};

/// State for one running app: the cap-bus server + the bubblewrap child.
struct RunningApp {
    cap_bus: Option<ServerHandle>,
    child: Option<Child>,
}

/// Registry of running apps. One entry per slug. Held inside `AppState` and
/// shared with the Tauri command handlers.
#[derive(Default)]
pub struct LaunchRegistry {
    inner: AsyncMutex<HashMap<String, RunningApp>>,
}

impl LaunchRegistry {
    /// Build a fresh, empty registry.
    pub fn new() -> Self {
        Self::default()
    }
}

/// Where do we look up generated apps? Production: `~/.eliza/apps`. Tests
/// override via `USBELIZA_APPS_ROOT`.
fn apps_root() -> Result<PathBuf> {
    if let Ok(explicit) = std::env::var("USBELIZA_APPS_ROOT") {
        return Ok(PathBuf::from(explicit));
    }
    let dirs = directories::BaseDirs::new()
        .context("cannot resolve user home dir; set USBELIZA_APPS_ROOT")?;
    Ok(dirs.home_dir().join(".eliza").join("apps"))
}

/// Where does the per-app cap-bus socket live? Production:
/// `/run/eliza/cap-<slug>.sock`. Tests override via `USBELIZA_CAP_BUS_DIR`.
fn cap_bus_socket(slug: &str) -> PathBuf {
    if let Ok(explicit) = std::env::var("USBELIZA_CAP_BUS_DIR") {
        return PathBuf::from(explicit).join(format!("cap-{slug}.sock"));
    }
    PathBuf::from("/run/eliza").join(format!("cap-{slug}.sock"))
}

/// Locate a working chromium-class browser binary.
///
/// Honors `USBELIZA_BROWSER` if set; otherwise probes a small ordered list:
/// `chromium`, `chromium-browser`, `google-chrome`. The probe is by
/// `which`-style path search; failure means we can't launch a webview app.
fn locate_browser() -> Result<PathBuf> {
    if let Ok(explicit) = std::env::var("USBELIZA_BROWSER") {
        return Ok(PathBuf::from(explicit));
    }
    for candidate in ["chromium", "chromium-browser", "google-chrome"] {
        if let Some(path) = which(candidate) {
            return Ok(path);
        }
    }
    Err(anyhow!(
        "no chromium-class browser found in PATH (tried chromium, chromium-browser, google-chrome). \
         Set USBELIZA_BROWSER to override."
    ))
}

fn which(cmd: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|p| p.join(cmd))
            .find(|p| p.is_file() && is_executable(p))
    })
}

#[cfg(unix)]
fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(_path: &std::path::Path) -> bool {
    true
}

/// Locate the host Wayland socket. Honors `WAYLAND_DISPLAY` (the standard
/// env var) or falls back to `wayland-0`.
fn wayland_socket() -> Result<PathBuf> {
    let xdg = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("XDG_RUNTIME_DIR not set"))?;
    let display_name = std::env::var("WAYLAND_DISPLAY").unwrap_or_else(|_| "wayland-0".into());
    let socket = xdg.join(&display_name);
    if !socket.exists() {
        return Err(anyhow!(
            "wayland socket {} not present (is the user logged into a Wayland session?)",
            socket.display()
        ));
    }
    Ok(socket)
}

/// Launch the app named `slug`. Idempotent: if the app is already running,
/// we leave it alone and just bring its window forward. (Phase 0 simply
/// no-ops on duplicate-launch; window-focus integration is a Phase 1 polish
/// item.)
pub async fn launch(registry: &LaunchRegistry, slug: &str) -> Result<()> {
    {
        let inner = registry.inner.lock().await;
        if let Some(running) = inner.get(slug)
            && running.child.is_some()
        {
            info!(slug, "app already running; skipping launch");
            return Ok(());
        }
    }

    let app_dir = apps_root()?.join(slug);
    if !app_dir.is_dir() {
        return Err(anyhow!("app `{slug}` not found at {}", app_dir.display()));
    }

    let manifest_path = app_dir.join("manifest.json");
    let manifest_text = tokio::fs::read_to_string(&manifest_path)
        .await
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest: Manifest = serde_json::from_str(&manifest_text).context("parse manifest.json")?;

    validate_manifest(&manifest, &app_dir).context("validate manifest")?;

    if manifest.slug != slug {
        return Err(anyhow!(
            "manifest slug `{}` does not match requested slug `{slug}`",
            manifest.slug,
        ));
    }

    // Ensure data/ exists before we launch — bwrap will bind-mount it.
    let data_dir = app_dir.join("data");
    tokio::fs::create_dir_all(&data_dir)
        .await
        .with_context(|| format!("create {}", data_dir.display()))?;

    let cap_socket = cap_bus_socket(slug);
    let granted: Vec<Capability> = manifest.capabilities.clone();

    let cap_handle = spawn_cap_bus(ServerConfig {
        slug: slug.to_owned(),
        granted,
        data_dir: data_dir.clone(),
        socket_path: cap_socket.clone(),
        socket_mode: None,
        // Production leaves the handler-config knobs `None` so each
        // handler resolves its own binary paths / endpoints via env +
        // PATH lookup. Tests override these to inject fakes.
        notify: None,
        clipboard: None,
        network: None,
    })
    .await
    .context("spawn cap-bus server")?;

    let webview_browser = locate_browser().context("locate webview browser")?;
    let wayland_socket_path = wayland_socket().context("locate wayland socket")?;
    let xdg_runtime_dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("XDG_RUNTIME_DIR not set"))?;

    let invocation = build_bwrap(
        &manifest,
        &LaunchContext {
            app_root: app_dir.clone(),
            cap_socket,
            webview_browser,
            wayland_socket: wayland_socket_path,
            xdg_runtime_dir,
        },
    )
    .context("build bwrap invocation")?;

    info!(slug, "launching bubblewrap'd app");
    let child = Command::new(&invocation.program)
        .args(&invocation.argv)
        .kill_on_drop(true)
        .spawn()
        .with_context(|| {
            format!(
                "spawn {} for slug {slug}",
                invocation.program.to_string_lossy()
            )
        })?;

    let mut inner = registry.inner.lock().await;
    inner.insert(
        slug.to_owned(),
        RunningApp {
            cap_bus: Some(cap_handle),
            child: Some(child),
        },
    );
    Ok(())
}

/// Stop a running app: kills the bubblewrap child + tears down the cap-bus.
pub async fn stop(registry: &LaunchRegistry, slug: &str) -> Result<()> {
    let mut inner = registry.inner.lock().await;
    let Some(mut running) = inner.remove(slug) else {
        return Ok(()); // not running, nothing to do
    };
    if let Some(mut child) = running.child.take() {
        // SIGTERM via tokio's kill (kill_on_drop also fires when the Child
        // is dropped, but explicit shutdown lets us await).
        if let Err(e) = child.kill().await {
            warn!(slug, "failed to kill app child: {e:#}");
        }
    }
    if let Some(handle) = running.cap_bus.take()
        && let Err(e) = handle.join().await
    {
        warn!(slug, "cap-bus join error: {e:#}");
    }
    Ok(())
}

/// Stop everything. Used on Tauri shutdown.
#[allow(dead_code)] // Wired into the Tauri shutdown hook in milestone 11d.
pub async fn stop_all(registry: &LaunchRegistry) {
    let slugs: Vec<String> = {
        let inner = registry.inner.lock().await;
        inner.keys().cloned().collect()
    };
    for slug in slugs {
        if let Err(e) = stop(registry, &slug).await {
            warn!(slug, "stop_all error: {e:#}");
        }
    }
}

/// Construct the per-app `Arc<LaunchRegistry>` `AppState` carries.
pub fn registry() -> Arc<LaunchRegistry> {
    Arc::new(LaunchRegistry::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_bus_socket_default_is_under_run_eliza() {
        let path = cap_bus_socket("calendar");
        // Without the env override we get the prod path.
        assert!(path.starts_with("/run/eliza"));
        assert_eq!(path.file_name().unwrap(), "cap-calendar.sock");
    }
}
