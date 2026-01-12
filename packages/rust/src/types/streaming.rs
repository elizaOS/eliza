//! Streaming type definitions for elizaOS
//!
//! This module defines the interface contract for stream content extractors.
//! Implementations live outside of the core types module (e.g., in utilities or services).

/// Interface for stream content extractors.
///
/// Implementations decide how to filter LLM output for streaming (XML parsing, JSON parsing,
/// plain text passthrough, etc.). Create a fresh instance per stream; do not reuse instances.
pub trait IStreamExtractor: Send {
    /// Whether extraction is complete (no more content expected from this stream).
    fn done(&self) -> bool;

    /// Process a chunk from the model stream.
    ///
    /// Returns the text that should be streamed to the client. An empty string means "nothing yet".
    fn push(&mut self, chunk: &str) -> String;
}
