// advanced_capabilities/providers/mod.rs
pub mod agent_settings;
pub mod knowledge;
pub mod roles;
pub mod settings;

pub use agent_settings::AgentSettingsProvider;
pub use knowledge::KnowledgeProvider;
pub use roles::RolesProvider;
pub use settings::SettingsProvider;
