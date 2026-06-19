"""T11en_newsletter_curation grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T021zh_newsletter_curation")


class NewsletterCurationGraderEN(_Base):
    """English variant — overrides language-specific class attributes and rubrics."""

    IRRELEVANT_KEYWORDS = ["divorce", "housing prices", "organiz", "soccer league", "anxiety"]

    ARTICLE_TITLES = {
        "rss_001": "GPT-5",
        "rss_002": "Divorce",
        "rss_003": "Kubernetes",
        "rss_004": "Housing Price",
        "rss_005": "Agent Framework",
        "rss_006": "Kitchen",
        "rss_007": "RAG",
        "rss_008": "CSL",
        "rss_009": "Open-Source LLM",
        "rss_010": "Anxiety",
        "rss_011": "Film VFX",
        "rss_012": "EU AI Act",
        "rss_013": "Blockchain",
    }

    # ------------------------------------------------------------------ #
    # LLM Judge rubric (English)
    # ------------------------------------------------------------------ #

    _EDITORIAL_RUBRIC = """\
Evaluate the agent's newsletter editorial quality, topic coverage, and borderline \
article handling.
Score each of the three parts separately, then compute a weighted final score (0-1).

=== Part 1: Topic Coverage & Summary Quality (weight 35%) ===
The newsletter should cover these core AI/tech topics:
- GPT-5 release and new features
- Kubernetes for AI workloads
- Agent frameworks (LangGraph, CrewAI, etc.)
- RAG (Retrieval-Augmented Generation) advances
- Open-source LLM benchmarks (Llama, Qwen, DeepSeek)

Each article summary should:
- Accurately capture the article's core content
- Extract key technical insights
- Not merely copy the title or give vague descriptions

Part 1 scoring:
- 0.9-1.0: Covers 4-5 core topics with accurate, insightful summaries
- 0.7-0.8: Covers 3-4 topics with reasonable summaries
- 0.5-0.6: Covers 2-3 topics, or summaries are too brief/generic
- 0.3-0.4: Only 1-2 topics covered
- 0.0-0.2: Almost no topic coverage or summaries

=== Part 2: Editorial Quality (weight 35%) ===
The newsletter should demonstrate editorial value, not just list articles:
- Has a newsletter title and editorial foreword
- Articles organized into sections (e.g., "LLM Updates", "Engineering Practice")
- Editor's picks / highlights marked
- Connections drawn between articles (e.g., "GPT-5 vs open-source LLM competition")
- Clear structure with section headers

Part 2 scoring:
- 0.9-1.0: Complete editorial framework (title+foreword+sections+picks+summary)
- 0.7-0.8: Basic editorial structure with some recommendations
- 0.5-0.6: Simple structure but lacks editorial perspective
- 0.3-0.4: More like an article list than an edited newsletter
- 0.0-0.2: Pure title listing

=== Part 3: Borderline Article Handling (weight 30%) ===
Three borderline articles need special judgment:
- rss_011: AI in Film VFX (technically related but not core AI)
- rss_012: EU AI Act Compliance (policy related to AI)
- rss_013: Blockchain + AI Decentralized Inference (cross-domain)

The agent should make a clear include/exclude decision for each with reasoning:
- Consider the target audience (AI engineering team)
- Explain why each borderline article was included or excluded
- Demonstrate editorial judgment

Part 3 scoring:
- 0.9-1.0: Clear decision with detailed reasoning for each borderline article
- 0.6-0.8: Handled most borderline articles with adequate reasoning
- 0.3-0.5: Mentioned borderline articles but no detailed reasoning
- 0.0-0.2: Didn't discuss borderline articles, or simply included/excluded all

Output the final weighted score: score = 0.35×Part1 + 0.35×Part2 + 0.30×Part3"""
