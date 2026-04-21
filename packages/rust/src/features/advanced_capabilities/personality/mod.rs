//! Personality capability — character evolution and per-user preferences.
//!
//! Ports the TypeScript `plugin-personality` module, providing:
//! - Character traits, modifications, and snapshots
//! - CharacterFileManager service
//! - MODIFY_CHARACTER action
//! - CHARACTER_EVOLUTION evaluator
//! - USER_PERSONALITY provider

pub mod character_evolution;
pub mod character_file_manager;
pub mod modify_character;
pub mod types;
pub mod user_personality;

pub use character_evolution::CharacterEvolutionEvaluator;
pub use character_file_manager::CharacterFileManager;
pub use modify_character::ModifyCharacterAction;
pub use types::*;
pub use user_personality::UserPersonalityProvider;
