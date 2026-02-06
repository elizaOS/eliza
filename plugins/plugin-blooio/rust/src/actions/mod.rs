pub mod send_message;

pub use send_message::SendMessageAction;

/// Returns all actions provided by the Blooio plugin.
pub fn get_blooio_actions() -> Vec<Box<dyn crate::Action>> {
    vec![Box::new(SendMessageAction)]
}
