from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar, Protocol

from elizaos_plugin_experience.prompts import build_extract_experiences_prompt
from elizaos_plugin_experience.service import ExperienceService
from elizaos_plugin_experience.types import ExperienceType, OutcomeType

if TYPE_CHECKING:
    from elizaos_plugin_experience.types import ExperienceQuery


def _coerce_float(value: object) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


class ModelFn(Protocol):
    async def __call__(self, prompt: str) -> str: ...


@dataclass
class ExtractedExperience:
    type: str | None = None
    learning: str | None = None
    context: str | None = None
    confidence: float | None = None
    reasoning: str | None = None


@dataclass
class ExperienceEvaluator:
    name: ClassVar[str] = "EXPERIENCE_EVALUATOR"
    description: ClassVar[str] = (
        "Periodically analyzes conversation patterns to extract novel learning experiences"
    )

    @staticmethod
    def parse_extracted_experiences(response: str) -> list[ExtractedExperience]:
        match = re.search(r"\[[\s\S]*\]", response)
        if not match:
            return []

        try:
            raw = json.loads(match.group(0))
        except json.JSONDecodeError:
            return []

        if not isinstance(raw, list):
            return []

        out: list[ExtractedExperience] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            out.append(
                ExtractedExperience(
                    type=str(item.get("type")) if item.get("type") is not None else None,
                    learning=str(item.get("learning"))
                    if item.get("learning") is not None
                    else None,
                    context=str(item.get("context")) if item.get("context") is not None else None,
                    confidence=_coerce_float(item.get("confidence")),
                    reasoning=str(item.get("reasoning"))
                    if item.get("reasoning") is not None
                    else None,
                )
            )
        return out

    @staticmethod
    async def handler(
        *,
        service: ExperienceService,
        model_fn: ModelFn,
        agent_id: str,
        conversation_context: str,
        threshold: float = 0.7,
    ) -> int:
        existing = service.query_experiences(
            query=service_query_from_text(conversation_context, limit=10, min_confidence=0.7),
        )
        existing_text = "\n".join(f"- {e.learning}" for e in existing) if existing else "None"

        prompt = build_extract_experiences_prompt(
            conversation_context=conversation_context,
            existing_experiences=existing_text,
        )

        response = await model_fn(prompt)
        extracted = ExperienceEvaluator.parse_extracted_experiences(response)

        type_map: dict[str, ExperienceType] = {
            "DISCOVERY": ExperienceType.DISCOVERY,
            "CORRECTION": ExperienceType.CORRECTION,
            "SUCCESS": ExperienceType.SUCCESS,
            "LEARNING": ExperienceType.LEARNING,
        }

        recorded = 0
        for exp in extracted[:3]:
            if not exp.learning or exp.confidence is None or exp.confidence < threshold:
                continue

            normalized_type = exp.type.upper() if exp.type else ""
            experience_type = type_map.get(normalized_type, ExperienceType.LEARNING)
            outcome = (
                OutcomeType.POSITIVE
                if experience_type == ExperienceType.CORRECTION
                else OutcomeType.NEUTRAL
            )

            service.record_experience(
                agent_id=agent_id,
                context=sanitize_context(exp.context or "Conversation analysis"),
                action="pattern_recognition",
                result=exp.learning,
                learning=sanitize_context(exp.learning),
                experience_type=experience_type,
                outcome=outcome,
                domain=detect_domain(exp.learning),
                tags=["extracted", "novel", experience_type.value],
                confidence=min(exp.confidence, 0.9),
                importance=0.8,
            )
            recorded += 1

        return recorded


def service_query_from_text(text: str, *, limit: int, min_confidence: float) -> ExperienceQuery:
    from elizaos_plugin_experience.types import ExperienceQuery

    return ExperienceQuery(query=text, limit=limit, min_confidence=min_confidence)


def sanitize_context(text: str) -> str:
    if not text:
        return "Unknown context"

    sanitized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    sanitized = re.sub(
        r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b",
        "[EMAIL]",
        sanitized,
    )
    sanitized = re.sub(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", "[IP]", sanitized)
    sanitized = re.sub(r"/Users/[^/\s]+", "/Users/[USER]", sanitized)
    sanitized = re.sub(r"/home/[^/\s]+", "/home/[USER]", sanitized)
    sanitized = re.sub(r"\b[A-Z0-9]{20,}\b", "[TOKEN]", sanitized)
    sanitized = re.sub(
        r"\b(user|person|someone|they)\s+(said|asked|told|mentioned)\b",
        "when asked",
        sanitized,
        flags=re.IGNORECASE,
    )
    return sanitized[:200]


def detect_domain(text: str) -> str:
    domains: dict[str, list[str]] = {
        "shell": ["command", "terminal", "bash", "shell", "execute", "script", "cli"],
        "coding": [
            "code",
            "function",
            "variable",
            "syntax",
            "programming",
            "debug",
            "typescript",
            "javascript",
        ],
        "system": ["file", "directory", "process", "memory", "cpu", "system", "install", "package"],
        "network": ["http", "api", "request", "response", "url", "network", "fetch", "curl"],
        "data": ["json", "csv", "database", "query", "data", "sql", "table"],
        "ai": ["model", "llm", "embedding", "prompt", "token", "inference"],
    }

    lower = text.lower()
    for domain, keywords in domains.items():
        if any(k in lower for k in keywords):
            return domain
    return "general"
