//! Error types for the Agent Skills plugin.

use thiserror::Error;

/// Agent Skills error type.
#[derive(Error, Debug)]
pub enum Error {
    /// Invalid skill slug.
    #[error("Invalid skill slug: {0}")]
    InvalidSlug(String),

    /// Missing required field.
    #[error("Missing required field: {0}")]
    MissingField(String),

    /// Validation error.
    #[error("Validation error: {0}")]
    Validation(String),

    /// IO error.
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// HTTP error.
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// JSON error.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// YAML error.
    #[error("YAML error: {0}")]
    Yaml(#[from] serde_yaml::Error),

    /// ZIP error.
    #[error("ZIP error: {0}")]
    Zip(#[from] zip::result::ZipError),

    /// Skill not found.
    #[error("Skill not found: {0}")]
    NotFound(String),

    /// Parse error.
    #[error("Parse error: {0}")]
    Parse(String),

    /// URL parse error.
    #[error("URL parse error: {0}")]
    Url(#[from] url::ParseError),

    /// Package too large.
    #[error("Package too large: {size} bytes (max {max} bytes)")]
    PackageTooLarge {
        /// Actual size.
        size: usize,
        /// Maximum allowed size.
        max: usize,
    },

    /// Generic error.
    #[error("{0}")]
    Other(String),
}

/// Result type for the Agent Skills plugin.
pub type Result<T> = std::result::Result<T, Error>;
