// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! Cargo build script: defers to `tauri-build` for asset bundling, schema
//! validation, and platform-specific glue.

fn main() {
    tauri_build::build();
}
