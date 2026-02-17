//! Packaging tests for SWE-agent Rust implementation

use elizaos_sweagent::VERSION;

#[test]
fn test_version_format() {
    let parts: Vec<&str> = VERSION.split('.').collect();
    assert_eq!(parts.len(), 3, "Version should be in semver format (x.y.z)");

    for part in parts {
        assert!(
            part.parse::<u32>().is_ok(),
            "Each version part should be a number"
        );
    }
}

#[test]
fn test_version_matches_python_and_typescript() {
    // This ensures the Rust version matches what's expected for parity
    assert_eq!(
        VERSION, "1.1.0",
        "Version should match Python and TypeScript"
    );
}

#[test]
fn test_crate_exports() {
    // Verify main types are exported
}

#[test]
fn test_feature_detection() {
    let mut enabled_features = Vec::new();
    if cfg!(feature = "native") {
        enabled_features.push("native");
    }
    if cfg!(feature = "wasm") {
        enabled_features.push("wasm");
    }
    assert!(
        !enabled_features.is_empty(),
        "At least one runtime feature should be enabled"
    );
}
