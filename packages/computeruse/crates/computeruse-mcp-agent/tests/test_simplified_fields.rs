use serde_json::json;
use computeruse_mcp_agent::duration_parser::parse_duration;
use computeruse_mcp_agent::utils::{ExecuteSequenceArgs, SequenceStep};

#[test]
fn test_duration_parser() {
    // Test milliseconds
    assert_eq!(parse_duration("500").unwrap(), 500);
    assert_eq!(parse_duration("1000ms").unwrap(), 1000);
    assert_eq!(parse_duration("250milliseconds").unwrap(), 250);

    // Test seconds
    assert_eq!(parse_duration("1s").unwrap(), 1000);
    assert_eq!(parse_duration("2.5s").unwrap(), 2500);
    assert_eq!(parse_duration("10seconds").unwrap(), 10000);

    // Test minutes
    assert_eq!(parse_duration("1m").unwrap(), 60000);
    assert_eq!(parse_duration("2min").unwrap(), 120000);
    assert_eq!(parse_duration("0.5minutes").unwrap(), 30000);

    // Test hours
    assert_eq!(parse_duration("1h").unwrap(), 3600000);
    assert_eq!(parse_duration("2hours").unwrap(), 7200000);
    assert_eq!(parse_duration("0.5h").unwrap(), 1800000);
}

#[test]
fn test_continue_field() {
    // Test new 'continue' field (opposite of stop_on_error)
    let args_json = json!({
        "steps": [],
        "continue": true
    });

    let args: ExecuteSequenceArgs = serde_json::from_value(args_json).unwrap();
    assert_eq!(args.r#continue, Some(true));
    assert!(args.stop_on_error.is_none());
}

#[test]
fn test_verbosity_field() {
    // Test new 'verbosity' field
    let args_quiet = json!({
        "steps": [],
        "verbosity": "quiet"
    });

    let args: ExecuteSequenceArgs = serde_json::from_value(args_quiet).unwrap();
    assert_eq!(args.verbosity, Some("quiet".to_string()));

    let args_verbose = json!({
        "steps": [],
        "verbosity": "verbose"
    });

    let args: ExecuteSequenceArgs = serde_json::from_value(args_verbose).unwrap();
    assert_eq!(args.verbosity, Some("verbose".to_string()));
}

#[test]
fn test_delay_field_in_step() {
    // Test new 'delay' field with human-readable duration
    let step_json = json!({
        "tool_name": "wait_tool",
        "arguments": {},
        "delay": "2s"
    });

    let step: SequenceStep = serde_json::from_value(step_json).unwrap();
    assert_eq!(step.delay, Some("2s".to_string()));
    assert!(step.delay_ms.is_none());
}

#[test]
fn test_backward_compatibility_with_delay_ms() {
    // Test that old delay_ms still works
    let step_json = json!({
        "tool_name": "wait_tool",
        "arguments": {},
        "delay_ms": 2000
    });

    let step: SequenceStep = serde_json::from_value(step_json).unwrap();
    assert_eq!(step.delay_ms, Some(2000));
    assert!(step.delay.is_none());
}

#[test]
fn test_both_delay_fields() {
    // Test what happens when both delay and delay_ms are provided
    let step_json = json!({
        "tool_name": "wait_tool",
        "arguments": {},
        "delay": "1s",
        "delay_ms": 2000
    });

    let step: SequenceStep = serde_json::from_value(step_json).unwrap();
    assert_eq!(step.delay, Some("1s".to_string()));
    assert_eq!(step.delay_ms, Some(2000));
    // The implementation should prefer 'delay' over 'delay_ms'
}

#[test]
fn test_both_continue_and_stop_on_error() {
    // Test what happens when both fields are provided
    let args_json = json!({
        "steps": [],
        "continue": true,
        "stop_on_error": false
    });

    let args: ExecuteSequenceArgs = serde_json::from_value(args_json).unwrap();
    assert_eq!(args.r#continue, Some(true));
    assert_eq!(args.stop_on_error, Some(false));
    // The implementation should prefer 'continue' over 'stop_on_error'
}

#[test]
fn test_both_verbosity_and_include_detailed() {
    // Test what happens when both fields are provided
    let args_json = json!({
        "steps": [],
        "verbosity": "quiet",
        "include_detailed_results": true
    });

    let args: ExecuteSequenceArgs = serde_json::from_value(args_json).unwrap();
    assert_eq!(args.verbosity, Some("quiet".to_string()));
    assert_eq!(args.include_detailed_results, Some(true));
    // The implementation should prefer 'verbosity' over 'include_detailed_results'
}

#[test]
fn test_complex_workflow_with_all_new_fields() {
    // Test a complete workflow using all new simplified fields
    let workflow = json!({
        "steps": [
            {
                "tool_name": "click_element",
                "arguments": {
                    "selector": "button|Submit"
                },
                "delay": "500ms"
            },
            {
                "tool_name": "type_text",
                "arguments": {
                    "text": "Hello World"
                },
                "delay": "1s"
            }
        ],
        "continue": false,
        "verbosity": "verbose",
        "output": "return { success: true, data: context };"
    });

    let args: ExecuteSequenceArgs = serde_json::from_value(workflow).unwrap();
    assert_eq!(args.r#continue, Some(false));
    assert_eq!(args.verbosity, Some("verbose".to_string()));
    assert!(args.output.is_some());
    assert_eq!(args.steps.as_ref().unwrap().len(), 2);
    assert_eq!(
        args.steps.as_ref().unwrap()[0].delay,
        Some("500ms".to_string())
    );
    assert_eq!(
        args.steps.as_ref().unwrap()[1].delay,
        Some("1s".to_string())
    );
}

#[test]
fn test_mixed_old_and_new_syntax() {
    // Test mixing old and new syntax in the same workflow
    let workflow = json!({
        "steps": [
            {
                "tool_name": "tool1",
                "arguments": {},
                "delay_ms": 1000  // Old syntax
            },
            {
                "tool_name": "tool2",
                "arguments": {},
                "delay": "2s"  // New syntax
            }
        ],
        "stop_on_error": true,  // Old syntax
        "output": {  // New syntax
            "run": "return { done: true };"
        }
    });

    let args: ExecuteSequenceArgs = serde_json::from_value(workflow).unwrap();
    assert_eq!(args.stop_on_error, Some(true));
    assert!(args.r#continue.is_none());
    assert!(args.output.is_some());
    assert_eq!(args.steps.as_ref().unwrap()[0].delay_ms, Some(1000));
    assert_eq!(
        args.steps.as_ref().unwrap()[1].delay,
        Some("2s".to_string())
    );
}
