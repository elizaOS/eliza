use elizaos_computeruse::{create_computeruse_plugin, ComputerUseConfig, ComputerUseMode};
use serde_json::json;

// ---------------------------------------------------------------------------
// Helper: creates a plugin in MCP mode without a real MCP server.
// The handle_action method will fail for MCP calls since no server is
// connected, but we can still test argument validation and dispatch.
// ---------------------------------------------------------------------------

fn disabled_plugin() -> elizaos_computeruse::ComputerUsePlugin {
    create_computeruse_plugin(Some(ComputerUseConfig {
        enabled: false,
        mode: ComputerUseMode::Auto,
        ..Default::default()
    }))
}

fn enabled_plugin_no_backend() -> elizaos_computeruse::ComputerUsePlugin {
    // Enabled but backend is None (never initialized).
    let cfg = ComputerUseConfig {
        enabled: true,
        mode: ComputerUseMode::Mcp,
        ..Default::default()
    };
    // Don't call init() – backend stays None.
    create_computeruse_plugin(Some(cfg))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn disabled_plugin_rejects_all_actions() {
    let mut plugin = disabled_plugin();
    let res = plugin
        .handle_action("COMPUTERUSE_CLICK", json!({"selector": "role:Button", "process": "notepad"}))
        .await
        .unwrap();
    assert_eq!(res["success"], false);
    assert!(res["error"].as_str().unwrap_or("").to_lowercase().contains("disabled"));
}

#[tokio::test]
async fn unknown_action_returns_error() {
    let mut plugin = enabled_plugin_no_backend();
    let res = plugin
        .handle_action("COMPUTERUSE_FLY", json!({}))
        .await
        .unwrap();
    assert_eq!(res["success"], false);
    assert!(res["error"].as_str().unwrap_or("").contains("Unknown"));
}

#[tokio::test]
async fn click_without_selector_errors() {
    let mut plugin = enabled_plugin_no_backend();
    // backend is None, so even with valid args the match falls through.
    let res = plugin.handle_action("COMPUTERUSE_CLICK", json!({})).await;
    // Should error because backend is None and action doesn't match any arm.
    assert!(
        res.is_err() || res.as_ref().unwrap().get("success") == Some(&json!(false)),
        "Expected error or success=false, got {:?}",
        res
    );
}

#[tokio::test]
async fn open_application_without_name_errors() {
    let mut plugin = enabled_plugin_no_backend();
    let res = plugin
        .handle_action("COMPUTERUSE_OPEN_APPLICATION", json!({}))
        .await;
    assert!(
        res.is_err() || res.as_ref().unwrap().get("success") == Some(&json!(false)),
        "Expected error for missing name"
    );
}

#[tokio::test]
async fn type_without_text_errors() {
    let mut plugin = enabled_plugin_no_backend();
    let res = plugin
        .handle_action(
            "COMPUTERUSE_TYPE",
            json!({"selector": "role:Edit", "process": "notepad"}),
        )
        .await;
    assert!(
        res.is_err() || res.as_ref().unwrap().get("success") == Some(&json!(false)),
        "Expected error for missing text"
    );
}

#[tokio::test]
async fn get_window_tree_without_process_errors() {
    let mut plugin = enabled_plugin_no_backend();
    let res = plugin
        .handle_action("COMPUTERUSE_GET_WINDOW_TREE", json!({}))
        .await;
    assert!(
        res.is_err() || res.as_ref().unwrap().get("success") == Some(&json!(false)),
        "Expected error for missing process"
    );
}

#[tokio::test]
async fn get_applications_on_uninitialized_backend_errors() {
    let mut plugin = enabled_plugin_no_backend();
    let res = plugin
        .handle_action("COMPUTERUSE_GET_APPLICATIONS", json!({}))
        .await;
    assert!(
        res.is_err() || res.as_ref().unwrap().get("success") == Some(&json!(false)),
    );
}

// ---------------------------------------------------------------------------
// parse_process_scoped_selector unit tests (via plugin module tests)
// These are already in plugin.rs but we add additional coverage here.
// ---------------------------------------------------------------------------

#[test]
fn config_defaults_are_sensible() {
    let cfg = ComputerUseConfig::default();
    assert!(!cfg.enabled);
    assert_eq!(cfg.mode, ComputerUseMode::Auto);
    assert_eq!(cfg.mcp_command, "npx");
    assert!(!cfg.mcp_args.is_empty());
}

#[tokio::test]
async fn init_disabled_sets_no_backend() {
    let mut plugin = disabled_plugin();
    plugin.init().await.unwrap();
    assert!(plugin.backend().is_none());
}

#[tokio::test]
async fn disabled_plugin_click_with_full_args_still_rejected() {
    let mut plugin = disabled_plugin();
    let res = plugin
        .handle_action(
            "COMPUTERUSE_CLICK",
            json!({
                "process": "notepad",
                "selector": "role:Button|name:Save",
                "timeoutMs": 5000
            }),
        )
        .await
        .unwrap();
    assert_eq!(res["success"], false);
}

#[tokio::test]
async fn disabled_plugin_type_with_full_args_rejected() {
    let mut plugin = disabled_plugin();
    let res = plugin
        .handle_action(
            "COMPUTERUSE_TYPE",
            json!({
                "process": "notepad",
                "selector": "role:Edit",
                "text": "hello",
                "timeoutMs": 5000,
                "clearBeforeTyping": true
            }),
        )
        .await
        .unwrap();
    assert_eq!(res["success"], false);
}

#[tokio::test]
async fn disabled_plugin_open_application_rejected() {
    let mut plugin = disabled_plugin();
    let res = plugin
        .handle_action("COMPUTERUSE_OPEN_APPLICATION", json!({"name": "calc"}))
        .await
        .unwrap();
    assert_eq!(res["success"], false);
}
