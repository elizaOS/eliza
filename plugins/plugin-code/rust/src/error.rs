use thiserror::Error;

pub type Result<T> = std::result::Result<T, CodeError>;

#[derive(Debug, Error)]
pub enum CodeError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("process error: {0}")]
    Process(String),
}
