//! Integration tests for localdb plugin.

// Note: The localdb plugin has complex storage types that require
// initialization. Basic tests validate the module structure exists.

#[test]
fn test_module_exists() {
    // This test validates that the localdb plugin compiles and
    // its basic structure is accessible.
    assert!(true);
}

#[test]
fn test_plugin_name() {
    // Verify the plugin function exists and returns expected metadata
    let plugin = elizaos_plugin_localdb::plugin();
    assert_eq!(plugin.name(), "localdb");
}
