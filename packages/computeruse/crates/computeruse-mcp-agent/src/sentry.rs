// Sentry error tracking support for MCP server
// This module is only compiled when the 'sentry' feature is enabled

#[cfg(feature = "sentry")]
pub use with_sentry::*;

#[cfg(not(feature = "sentry"))]
pub use without_sentry::*;

// Implementation with Sentry enabled
#[cfg(feature = "sentry")]
mod with_sentry {
    use tracing::info;

    /// Initialize Sentry error tracking
    /// Requires SENTRY_DSN environment variable to be set
    /// Returns a guard that should be kept alive for the lifetime of the application
    pub fn init_sentry() -> Option<sentry::ClientInitGuard> {
        // Check if Sentry is explicitly disabled
        if std::env::var("SENTRY_DISABLED")
            .unwrap_or_default()
            .eq_ignore_ascii_case("true")
        {
            info!("Sentry is disabled via SENTRY_DISABLED environment variable");
            return None;
        }

        // Get DSN from environment
        let dsn = match std::env::var("SENTRY_DSN") {
            Ok(dsn) if !dsn.is_empty() => dsn,
            _ => {
                info!("Sentry DSN not configured (SENTRY_DSN env var not set). Error tracking disabled.");
                return None;
            }
        };

        info!("Initializing Sentry error tracking...");

        // Get environment and release information
        let environment =
            std::env::var("SENTRY_ENVIRONMENT").unwrap_or_else(|_| "production".to_string());

        let release = std::env::var("SENTRY_RELEASE")
            .unwrap_or_else(|_| format!("computeruse-mcp-agent@{}", env!("CARGO_PKG_VERSION")));

        // Get sample rate (default to 1.0 = 100% of errors)
        let traces_sample_rate = std::env::var("SENTRY_TRACES_SAMPLE_RATE")
            .ok()
            .and_then(|s| s.parse::<f32>().ok())
            .unwrap_or(1.0);

        // Clone release for logging since it will be moved into ClientOptions
        let release_for_log = release.clone();

        // Initialize Sentry with configuration
        let guard = sentry::init((
            dsn,
            sentry::ClientOptions {
                release: Some(release.into()),
                environment: Some(environment.into()),
                traces_sample_rate,
                attach_stacktrace: true,
                // Don't send default PII (can be enabled via SENTRY_SEND_DEFAULT_PII=true)
                send_default_pii: std::env::var("SENTRY_SEND_DEFAULT_PII")
                    .unwrap_or_default()
                    .eq_ignore_ascii_case("true"),
                ..Default::default()
            },
        ));

        // Add server context
        sentry::configure_scope(|scope| {
            scope.set_tag("server", "computeruse-mcp-agent");
            scope.set_tag("version", env!("CARGO_PKG_VERSION"));

            // Add hostname for context
            if let Ok(hostname) = hostname::get() {
                if let Some(hostname_str) = hostname.to_str() {
                    scope.set_tag("hostname", hostname_str);
                }
            }

            // Add platform info
            scope.set_tag("platform", std::env::consts::OS);
            scope.set_tag("arch", std::env::consts::ARCH);

            // Add deployment type to distinguish backend VMs from desktop clients
            // backend-vm = Azure Windows VMs (Terraform/Packer deployed)
            // desktop-client = User's local machine (mediar-app)
            if let Ok(deployment_type) = std::env::var("SENTRY_DEPLOYMENT_TYPE") {
                scope.set_tag("deployment_type", deployment_type);
            }

            // Add Azure VM context (only present on backend VMs)
            if let Ok(vm_name) = std::env::var("AZURE_VM_NAME") {
                scope.set_tag("vm_name", vm_name);
            }
            if let Ok(resource_group) = std::env::var("AZURE_RESOURCE_GROUP") {
                scope.set_tag("resource_group", resource_group);
            }
            if let Ok(vm_purpose) = std::env::var("AZURE_VM_PURPOSE") {
                scope.set_tag("vm_purpose", vm_purpose);
            }
            if let Ok(org_id) = std::env::var("ORGANIZATION_ID") {
                if !org_id.is_empty() {
                    scope.set_tag("organization_id", org_id);
                }
            }
        });

        info!(
            "Sentry initialized successfully (environment: {}, release: {})",
            std::env::var("SENTRY_ENVIRONMENT").unwrap_or_else(|_| "production".to_string()),
            release_for_log
        );

        Some(guard)
    }

    /// Create a Sentry tracing layer that can be added to the tracing subscriber
    /// Returns None if Sentry is not initialized
    pub fn create_sentry_layer(
    ) -> Option<impl tracing_subscriber::Layer<tracing_subscriber::Registry> + Send + Sync> {
        // Check if Sentry is disabled
        if std::env::var("SENTRY_DISABLED")
            .unwrap_or_default()
            .eq_ignore_ascii_case("true")
        {
            return None;
        }

        // Check if DSN is set
        if std::env::var("SENTRY_DSN").ok()?.is_empty() {
            return None;
        }

        // Return sentry-tracing layer
        // This will automatically capture ERROR and WARN level logs
        Some(sentry_tracing::layer())
    }

    /// Shutdown Sentry gracefully
    /// This flushes any pending events
    pub fn shutdown_sentry() {
        info!("Shutting down Sentry...");
        // Flush with a 2 second timeout using the client
        sentry::Hub::current()
            .client()
            .map(|client| client.close(Some(std::time::Duration::from_secs(2))));
    }

    /// Capture an error manually (useful for non-panic errors)
    pub fn capture_error(error: &anyhow::Error) {
        // Convert anyhow::Error to a type that implements std::error::Error
        // anyhow::Error doesn't implement std::error::Error directly, but we can use the source
        sentry::integrations::anyhow::capture_anyhow(error);
    }

    /// Add a breadcrumb (useful for tracking events leading to errors)
    pub fn add_breadcrumb(message: String, category: String) {
        sentry::add_breadcrumb(sentry::Breadcrumb {
            message: Some(message),
            category: Some(category),
            level: sentry::Level::Info,
            ..Default::default()
        });
    }
}

// Stub implementation when Sentry is disabled
#[cfg(not(feature = "sentry"))]
mod without_sentry {
    use tracing::debug;

    pub fn init_sentry() -> Option<()> {
        debug!("Sentry disabled: init_sentry (no-op)");
        None
    }

    pub fn shutdown_sentry() {
        debug!("Sentry disabled: shutdown_sentry (no-op)");
    }

    pub fn capture_error(_error: &anyhow::Error) {
        debug!("Sentry disabled: capture_error (no-op)");
    }

    pub fn add_breadcrumb(_message: String, _category: String) {
        debug!("Sentry disabled: add_breadcrumb (no-op)");
    }
}
