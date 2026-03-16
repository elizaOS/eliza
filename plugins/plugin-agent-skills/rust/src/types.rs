//! Agent Skills Types
//!
//! Implements the Agent Skills specification from agentskills.io
//! with Otto compatibility extensions.
//!
//! See: <https://agentskills.io/specification>

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;

// ============================================================
// CONSTANTS
// ============================================================

/// Maximum length for skill name.
pub const SKILL_NAME_MAX_LENGTH: usize = 64;

/// Maximum length for skill description.
pub const SKILL_DESCRIPTION_MAX_LENGTH: usize = 1024;

/// Maximum length for compatibility field.
pub const SKILL_COMPATIBILITY_MAX_LENGTH: usize = 500;

/// Recommended maximum body length (tokens).
pub const SKILL_BODY_RECOMMENDED_TOKENS: usize = 5000;

/// Pattern for valid skill names.
pub static SKILL_NAME_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9]+(-[a-z0-9]+)*$").unwrap());

// ============================================================
// OTTO EXTENSIONS
// ============================================================

/// Otto installation option for dependencies.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OttoInstallOption {
    /// Unique identifier for this install option.
    pub id: String,

    /// Installation method kind.
    pub kind: String,

    /// Formula name (for brew).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,

    /// Package name (for apt, pip, cargo).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,

    /// Binary names provided by this installation.
    #[serde(default)]
    pub bins: Vec<String>,

    /// Human-readable label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Otto-specific metadata extensions.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OttoMetadata {
    /// Emoji icon for the skill.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,

    /// Required binaries/dependencies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires: Option<HashMap<String, Vec<String>>>,

    /// Installation instructions.
    #[serde(default)]
    pub install: Vec<OttoInstallOption>,
}


// ============================================================
// CORE SKILL TYPES
// ============================================================

/// Skill metadata - arbitrary key-value mapping.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SkillMetadata {
    /// Skill author.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,

    /// Skill version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,

    /// Otto-specific metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub otto: Option<OttoMetadata>,
}

/// Skill frontmatter as defined by the Agent Skills specification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillFrontmatter {
    /// Skill name (1-64 chars, lowercase alphanumeric + hyphens).
    pub name: String,

    /// What the skill does and when to use it (1-1024 chars).
    pub description: String,

    /// License name or reference to bundled license file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,

    /// Environment requirements (max 500 chars).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatibility: Option<String>,

    /// Arbitrary key-value mapping for additional metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<SkillMetadata>,

    /// Space-delimited list of pre-approved tools (experimental).
    #[serde(rename = "allowed-tools", skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<String>,

    /// Homepage URL (Otto extension).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
}

/// A fully loaded skill with parsed content.
#[derive(Debug, Clone)]
pub struct Skill {
    /// Skill slug (directory name, matches frontmatter name).
    pub slug: String,

    /// Display name from frontmatter.
    pub name: String,

    /// Description from frontmatter.
    pub description: String,

    /// Skill version.
    pub version: String,

    /// Full SKILL.md content.
    pub content: String,

    /// Parsed frontmatter.
    pub frontmatter: SkillFrontmatter,

    /// Absolute path to skill directory.
    pub path: String,

    /// List of script files in scripts/ directory.
    pub scripts: Vec<String>,

    /// List of reference files in references/ directory.
    pub references: Vec<String>,

    /// List of asset files in assets/ directory.
    pub assets: Vec<String>,

    /// When the skill was loaded (unix timestamp ms).
    pub loaded_at: u64,
}

/// Skill metadata for progressive disclosure (Level 1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillMetadataEntry {
    /// Skill name.
    pub name: String,

    /// Skill description.
    pub description: String,

    /// Path to SKILL.md.
    pub location: String,
}

/// Skill instructions (Level 2).
#[derive(Debug, Clone)]
pub struct SkillInstructions {
    /// Skill slug.
    pub slug: String,

    /// Instructions body (markdown).
    pub body: String,

    /// Estimated token count.
    pub estimated_tokens: usize,
}

// ============================================================
// REGISTRY TYPES
// ============================================================

/// Search result from registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSearchResult {
    /// Relevance score (0-1).
    pub score: f64,

    /// Skill slug.
    pub slug: String,

    /// Display name.
    #[serde(rename = "displayName")]
    pub display_name: String,

    /// Short summary.
    pub summary: String,

    /// Latest version.
    pub version: String,

    /// Last update timestamp.
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
}

/// Catalog entry from registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillCatalogEntry {
    /// Skill slug.
    pub slug: String,

    /// Display name.
    #[serde(rename = "displayName")]
    pub display_name: String,

    /// Short summary.
    pub summary: Option<String>,

    /// Latest version.
    pub version: String,

    /// Tags/categories.
    #[serde(default)]
    pub tags: HashMap<String, String>,

    /// Usage statistics.
    #[serde(default)]
    pub stats: HashMap<String, u64>,

    /// Last update timestamp.
    #[serde(rename = "updatedAt", default)]
    pub updated_at: u64,
}

/// Detailed skill information from registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDetails {
    /// Skill information.
    pub skill: SkillDetailsInner,

    /// Latest version information.
    #[serde(rename = "latestVersion")]
    pub latest_version: SkillVersionInfo,

    /// Owner information.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<SkillOwner>,
}

/// Inner skill details.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDetailsInner {
    /// Skill slug.
    pub slug: String,

    /// Display name.
    #[serde(rename = "displayName")]
    pub display_name: String,

    /// Short summary.
    pub summary: String,

    /// Tags/categories.
    #[serde(default)]
    pub tags: HashMap<String, String>,

    /// Usage statistics.
    #[serde(default)]
    pub stats: HashMap<String, u64>,

    /// Creation timestamp.
    #[serde(rename = "createdAt", default)]
    pub created_at: u64,

    /// Last update timestamp.
    #[serde(rename = "updatedAt", default)]
    pub updated_at: u64,
}

/// Version information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillVersionInfo {
    /// Version string.
    pub version: String,

    /// Creation timestamp.
    #[serde(rename = "createdAt", default)]
    pub created_at: u64,

    /// Changelog.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changelog: Option<String>,
}

/// Skill owner information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillOwner {
    /// Handle/username.
    pub handle: String,

    /// Display name.
    #[serde(rename = "displayName")]
    pub display_name: String,

    /// Profile image.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

// ============================================================
// VALIDATION TYPES
// ============================================================

/// Validation error.
#[derive(Debug, Clone)]
pub struct SkillValidationError {
    /// Field name.
    pub field: String,

    /// Error message.
    pub message: String,

    /// Error code.
    pub code: String,
}

/// Validation warning.
#[derive(Debug, Clone)]
pub struct SkillValidationWarning {
    /// Field name.
    pub field: String,

    /// Warning message.
    pub message: String,

    /// Warning code.
    pub code: String,
}

/// Skill validation result.
#[derive(Debug, Clone)]
pub struct SkillValidationResult {
    /// Whether the skill is valid.
    pub valid: bool,

    /// Validation errors.
    pub errors: Vec<SkillValidationError>,

    /// Validation warnings.
    pub warnings: Vec<SkillValidationWarning>,
}
