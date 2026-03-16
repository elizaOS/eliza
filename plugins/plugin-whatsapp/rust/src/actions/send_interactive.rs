//! Send interactive message action for WhatsApp plugin.

use crate::client::WhatsAppClientError;
use crate::service::WhatsAppService;
use crate::types::{ListRow, ListSection, WhatsAppMessageResponse};
use tracing::info;

/// Action name.
pub const SEND_INTERACTIVE_ACTION: &str = "WHATSAPP_SEND_INTERACTIVE";

/// Interactive message type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InteractiveType {
    Button,
    List,
}

impl InteractiveType {
    /// Parse from string.
    pub fn from_str(s: &str) -> Result<Self, String> {
        match s.to_lowercase().as_str() {
            "button" | "buttons" => Ok(InteractiveType::Button),
            "list" => Ok(InteractiveType::List),
            _ => Err(format!("Invalid interactive type: {}", s)),
        }
    }

    /// Get string representation.
    pub fn as_str(&self) -> &'static str {
        match self {
            InteractiveType::Button => "button",
            InteractiveType::List => "list",
        }
    }
}

/// Button definition.
#[derive(Debug, Clone)]
pub struct InteractiveButton {
    /// Button ID.
    pub id: String,
    /// Button title.
    pub title: String,
}

impl InteractiveButton {
    /// Create a new button.
    pub fn new(id: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
        }
    }

    /// Convert to tuple for API.
    pub fn to_tuple(&self) -> (String, String) {
        (self.id.clone(), self.title.clone())
    }
}

/// Parameters for sending a WhatsApp interactive message.
#[derive(Debug, Clone)]
pub struct SendInteractiveParams {
    /// Recipient phone number.
    pub to: String,
    /// Interactive message type.
    pub interactive_type: InteractiveType,
    /// Body text.
    pub body_text: String,
    /// Buttons (for button type).
    pub buttons: Option<Vec<InteractiveButton>>,
    /// Sections (for list type).
    pub sections: Option<Vec<ListSection>>,
    /// List button text (for list type).
    pub list_button_text: Option<String>,
    /// Header text.
    pub header_text: Option<String>,
    /// Footer text.
    pub footer_text: Option<String>,
}

impl SendInteractiveParams {
    /// Create new button message parameters.
    pub fn button_message(
        to: impl Into<String>,
        body_text: impl Into<String>,
        buttons: Vec<InteractiveButton>,
    ) -> Self {
        Self {
            to: to.into(),
            interactive_type: InteractiveType::Button,
            body_text: body_text.into(),
            buttons: Some(buttons),
            sections: None,
            list_button_text: None,
            header_text: None,
            footer_text: None,
        }
    }

    /// Create new list message parameters.
    pub fn list_message(
        to: impl Into<String>,
        body_text: impl Into<String>,
        button_text: impl Into<String>,
        sections: Vec<ListSection>,
    ) -> Self {
        Self {
            to: to.into(),
            interactive_type: InteractiveType::List,
            body_text: body_text.into(),
            buttons: None,
            sections: Some(sections),
            list_button_text: Some(button_text.into()),
            header_text: None,
            footer_text: None,
        }
    }

    /// Set header text.
    pub fn with_header(mut self, text: impl Into<String>) -> Self {
        self.header_text = Some(text.into());
        self
    }

    /// Set footer text.
    pub fn with_footer(mut self, text: impl Into<String>) -> Self {
        self.footer_text = Some(text.into());
        self
    }
}

/// Validate interactive parameters.
pub fn validate(params: &SendInteractiveParams) -> Result<(), String> {
    if params.to.is_empty() {
        return Err("Recipient phone number is required".to_string());
    }
    if params.body_text.is_empty() {
        return Err("Body text is required".to_string());
    }

    match params.interactive_type {
        InteractiveType::Button => {
            let buttons = params
                .buttons
                .as_ref()
                .ok_or("Buttons are required for button type")?;
            if buttons.is_empty() {
                return Err("At least one button is required".to_string());
            }
            if buttons.len() > 3 {
                return Err("Maximum 3 buttons allowed".to_string());
            }
            for button in buttons {
                if button.title.len() > 20 {
                    return Err(format!("Button title too long: {}", button.title));
                }
            }
        }
        InteractiveType::List => {
            let sections = params
                .sections
                .as_ref()
                .ok_or("Sections are required for list type")?;
            if sections.is_empty() {
                return Err("At least one section is required".to_string());
            }
            if params.list_button_text.is_none() {
                return Err("List button text is required for list type".to_string());
            }
            let total_rows: usize = sections.iter().map(|s| s.rows.len()).sum();
            if total_rows > 10 {
                return Err("Maximum 10 rows allowed across all sections".to_string());
            }
        }
    }

    Ok(())
}

/// Execute the send interactive action.
pub async fn execute_send_interactive(
    service: &WhatsAppService,
    params: SendInteractiveParams,
) -> Result<WhatsAppMessageResponse, WhatsAppClientError> {
    validate(&params).map_err(|e| WhatsAppClientError::Config(e))?;

    let response = match params.interactive_type {
        InteractiveType::Button => {
            let buttons: Vec<(String, String)> = params
                .buttons
                .unwrap_or_default()
                .into_iter()
                .map(|b| b.to_tuple())
                .collect();

            service
                .send_button_message(
                    &params.to,
                    &params.body_text,
                    &buttons,
                    params.header_text.as_deref(),
                    params.footer_text.as_deref(),
                )
                .await?
        }
        InteractiveType::List => {
            service
                .send_list_message(
                    &params.to,
                    &params.body_text,
                    params.list_button_text.as_deref().unwrap_or("Select"),
                    params.sections.unwrap_or_default(),
                    params.header_text.as_deref(),
                    params.footer_text.as_deref(),
                )
                .await?
        }
    };

    info!(
        "Sent WhatsApp interactive {} to {}, message_id={}",
        params.interactive_type.as_str(),
        params.to,
        response.messages.first().map(|m| &m.id).unwrap_or(&"unknown".to_string())
    );

    Ok(response)
}
