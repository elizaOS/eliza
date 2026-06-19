"""Shared trajectory envelope helpers."""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, Mapping, Optional


SCHEMA_VERSION = "loca_traj_v1"


def make_base_envelope(
    backend: str,
    task: Mapping[str, Any],
    *,
    conversation: Optional[Mapping[str, Any]] = None,
    events: Optional[Mapping[str, Any]] = None,
    metrics: Optional[Mapping[str, Any]] = None,
    provider_payload: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """Create the base normalized trajectory envelope."""
    return {
        "schema_version": SCHEMA_VERSION,
        "backend": backend,
        "task": deepcopy(dict(task)),
        "conversation": deepcopy(dict(conversation or {})),
        "events": deepcopy(dict(events or {})),
        "metrics": deepcopy(dict(metrics or {})),
        "provider_payload": deepcopy(dict(provider_payload or {})),
    }


def _attach_section(
    envelope: Dict[str, Any],
    section: str,
    payload: Optional[Mapping[str, Any]] = None,
    **kwargs: Any,
) -> Dict[str, Any]:
    section_data = envelope.setdefault(section, {})
    if payload:
        section_data.update(deepcopy(dict(payload)))
    if kwargs:
        section_data.update(deepcopy(kwargs))
    return envelope


def attach_conversation(
    envelope: Dict[str, Any],
    payload: Optional[Mapping[str, Any]] = None,
    **kwargs: Any,
) -> Dict[str, Any]:
    """Attach normalized conversation fields to the envelope."""
    return _attach_section(envelope, "conversation", payload, **kwargs)


def attach_events(
    envelope: Dict[str, Any],
    payload: Optional[Mapping[str, Any]] = None,
    **kwargs: Any,
) -> Dict[str, Any]:
    """Attach normalized event fields to the envelope."""
    return _attach_section(envelope, "events", payload, **kwargs)


def attach_metrics(
    envelope: Dict[str, Any],
    payload: Optional[Mapping[str, Any]] = None,
    **kwargs: Any,
) -> Dict[str, Any]:
    """Attach normalized metric fields to the envelope."""
    return _attach_section(envelope, "metrics", payload, **kwargs)


def attach_provider_payload(
    envelope: Dict[str, Any],
    payload: Optional[Mapping[str, Any]] = None,
    **kwargs: Any,
) -> Dict[str, Any]:
    """Attach backend-specific fields to the envelope."""
    return _attach_section(envelope, "provider_payload", payload, **kwargs)
