//! Parity with TypeScript `plugin-collector`: optional agent orchestrator (PTY) via
//! `ELIZA_AGENT_ORCHESTRATOR`.

/// Match `elizaAgentOrchestratorLoadRequested()` in `plugin-collector.ts`.
pub fn eliza_agent_orchestrator_load_requested() -> bool {
    match std::env::var("ELIZA_AGENT_ORCHESTRATOR") {
        Ok(raw) => {
            let normalized = raw.trim().to_lowercase();
            if matches!(normalized.as_str(), "0" | "false" | "no") {
                return false;
            }
            matches!(normalized.as_str(), "1" | "true" | "yes")
        }
        Err(_) => false,
    }
}
