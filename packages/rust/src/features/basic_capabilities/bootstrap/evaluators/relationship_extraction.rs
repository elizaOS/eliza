//! Relationship extraction evaluator implementation.
//!
//! Extracts relationship data from conversation messages: platform identities,
//! relationship indicators, disputes/corrections, sentiment, trust metrics,
//! privacy boundaries, admin metadata updates, and mentioned third-party entities.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::json;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_evaluator_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{EvaluatorResult, Memory, State};

/// Parse a project UUID into a `uuid::Uuid` for runtime API calls.
fn parse_entity_uuid(id: &crate::types::UUID) -> Option<uuid::Uuid> {
    uuid::Uuid::parse_str(id.as_str()).ok()
}

use super::Evaluator;

/// Evaluator that extracts relationship information from conversations.
pub struct RelationshipExtractionEvaluator;

static SPEC: Lazy<&'static crate::generated::spec_helpers::EvaluatorDoc> =
    Lazy::new(|| require_evaluator_spec("RELATIONSHIP_EXTRACTION"));

// ---------------------------------------------------------------------------
// Pre-compiled regex patterns (compiled once, reused across calls)
// ---------------------------------------------------------------------------

// Platform identity patterns
static RE_X_HANDLE: Lazy<Regex> = Lazy::new(|| Regex::new(r"@[\w]+").unwrap());
static RE_EMAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\w.+-]+@[\w.-]+\.\w+").unwrap());
static RE_DISCORD: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\w]+#\d{4}").unwrap());
static RE_GITHUB: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)github\.com/(\w+)|@(\w+) on github").unwrap());

// Dispute detection patterns
static RE_DISPUTE_NOT_THEIR: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)that'?s not (actually|really) their (\w+)").unwrap());
static RE_DISPUTE_ACTUALLY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)no,? (actually|really) it'?s (\w+)").unwrap());
static RE_DISPUTE_WRONG: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)you'?re wrong,? it'?s (\w+)").unwrap());
static RE_DISPUTE_INCORRECT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)that'?s incorrect").unwrap());

// Privacy boundary patterns
static RE_PRIVACY_DONT_TELL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)don'?t tell anyone").unwrap());
static RE_PRIVACY_CONFIDENTIAL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)keep.{0,20}confidential").unwrap());
static RE_PRIVACY_SECRET: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)keep.{0,20}secret").unwrap());
static RE_PRIVACY_DONT_MENTION: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)don'?t mention").unwrap());
static RE_PRIVACY_BETWEEN_US: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)between you and me").unwrap());
static RE_PRIVACY_OFF_RECORD: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)off the record").unwrap());
static RE_PRIVACY_PRIVATE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\bprivate\b").unwrap());
static RE_PRIVACY_DONT_SHARE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)don'?t share").unwrap());
static RE_PRIVACY_THIS_IS_CONF: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)this is confidential").unwrap());

// Trust / helpfulness patterns
static RE_TRUST_HELPFUL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)here'?s|let me help|i can help|try this|solution|answer").unwrap()
});
// Trust / suspicious patterns (security-sensitive, double-weighted)
static RE_TRUST_SUSPICIOUS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)delete all|give me access|send me your|password|private key|update my permissions|i'?m the new admin|give me.*details|send me.*keys",
    )
    .unwrap()
});

// Admin metadata update pattern: "update/set/change <name>'s <field> to/is/= <value>"
static RE_ADMIN_UPDATE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(?:update|set|change)\s+(\w+(?:\s+\w+)*)'?s?\s+(\w+)\s+(?:to|is|=)\s+(.+)")
        .unwrap()
});

// Mentioned people patterns
static RE_MENTIONED_IS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(\w+ \w+) (?:is|was|works) (?:a|an|the|at|in) ([^.!?]+)").unwrap()
});
static RE_MENTIONED_KNOW: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)(?:met|know|talked to) (\w+ \w+)").unwrap());
static RE_MENTIONED_POSSESSION: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)(\w+)'s (birthday|email|phone|address) is ([^.!?]+)").unwrap());

// Community indicators (extends the existing colleague / friend / family)
static RE_COMMUNITY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(community|group|event|meetup|member|contribute|volunteer|help with|count me in|together we can)\b").unwrap()
});

// Stopwords for mentioned-name filtering
static STOPWORDS: &[&str] = &["the", "and", "but", "for", "with", "this", "that", "from"];

// ---------------------------------------------------------------------------
// Intermediate structs (not exported — internal to the evaluator)
// ---------------------------------------------------------------------------

/// A detected dispute / correction in conversation.
struct DisputeInfo {
    disputed_entity: String,
    disputed_field: String,
    original_value: String,
    claimed_value: String,
}

/// Privacy boundary detected in text.
struct PrivacyInfo {
    privacy_type: &'static str, // "confidential" | "doNotShare" | "private"
    content: String,
    context: &'static str,
}

/// A third-party person mentioned in the message.
struct MentionedPerson {
    name: String,
    context: String,
}

/// Trust assessment metrics.
struct TrustMetrics {
    helpful_count: u32,
    suspicious_count: u32,
}

/// Admin metadata update request.
struct AdminUpdate {
    target_name: String,
    field: String,
    value: String,
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

impl RelationshipExtractionEvaluator {
    // -----------------------------------------------------------------------
    // 1. Platform identity extraction (existing, enhanced with GitHub)
    // -----------------------------------------------------------------------

    /// Extract platform identities from text.
    fn extract_platform_identities(text: &str) -> Vec<(String, String, f64)> {
        let mut identities = Vec::new();

        // X / Twitter handles
        for cap in RE_X_HANDLE.find_iter(text) {
            let handle = cap.as_str();
            if !["@here", "@everyone", "@channel"].contains(&handle.to_lowercase().as_str()) {
                identities.push(("x".to_string(), handle.to_string(), 0.7));
            }
        }

        // Email addresses
        for cap in RE_EMAIL.find_iter(text) {
            identities.push(("email".to_string(), cap.as_str().to_string(), 0.9));
        }

        // Discord usernames (name#1234)
        for cap in RE_DISCORD.find_iter(text) {
            identities.push(("discord".to_string(), cap.as_str().to_string(), 0.8));
        }

        // GitHub usernames (github.com/user or "@user on github")
        for cap in RE_GITHUB.captures_iter(text) {
            let handle = cap
                .get(1)
                .or_else(|| cap.get(2))
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            if !handle.is_empty() {
                identities.push(("github".to_string(), handle, 0.8));
            }
        }

        identities
    }

    // -----------------------------------------------------------------------
    // 2. Relationship indicator detection (existing, enhanced with community)
    // -----------------------------------------------------------------------

    /// Detect relationship indicators in text.
    fn detect_relationship_indicators(text: &str) -> Vec<(String, String, f64)> {
        let mut indicators = Vec::new();
        let lower = text.to_lowercase();

        // Friend indicators
        let friend_patterns = [
            "my friend",
            "good friend",
            "best friend",
            "close friend",
            "we're friends",
        ];
        for pattern in &friend_patterns {
            if lower.contains(pattern) {
                indicators.push(("friend".to_string(), "positive".to_string(), 0.8));
                break;
            }
        }

        // Colleague indicators
        let colleague_patterns = [
            "my colleague",
            "coworker",
            "co-worker",
            "work together",
            "at work",
        ];
        for pattern in &colleague_patterns {
            if lower.contains(pattern) {
                indicators.push(("colleague".to_string(), "neutral".to_string(), 0.8));
                break;
            }
        }

        // Family indicators
        let family_patterns = [
            "my brother",
            "my sister",
            "my mom",
            "my dad",
            "my mother",
            "my father",
            "my parent",
            "my son",
            "my daughter",
            "my child",
            "my family",
            "family member",
        ];
        for pattern in &family_patterns {
            if lower.contains(pattern) {
                indicators.push(("family".to_string(), "positive".to_string(), 0.9));
                break;
            }
        }

        // Community indicators
        if RE_COMMUNITY.is_match(text) {
            indicators.push(("community".to_string(), "positive".to_string(), 0.6));
        }

        indicators
    }

    // -----------------------------------------------------------------------
    // 3. Dispute / correction detection (NEW)
    // -----------------------------------------------------------------------

    /// Detect whether the message contains a dispute or correction of
    /// previously stated information (e.g. "that's wrong", "actually it's X").
    fn detect_dispute(text: &str) -> Option<DisputeInfo> {
        let dispute_patterns: &[&Lazy<Regex>] = &[
            &RE_DISPUTE_NOT_THEIR,
            &RE_DISPUTE_ACTUALLY,
            &RE_DISPUTE_WRONG,
            &RE_DISPUTE_INCORRECT,
        ];

        for pattern in dispute_patterns {
            if pattern.is_match(text) {
                return Some(DisputeInfo {
                    disputed_entity: "unknown".to_string(),
                    disputed_field: "platform_identity".to_string(),
                    original_value: "unknown".to_string(),
                    claimed_value: "unknown".to_string(),
                });
            }
        }

        None
    }

    // -----------------------------------------------------------------------
    // 4. Sentiment analysis (NEW)
    // -----------------------------------------------------------------------

    /// Determine the overall sentiment of a text fragment.
    /// Returns "positive", "negative", or "neutral".
    fn determine_sentiment(text: &str) -> &'static str {
        static POSITIVE_WORDS: &[&str] = &[
            "thanks",
            "great",
            "good",
            "appreciate",
            "love",
            "helpful",
            "awesome",
            "wonderful",
            "fantastic",
            "excellent",
            "amazing",
        ];
        static NEGATIVE_WORDS: &[&str] = &[
            "harsh",
            "wrong",
            "bad",
            "terrible",
            "hate",
            "angry",
            "upset",
            "horrible",
            "awful",
            "annoying",
            "disappointed",
        ];

        let lower = text.to_lowercase();
        let mut pos = 0u32;
        let mut neg = 0u32;

        for word in POSITIVE_WORDS {
            if lower.contains(word) {
                pos += 1;
            }
        }
        for word in NEGATIVE_WORDS {
            if lower.contains(word) {
                neg += 1;
            }
        }

        if pos > neg {
            "positive"
        } else if neg > pos {
            "negative"
        } else {
            "neutral"
        }
    }

    // -----------------------------------------------------------------------
    // 5. Trust assessment (NEW)
    // -----------------------------------------------------------------------

    /// Assess trust indicators from a slice of messages belonging to a single
    /// entity. Returns counts of helpful and suspicious signals.
    fn assess_trust(messages: &[&Memory]) -> TrustMetrics {
        let mut helpful_count: u32 = 0;
        let mut suspicious_count: u32 = 0;

        for msg in messages {
            let text = match &msg.content.text {
                Some(t) => t,
                None => continue,
            };

            if RE_TRUST_HELPFUL.is_match(text) {
                helpful_count += 1;
            }
            // Suspicious patterns carry double weight (security-sensitive)
            if RE_TRUST_SUSPICIOUS.is_match(text) {
                suspicious_count += 2;
            }
        }

        TrustMetrics {
            helpful_count,
            suspicious_count,
        }
    }

    // -----------------------------------------------------------------------
    // 6. Privacy boundary detection (NEW)
    // -----------------------------------------------------------------------

    /// Detect privacy / confidentiality boundaries in text.
    fn detect_privacy_boundaries(text: &str) -> Option<PrivacyInfo> {
        let checks: &[(&Lazy<Regex>, &str, &str)] = &[
            (
                &RE_PRIVACY_DONT_TELL,
                "confidential",
                "Privacy boundary detected",
            ),
            (
                &RE_PRIVACY_CONFIDENTIAL,
                "confidential",
                "Privacy boundary detected",
            ),
            (
                &RE_PRIVACY_SECRET,
                "confidential",
                "Privacy boundary detected",
            ),
            (
                &RE_PRIVACY_DONT_MENTION,
                "doNotShare",
                "Privacy boundary detected",
            ),
            (
                &RE_PRIVACY_BETWEEN_US,
                "confidential",
                "Privacy boundary detected",
            ),
            (
                &RE_PRIVACY_OFF_RECORD,
                "confidential",
                "Privacy boundary detected",
            ),
            (&RE_PRIVACY_PRIVATE, "private", "Privacy boundary detected"),
            (
                &RE_PRIVACY_DONT_SHARE,
                "doNotShare",
                "Privacy boundary detected",
            ),
            (
                &RE_PRIVACY_THIS_IS_CONF,
                "confidential",
                "Privacy boundary detected",
            ),
        ];

        for (pattern, ptype, ctx) in checks {
            if pattern.is_match(text) {
                return Some(PrivacyInfo {
                    privacy_type: ptype,
                    content: text.to_string(),
                    context: ctx,
                });
            }
        }

        None
    }

    // -----------------------------------------------------------------------
    // 7. Admin metadata update detection (NEW)
    // -----------------------------------------------------------------------

    /// Check whether the message is an admin-style metadata update command.
    /// Pattern: "update/set/change <name>'s <field> to/is/= <value>"
    fn detect_admin_update(text: &str) -> Option<AdminUpdate> {
        RE_ADMIN_UPDATE.captures(text).map(|cap| AdminUpdate {
            target_name: cap
                .get(1)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default(),
            field: cap
                .get(2)
                .map(|m| m.as_str().to_lowercase())
                .unwrap_or_default(),
            value: cap
                .get(3)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default(),
        })
    }

    // -----------------------------------------------------------------------
    // 8. Mentioned entity extraction (NEW)
    // -----------------------------------------------------------------------

    /// Extract third-party people mentioned in text (e.g. "my friend John
    /// works at Acme", "met Sarah Connor").
    fn extract_mentioned_people(text: &str) -> Vec<MentionedPerson> {
        let mut people = Vec::new();

        // "X is/was/works a/an/the/at/in ..."
        for cap in RE_MENTIONED_IS.captures_iter(text) {
            if let Some(name_match) = cap.get(1) {
                let name = name_match.as_str();
                if Self::is_valid_person_name(name) {
                    people.push(MentionedPerson {
                        name: name.to_string(),
                        context: cap
                            .get(0)
                            .map(|m| m.as_str().to_string())
                            .unwrap_or_default(),
                    });
                }
            }
        }

        // "met/know/talked to X Y"
        for cap in RE_MENTIONED_KNOW.captures_iter(text) {
            if let Some(name_match) = cap.get(1) {
                let name = name_match.as_str();
                if Self::is_valid_person_name(name) {
                    people.push(MentionedPerson {
                        name: name.to_string(),
                        context: cap
                            .get(0)
                            .map(|m| m.as_str().to_string())
                            .unwrap_or_default(),
                    });
                }
            }
        }

        // "X's birthday/email/phone/address is ..."
        for cap in RE_MENTIONED_POSSESSION.captures_iter(text) {
            if let Some(name_match) = cap.get(1) {
                let name = name_match.as_str();
                if name.len() > 1 && !STOPWORDS.contains(&name.to_lowercase().as_str()) {
                    people.push(MentionedPerson {
                        name: name.to_string(),
                        context: cap
                            .get(0)
                            .map(|m| m.as_str().to_string())
                            .unwrap_or_default(),
                    });
                }
            }
        }

        people
    }

    /// Simple validation: name must be longer than 3 chars and not a stopword.
    fn is_valid_person_name(name: &str) -> bool {
        name.len() > 3 && !STOPWORDS.contains(&name.to_lowercase().as_str())
    }
}

// ---------------------------------------------------------------------------
// Evaluator trait implementation
// ---------------------------------------------------------------------------

#[async_trait]
impl Evaluator for RelationshipExtractionEvaluator {
    fn name(&self) -> &'static str {
        &SPEC.name
    }

    fn description(&self) -> &'static str {
        &SPEC.description
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, message: &Memory) -> bool {
        message
            .content
            .text
            .as_ref()
            .map(|t| !t.is_empty())
            .unwrap_or(false)
    }

    async fn evaluate(
        &self,
        runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<EvaluatorResult> {
        let text = match &message.content.text {
            Some(t) if !t.is_empty() => t.as_str(),
            _ => {
                return Ok(
                    EvaluatorResult::pass(50, "No text to analyze").with_detail("noText", true)
                );
            }
        };

        // --- 1. Platform identities ---
        let identities = Self::extract_platform_identities(text);

        // --- 2. Relationship indicators ---
        let indicators = Self::detect_relationship_indicators(text);

        // --- 3. Dispute detection ---
        let dispute = Self::detect_dispute(text);
        let has_dispute = dispute.is_some();

        // --- 4. Sentiment analysis ---
        let sentiment = Self::determine_sentiment(text);

        // --- 5. Trust assessment (using current message as single-element slice) ---
        let trust = Self::assess_trust(&[message]);

        // --- 6. Privacy boundary detection ---
        let privacy = Self::detect_privacy_boundaries(text);
        let has_privacy = privacy.is_some();

        // --- 7. Admin metadata update detection ---
        let admin_update = Self::detect_admin_update(text);
        let has_admin_update = admin_update.is_some();

        // --- 8. Mentioned people extraction ---
        let mentioned_people = Self::extract_mentioned_people(text);

        // --- Side-effects: update entity metadata when applicable ---

        // 5a. Persist trust metrics on the entity
        if let Some(eid) = parse_entity_uuid(&message.entity_id) {
            if let Ok(Some(entity)) = runtime.get_entity(eid).await {
                // Entity metadata is Option<serde_json::Value>; ensure we have an object.
                let mut meta_obj = match entity.metadata.clone() {
                    Some(serde_json::Value::Object(map)) => map,
                    _ => serde_json::Map::new(),
                };

                // Trust metrics
                let total = 1u32.max(trust.helpful_count + trust.suspicious_count);
                let helpfulness = (trust.helpful_count as f64) / (total as f64);
                let suspicion = (trust.suspicious_count as f64) / (total as f64);
                meta_obj.insert(
                    "trustMetrics".to_string(),
                    json!({
                        "helpfulness": helpfulness,
                        "suspicionLevel": suspicion,
                        "engagement": 1,
                        "lastAssessed": runtime.get_current_timestamp(),
                    }),
                );

                // 6a. Mark privacy boundaries on entity
                if let Some(ref pi) = privacy {
                    meta_obj.insert("privateData".to_string(), json!(true));
                    meta_obj.insert("confidential".to_string(), json!(true));
                    meta_obj.insert(
                        "privacyMarker".to_string(),
                        json!({
                            "type": pi.privacy_type,
                            "context": pi.context,
                            "timestamp": runtime.get_current_timestamp(),
                        }),
                    );
                }

                let mut updated_entity = entity.clone();
                updated_entity.metadata = Some(serde_json::Value::Object(meta_obj));
                let _ = runtime.update_entity(&updated_entity).await;
            }
        }

        // --- Logging ---
        runtime.log_info(
            "evaluator:relationship_extraction",
            &format!(
                "identities={} indicators={} dispute={} sentiment={} privacy={} mentioned={} admin_update={}",
                identities.len(),
                indicators.len(),
                has_dispute,
                sentiment,
                has_privacy,
                mentioned_people.len(),
                has_admin_update,
            ),
        );

        if has_dispute {
            runtime.log_info(
                "evaluator:relationship_extraction",
                "Dispute/correction detected in message",
            );
        }

        if has_privacy {
            runtime.log_warning(
                "evaluator:relationship_extraction",
                "Privacy boundary detected — content flagged as confidential",
            );
        }

        // --- Build serialized data before logging (consumes owned structs) ---

        // Serialize dispute info (consumes DisputeInfo)
        let dispute_json = dispute.map(|d| {
            json!({
                "disputedEntity": d.disputed_entity,
                "disputedField": d.disputed_field,
                "originalValue": d.original_value,
                "claimedValue": d.claimed_value,
            })
        });

        // Serialize admin update info (consumes AdminUpdate)
        let admin_update_json = admin_update.map(|u| {
            runtime.log_info(
                "evaluator:relationship_extraction",
                &format!(
                    "Admin update request: set {}'s {} = {}",
                    u.target_name, u.field, u.value
                ),
            );
            json!({
                "targetName": u.target_name,
                "field": u.field,
                "value": u.value,
            })
        });

        // Serialize mentioned people for metadata
        let mentioned_json: Vec<serde_json::Value> = mentioned_people
            .iter()
            .map(|p| {
                json!({
                    "name": p.name,
                    "context": p.context,
                })
            })
            .collect();

        // --- Build result summary ---
        let summary = format!(
            "Extracted {} identities, {} indicators, {} mentioned people. \
             Dispute: {}. Sentiment: {}. Privacy: {}.",
            identities.len(),
            indicators.len(),
            mentioned_people.len(),
            has_dispute,
            sentiment,
            has_privacy,
        );

        let mut result = EvaluatorResult::pass(70, &summary)
            // Counts
            .with_detail("identitiesCount", identities.len() as i64)
            .with_detail("indicatorsCount", indicators.len() as i64)
            .with_detail("mentionedPeopleCount", mentioned_people.len() as i64)
            // Booleans
            .with_detail("hasDispute", has_dispute)
            .with_detail("hasPrivacyBoundary", has_privacy)
            .with_detail("hasAdminUpdate", has_admin_update)
            // Sentiment
            .with_detail("sentiment", sentiment)
            // Trust
            .with_detail("trustHelpfulCount", trust.helpful_count as i64)
            .with_detail("trustSuspiciousCount", trust.suspicious_count as i64)
            // Structured data
            .with_detail("mentionedPeople", json!(mentioned_json));

        if let Some(dj) = dispute_json {
            result = result.with_detail("dispute", dj);
        }

        if let Some(aj) = admin_update_json {
            result = result.with_detail("adminUpdate", aj);
        }

        if let Some(ref pi) = privacy {
            result = result.with_detail(
                "privacyBoundary",
                json!({
                    "type": pi.privacy_type,
                    "content": pi.content,
                    "context": pi.context,
                }),
            );
        }

        Ok(result)
    }
}
