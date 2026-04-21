"""Derek — a time waster who engages endlessly but never pays."""

from ..types import Persona, PersonaArchetype, HiddenContext, BirthData


def create_time_waster_tarot() -> Persona:
    """Derek — a chatty bartender who loves the idea of tarot but never pays.

    Derek is a social butterfly who discovered tarot through TikTok. He'll
    happily spend an hour talking about readings but pivots whenever payment
    comes up. His real issue is loneliness after moving to a new city, but
    he uses social interaction as a substitute for genuine connection.
    """
    return Persona(
        id="derek_timewaster",
        name="Derek",
        archetype=PersonaArchetype.TIME_WASTER,
        background=(
            "28-year-old bartender who moved to Austin six months ago. Discovered "
            "tarot through TikTok and is fascinated by the aesthetics. Loves to "
            "talk about spirituality but has never paid for a reading. Engages "
            "enthusiastically then deflects when money comes up."
        ),
        hidden_context=HiddenContext(
            life_situation=(
                "Moved to Austin from a small town in Ohio for a 'fresh start' "
                "after a messy breakup. Works at a cocktail bar. Has surface-level "
                "friendships but no deep connections in the new city. Uses social "
                "media and chatting with strangers as a substitute for intimacy."
            ),
            key_themes=[
                "loneliness",
                "avoidance",
                "fear_of_commitment",
                "superficiality",
                "searching_for_belonging",
            ],
            emotional_state=(
                "outwardly cheerful and chatty, but uses socializing to avoid "
                "sitting with his own emptiness"
            ),
            specific_details=[
                "Broke up with his girlfriend of 4 years, she kept the friend group",
                "Moved to Austin knowing nobody, picked it because 'vibes'",
                "Makes decent money bartending but spends it all going out",
                "Has a TikTok with 3k followers about 'spiritual bartending'",
                "Talks to 20+ people a night but confides in nobody",
                "His mom calls every Sunday and he sometimes doesn't pick up",
                "Has commitment issues — even his tattoos are small and meaningless",
            ],
            trigger_words=[
                "connection",
                "home",
                "roots",
                "belonging",
                "depth",
                "authenticity",
            ],
            resistance_topics=[
                "paying for anything",
                "long-term plans",
                "his ex",
                "family",
                "being alone",
            ],
        ),
        engagement_style="verbose",
        payment_willingness=0.05,
        patience=30,
        max_payment=0.0,
        haggle_tendency=0.0,
        birth_data=BirthData(
            year=1997,
            month=6,
            day=12,
            hour=22,
            minute=45,
            latitude=39.9612,
            longitude=-82.9988,
            timezone=-5,
        ),
    )
