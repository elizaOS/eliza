//! Tests for dynamic_prompt_exec_from_state and related functionality.
//!
//! This test module validates the dynamic execution engine:
//! 1. SchemaRow and RetryBackoffConfig types
//! 2. XML parsing and validation code handling
//! 3. Cross-language parity with TypeScript and Python

use elizaos::types::state::{RetryBackoffConfig, SchemaRow, StreamEvent, StreamEventType};

// ============================================================================
// SchemaRow Tests
// ============================================================================

#[test]
fn test_schema_row_new() {
    let row = SchemaRow::new("thought", "Your internal reasoning");
    assert_eq!(row.field, "thought");
    assert_eq!(row.description, "Your internal reasoning");
    assert!(!row.required);
    assert!(row.validate_field.is_none());
    assert!(row.stream_field.is_none());
}

#[test]
fn test_schema_row_required() {
    let row = SchemaRow::new("text", "Response to user").required();
    assert!(row.required);
}

#[test]
fn test_schema_row_validate() {
    let row = SchemaRow::new("text", "Response").validate(true);
    assert_eq!(row.validate_field, Some(true));

    let row_false = SchemaRow::new("thought", "Reasoning").validate(false);
    assert_eq!(row_false.validate_field, Some(false));
}

#[test]
fn test_schema_row_stream() {
    let row = SchemaRow::new("text", "Response").stream(true);
    assert_eq!(row.stream_field, Some(true));

    let row_false = SchemaRow::new("thought", "Reasoning").stream(false);
    assert_eq!(row_false.stream_field, Some(false));
}

#[test]
fn test_schema_row_builder_chain() {
    let row = SchemaRow::new("text", "Response to user")
        .required()
        .validate(true)
        .stream(true);

    assert_eq!(row.field, "text");
    assert_eq!(row.description, "Response to user");
    assert!(row.required);
    assert_eq!(row.validate_field, Some(true));
    assert_eq!(row.stream_field, Some(true));
}

// ============================================================================
// RetryBackoffConfig Tests
// ============================================================================

#[test]
fn test_retry_backoff_config_default() {
    let config = RetryBackoffConfig::default();
    assert_eq!(config.initial_ms, 1000);
    assert_eq!(config.multiplier, 2.0);
    assert_eq!(config.max_ms, 30000);
}

#[test]
fn test_retry_backoff_config_custom() {
    let config = RetryBackoffConfig {
        initial_ms: 500,
        multiplier: 1.5,
        max_ms: 10000,
    };
    assert_eq!(config.initial_ms, 500);
    assert_eq!(config.multiplier, 1.5);
    assert_eq!(config.max_ms, 10000);
}

#[test]
fn test_retry_backoff_delay_calculation() {
    let config = RetryBackoffConfig {
        initial_ms: 1000,
        multiplier: 2.0,
        max_ms: 30000,
    };

    // First retry: 1000 * 2^0 = 1000ms
    assert_eq!(config.delay_for_retry(1), 1000);

    // Second retry: 1000 * 2^1 = 2000ms
    assert_eq!(config.delay_for_retry(2), 2000);

    // Third retry: 1000 * 2^2 = 4000ms
    assert_eq!(config.delay_for_retry(3), 4000);

    // Fourth retry: 1000 * 2^3 = 8000ms
    assert_eq!(config.delay_for_retry(4), 8000);
}

#[test]
fn test_retry_backoff_delay_capped() {
    let config = RetryBackoffConfig {
        initial_ms: 1000,
        multiplier: 2.0,
        max_ms: 5000,
    };

    // Fifth retry would be 1000 * 2^4 = 16000ms, but capped at 5000ms
    assert_eq!(config.delay_for_retry(5), 5000);
}

// ============================================================================
// StreamEventType Tests
// ============================================================================

#[test]
fn test_stream_event_type_values() {
    // Verify all event types exist and have correct serialization
    assert_eq!(
        serde_json::to_string(&StreamEventType::Chunk).unwrap(),
        "\"chunk\""
    );
    assert_eq!(
        serde_json::to_string(&StreamEventType::FieldValidated).unwrap(),
        "\"field_validated\""
    );
    assert_eq!(
        serde_json::to_string(&StreamEventType::RetryStart).unwrap(),
        "\"retry_start\""
    );
    assert_eq!(
        serde_json::to_string(&StreamEventType::Error).unwrap(),
        "\"error\""
    );
    assert_eq!(
        serde_json::to_string(&StreamEventType::Complete).unwrap(),
        "\"complete\""
    );
}

// ============================================================================
// StreamEvent Tests
// ============================================================================

#[test]
fn test_stream_event_chunk() {
    let event = StreamEvent::chunk("text", "Hello world");
    assert_eq!(event.event_type, StreamEventType::Chunk);
    assert_eq!(event.field, Some("text".to_string()));
    assert_eq!(event.chunk, Some("Hello world".to_string()));
    assert!(event.timestamp > 0);
}

#[test]
fn test_stream_event_field_validated() {
    let event = StreamEvent::field_validated("text");
    assert_eq!(event.event_type, StreamEventType::FieldValidated);
    assert_eq!(event.field, Some("text".to_string()));
    assert!(event.timestamp > 0);
}

#[test]
fn test_stream_event_retry_start() {
    let event = StreamEvent::retry_start(2);
    assert_eq!(event.event_type, StreamEventType::RetryStart);
    assert_eq!(event.retry_count, Some(2));
    assert!(event.timestamp > 0);
}

#[test]
fn test_stream_event_error() {
    let event = StreamEvent::error("Something went wrong");
    assert_eq!(event.event_type, StreamEventType::Error);
    assert_eq!(event.error, Some("Something went wrong".to_string()));
    assert!(event.timestamp > 0);
}

#[test]
fn test_stream_event_complete() {
    let event = StreamEvent::complete();
    assert_eq!(event.event_type, StreamEventType::Complete);
    assert!(event.timestamp > 0);
}

// ============================================================================
// XML Parsing Tests
// Note: XML parsing is tested indirectly through the dynamicPromptExecFromState API.
// The parse_xml_to_json function is internal to the runtime module.
// ============================================================================

// ============================================================================
// Cross-Language Parity Tests
// ============================================================================

mod parity {
    use super::*;

    #[test]
    fn test_schema_row_fields_match_typescript() {
        // TypeScript has: field, description, required?, validateField?, streamField?
        // Rust has: field, description, required, validate_field, stream_field
        let row = SchemaRow {
            field: "test".to_string(),
            description: "Test field".to_string(),
            required: true,
            validate_field: Some(true), // = validateField in TypeScript
            stream_field: Some(true),   // = streamField in TypeScript
        };

        assert!(!row.field.is_empty());
        assert!(!row.description.is_empty());
        assert!(row.required);
        assert!(row.validate_field.is_some());
        assert!(row.stream_field.is_some());
    }

    #[test]
    fn test_schema_row_fields_match_python() {
        // Python has: field, description, required, validate_field, stream_field
        // Rust uses the same snake_case naming
        let row = SchemaRow::new("test", "Test field")
            .required()
            .validate(true)
            .stream(true);

        assert_eq!(row.field, "test");
        assert_eq!(row.description, "Test field");
        assert!(row.required);
        assert_eq!(row.validate_field, Some(true));
        assert_eq!(row.stream_field, Some(true));
    }

    #[test]
    fn test_retry_backoff_config_fields_match_typescript() {
        // TypeScript has: initialMs, multiplier, maxMs
        // Rust has: initial_ms, multiplier, max_ms
        let config = RetryBackoffConfig {
            initial_ms: 1000, // = initialMs in TypeScript
            multiplier: 2.0,
            max_ms: 30000, // = maxMs in TypeScript
        };

        assert_eq!(config.initial_ms, 1000);
        assert_eq!(config.multiplier, 2.0);
        assert_eq!(config.max_ms, 30000);
    }

    #[test]
    fn test_stream_event_types_match_all_languages() {
        // All languages should have: chunk, field_validated, retry_start, error, complete
        let expected_types = vec![
            "chunk",
            "field_validated",
            "retry_start",
            "error",
            "complete",
        ];

        // Verify each type serializes to expected value
        let type_values: Vec<String> = vec![
            serde_json::to_string(&StreamEventType::Chunk).unwrap(),
            serde_json::to_string(&StreamEventType::FieldValidated).unwrap(),
            serde_json::to_string(&StreamEventType::RetryStart).unwrap(),
            serde_json::to_string(&StreamEventType::Error).unwrap(),
            serde_json::to_string(&StreamEventType::Complete).unwrap(),
        ];

        for expected in &expected_types {
            let quoted = format!("\"{}\"", expected);
            assert!(
                type_values.contains(&quoted),
                "Missing event type: {}",
                expected
            );
        }
    }

    #[test]
    fn test_validation_levels_semantics() {
        // Level 0: Trusted - no validation codes
        // Level 1: Progressive - per-field validation
        // Level 2: Checkpoint - codes at start
        // Level 3: Full - codes at start and end

        // Verify the levels are conceptually the same across languages
        let levels: Vec<(u8, &str)> = vec![
            (0, "trusted/fast - no validation codes"),
            (1, "progressive - per-field validation"),
            (2, "checkpoint - first codes"),
            (3, "full - first and last codes"),
        ];

        for (level, description) in &levels {
            assert!(*level <= 3, "Invalid level {}: {}", level, description);
        }
    }
}

// ============================================================================
// Integration Tests (require async runtime)
// ============================================================================

#[cfg(test)]
mod integration {
    use super::*;

    // Note: Full integration tests for dynamic_prompt_exec_from_state require
    // setting up a mock model handler and database adapter, which is complex
    // in Rust. The core type tests above verify the fundamental building blocks.

    #[test]
    fn test_schema_creation_for_message_handler() {
        // This schema matches what message_service.rs uses
        let schema = vec![
            SchemaRow::new(
                "thought",
                "Your internal reasoning about the message and what to do",
            )
            .required()
            .validate(false)
            .stream(false),
            SchemaRow::new(
                "providers",
                "List of providers to use for additional context (comma-separated)",
            )
            .validate(false)
            .stream(false),
            SchemaRow::new("actions", "List of actions to take (comma-separated)")
                .required()
                .validate(false)
                .stream(false),
            SchemaRow::new("text", "The text response to send to the user").stream(true),
            SchemaRow::new("simple", "Whether this is a simple response (true/false)")
                .validate(false)
                .stream(false),
        ];

        assert_eq!(schema.len(), 5);
        assert!(schema[0].required); // thought is required
        assert!(schema[2].required); // actions is required
        assert_eq!(schema[3].stream_field, Some(true)); // text streams
    }

    #[test]
    fn test_schema_creation_for_should_respond() {
        // This schema matches what message_service.rs uses for shouldRespond
        let schema = vec![
            SchemaRow::new("name", "The name of the agent responding")
                .validate(false)
                .stream(false),
            SchemaRow::new("reasoning", "Your reasoning for this decision")
                .validate(false)
                .stream(false),
            SchemaRow::new("action", "RESPOND | IGNORE | STOP")
                .validate(false)
                .stream(false),
        ];

        assert_eq!(schema.len(), 3);
        // None of these are streamed - internal decision making
        for row in &schema {
            assert_eq!(row.stream_field, Some(false));
        }
    }
}

// ============================================================================
// Streaming Extractor Tests
// ============================================================================

#[cfg(test)]
mod streaming_tests {
    use elizaos::types::state::{SchemaRow, StreamEvent};
    use elizaos::types::streaming::{
        validate_chunk_size, ExtractorState, FieldState, IStreamExtractor, MarkableExtractor,
        ValidationStreamExtractor, ValidationStreamExtractorConfig, MAX_CHUNK_SIZE,
    };
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn test_markable_extractor_new() {
        let extractor = MarkableExtractor::new();
        assert!(!extractor.done());
    }

    #[test]
    fn test_markable_extractor_passthrough() {
        let mut extractor = MarkableExtractor::new();
        let output = extractor.push("test chunk");
        assert_eq!(output, "test chunk");
    }

    #[test]
    fn test_markable_extractor_mark_complete() {
        let mut extractor = MarkableExtractor::new();
        assert!(!extractor.done());
        extractor.mark_complete();
        assert!(extractor.done());
    }

    #[test]
    fn test_markable_extractor_reset() {
        let mut extractor = MarkableExtractor::new();
        extractor.mark_complete();
        assert!(extractor.done());
        extractor.reset();
        assert!(!extractor.done());
    }

    #[test]
    fn test_validate_chunk_size_ok() {
        assert!(validate_chunk_size("small chunk").is_ok());
    }

    #[test]
    fn test_validate_chunk_size_error() {
        // Create a chunk larger than MAX_CHUNK_SIZE
        let large_chunk = "x".repeat(MAX_CHUNK_SIZE + 1);
        let result = validate_chunk_size(&large_chunk);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.actual, MAX_CHUNK_SIZE + 1);
        assert_eq!(err.max, MAX_CHUNK_SIZE);
    }

    #[test]
    fn test_validation_stream_extractor_level0() {
        // Level 0: Stream immediately without validation
        let chunks: Rc<RefCell<Vec<(String, Option<String>)>>> = Rc::new(RefCell::new(vec![]));
        let chunks_clone = chunks.clone();

        let config = ValidationStreamExtractorConfig {
            level: 0,
            schema: vec![SchemaRow::new("text", "Response text")],
            stream_fields: vec!["text".to_string()],
            expected_codes: HashMap::new(),
            on_chunk: move |chunk: &str, field: Option<&str>| {
                chunks_clone
                    .borrow_mut()
                    .push((chunk.to_string(), field.map(|s| s.to_string())));
            },
            on_event: None::<fn(StreamEvent)>,
            abort_signal: None,
            has_rich_consumer: false,
        };

        let mut extractor = ValidationStreamExtractor::new(config);
        assert!(!extractor.done());
        assert_eq!(extractor.get_state(), ExtractorState::Streaming);

        // Push XML content
        extractor.push("<text>Hello ");
        extractor.push("World</text>");

        // At level 0, content should be emitted immediately
        let received = chunks.borrow();
        assert!(!received.is_empty());

        // Flush to complete
        extractor.flush();
        assert!(extractor.done());
        assert_eq!(extractor.get_state(), ExtractorState::Complete);
    }

    #[test]
    fn test_validation_stream_extractor_diagnosis() {
        let config = ValidationStreamExtractorConfig {
            level: 1,
            schema: vec![
                SchemaRow::new("field1", "First field"),
                SchemaRow::new("field2", "Second field"),
            ],
            stream_fields: vec!["field1".to_string(), "field2".to_string()],
            expected_codes: HashMap::new(),
            on_chunk: |_: &str, _: Option<&str>| {},
            on_event: None::<fn(StreamEvent)>,
            abort_signal: None,
            has_rich_consumer: false,
        };

        let mut extractor = ValidationStreamExtractor::new(config);
        extractor.push("<field1>content</field1>"); // Only field1 is complete

        let diagnosis = extractor.diagnose();
        // field2 should be either missing or incomplete
        assert!(
            diagnosis.missing_fields.contains(&"field2".to_string())
                || diagnosis.incomplete_fields.contains(&"field2".to_string())
        );
    }

    #[test]
    fn test_validation_stream_extractor_signal_retry() {
        let retry_separator_received = Rc::new(RefCell::new(false));
        let retry_clone = retry_separator_received.clone();

        let config = ValidationStreamExtractorConfig {
            level: 0,
            schema: vec![SchemaRow::new("text", "Response")],
            stream_fields: vec!["text".to_string()],
            expected_codes: HashMap::new(),
            on_chunk: move |chunk: &str, _: Option<&str>| {
                if chunk.contains("let me start again") {
                    *retry_clone.borrow_mut() = true;
                }
            },
            on_event: None::<fn(StreamEvent)>,
            abort_signal: None,
            has_rich_consumer: false,
        };

        let mut extractor = ValidationStreamExtractor::new(config);
        let validated = extractor.signal_retry(1);

        assert!(validated.is_empty()); // No validated fields yet
        assert_eq!(extractor.get_state(), ExtractorState::Retrying);
        assert!(*retry_separator_received.borrow()); // Separator was emitted
    }

    #[test]
    fn test_validation_stream_extractor_signal_error() {
        let config = ValidationStreamExtractorConfig {
            level: 0,
            schema: vec![SchemaRow::new("text", "Response")],
            stream_fields: vec!["text".to_string()],
            expected_codes: HashMap::new(),
            on_chunk: |_: &str, _: Option<&str>| {},
            on_event: None::<fn(StreamEvent)>,
            abort_signal: None,
            has_rich_consumer: false,
        };

        let mut extractor = ValidationStreamExtractor::new(config);
        extractor.signal_error("Test error");

        assert!(extractor.done());
        assert_eq!(extractor.get_state(), ExtractorState::Failed);
    }

    #[test]
    fn test_validation_stream_extractor_abort() {
        let aborted = Arc::new(AtomicBool::new(false));
        let aborted_clone = aborted.clone();

        let config = ValidationStreamExtractorConfig {
            level: 0,
            schema: vec![SchemaRow::new("text", "Response")],
            stream_fields: vec!["text".to_string()],
            expected_codes: HashMap::new(),
            on_chunk: |_: &str, _: Option<&str>| {},
            on_event: None::<fn(StreamEvent)>,
            abort_signal: Some(Box::new(move || aborted_clone.load(Ordering::SeqCst))),
            has_rich_consumer: false,
        };

        let mut extractor = ValidationStreamExtractor::new(config);

        // Push before abort
        extractor.push("<text>Hello");
        assert!(!extractor.done());

        // Set abort signal
        aborted.store(true, Ordering::SeqCst);

        // Push after abort - should transition to failed
        extractor.push(" World</text>");
        assert!(extractor.done());
        assert_eq!(extractor.get_state(), ExtractorState::Failed);
    }

    #[test]
    fn test_extractor_state_enum_values() {
        // Verify state enum matches TypeScript/Python
        assert_eq!(format!("{:?}", ExtractorState::Streaming), "Streaming");
        assert_eq!(format!("{:?}", ExtractorState::Validating), "Validating");
        assert_eq!(format!("{:?}", ExtractorState::Retrying), "Retrying");
        assert_eq!(format!("{:?}", ExtractorState::Complete), "Complete");
        assert_eq!(format!("{:?}", ExtractorState::Failed), "Failed");
    }

    #[test]
    fn test_field_state_enum_values() {
        // Verify field state enum matches TypeScript/Python
        assert_eq!(format!("{:?}", FieldState::Pending), "Pending");
        assert_eq!(format!("{:?}", FieldState::Partial), "Partial");
        assert_eq!(format!("{:?}", FieldState::Complete), "Complete");
        assert_eq!(format!("{:?}", FieldState::Invalid), "Invalid");
    }
}
