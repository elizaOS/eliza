//! Skill Parser
//!
//! Parses and validates SKILL.md files according to the Agent Skills specification.
//!
//! See: <https://agentskills.io/specification>

use regex::Regex;
use std::sync::LazyLock;

use crate::types::{
    SkillFrontmatter, SkillMetadataEntry, SkillValidationError, SkillValidationResult,
    SkillValidationWarning, SKILL_COMPATIBILITY_MAX_LENGTH, SKILL_DESCRIPTION_MAX_LENGTH,
    SKILL_NAME_MAX_LENGTH, SKILL_NAME_PATTERN,
};

// Frontmatter regex
static FRONTMATTER_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^---\n([\s\S]*?)\n---\n?").unwrap());

// ============================================================
// FRONTMATTER PARSING
// ============================================================

/// Parse YAML frontmatter from SKILL.md content.
///
/// Returns: (frontmatter, body, raw_yaml)
pub fn parse_frontmatter(content: &str) -> (Option<SkillFrontmatter>, String, String) {
    if let Some(caps) = FRONTMATTER_REGEX.captures(content) {
        let raw = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let body = content[caps.get(0).map(|m| m.end()).unwrap_or(0)..]
            .trim()
            .to_string();

        match serde_yaml::from_str::<SkillFrontmatter>(raw) {
            Ok(fm) => (Some(fm), body, raw.to_string()),
            Err(_) => (None, body, raw.to_string()),
        }
    } else {
        (None, content.to_string(), String::new())
    }
}

// ============================================================
// VALIDATION
// ============================================================

/// Validate a skill's frontmatter according to the Agent Skills specification.
pub fn validate_frontmatter(
    frontmatter: &SkillFrontmatter,
    directory_name: Option<&str>,
) -> SkillValidationResult {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    // Required: name
    if frontmatter.name.is_empty() {
        errors.push(SkillValidationError {
            field: "name".to_string(),
            message: "name is required".to_string(),
            code: "MISSING_NAME".to_string(),
        });
    } else {
        // Validate name format
        if frontmatter.name.len() > SKILL_NAME_MAX_LENGTH {
            errors.push(SkillValidationError {
                field: "name".to_string(),
                message: format!(
                    "name must be {} characters or less",
                    SKILL_NAME_MAX_LENGTH
                ),
                code: "NAME_TOO_LONG".to_string(),
            });
        }

        if !SKILL_NAME_PATTERN.is_match(&frontmatter.name) {
            errors.push(SkillValidationError {
                field: "name".to_string(),
                message: "name must contain only lowercase letters, numbers, and hyphens"
                    .to_string(),
                code: "INVALID_NAME_FORMAT".to_string(),
            });
        }

        if frontmatter.name.starts_with('-') || frontmatter.name.ends_with('-') {
            errors.push(SkillValidationError {
                field: "name".to_string(),
                message: "name cannot start or end with a hyphen".to_string(),
                code: "NAME_INVALID_HYPHEN".to_string(),
            });
        }

        if frontmatter.name.contains("--") {
            errors.push(SkillValidationError {
                field: "name".to_string(),
                message: "name cannot contain consecutive hyphens".to_string(),
                code: "NAME_CONSECUTIVE_HYPHENS".to_string(),
            });
        }

        // Check directory name matches
        if let Some(dir_name) = directory_name {
            if dir_name != frontmatter.name {
                errors.push(SkillValidationError {
                    field: "name".to_string(),
                    message: format!(
                        "name \"{}\" must match directory name \"{}\"",
                        frontmatter.name, dir_name
                    ),
                    code: "NAME_MISMATCH".to_string(),
                });
            }
        }
    }

    // Required: description
    if frontmatter.description.is_empty() {
        errors.push(SkillValidationError {
            field: "description".to_string(),
            message: "description is required".to_string(),
            code: "MISSING_DESCRIPTION".to_string(),
        });
    } else {
        if frontmatter.description.len() > SKILL_DESCRIPTION_MAX_LENGTH {
            errors.push(SkillValidationError {
                field: "description".to_string(),
                message: format!(
                    "description must be {} characters or less",
                    SKILL_DESCRIPTION_MAX_LENGTH
                ),
                code: "DESCRIPTION_TOO_LONG".to_string(),
            });
        }

        if frontmatter.description.len() < 20 {
            warnings.push(SkillValidationWarning {
                field: "description".to_string(),
                message: "description is very short; consider adding more detail".to_string(),
                code: "DESCRIPTION_TOO_SHORT".to_string(),
            });
        }
    }

    // Optional: compatibility
    if let Some(ref compat) = frontmatter.compatibility {
        if compat.len() > SKILL_COMPATIBILITY_MAX_LENGTH {
            errors.push(SkillValidationError {
                field: "compatibility".to_string(),
                message: format!(
                    "compatibility must be {} characters or less",
                    SKILL_COMPATIBILITY_MAX_LENGTH
                ),
                code: "COMPATIBILITY_TOO_LONG".to_string(),
            });
        }
    }

    SkillValidationResult {
        valid: errors.is_empty(),
        errors,
        warnings,
    }
}

/// Validate a complete skill directory.
pub fn validate_skill_directory(
    _path: &str,
    content: &str,
    directory_name: &str,
) -> SkillValidationResult {
    let mut errors = Vec::new();
    let warnings = Vec::new();

    let (frontmatter, _, _) = parse_frontmatter(content);

    if frontmatter.is_none() {
        errors.push(SkillValidationError {
            field: "frontmatter".to_string(),
            message: "SKILL.md must have valid YAML frontmatter".to_string(),
            code: "MISSING_FRONTMATTER".to_string(),
        });
        return SkillValidationResult {
            valid: false,
            errors,
            warnings,
        };
    }

    let fm = frontmatter.unwrap();
    let fm_result = validate_frontmatter(&fm, Some(directory_name));

    SkillValidationResult {
        valid: fm_result.errors.is_empty(),
        errors: fm_result.errors,
        warnings: fm_result.warnings,
    }
}

// ============================================================
// SKILL BODY EXTRACTION
// ============================================================

/// Extract the body (instructions) from SKILL.md content.
pub fn extract_body(content: &str) -> String {
    let (_, body, _) = parse_frontmatter(content);
    body
}

/// Estimate token count for text (~4 characters per token).
pub fn estimate_tokens(text: &str) -> usize {
    text.len() / 4
}

// ============================================================
// PROMPT XML GENERATION
// ============================================================

/// Generate XML for skill metadata to include in agent prompts.
pub fn generate_skills_xml(skills: &[SkillMetadataEntry], include_location: bool) -> String {
    if skills.is_empty() {
        return String::new();
    }

    let skill_elements: Vec<String> = skills
        .iter()
        .map(|skill| {
            let location_tag = if include_location && !skill.location.is_empty() {
                format!(
                    "\n    <location>{}</location>",
                    escape_xml(&skill.location)
                )
            } else {
                String::new()
            };

            format!(
                "  <skill>\n    <name>{}</name>\n    <description>{}</description>{}\n  </skill>",
                escape_xml(&skill.name),
                escape_xml(&skill.description),
                location_tag
            )
        })
        .collect();

    format!(
        "<available_skills>\n{}\n</available_skills>",
        skill_elements.join("\n")
    )
}

/// Escape special XML characters.
fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
