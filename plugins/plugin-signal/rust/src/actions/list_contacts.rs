//! List contacts action for Signal plugin.

use crate::service::SignalService;
use crate::types::get_signal_contact_display_name;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Parameters for listing Signal contacts (none required)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ListContactsParams {
    /// Whether to include blocked contacts
    #[serde(default)]
    pub include_blocked: bool,
}

/// Contact info in result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactInfo {
    pub number: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
}

/// Result of listing Signal contacts
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListContactsResult {
    pub success: bool,
    pub contact_count: usize,
    pub contacts: Vec<ContactInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Execute the list contacts action
pub async fn execute_list_contacts(
    service: Arc<SignalService>,
    params: ListContactsParams,
) -> ListContactsResult {
    match service.get_contacts().await {
        Ok(contacts) => {
            // Filter and sort contacts
            let mut filtered: Vec<_> = contacts
                .into_iter()
                .filter(|c| params.include_blocked || !c.blocked)
                .collect();

            filtered.sort_by(|a, b| {
                get_signal_contact_display_name(a)
                    .to_lowercase()
                    .cmp(&get_signal_contact_display_name(b).to_lowercase())
            });

            let contact_infos: Vec<ContactInfo> = filtered
                .iter()
                .map(|c| ContactInfo {
                    number: c.number.clone(),
                    name: get_signal_contact_display_name(c),
                    uuid: c.uuid.clone(),
                })
                .collect();

            ListContactsResult {
                success: true,
                contact_count: contact_infos.len(),
                contacts: contact_infos,
                error: None,
            }
        }
        Err(e) => ListContactsResult {
            success: false,
            contact_count: 0,
            contacts: vec![],
            error: Some(e.to_string()),
        },
    }
}

/// Format contacts as a human-readable string
pub fn format_contacts_text(result: &ListContactsResult) -> String {
    if !result.success {
        return format!(
            "Failed to list contacts: {}",
            result.error.as_deref().unwrap_or("Unknown error")
        );
    }

    if result.contacts.is_empty() {
        return "No contacts found.".to_string();
    }

    let mut lines = vec![format!("Found {} contacts:", result.contact_count)];
    lines.push(String::new());

    for contact in &result.contacts {
        lines.push(format!("• {} ({})", contact.name, contact.number));
    }

    lines.join("\n")
}

/// Action metadata
pub const ACTION_NAME: &str = "SIGNAL_LIST_CONTACTS";
pub const ACTION_DESCRIPTION: &str = "List Signal contacts";
pub const ACTION_SIMILES: &[&str] = &[
    "LIST_SIGNAL_CONTACTS",
    "SHOW_CONTACTS",
    "GET_CONTACTS",
    "SIGNAL_CONTACTS",
];
