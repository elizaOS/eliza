//! Model handlers for ElizaOS Cloud Plugin.
//!
//! These handlers are designed to be called from the elizaOS runtime
//! to handle various model types.

pub mod text;
pub mod object;
pub mod embeddings;
pub mod image;
pub mod speech;
pub mod transcription;
pub mod tokenization;

// Text generation
pub use text::{handle_text_small, handle_text_large};

// Object/structured generation
pub use object::{handle_object_small, handle_object_large};

// Embeddings
pub use embeddings::{handle_text_embedding, handle_batch_text_embedding};

// Image
pub use image::{handle_image_generation, handle_image_description};

// Audio
pub use speech::handle_text_to_speech;
pub use transcription::handle_transcription;

// Tokenization
pub use tokenization::{handle_tokenizer_encode, handle_tokenizer_decode};
