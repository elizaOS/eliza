// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! Bubblewrap profile builder, manifest validator, and rolling version history.
//!
//! Phase 0 surface:
//!   - [`validate`] — schema check, capability whitelist, entry-file existence.
//!   - [`launcher::build`] — produces the `bwrap` argv for a validated manifest
//!     (locked decision #14: per-app cap socket bind, no shared `cap.sock`).

#![deny(missing_docs)]

pub mod launcher;

use std::path::Path;

use eliza_types::{Manifest, manifest::MANIFEST_SCHEMA_VERSION};

/// Errors a manifest can fail validation with.
#[derive(Debug, thiserror::Error)]
pub enum ValidationError {
    /// The on-disk manifest declared a `schema_version` this build cannot read.
    #[error(
        "manifest schema_version {found} is not supported by this build (max supported: {supported})"
    )]
    UnsupportedSchemaVersion {
        /// What the manifest claimed.
        found: u32,
        /// Highest version we know how to read.
        supported: u32,
    },

    /// The slug is empty or contains characters outside the URL-safe set.
    #[error("invalid slug `{0}`: must match `^[a-z0-9][a-z0-9-]*$`")]
    InvalidSlug(String),

    /// The entry file referenced by the manifest does not exist on disk.
    #[error("entry file `{0}` does not exist")]
    EntryMissing(String),
}

/// Validate a manifest. The `app_root` is `~/.eliza/apps/<slug>/`.
///
/// Phase 0 checks: `schema_version`, slug shape, entry file existence.
/// Phase 1 adds: capability whitelist re-check (already enforced at parse via
/// the enum), seccomp profile compilation, the 3-second smoke launch.
pub fn validate(manifest: &Manifest, app_root: &Path) -> Result<(), ValidationError> {
    if manifest.schema_version > MANIFEST_SCHEMA_VERSION {
        return Err(ValidationError::UnsupportedSchemaVersion {
            found: manifest.schema_version,
            supported: MANIFEST_SCHEMA_VERSION,
        });
    }

    if !slug_is_valid(&manifest.slug) {
        return Err(ValidationError::InvalidSlug(manifest.slug.clone()));
    }

    let entry = app_root.join(&manifest.entry);
    if !entry.exists() {
        return Err(ValidationError::EntryMissing(
            entry.to_string_lossy().into_owned(),
        ));
    }

    Ok(())
}

fn slug_is_valid(slug: &str) -> bool {
    if slug.is_empty() {
        return false;
    }
    let mut chars = slug.chars();
    let first = chars.next().expect("non-empty checked above");
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use eliza_types::{capability::Capability, manifest::AppRuntime};

    use super::*;

    fn fixture(slug: &str, entry: &str) -> Manifest {
        Manifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            slug: slug.into(),
            title: "Test".into(),
            intent: "test app".into(),
            runtime: AppRuntime::Webview,
            entry: PathBuf::from(entry),
            capabilities: vec![Capability::TimeRead],
            version: 1,
            last_built_by: "test".into(),
            last_built_at: "2026-05-10T00:00:00Z".into(),
        }
    }

    #[test]
    fn slug_validation_accepts_canonical_names() {
        for s in ["calendar", "notes", "text-editor", "app42"] {
            assert!(slug_is_valid(s), "{s:?} should be valid");
        }
    }

    #[test]
    fn slug_validation_rejects_uppercase_and_special_chars() {
        for s in ["", "Calendar", "my_app", "../etc", "-leading-dash"] {
            assert!(!slug_is_valid(s), "{s:?} should be invalid");
        }
    }

    #[test]
    fn validate_rejects_unknown_schema_version() {
        let dir = tempdir();
        let mut manifest = fixture("calendar", "src/index.html");
        manifest.schema_version = MANIFEST_SCHEMA_VERSION + 1;
        let err = validate(&manifest, dir.path()).expect_err("should fail");
        assert!(
            matches!(err, ValidationError::UnsupportedSchemaVersion { .. }),
            "got {err:?}",
        );
    }

    #[test]
    fn validate_rejects_invalid_slug() {
        let dir = tempdir();
        let manifest = fixture("My App", "src/index.html");
        let err = validate(&manifest, dir.path()).expect_err("should fail");
        assert!(
            matches!(err, ValidationError::InvalidSlug(_)),
            "got {err:?}"
        );
    }

    #[test]
    fn validate_rejects_missing_entry() {
        let dir = tempdir();
        let manifest = fixture("calendar", "src/index.html");
        let err = validate(&manifest, dir.path()).expect_err("should fail");
        assert!(
            matches!(err, ValidationError::EntryMissing(_)),
            "got {err:?}"
        );
    }

    #[test]
    fn validate_passes_when_entry_exists() {
        let dir = tempdir();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/index.html"), "<!doctype html>").unwrap();
        let manifest = fixture("calendar", "src/index.html");
        validate(&manifest, dir.path()).expect("should pass");
    }

    /// Minimal scratch dir helper to avoid pulling in `tempfile` for one test.
    /// Removed automatically when the returned `Tempdir` is dropped.
    fn tempdir() -> Tempdir {
        let dir = std::env::temp_dir().join(format!(
            "usbeliza-sandbox-test-{}-{}",
            std::process::id(),
            rand_suffix(),
        ));
        std::fs::create_dir_all(&dir).expect("create tempdir");
        Tempdir { path: dir }
    }

    fn rand_suffix() -> String {
        // Cheap unique suffix without pulling in `rand`. Not crypto.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        format!("{nanos:x}")
    }

    struct Tempdir {
        path: std::path::PathBuf,
    }

    impl Tempdir {
        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for Tempdir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
