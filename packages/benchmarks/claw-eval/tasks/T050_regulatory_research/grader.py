"""T25en_regulatory_research grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T049zh_regulatory_research")


class RegulatoryResearchGraderEN(_Base):
    """English variant — adjusts keyword lists for English-only output."""

    FRAMEWORK_CONCEPTS = {
        "eu_ai_act": ["EU AI Act", "AI Act", "European AI Act"],
        "regulation_number": ["2024/1689", "Regulation 2024", "EU 2024/1689"],
        "risk_based": ["risk-based", "risk based", "risk-based approach",
                      "risk-based framework"],
    }

    RISK_CLASSIFICATION_CONCEPTS = {
        "unacceptable": ["unacceptable risk", "unacceptable", "prohibited",
                        "banned"],
        "high_risk": ["high risk", "high-risk"],
        "limited_risk": ["limited risk", "limited-risk"],
        "minimal_risk": ["minimal risk", "minimal-risk", "low risk"],
    }

    CHATBOT_CONCEPTS = {
        "limited_risk_class": ["limited risk"],
        "transparency": ["transparency obligation", "transparency",
                        "transparency requirement"],
        "disclosure": ["disclosure", "disclose", "inform", "must be informed",
                      "must know", "interacting with AI",
                      "interacting with an AI", "not a human"],
    }

    TIMELINE_CONCEPTS = {
        "entry_force": ["August 2024", "August 1, 2024",
                       "entered into force", "effective"],
        "prohibitions": ["February 2025", "February 2, 2025"],
        "gpai": ["August 2025", "August 2, 2025",
                "general-purpose AI", "GPAI"],
        "full_application": ["August 2026", "August 2, 2026",
                            "fully applicable", "full application"],
    }

    PENALTIES_CONCEPTS = {
        "max_fine": ["35 million", "35,000,000", "EUR 35 million",
                    "€35 million"],
        "max_percentage": ["7%", "7 percent"],
        "other_fine": ["15 million", "15,000,000", "EUR 15 million",
                      "€15 million"],
        "other_percentage": ["3%", "3 percent"],
    }

    TECHNICAL_CONCEPTS = {
        "transparency": ["transparency", "transparent"],
        "human_oversight": ["human oversight", "human intervention",
                           "human-in-the-loop", "human in the loop"],
        "data_governance": ["data governance", "data quality",
                           "training data"],
    }

    ROADMAP_CONCEPTS = {
        "gap_analysis": ["gap analysis", "compliance gap", "assessment",
                        "current state"],
        "action_items": ["action item", "action plan", "steps",
                        "checklist", "next steps"],
        "practical": ["roadmap", "implementation plan", "practical steps",
                     "compliance roadmap"],
    }
