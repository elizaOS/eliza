//! # elizaos-plugin-webhooks
//!
//! HTTP webhook ingress plugin for elizaOS.
//!
//! Exposes three route groups:
//!   - `POST /hooks/wake`   – Enqueue system event + optional immediate heartbeat
//!   - `POST /hooks/agent`  – Run isolated agent turn + optional delivery
//!   - `POST /hooks/:name`  – Mapped webhook (resolves via `hooks.mappings` config)
//!
//! No separate HTTP server is created – routes register on the runtime's
//! existing HTTP server via the Eliza plugin system.
//!
//! ## Example config (`character.settings`):
//!
//! ```json5
//! {
//!   hooks: {
//!     enabled: true,
//!     token: "shared-secret",
//!     presets: ["gmail"],
//!     mappings: [
//!       {
//!         match: { path: "github" },
//!         action: "agent",
//!         name: "GitHub",
//!         messageTemplate: "New event: {{action}} on {{repository.full_name}}",
//!         wakeMode: "now",
//!         deliver: true,
//!         channel: "discord",
//!         to: "channel:123456789",
//!       }
//!     ],
//!   }
//! }
//! ```

pub mod auth;
pub mod error;
pub mod handlers;
pub mod mappings;
pub mod types;

// Re-exports for convenience
pub use auth::{extract_token, validate_token, RequestParts};
pub use error::WebhookError;
pub use handlers::{handle_agent, handle_mapped, handle_wake, AgentRuntime};
pub use mappings::{apply_mapping, find_mapping, render_template};
pub use types::{
    AppliedMapping, HandlerResponse, HookAction, HookMapping, HookMatch, HooksConfig, WakeMode,
};
