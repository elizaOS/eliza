// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! The first-boot calibration profile.
//!
//! Five conversational questions, persisted to `~/.eliza/calibration.toml`,
//! baked into Eliza's system prompt as a `<calibration>` block at agent startup.
//! See `PLAN.md` "First boot — the *Her*-inspired calibration".
//!
//! Cross-device note: this file is one of the artifacts the cloud-sync
//! subscription replicates so a user's Eliza calibrates the same on phone
//! (`MiladyOS`) and USB (`usbeliza`).

use serde::{Deserialize, Serialize};

/// The schema version for `calibration.toml`. Bump on shape change.
pub const CALIBRATION_SCHEMA_VERSION: u32 = 1;

/// The user's preference for opening many tools at once vs. one at a time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Multitasking {
    /// "Just the one I need right now."
    SingleTask,
    /// "Lots of tools at once."
    MultiTask,
}

/// The user's chronotype, used to bias notification timing and theme defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Chronotype {
    /// Morning person.
    Morning,
    /// Evening person.
    Evening,
    /// No strong preference.
    Flexible,
}

/// How the user wants Eliza to handle errors when something she built breaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCommunication {
    /// "Tell me what you tried."
    Transparent,
    /// "Just fix it."
    Quiet,
}

/// The full calibration profile written on first boot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CalibrationProfile {
    /// Schema version. Bump on shape change.
    pub schema_version: u32,

    /// RFC 3339 timestamp of profile creation.
    pub created_at: String,

    /// What the user wants Eliza to call them.
    pub name: String,

    /// Free-text answer to "what do you spend most of your computer time on?"
    pub work_focus: String,

    /// Multi-tool vs single-tool preference.
    pub multitasking: Multitasking,

    /// Morning / evening / flexible.
    pub chronotype: Chronotype,

    /// Quiet vs transparent error handling.
    pub error_communication: ErrorCommunication,
}

impl CalibrationProfile {
    /// Render the profile as a `<calibration>` block suitable for the agent's
    /// system prompt prefix. Used by `eliza-agent` at boot.
    #[must_use]
    pub fn to_system_prompt_block(&self) -> String {
        format!(
            "<calibration>\n  \
             name: {name}\n  \
             work_focus: {work_focus}\n  \
             multitasking: {multitasking}\n  \
             chronotype: {chronotype}\n  \
             error_communication: {error_communication}\n\
             </calibration>",
            name = self.name,
            work_focus = self.work_focus,
            multitasking = match self.multitasking {
                Multitasking::SingleTask => "single-task",
                Multitasking::MultiTask => "multi-task",
            },
            chronotype = match self.chronotype {
                Chronotype::Morning => "morning",
                Chronotype::Evening => "evening",
                Chronotype::Flexible => "flexible",
            },
            error_communication = match self.error_communication {
                ErrorCommunication::Transparent => "transparent",
                ErrorCommunication::Quiet => "quiet",
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> CalibrationProfile {
        CalibrationProfile {
            schema_version: CALIBRATION_SCHEMA_VERSION,
            created_at: "2026-05-10T15:00:00Z".into(),
            name: "Charlie".into(),
            work_focus: "writing code, mostly Rust and TypeScript".into(),
            multitasking: Multitasking::SingleTask,
            chronotype: Chronotype::Morning,
            error_communication: ErrorCommunication::Transparent,
        }
    }

    #[test]
    fn calibration_profile_round_trips_through_toml() {
        let profile = fixture();
        let toml_str = toml::to_string(&profile).expect("serialize");
        let parsed: CalibrationProfile = toml::from_str(&toml_str).expect("deserialize");
        assert_eq!(parsed, profile);
    }

    #[test]
    fn system_prompt_block_contains_name_and_chronotype() {
        let block = fixture().to_system_prompt_block();
        assert!(block.contains("name: Charlie"));
        assert!(block.contains("chronotype: morning"));
        assert!(block.starts_with("<calibration>"));
        assert!(block.ends_with("</calibration>"));
    }

    #[test]
    fn unknown_chronotype_is_rejected() {
        let toml_str = r#"
            schema_version = 1
            created_at = "2026-05-10T00:00:00Z"
            name = "x"
            work_focus = "x"
            multitasking = "single-task"
            chronotype = "afternoon"
            error_communication = "transparent"
        "#;
        let result: Result<CalibrationProfile, _> = toml::from_str(toml_str);
        assert!(result.is_err(), "unknown chronotype must be rejected");
    }
}
