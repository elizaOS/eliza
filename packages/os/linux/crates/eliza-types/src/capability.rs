// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! Capability v1 surface. The serialized form is a `{ "kind": "<name:purpose>", ...params }`
//! object so capabilities that need parameters (`network:fetch` allowlist) can carry them
//! without breaking the homogeneous list shape.
//!
//! Unknown variants must be rejected at validation time — the manifest validator in
//! `eliza-sandbox` consumes this enum directly so any addition here is a deliberate
//! v1-surface change.

use serde::{Deserialize, Serialize};

/// A single capability declaration on a generated app's manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Capability {
    /// Read the current wall-clock time and the system timezone.
    #[serde(rename = "time:read")]
    TimeRead,

    /// Read and write within the app's own `data/` directory only.
    #[serde(rename = "storage:scoped")]
    StorageScoped,

    /// Post a desktop notification through the host.
    #[serde(rename = "notifications:write")]
    NotificationsWrite,

    /// Make HTTPS requests to a manifest-pinned allowlist of hosts.
    #[serde(rename = "network:fetch")]
    NetworkFetch {
        /// Hostnames the app is permitted to reach. No wildcards.
        allowlist: Vec<String>,
    },

    /// Read clipboard contents (one-shot, gated by user confirm dialog).
    #[serde(rename = "clipboard:read")]
    ClipboardRead,

    /// Write clipboard contents (one-shot, gated by user confirm dialog).
    #[serde(rename = "clipboard:write")]
    ClipboardWrite,

    /// Ask the user to pick a file from outside the sandbox; mediated by the host.
    #[serde(rename = "files:open-dialog")]
    FilesOpenDialog,

    /// Call back into the Eliza agent for in-app help or sub-questions.
    #[serde(rename = "agent:ask")]
    AgentAsk,

    /// Hand a local file or URL off to the host's media engine for playback.
    #[serde(rename = "media:play")]
    MediaPlay,

    /// Emit print output to the host's printer surface.
    #[serde(rename = "print:emit")]
    PrintEmit,
}

impl Capability {
    /// The stable JSON-RPC method name a Phase 0+ cap-bus handler dispatches on.
    #[must_use]
    pub fn rpc_method(&self) -> &'static str {
        match self {
            Self::TimeRead => "time:read",
            Self::StorageScoped => "storage:scoped",
            Self::NotificationsWrite => "notifications:write",
            Self::NetworkFetch { .. } => "network:fetch",
            Self::ClipboardRead => "clipboard:read",
            Self::ClipboardWrite => "clipboard:write",
            Self::FilesOpenDialog => "files:open-dialog",
            Self::AgentAsk => "agent:ask",
            Self::MediaPlay => "media:play",
            Self::PrintEmit => "print:emit",
        }
    }

    /// Capabilities implemented by the Phase 0 cap-bus broker. Others parse and
    /// validate but the broker returns `not_implemented` at runtime.
    #[must_use]
    pub const fn is_phase_0_implemented(&self) -> bool {
        matches!(self, Self::TimeRead | Self::StorageScoped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_read_round_trips() {
        let cap = Capability::TimeRead;
        let json = serde_json::to_string(&cap).expect("serialize");
        assert_eq!(json, r#"{"kind":"time:read"}"#);
        let parsed: Capability = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, cap);
    }

    #[test]
    fn network_fetch_carries_allowlist() {
        let cap = Capability::NetworkFetch {
            allowlist: vec!["api.example.com".into()],
        };
        let json = serde_json::to_string(&cap).expect("serialize");
        assert_eq!(
            json,
            r#"{"kind":"network:fetch","allowlist":["api.example.com"]}"#
        );
        let parsed: Capability = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, cap);
    }

    #[test]
    fn unknown_kind_is_rejected() {
        let json = r#"{"kind":"camera:capture"}"#;
        let parsed: Result<Capability, _> = serde_json::from_str(json);
        assert!(parsed.is_err(), "unknown capability kinds must be rejected");
    }

    #[test]
    fn rpc_method_matches_kind_on_round_trip() {
        for cap in [
            Capability::TimeRead,
            Capability::StorageScoped,
            Capability::NotificationsWrite,
            Capability::NetworkFetch { allowlist: vec![] },
            Capability::ClipboardRead,
            Capability::ClipboardWrite,
            Capability::FilesOpenDialog,
            Capability::AgentAsk,
            Capability::MediaPlay,
            Capability::PrintEmit,
        ] {
            let json = serde_json::to_string(&cap).expect("serialize");
            let v: serde_json::Value = serde_json::from_str(&json).expect("parse");
            assert_eq!(v["kind"].as_str(), Some(cap.rpc_method()));
        }
    }

    #[test]
    fn phase_0_implemented_set_is_minimal() {
        assert!(Capability::TimeRead.is_phase_0_implemented());
        assert!(Capability::StorageScoped.is_phase_0_implemented());
        assert!(!Capability::NetworkFetch { allowlist: vec![] }.is_phase_0_implemented());
        assert!(!Capability::AgentAsk.is_phase_0_implemented());
    }
}
