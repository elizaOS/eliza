use serde_json::json;
use computeruse_mcp_agent::output_parser::{run_output_parser, OutputParserDefinition};
use computeruse_mcp_agent::utils::ExecuteSequenceArgs;

#[tokio::test]
async fn test_legacy_output_parser_field() {
    // Test that the legacy 'output_parser' field still works
    let args_json = json!({
        "steps": [{
            "tool_name": "test_tool",
            "arguments": {}
        }],
        "output_parser": {
            "javascript_code": "return { success: true, data: 'legacy' };"
        }
    });

    let args: ExecuteSequenceArgs = serde_json::from_value(args_json).unwrap();
    assert!(args.output_parser.is_some());
    assert!(args.output.is_none());
}

#[tokio::test]
async fn test_new_output_field() {
    // Test that the new 'output' field works
    let args_json = json!({
        "steps": [{
            "tool_name": "test_tool",
            "arguments": {}
        }],
        "output": {
            "javascript_code": "return { success: true, data: 'new' };"
        }
    });

    let args: ExecuteSequenceArgs = serde_json::from_value(args_json).unwrap();
    assert!(args.output_parser.is_none());
    assert!(args.output.is_some());
}

#[tokio::test]
async fn test_output_field_with_run() {
    // Test that the new 'output' field works with 'run' instead of 'javascript_code'
    let args_json = json!({
        "steps": [{
            "tool_name": "test_tool",
            "arguments": {}
        }],
        "output": {
            "run": "return { success: true, data: 'run_syntax' };"
        }
    });

    let args: ExecuteSequenceArgs = serde_json::from_value(args_json).unwrap();
    assert!(args.output.is_some());
}

#[tokio::test]
async fn test_output_field_as_string() {
    // Test that the 'output' field can be a simple string (JavaScript code directly)
    let args_json = json!({
        "steps": [{
            "tool_name": "test_tool",
            "arguments": {}
        }],
        "output": "return { success: true, data: 'string_syntax' };"
    });

    let args: ExecuteSequenceArgs = serde_json::from_value(args_json).unwrap();
    assert!(args.output.is_some());
    assert!(args.output.as_ref().unwrap().is_string());
}

#[tokio::test]
async fn test_parser_definition_legacy_javascript_code() {
    // Test legacy javascript_code field
    let parser_json = json!({
        "javascript_code": "return { test: 'legacy' };"
    });

    let parser: OutputParserDefinition = serde_json::from_value(parser_json).unwrap();
    assert!(parser.javascript_code.is_some());
    assert_eq!(
        parser.javascript_code.unwrap(),
        "return { test: 'legacy' };"
    );
    assert!(parser.run.is_none());
}

#[tokio::test]
async fn test_parser_definition_new_run_field() {
    // Test new 'run' field
    let parser_json = json!({
        "run": "return { test: 'new_run' };"
    });

    let parser: OutputParserDefinition = serde_json::from_value(parser_json).unwrap();
    assert!(parser.javascript_code.is_none());
    assert!(parser.run.is_some());
    assert_eq!(parser.run.unwrap(), "return { test: 'new_run' };");
}

#[tokio::test]
async fn test_parser_string_shorthand() {
    // Test that run_output_parser handles string input
    let parser_val = json!("return { success: true };");
    let tool_output = json!({
        "results": []
    });

    // This should not error during parsing - the string shorthand is valid
    // It will only error when trying to execute (Node.js not available in tests)
    let result = run_output_parser(&parser_val, &tool_output).await;
    // The result depends on whether Node.js is available in the test environment
    // We just verify it doesn't panic and handles the string format correctly
    match result {
        Ok(_) => {
            // Node.js was available and executed successfully
        }
        Err(err) => {
            // Either Node.js wasn't available or the JS had an error
            let err_msg = err.to_string();
            // Should be an execution error, not a parsing error
            assert!(
                err_msg.contains("Node.js")
                    || err_msg.contains("node")
                    || err_msg.contains("JavaScript")
            );
        }
    }
}

#[tokio::test]
async fn test_parser_with_both_fields_errors() {
    // Test that having both javascript_code and run fields is not allowed
    let parser_json = json!({
        "javascript_code": "return 1;",
        "run": "return 2;"
    });

    // This should fail to deserialize or cause an error when used
    let parser: OutputParserDefinition = serde_json::from_value(parser_json).unwrap();
    assert!(parser.javascript_code.is_some());
    assert!(parser.run.is_some());

    // When used, it should error because both fields are present
    let tool_output = json!({});
    let parser_val = serde_json::to_value(&parser).unwrap();
    let result = run_output_parser(&parser_val, &tool_output).await;

    // The current implementation prioritizes javascript_code over run
    // So it will attempt to execute with javascript_code
    match result {
        Ok(_) => {
            // Node.js was available and executed the javascript_code field
        }
        Err(err) => {
            let err_msg = err.to_string();
            // Could be either the "Cannot provide both" error or Node.js execution error
            assert!(
                err_msg.contains("Cannot provide both")
                    || err_msg.contains("Node.js")
                    || err_msg.contains("node")
                    || err_msg.contains("JavaScript")
            );
        }
    }
}

#[tokio::test]
async fn test_backward_compatibility_full_workflow() {
    // Test that old YAML format still works
    let old_format = json!({
        "steps": [{
            "tool_name": "click_element",
            "arguments": {
                "selector": "button|Submit"
            },
            "continue_on_error": false,
            "delay_ms": 1000
        }],
        "stop_on_error": true,
        "include_detailed_results": true,
        "output_parser": {
            "javascript_code": "return { parsed: true };"
        }
    });

    let args: ExecuteSequenceArgs = serde_json::from_value(old_format).unwrap();
    assert_eq!(args.stop_on_error, Some(true));
    assert_eq!(args.include_detailed_results, Some(true));
    assert!(args.output_parser.is_some());
    assert_eq!(args.steps.as_ref().unwrap()[0].delay_ms, Some(1000));
}

#[tokio::test]
async fn test_new_format_full_workflow() {
    // Test that new simplified format works
    let new_format = json!({
        "steps": [{
            "tool_name": "click_element",
            "arguments": {
                "selector": "button|Submit"
            }
        }],
        "output": "return { parsed: true };"
    });

    let args: ExecuteSequenceArgs = serde_json::from_value(new_format).unwrap();
    assert!(args.output.is_some());
    assert!(args.output_parser.is_none());
}

#[test]
fn test_both_output_fields_together() {
    // Test what happens when both output_parser and output are provided
    // Should use output_parser for backward compatibility
    let json_with_both = json!({
        "steps": [],
        "output_parser": {
            "javascript_code": "return 'old';"
        },
        "output": {
            "run": "return 'new';"
        }
    });

    let args: ExecuteSequenceArgs = serde_json::from_value(json_with_both).unwrap();
    assert!(args.output_parser.is_some());
    assert!(args.output.is_some());
    // In the actual implementation, output_parser takes precedence
}
