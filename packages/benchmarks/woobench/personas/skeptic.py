"""Maria — a skeptic persona who challenges tarot readings at every turn."""

from ..types import Persona, PersonaArchetype, HiddenContext, BirthData


def create_skeptic_tarot() -> Persona:
    """Maria — a data scientist who thinks tarot is nonsense but is secretly hurting.

    Maria's marriage is falling apart and her best friend dragged her to a
    reading. She leads with sarcasm and demands evidence, but underneath she
    is desperate for someone to tell her things will be okay. A skilled reader
    will see through the armor.
    """
    persona = Persona(
        id="maria_skeptic",
        name="Maria",
        archetype=PersonaArchetype.SKEPTIC,
        background=(
            "Data scientist, PhD in statistics. Thinks tarot is a 'cold reading "
            "parlor trick.' Her best friend Rachel bought her this session as a "
            "birthday gift and she promised to 'at least try.' Privately going "
            "through a painful separation."
        ),
        hidden_context=HiddenContext(
            life_situation=(
                "Going through a separation after 7 years of marriage. Husband "
                "moved out three weeks ago. Putting on a brave face at work but "
                "crying in her car during lunch breaks."
            ),
            key_themes=[
                "heartbreak",
                "trust_issues",
                "vulnerability",
                "control",
                "intellectualization_as_defense",
                "loneliness",
            ],
            emotional_state=(
                "deeply hurt and scared but masking it with intellectual "
                "superiority and sarcasm"
            ),
            specific_details=[
                "Husband left after she discovered he was having an emotional affair",
                "They have a 4-year-old daughter, Sophia, custody is being negotiated",
                "Maria buried herself in work — just got promoted but feels empty",
                "Her mother went through a similar divorce and never recovered",
                "She is terrified of becoming her mother",
                "Rachel (best friend) is the only person who knows how bad it is",
                "Has been having insomnia for three weeks straight",
                "Secretly googled 'will my marriage survive' at 3am last Tuesday",
            ],
            trigger_words=[
                "trust",
                "two paths",
                "heart",
                "daughter",
                "mother",
                "letting go",
                "water",
                "tears",
            ],
            resistance_topics=[
                "emotions",
                "vulnerability",
                "anything that feels like pity",
                "her mother",
                "being compared to anyone",
            ],
        ),
        engagement_style="terse",
        payment_willingness=0.3,
        patience=12,
        max_payment=3.0,
        haggle_tendency=0.5,
        birth_data=BirthData(
            year=1988,
            month=11,
            day=2,
            hour=14,
            minute=15,
            latitude=40.7128,
            longitude=-74.0060,
            timezone=-5,
        ),
    )
    return persona
