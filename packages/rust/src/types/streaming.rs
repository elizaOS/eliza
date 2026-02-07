//! Streaming type definitions and extractors for elizaOS
//!
//! This module defines stream content extractors with cross-language parity
//! (matching TypeScript and Python implementations).
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

use std::collections::{HashMap, HashSet};

use super::state::{SchemaRow, StreamEvent};

/// Maximum allowed chunk size to prevent memory issues (1MB)
pub const MAX_CHUNK_SIZE: usize = 1024 * 1024;

/// Error for chunk size validation
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkSizeError {
    /// Actual size of the chunk
    pub actual: usize,
    /// Maximum allowed size
    pub max: usize,
}

impl std::fmt::Display for ChunkSizeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Chunk size {} exceeds maximum {}", self.actual, self.max)
    }
}

impl std::error::Error for ChunkSizeError {}

/// Validate that a chunk doesn't exceed the maximum size.
pub fn validate_chunk_size(chunk: &str) -> Result<(), ChunkSizeError> {
    if chunk.len() > MAX_CHUNK_SIZE {
        Err(ChunkSizeError {
            actual: chunk.len(),
            max: MAX_CHUNK_SIZE,
        })
    } else {
        Ok(())
    }
}

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

// ============================================================================
// MarkableExtractor - Passthrough with external completion control
// ============================================================================

/// Passthrough extractor that can be marked complete externally.
///
/// WHY: When using ValidationStreamExtractor inside dynamic_prompt_exec_from_state,
/// extraction/completion is handled internally. But the outer streaming context
/// still needs to know when streaming is complete for retry/fallback logic.
///
/// This extractor passes through all content and provides a mark_complete() method
/// that the caller can invoke when the underlying operation completes successfully.
///
/// # Example
/// ```ignore
/// let mut extractor = MarkableExtractor::new();
/// let ctx = create_streaming_context(&extractor, callback);
///
/// let result = dynamic_prompt_exec_from_state(...).await;
/// if result.is_some() {
///     extractor.mark_complete(); // Signal success
/// }
///
/// if ctx.is_complete() {
///     // Now returns true after mark_complete()
/// }
/// ```
#[derive(Debug, Default)]
pub struct MarkableExtractor {
    is_done: bool,
}

impl MarkableExtractor {
    /// Create a new MarkableExtractor.
    pub fn new() -> Self {
        Self { is_done: false }
    }

    /// Mark the extractor as complete.
    ///
    /// WHY: Called by the outer code when the underlying operation completes
    /// successfully. This allows is_complete() to return true for retry/fallback logic.
    pub fn mark_complete(&mut self) {
        self.is_done = true;
    }
}

impl IStreamExtractor for MarkableExtractor {
    fn done(&self) -> bool {
        self.is_done
    }

    fn push(&mut self, chunk: &str) -> String {
        if validate_chunk_size(chunk).is_err() {
            return String::new();
        }
        chunk.to_string() // Pass through everything
    }

    fn flush(&mut self) -> String {
        String::new()
    }

    fn reset(&mut self) {
        self.is_done = false;
    }
}

// ============================================================================
// ValidationStreamExtractor - Validation-aware streaming
// ============================================================================

/// Extractor state machine for validation-aware streaming.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtractorState {
    /// Normal operation - actively receiving chunks
    Streaming,
    /// Stream ended, checking validation codes
    Validating,
    /// Validation failed, preparing for retry
    Retrying,
    /// Successfully finished
    Complete,
    /// Unrecoverable error
    Failed,
}

/// Per-field state tracking for progressive validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldState {
    /// Haven't seen this field yet
    Pending,
    /// Found opening tag but no closing tag
    Partial,
    /// Found both tags, content extracted
    Complete,
    /// Validation codes didn't match
    Invalid,
}

/// Configuration for ValidationStreamExtractor.
pub struct ValidationStreamExtractorConfig<F, E>
where
    F: FnMut(&str, Option<&str>),
    E: FnMut(StreamEvent),
{
    /// Validation level (0-3)
    pub level: u8,
    /// Schema rows with field definitions
    pub schema: Vec<SchemaRow>,
    /// Which fields to stream to the consumer
    pub stream_fields: Vec<String>,
    /// Expected validation codes per field
    pub expected_codes: HashMap<String, String>,
    /// Callback for streaming chunks (chunk, field)
    pub on_chunk: F,
    /// Rich event callback for sophisticated consumers
    pub on_event: Option<E>,
    /// Abort signal for cancellation (returns true if aborted)
    pub abort_signal: Option<Box<dyn Fn() -> bool + Send>>,
    /// Whether the consumer has an on_event handler
    pub has_rich_consumer: bool,
}

/// Diagnosis result for error analysis.
#[derive(Debug, Clone, Default)]
pub struct ValidationDiagnosis {
    /// Fields that were never started
    pub missing_fields: Vec<String>,
    /// Fields with wrong validation codes
    pub invalid_fields: Vec<String>,
    /// Fields that started but didn't complete
    pub incomplete_fields: Vec<String>,
}

/// Validation-aware stream extractor for dynamic_prompt_exec_from_state.
///
/// WHY THIS EXISTS:
/// LLMs can silently truncate output when they hit token limits. This is catastrophic
/// for structured outputs - you might get half a JSON object. Traditional streaming
/// has no validation - you might stream half a broken response.
///
/// This extractor bridges the gap: it enables streaming while detecting truncation.
/// It uses "validation codes" - random UUIDs that the LLM must echo. If the echoed
/// code matches, we know that part wasn't truncated.
///
/// VALIDATION LEVELS:
/// - Level 0 (Trusted): No codes, stream immediately. Fast but no safety.
/// - Level 1 (Progressive): Per-field codes, emit as each field validates.
/// - Level 2 (First Checkpoint): Code at start only, buffer until validated.
/// - Level 3 (Full): Codes at start AND end, maximum safety.
pub struct ValidationStreamExtractor<F, E>
where
    F: FnMut(&str, Option<&str>),
    E: FnMut(StreamEvent),
{
    config: ValidationStreamExtractorConfig<F, E>,
    buffer: String,
    field_contents: HashMap<String, String>,
    validated_fields: HashSet<String>,
    emitted_content: HashMap<String, String>,
    field_states: HashMap<String, FieldState>,
    state: ExtractorState,
}

impl<F, E> ValidationStreamExtractor<F, E>
where
    F: FnMut(&str, Option<&str>),
    E: FnMut(StreamEvent),
{
    /// Create a new ValidationStreamExtractor with the given configuration.
    pub fn new(config: ValidationStreamExtractorConfig<F, E>) -> Self {
        let mut field_states = HashMap::new();
        for field in &config.stream_fields {
            field_states.insert(field.clone(), FieldState::Pending);
        }

        Self {
            config,
            buffer: String::new(),
            field_contents: HashMap::new(),
            validated_fields: HashSet::new(),
            emitted_content: HashMap::new(),
            field_states,
            state: ExtractorState::Streaming,
        }
    }

    /// Check if extraction is complete.
    pub fn done(&self) -> bool {
        matches!(
            self.state,
            ExtractorState::Complete | ExtractorState::Failed
        )
    }

    /// Get current extractor state.
    pub fn get_state(&self) -> ExtractorState {
        self.state
    }

    /// Process a chunk from the model stream.
    pub fn push(&mut self, chunk: &str) -> String {
        // Check for cancellation
        if let Some(ref abort_signal) = self.config.abort_signal {
            if abort_signal() {
                if !matches!(
                    self.state,
                    ExtractorState::Complete | ExtractorState::Failed
                ) {
                    self.state = ExtractorState::Failed;
                    self.emit_event(StreamEvent::error("Cancelled by user".to_string()));
                }
                return String::new();
            }
        }

        if self.state != ExtractorState::Streaming {
            return String::new();
        }

        if validate_chunk_size(chunk).is_err() {
            return String::new();
        }

        self.buffer.push_str(chunk);

        // Extract field contents from buffer
        self.extract_field_contents();

        // For levels 0-1, check if we can emit validated content
        if self.config.level <= 1 {
            self.check_per_field_emission();
        }

        String::new() // We emit via callbacks, not return value
    }

    /// Flush any buffered content.
    pub fn flush(&mut self) -> String {
        // Don't overwrite failed state (e.g., from abort)
        if self.state == ExtractorState::Failed {
            return String::new();
        }

        // For levels 2-3, emit all buffered content when validation passes
        if self.config.level >= 2 {
            for field in self.config.stream_fields.clone() {
                if let Some(content) = self.field_contents.get(&field).cloned() {
                    if !content.is_empty() {
                        self.emit_field_content(&field, &content);
                    }
                }
            }
        }

        self.state = ExtractorState::Complete;
        self.emit_event(StreamEvent::complete());
        String::new()
    }

    /// Reset extractor state for retry.
    pub fn reset(&mut self) {
        self.buffer.clear();
        self.field_contents.clear();
        self.validated_fields.clear();
        self.emitted_content.clear();
        for field in &self.config.stream_fields {
            self.field_states.insert(field.clone(), FieldState::Pending);
        }
        self.state = ExtractorState::Streaming;
    }

    /// Signal a retry attempt. Returns info about validated fields for smart retry prompts.
    pub fn signal_retry(&mut self, retry_count: u32) -> Vec<String> {
        self.state = ExtractorState::Retrying;

        // Emit separator for simple consumers
        if !self.config.has_rich_consumer {
            (self.config.on_chunk)("\n-- that's not right, let me start again:\n", None);
        }

        self.emit_event(StreamEvent::retry_start(retry_count));

        self.validated_fields.iter().cloned().collect()
    }

    /// Signal an unrecoverable error.
    pub fn signal_error(&mut self, message: &str) {
        self.state = ExtractorState::Failed;
        self.emit_event(StreamEvent::error(message.to_string()));
    }

    /// Get fields that passed validation (for smart retry context).
    pub fn get_validated_fields(&self) -> HashMap<String, String> {
        let mut result = HashMap::new();
        for field in &self.validated_fields {
            if let Some(content) = self.field_contents.get(field) {
                result.insert(field.clone(), content.clone());
            }
        }
        result
    }

    /// Diagnose what went wrong for error reporting.
    pub fn diagnose(&self) -> ValidationDiagnosis {
        let mut missing_fields = Vec::new();
        let mut invalid_fields = Vec::new();
        let mut incomplete_fields = Vec::new();

        for row in &self.config.schema {
            match self.field_states.get(&row.field) {
                Some(FieldState::Pending) => missing_fields.push(row.field.clone()),
                Some(FieldState::Invalid) => invalid_fields.push(row.field.clone()),
                Some(FieldState::Partial) => incomplete_fields.push(row.field.clone()),
                _ => {}
            }
        }

        ValidationDiagnosis {
            missing_fields,
            invalid_fields,
            incomplete_fields,
        }
    }

    // Private helpers

    fn extract_field_contents(&mut self) {
        // Pre-compute all field tags for boundary detection
        let all_open_tags: Vec<String> = self
            .config
            .schema
            .iter()
            .map(|row| format!("<{}>", row.field))
            .collect();

        for row in self.config.schema.clone() {
            let field = &row.field;
            let open_tag = format!("<{}>", field);
            let close_tag = format!("</{}>", field);

            if let Some(open_idx) = self.buffer.find(&open_tag) {
                let content_start = open_idx + open_tag.len();

                if let Some(close_idx) = self.buffer[content_start..].find(&close_tag) {
                    // Complete field found
                    let content = self.buffer[content_start..content_start + close_idx].to_string();
                    self.field_contents.insert(field.clone(), content);
                    self.field_states
                        .insert(field.clone(), FieldState::Complete);
                } else if self.field_states.get(field) != Some(&FieldState::Complete) {
                    // Partial field - still streaming
                    self.field_states.insert(field.clone(), FieldState::Partial);

                    // Find the end boundary for partial content
                    let mut partial_end = self.buffer.len();
                    for other_tag in &all_open_tags {
                        if other_tag == &open_tag {
                            continue; // Skip self
                        }
                        if let Some(other_idx) = self.buffer[content_start..].find(other_tag) {
                            let abs_idx = content_start + other_idx;
                            if abs_idx < partial_end {
                                partial_end = abs_idx;
                            }
                        }
                    }

                    let partial_content = self.buffer[content_start..partial_end].to_string();
                    self.field_contents.insert(field.clone(), partial_content);
                }
            }
        }
    }

    fn check_per_field_emission(&mut self) {
        for field in self.config.stream_fields.clone() {
            let state = self.field_states.get(&field).copied();
            if state == Some(FieldState::Invalid) {
                continue; // Skip already invalid fields
            }

            let content = match self.field_contents.get(&field) {
                Some(c) if !c.is_empty() => c.clone(),
                _ => continue,
            };

            // Check validation codes if required
            if let Some(expected_code) = self.config.expected_codes.get(&field).cloned() {
                let start_code_valid = self.check_validation_code(&field, "start", &expected_code);
                let end_code_valid = self.check_validation_code(&field, "end", &expected_code);

                if state == Some(FieldState::Complete) {
                    if start_code_valid && end_code_valid {
                        self.validated_fields.insert(field.clone());
                        self.emit_field_content(&field, &content);
                        self.emit_event(StreamEvent::field_validated(field.clone()));
                    } else if start_code_valid && !end_code_valid {
                        self.field_states.insert(field.clone(), FieldState::Invalid);
                        self.emit_event(StreamEvent::error(format!(
                            "End validation code mismatch for {}",
                            field
                        )));
                    } else {
                        self.field_states.insert(field.clone(), FieldState::Invalid);
                        self.emit_event(StreamEvent::error(format!(
                            "Validation codes mismatch for {}",
                            field
                        )));
                    }
                }
            } else {
                // No validation codes for this field
                if self.config.level == 0 {
                    // Level 0: Stream immediately as content arrives (no validation)
                    self.emit_field_content(&field, &content);
                } else if state == Some(FieldState::Complete) {
                    // Levels 1-3: Stream when field is complete
                    self.emit_field_content(&field, &content);
                }
            }
        }
    }

    fn check_validation_code(&self, field: &str, position: &str, expected_code: &str) -> bool {
        let code_field = format!("code_{}_{}", field, position);
        let open_tag = format!("<{}>", code_field);
        let close_tag = format!("</{}>", code_field);

        if let Some(open_idx) = self.buffer.find(&open_tag) {
            let content_start = open_idx + open_tag.len();
            if let Some(close_idx) = self.buffer[content_start..].find(&close_tag) {
                let actual_code = self.buffer[content_start..content_start + close_idx].trim();
                return actual_code == expected_code;
            }
        }
        false
    }

    fn emit_field_content(&mut self, field: &str, content: &str) {
        let previously_emitted = self
            .emitted_content
            .get(field)
            .map(|s| s.len())
            .unwrap_or(0);

        // Defensive check: if content shrinks, reset and emit full content
        if content.len() < previously_emitted {
            self.emitted_content
                .insert(field.to_string(), content.to_string());
            if !content.is_empty() {
                (self.config.on_chunk)(content, Some(field));
                self.emit_event(StreamEvent::chunk(field.to_string(), content.to_string()));
            }
            return;
        }

        // Emit only the new portion
        if content.len() > previously_emitted {
            let new_content = &content[previously_emitted..];
            self.emitted_content
                .insert(field.to_string(), content.to_string());
            (self.config.on_chunk)(new_content, Some(field));
            self.emit_event(StreamEvent::chunk(
                field.to_string(),
                new_content.to_string(),
            ));
        }
    }

    fn emit_event(&mut self, event: StreamEvent) {
        if let Some(ref mut on_event) = self.config.on_event {
            on_event(event);
        }
    }
}
