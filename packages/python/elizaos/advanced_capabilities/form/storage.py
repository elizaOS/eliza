"""Component-based persistence for form data.

Form data is stored using elizaOS's Component system:
- Sessions stored as ``form_session:{roomId}``
- Submissions stored as ``form_submission:{formId}:{submissionId}``
- Autofill stored as ``form_autofill:{formId}``
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from .types import (
    FORM_AUTOFILL_COMPONENT,
    FORM_SESSION_COMPONENT,
    FORM_SUBMISSION_COMPONENT,
    FormAutofillData,
    FormSession,
    FormSubmission,
)

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


def _session_component_type(room_id: str) -> str:
    return f"{FORM_SESSION_COMPONENT}:{room_id}"


def _submission_component_type(form_id: str, submission_id: str) -> str:
    return f"{FORM_SUBMISSION_COMPONENT}:{form_id}:{submission_id}"


def _autofill_component_type(form_id: str) -> str:
    return f"{FORM_AUTOFILL_COMPONENT}:{form_id}"


def _session_to_dict(session: FormSession) -> dict[str, Any]:
    """Serialize a FormSession to a JSON-compatible dict."""
    import dataclasses

    return json.loads(json.dumps(dataclasses.asdict(session), default=str))


def _dict_to_session(data: dict[str, Any]) -> FormSession:
    """Deserialize a dict to a FormSession (best-effort)."""
    from .types import FieldHistoryEntry, FieldState, SessionEffort

    fields: dict[str, FieldState] = {}
    for k, v in data.get("fields", {}).items():
        if isinstance(v, dict):
            fields[k] = FieldState(
                **{fk: fv for fk, fv in v.items() if fk in FieldState.__dataclass_fields__}
            )
        else:
            fields[k] = FieldState()

    history: list[FieldHistoryEntry] = []
    for entry in data.get("history", []):
        if isinstance(entry, dict):
            history.append(
                FieldHistoryEntry(
                    field=entry.get("field", ""),
                    old_value=entry.get("old_value"),
                    new_value=entry.get("new_value"),
                    timestamp=entry.get("timestamp", 0),
                )
            )

    effort_data = data.get("effort", {})
    effort = SessionEffort(
        interaction_count=effort_data.get("interaction_count", 0),
        time_spent_ms=effort_data.get("time_spent_ms", 0),
        first_interaction_at=effort_data.get("first_interaction_at", 0),
        last_interaction_at=effort_data.get("last_interaction_at", 0),
    )

    return FormSession(
        id=data.get("id", ""),
        form_id=data.get("form_id", ""),
        entity_id=data.get("entity_id", ""),
        room_id=data.get("room_id", ""),
        status=data.get("status", "active"),
        form_version=data.get("form_version"),
        fields=fields,
        history=history,
        parent_session_id=data.get("parent_session_id"),
        context=data.get("context"),
        locale=data.get("locale"),
        last_asked_field=data.get("last_asked_field"),
        last_message_id=data.get("last_message_id"),
        cancel_confirmation_asked=data.get("cancel_confirmation_asked", False),
        effort=effort,
        expires_at=data.get("expires_at", 0),
        expiration_warned=data.get("expiration_warned", False),
        nudge_count=data.get("nudge_count", 0),
        last_nudge_at=data.get("last_nudge_at"),
        created_at=data.get("created_at", 0),
        updated_at=data.get("updated_at", 0),
        submitted_at=data.get("submitted_at"),
        meta=data.get("meta"),
    )


# ---------------------------------------------------------------------------
# Session operations
# ---------------------------------------------------------------------------


async def get_active_session(
    runtime: IAgentRuntime,
    entity_id: str,
    room_id: str,
) -> FormSession | None:
    """Get active form session for entity in a specific room."""
    component_type = _session_component_type(room_id)
    components = await runtime.get_components(entity_id, component_type)
    for comp in components:
        data = comp.get("data", {})
        if isinstance(data, dict) and data.get("status") in ("active", "ready"):
            return _dict_to_session(data)
    return None


async def get_all_active_sessions(
    runtime: IAgentRuntime,
    entity_id: str,
) -> list[FormSession]:
    """Get all active sessions for an entity across all rooms."""
    components = await runtime.get_components(entity_id, FORM_SESSION_COMPONENT)
    sessions: list[FormSession] = []
    for comp in components:
        data = comp.get("data", {})
        if isinstance(data, dict) and data.get("status") in ("active", "ready"):
            sessions.append(_dict_to_session(data))
    return sessions


async def get_stashed_sessions(
    runtime: IAgentRuntime,
    entity_id: str,
) -> list[FormSession]:
    """Get stashed sessions for an entity."""
    components = await runtime.get_components(entity_id, FORM_SESSION_COMPONENT)
    sessions: list[FormSession] = []
    for comp in components:
        data = comp.get("data", {})
        if isinstance(data, dict) and data.get("status") == "stashed":
            sessions.append(_dict_to_session(data))
    return sessions


async def get_session_by_id(
    runtime: IAgentRuntime,
    entity_id: str,
    session_id: str,
) -> FormSession | None:
    """Get a session by its ID."""
    components = await runtime.get_components(entity_id, FORM_SESSION_COMPONENT)
    for comp in components:
        data = comp.get("data", {})
        if isinstance(data, dict) and data.get("id") == session_id:
            return _dict_to_session(data)
    return None


async def save_session(
    runtime: IAgentRuntime,
    session: FormSession,
) -> None:
    """Save a form session (upsert)."""
    component_type = _session_component_type(session.room_id)
    data = _session_to_dict(session)
    await runtime.set_component(
        session.entity_id,
        component_type,
        data,
    )


async def delete_session(
    runtime: IAgentRuntime,
    session: FormSession,
) -> None:
    """Delete a session."""
    component_type = _session_component_type(session.room_id)
    await runtime.delete_component(session.entity_id, component_type)


# ---------------------------------------------------------------------------
# Submission operations
# ---------------------------------------------------------------------------


async def save_submission(
    runtime: IAgentRuntime,
    submission: FormSubmission,
) -> None:
    """Save a form submission (immutable record)."""
    import dataclasses

    component_type = _submission_component_type(submission.form_id, submission.id)
    data = json.loads(json.dumps(dataclasses.asdict(submission), default=str))
    await runtime.set_component(
        submission.entity_id,
        component_type,
        data,
    )


async def get_submissions(
    runtime: IAgentRuntime,
    entity_id: str,
    form_id: str | None = None,
) -> list[FormSubmission]:
    """Get submissions for an entity, optionally filtered by form ID."""
    prefix = FORM_SUBMISSION_COMPONENT
    if form_id:
        prefix = f"{FORM_SUBMISSION_COMPONENT}:{form_id}"
    components = await runtime.get_components(entity_id, prefix)
    results: list[FormSubmission] = []
    for comp in components:
        data = comp.get("data", {})
        if isinstance(data, dict):
            results.append(
                FormSubmission(
                    id=data.get("id", ""),
                    form_id=data.get("form_id", ""),
                    session_id=data.get("session_id", ""),
                    entity_id=data.get("entity_id", ""),
                    values=data.get("values", {}),
                    form_version=data.get("form_version"),
                    mapped_values=data.get("mapped_values"),
                    files=data.get("files"),
                    submitted_at=data.get("submitted_at", 0),
                    meta=data.get("meta"),
                )
            )
    return sorted(results, key=lambda s: s.submitted_at, reverse=True)


async def get_submission_by_id(
    runtime: IAgentRuntime,
    entity_id: str,
    submission_id: str,
) -> FormSubmission | None:
    """Get a specific submission by ID."""
    subs = await get_submissions(runtime, entity_id)
    for s in subs:
        if s.id == submission_id:
            return s
    return None


# ---------------------------------------------------------------------------
# Autofill operations
# ---------------------------------------------------------------------------


async def get_autofill_data(
    runtime: IAgentRuntime,
    entity_id: str,
    form_id: str,
) -> FormAutofillData | None:
    """Get autofill data for a user's form."""
    component_type = _autofill_component_type(form_id)
    components = await runtime.get_components(entity_id, component_type)
    for comp in components:
        data = comp.get("data", {})
        if isinstance(data, dict):
            return FormAutofillData(
                form_id=data.get("form_id", form_id),
                values=data.get("values", {}),
                updated_at=data.get("updated_at", 0),
            )
    return None


async def save_autofill_data(
    runtime: IAgentRuntime,
    entity_id: str,
    form_id: str,
    values: dict[str, Any],
) -> None:
    """Save autofill data for a user's form."""
    import time

    component_type = _autofill_component_type(form_id)
    data = {
        "form_id": form_id,
        "values": values,
        "updated_at": int(time.time() * 1000),
    }
    await runtime.set_component(entity_id, component_type, data)


# ---------------------------------------------------------------------------
# Placeholder: stale/expiring session queries
# ---------------------------------------------------------------------------


async def get_stale_sessions(
    runtime: IAgentRuntime,
    after_inactive_ms: int,
) -> list[FormSession]:
    """Placeholder -- requires database-level query in production."""
    _ = runtime, after_inactive_ms
    return []


async def get_expiring_sessions(
    runtime: IAgentRuntime,
    within_ms: int,
) -> list[FormSession]:
    """Placeholder -- requires database-level query in production."""
    _ = runtime, within_ms
    return []
