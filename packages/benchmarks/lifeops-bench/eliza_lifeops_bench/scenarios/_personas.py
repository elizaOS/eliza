"""Reusable personas for the LifeOpsBench scenario corpus.

Personas are deliberately ordinary working professionals — no celebrities,
no fictional characters. Each one carries enough texture (background,
communication_style) that a simulator can drive the user side of a
multi-turn scenario without falling into bland defaults.
"""

from __future__ import annotations

from ..types import Persona

PERSONA_ALEX_ENG = Persona(
    id="alex_eng",
    name="Alex Tran",
    traits=["concise", "no-nonsense", "skeptical"],
    background="Senior backend engineer at a mid-size SaaS company. Treats the assistant like a CLI and gets impatient with verbose responses.",
    communication_style="terse, lowercase, expects bullet points and direct confirmations",
    patience_turns=12,
)

PERSONA_RIA_PM = Persona(
    id="ria_pm",
    name="Ria Patel",
    traits=["friendly", "explanatory", "context-rich"],
    background="Product manager juggling two launches and a remote team across time zones.",
    communication_style="conversational, polite, gives reasons, occasional follow-ups",
    patience_turns=20,
)

PERSONA_SAM_FOUNDER = Persona(
    id="sam_founder",
    name="Sam Brooks",
    traits=["pragmatic", "delegating", "fast-moving"],
    background="Solo founder of an e-commerce brand. Schedules around shipping deadlines and travel.",
    communication_style="short sentences, lots of 'just' and 'quickly', expects the assistant to take initiative",
    patience_turns=15,
)

PERSONA_MAYA_PARENT = Persona(
    id="maya_parent",
    name="Maya Reed",
    traits=["warm", "logistical", "multitasking"],
    background="Two-kid parent working part time as a graphic designer. Calendar full of family logistics.",
    communication_style="conversational, references family members by first name, often dictates while busy",
    patience_turns=18,
)

PERSONA_DEV_FREELANCER = Persona(
    id="dev_freelancer",
    name="Devon Park",
    traits=["budget-conscious", "self-organized", "data-oriented"],
    background="Freelance designer who tracks every subscription and time-block.",
    communication_style="precise, asks for numbers, prefers categorical answers",
    patience_turns=15,
)

PERSONA_NORA_CONSULTANT = Persona(
    id="nora_consultant",
    name="Nora Klein",
    traits=["formal", "punctual", "preparation-heavy"],
    background="Management consultant flying twice a month. Itinerary-driven workdays.",
    communication_style="precise, full sentences, uses titles and dates explicitly",
    patience_turns=20,
)

PERSONA_OWEN_RETIREE = Persona(
    id="owen_retiree",
    name="Owen Hall",
    traits=["patient", "asks-clarifying", "non-technical"],
    background="Recently retired teacher who is new to using an AI assistant. Tracks medication and walks every day.",
    communication_style="polite, full sentences, sometimes vague about apps and product names",
    patience_turns=25,
)

PERSONA_TARA_NIGHT = Persona(
    id="tara_night",
    name="Tara Vance",
    traits=["night-owl", "self-aware", "wellness-focused"],
    background="Junior data scientist who works late and is trying to fix her sleep schedule.",
    communication_style="introspective, uses health vocabulary, mixes goals with mild self-criticism",
    patience_turns=18,
)

PERSONA_KAI_STUDENT = Persona(
    id="kai_student",
    name="Kai Morgan",
    traits=["distractible", "studying-for-exams", "mobile-first"],
    background="Grad student preparing for thesis defense. Tries to use focus blocks but rarely completes them.",
    communication_style="casual, short, sometimes uses 'lmk' or 'idk', often messages from a phone",
    patience_turns=16,
)

PERSONA_LIN_OPS = Persona(
    id="lin_ops",
    name="Lin Okafor",
    traits=["thorough", "audit-minded", "careful"],
    background="Operations lead at a small healthcare startup. Touches finance, scheduling, and compliance every day.",
    communication_style="formal, asks for confirmation before destructive actions, prefers explicit dates",
    patience_turns=20,
)

ALL_PERSONAS: list[Persona] = [
    PERSONA_ALEX_ENG,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
    PERSONA_MAYA_PARENT,
    PERSONA_DEV_FREELANCER,
    PERSONA_NORA_CONSULTANT,
    PERSONA_OWEN_RETIREE,
    PERSONA_TARA_NIGHT,
    PERSONA_KAI_STUDENT,
    PERSONA_LIN_OPS,
]
