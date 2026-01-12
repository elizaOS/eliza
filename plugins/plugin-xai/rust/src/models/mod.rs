//! Model handlers for the xAI plugin.

mod text;
mod embedding;

pub use text::{TextSmallHandler, TextLargeHandler};
pub use embedding::TextEmbeddingHandler;
