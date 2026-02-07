//! iMessage actions

mod send_message;

pub use send_message::extract_target_from_text;
pub use send_message::SendMessageAction;
