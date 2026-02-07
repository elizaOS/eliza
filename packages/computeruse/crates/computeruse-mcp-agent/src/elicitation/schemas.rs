//! Elicitation schemas for structured user input
//!
//! These schemas define the data structures that can be requested from users
//! during tool execution via MCP elicitation.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub use rmcp::elicit_safe;

/// Business context for workflow execution
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
#[schemars(description = "Business context for workflow execution")]
pub struct WorkflowContext {
    /// What is the business purpose of this automation?
    #[schemars(description = "What is the business purpose of this automation?")]
    pub business_purpose: String,

    /// Target application name
    #[schemars(description = "Target application name")]
    #[serde(default)]
    pub target_app: Option<String>,

    /// Expected outcome or success criteria
    #[schemars(description = "Expected outcome or success criteria")]
    #[serde(default)]
    pub expected_outcome: Option<String>,
}

/// Element disambiguation when multiple elements match a selector
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[schemars(description = "Choose which element to interact with")]
pub struct ElementDisambiguation {
    /// Which element index to use (0-based)
    #[schemars(description = "Which element should be used? (0-based index)")]
    pub selected_index: usize,

    /// Optional reason for selection
    #[schemars(description = "Why did you choose this element?")]
    #[serde(default)]
    pub reason: Option<String>,
}

/// Error recovery strategy selection
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[schemars(description = "How should we handle this error?")]
pub struct ErrorRecoveryChoice {
    /// The recovery action to take
    #[schemars(description = "Recovery action to take")]
    pub action: ErrorRecoveryAction,

    /// Additional context or modified parameters
    #[schemars(description = "Additional context or modified selector")]
    #[serde(default)]
    pub additional_context: Option<String>,
}

/// Available error recovery actions
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub enum ErrorRecoveryAction {
    /// Retry the same operation
    Retry,
    /// Wait longer for the element to appear
    WaitLonger,
    /// Try an alternative selector
    TryAlternativeSelector,
    /// Skip this step and continue
    Skip,
    /// Abort the workflow
    Abort,
}

/// Confirmation for destructive or irreversible actions
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[schemars(description = "Confirm this action before proceeding")]
pub struct ActionConfirmation {
    /// Whether to proceed with the action
    #[schemars(description = "Do you want to proceed with this action?")]
    pub confirmed: bool,

    /// Optional notes about the decision
    #[schemars(description = "Any notes about your decision")]
    #[serde(default)]
    pub notes: Option<String>,
}

/// Selector refinement when initial selector fails
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[schemars(description = "Help refine the element selector")]
pub struct SelectorRefinement {
    /// A more specific description of the target element
    #[schemars(description = "Describe the element you are trying to interact with")]
    pub element_description: String,

    /// Element type hint
    #[schemars(description = "What type of element is it?")]
    #[serde(default)]
    pub element_type: Option<ElementTypeHint>,

    /// Any visible text on or near the element
    #[schemars(description = "Any visible text on or near the element")]
    #[serde(default)]
    pub visible_text: Option<String>,
}

/// Hints about element types to help with selector refinement
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub enum ElementTypeHint {
    Button,
    TextField,
    Checkbox,
    Dropdown,
    Link,
    Menu,
    Tab,
    ListItem,
    Other,
}

/// Simple user response for the ask_user tool
/// Used when AI needs to ask clarifying questions
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[schemars(description = "Your response to the AI's question")]
pub struct UserResponse {
    /// Your answer or response
    #[schemars(description = "Your answer to the question")]
    pub answer: String,
}

// Mark types as safe for elicitation (generates proper JSON schemas)
elicit_safe!(WorkflowContext);
elicit_safe!(ElementDisambiguation);
elicit_safe!(ErrorRecoveryChoice);
elicit_safe!(ActionConfirmation);
elicit_safe!(SelectorRefinement);
elicit_safe!(UserResponse);
