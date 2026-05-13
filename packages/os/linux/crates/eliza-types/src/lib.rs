// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! Shared types for usbeliza.
//!
//! Every persisted artifact in this crate carries an explicit `schema_version` field
//! so future migrations are mechanical, not heuristic. Bump the version constant
//! when the on-disk shape changes; never silently break old files.

#![deny(missing_docs)]

pub mod calibration;
pub mod capability;
pub mod manifest;

pub use calibration::{CalibrationProfile, Chronotype, ErrorCommunication, Multitasking};
pub use capability::Capability;
pub use manifest::{AppRuntime, Manifest};
