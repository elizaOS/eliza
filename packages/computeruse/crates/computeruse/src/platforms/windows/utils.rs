//! Utility functions and type conversions for Windows platform

use super::types::ThreadSafeWinUIElement;
use crate::{AutomationError, UIElement};
use std::sync::Arc;
use uiautomation::controls::ControlType;
use uiautomation::types::UIProperty;
use uiautomation::UIAutomation;
use windows::core::HRESULT;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

// Re-export WindowsUIElement here since it will be used by other modules
pub use super::element::WindowsUIElement;

#[derive(Debug)]
pub struct PathSegment {
    pub control_type: ControlType,
    pub index: usize, // 1-based index
}

/// Generate a stable element ID based on element properties
#[allow(clippy::arc_with_non_send_sync)]
pub fn generate_element_id(element: &uiautomation::UIElement) -> Result<usize, AutomationError> {
    // Attempt to get stable properties first
    let automation_id = element
        .get_automation_id()
        .map(|s| if s.is_empty() { None } else { Some(s) })
        .unwrap_or(None);
    let role = element
        .get_control_type()
        .map(|s| {
            if s == ControlType::Custom {
                None
            } else {
                Some(s)
            }
        })
        .unwrap_or(None);
    let name = element
        .get_name()
        .map(|s| if s.is_empty() { None } else { Some(s) })
        .unwrap_or(None);
    let class_name = element
        .get_classname()
        .map(|s| if s.is_empty() { None } else { Some(s) })
        .unwrap_or(None);

    let mut to_hash = String::new();
    if let Some(id) = automation_id {
        to_hash.push_str(&id);
    }
    if let Some(role) = role {
        to_hash.push_str(&role.to_string());
    }
    if let Some(n) = name {
        to_hash.push_str(&n);
    }
    if let Some(cn) = class_name {
        to_hash.push_str(&cn);
    }

    // If still no stable properties, use bounds as a fallback for more stability
    if to_hash.is_empty() {
        if let Ok(rect) = element.get_bounding_rectangle() {
            to_hash.push_str(&format!(
                "{}:{}:{}:{}",
                rect.get_left(),
                rect.get_top(),
                rect.get_width(),
                rect.get_height()
            ));
        }
    }

    // As a last resort for elements with no stable identifiers, use the object's memory address.
    // This is NOT stable across sessions, but provides a unique ID within a single session.
    if to_hash.is_empty() {
        let element_arc = Arc::new(element.clone());
        let ptr = Arc::as_ptr(&element_arc);
        return Ok(ptr as usize);
    }

    let hash = blake3::hash(to_hash.as_bytes());
    Ok(hash.as_bytes()[0..8]
        .try_into()
        .map(u64::from_le_bytes)
        .unwrap() as usize)
}

/// Converts a raw uiautomation::UIElement to a computeruse UIElement
#[allow(clippy::arc_with_non_send_sync)]
pub fn convert_uiautomation_element_to_computeruse(element: uiautomation::UIElement) -> UIElement {
    let arc_ele = ThreadSafeWinUIElement(Arc::new(element));
    UIElement::new(Box::new(WindowsUIElement {
        element: arc_ele,
        engine: None,
    }))
}

/// Helper function to create UIAutomation instance with proper COM initialization
pub(crate) fn create_ui_automation_with_com_init() -> Result<UIAutomation, AutomationError> {
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() && hr != HRESULT(0x80010106u32 as i32) {
            // Only return error if it's not the "already initialized" case
            return Err(AutomationError::PlatformError(format!(
                "Failed to initialize COM: {hr}"
            )));
        }
    }

    UIAutomation::new_direct().map_err(|e| AutomationError::PlatformError(e.to_string()))
}

/// Maps generic role strings to Windows ControlType enums
pub(crate) fn map_generic_role_to_win_roles(role: &str) -> ControlType {
    match role.to_lowercase().as_str() {
        "pane" | "app" | "application" => ControlType::Pane,
        "window" | "dialog" => ControlType::Window,
        "button" => ControlType::Button,
        "checkbox" => ControlType::CheckBox,
        "menu" => ControlType::Menu,
        "menubar" => ControlType::MenuBar,
        "menuitem" => ControlType::MenuItem,
        "text" => ControlType::Text,
        "tree" => ControlType::Tree,
        "treeitem" => ControlType::TreeItem,
        "data" | "dataitem" => ControlType::DataItem,
        "datagrid" => ControlType::DataGrid,
        "url" | "urlfield" => ControlType::Edit,
        "list" => ControlType::List,
        "image" => ControlType::Image,
        "title" => ControlType::TitleBar,
        "listitem" => ControlType::ListItem,
        "combobox" => ControlType::ComboBox,
        "tab" => ControlType::Tab,
        "tabitem" => ControlType::TabItem,
        "toolbar" => ControlType::ToolBar,
        "appbar" => ControlType::AppBar,
        "calendar" => ControlType::Calendar,
        "edit" => ControlType::Edit,
        "hyperlink" => ControlType::Hyperlink,
        "progressbar" => ControlType::ProgressBar,
        "radiobutton" => ControlType::RadioButton,
        "scrollbar" => ControlType::ScrollBar,
        "slider" => ControlType::Slider,
        "spinner" => ControlType::Spinner,
        "statusbar" => ControlType::StatusBar,
        "tooltip" => ControlType::ToolTip,
        "custom" => ControlType::Custom,
        "group" => ControlType::Group,
        "thumb" => ControlType::Thumb,
        "document" => ControlType::Document,
        "splitbutton" => ControlType::SplitButton,
        "header" => ControlType::Header,
        "headeritem" => ControlType::HeaderItem,
        "table" => ControlType::Table,
        "titlebar" => ControlType::TitleBar,
        "separator" => ControlType::Separator,
        "semanticzoom" => ControlType::SemanticZoom,
        _ => ControlType::Custom, // keep as it is for unknown roles
    }
}

/// Centralized function to map string attribute keys to UIProperty variants
pub(crate) fn string_to_ui_property(key: &str) -> Option<UIProperty> {
    match key {
        // Core properties
        "AutomationId" => Some(UIProperty::AutomationId),
        "Name" => Some(UIProperty::Name),
        "ControlType" => Some(UIProperty::ControlType),
        "ProcessId" => Some(UIProperty::ProcessId),
        "Value" => Some(UIProperty::ValueValue),
        "ClassName" => Some(UIProperty::ClassName),
        "LocalizedControlType" => Some(UIProperty::LocalizedControlType),
        "AcceleratorKey" => Some(UIProperty::AcceleratorKey),
        "AccessKey" => Some(UIProperty::AccessKey),
        "HelpText" => Some(UIProperty::HelpText),

        // State properties
        "IsEnabled" => Some(UIProperty::IsEnabled),
        "IsKeyboardFocusable" => Some(UIProperty::IsKeyboardFocusable),
        "HasKeyboardFocus" => Some(UIProperty::HasKeyboardFocus),
        "IsPassword" => Some(UIProperty::IsPassword),
        "IsOffscreen" => Some(UIProperty::IsOffscreen),
        "IsContentElement" => Some(UIProperty::IsContentElement),
        "IsControlElement" => Some(UIProperty::IsControlElement),
        "IsRequiredForForm" => Some(UIProperty::IsRequiredForForm),
        "IsDialog" => Some(UIProperty::IsDialog),

        // Geometry properties
        "BoundingRectangle" => Some(UIProperty::BoundingRectangle),

        // Pattern-specific properties
        "ExpandCollapseExpandCollapseState" => Some(UIProperty::ExpandCollapseExpandCollapseState),

        // Text properties
        "LegacyIAccessibleValue" => Some(UIProperty::LegacyIAccessibleValue),
        "LegacyIAccessibleDescription" => Some(UIProperty::LegacyIAccessibleDescription),
        "LegacyIAccessibleRole" => Some(UIProperty::LegacyIAccessibleRole),
        "LegacyIAccessibleState" => Some(UIProperty::LegacyIAccessibleState),
        "LegacyIAccessibleHelp" => Some(UIProperty::LegacyIAccessibleHelp),
        "LegacyIAccessibleKeyboardShortcut" => Some(UIProperty::LegacyIAccessibleKeyboardShortcut),
        "LegacyIAccessibleName" => Some(UIProperty::LegacyIAccessibleName),
        "LegacyIAccessibleDefaultAction" => Some(UIProperty::LegacyIAccessibleDefaultAction),

        // Unknown properties
        _ => None,
    }
}

pub(crate) fn parse_path(path: &str) -> Option<Vec<PathSegment>> {
    let re = regex::Regex::new(r"^([A-Za-z]+)(?:\[(\d+)\])?$").unwrap();
    let mut segments = Vec::new();

    for part in path.trim_matches('/').split('/') {
        if part.is_empty() {
            continue;
        }

        let caps = re.captures(part)?;
        let control_str = caps.get(1)?.as_str();
        let index = caps.get(2).map_or(1, |m| m.as_str().parse().unwrap_or(1)); // if not index, assume one

        let control_type = match control_str {
            "Window" => ControlType::Window,
            "Pane" => ControlType::Pane,
            "Custom" => ControlType::Custom,
            "Document" => ControlType::Document,
            "Group" => ControlType::Group,
            "Table" => ControlType::Table,
            "DataItem" => ControlType::DataItem,
            "Hyperlink" => ControlType::Hyperlink,
            "Edit" => ControlType::Edit,
            "Button" => ControlType::Button,
            "CheckBox" => ControlType::CheckBox,
            "Menu" => ControlType::Menu,
            "MenuItem" => ControlType::MenuItem,
            "Text" => ControlType::Text,
            "Tree" => ControlType::Tree,
            "TreeItem" => ControlType::TreeItem,
            "DataGrid" => ControlType::DataGrid,
            "List" => ControlType::List,
            "Image" => ControlType::Image,
            "Title" => ControlType::TitleBar,
            "ListItem" => ControlType::ListItem,
            "Combobox" => ControlType::ComboBox,
            "Tab" => ControlType::Tab,
            "TabItem" => ControlType::TabItem,
            "ToolBar" => ControlType::ToolBar,
            "AppBar" => ControlType::AppBar,
            "Calendar" => ControlType::Calendar,
            "ProgressBar" => ControlType::ProgressBar,
            "RadioButton" => ControlType::RadioButton,
            "ScrollBar" => ControlType::ScrollBar,
            "Slider" => ControlType::Slider,
            "Spinner" => ControlType::Spinner,
            "StatusBar" => ControlType::StatusBar,
            "ToolTip" => ControlType::ToolTip,
            "Thumb" => ControlType::Thumb,
            "SplitButton" => ControlType::SplitButton,
            "Header" => ControlType::Header,
            "HeaderItem" => ControlType::HeaderItem,
            "TitleBar" => ControlType::TitleBar,
            "Separator" => ControlType::Separator,
            "SemanticZoom" => ControlType::SemanticZoom,
            _ => return None,
        };

        segments.push(PathSegment {
            control_type,
            index,
        });
    }

    Some(segments)
}
