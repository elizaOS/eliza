//! FormService — manages form definitions, sessions, and submissions.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

use super::types::*;

/// In-memory form service managing definitions, sessions, and submissions.
pub struct FormService {
    definitions: Arc<RwLock<HashMap<String, FormDefinition>>>,
    sessions: Arc<RwLock<HashMap<String, FormSession>>>,
    submissions: Arc<RwLock<Vec<FormSubmission>>>,
}

impl FormService {
    /// Create a new, empty form service.
    pub fn new() -> Self {
        Self {
            definitions: Arc::new(RwLock::new(HashMap::new())),
            sessions: Arc::new(RwLock::new(HashMap::new())),
            submissions: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Register a form definition.
    pub async fn register_definition(&self, definition: FormDefinition) -> anyhow::Result<()> {
        self.definitions
            .write()
            .await
            .insert(definition.id.clone(), definition);
        Ok(())
    }

    /// Get a form definition by ID.
    pub async fn get_definition(&self, id: &str) -> Option<FormDefinition> {
        self.definitions.read().await.get(id).cloned()
    }

    /// Start a new form session.
    pub async fn start_session(
        &self,
        form_id: &str,
        entity_id: Uuid,
        room_id: Uuid,
    ) -> anyhow::Result<FormSession> {
        let definition = self
            .get_definition(form_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("Form definition '{}' not found", form_id))?;

        let now = chrono::Utc::now().timestamp_millis();
        let ttl = definition.ttl.as_ref().cloned().unwrap_or_default();
        let expires_at = now + (ttl.min_days as i64 * 24 * 60 * 60 * 1000);

        let mut fields = HashMap::new();
        for control in &definition.controls {
            fields.insert(
                control.key.clone(),
                FieldState {
                    status: if control.default_value.is_some() {
                        FieldStatus::Filled
                    } else {
                        FieldStatus::Empty
                    },
                    value: control.default_value.clone(),
                    confidence: None,
                    alternatives: None,
                    error: None,
                    source: control.default_value.as_ref().map(|_| FieldSource::Default),
                    message_id: None,
                    updated_at: Some(now),
                    confirmed_at: None,
                    sub_fields: None,
                    meta: None,
                },
            );
        }

        let session = FormSession {
            id: Uuid::new_v4().to_string(),
            form_id: form_id.to_string(),
            form_version: Some(definition.version),
            entity_id,
            room_id,
            status: FormSessionStatus::Active,
            fields,
            history: Vec::new(),
            parent_session_id: None,
            context: None,
            locale: None,
            last_asked_field: None,
            last_message_id: None,
            cancel_confirmation_asked: false,
            effort: SessionEffort {
                interaction_count: 0,
                time_spent_ms: 0,
                first_interaction_at: now,
                last_interaction_at: now,
            },
            expires_at,
            expiration_warned: false,
            nudge_count: None,
            last_nudge_at: None,
            created_at: now,
            updated_at: now,
            submitted_at: None,
            meta: None,
        };

        self.sessions
            .write()
            .await
            .insert(session.id.clone(), session.clone());

        Ok(session)
    }

    /// Get active session for entity + room.
    pub async fn get_active_session(&self, entity_id: Uuid, room_id: Uuid) -> Option<FormSession> {
        self.sessions
            .read()
            .await
            .values()
            .find(|s| {
                s.entity_id == entity_id
                    && s.room_id == room_id
                    && s.status == FormSessionStatus::Active
            })
            .cloned()
    }

    /// Get session by ID.
    pub async fn get_session(&self, id: &str) -> Option<FormSession> {
        self.sessions.read().await.get(id).cloned()
    }

    /// Update a field in a session.
    pub async fn update_field(
        &self,
        session_id: &str,
        field_key: &str,
        value: serde_json::Value,
        confidence: f64,
        source: FieldSource,
    ) -> anyhow::Result<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow::anyhow!("Session '{}' not found", session_id))?;

        let now = chrono::Utc::now().timestamp_millis();

        // Record history for undo
        if let Some(old_state) = session.fields.get(field_key) {
            session.history.push(FieldHistoryEntry {
                field: field_key.to_string(),
                old_value: old_state.value.clone().unwrap_or(serde_json::Value::Null),
                new_value: value.clone(),
                timestamp: now,
            });
        }

        let status = if confidence < 0.6 {
            FieldStatus::Uncertain
        } else {
            FieldStatus::Filled
        };

        session.fields.insert(
            field_key.to_string(),
            FieldState {
                status,
                value: Some(value),
                confidence: Some(confidence),
                alternatives: None,
                error: None,
                source: Some(source),
                message_id: None,
                updated_at: Some(now),
                confirmed_at: None,
                sub_fields: None,
                meta: None,
            },
        );

        session.updated_at = now;
        session.effort.interaction_count += 1;
        session.effort.last_interaction_at = now;
        session.effort.time_spent_ms = now - session.effort.first_interaction_at;

        Ok(())
    }

    /// Stash a session (pause for later).
    pub async fn stash_session(&self, session_id: &str) -> anyhow::Result<()> {
        let mut sessions = self.sessions.write().await;
        if let Some(session) = sessions.get_mut(session_id) {
            session.status = FormSessionStatus::Stashed;
            session.updated_at = chrono::Utc::now().timestamp_millis();
        }
        Ok(())
    }

    /// Restore a stashed session.
    pub async fn restore_session(&self, session_id: &str) -> anyhow::Result<FormSession> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow::anyhow!("Session '{}' not found", session_id))?;

        session.status = FormSessionStatus::Active;
        session.updated_at = chrono::Utc::now().timestamp_millis();

        Ok(session.clone())
    }

    /// Submit a completed session.
    pub async fn submit_session(&self, session_id: &str) -> anyhow::Result<FormSubmission> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow::anyhow!("Session '{}' not found", session_id))?;

        let now = chrono::Utc::now().timestamp_millis();
        session.status = FormSessionStatus::Submitted;
        session.submitted_at = Some(now);
        session.updated_at = now;

        let values: HashMap<String, serde_json::Value> = session
            .fields
            .iter()
            .filter_map(|(k, v)| v.value.clone().map(|val| (k.clone(), val)))
            .collect();

        let submission = FormSubmission {
            id: Uuid::new_v4().to_string(),
            form_id: session.form_id.clone(),
            form_version: session.form_version,
            session_id: session_id.to_string(),
            entity_id: session.entity_id,
            values,
            mapped_values: None,
            submitted_at: now,
            meta: None,
        };

        self.submissions.write().await.push(submission.clone());

        Ok(submission)
    }

    /// Get stashed sessions for an entity.
    pub async fn get_stashed_sessions(&self, entity_id: Uuid) -> Vec<FormSession> {
        self.sessions
            .read()
            .await
            .values()
            .filter(|s| s.entity_id == entity_id && s.status == FormSessionStatus::Stashed)
            .cloned()
            .collect()
    }

    /// Compute progress percentage for a session.
    pub fn compute_progress(session: &FormSession, definition: &FormDefinition) -> f64 {
        let required_count = definition.controls.iter().filter(|c| c.required).count();

        if required_count == 0 {
            return 100.0;
        }

        let filled = definition
            .controls
            .iter()
            .filter(|c| c.required)
            .filter(|c| {
                session
                    .fields
                    .get(&c.key)
                    .map(|f| f.status == FieldStatus::Filled)
                    .unwrap_or(false)
            })
            .count();

        (filled as f64 / required_count as f64) * 100.0
    }
}

impl Default for FormService {
    fn default() -> Self {
        Self::new()
    }
}
