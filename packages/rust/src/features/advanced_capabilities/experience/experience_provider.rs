//! EXPERIENCE provider — injects relevant past experiences into context.

use async_trait::async_trait;
use std::sync::Arc;

use crate::basic_capabilities::providers::Provider;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::service::ExperienceService;
use super::types::ExperienceQuery;

/// Provider that surfaces relevant experiences in agent context.
pub struct ExperienceProvider {
    service: Arc<ExperienceService>,
}

impl ExperienceProvider {
    /// Create a new ExperienceProvider backed by the given service.
    pub fn new(service: Arc<ExperienceService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Provider for ExperienceProvider {
    fn name(&self) -> &'static str {
        "EXPERIENCE"
    }

    fn description(&self) -> &'static str {
        "Relevant past experiences and learnings"
    }

    fn is_dynamic(&self) -> bool {
        true
    }

    async fn get(
        &self,
        _runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        // Build a query from current message context
        let query_text = message
            .content
            .text
            .clone()
            .unwrap_or_default();

        let query = ExperienceQuery {
            query: if query_text.is_empty() {
                None
            } else {
                Some(query_text)
            },
            limit: Some(5),
            min_importance: Some(0.3),
            ..Default::default()
        };

        let experiences = self
            .service
            .search(&query)
            .await
            .unwrap_or_default();

        if experiences.is_empty() {
            return Ok(ProviderResult::new("").with_value("experienceCount", 0i64));
        }

        let formatted: Vec<String> = experiences
            .iter()
            .map(|exp| {
                format!(
                    "- [{:?}] {}: {} (confidence: {:.0}%)",
                    exp.experience_type,
                    exp.domain,
                    exp.learning,
                    exp.confidence * 100.0
                )
            })
            .collect();

        let text = format!(
            "# Relevant Experiences\n{}\n",
            formatted.join("\n")
        );

        Ok(ProviderResult::new(text).with_value("experienceCount", experiences.len() as i64))
    }
}
