#![allow(missing_docs)]

pub mod embeddings;
pub mod image;
pub mod object;
pub mod speech;
pub mod text;
pub mod tokenization;
pub mod transcription;

pub use embeddings::{handle_batch_text_embedding, handle_text_embedding};
pub use image::{handle_image_description, handle_image_generation};
pub use object::{handle_object_large, handle_object_small};
pub use speech::handle_text_to_speech;
pub use text::{handle_text_large, handle_text_small};
pub use tokenization::{handle_tokenizer_decode, handle_tokenizer_encode};
pub use transcription::handle_transcription;
