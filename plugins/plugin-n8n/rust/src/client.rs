#![allow(missing_docs)]

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use regex::Regex;
use tokio::sync::RwLock;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::config::N8nConfig;
use crate::error::{N8nError, Result};
use crate::models::JobStatus;
use crate::types::{
    CreatePluginOptions, JobError, PluginCreationJob, PluginSpecification, TestResults,
};

pub struct PluginCreationClient {
    config: N8nConfig,
    http_client: reqwest::Client,
    jobs: Arc<RwLock<HashMap<String, PluginCreationJob>>>,
    created_plugins: Arc<RwLock<HashSet<String>>>,
    last_job_creation: Arc<RwLock<Instant>>,
    job_creation_count: Arc<RwLock<u32>>,
}

impl PluginCreationClient {
    pub fn new(config: N8nConfig) -> Result<Self> {
        config.validate()?;

        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()?;

        Ok(Self {
            config,
            http_client,
            jobs: Arc::new(RwLock::new(HashMap::new())),
            created_plugins: Arc::new(RwLock::new(HashSet::new())),
            last_job_creation: Arc::new(RwLock::new(Instant::now())),
            job_creation_count: Arc::new(RwLock::new(0)),
        })
    }

    pub fn config(&self) -> &N8nConfig {
        &self.config
    }

    pub async fn get_created_plugins(&self) -> Vec<String> {
        self.created_plugins.read().await.iter().cloned().collect()
    }

    pub async fn is_plugin_created(&self, name: &str) -> bool {
        self.created_plugins.read().await.contains(name)
    }

    pub async fn get_all_jobs(&self) -> Vec<PluginCreationJob> {
        self.jobs.read().await.values().cloned().collect()
    }

    pub async fn get_job_status(&self, job_id: &str) -> Option<PluginCreationJob> {
        self.jobs.read().await.get(job_id).cloned()
    }

    pub async fn create_plugin(
        &self,
        specification: PluginSpecification,
        options: Option<CreatePluginOptions>,
    ) -> Result<String> {
        if self.is_plugin_created(&specification.name).await {
            return Err(N8nError::plugin_exists(&specification.name));
        }

        if !self.is_valid_plugin_name(&specification.name) {
            return Err(N8nError::invalid_plugin_name(&specification.name));
        }

        // Check rate limit
        if !self.check_rate_limit().await {
            return Err(N8nError::RateLimit);
        }

        let job_count = self.jobs.read().await.len();
        if job_count >= self.config.max_concurrent_jobs {
            return Err(N8nError::MaxConcurrentJobs {
                max_jobs: self.config.max_concurrent_jobs,
            });
        }

        let opts = options.unwrap_or_default();
        let model = opts
            .model
            .and_then(|m| m.parse().ok())
            .unwrap_or(self.config.model);

        let job_id = Uuid::new_v4().to_string();
        let sanitized_name = self.sanitize_plugin_name(&specification.name);
        let output_path = self
            .config
            .get_plugins_dir()
            .join(&job_id)
            .join(&sanitized_name);

        let job = PluginCreationJob {
            id: job_id.clone(),
            specification: specification.clone(),
            status: JobStatus::Pending,
            current_phase: "initializing".to_string(),
            progress: 0.0,
            logs: vec![],
            error: None,
            result: None,
            output_path: output_path.to_string_lossy().to_string(),
            started_at: Utc::now(),
            completed_at: None,
            current_iteration: 0,
            max_iterations: self.config.max_iterations,
            test_results: None,
            validation_score: None,
            errors: vec![],
            model_used: Some(model.to_string()),
        };

        // Store job
        self.jobs.write().await.insert(job_id.clone(), job.clone());
        self.created_plugins
            .write()
            .await
            .insert(specification.name.clone());

        let client = self.clone_for_background();
        let job_id_clone = job_id.clone();
        tokio::spawn(async move {
            if let Err(e) = client
                .run_creation_process(&job_id_clone, opts.use_template)
                .await
            {
                error!("Job {} failed: {}", job_id_clone, e);
                if let Some(job) = client.jobs.write().await.get_mut(&job_id_clone) {
                    job.status = JobStatus::Failed;
                    job.error = Some(e.to_string());
                    job.completed_at = Some(Utc::now());
                }
            }
        });

        Ok(job_id)
    }

    pub async fn cancel_job(&self, job_id: &str) -> bool {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.get_mut(job_id) {
            if job.status.is_active() {
                job.status = JobStatus::Cancelled;
                job.completed_at = Some(Utc::now());
                self.log_to_job_internal(job, "Job cancelled by user");
                return true;
            }
        }
        false
    }

    /// Clean up old completed jobs.
    pub async fn cleanup_old_jobs(&self, days: i64) -> usize {
        let cutoff = Utc::now() - chrono::Duration::days(days);
        let mut jobs = self.jobs.write().await;
        let mut removed = 0;

        let jobs_to_remove: Vec<String> = jobs
            .iter()
            .filter(|(_, job)| job.completed_at.map(|t| t < cutoff).unwrap_or(false))
            .map(|(id, _)| id.clone())
            .collect();

        for job_id in jobs_to_remove {
            if let Some(job) = jobs.remove(&job_id) {
                let output_path = PathBuf::from(&job.output_path);
                if output_path.exists() {
                    let _ = tokio::fs::remove_dir_all(&output_path).await;
                }
                removed += 1;
            }
        }

        if removed > 0 {
            info!("Cleaned up {} old jobs", removed);
        }

        removed
    }

    fn clone_for_background(&self) -> Self {
        Self {
            config: self.config.clone(),
            http_client: self.http_client.clone(),
            jobs: Arc::clone(&self.jobs),
            created_plugins: Arc::clone(&self.created_plugins),
            last_job_creation: Arc::clone(&self.last_job_creation),
            job_creation_count: Arc::clone(&self.job_creation_count),
        }
    }

    async fn run_creation_process(&self, job_id: &str, use_template: bool) -> Result<()> {
        {
            let mut jobs = self.jobs.write().await;
            if let Some(job) = jobs.get_mut(job_id) {
                job.status = JobStatus::Running;
            }
        }

        // Setup workspace
        self.setup_plugin_workspace(job_id, use_template).await?;

        let max_iterations = self.config.max_iterations;
        let mut success = false;

        for iteration in 1..=max_iterations {
            {
                let mut jobs = self.jobs.write().await;
                if let Some(job) = jobs.get_mut(job_id) {
                    job.current_iteration = iteration;
                    job.current_phase = format!("iteration {}/{}", iteration, max_iterations);
                    job.progress = (iteration as f64 / max_iterations as f64) * 100.0;
                    self.log_to_job_internal(job, &format!("Starting iteration {}", iteration));
                }
            }

            success = self.run_single_iteration(job_id).await?;

            if success {
                break;
            }

            if iteration < max_iterations {
                self.prepare_next_iteration(job_id).await?;
            }
        }

        // Update final status
        {
            let mut jobs = self.jobs.write().await;
            if let Some(job) = jobs.get_mut(job_id) {
                if success {
                    job.status = JobStatus::Completed;
                    self.log_to_job_internal(job, "Job completed successfully");
                } else {
                    job.status = JobStatus::Failed;
                    self.log_to_job_internal(job, "Job failed after maximum iterations");
                }
                job.completed_at = Some(Utc::now());
            }
        }

        Ok(())
    }

    async fn run_single_iteration(&self, job_id: &str) -> Result<bool> {
        self.update_phase(job_id, "generating").await;
        if let Err(e) = self.generate_plugin_code(job_id).await {
            self.add_error(job_id, "generating", &e.to_string()).await;
            return Ok(false);
        }

        self.update_phase(job_id, "building").await;
        if let Err(e) = self.build_plugin(job_id).await {
            self.add_error(job_id, "building", &e.to_string()).await;
            return Ok(false);
        }

        // Phase 3: Lint
        self.update_phase(job_id, "linting").await;
        if let Err(e) = self.lint_plugin(job_id).await {
            self.add_error(job_id, "linting", &e.to_string()).await;
            return Ok(false);
        }

        self.update_phase(job_id, "testing").await;
        if let Err(e) = self.test_plugin(job_id).await {
            self.add_error(job_id, "testing", &e.to_string()).await;
            return Ok(false);
        }

        self.update_phase(job_id, "validating").await;
        if let Err(e) = self.validate_plugin(job_id).await {
            self.add_error(job_id, "validating", &e.to_string()).await;
            return Ok(false);
        }

        Ok(true)
    }

    async fn update_phase(&self, job_id: &str, phase: &str) {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.get_mut(job_id) {
            job.current_phase = phase.to_string();
        }
    }

    async fn add_error(&self, job_id: &str, phase: &str, error: &str) {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.get_mut(job_id) {
            job.errors.push(JobError {
                iteration: job.current_iteration,
                phase: phase.to_string(),
                error: error.to_string(),
                timestamp: Utc::now(),
            });
            job.error = Some(error.to_string());
        }
    }

    async fn setup_plugin_workspace(&self, job_id: &str, _use_template: bool) -> Result<()> {
        let output_path = {
            let jobs = self.jobs.read().await;
            jobs.get(job_id)
                .map(|j| PathBuf::from(&j.output_path))
                .ok_or_else(|| N8nError::job_not_found(job_id))?
        };

        tokio::fs::create_dir_all(&output_path).await?;
        tokio::fs::create_dir_all(output_path.join("src")).await?;
        tokio::fs::create_dir_all(output_path.join("src/__tests__")).await?;

        let (name, description, version, deps) = {
            let jobs = self.jobs.read().await;
            let job = jobs
                .get(job_id)
                .ok_or_else(|| N8nError::job_not_found(job_id))?;
            (
                job.specification.name.clone(),
                job.specification.description.clone(),
                job.specification.version.clone(),
                job.specification.dependencies.clone(),
            )
        };

        // Build dependencies map
        let mut deps_map = serde_json::Map::new();
        deps_map.insert("@elizaos/core".to_string(), serde_json::json!("^1.0.0"));
        if let Some(additional_deps) = deps {
            for (k, v) in additional_deps {
                deps_map.insert(k, serde_json::Value::String(v));
            }
        }

        let mut package_json = serde_json::json!({
            "name": name,
            "version": version,
            "description": description,
            "main": "dist/index.js",
            "types": "dist/index.d.ts",
            "scripts": {
                "build": "tsc",
                "test": "vitest run",
                "lint": "bunx @biomejs/biome check --write --unsafe .",
                "lint:check": "bunx @biomejs/biome check ."
            },
            "devDependencies": {
                "@types/node": "^20.0.0",
                "typescript": "^5.0.0",
                "vitest": "^1.0.0",
                "@biomejs/biome": "^2.3.11"
            }
        });

        if let Some(obj) = package_json.as_object_mut() {
            obj.insert(
                "dependencies".to_string(),
                serde_json::Value::Object(deps_map),
            );
        }

        tokio::fs::write(
            output_path.join("package.json"),
            serde_json::to_string_pretty(&package_json)?,
        )
        .await?;

        let tsconfig = serde_json::json!({
            "compilerOptions": {
                "target": "ES2022",
                "module": "commonjs",
                "outDir": "./dist",
                "rootDir": "./src",
                "strict": true,
                "esModuleInterop": true,
                "declaration": true
            },
            "include": ["src/**/*"],
            "exclude": ["node_modules", "dist"]
        });

        tokio::fs::write(
            output_path.join("tsconfig.json"),
            serde_json::to_string_pretty(&tsconfig)?,
        )
        .await?;

        Ok(())
    }

    async fn generate_plugin_code(&self, job_id: &str) -> Result<()> {
        let (spec, iteration, errors) = {
            let jobs = self.jobs.read().await;
            let job = jobs
                .get(job_id)
                .ok_or_else(|| N8nError::job_not_found(job_id))?;
            (
                job.specification.clone(),
                job.current_iteration,
                job.errors.clone(),
            )
        };

        let prompt = if iteration == 1 {
            self.generate_initial_prompt(&spec)
        } else {
            let prev_errors: Vec<_> = errors
                .iter()
                .filter(|e| e.iteration == iteration - 1)
                .cloned()
                .collect();
            self.generate_iteration_prompt(&spec, &prev_errors)
        };

        let response = self
            .http_client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.config.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&serde_json::json!({
                "model": self.config.model.as_str(),
                "max_tokens": 8192,
                "temperature": 0,
                "messages": [
                    {"role": "user", "content": prompt}
                ]
            }))
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(N8nError::Generation(format!(
                "API request failed: {}",
                error_text
            )));
        }

        let response_json: serde_json::Value = response.json().await?;
        let content = response_json["content"]
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|block| block["text"].as_str())
            .unwrap_or("");

        self.write_generated_code(job_id, content).await?;

        Ok(())
    }

    fn generate_initial_prompt(&self, spec: &PluginSpecification) -> String {
        let mut prompt = format!(
            "You are creating an ElizaOS plugin with the following specification:\n\n\
             Name: {}\n\
             Description: {}\n\
             Version: {}\n\n",
            spec.name, spec.description, spec.version
        );

        if let Some(actions) = &spec.actions {
            prompt.push_str("Actions:\n");
            for action in actions {
                prompt.push_str(&format!("- {}: {}\n", action.name, action.description));
            }
            prompt.push('\n');
        }

        if let Some(providers) = &spec.providers {
            prompt.push_str("Providers:\n");
            for provider in providers {
                prompt.push_str(&format!("- {}: {}\n", provider.name, provider.description));
            }
            prompt.push('\n');
        }

        prompt.push_str(
            "Create an ElizaOS plugin implementation:\n\n\
             1. Create src/index.ts that exports the plugin object\n\
             2. Implement all specified components\n\
             3. Follow ElizaOS plugin structure and conventions\n\
             4. Include proper TypeScript types\n\
             5. Add error handling\n\
             6. Create unit tests\n\
             7. Ensure all imports use @elizaos/core\n\
             8. No stubs or incomplete implementations\n\n\
             Provide the complete implementation with file paths clearly marked.",
        );

        prompt
    }

    fn generate_iteration_prompt(&self, spec: &PluginSpecification, errors: &[JobError]) -> String {
        let error_summary: String = errors
            .iter()
            .map(|e| format!("Phase: {}\nError: {}", e.phase, e.error))
            .collect::<Vec<_>>()
            .join("\n\n");

        format!(
            "The ElizaOS plugin {} has the following errors:\n\n{}\n\n\
             Current plugin specification:\n{}\n\n\
             Please fix all the errors and provide updated code with file paths marked.",
            spec.name,
            error_summary,
            serde_json::to_string_pretty(spec).unwrap_or_default()
        )
    }

    async fn write_generated_code(&self, job_id: &str, response_text: &str) -> Result<()> {
        let output_path = {
            let jobs = self.jobs.read().await;
            jobs.get(job_id)
                .map(|j| PathBuf::from(&j.output_path))
                .ok_or_else(|| N8nError::job_not_found(job_id))?
        };

        let file_regex = Regex::new(
            r"```(?:typescript|ts|javascript|js)?\s*\n(?://\s*)?(?:File:\s*)?(.+?)\n([\s\S]*?)```",
        )
        .unwrap();

        for cap in file_regex.captures_iter(response_text) {
            let file_path = cap.get(1).map(|m| m.as_str().trim()).unwrap_or("");
            let file_content = cap.get(2).map(|m| m.as_str().trim()).unwrap_or("");

            let normalized_path = if file_path.starts_with("src/") {
                file_path.to_string()
            } else {
                format!("src/{}", file_path)
            };

            let full_path = output_path.join(&normalized_path);

            if let Some(parent) = full_path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }

            tokio::fs::write(&full_path, file_content).await?;
        }

        Ok(())
    }

    async fn build_plugin(&self, job_id: &str) -> Result<()> {
        let output_path = self.get_job_output_path(job_id).await?;

        // Run npm install
        self.run_command(job_id, &output_path, "npm", &["install"])
            .await?;

        // Run npm build
        self.run_command(job_id, &output_path, "npm", &["run", "build"])
            .await?;

        Ok(())
    }

    async fn lint_plugin(&self, job_id: &str) -> Result<()> {
        let output_path = self.get_job_output_path(job_id).await?;
        self.run_command(job_id, &output_path, "npm", &["run", "lint"])
            .await?;
        Ok(())
    }

    async fn test_plugin(&self, job_id: &str) -> Result<()> {
        let output_path = self.get_job_output_path(job_id).await?;
        let result = self
            .run_command(job_id, &output_path, "npm", &["test"])
            .await;

        if let Ok(output) = &result {
            let test_results = self.parse_test_results(output);
            let mut jobs = self.jobs.write().await;
            if let Some(job) = jobs.get_mut(job_id) {
                job.test_results = Some(test_results.clone());
                if test_results.failed > 0 {
                    return Err(N8nError::Test(format!(
                        "{} tests failed",
                        test_results.failed
                    )));
                }
            }
        }

        result.map(|_| ())
    }

    async fn validate_plugin(&self, _job_id: &str) -> Result<()> {
        warn!("Skipping validation");
        Ok(())
    }

    async fn prepare_next_iteration(&self, job_id: &str) -> Result<()> {
        let output_path = self.get_job_output_path(job_id).await?;
        let dist_path = output_path.join("dist");

        if dist_path.exists() {
            tokio::fs::remove_dir_all(&dist_path).await?;
        }

        Ok(())
    }

    async fn get_job_output_path(&self, job_id: &str) -> Result<PathBuf> {
        let jobs = self.jobs.read().await;
        jobs.get(job_id)
            .map(|j| PathBuf::from(&j.output_path))
            .ok_or_else(|| N8nError::job_not_found(job_id))
    }

    async fn run_command(
        &self,
        job_id: &str,
        cwd: &PathBuf,
        cmd: &str,
        args: &[&str],
    ) -> Result<String> {
        self.log_to_job(job_id, &format!("Running: {} {}", cmd, args.join(" ")))
            .await;

        let output = tokio::process::Command::new(cmd)
            .args(args)
            .current_dir(cwd)
            .output()
            .await?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let combined = format!("{}{}", stdout, stderr);

        if !output.status.success() {
            return Err(N8nError::Command(combined));
        }

        Ok(combined)
    }

    fn parse_test_results(&self, output: &str) -> TestResults {
        let passed_regex = Regex::new(r"(\d+) passed").unwrap();
        let failed_regex = Regex::new(r"(\d+) failed").unwrap();
        let duration_regex = Regex::new(r"Duration (\d+\.?\d*)s").unwrap();

        let passed = passed_regex
            .captures(output)
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0);

        let failed = failed_regex
            .captures(output)
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0);

        let duration = duration_regex
            .captures(output)
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0.0);

        TestResults {
            passed,
            failed,
            duration,
        }
    }

    async fn log_to_job(&self, job_id: &str, message: &str) {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.get_mut(job_id) {
            self.log_to_job_internal(job, message);
        }
    }

    fn log_to_job_internal(&self, job: &mut PluginCreationJob, message: &str) {
        let timestamp = Utc::now().to_rfc3339();
        job.logs.push(format!("[{}] {}", timestamp, message));
        info!("[Job {}] {}", job.id, message);
    }

    fn is_valid_plugin_name(&self, name: &str) -> bool {
        let regex = Regex::new(r"^@?[a-zA-Z0-9-_]+/[a-zA-Z0-9-_]+$").unwrap();
        regex.is_match(name) && !name.contains("..") && !name.contains("./")
    }

    fn sanitize_plugin_name(&self, name: &str) -> String {
        name.trim_start_matches('@')
            .replace('/', "-")
            .to_lowercase()
    }

    async fn check_rate_limit(&self) -> bool {
        let now = Instant::now();
        let one_hour = Duration::from_secs(3600);

        let mut last = self.last_job_creation.write().await;
        let mut count = self.job_creation_count.write().await;

        if now.duration_since(*last) > one_hour {
            *count = 0;
        }

        if *count >= self.config.rate_limit_per_hour {
            return false;
        }

        *last = now;
        *count += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_valid_plugin_name() {
        let config = N8nConfig::new("test-key");
        let client = PluginCreationClient::new(config).unwrap();

        assert!(client.is_valid_plugin_name("@elizaos/plugin-test"));
        assert!(client.is_valid_plugin_name("scope/plugin-test"));
        assert!(!client.is_valid_plugin_name("invalid-name"));
        assert!(!client.is_valid_plugin_name("@scope/../evil"));
    }

    #[test]
    fn test_sanitize_plugin_name() {
        let config = N8nConfig::new("test-key");
        let client = PluginCreationClient::new(config).unwrap();

        assert_eq!(
            client.sanitize_plugin_name("@elizaos/plugin-test"),
            "elizaos-plugin-test"
        );
    }
}
