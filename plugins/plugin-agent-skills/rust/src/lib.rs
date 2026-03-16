//! Agent Skills Plugin for elizaOS (Rust)
//!
//! Implements the Agent Skills specification with:
//! - Spec-compliant SKILL.md parsing and validation
//! - Progressive disclosure (metadata → instructions → resources)
//! - ClawHub registry integration
//! - Otto metadata compatibility
//! - Dual storage modes (memory/filesystem)
//!
//! See: <https://agentskills.io>

#![warn(missing_docs)]

pub mod actions;
pub mod error;
pub mod parser;
pub mod service;
pub mod storage;
pub mod types;

pub use actions::{
    ActionResult as SkillActionResult, GetSkillDetailsAction, GetSkillGuidanceAction,
    RunSkillScriptAction, SearchSkillsAction, SyncCatalogAction,
};
pub use error::{Error, Result};
pub use parser::{
    estimate_tokens, extract_body, generate_skills_xml, parse_frontmatter, validate_frontmatter,
    validate_skill_directory,
};
pub use service::AgentSkillsService;
pub use storage::{
    create_storage, install_from_github, install_from_url, load_skill_from_storage, FileContent,
    FileSystemSkillStore, MemorySkillStore, SkillFile, SkillPackage, SkillStorage,
};
pub use types::{
    OttoInstallOption, OttoMetadata, Skill, SkillCatalogEntry, SkillDetails,
    SkillFrontmatter, SkillInstructions, SkillMetadata, SkillMetadataEntry, SkillSearchResult,
    SkillValidationError, SkillValidationResult, SkillValidationWarning,
    SKILL_BODY_RECOMMENDED_TOKENS, SKILL_COMPATIBILITY_MAX_LENGTH, SKILL_DESCRIPTION_MAX_LENGTH,
    SKILL_NAME_MAX_LENGTH,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_frontmatter() {
        let content = r#"---
name: test-skill
description: A test skill for testing purposes.
---
# Test Skill

Instructions here.
"#;
        let (frontmatter, body, _) = parse_frontmatter(content);
        assert!(frontmatter.is_some());

        let fm = frontmatter.unwrap();
        assert_eq!(fm.name, "test-skill");
        assert_eq!(fm.description, "A test skill for testing purposes.");
        assert!(body.contains("# Test Skill"));
    }

    #[test]
    fn test_validate_valid_frontmatter() {
        let fm = SkillFrontmatter {
            name: "valid-skill".to_string(),
            description: "A valid skill description that explains what it does.".to_string(),
            license: None,
            compatibility: None,
            metadata: None,
            allowed_tools: None,
            homepage: None,
        };

        let result = validate_frontmatter(&fm, None);
        assert!(result.valid);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn test_validate_invalid_name() {
        let fm = SkillFrontmatter {
            name: "Invalid-Name".to_string(), // uppercase not allowed
            description: "A description.".to_string(),
            license: None,
            compatibility: None,
            metadata: None,
            allowed_tools: None,
            homepage: None,
        };

        let result = validate_frontmatter(&fm, None);
        assert!(!result.valid);
        assert!(!result.errors.is_empty());
    }

    #[test]
    fn test_estimate_tokens() {
        let text = "This is some text that should be approximately 10 tokens or so.";
        let tokens = estimate_tokens(text);
        assert!(tokens > 0);
        assert!(tokens < 100);
    }

    #[test]
    fn test_generate_skills_xml() {
        let skills = vec![
            types::SkillMetadataEntry {
                name: "skill-one".to_string(),
                description: "First skill.".to_string(),
                location: "/path/to/skill-one/SKILL.md".to_string(),
            },
            types::SkillMetadataEntry {
                name: "skill-two".to_string(),
                description: "Second skill.".to_string(),
                location: "/path/to/skill-two/SKILL.md".to_string(),
            },
        ];

        let xml = generate_skills_xml(&skills, true);
        assert!(xml.contains("<available_skills>"));
        assert!(xml.contains("skill-one"));
        assert!(xml.contains("skill-two"));
        assert!(xml.contains("<location>"));
    }
}
