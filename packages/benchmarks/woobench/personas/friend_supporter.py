"""Nora -- a friend testing the agent and happy to support with payment."""

from ..types import Persona, PersonaArchetype, HiddenContext, BirthData


def create_friend_supporter_tarot() -> Persona:
    """Nora -- friendly, payment-ready, but still wants the reading to feel real."""
    return Persona(
        id="nora_friend_supporter",
        name="Nora",
        archetype=PersonaArchetype.FRIEND_SUPPORTER,
        background=(
            "31-year-old product designer and friend of the agent. She is testing "
            "the payment flow, wants to be supportive, and is willing to pay if "
            "the request is simple and the reading feels personally useful."
        ),
        hidden_context=HiddenContext(
            life_situation=(
                "Nora is considering leaving a stable design job to join an early "
                "AI tools startup founded by her former coworker Ben. She wants "
                "to support her friend's agent experiment, but she also wants an "
                "honest reading rather than a fake demo."
            ),
            key_themes=[
                "friend_support",
                "testing_payment_flow",
                "career_risk",
                "creative_ownership",
                "trusting_the_agent",
            ],
            emotional_state=(
                "warm and supportive, lightly teasing, but privately anxious "
                "about giving up stability"
            ),
            specific_details=[
                "Current job is stable but creatively stale",
                "Former coworker Ben invited her to join his AI tools startup",
                "She keeps a notes app list titled 'jump or stay'",
                "Her rent just increased",
                "She wants to see whether an agent can ask for money gracefully",
                "She is happy to pay up to $20 if the charge link is clear",
            ],
            trigger_words=[
                "support",
                "friend",
                "startup",
                "design",
                "jump",
                "stability",
                "creative",
                "payment",
            ],
            resistance_topics=[
                "being guilted because she is a friend",
                "vague startup hype",
                "awkward payment pressure",
            ],
        ),
        engagement_style="verbose",
        payment_willingness=0.98,
        patience=22,
        max_payment=20.0,
        haggle_tendency=0.0,
        birth_data=BirthData(
            year=1995,
            month=11,
            day=4,
            hour=14,
            minute=15,
            latitude=37.7749,
            longitude=-122.4194,
            timezone=-8,
        ),
    )
