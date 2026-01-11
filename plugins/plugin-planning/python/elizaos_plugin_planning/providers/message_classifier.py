"""Message Classifier Provider - Classifies incoming messages for planning."""

import logging
from typing import Any, Optional

from elizaos_plugin_planning.types import ClassificationResult

logger = logging.getLogger(__name__)


class MessageClassifierProvider:
    """
    Classifies incoming messages by complexity and planning requirements.

    Uses LLM analysis to determine if strategic planning, sequential execution,
    or direct action is needed.
    """

    name = "messageClassifier"
    description = (
        "Classifies incoming messages by complexity and planning requirements "
        "using intelligent LLM analysis. Use to determine if strategic planning, "
        "sequential execution, or direct action is needed."
    )

    async def get(
        self,
        runtime: Any,
        message: dict[str, Any],
        state: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Classify a message for planning purposes."""
        text = message.get("content", {}).get("text") or ""

        if not text.strip():
            return {
                "text": "Message classified as: general (empty message)",
                "data": ClassificationResult(
                    classification="general",
                    confidence=0.1,
                    complexity="simple",
                    planning_type="direct_action",
                    planning_required=False,
                ),
            }

        try:
            classification_prompt = f"""Analyze this user request and classify it for planning purposes:

"{text}"

Classify the request across these dimensions:

1. COMPLEXITY LEVEL:
- simple: Direct actions that don't require planning
- medium: Multi-step tasks requiring coordination  
- complex: Strategic initiatives with multiple stakeholders
- enterprise: Large-scale transformations with full complexity

2. PLANNING TYPE:
- direct_action: Single action, no planning needed
- sequential_planning: Multiple steps in sequence
- strategic_planning: Complex coordination with stakeholders

3. REQUIRED CAPABILITIES:
- List specific capabilities needed (analysis, communication, project_management, etc.)

4. STAKEHOLDERS:
- List types of people/groups involved

5. CONSTRAINTS:
- List limitations or requirements mentioned

6. DEPENDENCIES:
- List dependencies between tasks or external factors

Respond in this exact format:
COMPLEXITY: [simple|medium|complex|enterprise]
PLANNING: [direct_action|sequential_planning|strategic_planning]  
CAPABILITIES: [comma-separated list]
STAKEHOLDERS: [comma-separated list]
CONSTRAINTS: [comma-separated list]
DEPENDENCIES: [comma-separated list]
CONFIDENCE: [0.0-1.0]"""

            if hasattr(runtime, "use_model"):
                response = await runtime.use_model(
                    "TEXT_SMALL",
                    {
                        "prompt": classification_prompt,
                        "temperature": 0.3,
                        "max_tokens": 300,
                    },
                )
                response_text = str(response)
            else:
                # Fallback for testing without runtime
                response_text = self._classify_heuristically(text)

            # Parse LLM response
            lines = response_text.split("\n")

            def parse_field(prefix: str) -> list[str]:
                for line in lines:
                    if line.startswith(prefix):
                        value = line[len(prefix) :].strip()
                        if value:
                            return [s.strip() for s in value.split(",") if s.strip()]
                return []

            def parse_single(prefix: str, default: str) -> str:
                for line in lines:
                    if line.startswith(prefix):
                        return line[len(prefix) :].strip() or default
                return default

            complexity = parse_single("COMPLEXITY:", "simple")
            planning_type = parse_single("PLANNING:", "direct_action")
            confidence_str = parse_single("CONFIDENCE:", "0.5")
            confidence = max(0.0, min(1.0, float(confidence_str) if confidence_str else 0.5))

            capabilities = parse_field("CAPABILITIES:")
            stakeholders = parse_field("STAKEHOLDERS:")
            constraints = parse_field("CONSTRAINTS:")
            dependencies = parse_field("DEPENDENCIES:")

            planning_required = planning_type != "direct_action" and complexity != "simple"

            # Map to legacy classification
            text_lower = text.lower()
            if "strategic" in text_lower or planning_type == "strategic_planning":
                legacy_classification = "strategic"
            elif "analyz" in text_lower:
                legacy_classification = "analysis"
            elif "process" in text_lower:
                legacy_classification = "processing"
            elif "execute" in text_lower:
                legacy_classification = "execution"
            else:
                legacy_classification = "general"

            result = ClassificationResult(
                classification=legacy_classification,
                confidence=confidence,
                complexity=complexity,
                planning_type=planning_type,
                planning_required=planning_required,
                capabilities=capabilities,
                stakeholders=stakeholders,
                constraints=constraints,
                dependencies=dependencies,
            )

            return {
                "text": (
                    f"Message classified as: {legacy_classification} "
                    f"({complexity} complexity, {planning_type}) "
                    f"with confidence: {confidence}"
                ),
                "data": result,
            }

        except Exception as e:
            logger.warning(f"LLM classification failed, using fallback: {e}")
            return self._fallback_classification(text)

    def _classify_heuristically(self, text: str) -> str:
        """Heuristic classification for testing."""
        text_lower = text.lower()

        if any(word in text_lower for word in ["strategy", "plan", "strategic"]):
            complexity = "complex"
            planning_type = "strategic_planning"
            confidence = "0.7"
        elif any(word in text_lower for word in ["analyze", "analysis"]):
            complexity = "medium"
            planning_type = "sequential_planning"
            confidence = "0.8"
        elif any(word in text_lower for word in ["process", "processing"]):
            complexity = "medium"
            planning_type = "sequential_planning"
            confidence = "0.8"
        elif any(word in text_lower for word in ["execute", "final"]):
            complexity = "simple"
            planning_type = "direct_action"
            confidence = "0.8"
        else:
            complexity = "simple"
            planning_type = "direct_action"
            confidence = "0.5"

        return f"""COMPLEXITY: {complexity}
PLANNING: {planning_type}
CAPABILITIES: analysis
STAKEHOLDERS: user
CONSTRAINTS: 
DEPENDENCIES: 
CONFIDENCE: {confidence}"""

    def _fallback_classification(self, text: str) -> dict[str, Any]:
        """Fallback classification when LLM fails."""
        text_lower = text.lower()
        classification = "general"
        confidence = 0.5

        if any(word in text_lower for word in ["strategy", "plan", "strategic"]):
            classification = "strategic"
            confidence = 0.7
        elif any(word in text_lower for word in ["analyze", "analysis"]):
            classification = "analysis"
            confidence = 0.8
        elif any(word in text_lower for word in ["process", "processing"]):
            classification = "processing"
            confidence = 0.8
        elif any(word in text_lower for word in ["execute", "final"]):
            classification = "execution"
            confidence = 0.8

        result = ClassificationResult(
            classification=classification,
            confidence=confidence,
            complexity="simple",
            planning_type="direct_action",
            planning_required=False,
        )

        return {
            "text": f"Message classified as: {classification} with confidence: {confidence} (fallback)",
            "data": result,
        }





