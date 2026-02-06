//! Lobster plugin actions

mod resume;
mod run;

pub use resume::LobsterResumeAction;
pub use run::LobsterRunAction;

use crate::Action;

/// Get all lobster actions
pub fn get_lobster_actions() -> Vec<Box<dyn Action>> {
    vec![
        Box::new(LobsterRunAction::new()),
        Box::new(LobsterResumeAction::new()),
    ]
}
