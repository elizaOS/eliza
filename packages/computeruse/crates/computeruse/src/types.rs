//! Common types used across platforms for UI automation

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

/// Position options for text overlays in highlighting
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum TextPosition {
    Top,
    TopRight,
    Right,
    BottomRight,
    Bottom,
    BottomLeft,
    Left,
    TopLeft,
    Inside,
}

/// Font styling options for text overlays
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FontStyle {
    pub size: u32,
    pub bold: bool,
    pub color: u32, // BGR format
}

impl Default for FontStyle {
    fn default() -> Self {
        Self {
            size: 12,
            bold: false,
            color: 0x000000, // Black
        }
    }
}

/// Handle for managing active highlights with cleanup
pub struct HighlightHandle {
    pub(crate) should_close: Arc<AtomicBool>,
    pub(crate) handle: Option<thread::JoinHandle<()>>,
}

impl HighlightHandle {
    /// Manually close the highlight
    pub fn close(mut self) {
        self.should_close.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for HighlightHandle {
    fn drop(&mut self) {
        // Do not force-close on drop. Allow the highlight thread to finish
        // naturally based on its requested duration. Dropping the JoinHandle
        // detaches the thread so it can complete without blocking the caller.
        let _ = self.handle.take();
    }
}

/// An item detected by Omniparser vision model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OmniparserItem {
    /// Label type: e.g., "icon", "text", "button"
    pub label: String,
    /// Description or OCR text content
    pub content: Option<String>,
    /// Bounding box [x_min, y_min, x_max, y_max] in absolute pixel coordinates
    pub box_2d: Option<[f64; 4]>,
}

/// An element detected by Gemini Vision model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisionElement {
    /// Element type: text, icon, button, input, checkbox, dropdown, link, image, unknown
    pub element_type: String,
    /// Visible text or label on the element
    pub content: Option<String>,
    /// AI description of what this element is or does
    pub description: Option<String>,
    /// Bounding box [x_min, y_min, x_max, y_max] in absolute pixel coordinates
    pub box_2d: Option<[f64; 4]>,
    /// Whether the element is interactive/clickable
    pub interactivity: Option<bool>,
}
