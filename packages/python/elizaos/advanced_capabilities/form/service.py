"""FormService -- Central service for managing conversational forms.

The FormService is the journey controller. It ensures agents stay on
the path defined by form definitions, guiding users reliably to outcomes.
"""

from __future__ import annotations

import time
import uuid
from typing import TYPE_CHECKING, Any

from elizaos.types import Service, ServiceType

from .builtins import ControlType, register_builtin_types
from .types import (
    ExternalActivation,
    FieldHistoryEntry,
    FieldState,
    FilledFieldSummary,
    FormContextState,
    FormControl,
    FormDefinition,
    FormSession,
    FormSubmission,
    MissingFieldSummary,
    PendingExternalFieldSummary,
    SessionEffort,
    UncertainFieldSummary,
)

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime

from . import storage as form_storage


class FormService(Service):
    """Central service for managing conversational forms."""

    name = "form"
    service_type = ServiceType.FORM if hasattr(ServiceType, "FORM") else "FORM"

    @property
    def capability_description(self) -> str:
        return "Conversational form management with field extraction and session tracking"

    def __init__(self) -> None:
        self._runtime: IAgentRuntime | None = None
        self._forms: dict[str, FormDefinition] = {}
        self._control_types: dict[str, ControlType] = {}

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> FormService:
        service = cls()
        service._runtime = runtime
        # Register built-in control types
        register_builtin_types(service.register_control_type)
        runtime.logger.info(
            "FormService started",
            src="service:form",
            agentId=str(runtime.agent_id),
        )
        return service

    async def stop(self) -> None:
        if self._runtime:
            self._runtime.logger.info(
                "FormService stopped",
                src="service:form",
            )
        self._forms.clear()
        self._control_types.clear()
        self._runtime = None

    # -----------------------------------------------------------------------
    # Form definition management
    # -----------------------------------------------------------------------

    def register_form(self, definition: FormDefinition) -> None:
        self._forms[definition.id] = definition

    def get_form(self, form_id: str) -> FormDefinition | None:
        return self._forms.get(form_id)

    def list_forms(self) -> list[FormDefinition]:
        return list(self._forms.values())

    # -----------------------------------------------------------------------
    # Control type registry
    # -----------------------------------------------------------------------

    def register_control_type(
        self,
        control_type: ControlType,
        *,
        allow_override: bool = False,
    ) -> None:
        existing = self._control_types.get(control_type.id)
        if existing and existing.builtin and not allow_override:
            if self._runtime:
                self._runtime.logger.warn(
                    f"Cannot override built-in type '{control_type.id}' without allow_override=True"
                )
            return
        self._control_types[control_type.id] = control_type

    def get_control_type(self, type_id: str) -> ControlType | None:
        return self._control_types.get(type_id)

    def list_control_types(self) -> list[ControlType]:
        return list(self._control_types.values())

    def is_composite_type(self, type_id: str) -> bool:
        ct = self._control_types.get(type_id)
        return ct is not None and ct.get_sub_controls is not None

    def is_external_type(self, type_id: str) -> bool:
        ct = self._control_types.get(type_id)
        return ct is not None and ct.activate is not None

    def get_sub_controls(self, control: FormControl) -> list[FormControl]:
        ct = self._control_types.get(control.type)
        if ct and ct.get_sub_controls:
            return ct.get_sub_controls(control, self._runtime)
        return []

    # -----------------------------------------------------------------------
    # Session management
    # -----------------------------------------------------------------------

    async def start_session(
        self,
        form_id: str,
        entity_id: str,
        room_id: str,
        *,
        context: dict[str, Any] | None = None,
        initial_values: dict[str, Any] | None = None,
        locale: str | None = None,
    ) -> FormSession:
        definition = self._forms.get(form_id)
        if not definition:
            raise ValueError(f"Form definition not found: {form_id}")

        now = int(time.time() * 1000)
        ttl_ms = definition.ttl.min_days * 24 * 60 * 60 * 1000

        # Build initial field states
        fields: dict[str, FieldState] = {}
        for control in definition.controls:
            fs = FieldState()
            if initial_values and control.key in initial_values:
                fs.value = initial_values[control.key]
                fs.status = "filled"
                fs.source = "manual"
                fs.confidence = 1.0
                fs.updated_at = now
            elif control.default_value is not None:
                fs.value = control.default_value
                fs.status = "filled"
                fs.source = "default"
                fs.confidence = 1.0
                fs.updated_at = now
            fields[control.key] = fs

        session = FormSession(
            id=str(uuid.uuid4()),
            form_id=form_id,
            form_version=definition.version,
            entity_id=entity_id,
            room_id=room_id,
            status="active",
            fields=fields,
            context=context,
            locale=locale,
            effort=SessionEffort(
                first_interaction_at=now,
                last_interaction_at=now,
            ),
            expires_at=now + ttl_ms,
            created_at=now,
            updated_at=now,
        )

        if self._runtime:
            await form_storage.save_session(self._runtime, session)
        return session

    async def get_active_session(self, entity_id: str, room_id: str) -> FormSession | None:
        if not self._runtime:
            return None
        return await form_storage.get_active_session(self._runtime, entity_id, room_id)

    async def get_all_active_sessions(self, entity_id: str) -> list[FormSession]:
        if not self._runtime:
            return []
        return await form_storage.get_all_active_sessions(self._runtime, entity_id)

    async def get_stashed_sessions(self, entity_id: str) -> list[FormSession]:
        if not self._runtime:
            return []
        return await form_storage.get_stashed_sessions(self._runtime, entity_id)

    async def save_session(self, session: FormSession) -> None:
        if self._runtime:
            await form_storage.save_session(self._runtime, session)

    # -----------------------------------------------------------------------
    # Field operations
    # -----------------------------------------------------------------------

    async def update_field(
        self,
        session_id: str,
        entity_id: str,
        field_key: str,
        value: Any,
        confidence: float,
        source: str,
        message_id: str | None = None,
    ) -> None:
        if not self._runtime:
            return
        session = await form_storage.get_session_by_id(self._runtime, entity_id, session_id)
        if not session:
            raise ValueError(f"Session not found: {session_id}")

        now = int(time.time() * 1000)
        old_state = session.fields.get(field_key, FieldState())

        # Record history for undo
        if old_state.value is not None:
            session.history.append(
                FieldHistoryEntry(
                    field=field_key,
                    old_value=old_state.value,
                    new_value=value,
                    timestamp=now,
                )
            )
            # Trim history
            definition = self._forms.get(session.form_id)
            max_undo = definition.ux.max_undo_steps if definition else 5
            session.history = session.history[-max_undo:]

        # Find control for threshold
        control = self._find_control(session.form_id, field_key)
        threshold = control.confirm_threshold if control else 0.8

        new_state = FieldState(
            status="filled" if confidence >= threshold else "uncertain",
            value=value,
            confidence=confidence,
            source=source,  # type: ignore[arg-type]
            message_id=message_id,
            updated_at=now,
        )
        session.fields[field_key] = new_state

        # Update effort
        session.effort.interaction_count += 1
        session.effort.last_interaction_at = now
        if session.effort.time_spent_ms == 0:
            session.effort.time_spent_ms = now - session.effort.first_interaction_at
        else:
            session.effort.time_spent_ms = now - session.effort.first_interaction_at

        # Check if all required fields filled
        if self._check_all_required_filled(session):
            session.status = "ready"

        session.updated_at = now
        await form_storage.save_session(self._runtime, session)

    async def undo_last_change(self, session_id: str, entity_id: str) -> dict[str, Any] | None:
        if not self._runtime:
            return None
        session = await form_storage.get_session_by_id(self._runtime, entity_id, session_id)
        if not session or not session.history:
            return None

        entry = session.history.pop()
        field_state = session.fields.get(entry.field, FieldState())
        field_state.value = entry.old_value
        field_state.status = "filled" if entry.old_value is not None else "empty"
        field_state.updated_at = int(time.time() * 1000)
        session.fields[entry.field] = field_state
        session.updated_at = int(time.time() * 1000)
        await form_storage.save_session(self._runtime, session)
        return {"field": entry.field, "restored_value": entry.old_value}

    async def skip_field(self, session_id: str, entity_id: str, field_key: str) -> bool:
        if not self._runtime:
            return False
        session = await form_storage.get_session_by_id(self._runtime, entity_id, session_id)
        if not session:
            return False

        control = self._find_control(session.form_id, field_key)
        if control and control.required:
            return False  # Cannot skip required fields

        now = int(time.time() * 1000)
        session.fields[field_key] = FieldState(status="skipped", updated_at=now)
        session.updated_at = now
        await form_storage.save_session(self._runtime, session)
        return True

    async def confirm_field(
        self,
        session_id: str,
        entity_id: str,
        field_key: str,
        accepted: bool,
    ) -> None:
        if not self._runtime:
            return
        session = await form_storage.get_session_by_id(self._runtime, entity_id, session_id)
        if not session:
            return

        now = int(time.time() * 1000)
        field_state = session.fields.get(field_key)
        if not field_state:
            return

        if accepted:
            field_state.status = "filled"
            field_state.confirmed_at = now
        else:
            field_state.status = "empty"
            field_state.value = None
            field_state.confidence = None

        field_state.updated_at = now
        session.updated_at = now
        await form_storage.save_session(self._runtime, session)

    # -----------------------------------------------------------------------
    # Composite / external field operations
    # -----------------------------------------------------------------------

    async def update_sub_field(
        self,
        session_id: str,
        entity_id: str,
        parent_field: str,
        sub_field: str,
        value: Any,
        confidence: float,
        message_id: str | None = None,
    ) -> None:
        if not self._runtime:
            return
        session = await form_storage.get_session_by_id(self._runtime, entity_id, session_id)
        if not session:
            raise ValueError(f"Session not found: {session_id}")

        now = int(time.time() * 1000)
        parent_state = session.fields.get(parent_field)
        if not parent_state:
            parent_state = FieldState()
            session.fields[parent_field] = parent_state

        if parent_state.sub_fields is None:
            parent_state.sub_fields = {}

        parent_state.sub_fields[sub_field] = FieldState(
            status="filled" if confidence >= 0.8 else "uncertain",
            value=value,
            confidence=confidence,
            source="extraction",
            message_id=message_id,
            updated_at=now,
        )

        # Check if all subfields are filled
        if self.are_sub_fields_filled(session, parent_field):
            parent_state.status = "filled"

        parent_state.updated_at = now
        session.updated_at = now
        await form_storage.save_session(self._runtime, session)

    def are_sub_fields_filled(self, session: FormSession, parent_field: str) -> bool:
        parent_state = session.fields.get(parent_field)
        if not parent_state or not parent_state.sub_fields:
            return False

        control = self._find_control(session.form_id, parent_field)
        if not control:
            return False

        sub_controls = self.get_sub_controls(control)
        for sc in sub_controls:
            if sc.required:
                sub_state = parent_state.sub_fields.get(sc.key)
                if not sub_state or sub_state.status != "filled":
                    return False
        return True

    def get_sub_field_values(self, session: FormSession, parent_field: str) -> dict[str, Any]:
        parent_state = session.fields.get(parent_field)
        if not parent_state or not parent_state.sub_fields:
            return {}
        return {k: v.value for k, v in parent_state.sub_fields.items() if v.value is not None}

    async def activate_external_field(
        self,
        session_id: str,
        entity_id: str,
        field_key: str,
    ) -> ExternalActivation:
        if not self._runtime:
            raise RuntimeError("Runtime not available")

        session = await form_storage.get_session_by_id(self._runtime, entity_id, session_id)
        if not session:
            raise ValueError(f"Session not found: {session_id}")

        control = self._find_control(session.form_id, field_key)
        if not control:
            raise ValueError(f"Control not found: {field_key}")

        ct = self._control_types.get(control.type)
        if not ct or not ct.activate:
            raise ValueError(f"Control type '{control.type}' does not support activation")

        from .types import ExternalFieldState

        sub_values = self.get_sub_field_values(session, field_key)
        activation = await ct.activate(
            {
                "runtime": self._runtime,
                "session": session,
                "control": control,
                "sub_values": sub_values,
            }
        )

        now = int(time.time() * 1000)
        field_state = session.fields.get(field_key, FieldState())
        field_state.status = "pending"
        field_state.external_state = ExternalFieldState(
            status="pending",
            reference=activation.reference,
            instructions=activation.instructions,
            address=activation.address,
            activated_at=now,
        )
        field_state.updated_at = now
        session.fields[field_key] = field_state
        session.updated_at = now
        await form_storage.save_session(self._runtime, session)
        return activation

    async def confirm_external_field(
        self,
        session_id: str,
        entity_id: str,
        field_key: str,
        value: Any,
        external_data: dict[str, Any] | None = None,
    ) -> None:
        if not self._runtime:
            return
        session = await form_storage.get_session_by_id(self._runtime, entity_id, session_id)
        if not session:
            return

        now = int(time.time() * 1000)
        field_state = session.fields.get(field_key)
        if not field_state:
            return

        field_state.status = "filled"
        field_state.value = value
        field_state.source = "external"
        field_state.updated_at = now
        if field_state.external_state:
            field_state.external_state.status = "confirmed"
            field_state.external_state.confirmed_at = now
            field_state.external_state.external_data = external_data

        if self._check_all_required_filled(session):
            session.status = "ready"

        session.updated_at = now
        await form_storage.save_session(self._runtime, session)

    async def cancel_external_field(
        self,
        session_id: str,
        entity_id: str,
        field_key: str,
        reason: str,
    ) -> None:
        if not self._runtime:
            return
        session = await form_storage.get_session_by_id(self._runtime, entity_id, session_id)
        if not session:
            return

        now = int(time.time() * 1000)
        field_state = session.fields.get(field_key)
        if field_state and field_state.external_state:
            field_state.external_state.status = "failed"
            field_state.status = "empty"
            field_state.updated_at = now

        session.updated_at = now
        await form_storage.save_session(self._runtime, session)

    # -----------------------------------------------------------------------
    # Lifecycle operations
    # -----------------------------------------------------------------------

    async def submit(self, session_id: str, entity_id: str) -> FormSubmission:
        if not self._runtime:
            raise RuntimeError("Runtime not available")

        session = await form_storage.get_session_by_id(self._runtime, entity_id, session_id)
        if not session:
            raise ValueError(f"Session not found: {session_id}")

        now = int(time.time() * 1000)
        values = self.get_values(session)
        mapped_values = self.get_mapped_values(session)

        submission = FormSubmission(
            id=str(uuid.uuid4()),
            form_id=session.form_id,
            form_version=session.form_version,
            session_id=session.id,
            entity_id=entity_id,
            values=values,
            mapped_values=mapped_values,
            submitted_at=now,
        )

        session.status = "submitted"
        session.submitted_at = now
        session.updated_at = now

        await form_storage.save_submission(self._runtime, submission)
        await form_storage.save_session(self._runtime, session)

        # Save autofill data
        await form_storage.save_autofill_data(self._runtime, entity_id, session.form_id, values)

        return submission

    async def stash(self, session_id: str, entity_id: str) -> None:
        if not self._runtime:
            return
        session = await form_storage.get_session_by_id(self._runtime, entity_id, session_id)
        if not session:
            raise ValueError(f"Session not found: {session_id}")

        session.status = "stashed"
        session.updated_at = int(time.time() * 1000)
        await form_storage.save_session(self._runtime, session)

    async def restore(self, session_id: str, entity_id: str) -> FormSession:
        if not self._runtime:
            raise RuntimeError("Runtime not available")

        session = await form_storage.get_session_by_id(self._runtime, entity_id, session_id)
        if not session:
            raise ValueError(f"Session not found: {session_id}")

        session.status = "active"
        session.updated_at = int(time.time() * 1000)
        await form_storage.save_session(self._runtime, session)
        return session

    async def cancel(self, session_id: str, entity_id: str, force: bool = False) -> bool:
        if not self._runtime:
            return False
        session = await form_storage.get_session_by_id(self._runtime, entity_id, session_id)
        if not session:
            return False

        if not force and self.should_confirm_cancel(session):
            session.cancel_confirmation_asked = True
            session.updated_at = int(time.time() * 1000)
            await form_storage.save_session(self._runtime, session)
            return False

        session.status = "cancelled"
        session.updated_at = int(time.time() * 1000)
        await form_storage.save_session(self._runtime, session)
        return True

    # -----------------------------------------------------------------------
    # Queries
    # -----------------------------------------------------------------------

    async def get_submissions(
        self, entity_id: str, form_id: str | None = None
    ) -> list[FormSubmission]:
        if not self._runtime:
            return []
        return await form_storage.get_submissions(self._runtime, entity_id, form_id)

    async def get_autofill(self, entity_id: str, form_id: str) -> dict[str, Any] | None:
        if not self._runtime:
            return None
        data = await form_storage.get_autofill_data(self._runtime, entity_id, form_id)
        return data.values if data else None

    async def apply_autofill(self, session: FormSession) -> list[str]:
        """Apply autofill to a session, returns list of filled field keys."""
        if not self._runtime:
            return []
        autofill = await form_storage.get_autofill_data(
            self._runtime, session.entity_id, session.form_id
        )
        if not autofill:
            return []

        filled: list[str] = []
        now = int(time.time() * 1000)
        for key, value in autofill.values.items():
            field_state = session.fields.get(key)
            if field_state and field_state.status == "empty":
                field_state.value = value
                field_state.status = "filled"
                field_state.source = "autofill"
                field_state.confidence = 1.0
                field_state.updated_at = now
                filled.append(key)

        if filled:
            session.updated_at = now
            await form_storage.save_session(self._runtime, session)
        return filled

    # -----------------------------------------------------------------------
    # Context helpers
    # -----------------------------------------------------------------------

    def get_session_context(self, session: FormSession) -> FormContextState:
        definition = self._forms.get(session.form_id)
        if not definition:
            return FormContextState()

        filled: list[FilledFieldSummary] = []
        missing_required: list[MissingFieldSummary] = []
        uncertain: list[UncertainFieldSummary] = []
        pending_external: list[PendingExternalFieldSummary] = []

        for control in definition.controls:
            fs = session.fields.get(control.key, FieldState())

            if fs.status == "filled":
                display = "***" if control.sensitive else str(fs.value or "")
                filled.append(
                    FilledFieldSummary(key=control.key, label=control.label, display_value=display)
                )
            elif fs.status == "uncertain":
                uncertain.append(
                    UncertainFieldSummary(
                        key=control.key,
                        label=control.label,
                        value=fs.value,
                        confidence=fs.confidence or 0.0,
                    )
                )
            elif fs.status == "pending" and fs.external_state:
                pending_external.append(
                    PendingExternalFieldSummary(
                        key=control.key,
                        label=control.label,
                        instructions=fs.external_state.instructions or "",
                        reference=fs.external_state.reference or "",
                        activated_at=fs.external_state.activated_at or 0,
                        address=fs.external_state.address,
                    )
                )
            elif control.required and fs.status in ("empty", "invalid"):
                missing_required.append(
                    MissingFieldSummary(
                        key=control.key,
                        label=control.label,
                        description=control.description,
                        ask_prompt=control.ask_prompt,
                    )
                )

        total = len(definition.controls)
        filled_count = len(filled) + len(
            [
                c
                for c in definition.controls
                if session.fields.get(c.key, FieldState()).status == "skipped"
            ]
        )
        progress = (filled_count / total * 100) if total > 0 else 0

        next_field: FormControl | None = None
        if missing_required:
            next_field = self._find_control(session.form_id, missing_required[0].key)

        return FormContextState(
            has_active_form=True,
            form_id=definition.id,
            form_name=definition.name,
            progress=progress,
            filled_fields=filled,
            missing_required=missing_required,
            uncertain_fields=uncertain,
            next_field=next_field,
            status=session.status,
            pending_cancel_confirmation=session.cancel_confirmation_asked,
            pending_external_fields=pending_external,
        )

    def get_values(self, session: FormSession) -> dict[str, Any]:
        return {
            k: v.value
            for k, v in session.fields.items()
            if v.value is not None and v.status in ("filled", "uncertain")
        }

    def get_mapped_values(self, session: FormSession) -> dict[str, Any]:
        definition = self._forms.get(session.form_id)
        if not definition:
            return self.get_values(session)

        result: dict[str, Any] = {}
        for control in definition.controls:
            fs = session.fields.get(control.key)
            if fs and fs.value is not None and fs.status in ("filled", "uncertain"):
                mapped_key = control.dbbind or control.key
                result[mapped_key] = fs.value
        return result

    def calculate_ttl(self, session: FormSession) -> int:
        """Calculate TTL in milliseconds based on effort."""
        definition = self._forms.get(session.form_id)
        if not definition:
            return 14 * 24 * 60 * 60 * 1000

        effort_minutes = session.effort.time_spent_ms / (1000 * 60)
        extra_days = effort_minutes * definition.ttl.effort_multiplier
        total_days = max(
            definition.ttl.min_days,
            min(definition.ttl.min_days + extra_days, definition.ttl.max_days),
        )
        return int(total_days * 24 * 60 * 60 * 1000)

    def should_confirm_cancel(self, session: FormSession) -> bool:
        """Return True if cancel should require confirmation (user invested effort)."""
        filled_count = sum(1 for fs in session.fields.values() if fs.status == "filled")
        return filled_count >= 2 and not session.cancel_confirmation_asked

    # -----------------------------------------------------------------------
    # Internal helpers
    # -----------------------------------------------------------------------

    def _find_control(self, form_id: str, field_key: str) -> FormControl | None:
        definition = self._forms.get(form_id)
        if not definition:
            return None
        for control in definition.controls:
            if control.key == field_key:
                return control
        return None

    def _check_all_required_filled(self, session: FormSession) -> bool:
        definition = self._forms.get(session.form_id)
        if not definition:
            return False
        for control in definition.controls:
            if control.required:
                fs = session.fields.get(control.key, FieldState())
                if fs.status not in ("filled",):
                    return False
        return True
