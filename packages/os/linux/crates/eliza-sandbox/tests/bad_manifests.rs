// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! "Reject 5 known-bad manifests" pass criterion (PLAN.md, Phase 0
//! milestone 11d). Each fixture under `tests/fixtures/bad-manifests/`
//! exercises a distinct rejection path.

use std::path::PathBuf;

use eliza_sandbox::{ValidationError, validate};
use eliza_types::Manifest;

/// Loads a fixture JSON and returns the parse outcome. We split parse
/// failures from validate failures so the test can assert that the
/// "missing field" / "unknown capability" / "unknown runtime" cases die
/// at parse time (the typed enum is the gate), and the "bad slug" /
/// "future `schema_version`" cases die at validate time.
fn parse(fixture: &str) -> Result<Manifest, serde_json::Error> {
    let path = fixtures_dir().join(fixture);
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text)
}

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bad-manifests")
}

#[test]
fn rejects_missing_required_field_at_parse_time() {
    // The fixture omits `title`; serde rejects before validate() runs.
    let result = parse("1-missing-required-field.json");
    assert!(
        result.is_err(),
        "manifest missing `title` must fail to parse",
    );
}

#[test]
fn rejects_unknown_capability_kind_at_parse_time() {
    // `camera:capture` is not in the v1 enum; serde rejects.
    let result = parse("2-unknown-capability.json");
    assert!(
        result.is_err(),
        "manifest with unknown capability kind must fail to parse",
    );
}

#[test]
fn rejects_unknown_runtime_at_parse_time() {
    // `vulkan` is not in AppRuntime.
    let result = parse("3-unknown-runtime.json");
    assert!(
        result.is_err(),
        "manifest with unknown runtime must fail to parse",
    );
}

#[test]
fn rejects_bad_slug_at_validate_time() {
    let manifest: Manifest = parse("4-bad-slug.json").expect("parses");
    let scratch = tempdir("bad-slug");
    let err = validate(&manifest, &scratch).expect_err("must fail");
    assert!(
        matches!(err, ValidationError::InvalidSlug(_)),
        "expected InvalidSlug, got {err:?}",
    );
}

#[test]
fn rejects_future_schema_version_at_validate_time() {
    let manifest: Manifest = parse("5-future-schema-version.json").expect("parses");
    let scratch = tempdir("future-schema");
    let err = validate(&manifest, &scratch).expect_err("must fail");
    assert!(
        matches!(err, ValidationError::UnsupportedSchemaVersion { .. }),
        "expected UnsupportedSchemaVersion, got {err:?}",
    );
}

fn tempdir(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let dir = std::env::temp_dir().join(format!(
        "usbeliza-bad-manifests-{label}-{}-{nanos:x}",
        std::process::id(),
    ));
    std::fs::create_dir_all(&dir).expect("mktemp");
    dir
}
