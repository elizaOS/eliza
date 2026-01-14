//! Model handlers for the xAI plugin.

mod embedding;
mod text;

pub use embedding::TextEmbeddingHandler;
pub use text::{TextLargeHandler, TextSmallHandler};
