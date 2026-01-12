//! Autonomous Self-Looping Agent (Rust)
//!
//! A sandboxed, self-looping autonomous agent that:
//! - Thinks locally using local-ai plugin with a small GGUF model
//! - Acts by running commands via shell plugin (strictly inside a sandbox directory)
//! - Remembers via in-memory storage
//!
//! The agent runs a continuous loop: plan → act → observe → store → repeat

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use chrono::Utc;
use elizaos_plugin_local_ai::{LocalAIConfig, LocalAIPlugin, TextGenerationParams};
use elizaos_plugin_shell::{ShellConfig, ShellConfigBuilder, ShellService};
use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn, Level};
use uuid::Uuid;

// ============================================================================
// Configuration
// ============================================================================

#[derive(Debug, Clone)]
struct AutonomousConfig {
    sandbox_dir: PathBuf,
    models_dir: PathBuf,
    model_name: String,
    loop_interval_ms: u64,
    max_iterations: u64,
    max_consecutive_failures: u64,
    stop_file: PathBuf,
    conversation_id: String,
    agent_id: String,
    memory_context_size: usize,
    context_size: usize,
    gpu_layers: u32,
    temperature: f32,
    max_tokens: usize,
    shell_timeout_ms: u64,
}

impl AutonomousConfig {
    fn from_env() -> Result<Self> {
        let exe_path = std::env::current_exe().unwrap_or_default();
        let default_sandbox = exe_path
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|p| p.join("sandbox"))
            .unwrap_or_else(|| PathBuf::from("./sandbox"));

        let home = directories::BaseDirs::new()
            .map(|d| d.home_dir().to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));

        let default_models = home.join(".eliza").join("models");

        let sandbox_dir = std::env::var("SANDBOX_DIR")
            .map(PathBuf::from)
            .unwrap_or(default_sandbox);

        let models_dir = std::env::var("MODELS_DIR")
            .map(PathBuf::from)
            .unwrap_or(default_models);

        let model_name =
            std::env::var("LOCAL_SMALL_MODEL").unwrap_or_else(|_| "Qwen3-4B-Q4_K_M.gguf".into());

        Ok(Self {
            sandbox_dir: sandbox_dir.clone(),
            models_dir,
            model_name,
            loop_interval_ms: std::env::var("LOOP_INTERVAL_MS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(3000),
            max_iterations: std::env::var("MAX_ITERATIONS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(1000),
            max_consecutive_failures: std::env::var("MAX_CONSECUTIVE_FAILURES")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(5),
            stop_file: sandbox_dir.join("STOP"),
            conversation_id: std::env::var("CONVERSATION_ID")
                .unwrap_or_else(|_| Uuid::new_v4().to_string()),
            agent_id: std::env::var("AGENT_ID").unwrap_or_else(|_| Uuid::new_v4().to_string()),
            memory_context_size: std::env::var("MEMORY_CONTEXT_SIZE")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(10),
            context_size: std::env::var("CONTEXT_SIZE")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(8192),
            gpu_layers: std::env::var("GPU_LAYERS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0),
            temperature: std::env::var("TEMPERATURE")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.7),
            max_tokens: std::env::var("MAX_TOKENS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(512),
            shell_timeout_ms: std::env::var("SHELL_TIMEOUT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(30000),
        })
    }
}

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum ActionType {
    Run,
    Sleep,
    Stop,
}

impl std::fmt::Display for ActionType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ActionType::Run => write!(f, "RUN"),
            ActionType::Sleep => write!(f, "SLEEP"),
            ActionType::Stop => write!(f, "STOP"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentDecision {
    action: ActionType,
    command: Option<String>,
    sleep_ms: Option<u64>,
    note: Option<String>,
}

impl Default for AgentDecision {
    fn default() -> Self {
        Self {
            action: ActionType::Sleep,
            command: None,
            sleep_ms: Some(1000),
            note: Some("Default decision".into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExecutionResult {
    success: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IterationRecord {
    id: String,
    timestamp: i64,
    step: u64,
    prompt_summary: String,
    decision: AgentDecision,
    result: Option<ExecutionResult>,
    derived_summary: String,
}

// ============================================================================
// Memory Storage
// ============================================================================

struct AgentMemory {
    records: VecDeque<IterationRecord>,
    max_records: usize,
}

impl AgentMemory {
    fn new(max_records: usize) -> Self {
        Self {
            records: VecDeque::new(),
            max_records,
        }
    }

    fn store(&mut self, record: IterationRecord) {
        if self.records.len() >= self.max_records {
            self.records.pop_front();
        }
        self.records.push_back(record);
    }

    fn get_recent(&self, count: usize) -> Vec<&IterationRecord> {
        let start = self.records.len().saturating_sub(count);
        self.records.range(start..).collect()
    }

    fn count(&self) -> usize {
        self.records.len()
    }
}

// ============================================================================
// Command Safety
// ============================================================================

const FORBIDDEN_COMMANDS: &[&str] = &[
    "curl", "wget", "ssh", "scp", "rsync", "nc", "netcat", "socat", "python", "python3", "node",
    "bun", "deno", "kill", "pkill", "killall", "reboot", "shutdown", "halt", "poweroff", "chown",
    "chmod", "chgrp", "sudo", "su",
];

fn is_command_allowed(command: &str) -> bool {
    let trimmed = command.trim().to_lowercase();
    let parts: Vec<&str> = trimmed.split_whitespace().collect();

    if parts.is_empty() {
        return false;
    }

    let base_command = parts[0].rsplit('/').next().unwrap_or(parts[0]);

    // Check forbidden commands
    if FORBIDDEN_COMMANDS.contains(&base_command) {
        return false;
    }

    // Check dangerous patterns
    let dangerous_patterns = [
        r"\.\./",           // Path traversal
        r"\$\(",            // Command substitution
        r"`",               // Backtick command substitution
        r";\s*rm\s",        // Chained rm
        r"&&\s*rm\s",       // Chained rm
        r"\|\|\s*rm\s",     // Chained rm
    ];

    for pattern in dangerous_patterns {
        if Regex::new(pattern).map(|re| re.is_match(&trimmed)).unwrap_or(false) {
            return false;
        }
    }

    true
}

// ============================================================================
// XML Parser
// ============================================================================

fn parse_agent_output(output: &str) -> AgentDecision {
    let default = AgentDecision::default();

    // Remove <think> tags
    let think_re = Regex::new(r"<think>[\s\S]*?</think>\s*").unwrap();
    let cleaned = think_re.replace_all(output, "");

    // Extract action
    let action_re = Regex::new(r"<action>\s*(RUN|SLEEP|STOP)\s*</action>").unwrap();
    let action = match action_re.captures(&cleaned) {
        Some(caps) => match caps.get(1).map(|m| m.as_str().to_uppercase()).as_deref() {
            Some("RUN") => ActionType::Run,
            Some("SLEEP") => ActionType::Sleep,
            Some("STOP") => ActionType::Stop,
            _ => return default,
        },
        None => {
            warn!("Could not extract action from agent output");
            return default;
        }
    };

    // Extract command (for RUN)
    let command = if action == ActionType::Run {
        let cmd_re = Regex::new(r"<command>\s*([\s\S]*?)\s*</command>").unwrap();
        match cmd_re.captures(&cleaned) {
            Some(caps) => caps.get(1).map(|m| m.as_str().trim().to_string()),
            None => {
                warn!("RUN action without command, defaulting to SLEEP");
                return AgentDecision {
                    action: ActionType::Sleep,
                    sleep_ms: Some(1000),
                    note: Some("RUN action without command".into()),
                    ..default
                };
            }
        }
    } else {
        None
    };

    // Extract sleepMs (for SLEEP)
    let sleep_ms = if action == ActionType::Sleep {
        let sleep_re = Regex::new(r"<sleepMs>\s*(\d+)\s*</sleepMs>").unwrap();
        sleep_re
            .captures(&cleaned)
            .and_then(|caps| caps.get(1))
            .and_then(|m| m.as_str().parse().ok())
            .or(Some(1000))
    } else {
        None
    };

    // Extract note
    let note_re = Regex::new(r"<note>\s*([\s\S]*?)\s*</note>").unwrap();
    let note = note_re
        .captures(&cleaned)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().trim().to_string());

    AgentDecision {
        action,
        command,
        sleep_ms,
        note,
    }
}

// ============================================================================
// Prompt Builder
// ============================================================================

fn build_prompt(
    config: &AutonomousConfig,
    current_dir: &str,
    shell_history: &[String],
    memory_records: &[&IterationRecord],
    dir_listing: &str,
) -> String {
    let memory_context = if memory_records.is_empty() {
        "(no previous iterations)".to_string()
    } else {
        memory_records
            .iter()
            .map(|r| {
                let result_info = r
                    .result
                    .as_ref()
                    .map(|res| {
                        format!(
                            "exit={}, {}",
                            res.exit_code.unwrap_or(-1),
                            &res.stdout[..res.stdout.len().min(100)]
                        )
                    })
                    .unwrap_or_else(|| "no result".to_string());

                format!(
                    "[Step {}] {}{}→ {}",
                    r.step,
                    r.decision.action,
                    r.decision
                        .command
                        .as_ref()
                        .map(|c| format!(": {} ", c))
                        .unwrap_or_else(|| " ".to_string()),
                    result_info
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let history_context = if shell_history.is_empty() {
        "(no shell history yet)".to_string()
    } else {
        shell_history
            .iter()
            .rev()
            .take(5)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    };

    format!(
        r#"You are an autonomous agent operating in a sandboxed directory.

## Your Environment
- Sandbox directory: {}
- Current working directory: {}
- Files in current directory:
{}

## Your Capabilities
- You can run shell commands (ls, cat, echo, touch, mkdir, cp, mv, grep, find, head, tail, wc, sort, uniq, date)
- You CANNOT run: networking commands, interpreters (python, node), process control (kill), or system commands
- All file operations are restricted to the sandbox directory

## Recent Memory
{}

## Recent Shell History
{}

## Your Task
You are a curious autonomous agent. Your goal is to:
1. Explore your sandbox environment
2. Create and organize files as you see fit
3. Keep a log of your activities
4. Find interesting things to do within your constraints

Think about what would be useful or interesting to do next, then output your decision.

## Output Format
Respond with EXACTLY one of these XML structures:

To run a command:
<action>RUN</action>
<command>your shell command here</command>
<note>brief explanation of what you're doing</note>

To sleep/wait:
<action>SLEEP</action>
<sleepMs>milliseconds to sleep</sleepMs>
<note>why you're waiting</note>

To stop the agent:
<action>STOP</action>
<note>why you're stopping</note>

IMPORTANT: Output ONLY the XML tags. No other text before or after."#,
        config.sandbox_dir.display(),
        current_dir,
        if dir_listing.is_empty() {
            "(empty or unable to list)"
        } else {
            dir_listing
        },
        memory_context,
        history_context
    )
}

// ============================================================================
// Autonomous Agent
// ============================================================================

struct AutonomousAgent {
    config: AutonomousConfig,
    ai_plugin: LocalAIPlugin,
    shell_service: Arc<Mutex<ShellService>>,
    memory: Arc<Mutex<AgentMemory>>,
    iteration_count: u64,
    consecutive_failures: u64,
    is_running: Arc<AtomicBool>,
    shell_history: Vec<String>,
}

impl AutonomousAgent {
    async fn new(config: AutonomousConfig) -> Result<Self> {
        // Create AI plugin
        let ai_config = LocalAIConfig::new(&config.models_dir)
            .small_model(&config.model_name)
            .large_model(&config.model_name)
            .gpu_layers(config.gpu_layers)
            .context_size(config.context_size);

        let ai_plugin = LocalAIPlugin::new(ai_config)
            .context("Failed to create LocalAIPlugin")?;

        // Create shell service
        let shell_config = ShellConfigBuilder::new()
            .enabled(true)
            .allowed_directory(config.sandbox_dir.clone())
            .timeout(Duration::from_millis(config.shell_timeout_ms))
            .build();

        let shell_service = ShellService::new(shell_config);

        Ok(Self {
            config,
            ai_plugin,
            shell_service: Arc::new(Mutex::new(shell_service)),
            memory: Arc::new(Mutex::new(AgentMemory::new(1000))),
            iteration_count: 0,
            consecutive_failures: 0,
            is_running: Arc::new(AtomicBool::new(false)),
            shell_history: Vec::new(),
        })
    }

    async fn initialize(&self) -> Result<()> {
        // Ensure sandbox exists
        fs::create_dir_all(&self.config.sandbox_dir)
            .await
            .context("Failed to create sandbox directory")?;

        // Create welcome file
        let welcome_path = self.config.sandbox_dir.join("WELCOME.txt");
        if !welcome_path.exists() {
            fs::write(
                &welcome_path,
                r#"Welcome, Autonomous Agent!

This is your sandbox. You can:
- Create files and directories
- Read and modify files
- Explore with ls, cat, find, grep, etc.

To stop the agent, create a file named "STOP" in this directory.

Have fun exploring!
"#,
            )
            .await
            .context("Failed to create welcome file")?;
        }

        info!("✓ Sandbox initialized: {}", self.config.sandbox_dir.display());
        Ok(())
    }

    fn should_stop(&self) -> bool {
        // Check STOP file
        if self.config.stop_file.exists() {
            info!("STOP file detected, stopping agent");
            return true;
        }

        // Check iteration limit
        if self.iteration_count >= self.config.max_iterations {
            info!(
                "Max iterations ({}) reached, stopping agent",
                self.config.max_iterations
            );
            return true;
        }

        // Check consecutive failures
        if self.consecutive_failures >= self.config.max_consecutive_failures {
            warn!(
                "Max consecutive failures ({}) reached, stopping agent",
                self.config.max_consecutive_failures
            );
            return true;
        }

        // Check env var
        if std::env::var("AUTONOMY_ENABLED")
            .map(|v| v == "false")
            .unwrap_or(false)
        {
            info!("AUTONOMY_ENABLED=false, stopping agent");
            return true;
        }

        false
    }

    async fn get_directory_listing(&self) -> String {
        let mut shell = self.shell_service.lock().await;
        match shell.execute_command("ls -la", Some(&self.config.conversation_id)).await {
            Ok(result) if result.success => result.stdout,
            Ok(result) => format!("(failed to list: {})", result.stderr),
            Err(e) => format!("(error: {})", e),
        }
    }

    async fn think(&self) -> Result<AgentDecision> {
        let shell = self.shell_service.lock().await;
        let current_dir = shell.get_current_directory();
        drop(shell);

        let memory = self.memory.lock().await;
        let memory_records = memory.get_recent(self.config.memory_context_size);

        let dir_listing = self.get_directory_listing().await;

        let prompt = build_prompt(
            &self.config,
            &current_dir,
            &self.shell_history,
            &memory_records,
            &dir_listing,
        );

        debug!("Generating agent decision...");

        let params = TextGenerationParams::new(&prompt)
            .max_tokens(self.config.max_tokens)
            .temperature(self.config.temperature)
            .stop("</note>");

        let result = self.ai_plugin.generate_text_with_params(&params).await?;

        let mut response = result.text;

        // Add closing tag if truncated
        if !response.contains("</note>") {
            response.push_str("</note>");
        }

        debug!("Model response: {}...", &response[..response.len().min(200)]);

        Ok(parse_agent_output(&response))
    }

    async fn act(&mut self, decision: &AgentDecision) -> Result<Option<ExecutionResult>> {
        match decision.action {
            ActionType::Stop => {
                info!("Agent decided to stop: {:?}", decision.note);
                self.is_running.store(false, Ordering::SeqCst);
                Ok(None)
            }

            ActionType::Sleep => {
                let sleep_ms = decision.sleep_ms.unwrap_or(1000);
                info!("Agent sleeping for {}ms: {:?}", sleep_ms, decision.note);
                tokio::time::sleep(Duration::from_millis(sleep_ms)).await;
                Ok(None)
            }

            ActionType::Run => {
                let command = match &decision.command {
                    Some(cmd) => cmd.clone(),
                    None => {
                        return Ok(Some(ExecutionResult {
                            success: false,
                            exit_code: Some(1),
                            stdout: String::new(),
                            stderr: "No command provided".into(),
                            cwd: self.config.sandbox_dir.display().to_string(),
                        }));
                    }
                };

                // Validate command
                if !is_command_allowed(&command) {
                    warn!("⚠ Blocked forbidden command: {}", command);
                    return Ok(Some(ExecutionResult {
                        success: false,
                        exit_code: Some(1),
                        stdout: String::new(),
                        stderr: "Command blocked by security policy".into(),
                        cwd: self.config.sandbox_dir.display().to_string(),
                    }));
                }

                info!("Executing: {}", command);

                let mut shell = self.shell_service.lock().await;
                let result = shell
                    .execute_command(&command, Some(&self.config.conversation_id))
                    .await?;

                // Add to shell history
                self.shell_history.push(format!("$ {}", command));
                if self.shell_history.len() > 50 {
                    self.shell_history.remove(0);
                }

                let exec_result = ExecutionResult {
                    success: result.success,
                    exit_code: result.exit_code,
                    stdout: result.stdout[..result.stdout.len().min(1000)].to_string(),
                    stderr: result.stderr[..result.stderr.len().min(500)].to_string(),
                    cwd: result.executed_in,
                };

                if result.success {
                    info!("✓ Command succeeded (exit {:?})", result.exit_code);
                    if !result.stdout.is_empty() {
                        let preview = result.stdout[..result.stdout.len().min(200)]
                            .replace('\n', " ");
                        debug!("  stdout: {}", preview);
                    }
                } else {
                    warn!(
                        "✗ Command failed (exit {:?}): {}",
                        result.exit_code, result.stderr
                    );
                }

                Ok(Some(exec_result))
            }
        }
    }

    fn generate_summary(&self, decision: &AgentDecision, result: &Option<ExecutionResult>) -> String {
        match decision.action {
            ActionType::Stop => {
                format!(
                    "Stopped: {}",
                    decision.note.as_deref().unwrap_or("agent decided to stop")
                )
            }
            ActionType::Sleep => {
                format!(
                    "Slept {}ms: {}",
                    decision.sleep_ms.unwrap_or(0),
                    decision.note.as_deref().unwrap_or("waiting")
                )
            }
            ActionType::Run => {
                if let Some(res) = result {
                    let status = if res.success { "OK" } else { "FAIL" };
                    let output = if !res.stdout.is_empty() {
                        &res.stdout[..res.stdout.len().min(50)]
                    } else if !res.stderr.is_empty() {
                        &res.stderr[..res.stderr.len().min(50)]
                    } else {
                        "(no output)"
                    };
                    format!(
                        "{}: {} → {}",
                        status,
                        decision.command.as_deref().unwrap_or("?"),
                        output.replace('\n', " ")
                    )
                } else {
                    "Unknown".into()
                }
            }
        }
    }

    async fn run(&mut self) -> Result<()> {
        self.is_running.store(true, Ordering::SeqCst);

        // Setup shutdown signal handling
        let is_running = self.is_running.clone();
        tokio::spawn(async move {
            tokio::signal::ctrl_c().await.ok();
            info!("\nReceived shutdown signal, stopping agent...");
            is_running.store(false, Ordering::SeqCst);
        });

        info!("Starting autonomous loop...");

        while self.is_running.load(Ordering::SeqCst) && !self.should_stop() {
            self.iteration_count += 1;
            let iteration_id = Uuid::new_v4().to_string();
            let timestamp = Utc::now().timestamp();

            println!();
            println!("{}", "=".repeat(60));
            println!("=== Iteration {} ===", self.iteration_count);
            println!("{}", "=".repeat(60));

            let decision: AgentDecision;
            let mut result: Option<ExecutionResult> = None;

            // Think phase
            match self.think().await {
                Ok(d) => {
                    decision = d;
                    self.consecutive_failures = 0;
                }
                Err(e) => {
                    error!("✗ Think phase failed: {}", e);
                    self.consecutive_failures += 1;
                    decision = AgentDecision {
                        action: ActionType::Sleep,
                        sleep_ms: Some(self.config.loop_interval_ms * 2),
                        note: Some(format!("Think phase error: {}", e)),
                        ..Default::default()
                    };
                }
            }

            // Act phase
            match self.act(&decision).await {
                Ok(r) => {
                    result = r;
                }
                Err(e) => {
                    error!("✗ Act phase failed: {}", e);
                    self.consecutive_failures += 1;
                    result = Some(ExecutionResult {
                        success: false,
                        exit_code: Some(1),
                        stdout: String::new(),
                        stderr: format!("Action error: {}", e),
                        cwd: self.config.sandbox_dir.display().to_string(),
                    });
                }
            }

            // Store iteration record
            let summary = self.generate_summary(&decision, &result);
            let record = IterationRecord {
                id: iteration_id,
                timestamp,
                step: self.iteration_count,
                prompt_summary: format!("Iteration {}", self.iteration_count),
                decision: decision.clone(),
                result,
                derived_summary: summary,
            };

            {
                let mut memory = self.memory.lock().await;
                memory.store(record);
            }

            // Inter-iteration delay
            if self.is_running.load(Ordering::SeqCst) && decision.action != ActionType::Sleep {
                tokio::time::sleep(Duration::from_millis(self.config.loop_interval_ms)).await;
            }
        }

        println!();
        println!("{}", "=".repeat(60));
        println!(
            "Autonomous loop ended after {} iterations",
            self.iteration_count
        );
        println!("{}", "=".repeat(60));

        Ok(())
    }
}

// ============================================================================
// Main
// ============================================================================

fn print_banner() {
    println!(
        r#"
╔═══════════════════════════════════════════════════════════════════╗
║           AUTONOMOUS SELF-LOOPING AGENT (Rust)                    ║
║                                                                   ║
║  A sandboxed agent that thinks locally, acts via shell,           ║
║  and remembers in ephemeral memory.                               ║
╚═══════════════════════════════════════════════════════════════════╝
"#
    );
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(Level::INFO.into()),
        )
        .init();

    print_banner();

    // Load configuration
    let config = AutonomousConfig::from_env()?;

    println!("Configuration:");
    println!("  Sandbox:         {}", config.sandbox_dir.display());
    println!("  Models:          {}", config.models_dir.display());
    println!("  Model:           {}", config.model_name);
    println!("  Loop interval:   {}ms", config.loop_interval_ms);
    println!("  Max iterations:  {}", config.max_iterations);
    println!("  Agent ID:        {}", config.agent_id);
    println!();

    // Verify model exists
    let model_path = config.models_dir.join(&config.model_name);
    if !model_path.exists() {
        eprintln!("ERROR: Model not found at {}", model_path.display());
        eprintln!("Please download a model first:");
        eprintln!(
            "  wget -O ~/.eliza/models/{} \\",
            config.model_name
        );
        eprintln!(
            "    https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/{}",
            config.model_name
        );
        std::process::exit(1);
    }

    // Check LLM feature
    if !LocalAIPlugin::is_llm_enabled() {
        eprintln!("WARNING: LLM feature is not enabled.");
        eprintln!("Build with: cargo build --features llm");
        eprintln!("Running with mock responses.");
        eprintln!();
    }

    // Create and run agent
    let mut agent = AutonomousAgent::new(config).await?;
    agent.initialize().await?;
    agent.run().await?;

    info!("Agent shutdown complete");
    Ok(())
}
