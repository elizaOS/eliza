// advanced_capabilities/providers/mod.rs
pub mod agent_settings;
pub mod contacts;
pub mod facts;
pub mod follow_ups;
pub mod knowledge;
pub mod relationships;
pub mod roles;
pub mod settings;

pub use agent_settings::AgentSettingsProvider;
pub use contacts::ContactsProvider;
pub use facts::FactsProvider;
pub use follow_ups::FollowUpsProvider;
pub use knowledge::KnowledgeProvider;
pub use relationships::RelationshipsProvider;
pub use roles::RolesProvider;
pub use settings::SettingsProvider;
