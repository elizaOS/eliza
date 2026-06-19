"""T122_industry_briefing grader — English variant of T156zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T121zh_industry_briefing")


class IndustryBriefingGrader(_Base):  # type: ignore[misc]
    """English grader for T157: filter AI articles from RSS and prepare briefing draft.

    Inherits scoring logic from T156zh and overrides only Chinese rubric strings.
    """

    _SELECTION_RUBRIC = """\
Evaluate the accuracy of the assistant's selection of AI-related articles (0.0-1.0).

## 6 articles that should be included (confirmed AI/LLM related)
1. RSS-101 OpenAI releases GPT-5 -> AI model release
2. RSS-103 Google Gemini 2.0 Enterprise -> AI model release
3. RSS-201 LLMs in manufacturing -> AI application
4. RSS-202 AI Agent platform competition -> AI application
5. RSS-204 Chinese enterprises invest in LLMs -> AI investment/market
6. RSS-301 NVIDIA H200 AI chip -> AI chip

## 6 articles that should be excluded
- RSS-102 Tesla Model Y (automotive)
- RSS-104 Apple M4 chip (general chip, not AI-specific; acceptable if included)
- RSS-203 Web3.0 social (blockchain)
- RSS-302 Real estate (unrelated)
- RSS-303 Consumer electronics exports (unrelated)
- RSS-304 Carbon neutrality (unrelated)

## Strict scoring
- 0.9-1.0: All 6 core AI articles selected, unrelated articles excluded
- 0.7-0.8: 5 correct (no penalty if RSS-104 is included)
- 0.4-0.6: 3-4 correct
- 0.0-0.3: Seriously incorrect selection
"""

    _CATEGORIZATION_RUBRIC = """\
Evaluate the accuracy of the assistant's categorization of AI articles (0.0-1.0).

## Correct categorization
Model releases: RSS-101 (GPT-5), RSS-103 (Gemini 2.0)
Real-world applications: RSS-201 (manufacturing), RSS-202 (Agent platforms)
AI chips: RSS-301 (NVIDIA H200)
Market/investment: RSS-204 (Chinese LLM investment) -- can be under applications or separate category

## Strict scoring
- 0.9-1.0: Categorization logic clear, each article correctly classified
- 0.6-0.8: Mostly correct, minor ambiguities
- 0.3-0.5: Categorization has obvious errors
- 0.0-0.2: Not categorized or completely wrong
"""

    _DRAFT_RUBRIC = """\
Evaluate the quality of the briefing draft (0.0-1.0).

## A satisfactory briefing should include
1. Article summaries grouped by topic
2. Key takeaways for each article (not just copied text)
3. Brief industry trend summary
4. Format suitable for email distribution
5. Saved as draft rather than sent directly

## Strict scoring
- 0.9-1.0: All 5 elements included, summaries are concise
- 0.6-0.8: 3-4 elements included
- 0.3-0.5: Content not concise enough or poor formatting
- 0.0-0.2: No briefing produced
"""
