#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, RssError>;

#[derive(Error, Debug)]
pub enum RssError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("XML parsing error: {0}")]
    XmlParse(#[from] quick_xml::Error),

    #[error("Invalid feed format: {0}")]
    InvalidFeed(String),

    #[error("Invalid URL: {0}")]
    InvalidUrl(#[from] url::ParseError),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Feed not found: {0}")]
    NotFound(String),

    #[error("Already subscribed to: {0}")]
    AlreadySubscribed(String),

    #[error("Not subscribed to: {0}")]
    NotSubscribed(String),
}
