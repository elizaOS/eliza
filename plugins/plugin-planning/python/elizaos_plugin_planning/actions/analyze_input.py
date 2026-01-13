from __future__ import annotations

from dataclasses import dataclass
import time


@dataclass
class ActionExample:
    input: str
    output: str


@dataclass
class AnalyzeInputAction:
    @property
    def name(self) -> str:
        return "ANALYZE_INPUT"

    @property
    def similes(self) -> list[str]:
        return ["ANALYZE", "PARSE_INPUT"]

    @property
    def description(self) -> str:
        return "Analyzes user input and extracts key information"

    async def validate(self, message_text: str) -> bool:
        return True

    async def handler(self, params: dict[str, object]) -> dict[str, object]:
        text = params.get("text", "")
        if not isinstance(text, str):
            text = ""

        words = text.split() if text.strip() else []
        has_numbers = any(c.isdigit() for c in text)
        lower_text = text.lower()

        if "urgent" in lower_text or "emergency" in lower_text or "critical" in lower_text:
            sentiment = "urgent"
        elif "good" in lower_text:
            sentiment = "positive"
        elif "bad" in lower_text:
            sentiment = "negative"
        else:
            sentiment = "neutral"

        return {
            "action": "ANALYZE_INPUT",
            "wordCount": len(words),
            "hasNumbers": has_numbers,
            "sentiment": sentiment,
            "topics": [w.lower() for w in words if len(w) >= 5],
            "timestamp": int(time.time() * 1000),
        }

    @property
    def examples(self) -> list[ActionExample]:
        return [
            ActionExample(
                input="Analyze this complex problem",
                output="Analyzing the input...",
            ),
        ]
