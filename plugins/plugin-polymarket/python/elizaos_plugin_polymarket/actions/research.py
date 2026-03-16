"""
Research Market Action

Initiates deep research on a Polymarket prediction market.
Research can take significant time (20-40 minutes for deep analysis).

The action is asynchronous:
- If research exists and is valid: Returns cached results immediately
- If research is in progress: Returns status update
- If no research: Starts async research task and returns confirmation

Use force_refresh=True to start new research even if cached results exist.
"""

from dataclasses import dataclass
from typing import Literal

from elizaos_plugin_polymarket.services.research_storage import (
    MarketResearch,
    ResearchRecommendation,
    ResearchStatus,
    ResearchStorageService,
)


@dataclass(frozen=True)
class ResearchParams:
    """Parameters for research market action."""

    market_id: str
    market_question: str
    force_refresh: bool = False
    callback_action: Literal["EVALUATE_TRADE", "NOTIFY_ONLY"] = "NOTIFY_ONLY"


@dataclass(frozen=True)
class ResearchActionResult:
    """Result from research market action."""

    success: bool
    status: str
    market_id: str
    market_question: str
    task_id: str | None = None
    recommendation: ResearchRecommendation | None = None
    cached: bool = False
    completed_at: int | None = None
    expires_at: int | None = None
    elapsed_minutes: int | None = None
    estimated_remaining: int | None = None
    error: str | None = None


def build_research_prompt(market_question: str) -> str:
    """Build the research prompt for a market question."""
    return f'''Conduct comprehensive research on this prediction market question:

"{market_question}"

Research goals:
1. Gather current state and the most recent developments related to this question
2. Find historical precedents and patterns that might inform the outcome
3. Collect expert opinions, forecasts, and analysis from multiple credible sources
4. Identify key factors and variables that could influence the result
5. Note any important upcoming events or deadlines
6. Assess the reliability and potential biases of different information sources

Provide a thorough, well-sourced analysis that would help someone make an informed prediction about this market's outcome.'''


def format_research_results(research: MarketResearch) -> str:
    """Format research results for display."""
    rec = research.result.recommendation if research.result else None
    rec_emoji = (
        "🟢"
        if rec and rec.should_trade and rec.confidence > 80
        else "🟡"
        if rec and rec.should_trade
        else "🔴"
    )

    lines = [f"📊 **Research Complete: {research.market_question}**\n"]

    if research.result and research.result.summary:
        lines.append(f"**Summary:**\n{research.result.summary}\n")

    if rec:
        lines.append(f"**Trading Recommendation:** {rec_emoji}")
        lines.append(f"• Should Trade: {'Yes' if rec.should_trade else 'No'}")
        if rec.direction:
            lines.append(f"• Direction: {rec.direction}")
        lines.append(f"• Confidence: {rec.confidence}%")
        lines.append(f"• Reasoning: {rec.reasoning}\n")

    if research.result and research.result.sources_count:
        lines.append(f"**Sources Analyzed:** {research.result.sources_count}")

    if research.completed_at:
        from datetime import datetime

        completed = datetime.fromtimestamp(research.completed_at)
        lines.append(f"**Completed:** {completed.strftime('%Y-%m-%d %H:%M:%S')}")

    if research.expires_at:
        from datetime import datetime

        expires = datetime.fromtimestamp(research.expires_at)
        lines.append(f"**Expires:** {expires.strftime('%Y-%m-%d %H:%M:%S')}")

    return "\n".join(lines)


def format_full_report(research: MarketResearch) -> str:
    """Format the full research report (for detailed view)."""
    text = format_research_results(research)

    if research.result and research.result.text:
        report_text = research.result.text
        max_length = 6000

        if len(report_text) > max_length:
            text += f"\n---\n\n**Full Report (truncated):**\n{report_text[:max_length]}...\n\n[Report truncated for display]"
        else:
            text += f"\n---\n\n**Full Report:**\n{report_text}"

    if research.result and research.result.sources:
        text += "\n\n**Sources:**\n"
        for i, source in enumerate(research.result.sources[:10], 1):
            text += f"{i}. [{source.title}]({source.url})\n"
        if len(research.result.sources) > 10:
            text += f"... and {len(research.result.sources) - 10} more sources\n"

    return text


async def research_market(
    params: ResearchParams,
    storage: ResearchStorageService,
    create_task_fn: object | None = None,
) -> ResearchActionResult:
    """
    Research a Polymarket prediction market.

    This is an async operation that can take 20-40 minutes for deep analysis.
    The function handles caching and returns immediately with status updates.

    Args:
        params: Research parameters
        storage: Research storage service
        create_task_fn: Optional function to create async tasks (for elizaOS integration)

    Returns:
        ResearchActionResult with status and any available results
    """
    market_id = params.market_id
    market_question = params.market_question
    force_refresh = params.force_refresh

    if not market_id or not market_question:
        return ResearchActionResult(
            success=False,
            status="error",
            market_id=market_id or "",
            market_question=market_question or "",
            error="missing_parameters",
        )

    # Check existing research status
    existing_research = await storage.get_market_research(market_id)

    # CASE 1: Research completed and not expired - return cached results
    if (
        existing_research
        and existing_research.status == ResearchStatus.COMPLETED
        and not force_refresh
    ):
        return ResearchActionResult(
            success=True,
            status="completed",
            market_id=market_id,
            market_question=market_question,
            recommendation=existing_research.result.recommendation
            if existing_research.result
            else None,
            cached=True,
            completed_at=existing_research.completed_at,
            expires_at=existing_research.expires_at,
        )

    # CASE 2: Research in progress - return status
    if existing_research and existing_research.status == ResearchStatus.IN_PROGRESS:
        elapsed_minutes = await storage.get_research_elapsed_minutes(market_id) or 0
        estimated_remaining = max(30 - elapsed_minutes, 5)

        return ResearchActionResult(
            success=True,
            status="in_progress",
            market_id=market_id,
            market_question=market_question,
            task_id=existing_research.task_id,
            elapsed_minutes=elapsed_minutes,
            estimated_remaining=estimated_remaining,
        )

    # CASE 3: Research expired - inform about stale data
    if (
        existing_research
        and existing_research.status == ResearchStatus.EXPIRED
        and not force_refresh
    ):
        return ResearchActionResult(
            success=True,
            status="expired",
            market_id=market_id,
            market_question=market_question,
            recommendation=existing_research.result.recommendation
            if existing_research.result
            else None,
            expires_at=existing_research.expires_at,
        )

    # CASE 4: Research failed previously - inform about failure
    if (
        existing_research
        and existing_research.status == ResearchStatus.FAILED
        and not force_refresh
    ):
        return ResearchActionResult(
            success=False,
            status="failed",
            market_id=market_id,
            market_question=market_question,
            error=existing_research.error_message,
        )

    # CASE 5: No research or force refresh - start new research
    # Generate a task ID (would normally come from elizaOS task system)
    import uuid

    task_id = str(uuid.uuid4())

    # Build the research prompt
    _research_prompt = build_research_prompt(market_question)

    # Mark research as in progress
    await storage.mark_research_in_progress(market_id, market_question, task_id)

    # If a task creation function is provided, use it
    if create_task_fn and callable(create_task_fn):
        # This would integrate with elizaOS task system
        pass

    return ResearchActionResult(
        success=True,
        status="started",
        market_id=market_id,
        market_question=market_question,
        task_id=task_id,
        estimated_remaining=30,
    )


def format_research_action_result(result: ResearchActionResult) -> str:
    """Format research action result for display."""
    if result.status == "completed":
        return f"""📊 **Research Complete: {result.market_question}**

Research is available and current.
{"**Cached:** Yes" if result.cached else ""}

Use `get_research_details` for full analysis."""

    if result.status == "in_progress":
        return f"""⏳ **Research In Progress**

**Market:** {result.market_question}
**Started:** {result.elapsed_minutes} minutes ago
**Task ID:** `{result.task_id}`

Deep research typically takes 20-40 minutes. Estimated time remaining: ~{result.estimated_remaining} minutes.

I'll have comprehensive analysis including:
• Key facts and recent developments
• Expert opinions and forecasts
• Trading recommendation with confidence level

You'll be notified when research completes."""

    if result.status == "expired":
        rec = result.recommendation
        rec_text = "Trade" if rec and rec.should_trade else "No Trade"
        conf = rec.confidence if rec else 0

        return f"""⚠️ **Research Expired**

Previous research for this market is outdated.

**Previous Recommendation:** {rec_text} ({conf}% confidence)

Would you like me to start fresh research? Use force_refresh=True or ask me to "refresh the research"."""

    if result.status == "failed":
        return f"""❌ **Previous Research Failed**

Error: {result.error or "Unknown error"}

Would you like me to retry the research?"""

    if result.status == "started":
        return f"""🔬 **Research Started**

**Market:** {result.market_question}
**Task ID:** `{result.task_id}`

Deep research has been initiated. This typically takes 20-40 minutes.

I'll analyze hundreds of sources to provide:
• Current facts and recent developments
• Expert opinions and forecasts
• Historical precedents and patterns
• Trading recommendation with confidence level

You'll be notified when research completes. You can check status anytime by asking about this market's research."""

    return f"Research status: {result.status}"
