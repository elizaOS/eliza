//! In-memory form management service.

use crate::types::*;
use std::collections::HashMap;
use uuid::Uuid;

/// Service for managing form definitions, sessions, and submissions.
pub struct FormService {
    forms: HashMap<String, FormDefinition>,
    sessions: HashMap<String, FormSession>,
    submissions: Vec<FormSubmission>,
}

impl FormService {
    /// Create a new FormService.
    pub fn new() -> Self {
        Self {
            forms: HashMap::new(),
            sessions: HashMap::new(),
            submissions: Vec::new(),
        }
    }

    /// Register a form definition.
    pub fn register_form(&mut self, form: FormDefinition) {
        self.forms.insert(form.id.clone(), form);
    }

    /// Get a form definition by ID.
    pub fn get_form(&self, form_id: &str) -> Option<&FormDefinition> {
        self.forms.get(form_id)
    }

    /// List all registered forms.
    pub fn list_forms(&self) -> Vec<&FormDefinition> {
        self.forms.values().collect()
    }

    /// Start a new form session.
    pub fn start_session(
        &mut self,
        form_id: &str,
        entity_id: impl Into<String>,
        room_id: impl Into<String>,
        now_ms: i64,
    ) -> Result<String, FormError> {
        let form = self
            .forms
            .get(form_id)
            .ok_or_else(|| FormError::FormNotFound(form_id.to_string()))?;

        let session_id = Uuid::new_v4().to_string();
        let mut fields = HashMap::new();

        for control in &form.controls {
            let state = if let Some(ref default) = control.default_value {
                FieldState {
                    value: Some(default.clone()),
                    status: FieldStatus::Uncertain,
                    source: Some(FieldSource::Default),
                    ..Default::default()
                }
            } else {
                FieldState::default()
            };
            fields.insert(control.key.clone(), state);
        }

        let session = FormSession {
            id: session_id.clone(),
            form_id: form_id.to_string(),
            form_version: form.version,
            entity_id: entity_id.into(),
            room_id: room_id.into(),
            status: SessionStatus::Active,
            fields,
            history: Vec::new(),
            parent_session_id: None,
            context: None,
            locale: None,
            last_asked_field: None,
            last_message_id: None,
            cancel_confirmation_asked: None,
            effort: SessionEffort {
                interaction_count: 0,
                time_spent_ms: 0,
                first_interaction_at: now_ms,
                last_interaction_at: now_ms,
            },
            expires_at: now_ms + 14 * 24 * 60 * 60 * 1000, // 14 days default
            expiration_warned: None,
            nudge_count: None,
            last_nudge_at: None,
            created_at: now_ms,
            updated_at: now_ms,
            submitted_at: None,
            meta: None,
        };

        self.sessions.insert(session_id.clone(), session);
        Ok(session_id)
    }

    /// Get a session by ID.
    pub fn get_session(&self, session_id: &str) -> Option<&FormSession> {
        self.sessions.get(session_id)
    }

    /// Get a mutable session by ID.
    pub fn get_session_mut(&mut self, session_id: &str) -> Option<&mut FormSession> {
        self.sessions.get_mut(session_id)
    }

    /// Find the active session for an entity in a room.
    pub fn find_active_session(&self, entity_id: &str, room_id: &str) -> Option<&FormSession> {
        self.sessions.values().find(|s| {
            s.entity_id == entity_id
                && s.room_id == room_id
                && s.status == SessionStatus::Active
        })
    }

    /// Set a field value in a session.
    pub fn set_field(
        &mut self,
        session_id: &str,
        field_name: &str,
        value: serde_json::Value,
        now_ms: i64,
    ) -> Result<(), FormError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(FormError::SessionNotFound)?;

        let field = session
            .fields
            .get_mut(field_name)
            .ok_or_else(|| FormError::FieldNotFound(field_name.to_string()))?;

        field.value = Some(value);
        field.status = FieldStatus::Filled;
        session.updated_at = now_ms;
        session.effort.last_interaction_at = now_ms;
        session.effort.interaction_count += 1;
        Ok(())
    }

    /// Get the next unfilled required field.
    pub fn next_required_field(&self, session_id: &str) -> Option<String> {
        let session = self.sessions.get(session_id)?;
        let form = self.forms.get(&session.form_id)?;

        for control in &form.controls {
            if !control.required {
                continue;
            }
            if let Some(state) = session.fields.get(&control.key) {
                if state.status == FieldStatus::Empty {
                    return Some(control.key.clone());
                }
            }
        }
        None
    }

    /// Check if a session is ready for submission (all required fields filled).
    pub fn is_ready(&self, session_id: &str) -> bool {
        self.next_required_field(session_id).is_none()
    }

    /// Compute progress as a percentage.
    pub fn progress(&self, session_id: &str) -> f64 {
        let session = match self.sessions.get(session_id) {
            Some(s) => s,
            None => return 0.0,
        };
        let form = match self.forms.get(&session.form_id) {
            Some(f) => f,
            None => return 0.0,
        };

        let required_count = form.controls.iter().filter(|c| c.required).count();
        if required_count == 0 {
            return 100.0;
        }

        let filled = form
            .controls
            .iter()
            .filter(|c| c.required)
            .filter(|c| {
                session
                    .fields
                    .get(&c.key)
                    .map(|s| s.status == FieldStatus::Filled)
                    .unwrap_or(false)
            })
            .count();

        (filled as f64 / required_count as f64) * 100.0
    }

    /// Submit a session.
    pub fn submit(
        &mut self,
        session_id: &str,
        now_ms: i64,
    ) -> Result<FormSubmission, FormError> {
        if !self.is_ready(session_id) {
            return Err(FormError::NotReady);
        }

        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(FormError::SessionNotFound)?;

        session.status = SessionStatus::Submitted;
        session.updated_at = now_ms;
        session.submitted_at = Some(now_ms);

        let mut values = HashMap::new();
        for (name, state) in &session.fields {
            if let Some(ref value) = state.value {
                values.insert(name.clone(), value.clone());
            }
        }

        let submission = FormSubmission {
            id: Uuid::new_v4().to_string(),
            form_id: session.form_id.clone(),
            form_version: session.form_version,
            session_id: session_id.to_string(),
            entity_id: session.entity_id.clone(),
            values,
            mapped_values: None,
            files: None,
            submitted_at: now_ms,
            meta: None,
        };

        self.submissions.push(submission.clone());
        Ok(submission)
    }

    /// Cancel a session.
    pub fn cancel(&mut self, session_id: &str, now_ms: i64) -> Result<(), FormError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(FormError::SessionNotFound)?;
        session.status = SessionStatus::Cancelled;
        session.updated_at = now_ms;
        Ok(())
    }

    /// Stash a session (pause for later).
    pub fn stash(&mut self, session_id: &str, now_ms: i64) -> Result<(), FormError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(FormError::SessionNotFound)?;
        session.status = SessionStatus::Stashed;
        session.updated_at = now_ms;
        Ok(())
    }

    /// Restore a stashed session.
    pub fn restore(&mut self, session_id: &str, now_ms: i64) -> Result<(), FormError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(FormError::SessionNotFound)?;
        if session.status != SessionStatus::Stashed {
            return Err(FormError::NotStashed);
        }
        session.status = SessionStatus::Active;
        session.updated_at = now_ms;
        Ok(())
    }
}

impl Default for FormService {
    fn default() -> Self {
        Self::new()
    }
}

/// Errors from form operations.
#[derive(Debug, thiserror::Error)]
pub enum FormError {
    /// Form definition not found.
    #[error("Form not found: {0}")]
    FormNotFound(String),
    /// Session not found.
    #[error("Session not found")]
    SessionNotFound,
    /// Field not found in form.
    #[error("Field not found: {0}")]
    FieldNotFound(String),
    /// Form is not ready for submission.
    #[error("Form has unfilled required fields")]
    NotReady,
    /// Session is not stashed.
    #[error("Session is not stashed")]
    NotStashed,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builder::{ControlBuilder, FormBuilder};

    fn test_form() -> FormDefinition {
        FormBuilder::create("registration")
            .name("User Registration")
            .control(
                ControlBuilder::text("name")
                    .label("Full Name")
                    .required()
                    .ask("What's your name?"),
            )
            .control(ControlBuilder::email("email").label("Email").required())
            .control(ControlBuilder::text("bio").label("Bio"))
            .on_submit("handle_registration")
            .build()
    }

    #[test]
    fn test_register_and_get_form() {
        let mut svc = FormService::new();
        svc.register_form(test_form());
        assert!(svc.get_form("registration").is_some());
        assert!(svc.get_form("nonexistent").is_none());
    }

    #[test]
    fn test_start_session() {
        let mut svc = FormService::new();
        svc.register_form(test_form());
        let sid = svc.start_session("registration", "user-1", "room-1", 1000).unwrap();
        let session = svc.get_session(&sid).unwrap();
        assert_eq!(session.form_id, "registration");
        assert_eq!(session.status, SessionStatus::Active);
        assert_eq!(session.fields.len(), 3);
    }

    #[test]
    fn test_set_field_and_progress() {
        let mut svc = FormService::new();
        svc.register_form(test_form());
        let sid = svc.start_session("registration", "user-1", "room-1", 1000).unwrap();

        assert_eq!(svc.progress(&sid), 0.0);
        assert!(!svc.is_ready(&sid));

        svc.set_field(&sid, "name", serde_json::json!("Alice"), 2000).unwrap();
        assert_eq!(svc.progress(&sid), 50.0); // 1 of 2 required

        svc.set_field(&sid, "email", serde_json::json!("alice@example.com"), 3000).unwrap();
        assert_eq!(svc.progress(&sid), 100.0);
        assert!(svc.is_ready(&sid));
    }

    #[test]
    fn test_submit() {
        let mut svc = FormService::new();
        svc.register_form(test_form());
        let sid = svc.start_session("registration", "user-1", "room-1", 1000).unwrap();
        svc.set_field(&sid, "name", serde_json::json!("Alice"), 2000).unwrap();
        svc.set_field(&sid, "email", serde_json::json!("a@b.com"), 3000).unwrap();

        let sub = svc.submit(&sid, 4000).unwrap();
        assert_eq!(sub.values.len(), 2);
        assert_eq!(svc.get_session(&sid).unwrap().status, SessionStatus::Submitted);
    }

    #[test]
    fn test_submit_not_ready() {
        let mut svc = FormService::new();
        svc.register_form(test_form());
        let sid = svc.start_session("registration", "user-1", "room-1", 1000).unwrap();
        assert!(svc.submit(&sid, 2000).is_err());
    }

    #[test]
    fn test_cancel() {
        let mut svc = FormService::new();
        svc.register_form(test_form());
        let sid = svc.start_session("registration", "user-1", "room-1", 1000).unwrap();
        svc.cancel(&sid, 2000).unwrap();
        assert_eq!(svc.get_session(&sid).unwrap().status, SessionStatus::Cancelled);
    }

    #[test]
    fn test_stash_and_restore() {
        let mut svc = FormService::new();
        svc.register_form(test_form());
        let sid = svc.start_session("registration", "user-1", "room-1", 1000).unwrap();
        svc.stash(&sid, 2000).unwrap();
        assert_eq!(svc.get_session(&sid).unwrap().status, SessionStatus::Stashed);
        svc.restore(&sid, 3000).unwrap();
        assert_eq!(svc.get_session(&sid).unwrap().status, SessionStatus::Active);
    }

    #[test]
    fn test_next_required_field() {
        let mut svc = FormService::new();
        svc.register_form(test_form());
        let sid = svc.start_session("registration", "user-1", "room-1", 1000).unwrap();
        assert_eq!(svc.next_required_field(&sid).as_deref(), Some("name"));
        svc.set_field(&sid, "name", serde_json::json!("Alice"), 2000).unwrap();
        assert_eq!(svc.next_required_field(&sid).as_deref(), Some("email"));
        svc.set_field(&sid, "email", serde_json::json!("a@b.com"), 3000).unwrap();
        assert!(svc.next_required_field(&sid).is_none());
    }

    #[test]
    fn test_find_active_session() {
        let mut svc = FormService::new();
        svc.register_form(test_form());
        svc.start_session("registration", "user-1", "room-1", 1000).unwrap();
        assert!(svc.find_active_session("user-1", "room-1").is_some());
        assert!(svc.find_active_session("user-1", "room-2").is_none());
        assert!(svc.find_active_session("user-2", "room-1").is_none());
    }
}
