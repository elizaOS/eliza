use computeruse_mcp_agent::scripting_engine;

#[tokio::test]
#[ignore = "Requires local bindings which aren't available in CI"]
async fn test_javascript_engine_basic() {
    // Skip npm install in tests to avoid timeout
    std::env::set_var("COMPUTERUSE_SKIP_NPM_INSTALL", "1");

    // Test basic JavaScript execution with the new 'run' parameter
    let script = "return {success: true, value: 42};".to_string();
    let result =
        scripting_engine::execute_javascript_with_nodejs(script, None, None, None, None, None)
            .await
            .expect("JavaScript execution should succeed");

    assert_eq!(result["result"]["success"], true);
    assert_eq!(result["result"]["value"], 42);
}

#[tokio::test]
#[ignore = "Requires local bindings which aren't available in CI"]
async fn test_javascript_engine_with_async() {
    // Skip npm install in tests to avoid timeout
    std::env::set_var("COMPUTERUSE_SKIP_NPM_INSTALL", "1");

    // Test async JavaScript execution
    let script = r#"
        await sleep(100);
        return {delayed: true, timestamp: Date.now()};
    "#
    .to_string();

    let result =
        scripting_engine::execute_javascript_with_nodejs(script, None, None, None, None, None)
            .await
            .expect("Async JavaScript execution should succeed");

    assert_eq!(result["result"]["delayed"], true);
    assert!(result["result"]["timestamp"].is_number());
}

#[tokio::test]
#[ignore = "Requires local bindings which aren't available in CI"]
async fn test_javascript_engine_with_desktop_api() {
    // Skip npm install in tests to avoid timeout
    std::env::set_var("COMPUTERUSE_SKIP_NPM_INSTALL", "1");

    // Test that desktop API is available (may fail if no UI elements present)
    let script = r#"
        // Just check that desktop object exists
        return {
            hasDesktop: typeof desktop !== 'undefined',
            hasLocator: typeof desktop?.locator === 'function'
        };
    "#
    .to_string();

    let result =
        scripting_engine::execute_javascript_with_nodejs(script, None, None, None, None, None)
            .await
            .expect("Desktop API check should succeed");

    assert_eq!(result["result"]["hasDesktop"], true);
    assert_eq!(result["result"]["hasLocator"], true);
}
