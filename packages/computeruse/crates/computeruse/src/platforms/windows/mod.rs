//! Windows platform implementation for UI automation
//!
//! This module provides Windows-specific UI automation functionality using
//! the Windows UI Automation API through the uiautomation crate.

pub mod action_overlay;
pub mod applications;
pub mod element;
pub mod engine;
pub mod health;
pub mod highlighting;
pub mod input;
pub mod inspect_overlay;
pub mod tree_builder;
pub mod types;
pub mod utils;
pub mod virtual_display;
pub mod window_manager;

// Re-export the main types that external code needs
pub use element::WindowsUIElement;
pub use engine::WindowsEngine;
pub use types::{FontStyle, HighlightHandle, TextPosition};

// Re-export utility functions that might be needed externally
pub use utils::{convert_uiautomation_element_to_computeruse, generate_element_id};

// Re-export from applications module
pub use applications::{get_process_name_by_pid, is_browser_process, KNOWN_BROWSER_PROCESS_NAMES};

// Re-export highlighting control functions
pub use highlighting::{highlight_bounds, set_recording_mode, stop_all_highlights};

// Re-export inspect overlay functions
pub use inspect_overlay::{
    hide_inspect_overlay, show_inspect_overlay, InspectElement, InspectOverlayHandle,
    OverlayDisplayMode,
};

// Re-export action overlay functions
pub use action_overlay::{
    hide_action_overlay, is_action_overlay_enabled, set_action_overlay_enabled,
    show_action_overlay, update_action_overlay_message, ActionOverlayGuard,
};

// Re-export virtual display support
pub use virtual_display::{
    is_headless_environment, HeadlessConfig, VirtualDisplayConfig, VirtualDisplayManager,
};

// Re-export window manager
pub use window_manager::{WindowCache, WindowInfo, WindowManager, WindowPlacement};

// Re-export input functions
pub use input::{restore_focus_state, save_focus_state, send_mouse_click, FocusState};
