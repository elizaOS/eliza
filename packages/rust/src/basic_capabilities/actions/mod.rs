// basic_capabilities/actions/mod.rs
pub mod choice;
pub mod ignore;
pub mod none;
pub mod reply;

pub use choice::ChooseOptionAction;
pub use ignore::IgnoreAction;
pub use none::NoneAction;
pub use reply::ReplyAction;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};
use async_trait::async_trait;
use std::sync::Arc;

/// Trait that all actions must implement.
#[async_trait]
pub trait Action: Send + Sync {
    /// Get the action name.
    fn name(&self) -> &'static str;

    /// Get action similes (alternative names).
    fn similes(&self) -> &[&'static str];

    /// Get action description.
    fn description(&self) -> &'static str;

    /// Validate whether the action can be executed.
    async fn validate(&self, runtime: &dyn IAgentRuntime, message: &Memory) -> bool;

    /// Execute the action.
    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        state: Option<&State>,
        responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult>;
}

/// Callback type for action responses.
pub type ActionCallback = Box<dyn Fn(&crate::types::Content) + Send + Sync>;

/// Get basic actions (always available).
pub fn basic_actions() -> Vec<Box<dyn Action>> {
    vec![
        Box::new(ChooseOptionAction),
        Box::new(ReplyAction),
        Box::new(IgnoreAction),
        Box::new(NoneAction),
    ]
}
