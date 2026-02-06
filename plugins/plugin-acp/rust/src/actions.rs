//! ACP Actions for elizaOS
//!
//! Actions that enable AI agents to interact with the Agentic Commerce Protocol.

use crate::error::{AcpError, Result};
use crate::types::*;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Action result containing success status and data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult<T> {
    /// Whether the action succeeded
    pub success: bool,
    /// Result data (if success)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    /// Error message (if failure)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Human-readable response text
    pub text: String,
}

impl<T> ActionResult<T> {
    /// Create a successful result
    pub fn success(data: T, text: impl Into<String>) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
            text: text.into(),
        }
    }

    /// Create a failed result
    pub fn failure(error: impl Into<String>) -> Self {
        let error_msg = error.into();
        Self {
            success: false,
            data: None,
            error: Some(error_msg.clone()),
            text: error_msg,
        }
    }
}

/// Context for action execution
#[derive(Debug, Clone, Default)]
pub struct ActionContext {
    /// Environment variables
    pub env: HashMap<String, String>,
    /// User ID
    pub user_id: Option<String>,
    /// Session ID (for conversation)
    pub session_id: Option<String>,
    /// Additional metadata
    pub metadata: HashMap<String, serde_json::Value>,
}

impl ActionContext {
    /// Create a new action context
    pub fn new() -> Self {
        Self::default()
    }

    /// Get an environment variable
    pub fn get_env(&self, key: &str) -> Option<&String> {
        self.env.get(key)
    }

    /// Set an environment variable
    pub fn set_env(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.env.insert(key.into(), value.into());
    }
}

/// Trait for ACP actions
#[async_trait]
pub trait AcpAction {
    /// The input type for this action
    type Input: Send + Sync;
    /// The output type for this action
    type Output: Send + Sync + Serialize;

    /// Action name
    fn name(&self) -> &'static str;

    /// Action description
    fn description(&self) -> &'static str;

    /// Validate the action can be executed
    async fn validate(&self, context: &ActionContext) -> Result<bool>;

    /// Execute the action
    async fn execute(
        &self,
        input: Self::Input,
        context: &ActionContext,
    ) -> ActionResult<Self::Output>;
}

/// Create checkout session action
pub struct CreateCheckoutSessionAction;

impl CreateCheckoutSessionAction {
    /// Create a new instance
    pub fn new() -> Self {
        Self
    }
}

impl Default for CreateCheckoutSessionAction {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AcpAction for CreateCheckoutSessionAction {
    type Input = CreateCheckoutSessionRequest;
    type Output = CheckoutSession;

    fn name(&self) -> &'static str {
        "createCheckoutSession"
    }

    fn description(&self) -> &'static str {
        "Create a new ACP checkout session with items to purchase"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        // Check required environment variables
        if context.get_env("ACP_MERCHANT_BASE_URL").is_none() {
            return Err(AcpError::MissingConfig("ACP_MERCHANT_BASE_URL".to_string()));
        }
        Ok(true)
    }

    async fn execute(
        &self,
        input: Self::Input,
        context: &ActionContext,
    ) -> ActionResult<Self::Output> {
        // Validate first
        if let Err(e) = self.validate(context).await {
            return ActionResult::failure(e.to_string());
        }

        // Get configuration from context
        let base_url = match context.get_env("ACP_MERCHANT_BASE_URL") {
            Some(url) => url.clone(),
            None => return ActionResult::failure("Missing ACP_MERCHANT_BASE_URL"),
        };

        let config = crate::config::AcpClientConfig::new(&base_url);
        let config = if let Some(api_key) = context.get_env("ACP_MERCHANT_API_KEY") {
            config.with_api_key(api_key)
        } else {
            config
        };

        // Create client and execute
        let client = match crate::client::AcpClient::new(config) {
            Ok(c) => c,
            Err(e) => return ActionResult::failure(format!("Failed to create client: {}", e)),
        };

        match client.create_checkout_session(input, None).await {
            Ok(session) => {
                let text = format!(
                    "Created checkout session {} with {} items. Status: {:?}",
                    session.id,
                    session.line_items.len(),
                    session.status
                );
                ActionResult::success(session, text)
            }
            Err(e) => ActionResult::failure(format!("Failed to create checkout session: {}", e)),
        }
    }
}

/// Get checkout session action
pub struct GetCheckoutSessionAction;

impl GetCheckoutSessionAction {
    /// Create a new instance
    pub fn new() -> Self {
        Self
    }
}

impl Default for GetCheckoutSessionAction {
    fn default() -> Self {
        Self::new()
    }
}

/// Input for get checkout session action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetCheckoutSessionInput {
    /// Session ID
    pub session_id: String,
}

#[async_trait]
impl AcpAction for GetCheckoutSessionAction {
    type Input = GetCheckoutSessionInput;
    type Output = CheckoutSession;

    fn name(&self) -> &'static str {
        "getCheckoutSession"
    }

    fn description(&self) -> &'static str {
        "Retrieve an existing ACP checkout session by ID"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        if context.get_env("ACP_MERCHANT_BASE_URL").is_none() {
            return Err(AcpError::MissingConfig("ACP_MERCHANT_BASE_URL".to_string()));
        }
        Ok(true)
    }

    async fn execute(
        &self,
        input: Self::Input,
        context: &ActionContext,
    ) -> ActionResult<Self::Output> {
        if let Err(e) = self.validate(context).await {
            return ActionResult::failure(e.to_string());
        }

        let base_url = match context.get_env("ACP_MERCHANT_BASE_URL") {
            Some(url) => url.clone(),
            None => return ActionResult::failure("Missing ACP_MERCHANT_BASE_URL"),
        };

        let config = crate::config::AcpClientConfig::new(&base_url);
        let config = if let Some(api_key) = context.get_env("ACP_MERCHANT_API_KEY") {
            config.with_api_key(api_key)
        } else {
            config
        };

        let client = match crate::client::AcpClient::new(config) {
            Ok(c) => c,
            Err(e) => return ActionResult::failure(format!("Failed to create client: {}", e)),
        };

        match client.get_checkout_session(&input.session_id).await {
            Ok(session) => {
                let text = format!(
                    "Retrieved checkout session {}. Status: {:?}, {} items",
                    session.id,
                    session.status,
                    session.line_items.len()
                );
                ActionResult::success(session, text)
            }
            Err(e) => ActionResult::failure(format!("Failed to get checkout session: {}", e)),
        }
    }
}

/// Update checkout session action
pub struct UpdateCheckoutSessionAction;

impl UpdateCheckoutSessionAction {
    /// Create a new instance
    pub fn new() -> Self {
        Self
    }
}

impl Default for UpdateCheckoutSessionAction {
    fn default() -> Self {
        Self::new()
    }
}

/// Input for update checkout session action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCheckoutSessionInput {
    /// Session ID
    pub session_id: String,
    /// Update request
    pub request: UpdateCheckoutSessionRequest,
}

#[async_trait]
impl AcpAction for UpdateCheckoutSessionAction {
    type Input = UpdateCheckoutSessionInput;
    type Output = CheckoutSession;

    fn name(&self) -> &'static str {
        "updateCheckoutSession"
    }

    fn description(&self) -> &'static str {
        "Update an existing ACP checkout session with buyer info, shipping, or items"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        if context.get_env("ACP_MERCHANT_BASE_URL").is_none() {
            return Err(AcpError::MissingConfig("ACP_MERCHANT_BASE_URL".to_string()));
        }
        Ok(true)
    }

    async fn execute(
        &self,
        input: Self::Input,
        context: &ActionContext,
    ) -> ActionResult<Self::Output> {
        if let Err(e) = self.validate(context).await {
            return ActionResult::failure(e.to_string());
        }

        let base_url = match context.get_env("ACP_MERCHANT_BASE_URL") {
            Some(url) => url.clone(),
            None => return ActionResult::failure("Missing ACP_MERCHANT_BASE_URL"),
        };

        let config = crate::config::AcpClientConfig::new(&base_url);
        let config = if let Some(api_key) = context.get_env("ACP_MERCHANT_API_KEY") {
            config.with_api_key(api_key)
        } else {
            config
        };

        let client = match crate::client::AcpClient::new(config) {
            Ok(c) => c,
            Err(e) => return ActionResult::failure(format!("Failed to create client: {}", e)),
        };

        match client
            .update_checkout_session(&input.session_id, input.request, None)
            .await
        {
            Ok(session) => {
                let text = format!(
                    "Updated checkout session {}. Status: {:?}",
                    session.id, session.status
                );
                ActionResult::success(session, text)
            }
            Err(e) => ActionResult::failure(format!("Failed to update checkout session: {}", e)),
        }
    }
}

/// Complete checkout session action
pub struct CompleteCheckoutSessionAction;

impl CompleteCheckoutSessionAction {
    /// Create a new instance
    pub fn new() -> Self {
        Self
    }
}

impl Default for CompleteCheckoutSessionAction {
    fn default() -> Self {
        Self::new()
    }
}

/// Input for complete checkout session action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompleteCheckoutSessionInput {
    /// Session ID
    pub session_id: String,
    /// Complete request with payment data
    pub request: CompleteCheckoutSessionRequest,
}

#[async_trait]
impl AcpAction for CompleteCheckoutSessionAction {
    type Input = CompleteCheckoutSessionInput;
    type Output = CheckoutSession;

    fn name(&self) -> &'static str {
        "completeCheckoutSession"
    }

    fn description(&self) -> &'static str {
        "Complete an ACP checkout session with payment data"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        if context.get_env("ACP_MERCHANT_BASE_URL").is_none() {
            return Err(AcpError::MissingConfig("ACP_MERCHANT_BASE_URL".to_string()));
        }
        Ok(true)
    }

    async fn execute(
        &self,
        input: Self::Input,
        context: &ActionContext,
    ) -> ActionResult<Self::Output> {
        if let Err(e) = self.validate(context).await {
            return ActionResult::failure(e.to_string());
        }

        let base_url = match context.get_env("ACP_MERCHANT_BASE_URL") {
            Some(url) => url.clone(),
            None => return ActionResult::failure("Missing ACP_MERCHANT_BASE_URL"),
        };

        let config = crate::config::AcpClientConfig::new(&base_url);
        let config = if let Some(api_key) = context.get_env("ACP_MERCHANT_API_KEY") {
            config.with_api_key(api_key)
        } else {
            config
        };

        let client = match crate::client::AcpClient::new(config) {
            Ok(c) => c,
            Err(e) => return ActionResult::failure(format!("Failed to create client: {}", e)),
        };

        match client
            .complete_checkout_session(&input.session_id, input.request, None)
            .await
        {
            Ok(session) => {
                let text = if let Some(ref order) = session.order {
                    format!(
                        "Completed checkout session {}. Order ID: {}, Status: {:?}",
                        session.id, order.id, session.status
                    )
                } else {
                    format!(
                        "Completed checkout session {}. Status: {:?}",
                        session.id, session.status
                    )
                };
                ActionResult::success(session, text)
            }
            Err(e) => ActionResult::failure(format!("Failed to complete checkout session: {}", e)),
        }
    }
}

/// Cancel checkout session action
pub struct CancelCheckoutSessionAction;

impl CancelCheckoutSessionAction {
    /// Create a new instance
    pub fn new() -> Self {
        Self
    }
}

impl Default for CancelCheckoutSessionAction {
    fn default() -> Self {
        Self::new()
    }
}

/// Input for cancel checkout session action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelCheckoutSessionInput {
    /// Session ID
    pub session_id: String,
    /// Cancel request with optional intent trace
    pub request: CancelCheckoutSessionRequest,
}

#[async_trait]
impl AcpAction for CancelCheckoutSessionAction {
    type Input = CancelCheckoutSessionInput;
    type Output = CheckoutSession;

    fn name(&self) -> &'static str {
        "cancelCheckoutSession"
    }

    fn description(&self) -> &'static str {
        "Cancel an ACP checkout session with optional reason"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        if context.get_env("ACP_MERCHANT_BASE_URL").is_none() {
            return Err(AcpError::MissingConfig("ACP_MERCHANT_BASE_URL".to_string()));
        }
        Ok(true)
    }

    async fn execute(
        &self,
        input: Self::Input,
        context: &ActionContext,
    ) -> ActionResult<Self::Output> {
        if let Err(e) = self.validate(context).await {
            return ActionResult::failure(e.to_string());
        }

        let base_url = match context.get_env("ACP_MERCHANT_BASE_URL") {
            Some(url) => url.clone(),
            None => return ActionResult::failure("Missing ACP_MERCHANT_BASE_URL"),
        };

        let config = crate::config::AcpClientConfig::new(&base_url);
        let config = if let Some(api_key) = context.get_env("ACP_MERCHANT_API_KEY") {
            config.with_api_key(api_key)
        } else {
            config
        };

        let client = match crate::client::AcpClient::new(config) {
            Ok(c) => c,
            Err(e) => return ActionResult::failure(format!("Failed to create client: {}", e)),
        };

        match client
            .cancel_checkout_session(&input.session_id, input.request, None)
            .await
        {
            Ok(session) => {
                let text = format!(
                    "Canceled checkout session {}. Status: {:?}",
                    session.id, session.status
                );
                ActionResult::success(session, text)
            }
            Err(e) => ActionResult::failure(format!("Failed to cancel checkout session: {}", e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_action_result_success() {
        let result: ActionResult<String> =
            ActionResult::success("test data".to_string(), "Success message");
        assert!(result.success);
        assert_eq!(result.data, Some("test data".to_string()));
        assert!(result.error.is_none());
        assert_eq!(result.text, "Success message");
    }

    #[test]
    fn test_action_result_failure() {
        let result: ActionResult<String> = ActionResult::failure("Error occurred");
        assert!(!result.success);
        assert!(result.data.is_none());
        assert_eq!(result.error, Some("Error occurred".to_string()));
        assert_eq!(result.text, "Error occurred");
    }

    #[test]
    fn test_action_context() {
        let mut context = ActionContext::new();
        context.set_env("ACP_MERCHANT_BASE_URL", "https://api.test.com");

        assert_eq!(
            context.get_env("ACP_MERCHANT_BASE_URL"),
            Some(&"https://api.test.com".to_string())
        );
        assert!(context.get_env("NONEXISTENT").is_none());
    }

    #[test]
    fn test_action_names() {
        assert_eq!(CreateCheckoutSessionAction::new().name(), "createCheckoutSession");
        assert_eq!(GetCheckoutSessionAction::new().name(), "getCheckoutSession");
        assert_eq!(UpdateCheckoutSessionAction::new().name(), "updateCheckoutSession");
        assert_eq!(CompleteCheckoutSessionAction::new().name(), "completeCheckoutSession");
        assert_eq!(CancelCheckoutSessionAction::new().name(), "cancelCheckoutSession");
    }
}
