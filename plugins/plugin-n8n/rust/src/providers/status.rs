use async_trait::async_trait;

use super::{N8nProvider, ProviderContext, ProviderResult};

/// Provider that returns the status of active plugin creation jobs.
pub struct PluginCreationStatusProvider;

impl PluginCreationStatusProvider {
    /// Creates a new instance of the plugin creation status provider.
    pub fn new() -> Self {
        Self
    }
}

impl Default for PluginCreationStatusProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl N8nProvider for PluginCreationStatusProvider {
    fn name(&self) -> &'static str {
        "plugin_creation_status"
    }

    fn description(&self) -> &'static str {
        "Provides status of active plugin creation jobs"
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        let jobs = context.state.get("jobs").and_then(|j| j.as_array());

        match jobs {
            Some(jobs) => {
                let active_jobs: Vec<_> = jobs
                    .iter()
                    .filter(|j| {
                        let status = j.get("status").and_then(|s| s.as_str());
                        status == Some("running") || status == Some("pending")
                    })
                    .collect();

                if active_jobs.is_empty() {
                    return ProviderResult {
                        text: "No active plugin creation jobs".to_string(),
                        data: None,
                    };
                }

                let job = active_jobs[0];
                let name = job
                    .get("specification")
                    .and_then(|s| s.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("unknown");
                let status = job
                    .get("status")
                    .and_then(|s| s.as_str())
                    .unwrap_or("unknown");
                let phase = job
                    .get("currentPhase")
                    .and_then(|p| p.as_str())
                    .unwrap_or("unknown");
                let progress = job.get("progress").and_then(|p| p.as_f64()).unwrap_or(0.0);

                ProviderResult {
                    text: format!(
                        "Active plugin creation: {} - Status: {}, Phase: {}, Progress: {:.0}%",
                        name, status, phase, progress
                    ),
                    data: Some(serde_json::json!({
                        "pluginName": name,
                        "status": status,
                        "phase": phase,
                        "progress": progress,
                    })),
                }
            }
            None => ProviderResult {
                text: "No active plugin creation jobs".to_string(),
                data: None,
            },
        }
    }
}
