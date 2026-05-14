// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! Per-app cap-bus broker, hosted by `elizad`.
//!
//! Phase 0 scope (this scaffold): types only, plumbed through the workspace.
//! Real broker (one socket per running app, JSON-RPC handlers for `time:read`
//! and `storage:scoped`) lands in milestone #11 alongside the first canonical
//! app.
//!
//! See `eliza-cap-bus` for the protocol types.

#![allow(dead_code)]
