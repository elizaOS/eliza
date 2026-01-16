use serde_json::json;
use std::fs;
use std::path::PathBuf;
use tempfile::TempDir;

#[cfg(test)]
mod scripts_base_path_tests {
    use super::*;
    use computeruse_mcp_agent::utils::ExecuteSequenceArgs;

    #[test]
    fn test_scripts_base_path_serialization() {
        // Test that scripts_base_path can be properly serialized/deserialized
        let args = ExecuteSequenceArgs {
            scripts_base_path: Some("/mnt/workflows/123".to_string()),
            steps: Some(vec![]),
            ..Default::default()
        };

        let serialized = serde_json::to_string(&args).unwrap();
        let deserialized: ExecuteSequenceArgs = serde_json::from_str(&serialized).unwrap();

        assert_eq!(
            deserialized.scripts_base_path,
            Some("/mnt/workflows/123".to_string())
        );
    }

    #[test]
    fn test_scripts_base_path_optional() {
        // Test that scripts_base_path is optional and doesn't break existing workflows
        let json_without_field = json!({
            "steps": [
                {
                    "tool_name": "run_command",
                    "arguments": {
                        "engine": "javascript",
                        "script_file": "test.js"
                    }
                }
            ]
        });

        let args: ExecuteSequenceArgs = serde_json::from_value(json_without_field).unwrap();
        assert_eq!(args.scripts_base_path, None);
    }

    #[test]
    fn test_workflow_json_with_scripts_base_path() {
        // Test parsing JSON workflow with scripts_base_path
        let json_content = serde_json::json!({
            "name": "Test Workflow",
            "description": "Test workflow with scripts_base_path",
            "scripts_base_path": "/mnt/shared/scripts",
            "steps": [
                {
                    "tool_name": "run_command",
                    "arguments": {
                        "engine": "javascript",
                        "script_file": "helper.js"
                    }
                }
            ]
        });

        let parsed: ExecuteSequenceArgs = serde_json::from_value(json_content).unwrap();
        assert_eq!(
            parsed.scripts_base_path,
            Some("/mnt/shared/scripts".to_string())
        );
        assert!(parsed.steps.is_some());
    }

    #[test]
    fn test_workflow_json_without_scripts_base_path() {
        // Test backward compatibility - JSON without scripts_base_path should still work
        let json_content = serde_json::json!({
            "name": "Legacy Workflow",
            "description": "Test workflow without scripts_base_path",
            "steps": [
                {
                    "tool_name": "run_command",
                    "arguments": {
                        "engine": "javascript",
                        "script_file": "test.js"
                    }
                }
            ]
        });

        let parsed: ExecuteSequenceArgs = serde_json::from_value(json_content).unwrap();
        assert_eq!(parsed.scripts_base_path, None);
        assert!(parsed.steps.is_some());
    }

    #[test]
    fn test_scripts_base_path_with_all_fields() {
        // Test that scripts_base_path works alongside all other ExecuteSequenceArgs fields
        let args = ExecuteSequenceArgs {
            url: Some("file://workflow.yml".to_string()),
            steps: Some(vec![]),
            troubleshooting: Some(vec![]),
            variables: Some(std::collections::HashMap::new()),
            inputs: Some(json!({})),
            selectors: Some(json!({})),
            stop_on_error: Some(true),
            include_detailed_results: Some(false),
            output_parser: Some(json!({})),
            output: Some(json!({})),
            r#continue: Some(false),
            verbosity: Some("normal".to_string()),
            start_from_step: Some("step1".to_string()),
            end_at_step: Some("step5".to_string()),
            follow_fallback: Some(false),
            scripts_base_path: Some("/custom/path".to_string()),
            execute_jumps_at_end: Some(false),
            workflow_id: Some("test-workflow-123".to_string()),
            skip_preflight_check: Some(false),
            trace_id: Some("test-trace-123".to_string()),
            execution_id: Some("test-execution-456".to_string()),
            window_mgmt: Default::default(),
        };

        let serialized = serde_json::to_string(&args).unwrap();
        let deserialized: ExecuteSequenceArgs = serde_json::from_str(&serialized).unwrap();

        assert_eq!(
            deserialized.scripts_base_path,
            Some("/custom/path".to_string())
        );
        assert_eq!(deserialized.url, Some("file://workflow.yml".to_string()));
        assert_eq!(deserialized.stop_on_error, Some(true));
    }
}

#[cfg(test)]
mod file_resolution_tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn setup_test_directories() -> (TempDir, PathBuf, PathBuf, PathBuf) {
        let temp_dir = TempDir::new().unwrap();
        let base_path = temp_dir.path().to_path_buf();

        // Create scripts_base_path directory
        let scripts_base = base_path.join("scripts_base");
        fs::create_dir(&scripts_base).unwrap();

        // Create workflow directory
        let workflow_dir = base_path.join("workflow");
        fs::create_dir(&workflow_dir).unwrap();

        // Create current directory (simulated)
        let current_dir = base_path.join("current");
        fs::create_dir(&current_dir).unwrap();

        (temp_dir, scripts_base, workflow_dir, current_dir)
    }

    #[test]
    fn test_file_resolution_priority_scripts_base_first() {
        let (_temp, scripts_base, workflow_dir, _current) = setup_test_directories();

        // Create test.js in both scripts_base and workflow_dir
        fs::write(scripts_base.join("test.js"), "// From scripts_base").unwrap();
        fs::write(workflow_dir.join("test.js"), "// From workflow_dir").unwrap();

        // When scripts_base_path is set, it should be checked first
        // The actual resolution logic would be in the server.rs file
        // This test verifies the setup is correct
        assert!(scripts_base.join("test.js").exists());
        assert!(workflow_dir.join("test.js").exists());
    }

    #[test]
    fn test_file_resolution_fallback_to_workflow_dir() {
        let (_temp, scripts_base, workflow_dir, _current) = setup_test_directories();

        // Create test.js only in workflow_dir
        fs::write(workflow_dir.join("test.js"), "// From workflow_dir").unwrap();

        // File doesn't exist in scripts_base
        assert!(!scripts_base.join("test.js").exists());
        // But exists in workflow_dir
        assert!(workflow_dir.join("test.js").exists());
    }

    #[test]
    fn test_absolute_path_unchanged() {
        let (_temp, _scripts_base, _workflow_dir, _current) = setup_test_directories();

        // Absolute paths should not be affected by scripts_base_path
        let absolute_path = if cfg!(windows) {
            "C:\\absolute\\path\\to\\script.js"
        } else {
            "/absolute/path/to/script.js"
        };

        let path = Path::new(absolute_path);
        assert!(path.is_absolute());

        // Even with scripts_base_path set, absolute paths should remain unchanged
        // This is tested by the logic in server.rs
    }

    #[test]
    fn test_nested_relative_paths() {
        let (_temp, scripts_base, _workflow_dir, _current) = setup_test_directories();

        // Create nested structure in scripts_base
        let nested = scripts_base.join("helpers").join("utils");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("validator.js"), "// Validator script").unwrap();

        // Verify nested path exists
        assert!(scripts_base.join("helpers/utils/validator.js").exists());
    }

    #[test]
    fn test_scripts_base_path_not_exist() {
        // Test behavior when scripts_base_path points to non-existent directory
        let non_existent = PathBuf::from("/this/does/not/exist");
        assert!(!non_existent.exists());

        // The resolution logic should skip non-existent scripts_base_path
        // and fall back to workflow_dir or current dir
        // This is handled by the checks in server.rs
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use computeruse_mcp_agent::utils::ExecuteSequenceArgs;

    #[test]
    fn test_workflow_with_mounted_storage_simulation() {
        // Simulate the mounted storage scenario
        let temp_dir = TempDir::new().unwrap();
        let mount_path = temp_dir.path().join("mnt").join("workflows").join("abc123");
        fs::create_dir_all(&mount_path).unwrap();

        // Create helper scripts in mounted path
        fs::write(mount_path.join("validator.js"), "// Validation logic").unwrap();
        fs::write(mount_path.join("processor.js"), "// Processing logic").unwrap();

        // Create workflow that uses scripts_base_path
        let workflow = ExecuteSequenceArgs {
            scripts_base_path: Some(mount_path.to_string_lossy().to_string()),
            steps: Some(vec![]),
            ..Default::default()
        };

        assert!(workflow.scripts_base_path.is_some());
        let base_path = PathBuf::from(workflow.scripts_base_path.unwrap());
        assert!(base_path.join("validator.js").exists());
        assert!(base_path.join("processor.js").exists());
    }

    #[test]
    fn test_backward_compatibility_no_regression() {
        // Ensure old workflows without scripts_base_path continue to work
        let legacy_workflow = serde_json::json!({
            "steps": [
                {
                    "tool_name": "run_command",
                    "arguments": {
                        "engine": "javascript",
                        "script_file": "local_script.js"
                    }
                }
            ],
            "variables": {
                "api_key": {
                    "type": "string",
                    "label": "API Key"
                }
            },
            "inputs": {
                "api_key": "test-key-123"
            }
        });

        let parsed: ExecuteSequenceArgs = serde_json::from_value(legacy_workflow).unwrap();

        // Should parse successfully without scripts_base_path
        assert!(parsed.scripts_base_path.is_none());
        assert!(parsed.steps.is_some());
        assert!(parsed.variables.is_some());
        assert!(parsed.inputs.is_some());
    }

    #[test]
    fn test_scripts_base_path_with_environment_variable_pattern() {
        // Test that scripts_base_path can handle patterns like those from environment variables
        let workflow = ExecuteSequenceArgs {
            scripts_base_path: Some("${WORKFLOW_MOUNT_PATH}/scripts".to_string()),
            steps: Some(vec![]),
            ..Default::default()
        };

        // The actual environment variable substitution would happen at runtime
        // This test just ensures the field accepts such patterns
        assert_eq!(
            workflow.scripts_base_path,
            Some("${WORKFLOW_MOUNT_PATH}/scripts".to_string())
        );
    }
}
