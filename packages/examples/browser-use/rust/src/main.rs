//! Browser Use Example (Rust)
//!
//! An autonomous ElizaOS agent that explores the web with curiosity,
//! focusing on understanding quantum physics and related concepts.
//!
//! Usage:
//!     cargo run --release
//!     cargo run --release -- --topic "quantum entanglement"
//!     cargo run --release -- --autonomous

use anyhow::{Context, Result};
use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tokio::time::sleep;
use tracing::{info, warn, Level};
use tracing_subscriber::FmtSubscriber;

/// Character configuration loaded from shared JSON file
#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
struct CharacterConfig {
    name: String,
    bio: String,
    system: String,
    topics: Vec<String>,
    #[serde(default)]
    exploration: ExplorationConfig,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct ExplorationConfig {
    #[serde(default)]
    arxiv_base_url: Option<String>,
    #[serde(default)]
    initial_prompt_template: Option<String>,
    #[serde(default)]
    followup_prompt_template: Option<String>,
}

impl Default for CharacterConfig {
    fn default() -> Self {
        Self {
            name: "QuantumExplorer".to_string(),
            bio: "A curious AI researcher fascinated by quantum physics.".to_string(),
            system: "You are QuantumExplorer, a curious AI researcher.".to_string(),
            topics: vec![
                "quantum physics".to_string(),
                "quantum computing".to_string(),
            ],
            exploration: ExplorationConfig::default(),
        }
    }
}

/// Load character configuration from shared JSON file
fn load_character_config() -> CharacterConfig {
    // Try to find character.json relative to the executable or in parent directory
    let paths_to_try = [
        PathBuf::from("../character.json"),
        PathBuf::from("character.json"),
        PathBuf::from("../../character.json"),
    ];
    
    for path in &paths_to_try {
        if let Ok(content) = fs::read_to_string(path) {
            match serde_json::from_str(&content) {
                Ok(config) => {
                    info!("Loaded character config from {:?}", path);
                    return config;
                }
                Err(e) => {
                    warn!("Failed to parse character.json: {}", e);
                }
            }
        }
    }
    
    warn!("Could not load character.json, using defaults");
    CharacterConfig::default()
}

lazy_static::lazy_static! {
    static ref CHARACTER_CONFIG: CharacterConfig = load_character_config();
}

/// Configuration for the explorer
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct ExplorerConfig {
    topic: Option<String>,
    autonomous: bool,
    max_steps: usize,
    headless: bool,
    verbose: bool,
}

impl Default for ExplorerConfig {
    fn default() -> Self {
        Self {
            topic: None,
            autonomous: false,
            max_steps: 10,
            headless: true,
            verbose: false,
        }
    }
}

/// Simple LLM client for exploration
struct LlmClient {
    api_key: String,
    base_url: String,
    model: String,
}

#[derive(Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
    max_tokens: u32,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessageResponse,
}

#[derive(Deserialize)]
struct ChatMessageResponse {
    content: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

impl LlmClient {
    fn new() -> Result<Self> {
        // Try Groq first (fast and cheap)
        if let Ok(api_key) = env::var("GROQ_API_KEY") {
            return Ok(Self {
                api_key,
                base_url: "https://api.groq.com/openai/v1".to_string(),
                model: env::var("GROQ_MODEL").unwrap_or_else(|_| "llama-3.3-70b-versatile".to_string()),
            });
        }

        // Try OpenAI
        if let Ok(api_key) = env::var("OPENAI_API_KEY") {
            return Ok(Self {
                api_key,
                base_url: "https://api.openai.com/v1".to_string(),
                model: env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-5-mini".to_string()),
            });
        }

        anyhow::bail!("No API key found. Set GROQ_API_KEY or OPENAI_API_KEY.")
    }

    async fn generate(&self, system: &str, prompt: &str) -> Result<String> {
        let client = reqwest::Client::new();

        let request = ChatRequest {
            model: self.model.clone(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: system.to_string(),
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: prompt.to_string(),
                },
            ],
            temperature: 0.7,
            max_tokens: 2048,
        };

        let response = client
            .post(format!("{}/chat/completions", self.base_url))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .context("Failed to send request")?;

        let chat_response: ChatResponse = response
            .json()
            .await
            .context("Failed to parse response")?;

        chat_response
            .choices
            .first()
            .map(|c| c.message.content.clone())
            .ok_or_else(|| anyhow::anyhow!("No response generated"))
    }
}

/// Explore a quantum physics topic by searching research papers
async fn explore_topic(client: &LlmClient, topic: &str, max_steps: usize) -> Result<()> {
    println!("\n{}", "═".repeat(60));
    println!("🔬 Research Mission: {}", topic);
    println!("{}\n", "═".repeat(60));

    // Use shared character config
    let system_prompt = &CHARACTER_CONFIG.system;
    let arxiv_base = CHARACTER_CONFIG
        .exploration
        .arxiv_base_url
        .as_deref()
        .unwrap_or("https://arxiv.org/search/?searchtype=all&query=");
    
    let arxiv_url = format!("{}{}", arxiv_base, topic.replace(' ', "+"));

    // Initial exploration prompt from config or default
    let initial_prompt = CHARACTER_CONFIG
        .exploration
        .initial_prompt_template
        .as_ref()
        .map(|t| t.replace("{topic}", topic).replace("{arxiv_url}", &arxiv_url))
        .unwrap_or_else(|| {
            format!(
                r#"Research mission: Find NEW scientific discoveries about "{}" in quantum physics.

Imagine you are browsing arXiv.org ({}).

Please:
1. Describe what recent research papers might be available on this topic
2. Identify 3-5 potential breakthrough findings from recent papers
3. Explain the experimental methods and results you would expect to find
4. Highlight any cutting-edge applications (quantum computing, cryptography, etc.)

Be specific and cite hypothetical paper titles and author names when discussing findings."#,
                topic, arxiv_url
            )
        });

    let response = client.generate(system_prompt, &initial_prompt).await?;

    println!("📖 Research findings:\n{}\n", response);

    // Follow-up explorations - continue research paper discovery
    for step in 1..max_steps {
        sleep(Duration::from_millis(500)).await;

        let follow_up = CHARACTER_CONFIG
            .exploration
            .followup_prompt_template
            .as_ref()
            .map(|t| t.replace("{topic}", topic))
            .unwrap_or_else(|| {
                format!(
                    r#"Continue your research on {}. 

Based on the papers you discovered, what are the most exciting open questions?
What NEW experiments are being proposed? What theoretical predictions await verification?
Identify specific research groups or institutions leading this work."#,
                    topic
                )
            });

        let response = client.generate(system_prompt, &follow_up).await?;
        println!("📖 Research step {} findings:\n{}\n", step + 1, response);
    }

    Ok(())
}

/// Run autonomous exploration across multiple topics
async fn autonomous_exploration(client: &LlmClient, max_iterations: usize) -> Result<()> {
    info!("🚀 Starting autonomous exploration mode...");
    println!("\nThe agent will explore quantum physics topics independently.\n");

    let mut rng = rand::thread_rng();
    let mut explored: Vec<String> = Vec::new();
    let topics = &CHARACTER_CONFIG.topics;

    for i in 0..max_iterations {
        // Choose a topic not yet explored
        let available: Vec<&String> = topics
            .iter()
            .filter(|t| !explored.contains(*t))
            .collect();

        let topic = if available.is_empty() {
            topics.choose(&mut rng).unwrap()
        } else {
            available.choose(&mut rng).unwrap()
        };

        explored.push(topic.clone());

        println!("\n{}", "━".repeat(60));
        println!("  Iteration {}/{}: {}", i + 1, max_iterations, topic);
        println!("{}", "━".repeat(60));

        explore_topic(client, topic, 3).await?;

        sleep(Duration::from_secs(1)).await;
    }

    println!("\n✅ Autonomous exploration complete!");
    println!("   Topics explored: {}", explored.join(", "));

    Ok(())
}

fn parse_args() -> ExplorerConfig {
    let args: Vec<String> = env::args().collect();
    let mut config = ExplorerConfig::default();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--topic" => {
                if i + 1 < args.len() {
                    config.topic = Some(args[i + 1].clone());
                    i += 1;
                }
            }
            "--autonomous" => {
                config.autonomous = true;
            }
            "--max-steps" => {
                if i + 1 < args.len() {
                    config.max_steps = args[i + 1].parse().unwrap_or(10);
                    i += 1;
                }
            }
            "--verbose" => {
                config.verbose = true;
            }
            "--help" | "-h" => {
                println!(
                    r#"QuantumExplorer - Autonomous browser agent for quantum physics

USAGE:
    browser-use-example [OPTIONS]

OPTIONS:
    --topic <TOPIC>      Specific topic to explore (default: random)
    --autonomous         Enable continuous autonomous exploration
    --max-steps <N>      Maximum exploration steps (default: 10)
    --verbose            Enable verbose logging
    --help, -h           Show this help message

ENVIRONMENT:
    GROQ_API_KEY         Groq API key (recommended - fast and cheap)
    OPENAI_API_KEY       OpenAI API key (alternative)

EXAMPLES:
    cargo run --release
    cargo run --release -- --topic "quantum entanglement"
    cargo run --release -- --autonomous --max-steps 5
"#
                );
                std::process::exit(0);
            }
            _ => {}
        }
        i += 1;
    }

    config
}

#[tokio::main]
async fn main() -> Result<()> {
    let config = parse_args();

    // Initialize logging
    let level = if config.verbose {
        Level::DEBUG
    } else {
        Level::INFO
    };
    let subscriber = FmtSubscriber::builder().with_max_level(level).finish();
    tracing::subscriber::set_global_default(subscriber)?;

    println!("\n{}", "═".repeat(60));
    println!("  🔬 {} - Autonomous Browser Agent (Rust)", CHARACTER_CONFIG.name);
    println!("  Exploring the mysteries of quantum physics...");
    println!("{}\n", "═".repeat(60));

    // Create LLM client
    let client = LlmClient::new()?;
    info!("Using model: {}", client.model);

    if config.autonomous {
        autonomous_exploration(&client, config.max_steps).await?;
    } else {
        let default_topic = CHARACTER_CONFIG
            .topics
            .first()
            .map(|s| s.as_str())
            .unwrap_or("quantum physics");
        let topic = config.topic.as_deref().unwrap_or(default_topic);
        explore_topic(&client, topic, config.max_steps).await?;
    }

    Ok(())
}
