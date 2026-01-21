use crate::types::{Experience, ExperienceQuery, ExperienceType, OutcomeType};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

/// Input parameters for recording an experience.
#[derive(Debug, Clone)]
pub struct ExperienceInput {
    /// Type of experience.
    pub experience_type: ExperienceType,
    /// Outcome of the experience.
    pub outcome: OutcomeType,
    /// Context in which the experience occurred.
    pub context: String,
    /// Action that was taken.
    pub action: String,
    /// Result of the action.
    pub result: String,
    /// What was learned from this experience.
    pub learning: String,
    /// Tags for categorization.
    pub tags: Vec<String>,
    /// Domain of the experience (e.g., "shell", "coding").
    pub domain: String,
    /// Confidence level (0-1).
    pub confidence: f64,
    /// Importance level (0-1).
    pub importance: f64,
}

impl ExperienceInput {
    /// Create a new experience input with required fields.
    pub fn new(context: String, action: String, result: String, learning: String) -> Self {
        Self {
            experience_type: ExperienceType::Learning,
            outcome: OutcomeType::Neutral,
            context,
            action,
            result,
            learning,
            tags: Vec::new(),
            domain: "general".to_string(),
            confidence: 0.5,
            importance: 0.5,
        }
    }

    /// Set the experience type.
    pub fn with_type(mut self, experience_type: ExperienceType) -> Self {
        self.experience_type = experience_type;
        self
    }

    /// Set the outcome type.
    pub fn with_outcome(mut self, outcome: OutcomeType) -> Self {
        self.outcome = outcome;
        self
    }

    /// Set the domain.
    pub fn with_domain(mut self, domain: String) -> Self {
        self.domain = domain;
        self
    }

    /// Set the tags.
    pub fn with_tags(mut self, tags: Vec<String>) -> Self {
        self.tags = tags;
        self
    }

    /// Set the confidence level (0-1).
    pub fn with_confidence(mut self, confidence: f64) -> Self {
        self.confidence = confidence;
        self
    }

    /// Set the importance level (0-1).
    pub fn with_importance(mut self, importance: f64) -> Self {
        self.importance = importance;
        self
    }
}

/// In-memory experience service with token-overlap similarity.
#[derive(Debug, Default)]
pub struct ExperienceService {
    max_experiences: usize,
    experiences: HashMap<String, Experience>,
}

impl ExperienceService {
    /// Create a new service with a maximum number of stored experiences.
    pub fn new(max_experiences: usize) -> Self {
        Self {
            max_experiences: max_experiences.max(1),
            experiences: HashMap::new(),
        }
    }

    /// Set the maximum number of experiences to store, pruning if necessary.
    pub fn set_max_experiences(&mut self, max_experiences: usize) {
        self.max_experiences = max_experiences.max(1);
        self.prune_if_needed();
    }

    /// Record an experience and return the stored record.
    pub fn record_experience(
        &mut self,
        agent_id: &str,
        input: ExperienceInput,
        now_ms: i64,
    ) -> Experience {
        let id = Uuid::new_v4().to_string();
        let exp = Experience {
            id,
            agent_id: agent_id.to_string(),
            experience_type: input.experience_type,
            outcome: input.outcome,
            context: input.context,
            action: input.action,
            result: input.result,
            learning: input.learning,
            tags: input.tags,
            domain: input.domain,
            related_experiences: None,
            supersedes: None,
            confidence: input.confidence,
            importance: input.importance,
            created_at: now_ms,
            updated_at: now_ms,
            last_accessed_at: Some(now_ms),
            access_count: 0,
            previous_belief: None,
            corrected_belief: None,
            embedding: None,
            memory_ids: None,
        };

        self.experiences.insert(exp.id.clone(), exp.clone());
        self.prune_if_needed();
        exp
    }

    /// Query experiences using filters and optional similarity ranking.
    pub fn query_experiences(&mut self, query: &ExperienceQuery, now_ms: i64) -> Vec<Experience> {
        let mut candidates: Vec<Experience> = self.experiences.values().cloned().collect();

        if let Some(types) = &query.types {
            candidates.retain(|e| types.contains(&e.experience_type));
        }
        if let Some(outcomes) = &query.outcomes {
            candidates.retain(|e| outcomes.contains(&e.outcome));
        }
        if let Some(domains) = &query.domains {
            candidates.retain(|e| domains.contains(&e.domain));
        }
        if let Some(tags) = &query.tags {
            candidates.retain(|e| tags.iter().any(|t| e.tags.contains(t)));
        }
        if let Some(min_conf) = query.min_confidence {
            candidates.retain(|e| e.confidence >= min_conf);
        }
        if let Some(min_imp) = query.min_importance {
            candidates.retain(|e| e.importance >= min_imp);
        }
        if let Some(range) = &query.time_range {
            candidates.retain(|e| {
                (range.start.is_none() || e.created_at >= range.start.unwrap())
                    && (range.end.is_none() || e.created_at <= range.end.unwrap())
            });
        }

        let limit = query.limit.unwrap_or(10);

        let mut results = if let Some(q) = &query.query {
            find_similar(q, &candidates, limit)
        } else {
            candidates.sort_by(|a, b| {
                let score_a = a.confidence * a.importance;
                let score_b = b.confidence * b.importance;
                score_b
                    .partial_cmp(&score_a)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| b.updated_at.cmp(&a.updated_at))
            });
            candidates.into_iter().take(limit).collect()
        };

        // Update access metrics
        for exp in &mut results {
            if let Some(stored) = self.experiences.get_mut(&exp.id) {
                stored.access_count = stored.access_count.saturating_add(1);
                stored.last_accessed_at = Some(now_ms);
                *exp = stored.clone();
            }
        }

        if query.include_related.unwrap_or(false) {
            let mut seen: HashSet<String> = results.iter().map(|e| e.id.clone()).collect();
            let mut related: Vec<Experience> = Vec::new();
            for exp in &results {
                for rel_id in exp.related_experiences.clone().unwrap_or_default() {
                    if seen.contains(&rel_id) {
                        continue;
                    }
                    if let Some(rel) = self.experiences.get(&rel_id) {
                        related.push(rel.clone());
                        seen.insert(rel_id);
                    }
                }
            }
            results.extend(related);
        }

        results
    }

    fn prune_if_needed(&mut self) {
        if self.experiences.len() <= self.max_experiences {
            return;
        }

        let mut items: Vec<Experience> = self.experiences.values().cloned().collect();
        items.sort_by(|a, b| {
            a.importance
                .partial_cmp(&b.importance)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.access_count.cmp(&b.access_count))
                .then_with(|| a.created_at.cmp(&b.created_at))
        });

        let remove_count = items.len().saturating_sub(self.max_experiences);
        for exp in items.into_iter().take(remove_count) {
            self.experiences.remove(&exp.id);
        }
    }
}

fn find_similar(query_text: &str, candidates: &[Experience], limit: usize) -> Vec<Experience> {
    let q = tokenize(query_text);
    let mut scored: Vec<(Experience, f64)> = Vec::new();

    for exp in candidates {
        let combined = format!(
            "{} {} {} {}",
            exp.context, exp.action, exp.result, exp.learning
        );
        let e = tokenize(&combined);
        let sim = jaccard(&q, &e);
        if sim > 0.0 {
            scored.push((exp.clone(), sim));
        }
    }

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().take(limit).map(|(e, _)| e).collect()
}

fn tokenize(text: &str) -> HashSet<String> {
    let mut out: HashSet<String> = HashSet::new();
    let mut current = String::new();

    for ch in text.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() || lower == '_' {
            current.push(lower);
        } else if !current.is_empty() {
            out.insert(std::mem::take(&mut current));
        }
    }

    if !current.is_empty() {
        out.insert(current);
    }

    out
}

fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count() as f64;
    let union = a.union(b).count() as f64;
    if union == 0.0 {
        0.0
    } else {
        inter / union
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_record_and_query() {
        let mut svc = ExperienceService::new(100);
        let now = 1_700_000_000_000i64;

        let input = ExperienceInput::new(
            "debugging".to_string(),
            "run tests".to_string(),
            "fixed it".to_string(),
            "install deps first".to_string(),
        )
        .with_type(ExperienceType::Learning)
        .with_domain("coding".to_string())
        .with_confidence(0.9)
        .with_importance(0.8);

        let exp = svc.record_experience("agent-1", input, now);

        let q = ExperienceQuery {
            query: Some("install dependencies".to_string()),
            limit: Some(5),
            ..Default::default()
        };

        let results = svc.query_experiences(&q, now + 1);
        assert!(results.iter().any(|e| e.id == exp.id));
    }
}
