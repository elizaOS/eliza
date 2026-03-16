"""
elizaOS Experience Plugin - Experience learning and recall.

This Python package provides an in-memory implementation of the Experience plugin primitives:
- Experience types and queries
- Prompt helpers for extracting experiences
- A simple ExperienceService for recording and querying experiences
"""

from elizaos_plugin_experience.actions import RecordExperienceAction
from elizaos_plugin_experience.evaluators import ExperienceEvaluator
from elizaos_plugin_experience.prompts import (
    EXTRACT_EXPERIENCES_TEMPLATE,
    build_extract_experiences_prompt,
)
from elizaos_plugin_experience.providers import ExperienceProvider
from elizaos_plugin_experience.service import ExperienceService
from elizaos_plugin_experience.types import (
    Experience,
    ExperienceAnalysis,
    ExperienceEvent,
    ExperienceQuery,
    ExperienceTimeRange,
    ExperienceType,
    JsonValue,
    OutcomeType,
)

__all__ = [
    # Actions
    "RecordExperienceAction",
    # Evaluators
    "ExperienceEvaluator",
    # Providers
    "ExperienceProvider",
    # Service
    "ExperienceService",
    # Types
    "JsonValue",
    "ExperienceType",
    "OutcomeType",
    "Experience",
    "ExperienceQuery",
    "ExperienceTimeRange",
    "ExperienceAnalysis",
    "ExperienceEvent",
    # Prompts
    "EXTRACT_EXPERIENCES_TEMPLATE",
    "build_extract_experiences_prompt",
]

__version__ = "1.2.0"
PLUGIN_NAME = "experience"
PLUGIN_DESCRIPTION = "Experience learning and recall for elizaOS agents"
