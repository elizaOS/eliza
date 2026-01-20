//! Streaming type definitions for elizaOS
//!
//! This module defines the interface contract for stream content extractors.
//! Implementations live outside of the core types module (e.g., in utilities or services).
//!
//! # Validation-Aware Streaming
//!
//! LLMs can silently truncate output when hitting token limits. This is catastrophic
//! for structured outputs - you might stream half a broken response.
//!
//! Solution: Validation codes - short UUIDs the LLM must echo back. If the echoed
//! code matches, we know that part wasn't truncated.
//!
//! ## Validation Levels:
//! - 0 (Trusted): No codes, stream immediately. Fast but no safety.
//! - 1 (Progressive): Per-field codes, stream as each field validates.
//! - 2 (First Checkpoint): Code at start, buffer until validated.
//! - 3 (Full): Codes at start AND end, maximum safety.

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

    /// Flush any buffered content (called when stream ends).
    fn flush(&mut self) -> String {
        String::new()
    }

    /// Reset internal state for reuse (e.g., between retry attempts).
    fn reset(&mut self) {}
}

/// Interface for streaming retry state tracking.
///
/// WHY: When streaming fails mid-response, we need to:
/// 1. Know what was successfully streamed (for continuation prompts)
/// 2. Know if the stream completed (don't retry complete streams)
/// 3. Reset state for retry attempts
pub trait IStreamingRetryState: Send {
    /// Get all text that was successfully streamed.
    /// Use this for building continuation prompts on retry.
    fn get_streamed_text(&self) -> String;

    /// Check if streaming completed successfully.
    /// If true, no retry needed. If false, can retry with continuation.
    fn is_complete(&self) -> bool;

    /// Reset state for a new streaming attempt.
    fn reset(&mut self);
}
