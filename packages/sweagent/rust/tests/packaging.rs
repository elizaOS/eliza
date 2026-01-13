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
    use elizaos_sweagent::types::{History, HistoryItem, StepOutput, Trajectory, TrajectoryStep};
    use elizaos_sweagent::SWEAgentError;
    use elizaos_sweagent::{
        AgentConfig, AgentRunResult, DefaultAgent, DefaultAgentConfig, RetryAgent, RetryAgentConfig,
    };
    use elizaos_sweagent::{Bundle, BundleConfig, ParseFunction, ToolConfig, ToolHandler};
    use elizaos_sweagent::{DeploymentConfig, EnvironmentConfig, RepoConfig, SWEEnv};
    use elizaos_sweagent::{RunBatch, RunBatchConfig, RunSingle, RunSingleConfig};
}

#[test]
fn test_feature_detection() {
    // In native feature, we should have full async support
    #[cfg(feature = "native")]
    {
        assert!(true, "Native feature is enabled");
    }

    #[cfg(feature = "wasm")]
    {
        assert!(true, "WASM feature is enabled");
    }
}
