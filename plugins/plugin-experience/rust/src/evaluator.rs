//! Experience evaluator for extracting learnings from conversation context.

use crate::prompts::build_extract_experiences_prompt;
use crate::service::{ExperienceInput, ExperienceService};
use crate::types::{ExperienceQuery, ExperienceType, OutcomeType};
use std::future::Future;

/// An experience extracted from an LLM response.
#[derive(Debug, Clone)]
pub struct ExtractedExperience {
    /// Type of experience (DISCOVERY, CORRECTION, SUCCESS, LEARNING).
    pub experience_type: Option<String>,
    /// What was learned.
    pub learning: Option<String>,
    /// Context in which the learning occurred.
    pub context: Option<String>,
    /// Confidence level (0-1).
    pub confidence: Option<f64>,
    /// Reasoning for why this is novel.
    pub reasoning: Option<String>,
}

/// Evaluator that extracts learning experiences from conversation context.
///
/// Matches the TypeScript `experienceEvaluator` and Python `ExperienceEvaluator`.
pub struct ExperienceEvaluator;

impl ExperienceEvaluator {
    /// Evaluator name.
    pub const NAME: &'static str = "EXPERIENCE_EVALUATOR";

    /// Human-readable description.
    pub const DESCRIPTION: &'static str =
        "Periodically analyzes conversation patterns to extract novel learning experiences";

    /// Parse extracted experiences from an LLM JSON response.
    ///
    /// Expects a JSON array within the response text. Returns an empty vec
    /// if no valid JSON array is found or if parsing fails.
    pub fn parse_extracted_experiences(response: &str) -> Vec<ExtractedExperience> {
        let start = match response.find('[') {
            Some(i) => i,
            None => return Vec::new(),
        };
        let end = match response.rfind(']') {
            Some(i) => i + 1,
            None => return Vec::new(),
        };

        if end <= start {
            return Vec::new();
        }

        let json_str = &response[start..end];
        let parsed: serde_json::Value = match serde_json::from_str(json_str) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };

        let arr = match parsed.as_array() {
            Some(a) => a,
            None => return Vec::new(),
        };

        arr.iter()
            .filter_map(|item| {
                let obj = item.as_object()?;
                Some(ExtractedExperience {
                    experience_type: obj.get("type").and_then(|v| v.as_str()).map(String::from),
                    learning: obj.get("learning").and_then(|v| v.as_str()).map(String::from),
                    context: obj.get("context").and_then(|v| v.as_str()).map(String::from),
                    confidence: obj.get("confidence").and_then(|v| v.as_f64()),
                    reasoning: obj.get("reasoning").and_then(|v| v.as_str()).map(String::from),
                })
            })
            .collect()
    }

    /// Run the evaluator: use an LLM to extract novel experiences from conversation
    /// and record them in the service.
    ///
    /// `model_fn` is called with the extraction prompt and should return the LLM response text.
    /// At most 3 experiences are recorded per invocation.
    /// Returns the number of experiences recorded.
    pub async fn handler<F, Fut>(
        service: &mut ExperienceService,
        model_fn: F,
        agent_id: &str,
        conversation_context: &str,
        threshold: f64,
        now_ms: i64,
    ) -> usize
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = String>,
    {
        // Query existing experiences for deduplication
        let existing = service.query_experiences(
            &ExperienceQuery {
                query: Some(conversation_context.to_string()),
                limit: Some(10),
                min_confidence: Some(0.7),
                ..Default::default()
            },
            now_ms,
        );

        let existing_text = if existing.is_empty() {
            "None".to_string()
        } else {
            existing
                .iter()
                .map(|e| format!("- {}", e.learning))
                .collect::<Vec<_>>()
                .join("\n")
        };

        let prompt = build_extract_experiences_prompt(conversation_context, &existing_text);
        let response = model_fn(prompt).await;
        let extracted = Self::parse_extracted_experiences(&response);

        let type_map: &[(&str, ExperienceType)] = &[
            ("DISCOVERY", ExperienceType::Discovery),
            ("CORRECTION", ExperienceType::Correction),
            ("SUCCESS", ExperienceType::Success),
            ("LEARNING", ExperienceType::Learning),
        ];

        let mut recorded = 0usize;
        for exp in extracted.iter().take(3) {
            let learning = match &exp.learning {
                Some(l) if !l.is_empty() => l.clone(),
                _ => continue,
            };
            let confidence = match exp.confidence {
                Some(c) if c >= threshold => c,
                _ => continue,
            };

            let normalized_type = exp
                .experience_type
                .as_deref()
                .unwrap_or("")
                .to_uppercase();

            let experience_type = type_map
                .iter()
                .find(|(k, _)| *k == normalized_type)
                .map(|(_, v)| *v)
                .unwrap_or(ExperienceType::Learning);

            let outcome = if experience_type == ExperienceType::Correction {
                OutcomeType::Positive
            } else {
                OutcomeType::Neutral
            };

            let context_text =
                sanitize_context(exp.context.as_deref().unwrap_or("Conversation analysis"));

            let domain = detect_domain(&learning);

            // Get lowercase type string matching serde serialization
            let tag_value = serde_json::to_value(experience_type)
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| "learning".to_string());

            let input = ExperienceInput::new(
                context_text,
                "pattern_recognition".to_string(),
                learning.clone(),
                sanitize_context(&learning),
            )
            .with_type(experience_type)
            .with_outcome(outcome)
            .with_domain(domain)
            .with_tags(vec![
                "extracted".to_string(),
                "novel".to_string(),
                tag_value,
            ])
            .with_confidence(confidence.min(0.9))
            .with_importance(0.8);

            service.record_experience(agent_id, input, now_ms);
            recorded += 1;
        }

        recorded
    }
}

/// Sanitize text by removing user-specific details.
///
/// Redacts email addresses, IP addresses, user directory paths, and long API tokens.
/// Truncates to 200 characters.
pub fn sanitize_context(text: &str) -> String {
    if text.is_empty() {
        return "Unknown context".to_string();
    }

    let mut result = text.to_string();

    // Remove email addresses
    result = redact_emails(&result);

    // Remove IP addresses
    result = redact_ip_addresses(&result);

    // Remove user directory paths
    result = redact_user_paths(&result);

    // Remove long uppercase alphanumeric tokens (API keys, etc.)
    result = redact_tokens(&result);

    // Truncate to 200 characters (respecting char boundaries)
    if result.len() > 200 {
        let mut end = 200;
        while end < result.len() && !result.is_char_boundary(end) {
            end += 1;
        }
        result.truncate(end.min(result.len()));
    }

    result
}

fn redact_emails(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        if chars[i] == '@' && i > 0 {
            // Find start of email (go back to find word boundary in result)
            let start = result
                .rfind(|c: char| {
                    !c.is_ascii_alphanumeric() && c != '.' && c != '_' && c != '%' && c != '+'
                        && c != '-'
                })
                .map(|p| p + 1)
                .unwrap_or(0);

            // Find end of email (go forward past domain)
            let mut end = i + 1;
            while end < chars.len()
                && (chars[end].is_ascii_alphanumeric() || chars[end] == '.' || chars[end] == '-')
            {
                end += 1;
            }

            // Validate that it looks like an email (chars before @ and domain after)
            if start < result.len() && end > i + 1 {
                result.truncate(start);
                result.push_str("[EMAIL]");
                i = end;
                continue;
            }
        }
        result.push(chars[i]);
        i += 1;
    }

    result
}

fn redact_ip_addresses(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        if chars[i].is_ascii_digit() {
            // Check word boundary before
            let before_ok = i == 0 || !chars[i - 1].is_ascii_alphanumeric();
            if before_ok {
                if let Some(end) = try_parse_ip(&chars, i) {
                    // Check word boundary after
                    let after_ok = end >= chars.len() || !chars[end].is_ascii_alphanumeric();
                    if after_ok {
                        result.push_str("[IP]");
                        i = end;
                        continue;
                    }
                }
            }
        }
        result.push(chars[i]);
        i += 1;
    }

    result
}

fn try_parse_ip(chars: &[char], start: usize) -> Option<usize> {
    let mut pos = start;

    for octet in 0..4u8 {
        if octet > 0 {
            if pos >= chars.len() || chars[pos] != '.' {
                return None;
            }
            pos += 1;
        }

        let digit_start = pos;
        while pos < chars.len() && chars[pos].is_ascii_digit() {
            pos += 1;
        }
        let digit_count = pos - digit_start;
        if digit_count == 0 || digit_count > 3 {
            return None;
        }

        let num_str: String = chars[digit_start..pos].iter().collect();
        match num_str.parse::<u32>() {
            Ok(n) if n <= 255 => {}
            _ => return None,
        }
    }

    Some(pos)
}

fn redact_user_paths(text: &str) -> String {
    let mut result = text.to_string();

    // Redact /Users/<username> paths
    loop {
        let idx = match result.find("/Users/") {
            Some(i) => i,
            None => break,
        };
        let after = idx + 7; // len of "/Users/"
        if after >= result.len() {
            break;
        }

        let username_end = result[after..]
            .find(|c: char| c == '/' || c.is_whitespace())
            .map(|p| after + p)
            .unwrap_or(result.len());

        let username = &result[after..username_end];
        if username == "[USER]" || username.is_empty() {
            break; // Already redacted or empty
        }

        result = format!(
            "{}/Users/[USER]{}",
            &result[..idx],
            &result[username_end..]
        );
    }

    // Redact /home/<username> paths
    loop {
        let idx = match result.find("/home/") {
            Some(i) => i,
            None => break,
        };
        let after = idx + 6; // len of "/home/"
        if after >= result.len() {
            break;
        }

        let username_end = result[after..]
            .find(|c: char| c == '/' || c.is_whitespace())
            .map(|p| after + p)
            .unwrap_or(result.len());

        let username = &result[after..username_end];
        if username == "[USER]" || username.is_empty() {
            break;
        }

        result = format!(
            "{}/home/[USER]{}",
            &result[..idx],
            &result[username_end..]
        );
    }

    result
}

fn redact_tokens(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut current_token = String::new();
    let mut all_upper_or_digit = true;

    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            if !(ch.is_ascii_uppercase() || ch.is_ascii_digit()) {
                all_upper_or_digit = false;
            }
            current_token.push(ch);
        } else {
            if current_token.len() >= 20 && all_upper_or_digit {
                result.push_str("[TOKEN]");
            } else {
                result.push_str(&current_token);
            }
            current_token.clear();
            all_upper_or_digit = true;
            result.push(ch);
        }
    }

    // Handle trailing token
    if current_token.len() >= 20 && all_upper_or_digit {
        result.push_str("[TOKEN]");
    } else {
        result.push_str(&current_token);
    }

    result
}

/// Detect the domain of a learning based on keyword matching.
pub fn detect_domain(text: &str) -> String {
    let lower = text.to_ascii_lowercase();

    let domains: &[(&str, &[&str])] = &[
        (
            "shell",
            &[
                "command", "terminal", "bash", "shell", "execute", "script", "cli",
            ],
        ),
        (
            "coding",
            &[
                "code",
                "function",
                "variable",
                "syntax",
                "programming",
                "debug",
                "typescript",
                "javascript",
            ],
        ),
        (
            "system",
            &[
                "file",
                "directory",
                "process",
                "memory",
                "cpu",
                "system",
                "install",
                "package",
            ],
        ),
        (
            "network",
            &[
                "http", "api", "request", "response", "url", "network", "fetch", "curl",
            ],
        ),
        (
            "data",
            &["json", "csv", "database", "query", "data", "sql", "table"],
        ),
        (
            "ai",
            &[
                "model", "llm", "embedding", "prompt", "token", "inference",
            ],
        ),
    ];

    for (domain, keywords) in domains {
        if keywords.iter().any(|kw| lower.contains(kw)) {
            return (*domain).to_string();
        }
    }

    "general".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_valid_json() {
        let response = r#"Here are the experiences: [{"type": "DISCOVERY", "learning": "jq is available", "context": "system check", "confidence": 0.85, "reasoning": "novel tool"}]"#;
        let experiences = ExperienceEvaluator::parse_extracted_experiences(response);
        assert_eq!(experiences.len(), 1);
        assert_eq!(experiences[0].experience_type.as_deref(), Some("DISCOVERY"));
        assert_eq!(experiences[0].learning.as_deref(), Some("jq is available"));
        assert!((experiences[0].confidence.unwrap() - 0.85).abs() < f64::EPSILON);
        assert_eq!(
            experiences[0].reasoning.as_deref(),
            Some("novel tool")
        );
    }

    #[test]
    fn parse_empty_array() {
        let response = "No experiences found: []";
        let experiences = ExperienceEvaluator::parse_extracted_experiences(response);
        assert!(experiences.is_empty());
    }

    #[test]
    fn parse_malformed_json() {
        let experiences = ExperienceEvaluator::parse_extracted_experiences("not json at all");
        assert!(experiences.is_empty());
    }

    #[test]
    fn parse_invalid_json_array() {
        let experiences =
            ExperienceEvaluator::parse_extracted_experiences("[ {broken json here ]");
        assert!(experiences.is_empty());
    }

    #[test]
    fn parse_multiple_experiences() {
        let response = r#"[
            {"type": "LEARNING", "learning": "thing one", "confidence": 0.9},
            {"type": "CORRECTION", "learning": "thing two", "confidence": 0.7}
        ]"#;
        let experiences = ExperienceEvaluator::parse_extracted_experiences(response);
        assert_eq!(experiences.len(), 2);
        assert_eq!(experiences[0].learning.as_deref(), Some("thing one"));
        assert_eq!(experiences[1].learning.as_deref(), Some("thing two"));
    }

    #[test]
    fn parse_skips_non_objects() {
        let response = r#"[42, "string", {"type": "LEARNING", "learning": "valid"}]"#;
        let experiences = ExperienceEvaluator::parse_extracted_experiences(response);
        assert_eq!(experiences.len(), 1);
        assert_eq!(experiences[0].learning.as_deref(), Some("valid"));
    }

    #[test]
    fn sanitize_removes_emails() {
        let text = "Contact user@example.com for details";
        let result = sanitize_context(text);
        assert!(result.contains("[EMAIL]"));
        assert!(!result.contains("user@example.com"));
    }

    #[test]
    fn sanitize_removes_ips() {
        let text = "Server at 192.168.1.100 is down";
        let result = sanitize_context(text);
        assert!(result.contains("[IP]"));
        assert!(!result.contains("192.168.1.100"));
    }

    #[test]
    fn sanitize_removes_user_paths() {
        let text = "Found file at /Users/john/project/main.rs";
        let result = sanitize_context(text);
        assert!(result.contains("/Users/[USER]"));
        assert!(!result.contains("/Users/john"));
    }

    #[test]
    fn sanitize_removes_home_paths() {
        let text = "Config at /home/alice/.config/app.toml";
        let result = sanitize_context(text);
        assert!(result.contains("/home/[USER]"));
        assert!(!result.contains("/home/alice"));
    }

    #[test]
    fn sanitize_removes_tokens() {
        let text = "Key is ABCDEFGHIJKLMNOPQRSTUVWXYZ123 end";
        let result = sanitize_context(text);
        assert!(result.contains("[TOKEN]"));
        assert!(!result.contains("ABCDEFGHIJKLMNOPQRSTUVWXYZ123"));
    }

    #[test]
    fn sanitize_truncates() {
        let text = "a".repeat(300);
        let result = sanitize_context(&text);
        assert!(result.len() <= 200);
    }

    #[test]
    fn sanitize_empty_returns_default() {
        assert_eq!(sanitize_context(""), "Unknown context");
    }

    #[test]
    fn sanitize_preserves_normal_text() {
        let text = "Installed the package successfully";
        let result = sanitize_context(text);
        assert_eq!(result, text);
    }

    #[test]
    fn detect_domain_coding() {
        assert_eq!(detect_domain("Fix the function syntax error"), "coding");
    }

    #[test]
    fn detect_domain_shell() {
        assert_eq!(detect_domain("Execute the bash command"), "shell");
    }

    #[test]
    fn detect_domain_network() {
        assert_eq!(detect_domain("The API request returned 404"), "network");
    }

    #[test]
    fn detect_domain_data() {
        assert_eq!(detect_domain("Load the JSON data"), "data");
    }

    #[test]
    fn detect_domain_system() {
        assert_eq!(detect_domain("Install the package globally"), "system");
    }

    #[test]
    fn detect_domain_ai() {
        assert_eq!(detect_domain("The LLM model hallucinates"), "ai");
    }

    #[test]
    fn detect_domain_general() {
        assert_eq!(detect_domain("The weather is nice"), "general");
    }

    #[tokio::test]
    async fn handler_records_experiences_from_llm_response() {
        let mut svc = ExperienceService::new(100);
        let now = 1_700_000_000_000i64;

        let mock_response = r#"[
            {"type": "DISCOVERY", "learning": "jq is available for JSON", "context": "system check", "confidence": 0.85, "reasoning": "novel tool"}
        ]"#
        .to_string();

        let count = ExperienceEvaluator::handler(
            &mut svc,
            |_prompt| async { mock_response },
            "agent-1",
            "Found that jq is installed on the system",
            0.7,
            now,
        )
        .await;

        assert_eq!(count, 1);

        let results = svc.query_experiences(
            &ExperienceQuery {
                query: Some("jq JSON".to_string()),
                limit: Some(5),
                ..Default::default()
            },
            now + 1,
        );
        assert!(!results.is_empty());
        assert!(results[0].tags.contains(&"extracted".to_string()));
        assert!(results[0].tags.contains(&"novel".to_string()));
        assert!(results[0].tags.contains(&"discovery".to_string()));
    }

    #[tokio::test]
    async fn handler_skips_low_confidence() {
        let mut svc = ExperienceService::new(100);
        let now = 1_700_000_000_000i64;

        let mock_response = r#"[
            {"type": "LEARNING", "learning": "something weak", "confidence": 0.3}
        ]"#
        .to_string();

        let count = ExperienceEvaluator::handler(
            &mut svc,
            |_prompt| async { mock_response },
            "agent-1",
            "some conversation",
            0.7,
            now,
        )
        .await;

        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn handler_caps_at_three_experiences() {
        let mut svc = ExperienceService::new(100);
        let now = 1_700_000_000_000i64;

        let mock_response = r#"[
            {"type": "LEARNING", "learning": "one", "confidence": 0.9},
            {"type": "LEARNING", "learning": "two", "confidence": 0.9},
            {"type": "LEARNING", "learning": "three", "confidence": 0.9},
            {"type": "LEARNING", "learning": "four", "confidence": 0.9},
            {"type": "LEARNING", "learning": "five", "confidence": 0.9}
        ]"#
        .to_string();

        let count = ExperienceEvaluator::handler(
            &mut svc,
            |_prompt| async { mock_response },
            "agent-1",
            "lots of things learned",
            0.7,
            now,
        )
        .await;

        assert_eq!(count, 3);
    }

    #[tokio::test]
    async fn handler_correction_gets_positive_outcome() {
        let mut svc = ExperienceService::new(100);
        let now = 1_700_000_000_000i64;

        let mock_response = r#"[
            {"type": "CORRECTION", "learning": "install deps first", "context": "build failure", "confidence": 0.85}
        ]"#
        .to_string();

        let count = ExperienceEvaluator::handler(
            &mut svc,
            |_prompt| async { mock_response },
            "agent-1",
            "failed then fixed build",
            0.7,
            now,
        )
        .await;

        assert_eq!(count, 1);

        let results = svc.query_experiences(
            &ExperienceQuery {
                types: Some(vec![ExperienceType::Correction]),
                limit: Some(5),
                ..Default::default()
            },
            now + 1,
        );
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].outcome, OutcomeType::Positive);
    }

    #[tokio::test]
    async fn handler_empty_response() {
        let mut svc = ExperienceService::new(100);
        let now = 1_700_000_000_000i64;

        let count = ExperienceEvaluator::handler(
            &mut svc,
            |_prompt| async { "[]".to_string() },
            "agent-1",
            "nothing interesting",
            0.7,
            now,
        )
        .await;

        assert_eq!(count, 0);
    }
}
