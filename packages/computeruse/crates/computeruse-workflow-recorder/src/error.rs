use thiserror::Error;

/// Error types for workflow recording
#[derive(Debug, Error)]
pub enum WorkflowRecorderError {
    /// Error when initializing the recorder
    #[error("Failed to initialize recorder: {0}")]
    InitializationError(String),

    /// Error when recording an event
    #[error("Failed to record event: {0}")]
    RecordingError(String),

    /// Error when saving the recorded workflow
    #[error("Failed to save workflow: {0}")]
    SaveError(String),

    /// Error from the Windows UI Automation API
    #[cfg(target_os = "windows")]
    #[error("UI Automation error: {0}")]
    UiAutomationError(#[from] uiautomation::Error),

    /// Error from Windows API
    #[cfg(target_os = "windows")]
    #[error("Windows API error: {0}")]
    WindowsError(String),

    /// Error from notify file watcher
    #[error("File watcher error: {0}")]
    NotifyError(#[from] notify::Error),

    /// Error when serializing or deserializing JSON
    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),

    /// I/O error
    #[error("I/O error: {0}")]
    IoError(#[from] std::io::Error),
}

/// Result type for workflow recorder operations
pub type Result<T> = std::result::Result<T, WorkflowRecorderError>;
