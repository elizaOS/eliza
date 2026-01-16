#[cfg(test)]
mod telemetry_tests {
    use computeruse_mcp_agent::telemetry::{StepSpan, WorkflowSpan};

    #[test]
    fn test_workflow_span_creation() {
        // Test that WorkflowSpan can be created without panicking
        let mut span = WorkflowSpan::new("test_workflow");

        // Test setting attributes
        span.set_attribute("test_key", "test_value".to_string());

        // Test adding events
        span.add_event(
            "test_event",
            vec![
                ("event_attr1", "value1".to_string()),
                ("event_attr2", "value2".to_string()),
            ],
        );

        // Test setting status - success case
        span.set_status(true, "Workflow completed successfully");

        // End the span
        span.end();
    }

    #[test]
    fn test_workflow_span_with_failure() {
        let mut span = WorkflowSpan::new("failing_workflow");

        // Test setting failure status
        span.set_status(false, "Workflow failed due to error");

        span.end();
    }

    #[test]
    fn test_step_span_creation() {
        // Test StepSpan without ID
        let mut span = StepSpan::new("screenshot", None);
        span.set_attribute("resolution", "1920x1080".to_string());
        span.set_status(true, None);
        span.end();

        // Test StepSpan with ID
        let mut span_with_id = StepSpan::new("click", Some("step_123"));
        span_with_id.set_attribute("target", "button.submit".to_string());
        span_with_id.set_status(false, Some("Element not found"));
        span_with_id.end();
    }

    #[tokio::test]
    async fn test_telemetry_initialization() {
        // Disable SDK for testing to avoid network calls
        // Skip collector check to avoid network calls and timeouts in CI
        std::env::set_var("OTEL_SKIP_COLLECTOR_CHECK", "true");
        std::env::set_var("OTEL_RETRY_DURATION_MINS", "0");
        std::env::set_var("OTEL_SDK_DISABLED", "true");

        // Test that init_telemetry doesn't panic
        let result = computeruse_mcp_agent::telemetry::init_telemetry();

        // Should succeed (or at least not panic)
        assert!(
            result.is_ok(),
            "Telemetry initialization failed: {result:?}"
        );

        // Test shutdown
        computeruse_mcp_agent::telemetry::shutdown_telemetry();
    }

    #[test]
    fn test_multiple_spans_lifecycle() {
        // Simulate a workflow with multiple steps
        let mut workflow = WorkflowSpan::new("complex_workflow");
        workflow.set_attribute("total_steps", "3".to_string());

        // Step 1
        let mut step1 = StepSpan::new("navigate", Some("nav_001"));
        step1.set_attribute("url", "https://example.com".to_string());
        step1.set_status(true, None);
        step1.end();

        // Step 2
        let mut step2 = StepSpan::new("type_text", Some("type_002"));
        step2.set_attribute("text", "test input".to_string());
        step2.set_status(true, None);
        step2.end();

        // Step 3 - fails
        let mut step3 = StepSpan::new("click", Some("click_003"));
        step3.set_attribute("selector", "#missing-element".to_string());
        step3.set_status(false, Some("Element not found"));
        step3.end();

        workflow.add_event(
            "workflow_failed",
            vec![
                ("failed_at_step", "3".to_string()),
                ("reason", "Element not found".to_string()),
            ],
        );
        workflow.set_status(false, "Workflow failed at step 3");
        workflow.end();
    }

    #[cfg(feature = "telemetry")]
    #[test]
    fn test_with_telemetry_enabled() {
        // This test only runs when telemetry feature is enabled
        use std::env;

        // Set environment to disable actual network calls during testing
        env::set_var("OTEL_SDK_DISABLED", "true");
        // Skip collector check to avoid network calls and timeouts in CI
        env::set_var("OTEL_SKIP_COLLECTOR_CHECK", "true");
        env::set_var("OTEL_RETRY_DURATION_MINS", "0");

        let result = computeruse_mcp_agent::telemetry::init_telemetry();
        assert!(result.is_ok());

        // Create spans - should use real OpenTelemetry implementation
        let mut workflow = WorkflowSpan::new("telemetry_enabled_test");
        workflow.set_attribute("feature", "telemetry".to_string());
        workflow.set_status(true, "Test completed");
        workflow.end();

        computeruse_mcp_agent::telemetry::shutdown_telemetry();
    }

    #[cfg(not(feature = "telemetry"))]
    #[test]
    fn test_without_telemetry() {
        // This test only runs when telemetry feature is disabled
        // All operations should be no-ops but not panic

        let result = computeruse_mcp_agent::telemetry::init_telemetry();
        assert!(result.is_ok());

        // Create spans - should use stub implementation
        let mut workflow = WorkflowSpan::new("telemetry_disabled_test");
        workflow.set_attribute("feature", "disabled".to_string());
        workflow.add_event("test_event", vec![]);
        workflow.set_status(true, "No-op test");
        workflow.end();

        let mut step = StepSpan::new("test_tool", Some("test_id"));
        step.set_attribute("test", "value".to_string());
        step.set_status(true, None);
        step.end();

        computeruse_mcp_agent::telemetry::shutdown_telemetry();
    }
}
