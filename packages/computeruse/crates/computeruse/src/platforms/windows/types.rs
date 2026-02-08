//! Type definitions and RAII wrappers for Windows platform

use crate::AutomationError;
use std::sync::Arc;
use windows::Win32::Foundation::{CloseHandle, HANDLE};

/// RAII wrapper for Windows HANDLE that ensures proper cleanup
pub(crate) struct HandleGuard(pub(crate) HANDLE);

impl Drop for HandleGuard {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_invalid() {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// Thread-safe wrapper for UIAutomation COM object
pub struct ThreadSafeWinUIAutomation();

// Safety: UIAutomation is thread-safe after proper COM initialization
unsafe impl Send for ThreadSafeWinUIAutomation {}
unsafe impl Sync for ThreadSafeWinUIAutomation {}

// Re-export common types from the main crate for backward compatibility
pub use crate::types::{FontStyle, HighlightHandle, TextPosition};

/// Thread-safe wrapper for UIElement
#[derive(Clone)]
pub(crate) struct ThreadSafeWinUIElement(pub(crate) Arc<uiautomation::UIElement>);

// Safety: UIElement is thread-safe when wrapped properly
unsafe impl Send for ThreadSafeWinUIElement {}
unsafe impl Sync for ThreadSafeWinUIElement {}

/// Options for application activation
#[allow(dead_code)]
pub enum ActivateOptions {
    None = 0x00000000,
    DesignMode = 0x00000001,
    NoErrorUI = 0x00000002,
    NoSplashScreen = 0x00000004,
}

// Tree building types are now in tree_builder.rs

// Error conversions

impl From<uiautomation::Error> for AutomationError {
    fn from(error: uiautomation::Error) -> Self {
        AutomationError::PlatformError(format!("UIAutomation error: {error}"))
    }
}
