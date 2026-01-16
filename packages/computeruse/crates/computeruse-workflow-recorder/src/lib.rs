//! Workflow Recorder crate for Windows
//!
//! This crate provides functionality to record user interactions with the Windows UI,
//! including mouse clicks, keyboard input, and window focus changes.
//! The recorded workflow can be saved as a JSON file for later playback or analysis.

#![cfg_attr(not(target_os = "windows"), allow(unused))]

mod error;
mod events;
mod recorder;

pub use error::*;
pub use events::{
    build_chained_selector, build_parent_hierarchy, ApplicationSwitchEvent,
    ApplicationSwitchMethod, BrowserClickEvent, BrowserTabNavigationEvent, BrowserTextInputEvent,
    ButtonInteractionType, ClickEvent, ClipboardAction, ClipboardEvent, DomElementInfo,
    DragDropEvent, EnhancedUIElement, EventMetadata, FieldFocusMethod, FileOpenedEvent,
    HotkeyEvent, InteractionContext, KeyboardEvent, McpToolStep, MouseButton, MouseEvent,
    MouseEventType, PendingActionEvent, PendingActionType, Position, RecordedEvent,
    RecordedWorkflow, Rect, SelectionMethod, SelectorCandidate, TabAction, TabNavigationMethod,
    TextInputCompletedEvent, TextInputMethod, TextSelectionEvent, UIElementInfo, WorkflowEvent,
};
pub use recorder::*;

#[cfg(target_os = "windows")]
pub mod structs {
    pub use crate::recorder::windows::structs::*;
}
