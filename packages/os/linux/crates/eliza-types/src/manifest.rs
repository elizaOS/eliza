// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! The per-app `manifest.json` schema. Lives at `~/.eliza/apps/<slug>/manifest.json`.
//!
//! `schema_version` is intentionally a top-level required field — the validator in
//! `eliza-sandbox` rejects manifests with an unknown `schema_version` rather than
//! silently coercing.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::capability::Capability;

/// The manifest schema version this build supports.
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;

/// Which runtime hosts the generated app's UI.
///
/// The "panel-*" / "dock" / "widget" variants are dream-world runtimes:
/// Eliza generates them on demand when the user asks for a taskbar,
/// a docked panel, or an ambient widget. The launcher reads this field
/// and tells sway how to position the resulting Chromium window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppRuntime {
    /// Chromium-embedded webview window. AI-generated HTML targets this.
    Webview,
    /// Native GTK4 window. Used when the manifest opts in.
    Gtk4,
    /// Terminal window hosting an `xterm.js` surface.
    Terminal,
    /// A thin horizontal strip docked at the top of the screen.
    /// Sway floats + pins it sticky across workspaces.
    PanelTop,
    /// Same idea, docked at the bottom.
    PanelBottom,
    /// A vertical strip docked at the left edge.
    PanelLeft,
    /// A vertical strip docked at the right edge.
    PanelRight,
    /// A floating, draggable window — music-player-style controls.
    Dock,
    /// A small floating window that ignores focus — Pomodoro, weather pill.
    Widget,
}

/// The app manifest. Persisted as JSON on the encrypted partition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    /// Schema version. Bump when the on-disk shape changes; old versions
    /// are migrated forward by `eliza-sandbox`, never read raw.
    pub schema_version: u32,

    /// Stable identifier; URL-safe; the directory name under `~/.eliza/apps/`.
    pub slug: String,

    /// Human-facing window title.
    pub title: String,

    /// The free-text user intent that produced this app on first build.
    pub intent: String,

    /// Which runtime hosts the app's UI.
    pub runtime: AppRuntime,

    /// Entry file relative to `~/.eliza/apps/<slug>/`. For `Webview`, an HTML file.
    pub entry: PathBuf,

    /// Declared capabilities. The sandbox enforces; the cap-bus dispatches.
    pub capabilities: Vec<Capability>,

    /// Monotonically incremented per atomic-swap build of this slug.
    pub version: u32,

    /// Identifier of the code generator that produced this version
    /// (e.g. `"claude-code-2.1.138"`).
    pub last_built_by: String,

    /// RFC 3339 timestamp of the last successful build.
    pub last_built_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar_manifest_round_trips() {
        let manifest = Manifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            slug: "calendar".into(),
            title: "Calendar".into(),
            intent: "show me my calendar".into(),
            runtime: AppRuntime::Webview,
            entry: PathBuf::from("src/index.html"),
            capabilities: vec![Capability::TimeRead, Capability::StorageScoped],
            version: 1,
            last_built_by: "claude-code-2.1.138".into(),
            last_built_at: "2026-05-10T08:00:00Z".into(),
        };
        let json = serde_json::to_string(&manifest).expect("serialize");
        let parsed: Manifest = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, manifest);
        assert_eq!(parsed.schema_version, MANIFEST_SCHEMA_VERSION);
    }

    #[test]
    fn manifest_with_unknown_runtime_is_rejected() {
        let json = r#"{
            "schema_version": 1,
            "slug": "x",
            "title": "X",
            "intent": "x",
            "runtime": "vulkan",
            "entry": "src/index.html",
            "capabilities": [],
            "version": 1,
            "last_built_by": "test",
            "last_built_at": "2026-05-10T00:00:00Z"
        }"#;
        let result: Result<Manifest, _> = serde_json::from_str(json);
        assert!(result.is_err(), "unknown runtime must be rejected");
    }
}
