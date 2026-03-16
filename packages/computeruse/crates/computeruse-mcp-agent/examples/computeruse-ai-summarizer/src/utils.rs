use anyhow::Result;
use clap::Parser;
use std::env;
use std::path::PathBuf;
use tracing::Level;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
pub struct Args {
    #[arg(
        short,
        long,
        default_value = "you're are screen summarizer assitant and here is the data of ui element tree as context. the ui element tree data would be in json format. use the `name` and `text` attr of ui tree to summarize the screen context consicely"
    )]
    pub system_prompt: String,
    #[arg(short, long, default_value = "gemma3:1b")]
    pub model: String,
    #[arg(short, long, default_value = "ctrl+alt+j")]
    pub hotkey: String,
    #[arg(short, long, action = clap::ArgAction::SetTrue)]
    pub ai_mode: bool,
}

pub fn init_logging() -> Result<()> {
    let log_level = env::var("LOG_LEVEL")
        .map(|level| match level.to_lowercase().as_str() {
            "error" => Level::ERROR,
            "warn" => Level::WARN,
            "info" => Level::INFO,
            "debug" => Level::DEBUG,
            _ => Level::INFO,
        })
        .unwrap_or(Level::DEBUG);

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive(log_level.into()))
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();

    Ok(())
}

pub fn get_agent_binary_path() -> PathBuf {
    if let Ok(env_path) = std::env::var("COMPUTERUSE_AGENT_PATH") {
        return PathBuf::from(env_path);
    }
    let mut path = env::current_dir().unwrap();
    path.push("target");
    path.push("release");
    path.push("computeruse-mcp-agent");
    #[cfg(target_os = "windows")]
    path.set_extension("exe");
    path
}
