//! Integration tests for the experience plugin.
//!
//! All tests are in-memory and require no credentials.

use elizaos_plugin_experience::{
    build_extract_experiences_prompt, detect_domain, sanitize_context, ExperienceEvaluator,
    ExperienceInput, ExperienceProvider, ExperienceQuery, ExperienceService, ExperienceType,
    OutcomeType, RecordExperienceAction, TimeRange,
};

// ---------------------------------------------------------------------------
// Service CRUD
// ---------------------------------------------------------------------------

#[test]
fn service_record_and_retrieve_by_query() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    let input = ExperienceInput::new(
        "debugging a failing build".to_string(),
        "run tests".to_string(),
        "fixed missing dependency".to_string(),
        "Install dependencies before running Python scripts".to_string(),
    )
    .with_type(ExperienceType::Learning)
    .with_domain("coding".to_string())
    .with_confidence(0.9)
    .with_importance(0.8);

    let exp = svc.record_experience("agent-1", input, now);

    let results = svc.query_experiences(
        &ExperienceQuery {
            query: Some("install python dependencies".to_string()),
            limit: Some(5),
            ..Default::default()
        },
        now + 1,
    );

    assert!(results.iter().any(|e| e.id == exp.id));
}

#[test]
fn service_query_by_type() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    // Record a LEARNING
    svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "ctx".to_string(),
            "act".to_string(),
            "res".to_string(),
            "learning one".to_string(),
        )
        .with_type(ExperienceType::Learning),
        now,
    );

    // Record a DISCOVERY
    svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "ctx".to_string(),
            "act".to_string(),
            "res".to_string(),
            "discovery one".to_string(),
        )
        .with_type(ExperienceType::Discovery),
        now + 1,
    );

    let results = svc.query_experiences(
        &ExperienceQuery {
            types: Some(vec![ExperienceType::Discovery]),
            limit: Some(10),
            ..Default::default()
        },
        now + 2,
    );

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].experience_type, ExperienceType::Discovery);
}

#[test]
fn service_query_by_domain() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "ctx".to_string(),
            "act".to_string(),
            "res".to_string(),
            "shell learning".to_string(),
        )
        .with_domain("shell".to_string()),
        now,
    );

    svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "ctx".to_string(),
            "act".to_string(),
            "res".to_string(),
            "coding learning".to_string(),
        )
        .with_domain("coding".to_string()),
        now + 1,
    );

    let results = svc.query_experiences(
        &ExperienceQuery {
            domains: Some(vec!["coding".to_string()]),
            limit: Some(10),
            ..Default::default()
        },
        now + 2,
    );

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].domain, "coding");
}

#[test]
fn service_query_by_tags() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "ctx".to_string(),
            "act".to_string(),
            "res".to_string(),
            "tagged thing".to_string(),
        )
        .with_tags(vec!["important".to_string(), "novel".to_string()]),
        now,
    );

    svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "ctx".to_string(),
            "act".to_string(),
            "res".to_string(),
            "untagged thing".to_string(),
        ),
        now + 1,
    );

    let results = svc.query_experiences(
        &ExperienceQuery {
            tags: Some(vec!["important".to_string()]),
            limit: Some(10),
            ..Default::default()
        },
        now + 2,
    );

    assert_eq!(results.len(), 1);
    assert!(results[0].tags.contains(&"important".to_string()));
}

#[test]
fn service_query_by_confidence_and_importance() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "ctx".to_string(),
            "act".to_string(),
            "res".to_string(),
            "high confidence".to_string(),
        )
        .with_confidence(0.9)
        .with_importance(0.9),
        now,
    );

    svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "ctx".to_string(),
            "act".to_string(),
            "res".to_string(),
            "low confidence".to_string(),
        )
        .with_confidence(0.3)
        .with_importance(0.3),
        now + 1,
    );

    let results = svc.query_experiences(
        &ExperienceQuery {
            min_confidence: Some(0.7),
            min_importance: Some(0.7),
            limit: Some(10),
            ..Default::default()
        },
        now + 2,
    );

    assert_eq!(results.len(), 1);
    assert!(results[0].confidence >= 0.7);
    assert!(results[0].importance >= 0.7);
}

#[test]
fn service_query_by_time_range() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "ctx".to_string(),
            "act".to_string(),
            "res".to_string(),
            "old experience".to_string(),
        ),
        now - 100_000,
    );

    svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "ctx".to_string(),
            "act".to_string(),
            "res".to_string(),
            "recent experience".to_string(),
        ),
        now,
    );

    let results = svc.query_experiences(
        &ExperienceQuery {
            time_range: Some(TimeRange {
                start: Some(now - 50_000),
                end: None,
            }),
            limit: Some(10),
            ..Default::default()
        },
        now + 1,
    );

    assert_eq!(results.len(), 1);
    assert!(results[0].created_at >= now - 50_000);
}

#[test]
fn service_query_by_outcome() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "ctx".to_string(),
            "act".to_string(),
            "res".to_string(),
            "positive".to_string(),
        )
        .with_outcome(OutcomeType::Positive),
        now,
    );

    svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "ctx".to_string(),
            "act".to_string(),
            "res".to_string(),
            "negative".to_string(),
        )
        .with_outcome(OutcomeType::Negative),
        now + 1,
    );

    let results = svc.query_experiences(
        &ExperienceQuery {
            outcomes: Some(vec![OutcomeType::Positive]),
            limit: Some(10),
            ..Default::default()
        },
        now + 2,
    );

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].outcome, OutcomeType::Positive);
}

// ---------------------------------------------------------------------------
// Similarity search
// ---------------------------------------------------------------------------

#[test]
fn service_similarity_search_ranks_relevant_higher() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    // Record a coding experience
    svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "debugging build failure".to_string(),
            "install packages".to_string(),
            "build succeeded after installing deps".to_string(),
            "Always install dependencies before building Python projects".to_string(),
        )
        .with_domain("coding".to_string())
        .with_confidence(0.9)
        .with_importance(0.8),
        now,
    );

    // Record an unrelated experience
    svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "weather discussion".to_string(),
            "check weather".to_string(),
            "sunny day".to_string(),
            "Weather patterns are unpredictable".to_string(),
        )
        .with_domain("general".to_string())
        .with_confidence(0.5)
        .with_importance(0.3),
        now + 1,
    );

    let results = svc.query_experiences(
        &ExperienceQuery {
            query: Some("install python dependencies for build".to_string()),
            limit: Some(5),
            ..Default::default()
        },
        now + 2,
    );

    assert!(!results.is_empty());
    // The coding experience should rank first
    assert_eq!(results[0].domain, "coding");
    assert!(results[0].learning.contains("dependencies"));
}

#[test]
fn service_similarity_search_empty_query() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "ctx".to_string(),
            "act".to_string(),
            "res".to_string(),
            "learning".to_string(),
        ),
        now,
    );

    // With no text query, should still return experiences (sorted by score)
    let results = svc.query_experiences(
        &ExperienceQuery {
            limit: Some(5),
            ..Default::default()
        },
        now + 1,
    );

    assert_eq!(results.len(), 1);
}

// ---------------------------------------------------------------------------
// Service pruning
// ---------------------------------------------------------------------------

#[test]
fn service_prunes_when_exceeding_max() {
    let mut svc = ExperienceService::new(3);
    let now = 1_700_000_000_000i64;

    for i in 0..5 {
        svc.record_experience(
            "agent-1",
            ExperienceInput::new(
                format!("ctx-{i}"),
                format!("act-{i}"),
                format!("res-{i}"),
                format!("learning-{i}"),
            )
            .with_importance(i as f64 / 10.0),
            now + i as i64,
        );
    }

    let results = svc.query_experiences(
        &ExperienceQuery {
            limit: Some(100),
            ..Default::default()
        },
        now + 10,
    );

    assert!(results.len() <= 3, "Should have pruned to max 3");
}

// ---------------------------------------------------------------------------
// Access count tracking
// ---------------------------------------------------------------------------

#[test]
fn service_updates_access_count_on_query() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    let exp = svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "ctx".to_string(),
            "act".to_string(),
            "res".to_string(),
            "learning".to_string(),
        )
        .with_confidence(0.9)
        .with_importance(0.9),
        now,
    );

    assert_eq!(exp.access_count, 0);

    let results = svc.query_experiences(
        &ExperienceQuery {
            limit: Some(10),
            ..Default::default()
        },
        now + 1,
    );

    assert_eq!(results[0].access_count, 1);

    // Query again
    let results = svc.query_experiences(
        &ExperienceQuery {
            limit: Some(10),
            ..Default::default()
        },
        now + 2,
    );

    assert_eq!(results[0].access_count, 2);
}

// ---------------------------------------------------------------------------
// Related experiences
// ---------------------------------------------------------------------------

#[test]
fn service_include_related_experiences() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    // Record two experiences that are related
    let exp_a = svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "ctx-a".to_string(),
            "act-a".to_string(),
            "res-a".to_string(),
            "learning-a unique-token-a".to_string(),
        )
        .with_confidence(0.9)
        .with_importance(0.9),
        now,
    );

    // This experience has very different content (won't match similarity search for "unique-token-a")
    let exp_b = svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "ctx-b".to_string(),
            "act-b".to_string(),
            "res-b".to_string(),
            "learning-b completely-different-words".to_string(),
        )
        .with_confidence(0.5)
        .with_importance(0.5),
        now + 1,
    );

    // Query with include_related (without text query, both should appear based on scoring)
    let results = svc.query_experiences(
        &ExperienceQuery {
            include_related: Some(true),
            limit: Some(10),
            ..Default::default()
        },
        now + 2,
    );

    let ids: Vec<&str> = results.iter().map(|e| e.id.as_str()).collect();
    assert!(ids.contains(&exp_a.id.as_str()));
    assert!(ids.contains(&exp_b.id.as_str()));
}

// ---------------------------------------------------------------------------
// Action tests
// ---------------------------------------------------------------------------

#[test]
fn action_validate_triggers_on_keywords() {
    assert!(RecordExperienceAction::validate("Please remember this"));
    assert!(RecordExperienceAction::validate("Record this learning"));
    assert!(RecordExperienceAction::validate("NOTE this for later"));
    assert!(RecordExperienceAction::validate(
        "Can you remember that Python needs deps?"
    ));
}

#[test]
fn action_validate_rejects_unrelated() {
    assert!(!RecordExperienceAction::validate("What is 2+2?"));
    assert!(!RecordExperienceAction::validate("Hello world"));
    assert!(!RecordExperienceAction::validate(""));
    assert!(!RecordExperienceAction::validate(
        "Tell me about experience design"
    ));
}

#[test]
fn action_handler_stores_experience() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    let exp = RecordExperienceAction::handler(
        &mut svc,
        "agent-1",
        "Installing dependencies is required before running Python scripts",
        now,
    );

    assert_eq!(exp.agent_id, "agent-1");
    assert_eq!(
        exp.learning,
        "Installing dependencies is required before running Python scripts"
    );
    assert_eq!(exp.domain, "general");
    assert!(exp.tags.contains(&"manual".to_string()));
    assert!((exp.confidence - 0.9).abs() < f64::EPSILON);
    assert!((exp.importance - 0.6).abs() < f64::EPSILON);
    assert_eq!(exp.experience_type, ExperienceType::Learning);

    // Verify it's queryable
    let results = svc.query_experiences(
        &ExperienceQuery {
            query: Some("dependencies python".to_string()),
            limit: Some(5),
            ..Default::default()
        },
        now + 1,
    );
    assert!(results.iter().any(|e| e.id == exp.id));
}

#[test]
fn action_constants() {
    assert_eq!(RecordExperienceAction::NAME, "RECORD_EXPERIENCE");
    assert!(!RecordExperienceAction::SIMILES.is_empty());
    assert!(RecordExperienceAction::SIMILES.contains(&"REMEMBER"));
    assert!(!RecordExperienceAction::DESCRIPTION.is_empty());
}

// ---------------------------------------------------------------------------
// Provider tests
// ---------------------------------------------------------------------------

#[test]
fn provider_empty_for_short_messages() {
    let mut svc = ExperienceService::new(100);
    let result = ExperienceProvider::get(&mut svc, "hi", 1_700_000_000_000);
    assert!(result.text.is_empty());
    assert_eq!(result.experience_count, 0);
}

#[test]
fn provider_empty_when_no_matching_experiences() {
    let mut svc = ExperienceService::new(100);
    let result = ExperienceProvider::get(
        &mut svc,
        "How do I install dependencies for Python scripts?",
        1_700_000_000_000,
    );
    assert!(result.text.is_empty());
    assert_eq!(result.experience_count, 0);
}

#[test]
fn provider_returns_formatted_text() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    svc.record_experience(
        "agent-1",
        ExperienceInput::new(
            "debugging build".to_string(),
            "install packages".to_string(),
            "build succeeded".to_string(),
            "Install dependencies before running Python scripts".to_string(),
        )
        .with_domain("coding".to_string())
        .with_confidence(0.9)
        .with_importance(0.8),
        now,
    );

    let result = ExperienceProvider::get(
        &mut svc,
        "How do I install dependencies for Python scripts?",
        now + 1,
    );

    assert!(result.experience_count > 0);
    assert!(result.text.starts_with("[RELEVANT EXPERIENCES]"));
    assert!(result.text.ends_with("[/RELEVANT EXPERIENCES]"));
    assert!(result.text.contains("Experience 1:"));
    assert!(result.text.contains("In coding context"));
    assert!(result.text.contains("Install dependencies"));
}

#[test]
fn provider_constants() {
    assert_eq!(ExperienceProvider::NAME, "experienceProvider");
    assert!(!ExperienceProvider::DESCRIPTION.is_empty());
}

// ---------------------------------------------------------------------------
// Evaluator parse tests
// ---------------------------------------------------------------------------

#[test]
fn evaluator_parse_valid_json_array() {
    let response = r#"[{"type": "DISCOVERY", "learning": "jq is available", "context": "system check", "confidence": 0.85, "reasoning": "novel tool"}]"#;
    let exps = ExperienceEvaluator::parse_extracted_experiences(response);
    assert_eq!(exps.len(), 1);
    assert_eq!(exps[0].experience_type.as_deref(), Some("DISCOVERY"));
    assert_eq!(exps[0].learning.as_deref(), Some("jq is available"));
    assert!((exps[0].confidence.unwrap() - 0.85).abs() < f64::EPSILON);
}

#[test]
fn evaluator_parse_json_with_surrounding_text() {
    let response =
        r#"Here are some experiences:\n[{"type":"LEARNING","learning":"test","confidence":0.9}]\nDone!"#;
    let exps = ExperienceEvaluator::parse_extracted_experiences(response);
    assert_eq!(exps.len(), 1);
}

#[test]
fn evaluator_parse_empty_array() {
    let exps = ExperienceEvaluator::parse_extracted_experiences("[]");
    assert!(exps.is_empty());
}

#[test]
fn evaluator_parse_no_json() {
    let exps = ExperienceEvaluator::parse_extracted_experiences("No experiences found.");
    assert!(exps.is_empty());
}

#[test]
fn evaluator_parse_malformed_json() {
    let exps = ExperienceEvaluator::parse_extracted_experiences("[{broken}]");
    assert!(exps.is_empty());
}

#[test]
fn evaluator_parse_multiple() {
    let response = r#"[
        {"type": "LEARNING", "learning": "one", "confidence": 0.9},
        {"type": "CORRECTION", "learning": "two", "confidence": 0.7},
        {"type": "SUCCESS", "learning": "three", "confidence": 0.8}
    ]"#;
    let exps = ExperienceEvaluator::parse_extracted_experiences(response);
    assert_eq!(exps.len(), 3);
}

#[test]
fn evaluator_constants() {
    assert_eq!(ExperienceEvaluator::NAME, "EXPERIENCE_EVALUATOR");
    assert!(!ExperienceEvaluator::DESCRIPTION.is_empty());
}

// ---------------------------------------------------------------------------
// Evaluator handler (async)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn evaluator_handler_records_from_llm_response() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    let mock_response = r#"[{"type": "DISCOVERY", "learning": "jq is available for JSON processing", "context": "system check", "confidence": 0.85}]"#.to_string();

    let count = ExperienceEvaluator::handler(
        &mut svc,
        |_prompt| async { mock_response },
        "agent-1",
        "Found that jq is installed on the system for JSON",
        0.7,
        now,
    )
    .await;

    assert_eq!(count, 1);

    // Verify it was stored
    let results = svc.query_experiences(
        &ExperienceQuery {
            query: Some("jq JSON processing".to_string()),
            limit: Some(5),
            ..Default::default()
        },
        now + 1,
    );
    assert!(!results.is_empty());
    assert!(results[0].tags.contains(&"extracted".to_string()));
}

#[tokio::test]
async fn evaluator_handler_skips_below_threshold() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    let mock_response =
        r#"[{"type": "LEARNING", "learning": "low quality", "confidence": 0.3}]"#.to_string();

    let count = ExperienceEvaluator::handler(
        &mut svc,
        |_prompt| async { mock_response },
        "agent-1",
        "some conversation",
        0.7, // threshold is 0.7
        now,
    )
    .await;

    assert_eq!(count, 0);
}

#[tokio::test]
async fn evaluator_handler_caps_at_three() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    let mock_response = r#"[
        {"type": "LEARNING", "learning": "a", "confidence": 0.9},
        {"type": "LEARNING", "learning": "b", "confidence": 0.9},
        {"type": "LEARNING", "learning": "c", "confidence": 0.9},
        {"type": "LEARNING", "learning": "d", "confidence": 0.9},
        {"type": "LEARNING", "learning": "e", "confidence": 0.9}
    ]"#
    .to_string();

    let count = ExperienceEvaluator::handler(
        &mut svc,
        |_prompt| async { mock_response },
        "agent-1",
        "lots of things",
        0.5,
        now,
    )
    .await;

    assert_eq!(count, 3);
}

#[tokio::test]
async fn evaluator_handler_builds_prompt_with_context() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;
    let mut captured_prompt = String::new();

    let _ = ExperienceEvaluator::handler(
        &mut svc,
        |prompt| {
            captured_prompt = prompt;
            async { "[]".to_string() }
        },
        "agent-1",
        "The system has jq installed",
        0.7,
        now,
    )
    .await;

    assert!(captured_prompt.contains("The system has jq installed"));
    assert!(!captured_prompt.contains("{{conversation_context}}"));
    assert!(!captured_prompt.contains("{{existing_experiences}}"));
}

// ---------------------------------------------------------------------------
// Sanitize context
// ---------------------------------------------------------------------------

#[test]
fn sanitize_context_removes_emails() {
    let result = sanitize_context("Contact user@example.com for details");
    assert!(result.contains("[EMAIL]"));
    assert!(!result.contains("user@example.com"));
}

#[test]
fn sanitize_context_removes_ips() {
    let result = sanitize_context("Server at 192.168.1.100 is down");
    assert!(result.contains("[IP]"));
    assert!(!result.contains("192.168.1.100"));
}

#[test]
fn sanitize_context_removes_user_paths() {
    let result = sanitize_context("Found at /Users/john/project/main.rs");
    assert!(result.contains("/Users/[USER]"));
    assert!(!result.contains("/Users/john"));
}

#[test]
fn sanitize_context_removes_home_paths() {
    let result = sanitize_context("Config at /home/alice/.config/app.toml");
    assert!(result.contains("/home/[USER]"));
    assert!(!result.contains("/home/alice"));
}

#[test]
fn sanitize_context_removes_tokens() {
    let result = sanitize_context("Key ABCDEFGHIJKLMNOPQRSTUVWXYZ123 here");
    assert!(result.contains("[TOKEN]"));
    assert!(!result.contains("ABCDEFGHIJKLMNOPQRSTUVWXYZ123"));
}

#[test]
fn sanitize_context_truncates_long_text() {
    let long_text = "a".repeat(300);
    let result = sanitize_context(&long_text);
    assert!(result.len() <= 200);
}

#[test]
fn sanitize_context_empty_returns_default() {
    assert_eq!(sanitize_context(""), "Unknown context");
}

#[test]
fn sanitize_context_preserves_normal_text() {
    let text = "Installed the package successfully";
    assert_eq!(sanitize_context(text), text);
}

// ---------------------------------------------------------------------------
// Detect domain
// ---------------------------------------------------------------------------

#[test]
fn detect_domain_identifies_coding() {
    assert_eq!(detect_domain("Fix the function syntax error"), "coding");
    assert_eq!(detect_domain("Debug the Python code"), "coding");
}

#[test]
fn detect_domain_identifies_shell() {
    assert_eq!(detect_domain("Execute the bash command"), "shell");
    assert_eq!(detect_domain("Run the CLI script"), "shell");
}

#[test]
fn detect_domain_identifies_network() {
    assert_eq!(detect_domain("The API request returned 404"), "network");
    assert_eq!(detect_domain("Fetch data from the URL"), "network");
}

#[test]
fn detect_domain_identifies_data() {
    assert_eq!(detect_domain("Load the JSON data"), "data");
    assert_eq!(detect_domain("Query the SQL database"), "data");
}

#[test]
fn detect_domain_identifies_system() {
    assert_eq!(detect_domain("Install the package globally"), "system");
    assert_eq!(detect_domain("Check the file directory"), "system");
}

#[test]
fn detect_domain_identifies_ai() {
    assert_eq!(detect_domain("The LLM model hallucinates"), "ai");
    assert_eq!(detect_domain("Generate an embedding vector"), "ai");
}

#[test]
fn detect_domain_falls_back_to_general() {
    assert_eq!(detect_domain("The weather is nice today"), "general");
    assert_eq!(detect_domain("Hello world"), "general");
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

#[test]
fn prompt_builder_substitutes_placeholders() {
    let prompt = build_extract_experiences_prompt("my conversation", "existing stuff");
    assert!(prompt.contains("my conversation"));
    assert!(prompt.contains("existing stuff"));
    assert!(!prompt.contains("{{conversation_context}}"));
    assert!(!prompt.contains("{{existing_experiences}}"));
}

// ---------------------------------------------------------------------------
// Type serialization
// ---------------------------------------------------------------------------

#[test]
fn experience_type_serde_roundtrip() {
    let json = serde_json::to_string(&ExperienceType::Discovery).unwrap();
    assert_eq!(json, "\"discovery\"");
    let deserialized: ExperienceType = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized, ExperienceType::Discovery);
}

#[test]
fn outcome_type_serde_roundtrip() {
    let json = serde_json::to_string(&OutcomeType::Positive).unwrap();
    assert_eq!(json, "\"positive\"");
    let deserialized: OutcomeType = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized, OutcomeType::Positive);
}

#[test]
fn experience_query_default() {
    let q = ExperienceQuery::default();
    assert!(q.query.is_none());
    assert!(q.types.is_none());
    assert!(q.limit.is_none());
}

// ---------------------------------------------------------------------------
// Full pipeline: action → service → provider
// ---------------------------------------------------------------------------

#[test]
fn full_pipeline_action_to_provider() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    // Step 1: Record via action
    let exp = RecordExperienceAction::handler(
        &mut svc,
        "agent-1",
        "Install dependencies before running Python scripts",
        now,
    );

    assert!(!exp.id.is_empty());

    // Step 2: Query via provider
    let result = ExperienceProvider::get(
        &mut svc,
        "How to install python dependencies for scripts?",
        now + 1,
    );

    assert!(result.experience_count > 0);
    assert!(result.text.contains("Install dependencies"));
    assert!(result.text.contains("[RELEVANT EXPERIENCES]"));
}

#[tokio::test]
async fn full_pipeline_evaluator_to_provider() {
    let mut svc = ExperienceService::new(100);
    let now = 1_700_000_000_000i64;

    // Step 1: Extract via evaluator
    let mock_response = r#"[{"type": "DISCOVERY", "learning": "jq is available for JSON processing on this system", "context": "system exploration", "confidence": 0.85}]"#.to_string();

    let count = ExperienceEvaluator::handler(
        &mut svc,
        |_prompt| async { mock_response },
        "agent-1",
        "Found jq installed for JSON processing",
        0.7,
        now,
    )
    .await;

    assert_eq!(count, 1);

    // Step 2: Retrieve via provider
    let result = ExperienceProvider::get(
        &mut svc,
        "What tools are available for JSON processing?",
        now + 1,
    );

    assert!(result.experience_count > 0);
    assert!(result.text.contains("jq"));
}
