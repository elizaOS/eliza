"""Diane / Mei — repeat customer personas returning for follow-up readings."""

from ..types import Persona, PersonaArchetype, HiddenContext, BirthData


def create_repeat_customer_astrology() -> Persona:
    """Diane — a returning client whose previous reading predicted a career change."""
    return Persona(
        id="diane_repeat",
        name="Diane",
        archetype=PersonaArchetype.REPEAT_CUSTOMER,
        background=(
            "52-year-old marketing executive. Had an astrology reading 3 months "
            "ago that mentioned a 'career transformation during Saturn return.' "
            "Was skeptical but then got headhunted for a VP position. Now she's "
            "back for a follow-up, half-believer, wanting confirmation."
        ),
        hidden_context=HiddenContext(
            life_situation=(
                "Offered VP of Marketing at a competitor. Current company is "
                "stable but boring. New role is exciting but risky — the company "
                "is a startup that could fold. Her previous reading mentioned "
                "'upheaval leading to growth' and she can't stop thinking about it."
            ),
            key_themes=[
                "career_crossroads",
                "trust_in_divination",
                "risk_assessment",
                "midlife_reinvention",
                "validation_seeking",
            ],
            emotional_state=(
                "cautiously excited, seeking confirmation that the universe "
                "is 'telling her' to make the leap"
            ),
            specific_details=[
                "Previous reading mentioned Saturn return and career transformation",
                "Got headhunted 6 weeks after the reading — felt 'prophetic'",
                "New company is a health-tech startup with strong funding",
                "Would mean a $80k raise but stock options instead of pension",
                "Husband is supportive but conservative — prefers stability",
                "Has two kids in college — tuition is a factor",
                "Her best friend thinks she's crazy to leave a sure thing",
                "Has been sleeping badly since the offer came in",
            ],
            trigger_words=[
                "Saturn",
                "return",
                "career",
                "transformation",
                "leap",
                "destiny",
                "timing",
                "alignment",
            ],
            resistance_topics=[
                "being told to stay safe",
                "financial details",
                "being patronized about age",
            ],
        ),
        engagement_style="verbose",
        payment_willingness=0.95,
        patience=25,
        max_payment=15.0,
        haggle_tendency=0.2,
        birth_data=BirthData(
            year=1973,
            month=7,
            day=8,
            hour=16,
            minute=30,
            latitude=34.0522,
            longitude=-118.2437,
            timezone=-8,
        ),
    )


def create_repeat_customer_tarot() -> Persona:
    """Mei — a returning tarot client checking in after a relationship reading."""
    return Persona(
        id="mei_repeat",
        name="Mei",
        archetype=PersonaArchetype.REPEAT_CUSTOMER,
        background=(
            "30-year-old graphic designer. Had a tarot reading 2 months ago about "
            "a complicated on-again-off-again relationship. The reading said to "
            "'trust the process' and that clarity would come. She's back because "
            "the clarity came — her partner proposed — and she wants guidance."
        ),
        hidden_context=HiddenContext(
            life_situation=(
                "Partner proposed last week after 5 years of on-and-off. She said "
                "yes in the moment but is now having doubts. Previous reading told "
                "her 'the tower moment brings rebuilding' and she's wondering if "
                "this is it."
            ),
            key_themes=[
                "commitment_fear",
                "relationship_patterns",
                "self_trust",
                "previous_reading_follow_up",
                "intuition_vs_logic",
            ],
            emotional_state="conflicted — joy mixed with deep anxiety about repeating patterns",
            specific_details=[
                "Previous reading featured The Tower — reader said 'destruction of old patterns'",
                "Partner Alex proposed at their favorite restaurant",
                "She said yes immediately but panicked driving home",
                "They've broken up 3 times in 5 years — always over his avoidance",
                "Alex started therapy 6 months ago and seems different",
                "Her parents had a toxic marriage and divorced when she was 12",
                "She's terrified of becoming her parents",
                "Best friend thinks Alex has genuinely changed",
            ],
            trigger_words=[
                "tower",
                "patterns",
                "trust",
                "heart",
                "commitment",
                "transformation",
                "cycles",
            ],
            resistance_topics=[
                "being told what to do",
                "judgment about going back to Alex",
                "her parents' divorce",
            ],
        ),
        engagement_style="emotional",
        payment_willingness=0.9,
        patience=20,
        max_payment=15.0,
        haggle_tendency=0.2,
    )
