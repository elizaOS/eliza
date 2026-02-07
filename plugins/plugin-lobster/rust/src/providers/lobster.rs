//! Lobster provider for context injection

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::service::LobsterService;
use crate::{Provider, ProviderResult};

const LOBSTER_HELP: &str = r#"
## Lobster Workflow Runtime

Lobster is available for running multi-step pipelines with approval checkpoints.

### Commands

- `lobster run <pipeline>` - Run a pipeline
- `lobster resume <token>` - Resume a paused pipeline

### Example

```
lobster run deploy-pipeline
```

When a pipeline reaches an approval step, you'll be prompted to approve or reject.
"#;

/// Provider that supplies Lobster context
pub struct LobsterProvider {
    name: &'static str,
    description: &'static str,
    position: i32,
}

impl LobsterProvider {
    pub fn new() -> Self {
        Self {
            name: "lobster",
            description: "Provides Lobster workflow runtime context",
            position: 100,
        }
    }
}

impl Default for LobsterProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Provider for LobsterProvider {
    fn name(&self) -> &str {
        self.name
    }

    fn description(&self) -> &str {
        self.description
    }

    fn position(&self) -> i32 {
        self.position
    }

    async fn get(
        &self,
        _message: &Value,
        state: &Value,
        service: Option<&LobsterService>,
    ) -> ProviderResult {
        // Check availability
        let available = if let Some(svc) = service {
            svc.is_available().await
        } else {
            false
        };

        if !available {
            return ProviderResult {
                values: json!({ "available": false }),
                text: "Lobster is not available. Install it to enable pipeline execution.".to_string(),
                data: json!({ "available": false }),
            };
        }

        // Check for pending approval
        let pending_token = state
            .get("pendingLobsterToken")
            .and_then(|v| v.as_str());

        if let Some(token) = pending_token {
            return ProviderResult {
                values: json!({ "available": true, "pendingApproval": true }),
                text: "Lobster has a pending approval. Reply with 'approve' or 'reject' to continue the pipeline.".to_string(),
                data: json!({
                    "available": true,
                    "pendingApproval": true,
                    "resumeToken": token,
                }),
            };
        }

        ProviderResult {
            values: json!({ "available": true }),
            text: LOBSTER_HELP.to_string(),
            data: json!({ "available": true }),
        }
    }
}
