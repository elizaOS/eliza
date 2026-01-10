//! Error types for the RSS plugin.

use thiserror::Error;

/// Result type alias for RSS plugin operations.
pub type Result<T> = std::result::Result<T, RssError>;

/// Errors that can occur in RSS plugin operations.
#[derive(Error, Debug)]
pub enum RssError {
    /// HTTP request error.
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// XML parsing error.
    #[error("XML parsing error: {0}")]
    XmlParse(#[from] quick_xml::Error),

    /// Invalid feed format.
    #[error("Invalid feed format: {0}")]
    InvalidFeed(String),

    /// URL parsing error.
    #[error("Invalid URL: {0}")]
    InvalidUrl(#[from] url::ParseError),

    /// I/O error.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// Configuration error.
    #[error("Configuration error: {0}")]
    Config(String),

    /// Feed not found.
    #[error("Feed not found: {0}")]
    NotFound(String),

    /// Already subscribed.
    #[error("Already subscribed to: {0}")]
    AlreadySubscribed(String),

    /// Not subscribed.
    #[error("Not subscribed to: {0}")]
    NotSubscribed(String),
}

