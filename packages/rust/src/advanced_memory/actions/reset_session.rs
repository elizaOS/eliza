use crate::types::Action;

// TODO: Implement reset_session action
pub struct ResetSessionAction;

impl Action for ResetSessionAction {
    fn name(&self) -> &str {
        "RESET_SESSION"
    }
}
