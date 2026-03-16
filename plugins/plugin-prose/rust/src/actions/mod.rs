//! Prose plugin actions

mod compile;
mod help;
mod run;

pub use compile::ProseCompileAction;
pub use help::ProseHelpAction;
pub use run::ProseRunAction;

use crate::Action;

/// Get all prose actions
pub fn get_prose_actions() -> Vec<Box<dyn Action>> {
    vec![
        Box::new(ProseRunAction::new()),
        Box::new(ProseCompileAction::new()),
        Box::new(ProseHelpAction::new()),
    ]
}
