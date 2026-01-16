// Example demonstrating OpenTelemetry integration
// Run with: cargo run --example test_telemetry --features telemetry

#[cfg(feature = "telemetry")]
use computeruse_mcp_agent::telemetry::{StepSpan, WorkflowSpan};

#[cfg(feature = "telemetry")]
#[tokio::main]
async fn main() {
    // Disable actual network calls for demo
    std::env::set_var("OTEL_SDK_DISABLED", "true");

    // Initialize telemetry
    if let Err(e) = computeruse_mcp_agent::telemetry::init_telemetry() {
        eprintln!("Failed to initialize telemetry: {e}");
        return;
    }

    println!("OpenTelemetry integration test");
    println!("================================");

    // Simulate a workflow execution
    let mut workflow = WorkflowSpan::new("example_workflow");
    workflow.set_attribute("workflow_file", "examples/test.yml".to_string());
    workflow.set_attribute("total_steps", "3".to_string());

    println!("Starting workflow: example_workflow");

    // Step 1: Navigate
    {
        let mut step = StepSpan::new("navigate", Some("nav_001"));
        step.set_attribute("url", "https://example.com".to_string());
        println!("  Step 1: Navigating to https://example.com");
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        step.set_status(true, None);
        step.end();
        println!("  ✓ Navigation complete");
    }

    // Step 2: Type text
    {
        let mut step = StepSpan::new("type_text", Some("type_002"));
        step.set_attribute("selector", "#search".to_string());
        step.set_attribute("text", "OpenTelemetry test".to_string());
        println!("  Step 2: Typing text into #search");
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        step.set_status(true, None);
        step.end();
        println!("  ✓ Text typed successfully");
    }

    // Step 3: Click (fails)
    {
        let mut step = StepSpan::new("click", Some("click_003"));
        step.set_attribute("selector", "#nonexistent".to_string());
        println!("  Step 3: Clicking #nonexistent");
        tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
        let error = "Element not found: #nonexistent";
        step.set_status(false, Some(error));
        step.end();
        println!("  ✗ Click failed: {error}");
    }

    // Add workflow event
    workflow.add_event(
        "workflow_failed",
        vec![
            ("failed_at_step", "3".to_string()),
            ("error", "Element not found".to_string()),
        ],
    );

    // Mark workflow as failed
    workflow.set_status(false, "Workflow failed at step 3: Element not found");
    workflow.end();

    println!("\nWorkflow completed with errors");
    println!("Total duration: ~300ms");

    // Shutdown telemetry
    computeruse_mcp_agent::telemetry::shutdown_telemetry();

    println!("\nTelemetry test completed successfully!");
    println!("When OTEL_SDK_DISABLED is not set, traces would be sent to:");
    println!("  OTEL_EXPORTER_OTLP_ENDPOINT (default: http://localhost:4318)");
}

#[cfg(not(feature = "telemetry"))]
fn main() {
    println!("This example requires the 'telemetry' feature.");
    println!("Run with: cargo run --example test_telemetry --features telemetry");
}
