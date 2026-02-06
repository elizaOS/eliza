from __future__ import annotations

import time

from elizaos.types import Provider, ProviderResult
from elizaos.types.model import ModelType

from .prompts import MESSAGE_CLASSIFIER_TEMPLATE


async def get_message_classification(runtime, message, _state=None) -> ProviderResult:
    text = message.content.text or ""

    if not text.strip():
        return ProviderResult(
            text="Message classified as: general (empty message)",
            data={
                "classification": "general",
                "confidence": 0.1,
                "complexity": "simple",
                "planningRequired": False,
                "stakeholders": [],
                "constraints": [],
            },
        )

    try:
        prompt = MESSAGE_CLASSIFIER_TEMPLATE.format(text=text)
        response = await runtime.use_model(
            ModelType.TEXT_SMALL,
            {
                "prompt": prompt,
                "temperature": 0.3,
                "maxTokens": 300,
            },
        )

        response_text = str(response)
        lines = response_text.splitlines()

        def _parse_list(prefix: str) -> list[str]:
            line = next((ln for ln in lines if ln.startswith(prefix)), "")
            if not line:
                return []
            raw = line[len(prefix) :].strip()
            if not raw:
                return []
            return [s.strip() for s in raw.split(",") if s.strip()]

        complexity = next(
            (ln[len("COMPLEXITY:") :].strip() for ln in lines if ln.startswith("COMPLEXITY:")),
            "simple",
        )
        planning_type = next(
            (ln[len("PLANNING:") :].strip() for ln in lines if ln.startswith("PLANNING:")),
            "direct_action",
        )
        confidence_str = next(
            (ln[len("CONFIDENCE:") :].strip() for ln in lines if ln.startswith("CONFIDENCE:")),
            "0.5",
        )
        try:
            confidence = float(confidence_str)
        except Exception:
            confidence = 0.5
        confidence = max(0.0, min(1.0, confidence))

        capabilities = _parse_list("CAPABILITIES:")
        stakeholders = _parse_list("STAKEHOLDERS:")
        constraints = _parse_list("CONSTRAINTS:")
        dependencies = _parse_list("DEPENDENCIES:")

        planning_required = planning_type != "direct_action" and complexity != "simple"

        classification = "general"
        lower = text.lower()
        if "strategic" in lower or planning_type == "strategic_planning":
            classification = "strategic"
        elif "analyz" in lower:
            classification = "analysis"
        elif "process" in lower:
            classification = "processing"
        elif "execute" in lower:
            classification = "execution"

        return ProviderResult(
            text=f"Message classified as: {classification} ({complexity} complexity, {planning_type}) with confidence: {confidence}",
            data={
                "classification": classification,
                "confidence": confidence,
                "originalText": text,
                "complexity": complexity,
                "planningType": planning_type,
                "planningRequired": planning_required,
                "capabilities": capabilities,
                "stakeholders": stakeholders,
                "constraints": constraints,
                "dependencies": dependencies,
                "analyzedAt": int(time.time() * 1000),
                "modelUsed": "TEXT_SMALL",
            },
        )
    except Exception as e:
        return ProviderResult(
            text="Message classified as: general with confidence: 0.5 (fallback)",
            data={
                "classification": "general",
                "confidence": 0.5,
                "originalText": text,
                "complexity": "simple",
                "planningRequired": False,
                "planningType": "direct_action",
                "capabilities": [],
                "stakeholders": [],
                "constraints": [],
                "dependencies": [],
                "error": str(e),
                "fallback": True,
            },
        )


message_classifier_provider = Provider(
    name="messageClassifier",
    description="Classifies messages by complexity and planning requirements",
    get=get_message_classification,
)
