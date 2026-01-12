from __future__ import annotations

from dataclasses import dataclass
from elizaos_plugin_planning.actions.analyze_input import ActionExample


@dataclass
class ProcessAnalysisAction:

    @property
    def name(self) -> str:
        return "PROCESS_ANALYSIS"

    @property
    def similes(self) -> list[str]:
        return ["PROCESS", "MAKE_DECISIONS"]

    @property
    def description(self) -> str:
        return "Processes the analysis results and makes decisions"

    async def validate(self, message_text: str) -> bool:
        return True

    async def handler(self, params: dict[str, object]) -> dict[str, object]:
        analysis = params.get("analysis")
        if not analysis or not isinstance(analysis, dict):
            raise ValueError("Missing 'analysis' parameter")

        word_count = analysis.get("wordCount", 0)
        if not isinstance(word_count, int):
            word_count = 0
            
        sentiment = analysis.get("sentiment", "neutral")
        if not isinstance(sentiment, str):
            sentiment = "neutral"

        if sentiment == "positive":
            suggested_response = "Thank you for the positive feedback!"
        elif sentiment == "negative":
            suggested_response = "I understand your concerns and will help address them."
        else:
            suggested_response = "I can help you with that."

        return {
            "action": "PROCESS_ANALYSIS",
            "needsMoreInfo": word_count < 5,
            "isComplex": word_count > 20,
            "requiresAction": sentiment != "neutral" or word_count > 8,
            "suggestedResponse": suggested_response,
        }

    @property
    def examples(self) -> list[ActionExample]:
        return [
            ActionExample(
                input="Process the analysis results",
                output="Processing decisions...",
            ),
        ]
