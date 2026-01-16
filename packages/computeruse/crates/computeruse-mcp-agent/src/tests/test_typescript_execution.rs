#[cfg(test)]
mod typescript_execution_tests {
    use super::*;
    use crate::scripting_engine::execute_typescript_with_nodejs;
    use serde_json::json;

    #[tokio::test]
    async fn test_typescript_returns_simple_value() {
        let script = r#"
            console.log('Test: TypeScript simple return');
            return { status: 'success', value: 42 };
        "#;

        let result = execute_typescript_with_nodejs(script.to_string(), None, None, None, None, None).await;

        assert!(result.is_ok(), "TypeScript execution should succeed");
        let value = result.unwrap();

        assert_eq!(value["status"], "success");
        assert_eq!(value["value"], 42);
    }

    #[tokio::test]
    async fn test_typescript_returns_async_value() {
        let script = r#"
            console.log('Test: TypeScript async return');
            await sleep(100);
            return { status: 'async_success', timestamp: Date.now() };
        "#;

        let result = execute_typescript_with_nodejs(script.to_string(), None, None, None, None, None).await;

        assert!(result.is_ok(), "TypeScript async execution should succeed");
        let value = result.unwrap();

        assert_eq!(value["status"], "async_success");
        assert!(value["timestamp"].is_number());
    }

    #[tokio::test]
    async fn test_typescript_returns_null_for_undefined() {
        let script = r#"
            console.log('Test: TypeScript undefined return');
            // No explicit return
        "#;

        let result = execute_typescript_with_nodejs(script.to_string(), None, None, None, None, None).await;

        assert!(result.is_ok(), "TypeScript execution should succeed even without return");
        let value = result.unwrap();

        assert_eq!(value, json!(null), "Undefined should be converted to null");
    }

    #[tokio::test]
    async fn test_typescript_captures_console_output() {
        let script = r#"
            console.log('Line 1');
            console.log('Line 2');
            return { lines: 2 };
        "#;

        // This test would need access to the captured logs
        // For now just test that execution succeeds
        let result = execute_typescript_with_nodejs(script.to_string(), None, None, None, None, None).await;

        assert!(result.is_ok(), "TypeScript execution with console output should succeed");
        let value = result.unwrap();
        assert_eq!(value["lines"], 2);
    }

    #[tokio::test]
    async fn test_typescript_handles_errors() {
        let script = r#"
            console.log('Test: TypeScript error handling');
            throw new Error('Test error');
        "#;

        let result = execute_typescript_with_nodejs(script.to_string(), None, None, None, None, None).await;

        assert!(result.is_err(), "TypeScript execution should fail on error");
        let error = result.unwrap_err();

        // Check that error message contains "Test error"
        let error_str = format!("{:?}", error);
        assert!(error_str.contains("Test error"), "Error should contain the thrown message");
    }

    #[tokio::test]
    async fn test_typescript_vs_javascript_consistency() {
        use crate::scripting_engine::execute_javascript_with_nodejs;

        let test_script = r#"
            const result = {
                status: 'success',
                engine: 'test',
                value: 123
            };
            return result;
        "#;

        // Test both engines with same script
        let ts_result = execute_typescript_with_nodejs(test_script.to_string(), None, None, None, None, None).await;
        let js_result = execute_javascript_with_nodejs(test_script.to_string(), None, None, None, None, None).await;

        assert!(ts_result.is_ok(), "TypeScript should succeed");
        assert!(js_result.is_ok(), "JavaScript should succeed");

        let ts_value = ts_result.unwrap();
        let js_value = js_result.unwrap();

        // Both should return the same result
        assert_eq!(ts_value["status"], js_value["status"]);
        assert_eq!(ts_value["value"], js_value["value"]);
    }
}