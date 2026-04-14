from __future__ import annotations

import re
import time
from uuid import uuid4

from elizaos.types import Action, ActionResult


async def _always_validate(_runtime, _message, _state=None) -> bool:
    return True


async def analyze_input_handler(
    _runtime, message, _state=None, options=None, _callback=None, _responses=None
):
    abort_signal = getattr(options, "abort_signal", None)
    if abort_signal is not None and getattr(abort_signal, "aborted", False):
        raise RuntimeError("Analysis aborted")

    text = message.content.text or ""
    words = text.split() if text.strip() else []
    sentiment = "neutral"
    lower = text.lower()
    if any(w in lower for w in ["urgent", "emergency", "critical"]):
        sentiment = "urgent"
    elif "good" in lower:
        sentiment = "positive"
    elif "bad" in lower:
        sentiment = "negative"

    return ActionResult(
        success=True,
        text=f"Analyzed {len(words)} words with {sentiment} sentiment",
        data={
            "wordCount": len(words),
            "hasNumbers": bool(re.search(r"\d", text)),
            "sentiment": sentiment,
            "topics": [w.lower() for w in words if len(w) >= 5],
            "timestamp": int(time.time() * 1000),
        },
    )


async def process_analysis_handler(
    _runtime, _message, _state=None, options=None, _callback=None, _responses=None
):
    previous = getattr(options, "previous_results", None) or []
    prev0 = previous[0] if previous else None
    analysis = getattr(prev0, "data", None) or {}
    word_count = int(analysis.get("wordCount") or 0)
    sentiment = str(analysis.get("sentiment") or "neutral")

    decisions = {
        "needsMoreInfo": word_count < 5,
        "isComplex": word_count > 20,
        "requiresAction": sentiment != "neutral" or word_count > 8,
        "suggestedResponse": (
            "Thank you for the positive feedback!"
            if sentiment == "positive"
            else "I understand your concerns and will help address them."
            if sentiment == "negative"
            else "I can help you with that."
        ),
    }

    return ActionResult(
        success=True,
        text=str(decisions["suggestedResponse"]),
        data={
            "analysis": analysis,
            "decisions": decisions,
            "processedAt": int(time.time() * 1000),
            "shouldContinue": not decisions["needsMoreInfo"],
        },
    )


async def execute_final_handler(
    _runtime, _message, _state=None, options=None, callback=None, _responses=None
):
    previous = getattr(options, "previous_results", None) or []
    decisions = None
    for r in previous:
        data = getattr(r, "data", None) or {}
        if "decisions" in data:
            decisions = data.get("decisions")
            break
    if not isinstance(decisions, dict):
        raise RuntimeError("No processing results available")

    msg = str(decisions.get("suggestedResponse") or "Done")
    if callback is not None:
        await callback({"text": msg, "source": "chain_example"})

    return ActionResult(success=True, text=msg, data={"action": "RESPOND", "message": msg})


async def create_plan_validate(_runtime, message, _state=None) -> bool:
    text = (message.content.text or "").lower()
    return any(k in text for k in ["plan", "project", "comprehensive", "organize", "strategy"])


async def create_plan_handler(
    _runtime, _message, _state=None, _options=None, callback=None, _responses=None
):
    plan_id = str(uuid4())
    if callback is not None:
        await callback(
            {
                "text": "I've created a comprehensive project plan.",
                "actions": ["CREATE_PLAN"],
                "source": "planning",
            }
        )
    return ActionResult(success=True, text="Created plan", data={"planId": plan_id})


analyze_input_action = Action(
    name="ANALYZE_INPUT",
    description="Analyzes user input and extracts key information",
    validate=_always_validate,
    handler=analyze_input_handler,
)

process_analysis_action = Action(
    name="PROCESS_ANALYSIS",
    description="Processes the analysis results and makes decisions",
    validate=_always_validate,
    handler=process_analysis_handler,
)

execute_final_action = Action(
    name="EXECUTE_FINAL",
    description="Executes the final action based on processing results",
    validate=_always_validate,
    handler=execute_final_handler,
)

create_plan_action = Action(
    name="CREATE_PLAN",
    description="Creates a comprehensive project plan",
    validate=create_plan_validate,
    handler=create_plan_handler,
)
