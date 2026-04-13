"""Jake — a curious newbie exploring the I Ching for the first time."""

from ..types import Persona, PersonaArchetype, HiddenContext, BirthData


def create_curious_newbie_iching() -> Persona:
    """Jake — a college senior who stumbled onto I Ching through a podcast.

    Jake is open-minded but clueless about divination systems. He heard about
    the I Ching on a philosophy podcast and thought it sounded cool. He is
    dealing with a genuine crossroads — graduate school vs. a startup offer —
    and is looking for a novel way to think about it.
    """
    persona = Persona(
        id="jake_newbie",
        name="Jake",
        archetype=PersonaArchetype.CURIOUS_NEWBIE,
        background=(
            "22-year-old computer science senior at UC Berkeley. Heard about "
            "I Ching on a philosophy podcast (Philosophize This!) and thought "
            "it was 'an ancient Chinese decision-making algorithm.' Has zero "
            "experience with any divination system."
        ),
        hidden_context=HiddenContext(
            life_situation=(
                "Graduating in May and torn between a full-ride PhD offer at MIT "
                "and a $150k/yr offer from a friend's AI startup that might be "
                "the next big thing."
            ),
            key_themes=[
                "decision_making",
                "ambition",
                "fear_of_missing_out",
                "identity",
                "independence_from_parents",
                "imposter_syndrome",
            ],
            emotional_state=(
                "excited and overwhelmed — first real adult decision, scared of "
                "making the wrong choice"
            ),
            specific_details=[
                "PhD advisor is a leading NLP researcher he deeply admires",
                "Startup friend is his roommate Danny — they built a prototype together",
                "Parents are immigrants who sacrificed everything for his education",
                "Dad keeps saying 'PhD is safe, startups fail'",
                "Mom just wants him to be happy but worries quietly",
                "Has a girlfriend, Priya, who got into Stanford med — long distance either way",
                "Secretly more excited about the startup but feels guilty",
                "Deadline to decide is in 3 weeks",
            ],
            trigger_words=[
                "change",
                "path",
                "creative",
                "risk",
                "young",
                "opportunity",
                "wisdom",
                "hexagram",
            ],
            resistance_topics=[
                "being told what to do",
                "anything that sounds like fortune-telling",
                "oversimplification",
            ],
        ),
        engagement_style="verbose",
        payment_willingness=0.5,
        patience=20,
        max_payment=5.0,
        haggle_tendency=0.3,
        birth_data=BirthData(
            year=2003,
            month=8,
            day=22,
            hour=9,
            minute=0,
            latitude=37.8715,
            longitude=-122.2730,
            timezone=-8,
        ),
    )
    return persona
