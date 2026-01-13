//! Logging utilities for SWE-agent

use tracing::{debug, error, info, warn, Level};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

/// Initialize the logging system
pub fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(filter)
        .init();
}

/// Initialize logging with a specific level
pub fn init_logging_with_level(level: Level) {
    let filter = EnvFilter::new(level.as_str());

    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(filter)
        .init();
}

/// Log an info message with agent context
pub fn log_agent_info(agent_name: &str, message: &str) {
    info!(agent = agent_name, "{}", message);
}

/// Log a debug message with agent context
pub fn log_agent_debug(agent_name: &str, message: &str) {
    debug!(agent = agent_name, "{}", message);
}

/// Log a warning with agent context
pub fn log_agent_warn(agent_name: &str, message: &str) {
    warn!(agent = agent_name, "{}", message);
}

/// Log an error with agent context
pub fn log_agent_error(agent_name: &str, message: &str) {
    error!(agent = agent_name, "{}", message);
}

/// Log step information
pub fn log_step(step_num: usize, thought: &str, action: &str) {
    info!(
        step = step_num,
        "💭 THOUGHT\n{}\n\n🎬 ACTION\n{}", thought, action
    );
}

/// Log observation
pub fn log_observation(observation: &str) {
    debug!(
        len = observation.len(),
        "📋 OBSERVATION: {}",
        if observation.len() > 200 {
            format!("{}...", &observation[..200])
        } else {
            observation.to_string()
        }
    );
}
