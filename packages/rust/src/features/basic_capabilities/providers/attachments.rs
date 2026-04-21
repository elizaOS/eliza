//! ATTACHMENTS provider implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_provider_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ProviderDoc> =
    Lazy::new(|| require_provider_spec("ATTACHMENTS"));

/// Provider for message attachments.
pub struct AttachmentsProvider;

#[async_trait]
impl Provider for AttachmentsProvider {
    fn name(&self) -> &'static str {
        &SPEC.name
    }

    fn description(&self) -> &'static str {
        &SPEC.description
    }

    fn is_dynamic(&self) -> bool {
        SPEC.dynamic.unwrap_or(true)
    }

    async fn get(
        &self,
        _runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let attachments = &message.content.attachments;

        if attachments.is_empty() {
            return Ok(ProviderResult::new("")
                .with_value("hasAttachments", false)
                .with_value("attachmentCount", 0i64));
        }

        let formatted: Vec<String> = attachments
            .iter()
            .map(|att| format!("- Type: {}\n  URL: {}", att.attachment_type, att.url))
            .collect();

        let text = format!(
            "# Attachments ({})\n{}",
            attachments.len(),
            formatted.join("\n")
        );

        let types: Vec<String> = attachments
            .iter()
            .map(|a| a.attachment_type.clone())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        Ok(ProviderResult::new(text)
            .with_value("hasAttachments", true)
            .with_value("attachmentCount", attachments.len() as i64)
            .with_data(
                "attachmentTypes",
                serde_json::to_value(&types).unwrap_or_default(),
            )
            .with_data(
                "attachments",
                serde_json::to_value(attachments).unwrap_or_default(),
            ))
    }
}
