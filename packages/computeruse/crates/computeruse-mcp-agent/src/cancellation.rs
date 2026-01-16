use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn, Instrument};

use crate::child_process;

/// Context for a single MCP request that can be cancelled
#[derive(Clone, Debug)]
pub struct RequestContext {
    pub request_id: String,
    pub cancellation_token: CancellationToken,
    pub timeout_duration: Option<Duration>,
    pub started_at: Instant,
}

impl RequestContext {
    pub fn new(request_id: String, timeout_ms: Option<u64>) -> Self {
        Self {
            request_id: request_id.clone(),
            cancellation_token: CancellationToken::new(),
            timeout_duration: timeout_ms.map(Duration::from_millis),
            started_at: Instant::now(),
        }
    }

    /// Check if this request has been cancelled
    pub fn is_cancelled(&self) -> bool {
        self.cancellation_token.is_cancelled()
    }

    /// Cancel this request
    pub fn cancel(&self) {
        self.cancellation_token.cancel();
    }

    /// Get elapsed time since request started
    pub fn elapsed(&self) -> Duration {
        self.started_at.elapsed()
    }

    /// Check if request has timed out
    pub fn is_timed_out(&self) -> bool {
        if let Some(timeout) = self.timeout_duration {
            self.elapsed() > timeout
        } else {
            false
        }
    }

    /// Create a child token that will be cancelled when parent is cancelled
    pub fn child_token(&self) -> CancellationToken {
        self.cancellation_token.child_token()
    }
}

/// Manages active requests and their cancellation tokens
pub struct RequestManager {
    active_requests: Arc<RwLock<HashMap<String, RequestContext>>>,
}

impl RequestManager {
    pub fn new() -> Self {
        Self {
            active_requests: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Register a new request
    pub async fn register(&self, request_id: String, timeout_ms: Option<u64>) -> RequestContext {
        let context = RequestContext::new(request_id.clone(), timeout_ms);

        // Start timeout task if timeout is specified
        if let Some(timeout) = context.timeout_duration {
            let context_clone = context.clone();
            let manager = self.clone();
            tokio::spawn(
                async move {
                    tokio::time::sleep(timeout).await;
                    if !context_clone.is_cancelled() {
                        warn!(
                            "Request {} timed out after {:?}",
                            context_clone.request_id, timeout
                        );
                        context_clone.cancel();
                        manager.unregister(&context_clone.request_id).await;
                    }
                }
                .in_current_span(),
            );
        }

        let mut requests = self.active_requests.write().await;
        requests.insert(request_id.clone(), context.clone());
        context
    }

    /// Unregister a request (cleanup)
    pub async fn unregister(&self, request_id: &str) {
        let mut requests = self.active_requests.write().await;
        if let Some(context) = requests.remove(request_id) {
            // Cancel if not already cancelled
            if !context.is_cancelled() {
                context.cancel();
            }
        }
    }

    /// Cancel a specific request by ID
    pub async fn cancel_request(&self, request_id: &str) -> bool {
        let requests = self.active_requests.read().await;
        if let Some(context) = requests.get(request_id) {
            context.cancel();
            true
        } else {
            false
        }
    }

    /// Get active request count
    pub async fn active_count(&self) -> usize {
        self.active_requests.read().await.len()
    }

    /// Cancel all active requests and kill their child processes
    pub async fn cancel_all(&self) {
        let requests = self.active_requests.read().await;
        let count = requests.len();
        info!(
            "[STOP-DEBUG] cancel_all: found {} active requests to cancel",
            count
        );
        let mut total_killed = 0;
        for (id, context) in requests.iter() {
            info!("[STOP-DEBUG] Cancelling request: {}", id);
            context.cancel();
            // Kill child processes associated with this execution_id
            let killed = child_process::kill_by_execution_id(id);
            total_killed += killed;
        }
        info!(
            "[STOP-DEBUG] cancel_all: cancelled {} requests, killed {} child processes",
            count, total_killed
        );
    }

    /// Get a request context by ID
    pub async fn get(&self, request_id: &str) -> Option<RequestContext> {
        self.active_requests.read().await.get(request_id).cloned()
    }
}

impl Clone for RequestManager {
    fn clone(&self) -> Self {
        Self {
            active_requests: self.active_requests.clone(),
        }
    }
}

impl Default for RequestManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Helper function to wrap an async operation with cancellation support
pub async fn with_cancellation<F, T>(
    context: &RequestContext,
    operation: F,
) -> Result<T, CancellationError>
where
    F: std::future::Future<Output = T>,
{
    tokio::select! {
        result = operation => Ok(result),
        _ = context.cancellation_token.cancelled() => {
            Err(CancellationError::Cancelled(context.request_id.clone()))
        }
    }
}

/// Error type for cancellation
#[derive(Debug, Clone)]
pub enum CancellationError {
    Cancelled(String),
    TimedOut(String),
}

impl std::fmt::Display for CancellationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CancellationError::Cancelled(id) => write!(f, "Request {id} was cancelled"),
            CancellationError::TimedOut(id) => write!(f, "Request {id} timed out"),
        }
    }
}

impl std::error::Error for CancellationError {}

/// Convert CancellationError to MCP error
impl From<CancellationError> for rmcp::ErrorData {
    fn from(err: CancellationError) -> Self {
        match err {
            CancellationError::Cancelled(id) => rmcp::ErrorData::internal_error(
                format!("Request cancelled: {id}"),
                Some(serde_json::json!({
                    "code": -32001,
                    "request_id": id
                })),
            ),
            CancellationError::TimedOut(id) => rmcp::ErrorData::internal_error(
                format!("Request timed out: {id}"),
                Some(serde_json::json!({
                    "code": -32002,
                    "request_id": id
                })),
            ),
        }
    }
}
