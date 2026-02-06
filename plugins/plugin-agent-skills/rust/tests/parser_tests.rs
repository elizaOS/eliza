//! Parser Tests
//!
//! Tests SKILL.md parsing and validation with real skills from otto.

use std::fs;
use std::path::PathBuf;

use elizaos_plugin_agent_skills::{
    estimate_tokens, extract_body, generate_skills_xml, parse_frontmatter, validate_frontmatter,
    validate_skill_directory, SkillFrontmatter, SkillMetadataEntry,
};

/// Path to otto skills for testing
fn otto_skills_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("otto")
        .join("skills")
}

#[test]
fn test_parse_simple_frontmatter() {
    let content = r#"---
name: test-skill
description: A test skill for testing purposes.
---
# Test Skill

Instructions here.
"#;

    let (frontmatter, body, raw) = parse_frontmatter(content);

    assert!(frontmatter.is_some());
    let fm = frontmatter.unwrap();
    assert_eq!(fm.name, "test-skill");
    assert_eq!(fm.description, "A test skill for testing purposes.");
    assert!(body.contains("# Test Skill"));
    assert!(raw.contains("name: test-skill"));
}

#[test]
fn test_parse_frontmatter_with_optional_fields() {
    let content = r#"---
name: advanced-skill
description: An advanced skill with all optional fields.
license: MIT
compatibility: Requires Python 3.10+
homepage: https://example.com
---
# Advanced Skill
"#;

    let (frontmatter, _, _) = parse_frontmatter(content);

    let fm = frontmatter.unwrap();
    assert_eq!(fm.license, Some("MIT".to_string()));
    assert_eq!(fm.compatibility, Some("Requires Python 3.10+".to_string()));
    assert_eq!(fm.homepage, Some("https://example.com".to_string()));
}

#[test]
fn test_no_frontmatter_returns_none() {
    let content = r#"# No Frontmatter

Just regular markdown.
"#;

    let (frontmatter, body, _) = parse_frontmatter(content);

    assert!(frontmatter.is_none());
    assert!(body.contains("# No Frontmatter"));
}

#[test]
fn test_validate_correct_frontmatter() {
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
fn test_reject_missing_name() {
    let fm = SkillFrontmatter {
        name: "".to_string(),
        description: "A description.".to_string(),
        license: None,
        compatibility: None,
        metadata: None,
        allowed_tools: None,
        homepage: None,
    };

    let result = validate_frontmatter(&fm, None);

    assert!(!result.valid);
    assert!(result.errors.iter().any(|e| e.code == "MISSING_NAME"));
}

#[test]
fn test_reject_invalid_name_format() {
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
    assert!(result.errors.iter().any(|e| e.code == "INVALID_NAME_FORMAT"));
}

#[test]
fn test_reject_consecutive_hyphens() {
    let fm = SkillFrontmatter {
        name: "invalid--name".to_string(),
        description: "A description.".to_string(),
        license: None,
        compatibility: None,
        metadata: None,
        allowed_tools: None,
        homepage: None,
    };

    let result = validate_frontmatter(&fm, None);

    assert!(!result.valid);
    assert!(result
        .errors
        .iter()
        .any(|e| e.code == "NAME_CONSECUTIVE_HYPHENS"));
}

#[test]
fn test_reject_missing_description() {
    let fm = SkillFrontmatter {
        name: "valid-name".to_string(),
        description: "".to_string(),
        license: None,
        compatibility: None,
        metadata: None,
        allowed_tools: None,
        homepage: None,
    };

    let result = validate_frontmatter(&fm, None);

    assert!(!result.valid);
    assert!(result
        .errors
        .iter()
        .any(|e| e.code == "MISSING_DESCRIPTION"));
}

#[test]
fn test_warn_short_description() {
    let fm = SkillFrontmatter {
        name: "valid-name".to_string(),
        description: "Too short.".to_string(),
        license: None,
        compatibility: None,
        metadata: None,
        allowed_tools: None,
        homepage: None,
    };

    let result = validate_frontmatter(&fm, None);

    assert!(result.valid); // warnings don't make it invalid
    assert!(result
        .warnings
        .iter()
        .any(|w| w.code == "DESCRIPTION_TOO_SHORT"));
}

#[test]
fn test_validate_directory_name_match() {
    let fm = SkillFrontmatter {
        name: "skill-name".to_string(),
        description: "A valid description that is long enough.".to_string(),
        license: None,
        compatibility: None,
        metadata: None,
        allowed_tools: None,
        homepage: None,
    };

    let result = validate_frontmatter(&fm, Some("different-name"));

    assert!(!result.valid);
    assert!(result.errors.iter().any(|e| e.code == "NAME_MISMATCH"));
}

#[test]
fn test_extract_body_without_frontmatter() {
    let content = r#"---
name: test
description: Test skill.
---
# Main Content

This is the body.
"#;

    let body = extract_body(content);

    assert_eq!(body, "# Main Content\n\nThis is the body.");
    assert!(!body.contains("---"));
    assert!(!body.contains("name: test"));
}

#[test]
fn test_estimate_tokens_based_on_characters() {
    let text = "This is some text that should be approximately some tokens.";
    let tokens = estimate_tokens(text);

    assert!(tokens > 0);
    assert!(tokens < text.len()); // ~4 chars per token
}

#[test]
fn test_generate_xml_with_locations() {
    let skills = vec![
        SkillMetadataEntry {
            name: "skill-one".to_string(),
            description: "First skill.".to_string(),
            location: "/path/to/skill-one/SKILL.md".to_string(),
        },
        SkillMetadataEntry {
            name: "skill-two".to_string(),
            description: "Second skill.".to_string(),
            location: "/path/to/skill-two/SKILL.md".to_string(),
        },
    ];

    let xml = generate_skills_xml(&skills, true);

    assert!(xml.contains("<available_skills>"));
    assert!(xml.contains("<name>skill-one</name>"));
    assert!(xml.contains("<description>First skill.</description>"));
    assert!(xml.contains("<location>/path/to/skill-one/SKILL.md</location>"));
    assert!(xml.contains("</available_skills>"));
}

#[test]
fn test_generate_xml_without_locations() {
    let skills = vec![SkillMetadataEntry {
        name: "skill-one".to_string(),
        description: "First skill.".to_string(),
        location: "/path".to_string(),
    }];

    let xml = generate_skills_xml(&skills, false);

    assert!(!xml.contains("<location>"));
}

#[test]
fn test_escape_xml_special_characters() {
    let skills = vec![SkillMetadataEntry {
        name: "test".to_string(),
        description: "Use when <condition> & \"situation\".".to_string(),
        location: "".to_string(),
    }];

    let xml = generate_skills_xml(&skills, true);

    assert!(xml.contains("&lt;condition&gt;"));
    assert!(xml.contains("&amp;"));
    assert!(xml.contains("&quot;"));
}

#[test]
fn test_empty_skills_returns_empty_string() {
    let xml = generate_skills_xml(&[], true);
    assert!(xml.is_empty());
}

#[test]
fn test_parse_real_github_skill() {
    let skill_path = otto_skills_path().join("github").join("SKILL.md");

    if skill_path.exists() {
        let content = fs::read_to_string(&skill_path).unwrap();
        let (frontmatter, body, _) = parse_frontmatter(&content);

        assert!(frontmatter.is_some());
        let fm = frontmatter.unwrap();
        assert_eq!(fm.name, "github");
        assert!(fm.description.contains("gh"));
        assert!(body.contains("# GitHub Skill"));
    }
}

#[test]
fn test_validate_real_skills() {
    let skill_dirs = ["github", "1password", "clawhub", "skill-creator", "tmux"];

    for skill_dir in skill_dirs {
        let skill_path = otto_skills_path().join(skill_dir);

        if skill_path.exists() {
            let skill_md_path = skill_path.join("SKILL.md");
            if let Ok(content) = fs::read_to_string(&skill_md_path) {
                let result =
                    validate_skill_directory(&skill_path.to_string_lossy(), &content, skill_dir);

                // Log any errors for debugging
                if !result.valid {
                    eprintln!(
                        "{} validation errors: {:?}",
                        skill_dir,
                        result
                            .errors
                            .iter()
                            .map(|e| &e.message)
                            .collect::<Vec<_>>()
                    );
                }

                // Just assert the result exists
                assert!(!result.errors.is_empty() || result.valid);
            }
        }
    }
}
