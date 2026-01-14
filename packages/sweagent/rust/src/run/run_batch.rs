//! Batch runner for SWE-agent

use super::hooks::{CombinedRunHook, RunHook};
use super::run_single::{RunSingle, RunSingleActionConfig, RunSingleConfig};
use crate::agent::problem_statement::ProblemStatementConfig;
use crate::agent::AgentConfig;
use crate::environment::EnvironmentConfig;
use crate::exceptions::{Result, SWEAgentError};
use crate::types::{AgentRunResult, SimpleBatchInstance};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Configuration for batch instance sources
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BatchInstanceSourceConfig {
    File {
        path: String,
        #[serde(default)]
        filter: Option<String>,
        #[serde(default)]
        slice: Option<String>,
        #[serde(default)]
        shuffle: bool,
    },
    SweBench {
        #[serde(default = "default_subset")]
        subset: String,
        #[serde(default = "default_split")]
        split: String,
        #[serde(default)]
        filter: Option<String>,
        #[serde(default)]
        slice: Option<String>,
        #[serde(default)]
        shuffle: bool,
        #[serde(default)]
        evaluate: bool,
    },
}

fn default_subset() -> String {
    "lite".to_string()
}

fn default_split() -> String {
    "dev".to_string()
}

impl Default for BatchInstanceSourceConfig {
    fn default() -> Self {
        Self::File {
            path: "instances.yaml".to_string(),
            filter: None,
            slice: None,
            shuffle: false,
        }
    }
}

/// Configuration for batch runs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunBatchConfig {
    #[serde(default)]
    pub agent: AgentConfig,
    #[serde(default)]
    pub env: EnvironmentConfig,
    #[serde(default)]
    pub instances: BatchInstanceSourceConfig,
    #[serde(default = "default_output_dir")]
    pub output_dir: String,
    #[serde(default = "default_num_workers")]
    pub num_workers: usize,
    #[serde(default)]
    pub redo_existing: bool,
    #[serde(default = "default_random_delay")]
    pub random_delay_multiplier: f64,
    #[serde(default)]
    pub actions: RunSingleActionConfig,
}

fn default_output_dir() -> String {
    "./trajectories".to_string()
}

fn default_num_workers() -> usize {
    1
}

fn default_random_delay() -> f64 {
    0.3
}

impl Default for RunBatchConfig {
    fn default() -> Self {
        Self {
            agent: AgentConfig::default(),
            env: EnvironmentConfig::default(),
            instances: BatchInstanceSourceConfig::default(),
            output_dir: default_output_dir(),
            num_workers: default_num_workers(),
            redo_existing: false,
            random_delay_multiplier: default_random_delay(),
            actions: RunSingleActionConfig::default(),
        }
    }
}

/// Result of a batch run
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchRunResult {
    pub results: Vec<InstanceResult>,
    pub total_instances: usize,
    pub completed: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// Result for a single instance in a batch
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceResult {
    pub instance_id: String,
    pub status: InstanceStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<AgentRunResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Status of an instance run
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceStatus {
    Completed,
    Skipped,
    Failed,
}

/// Batch runner for multiple problem instances
pub struct RunBatch {
    config: RunBatchConfig,
    instances: Vec<SimpleBatchInstance>,
    hooks: CombinedRunHook,
}

impl RunBatch {
    pub fn new(config: RunBatchConfig) -> Result<Self> {
        Ok(Self {
            config,
            instances: Vec::new(),
            hooks: CombinedRunHook::new(),
        })
    }

    /// Create from configuration
    pub fn from_config(config: RunBatchConfig) -> Self {
        Self {
            config,
            instances: Vec::new(),
            hooks: CombinedRunHook::new(),
        }
    }

    /// Add a hook
    pub fn add_hook(&mut self, hook: Box<dyn RunHook>) {
        self.hooks.add_hook(hook);
    }

    /// Load instances from source
    pub async fn load_instances(&mut self) -> Result<()> {
        let instances_config = self.config.instances.clone();
        match instances_config {
            BatchInstanceSourceConfig::File {
                path,
                filter,
                slice,
                shuffle,
            } => {
                self.load_from_file(&path, filter.as_deref(), slice.as_deref(), shuffle)?;
            }
            BatchInstanceSourceConfig::SweBench {
                subset,
                split,
                filter,
                slice,
                shuffle,
                ..
            } => {
                self.load_swe_bench(
                    &subset,
                    &split,
                    filter.as_deref(),
                    slice.as_deref(),
                    shuffle,
                )
                .await?;
            }
        }
        Ok(())
    }

    fn load_from_file(
        &mut self,
        path: &str,
        filter: Option<&str>,
        slice: Option<&str>,
        shuffle: bool,
    ) -> Result<()> {
        let content = std::fs::read_to_string(path)?;

        // Try YAML first, then JSON
        let instances: Vec<SimpleBatchInstance> =
            if path.ends_with(".yaml") || path.ends_with(".yml") {
                serde_yaml::from_str(&content)?
            } else {
                serde_json::from_str(&content)?
            };

        self.instances = self.filter_instances(instances, filter, slice, shuffle);
        Ok(())
    }

    async fn load_swe_bench(
        &mut self,
        subset: &str,
        split: &str,
        filter: Option<&str>,
        slice: Option<&str>,
        shuffle: bool,
    ) -> Result<()> {
        // SWE-bench can be loaded from:
        // 1. HuggingFace datasets API (requires external download)
        // 2. Local pre-downloaded files
        // 3. A cached path

        tracing::info!(
            subset = subset,
            split = split,
            "Loading SWE-bench instances"
        );

        // Try common locations for pre-downloaded SWE-bench data
        let possible_paths = [
            format!("data/swe-bench-{}-{}.json", subset, split),
            format!("data/swe-bench/{}/{}.json", subset, split),
            format!(
                "{}/swe-bench-{}-{}.json",
                std::env::var("SWE_BENCH_DATA").unwrap_or_default(),
                subset,
                split
            ),
            format!("~/.cache/sweagent/swe-bench-{}-{}.json", subset, split),
        ];

        // Expand ~ in paths
        let home = std::env::var("HOME").unwrap_or_default();
        let expanded_paths: Vec<String> = possible_paths
            .iter()
            .map(|p| p.replace("~", &home))
            .collect();

        for path in &expanded_paths {
            if std::path::Path::new(path).exists() {
                tracing::info!(path = path, "Found SWE-bench data file");
                return self.load_from_file(path, filter, slice, shuffle);
            }
        }

        // If not found locally, try to download from HuggingFace
        let url = format!(
            "https://huggingface.co/datasets/princeton-nlp/SWE-bench_{}/resolve/main/{}.json",
            subset, split
        );

        tracing::info!(url = &url, "Downloading SWE-bench data from HuggingFace");

        let client = reqwest::Client::new();
        let response =
            client.get(&url).send().await.map_err(|e| {
                SWEAgentError::ApiError(format!("Failed to download SWE-bench: {}", e))
            })?;

        if !response.status().is_success() {
            return Err(SWEAgentError::ConfigurationError(format!(
                "SWE-bench data not found. Please download {} subset manually or set SWE_BENCH_DATA env var. \
                Tried paths: {:?}. API response: {}",
                subset, expanded_paths, response.status()
            )));
        }

        let content = response.text().await?;

        // Parse the JSON content - SWE-bench format is a list of objects
        let raw_instances: Vec<serde_json::Value> = serde_json::from_str(&content)?;

        let instances: Vec<SimpleBatchInstance> = raw_instances
            .into_iter()
            .filter_map(|obj| {
                let id = obj
                    .get("instance_id")
                    .and_then(|v| v.as_str())
                    .map(String::from)?;

                let problem_statement = obj
                    .get("problem_statement")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .unwrap_or_default();

                let repo = obj
                    .get("repo")
                    .and_then(|v| v.as_str())
                    .map(|r| format!("https://github.com/{}", r));

                Some(SimpleBatchInstance {
                    id,
                    problem_statement,
                    repo_path: None,
                    github_url: repo,
                })
            })
            .collect();

        self.instances = self.filter_instances(instances, filter, slice, shuffle);

        tracing::info!(count = self.instances.len(), "Loaded SWE-bench instances");

        Ok(())
    }

    fn filter_instances(
        &self,
        mut instances: Vec<SimpleBatchInstance>,
        filter: Option<&str>,
        slice: Option<&str>,
        shuffle: bool,
    ) -> Vec<SimpleBatchInstance> {
        // Apply filter
        if let Some(pattern) = filter {
            if let Ok(re) = regex::Regex::new(pattern) {
                instances.retain(|i| re.is_match(&i.id));
            }
        }

        // Apply shuffle
        if shuffle {
            use rand::seq::SliceRandom;
            let mut rng = rand::thread_rng();
            instances.shuffle(&mut rng);
        }

        // Apply slice
        if let Some(slice_str) = slice {
            instances = self.apply_slice(instances, slice_str);
        }

        instances
    }

    fn apply_slice(
        &self,
        instances: Vec<SimpleBatchInstance>,
        slice_str: &str,
    ) -> Vec<SimpleBatchInstance> {
        // Parse slice string like ":50", "10:20", "::2"
        let parts: Vec<&str> = slice_str.split(':').collect();

        let start = parts
            .first()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);

        let end = parts
            .get(1)
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(instances.len());

        let step = parts
            .get(2)
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(1);

        instances
            .into_iter()
            .skip(start)
            .take(end - start)
            .step_by(step.max(1))
            .collect()
    }

    /// Check if an instance already has results
    fn has_existing_result(&self, instance_id: &str) -> bool {
        if self.config.redo_existing {
            return false;
        }

        let traj_path =
            PathBuf::from(&self.config.output_dir).join(format!("{}.traj", instance_id));

        traj_path.exists()
    }

    /// Run all instances
    pub async fn main(&mut self) -> Result<BatchRunResult> {
        self.load_instances().await?;

        let total = self.instances.len();
        tracing::info!(
            total = total,
            workers = self.config.num_workers,
            "Starting batch run"
        );

        self.hooks.on_start();

        let mut results = Vec::new();
        let mut completed = 0;
        let mut skipped = 0;
        let mut failed = 0;

        for (idx, instance) in self.instances.clone().into_iter().enumerate() {
            tracing::info!(
                idx = idx,
                total = total,
                instance_id = %instance.id,
                "Processing instance"
            );

            // Check for existing result
            if self.has_existing_result(&instance.id) {
                tracing::info!(instance_id = %instance.id, "Skipping - already exists");
                self.hooks.on_instance_skipped("Already exists");
                skipped += 1;
                results.push(InstanceResult {
                    instance_id: instance.id,
                    status: InstanceStatus::Skipped,
                    result: None,
                    error: None,
                });
                continue;
            }

            self.hooks.on_instance_start(idx, &instance.id);

            // Create config for this instance
            let single_config = RunSingleConfig {
                agent: self.config.agent.clone(),
                env: self.config.env.clone(),
                problem_statement: ProblemStatementConfig::Text {
                    text: instance.problem_statement.clone(),
                    id: instance.id.clone(),
                },
                output_dir: self.config.output_dir.clone(),
                actions: self.config.actions.clone(),
            };

            // Run the instance
            match RunSingle::from_config(single_config) {
                Ok(mut runner) => match runner.run().await {
                    Ok(result) => {
                        self.hooks.on_instance_completed(&result);
                        completed += 1;
                        results.push(InstanceResult {
                            instance_id: instance.id,
                            status: InstanceStatus::Completed,
                            result: Some(result),
                            error: None,
                        });
                    }
                    Err(e) => {
                        tracing::error!(error = %e, instance_id = %instance.id, "Instance failed");
                        failed += 1;
                        results.push(InstanceResult {
                            instance_id: instance.id,
                            status: InstanceStatus::Failed,
                            result: None,
                            error: Some(e.to_string()),
                        });
                    }
                },
                Err(e) => {
                    tracing::error!(error = %e, instance_id = %instance.id, "Failed to create runner");
                    failed += 1;
                    results.push(InstanceResult {
                        instance_id: instance.id,
                        status: InstanceStatus::Failed,
                        result: None,
                        error: Some(e.to_string()),
                    });
                }
            }

            // Add random delay between instances
            if self.config.random_delay_multiplier > 0.0 {
                let delay = rand::random::<f64>() * self.config.random_delay_multiplier;
                tokio::time::sleep(std::time::Duration::from_secs_f64(delay)).await;
            }
        }

        self.hooks.on_end();

        let batch_result = BatchRunResult {
            results,
            total_instances: total,
            completed,
            skipped,
            failed,
        };

        // Save summary
        self.save_summary(&batch_result)?;

        tracing::info!(
            completed = completed,
            skipped = skipped,
            failed = failed,
            "Batch run complete"
        );

        Ok(batch_result)
    }

    fn save_summary(&self, result: &BatchRunResult) -> Result<()> {
        let summary_path = PathBuf::from(&self.config.output_dir).join("batch_summary.json");
        let json = serde_json::to_string_pretty(result)?;
        std::fs::write(summary_path, json)?;
        Ok(())
    }
}

/// Run batch from configuration
pub async fn run_batch_from_config(config: RunBatchConfig) -> Result<BatchRunResult> {
    let mut runner = RunBatch::from_config(config);
    runner.main().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_batch_config_default() {
        let config = RunBatchConfig::default();
        assert_eq!(config.num_workers, 1);
        assert!(!config.redo_existing);
    }

    #[test]
    fn test_apply_slice() {
        let runner = RunBatch::from_config(RunBatchConfig::default());
        let instances: Vec<SimpleBatchInstance> = (0..10)
            .map(|i| SimpleBatchInstance {
                id: format!("instance-{}", i),
                problem_statement: "test".to_string(),
                repo_path: None,
                github_url: None,
            })
            .collect();

        let sliced = runner.apply_slice(instances, ":5");
        assert_eq!(sliced.len(), 5);
    }
}
