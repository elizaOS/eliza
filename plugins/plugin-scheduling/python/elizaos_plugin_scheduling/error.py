"""Error types for the scheduling plugin."""

from __future__ import annotations


class SchedulingError(Exception):
    """Base error for scheduling operations."""


class MeetingNotFoundError(SchedulingError):
    """Raised when a meeting is not found."""

    def __init__(self, meeting_id: str) -> None:
        self.meeting_id = meeting_id
        super().__init__(f"Meeting not found: {meeting_id}")


class ParticipantNotFoundError(SchedulingError):
    """Raised when a participant is not found in a meeting."""

    def __init__(self, entity_id: str, meeting_id: str) -> None:
        self.entity_id = entity_id
        self.meeting_id = meeting_id
        super().__init__(f"Participant not found in meeting: {entity_id}")


class NoAvailabilityError(SchedulingError):
    """Raised when no availability data is found for an entity."""

    def __init__(self, entity_id: str) -> None:
        self.entity_id = entity_id
        super().__init__(f"No availability found for entity: {entity_id}")


class StorageError(SchedulingError):
    """Raised on storage operation failures."""


class ServiceNotAvailableError(SchedulingError):
    """Raised when the scheduling service is not available."""

    def __init__(self) -> None:
        super().__init__("Scheduling service is not available")


class ValidationError(SchedulingError):
    """Raised when input validation fails."""
