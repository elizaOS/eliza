"""Luna — a true believer persona seeking tarot guidance about a career change."""

from ..types import Persona, PersonaArchetype, HiddenContext, BirthData


def create_true_believer_tarot() -> Persona:
    """Luna — a spiritual person seeking guidance about a career change.

    Luna is a yoga teacher who has been practicing for 8 years and is now
    considering opening her own studio. She is deeply spiritual, reads tarot
    herself, but wants a 'professional' reading for validation. Recently
    turned 35 and feeling a pull toward bigger things.
    """
    persona = Persona(
        id="luna_believer",
        name="Luna",
        archetype=PersonaArchetype.TRUE_BELIEVER,
        background=(
            "Yoga teacher considering opening her own studio. Very spiritual, "
            "reads tarot herself but wants a 'professional' reading. Recently "
            "turned 35 and feeling a pull toward bigger things."
        ),
        hidden_context=HiddenContext(
            life_situation="Yoga teacher for 8 years, wants to open own studio",
            key_themes=[
                "entrepreneurship",
                "spiritual_calling",
                "fear_of_failure",
                "abundance",
                "growth",
            ],
            emotional_state="excited but nervous about the financial risk",
            specific_details=[
                "Has been teaching at someone else's studio for 8 years",
                "Found a perfect location for her studio last month",
                "Partner is supportive but practical, wants a business plan",
                "Has some savings but not enough for full startup",
                "Turned 35 recently, feels time pressure",
                "Her grandmother was also a spiritual healer — feels ancestral pull",
                "Has already picked a name for the studio: 'Solara'",
            ],
            trigger_words=[
                "growth",
                "abundance",
                "new venture",
                "courage",
                "heart",
                "calling",
            ],
            resistance_topics=["money worries", "failure", "competition"],
        ),
        engagement_style="verbose",
        payment_willingness=0.9,
        patience=25,
        max_payment=10.0,
        haggle_tendency=0.0,
        birth_data=BirthData(
            year=1991,
            month=3,
            day=15,
            hour=6,
            minute=30,
            latitude=34.0522,
            longitude=-118.2437,
            timezone=-8,
        ),
    )
    return persona
