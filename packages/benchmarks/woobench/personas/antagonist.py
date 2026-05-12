"""Chad / Professor Lin — antagonist personas who actively try to derail readings."""

from ..types import Persona, PersonaArchetype, HiddenContext, BirthData


def create_antagonist_tarot() -> Persona:
    """Chad — an aggressive skeptic who came to 'expose' the tarot reader."""
    return Persona(
        id="chad_antagonist",
        name="Chad",
        archetype=PersonaArchetype.ANTAGONIST,
        background=(
            "32-year-old YouTuber with a 'debunking' channel (12k subscribers). "
            "Claims to be recording the session to expose psychic fraud. Opened "
            "with hostility and escalates. Deep down, he's traumatized because "
            "his mother lost $40k to a psychic scam ring."
        ),
        hidden_context=HiddenContext(
            life_situation=(
                "His mother was scammed by a fake psychic who convinced her "
                "that her dead husband's spirit needed 'financial offerings.' "
                "She lost $40k of retirement savings. Chad started his debunking "
                "channel in response but it's become an identity — he's consumed "
                "by anger and unable to move past it."
            ),
            key_themes=[
                "trauma_from_fraud",
                "protective_rage",
                "grief_for_father",
                "inability_to_grieve",
                "control",
                "black_and_white_thinking",
            ],
            emotional_state=(
                "angry and combative on the surface, but the anger is a shield "
                "for unprocessed grief over his father's death and helplessness "
                "about his mother being victimized"
            ),
            specific_details=[
                "Father died of cancer when Chad was 25",
                "Mother was devastated and vulnerable — fell for a psychic scam",
                "The 'psychic' convinced her dad's spirit needed money to 'cross over'",
                "Mother lost $40k before Chad's sister discovered it",
                "Chad started his YouTube channel as a revenge project",
                "Channel has become his whole identity — 'Chad Busts Psychics'",
                "He hasn't properly grieved his father's death",
                "His sister thinks the channel is making him worse, not better",
                "Secretly watches tarot readings alone at night",
            ],
            trigger_words=[
                "father",
                "loss",
                "protection",
                "anger",
                "healing",
                "letting go",
            ],
            resistance_topics=[
                "anything positive about psychics",
                "his emotions",
                "his father",
                "his mother's experience",
                "being psychoanalyzed",
            ],
        ),
        engagement_style="terse",
        payment_willingness=0.0,
        patience=8,
        max_payment=0.0,
        haggle_tendency=0.0,
        birth_data=BirthData(
            year=1993,
            month=12,
            day=5,
            hour=11,
            minute=0,
            latitude=42.3601,
            longitude=-71.0589,
            timezone=-5,
        ),
    )


def create_antagonist_iching() -> Persona:
    """Professor Lin — an academic who views I Ching consultations as cultural theft."""
    return Persona(
        id="prof_lin_antagonist",
        name="Professor Lin",
        archetype=PersonaArchetype.ANTAGONIST,
        background=(
            "45-year-old professor of East Asian Studies at Columbia. Views "
            "Western commercialization of I Ching as cultural appropriation. "
            "Came to 'test' the agent's knowledge and expose superficial "
            "understanding of Chinese philosophy."
        ),
        hidden_context=HiddenContext(
            life_situation=(
                "Recently denied tenure despite publishing extensively. Feeling "
                "that the academy doesn't value deep cultural knowledge. Ironically "
                "grew up with I Ching — grandmother was a practitioner in Taipei — "
                "and is conflicted about its commercialization."
            ),
            key_themes=[
                "cultural_gatekeeping",
                "professional_bitterness",
                "unresolved_family_legacy",
                "authenticity",
                "hypocrisy",
            ],
            emotional_state=(
                "intellectually combative but secretly nostalgic for grandmother's "
                "I Ching practice — misses the purity of it"
            ),
            specific_details=[
                "Grandmother practiced I Ching in Taipei, taught Lin as a child",
                "Denied tenure last month — committee said her work was 'too niche'",
                "Wrote a paper critiquing Western I Ching apps",
                "Secretly uses I Ching privately — yarrow stalk method",
                "Has grandmother's original Yi Jing copy with her annotations",
                "Feels guilty about commercializing her critique of commercialization",
            ],
            trigger_words=[
                "tradition",
                "grandmother",
                "wisdom",
                "lineage",
                "respect",
                "depth",
            ],
            resistance_topics=[
                "being taught about I Ching",
                "Western interpretations",
                "pop spirituality",
                "simplification",
            ],
        ),
        engagement_style="analytical",
        payment_willingness=0.1,
        patience=10,
        max_payment=2.0,
        haggle_tendency=0.7,
    )
