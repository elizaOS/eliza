mod documents;
mod knowledge;

pub use documents::DocumentsProvider;
pub use knowledge::KnowledgeProvider;

use async_trait::async_trait;
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct ProviderContext {
    pub agent_id: Uuid,
    pub entity_id: Option<Uuid>,
    pub room_id: Option<Uuid>,
    pub query: Option<String>,
    pub state: Value,
}

#[derive(Debug, Clone)]
pub struct ProviderResult {
    pub data: Value,
    pub values: Value,
    pub text: String,
}

impl Default for ProviderResult {
    fn default() -> Self {
        Self {
            data: serde_json::json!({}),
            values: serde_json::json!({}),
            text: String::new(),
        }
    }
}

#[async_trait]
pub trait KnowledgeProviderTrait: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn dynamic(&self) -> bool;
    async fn get(&self, context: &ProviderContext) -> ProviderResult;
}
