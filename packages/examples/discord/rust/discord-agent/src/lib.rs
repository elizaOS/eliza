//! Discord Agent Library
//!
//! This module exposes the character and handler modules for the Discord agent.

pub mod character;
pub mod handlers;

pub use character::create_character;
pub use handlers::{generate_response, handle_member_joined, handle_reaction_added};
