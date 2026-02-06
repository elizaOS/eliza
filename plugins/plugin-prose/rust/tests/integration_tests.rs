//! Integration tests for elizaos-plugin-prose
//!
//! Tests all 3 actions (PROSE_RUN, PROSE_COMPILE, PROSE_HELP),
//! the provider, ProseService creation/methods, types, and serde.

use elizaos_plugin_prose::*;
use serde_json::{json, Value};
use std::collections::HashMap;

// ===========================================================================
// Helper: build a message Value matching { content: { text: "..." } }
// ===========================================================================

fn make_message(text: &str) -> Value {
    json!({
        "id": "test-message-id",
        "content": { "text": text },
        "userId": "test-user",
        "roomId": "test-room"
    })
}

fn empty_state() -> Value {
    json!({})
}

// ===========================================================================
// Types — construction and serde
// ===========================================================================

#[cfg(test)]
mod type_tests {
    use super::*;

    #[test]
    fn prose_state_mode_as_str() {
        assert_eq!(ProseStateMode::Filesystem.as_str(), "filesystem");
        assert_eq!(ProseStateMode::InContext.as_str(), "in-context");
        assert_eq!(ProseStateMode::Sqlite.as_str(), "sqlite");
        assert_eq!(ProseStateMode::Postgres.as_str(), "postgres");
    }

    #[test]
    fn prose_state_mode_display() {
        assert_eq!(format!("{}", ProseStateMode::Filesystem), "filesystem");
        assert_eq!(format!("{}", ProseStateMode::InContext), "in-context");
    }

    #[test]
    fn prose_state_mode_default() {
        let mode: ProseStateMode = Default::default();
        assert_eq!(mode, ProseStateMode::Filesystem);
    }

    #[test]
    fn prose_state_mode_serde_roundtrip() {
        let mode = ProseStateMode::InContext;
        let serialized = serde_json::to_string(&mode).unwrap();
        assert_eq!(serialized, "\"in-context\"");
        let deserialized: ProseStateMode = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized, mode);
    }

    #[test]
    fn prose_state_mode_serde_all_variants() {
        for (mode, expected) in [
            (ProseStateMode::Filesystem, "\"filesystem\""),
            (ProseStateMode::InContext, "\"in-context\""),
            (ProseStateMode::Sqlite, "\"sqlite\""),
            (ProseStateMode::Postgres, "\"postgres\""),
        ] {
            let json = serde_json::to_string(&mode).unwrap();
            assert_eq!(json, expected);
            let back: ProseStateMode = serde_json::from_str(&json).unwrap();
            assert_eq!(back, mode);
        }
    }

    #[test]
    fn prose_run_options_serde() {
        let opts = ProseRunOptions {
            file: "workflow.prose".to_string(),
            state_mode: ProseStateMode::Sqlite,
            inputs_json: Some(r#"{"key":"val"}"#.to_string()),
            cwd: Some("/tmp".to_string()),
        };
        let json = serde_json::to_string(&opts).unwrap();
        let back: ProseRunOptions = serde_json::from_str(&json).unwrap();
        assert_eq!(back.file, "workflow.prose");
        assert_eq!(back.state_mode, ProseStateMode::Sqlite);
        assert_eq!(back.inputs_json.as_deref(), Some(r#"{"key":"val"}"#));
        assert_eq!(back.cwd.as_deref(), Some("/tmp"));
    }

    #[test]
    fn prose_run_options_default_state_mode() {
        let json = r#"{"file":"test.prose"}"#;
        let opts: ProseRunOptions = serde_json::from_str(json).unwrap();
        assert_eq!(opts.state_mode, ProseStateMode::Filesystem);
    }

    #[test]
    fn prose_compile_options_serde() {
        let opts = ProseCompileOptions {
            file: "test.prose".to_string(),
        };
        let json = serde_json::to_string(&opts).unwrap();
        let back: ProseCompileOptions = serde_json::from_str(&json).unwrap();
        assert_eq!(back.file, "test.prose");
    }

    #[test]
    fn prose_run_result_success() {
        let result = ProseRunResult::success("run-123".to_string(), None);
        assert!(result.success);
        assert_eq!(result.run_id.as_deref(), Some("run-123"));
        assert!(result.error.is_none());
    }

    #[test]
    fn prose_run_result_error() {
        let result = ProseRunResult::error("File not found");
        assert!(!result.success);
        assert!(result.run_id.is_none());
        assert_eq!(result.error.as_deref(), Some("File not found"));
    }

    #[test]
    fn prose_run_result_serde() {
        let result = ProseRunResult::success(
            "run-123".to_string(),
            Some(HashMap::from([("key".to_string(), json!("value"))])),
        );
        let json = serde_json::to_string(&result).unwrap();
        let back: ProseRunResult = serde_json::from_str(&json).unwrap();
        assert!(back.success);
        assert_eq!(back.outputs.unwrap()["key"], json!("value"));
    }

    #[test]
    fn prose_compile_result_valid() {
        let result = ProseCompileResult::valid();
        assert!(result.valid);
        assert!(result.errors.is_empty());
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn prose_compile_result_invalid() {
        let result = ProseCompileResult::invalid(
            vec!["Missing program".to_string()],
            vec!["No version".to_string()],
        );
        assert!(!result.valid);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.warnings.len(), 1);
    }

    #[test]
    fn prose_compile_result_serde() {
        let result = ProseCompileResult::invalid(
            vec!["err".to_string()],
            vec!["warn".to_string()],
        );
        let json = serde_json::to_string(&result).unwrap();
        let back: ProseCompileResult = serde_json::from_str(&json).unwrap();
        assert!(!back.valid);
        assert_eq!(back.errors, vec!["err"]);
        assert_eq!(back.warnings, vec!["warn"]);
    }

    #[test]
    fn prose_skill_file_construction() {
        let sf = ProseSkillFile {
            name: "prose.md".to_string(),
            path: "prose.md".to_string(),
            content: "# content".to_string(),
        };
        assert_eq!(sf.name, "prose.md");
        assert_eq!(sf.content, "# content");
    }

    #[test]
    fn prose_skill_file_serde() {
        let sf = ProseSkillFile {
            name: "help.md".to_string(),
            path: "/skills/help.md".to_string(),
            content: "# Help".to_string(),
        };
        let json = serde_json::to_string(&sf).unwrap();
        let back: ProseSkillFile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, "help.md");
        assert_eq!(back.path, "/skills/help.md");
    }

    #[test]
    fn prose_config_defaults() {
        let config = ProseConfig::default();
        assert_eq!(config.workspace_dir, ".prose");
        assert_eq!(config.default_state_mode, ProseStateMode::Filesystem);
        assert!(config.skills_dir.is_none());
    }

    #[test]
    fn prose_config_builder() {
        let config = ProseConfigBuilder::new()
            .workspace_dir("custom/.prose")
            .default_state_mode(ProseStateMode::Sqlite)
            .skills_dir("/opt/skills")
            .build();

        assert_eq!(config.workspace_dir, "custom/.prose");
        assert_eq!(config.default_state_mode, ProseStateMode::Sqlite);
        assert_eq!(config.skills_dir.as_deref(), Some("/opt/skills"));
    }

    #[test]
    fn prose_config_builder_defaults() {
        let config = ProseConfigBuilder::new().build();
        assert_eq!(config.workspace_dir, ".prose");
        assert_eq!(config.default_state_mode, ProseStateMode::Filesystem);
        assert!(config.skills_dir.is_none());
    }
}

// ===========================================================================
// Action specs
// ===========================================================================

#[cfg(test)]
mod spec_tests {
    use elizaos_plugin_prose::generated::specs::{require_action_spec, ACTION_SPECS};

    #[test]
    fn prose_run_spec_exists() {
        let spec = ACTION_SPECS.get("PROSE_RUN").expect("PROSE_RUN spec missing");
        assert_eq!(spec.name, "PROSE_RUN");
        assert!(spec.description.contains("OpenProse"));
    }

    #[test]
    fn prose_compile_spec_exists() {
        let spec = ACTION_SPECS
            .get("PROSE_COMPILE")
            .expect("PROSE_COMPILE spec missing");
        assert_eq!(spec.name, "PROSE_COMPILE");
        assert!(spec.description.contains("Validate"));
    }

    #[test]
    fn prose_help_spec_exists() {
        let spec = ACTION_SPECS
            .get("PROSE_HELP")
            .expect("PROSE_HELP spec missing");
        assert_eq!(spec.name, "PROSE_HELP");
        assert!(spec.description.to_lowercase().contains("help"));
    }

    #[test]
    fn require_action_spec_found() {
        let spec = require_action_spec("PROSE_RUN");
        assert_eq!(spec.name, "PROSE_RUN");
    }

    #[test]
    #[should_panic(expected = "Action spec not found")]
    fn require_action_spec_unknown_panics() {
        require_action_spec("UNKNOWN_ACTION");
    }

    #[test]
    fn all_specs_have_similes() {
        for (name, spec) in ACTION_SPECS.iter() {
            assert!(!spec.similes.is_empty(), "{} has no similes", name);
        }
    }

    #[test]
    fn all_specs_have_examples() {
        for (name, spec) in ACTION_SPECS.iter() {
            assert!(!spec.examples.is_empty(), "{} has no examples", name);
        }
    }
}

// ===========================================================================
// ProseRunAction
// ===========================================================================

#[cfg(test)]
mod run_action_tests {
    use super::*;

    #[test]
    fn metadata() {
        let action = ProseRunAction::new();
        assert_eq!(action.name(), "PROSE_RUN");
        assert!(!action.description().is_empty());
        assert!(!action.similes().is_empty());
        assert!(!action.examples().is_empty());
    }

    #[tokio::test]
    async fn validate_prose_run() {
        let action = ProseRunAction::new();
        let msg = make_message("prose run workflow.prose");
        assert!(action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_run_with_prose_file() {
        let action = ProseRunAction::new();
        let msg = make_message("run my-workflow.prose");
        assert!(action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_execute_with_prose() {
        let action = ProseRunAction::new();
        let msg = make_message("execute test.prose");
        assert!(action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_case_insensitive() {
        let action = ProseRunAction::new();
        let msg = make_message("PROSE RUN workflow.prose");
        assert!(action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_unrelated_false() {
        let action = ProseRunAction::new();
        let msg = make_message("what is the weather today?");
        assert!(!action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_empty_false() {
        let action = ProseRunAction::new();
        let msg = make_message("");
        assert!(!action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn handler_no_service_returns_error() {
        let action = ProseRunAction::new();
        let msg = make_message("prose run workflow.prose");
        let result = action.handler(&msg, &empty_state(), None).await;
        assert!(!result.success);
    }

    #[tokio::test]
    async fn handler_no_file_returns_error() {
        let action = ProseRunAction::new();
        let msg = make_message("prose run");
        let mut svc = ProseService::with_defaults();
        let result = action.handler(&msg, &empty_state(), Some(&mut svc)).await;
        // "prose run" alone has no file extracted, so it errors
        assert!(!result.success);
        assert!(result.text.to_lowercase().contains("specify") || result.text.to_lowercase().contains("service"));
    }
}

// ===========================================================================
// ProseCompileAction
// ===========================================================================

#[cfg(test)]
mod compile_action_tests {
    use super::*;

    #[test]
    fn metadata() {
        let action = ProseCompileAction::new();
        assert_eq!(action.name(), "PROSE_COMPILE");
        assert!(!action.description().is_empty());
        assert!(!action.similes().is_empty());
    }

    #[tokio::test]
    async fn validate_prose_compile() {
        let action = ProseCompileAction::new();
        let msg = make_message("prose compile workflow.prose");
        assert!(action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_prose_validate() {
        let action = ProseCompileAction::new();
        let msg = make_message("prose validate test.prose");
        assert!(action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_check_prose() {
        let action = ProseCompileAction::new();
        let msg = make_message("check my-workflow.prose");
        assert!(action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_validate_prose() {
        let action = ProseCompileAction::new();
        let msg = make_message("validate my-workflow.prose");
        assert!(action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_unrelated_false() {
        let action = ProseCompileAction::new();
        let msg = make_message("what is the weather today?");
        assert!(!action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_empty_false() {
        let action = ProseCompileAction::new();
        let msg = make_message("");
        assert!(!action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn handler_no_service_returns_error() {
        let action = ProseCompileAction::new();
        let msg = make_message("prose compile workflow.prose");
        let result = action.handler(&msg, &empty_state(), None).await;
        assert!(!result.success);
    }

    #[tokio::test]
    async fn handler_no_file_returns_error() {
        let action = ProseCompileAction::new();
        let msg = make_message("prose compile");
        let result = action.handler(&msg, &empty_state(), None).await;
        assert!(!result.success);
        assert!(result.text.to_lowercase().contains("specify"));
    }
}

// ===========================================================================
// ProseHelpAction
// ===========================================================================

#[cfg(test)]
mod help_action_tests {
    use super::*;

    #[test]
    fn metadata() {
        let action = ProseHelpAction::new();
        assert_eq!(action.name(), "PROSE_HELP");
        assert!(!action.description().is_empty());
        assert!(!action.similes().is_empty());
    }

    #[tokio::test]
    async fn validate_prose_help() {
        let action = ProseHelpAction::new();
        let msg = make_message("prose help");
        assert!(action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_prose_examples() {
        let action = ProseHelpAction::new();
        let msg = make_message("prose examples");
        assert!(action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_prose_syntax() {
        let action = ProseHelpAction::new();
        let msg = make_message("prose syntax");
        assert!(action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_how_to_write() {
        let action = ProseHelpAction::new();
        let msg = make_message("how do I write a prose program?");
        assert!(action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_what_is_openprose() {
        let action = ProseHelpAction::new();
        let msg = make_message("what is openprose?");
        assert!(action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_tutorial() {
        let action = ProseHelpAction::new();
        let msg = make_message("openprose tutorial");
        assert!(action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_unrelated_false() {
        let action = ProseHelpAction::new();
        let msg = make_message("what is the weather today?");
        assert!(!action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn validate_empty_false() {
        let action = ProseHelpAction::new();
        let msg = make_message("");
        assert!(!action.validate(&msg, &empty_state()).await);
    }

    #[tokio::test]
    async fn handler_quick_reference() {
        let action = ProseHelpAction::new();
        let msg = make_message("prose help");
        let result = action.handler(&msg, &empty_state(), None).await;
        assert!(result.success);
        assert!(result.text.contains("OpenProse"));
        assert!(result.text.contains("prose run"));
    }

    #[tokio::test]
    async fn handler_examples_request() {
        let action = ProseHelpAction::new();
        let msg = make_message("prose examples");
        let result = action.handler(&msg, &empty_state(), None).await;
        assert!(result.success);
        assert!(result.text.contains("Example"));
    }

    #[tokio::test]
    async fn handler_returns_data() {
        let action = ProseHelpAction::new();
        let msg = make_message("prose help");
        let result = action.handler(&msg, &empty_state(), None).await;
        assert!(result.data.is_some());
    }
}

// ===========================================================================
// ProseProvider
// ===========================================================================

#[cfg(test)]
mod provider_tests {
    use super::*;

    #[test]
    fn metadata() {
        let provider = ProseProvider::new();
        assert_eq!(provider.name(), "prose");
        assert!(provider.description().contains("OpenProse"));
        assert_eq!(provider.position(), 100);
    }

    #[tokio::test]
    async fn non_prose_message_returns_available() {
        let provider = ProseProvider::new();
        let msg = make_message("hello world");
        let result = provider.get(&msg, &empty_state(), None).await;
        assert!(result.text.contains("OpenProse"));
        assert_eq!(result.values["available"], true);
    }

    #[tokio::test]
    async fn no_service_returns_unavailable_for_prose_cmd() {
        let provider = ProseProvider::new();
        let msg = make_message("prose run test.prose");
        let result = provider.get(&msg, &empty_state(), None).await;
        assert_eq!(result.values["available"], false);
    }

    #[tokio::test]
    async fn prose_help_with_service() {
        let provider = ProseProvider::new();
        let svc = ProseService::with_defaults();
        let msg = make_message("prose help");
        let result = provider.get(&msg, &empty_state(), Some(&svc)).await;
        assert_eq!(result.values["available"], true);
    }

    #[tokio::test]
    async fn prose_compile_with_service() {
        let provider = ProseProvider::new();
        let svc = ProseService::with_defaults();
        let msg = make_message("prose compile test.prose");
        let result = provider.get(&msg, &empty_state(), Some(&svc)).await;
        assert_eq!(result.values["available"], true);
        assert!(result.text.contains("OpenProse VM"));
    }

    #[tokio::test]
    async fn prose_run_with_service() {
        let provider = ProseProvider::new();
        let svc = ProseService::with_defaults();
        let msg = make_message("prose run test.prose");
        let result = provider.get(&msg, &empty_state(), Some(&svc)).await;
        assert_eq!(result.values["available"], true);
        assert!(result.text.contains("OpenProse VM"));
    }

    #[tokio::test]
    async fn invalid_state_mode_falls_back() {
        let provider = ProseProvider::new();
        let svc = ProseService::with_defaults();
        let msg = make_message("prose run test.prose");
        let state = json!({ "proseStateMode": "nonexistent" });
        let result = provider.get(&msg, &state, Some(&svc)).await;
        // Should fall back to filesystem without panicking
        assert_eq!(result.values["available"], true);
    }
}

// ===========================================================================
// ProseService
// ===========================================================================

#[cfg(test)]
mod service_tests {
    use super::*;

    #[test]
    fn creation_with_defaults() {
        let svc = ProseService::with_defaults();
        // No skill files loaded, all specs return None
        assert!(svc.get_vm_spec().is_none());
        assert!(svc.get_skill_spec().is_none());
        assert!(svc.get_help().is_none());
        assert!(svc.get_compiler_spec().is_none());
    }

    #[test]
    fn creation_with_config() {
        let config = ProseConfigBuilder::new()
            .workspace_dir("custom/.prose")
            .default_state_mode(ProseStateMode::Sqlite)
            .build();
        let svc = ProseService::new(config);
        assert!(svc.get_vm_spec().is_none());
    }

    #[test]
    fn build_vm_context_contains_banner() {
        let svc = ProseService::with_defaults();
        let context = svc.build_vm_context(ProseStateMode::Filesystem, false, false);
        assert!(context.contains("OpenProse VM"));
    }

    #[test]
    fn build_vm_context_with_compiler() {
        // Inject stub content
        let mut skills = HashMap::new();
        skills.insert("compiler.md".to_string(), "# Compiler Spec".to_string());
        set_skill_content(skills);

        let svc = ProseService::with_defaults();
        let context = svc.build_vm_context(ProseStateMode::Filesystem, true, false);
        assert!(context.contains("Compiler"));

        // Cleanup
        set_skill_content(HashMap::new());
    }

    #[test]
    fn build_vm_context_with_guidance() {
        let mut skills = HashMap::new();
        skills.insert(
            "guidance/patterns.md".to_string(),
            "# Patterns".to_string(),
        );
        skills.insert(
            "guidance/antipatterns.md".to_string(),
            "# Antipatterns".to_string(),
        );
        set_skill_content(skills);

        let svc = ProseService::with_defaults();
        let context = svc.build_vm_context(ProseStateMode::Filesystem, false, true);
        assert!(context.contains("Authoring Patterns"));
        assert!(context.contains("Authoring Antipatterns"));

        set_skill_content(HashMap::new());
    }

    #[test]
    fn get_authoring_guidance_empty() {
        set_skill_content(HashMap::new());
        let svc = ProseService::with_defaults();
        let (patterns, antipatterns) = svc.get_authoring_guidance();
        assert!(patterns.is_none());
        assert!(antipatterns.is_none());
    }

    #[test]
    fn get_loaded_skills_empty() {
        set_skill_content(HashMap::new());
        let svc = ProseService::with_defaults();
        let skills = svc.get_loaded_skills();
        assert!(skills.is_empty());
    }

    #[test]
    fn get_loaded_skills_populated() {
        let mut map = HashMap::new();
        map.insert("prose.md".to_string(), "# VM".to_string());
        map.insert("help.md".to_string(), "# Help".to_string());
        set_skill_content(map);

        let svc = ProseService::with_defaults();
        let skills = svc.get_loaded_skills();
        assert_eq!(skills.len(), 2);
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"prose.md"));
        assert!(names.contains(&"help.md"));

        set_skill_content(HashMap::new());
    }

    #[test]
    fn set_and_get_skill_content_roundtrip() {
        let mut map = HashMap::new();
        map.insert("test.md".to_string(), "test content".to_string());
        set_skill_content(map.clone());

        let result = get_skill_content();
        assert_eq!(result, map);

        set_skill_content(HashMap::new());
    }

    #[tokio::test]
    async fn file_exists_false_for_nonexistent() {
        let svc = ProseService::with_defaults();
        assert!(!svc.file_exists("/nonexistent/path/test.prose").await);
    }

    #[tokio::test]
    async fn ensure_workspace_creates_dirs() {
        let tmpdir = tempfile::tempdir().unwrap();
        let svc = ProseService::with_defaults();
        let ws = svc
            .ensure_workspace(tmpdir.path().to_str().unwrap())
            .await
            .unwrap();

        let ws_path = std::path::Path::new(&ws);
        assert!(ws_path.exists());
        assert!(ws_path.join("runs").exists());
        assert!(ws_path.join("agents").exists());
    }

    #[tokio::test]
    async fn create_run_directory_structure() {
        let tmpdir = tempfile::tempdir().unwrap();
        let svc = ProseService::with_defaults();
        let ws = svc
            .ensure_workspace(tmpdir.path().to_str().unwrap())
            .await
            .unwrap();

        let program = r#"program "test" version "1.0" { session main() {} }"#;
        let (run_id, run_dir) = svc.create_run_directory(&ws, program).await.unwrap();

        assert!(!run_id.is_empty());
        assert!(run_id.contains('-'));

        let run_path = std::path::Path::new(&run_dir);
        assert!(run_path.exists());
        assert!(run_path.join("program.prose").exists());
        assert!(run_path.join("state.md").exists());
        assert!(run_path.join("bindings").exists());
        assert!(run_path.join("agents").exists());
        assert!(run_path.join("imports").exists());

        // Verify written content
        let written = tokio::fs::read_to_string(run_path.join("program.prose"))
            .await
            .unwrap();
        assert_eq!(written, program);

        let state = tokio::fs::read_to_string(run_path.join("state.md"))
            .await
            .unwrap();
        assert!(state.contains(&run_id));
    }

    #[tokio::test]
    async fn list_examples_no_skills_dir() {
        let svc = ProseService::with_defaults();
        let examples = svc.list_examples().await;
        assert!(examples.is_empty());
    }

    #[tokio::test]
    async fn list_examples_with_files() {
        let tmpdir = tempfile::tempdir().unwrap();
        let examples_dir = tmpdir.path().join("examples");
        tokio::fs::create_dir_all(&examples_dir).await.unwrap();
        tokio::fs::write(examples_dir.join("hello.prose"), "program hello {}")
            .await
            .unwrap();
        tokio::fs::write(examples_dir.join("world.prose"), "program world {}")
            .await
            .unwrap();
        tokio::fs::write(examples_dir.join("readme.md"), "not a prose file")
            .await
            .unwrap();

        let config = ProseConfigBuilder::new()
            .skills_dir(tmpdir.path().to_str().unwrap())
            .build();
        let svc = ProseService::new(config);
        let mut examples = svc.list_examples().await;
        examples.sort();
        assert_eq!(examples, vec!["hello.prose", "world.prose"]);
    }

    #[tokio::test]
    async fn read_example_found() {
        let tmpdir = tempfile::tempdir().unwrap();
        let examples_dir = tmpdir.path().join("examples");
        tokio::fs::create_dir_all(&examples_dir).await.unwrap();
        tokio::fs::write(examples_dir.join("hello.prose"), "program hello {}")
            .await
            .unwrap();

        let config = ProseConfigBuilder::new()
            .skills_dir(tmpdir.path().to_str().unwrap())
            .build();
        let svc = ProseService::new(config);
        let content = svc.read_example("hello").await;
        assert_eq!(content.as_deref(), Some("program hello {}"));
    }

    #[tokio::test]
    async fn read_example_not_found() {
        let tmpdir = tempfile::tempdir().unwrap();
        let examples_dir = tmpdir.path().join("examples");
        tokio::fs::create_dir_all(&examples_dir).await.unwrap();

        let config = ProseConfigBuilder::new()
            .skills_dir(tmpdir.path().to_str().unwrap())
            .build();
        let svc = ProseService::new(config);
        let content = svc.read_example("nonexistent").await;
        assert!(content.is_none());
    }
}

// ===========================================================================
// Error types
// ===========================================================================

#[cfg(test)]
mod error_tests {
    use elizaos_plugin_prose::ProseError;

    #[test]
    fn error_display_file_not_found() {
        let err = ProseError::FileNotFound("test.prose".to_string());
        assert!(err.to_string().contains("test.prose"));
    }

    #[test]
    fn error_display_parse_error() {
        let err = ProseError::ParseError("bad syntax".to_string());
        assert!(err.to_string().contains("bad syntax"));
    }

    #[test]
    fn error_display_validation_error() {
        let err = ProseError::ValidationError("missing program".to_string());
        assert!(err.to_string().contains("missing program"));
    }

    #[test]
    fn error_from_io() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "not found");
        let prose_err: ProseError = io_err.into();
        assert!(prose_err.to_string().contains("not found"));
    }
}

// ===========================================================================
// Plugin-level exports
// ===========================================================================

#[cfg(test)]
mod plugin_tests {
    use elizaos_plugin_prose::*;

    #[test]
    fn plugin_constants() {
        assert_eq!(PLUGIN_NAME, "prose");
        assert!(PLUGIN_DESCRIPTION.contains("OpenProse"));
        assert!(!PLUGIN_VERSION.is_empty());
    }

    #[test]
    fn get_prose_actions_returns_three() {
        let actions = actions::get_prose_actions();
        assert_eq!(actions.len(), 3);
    }

    #[test]
    fn get_prose_providers_returns_one() {
        let providers = providers::get_prose_providers();
        assert_eq!(providers.len(), 1);
    }

    #[test]
    fn action_result_construction() {
        let result = ActionResult {
            success: true,
            text: "done".to_string(),
            data: Some(serde_json::json!({"key": "val"})),
            error: None,
        };
        assert!(result.success);
        assert_eq!(result.text, "done");
    }

    #[test]
    fn provider_result_construction() {
        let result = ProviderResult {
            values: serde_json::json!({"available": true}),
            text: "ready".to_string(),
            data: serde_json::json!({}),
        };
        assert_eq!(result.text, "ready");
    }
}
