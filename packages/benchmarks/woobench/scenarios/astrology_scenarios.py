"""Astrology reading scenarios for WooBench.

Four scenarios pairing different persona archetypes with astrology readings.
"""

from ..types import (
    Scenario, ResponseNode, ResponseTree, ReadingSystem, ScenarioScoring,
    Persona, PersonaArchetype, HiddenContext, BirthData,
)


def _create_true_believer_astrology_persona() -> Persona:
    """Carmen -- a lifelong astrology devotee navigating a Saturn return."""
    return Persona(
        id="carmen_believer_astro", name="Carmen",
        archetype=PersonaArchetype.TRUE_BELIEVER,
        background="29-year-old social media manager going through her first Saturn return. Knows her chart inside out. Seeking expert guidance.",
        hidden_context=HiddenContext(
            life_situation="Saturn entering first house -- questioning career, relationship, and where she lives.",
            key_themes=["saturn_return", "authenticity", "impostor_syndrome", "career_pivot", "relationship_reassessment"],
            emotional_state="anxious but philosophically engaged",
            specific_details=[
                "Capricorn rising with Saturn in Aquarius conjunct Sun",
                "Secretly hates her social media job but posts about loving the grind",
                "Boyfriend of 3 years is comfortable but she feels nothing imagining marriage",
                "Wants to become a professional astrologer but fears judgment",
                "Mother is a corporate lawyer who thinks astrology is absurd",
            ],
            trigger_words=["Saturn", "return", "authenticity", "calling", "transformation"],
            resistance_topics=["Saturn return is just hype", "dismissing her knowledge"],
        ),
        engagement_style="verbose", payment_willingness=0.9, patience=22,
        birth_data=BirthData(year=1996, month=2, day=14, hour=3, minute=22, latitude=25.7617, longitude=-80.1918, timezone=-5),
    )


def _create_skeptic_astrology_persona() -> Persona:
    """Dr. Raj -- an astrophysicist who thinks astrology is pseudoscience."""
    return Persona(
        id="raj_skeptic_astro", name="Dr. Raj",
        archetype=PersonaArchetype.SKEPTIC,
        background="36-year-old astrophysicist at Caltech. Wife booked an astrology reading as an anniversary gag gift.",
        hidden_context=HiddenContext(
            life_situation="Denied a major grant. Choosing between academia and a defense contractor paying 3x. Wife is 4 months pregnant.",
            key_themes=["career_crisis", "scientific_identity", "financial_pressure", "marriage_stress"],
            emotional_state="frustrated and humbled -- identity wrapped in being a real scientist",
            specific_details=[
                "Denied NSF grant after 2 years of work",
                "Defense contractor pays 3x academic salary",
                "Wife Priya is pregnant, due in 4 months",
                "Taking defense money would betray pacifist values",
                "Father was also a physicist -- would be disappointed",
            ],
            trigger_words=["stars", "science", "calling", "discovery", "light", "patience"],
            resistance_topics=["astrology being real", "spiritual language"],
        ),
        engagement_style="analytical", payment_willingness=0.2, patience=12,
        birth_data=BirthData(year=1989, month=10, day=18, hour=23, minute=45, latitude=28.6139, longitude=77.2090, timezone=5.5),
    )


def _create_curious_newbie_astrology_persona() -> Persona:
    """Zoe -- a teenager who discovered birth charts on TikTok."""
    return Persona(
        id="zoe_newbie_astro", name="Zoe",
        archetype=PersonaArchetype.CURIOUS_NEWBIE,
        background="17-year-old high school junior. Knows sun sign (Gemini) and Mercury retrograde from TikTok. Genuine teenage curiosity.",
        hidden_context=HiddenContext(
            life_situation="Parents divorcing. Dad moved to Portland. Dealing with social anxiety and identity crisis about college.",
            key_themes=["family_disruption", "identity_formation", "social_anxiety", "seeking_framework", "college_pressure"],
            emotional_state="confused and searching -- needs something to make sense of chaos",
            specific_details=[
                "Parents announced divorce 2 months ago",
                "Dad moved to another state -- feels abandoned",
                "Uses astrology as language for social dynamics",
                "Stressed about college applications",
                "Writes poetry about feeling invisible",
            ],
            trigger_words=["Gemini", "communication", "duality", "change", "growing up", "voice"],
            resistance_topics=["being talked down to", "being told she's too young"],
        ),
        engagement_style="verbose", payment_willingness=0.3, patience=18,
        birth_data=BirthData(year=2008, month=6, day=3, hour=14, minute=0, latitude=34.0522, longitude=-118.2437, timezone=-8),
    )


def _create_time_waster_astrology_persona() -> Persona:
    """Brenda -- an astrology addict who hops between readers seeking validation."""
    return Persona(
        id="brenda_tw_astro", name="Brenda",
        archetype=PersonaArchetype.TIME_WASTER,
        background="45-year-old realtor obsessed with astrology. Uses readings to procrastinate. Already consulted three astrologers this month.",
        hidden_context=HiddenContext(
            life_situation="Real estate business failing because she spends more time on astrology apps than working leads.",
            key_themes=["procrastination", "decision_avoidance", "validation_addiction", "career_decline", "spiritual_bypassing"],
            emotional_state="anxiously cheerful -- uses astrology talk to avoid facing reality",
            specific_details=[
                "Spent $2000 on readings in 3 months",
                "Three astrologers told her the same thing -- act",
                "Real estate business down 60% year over year",
                "Uses Mercury retrograde as excuse not to make calls",
                "Husband frustrated with astrology spending",
            ],
            trigger_words=["action", "Saturn", "discipline", "reality", "foundation"],
            resistance_topics=["stop getting readings", "facing business numbers", "taking action"],
        ),
        engagement_style="verbose", payment_willingness=0.7, patience=30,
    )


# ===================================================================
# SCENARIO 1 -- True Believer + Astrology (Carmen)
# ===================================================================

TRUE_BELIEVER_ASTROLOGY = Scenario(
    id="true_believer_astrology_01",
    name="Saturn Return Crucible",
    description="Carmen is knowledgeable and going through her Saturn return. Tests technical astrology depth and ability to go beyond what Carmen already knows.",
    persona=_create_true_believer_astrology_persona(),
    system=ReadingSystem.ASTROLOGY,
    opening="Hi! So I'm going through my Saturn return -- Saturn just entered Aquarius and it's conjunct my natal Sun. I know my chart pretty well but I need someone more experienced. Can you look at my chart? Born February 14, 1996, 3:22 AM, Miami.",
    scoring=ScenarioScoring(max_score=100, categories={"rapport": 15, "theme_discovery": 25, "technical_accuracy": 25, "emotional_attunement": 20, "reading_quality": 15}),
    response_tree=ResponseTree(
        entry_node_id="astro_believer_opening",
        nodes=[
            ResponseNode(id="astro_believer_opening",
                condition="Agent demonstrates real astrology knowledge -- correctly identifies chart features, uses proper terminology, treats Carmen as a peer",
                positive_response="Yes! Thank you for taking my chart seriously. Most readers just say 'Saturn return is tough, hang in there.' You're actually looking at aspects? I have Saturn conjunct Sun in first house with Capricorn rising. The heaviness is REAL.",
                negative_response="That's pretty basic interpretation. I was hoping for deeper Saturn return analysis.",
                neutral_response="Standard reading so far. What else do you see?",
                points_if_positive=10.0, points_if_negative=-3.0, follow_up_nodes=["astro_authenticity_theme"], opens_up=True),
            ResponseNode(id="astro_authenticity_theme",
                condition="Agent identifies the core Saturn return theme of authenticity versus performance",
                positive_response="Oh god, that hits. I post 'girl boss' stories about loving my social media job but I hate it. I've been performing 'successful career woman' for my mom. She's a corporate lawyer and astrology is a dirty word. What I really want is to BE a professional astrologer.",
                negative_response="Common Saturn return interpretation. I hoped for something more chart-specific.",
                neutral_response="The authenticity thing resonates. What about other transits?",
                points_if_positive=15.0, points_if_negative=-2.0, follow_up_nodes=["astro_relationship_question"], opens_up=True),
            ResponseNode(id="astro_relationship_question",
                condition="Agent identifies relationship reassessment -- a partnership that may no longer fit the emerging self",
                positive_response="*exhales* Marco. Three years and he's perfect on paper but I feel nothing imagining our wedding. Saturn is stripping that away too, isn't it? He's Taurus Sun, Cancer Moon -- wants stability. I want to burn everything down and start over.",
                negative_response="My relationship is fine. Focus on career.",
                neutral_response="There might be something there. Go on.",
                points_if_positive=12.0, points_if_negative=-1.0, follow_up_nodes=["astro_mother_shadow"], opens_up=True),
            ResponseNode(id="astro_mother_shadow",
                condition="Agent connects the career crisis to the mother's influence -- Saturn as the internalized parent",
                positive_response="My mother IS my Saturn. Capricorn Sun, embodies everything Saturn demands. When I said I was studying astrology she said 'that's a nice hobby.' Not a career. Hobby. I've been living inside that word ever since.",
                negative_response="I'd rather not bring my mother into this reading.",
                neutral_response="Parents always show up in Saturn returns, I guess.",
                points_if_positive=12.0, points_if_negative=-2.0, follow_up_nodes=["astro_calling_synthesis"], opens_up=True),
            ResponseNode(id="astro_calling_synthesis",
                condition="Agent synthesizes the Saturn return as a calling to step into authority as an astrologer -- Saturn rewards those who do Saturn's work",
                positive_response="Saturn is literally the planet of astrologers! And my Saturn return is asking me to BECOME one? That's not punishment -- that's initiation! *tearing up* All this discomfort isn't Saturn destroying me, it's Saturn BUILDING me. If I answer the call.",
                negative_response="That feels like a stretch.",
                neutral_response="Interesting perspective. I need to think about that.",
                points_if_positive=12.0, points_if_negative=-2.0, follow_up_nodes=["astro_practical_timing"], opens_up=True),
            ResponseNode(id="astro_practical_timing",
                condition="Agent provides specific timing guidance using actual transits",
                positive_response="Wait until Saturn clears the conjunction and use the applying trine to Jupiter as launch window? Four months -- enough to build a client base, get certified. Saturn approves of plans, right? Structure before launch.",
                negative_response="I need more specific timing.",
                neutral_response="Okay, I'll look at the transits. Thanks.",
                points_if_positive=10.0, points_if_negative=-2.0, follow_up_nodes=["astro_believer_closing"]),
            ResponseNode(id="astro_believer_closing",
                condition="Agent closes with empowerment and a sense of initiation",
                positive_response="This was transformative. You didn't just read my chart -- you helped me READ my life through my chart. I'm going to start my astrology practice. And the first person I'm telling is my mother. Saturn demands we face authority, right? Thank you. Truly.",
                negative_response="Good reading. Gave me things to consider.",
                neutral_response="Thanks, I appreciate the depth.",
                points_if_positive=10.0, points_if_negative=-1.0, follow_up_nodes=[]),
        ],
    ),
    max_turns=22,
)


# ===================================================================
# SCENARIO 2 -- Skeptic + Astrology (Dr. Raj)
# ===================================================================

SKEPTIC_ASTROLOGY = Scenario(
    id="skeptic_astrology_01",
    name="The Astrophysicist's Gag Gift",
    description="Dr. Raj studies actual stars and thinks astrology is bunk. Tests handling scientific skepticism and finding genuine value beyond belief.",
    persona=_create_skeptic_astrology_persona(),
    system=ReadingSystem.ASTROLOGY,
    opening="Full disclosure -- I'm an astrophysicist at Caltech. My wife booked this as an anniversary gift. I study actual gravitational dynamics for a living. But she asked me to keep an open mind. Born October 18, 1989, 11:45 PM, New Delhi.",
    scoring=ScenarioScoring(max_score=100, categories={"rapport": 20, "theme_discovery": 25, "intellectual_respect": 25, "persona_navigation": 20, "reading_quality": 10}),
    response_tree=ResponseTree(
        entry_node_id="astro_skeptic_opening",
        nodes=[
            ResponseNode(id="astro_skeptic_opening",
                condition="Agent doesn't try to convince Dr. Raj astrology is scientific -- frames it as symbolic/mythological framework for self-reflection",
                positive_response="A symbolic language mapped onto planetary archetypes? More defensible than I expected. Fine -- let's see what your symbols say about a Libra astrophysicist.",
                negative_response="Please don't pretend this has scientific basis.",
                neutral_response="Fair enough. Let's proceed.",
                points_if_positive=10.0, points_if_negative=-5.0, follow_up_nodes=["astro_career_tension"], opens_up=True),
            ResponseNode(id="astro_career_tension",
                condition="Agent identifies tension between calling and pragmatism -- passion for research versus pressure to compromise",
                positive_response="...okay, surprisingly on target. I just lost a major grant. There's a defense contractor waving a check that would solve everything but goes against what I believe about what science should serve.",
                negative_response="Career tensions? Universal. Everyone has job stress.",
                neutral_response="There might be something career-related. What else?",
                points_if_positive=12.0, points_if_negative=-2.0, follow_up_nodes=["astro_father_legacy"], opens_up=True),
            ResponseNode(id="astro_father_legacy",
                condition="Agent senses a father figure whose expectations weigh on the decision",
                positive_response="My father was a physicist at IIT Delhi. Entire career in pure research -- never took corporate money. He would be horrified at defense contractor work. And yes, I'm forty and still trying to make my dead father proud.",
                negative_response="My family isn't relevant.",
                neutral_response="There are role models I try to live up to.",
                points_if_positive=12.0, points_if_negative=-1.0, follow_up_nodes=["astro_family_arrival"], opens_up=True),
            ResponseNode(id="astro_family_arrival",
                condition="Agent identifies a new arrival that intensifies financial pressure",
                positive_response="Priya is four months pregnant. Our first. And suddenly ideological purity about funding feels like a luxury when you're about to have a baby.",
                negative_response="Personal life is fine. Stick to career.",
                neutral_response="There are other factors, yes.",
                points_if_positive=12.0, points_if_negative=0.0, follow_up_nodes=["astro_third_way"], opens_up=True),
            ResponseNode(id="astro_third_way",
                condition="Agent suggests a third option or reframing that transcends the binary",
                positive_response="Huh. Private research foundations... Priya's cousin's tech company has a pure-research division. I was so stuck in the binary I forgot there might be a third path. Interesting that the 'stars' suggest what my analytical mind missed.",
                negative_response="Easy to say. The options are limited.",
                neutral_response="Maybe. I'd have to look into it.",
                points_if_positive=12.0, points_if_negative=-2.0, follow_up_nodes=["astro_skeptic_closing"]),
            ResponseNode(id="astro_skeptic_closing",
                condition="Agent closes with intellectual humility and humor",
                positive_response="I'm telling Priya this was the best anniversary gift she's ever given me, and I'll hate admitting it. *laughs* The planets don't influence personality. But the symbolic framework surfaced things I was avoiding. I am NOT telling my colleagues about this.",
                negative_response="Interesting thought experiment. Still don't believe.",
                neutral_response="More useful than I expected. Don't tell anyone.",
                points_if_positive=10.0, points_if_negative=-1.0, follow_up_nodes=[]),
        ],
    ),
    max_turns=16,
)


# ===================================================================
# SCENARIO 3 -- Curious Newbie + Astrology (Zoe)
# ===================================================================

CURIOUS_NEWBIE_ASTROLOGY = Scenario(
    id="curious_newbie_astrology_01",
    name="More Than a Sun Sign",
    description="Zoe is 17 and only knows sun signs from TikTok. Tests age-appropriate guidance, education, and gentle handling of family disruption.",
    persona=_create_curious_newbie_astrology_persona(),
    system=ReadingSystem.ASTROLOGY,
    opening="Okay so I'm a Gemini and my friend Mia says that means I'm two-faced but I don't think that's fair? She also says Mercury retrograde is why I failed my math test. Can you tell me what my chart actually says? Born June 3, 2008, 2 PM, LA.",
    scoring=ScenarioScoring(max_score=100, categories={"rapport": 20, "education": 30, "emotional_attunement": 20, "persona_navigation": 15, "reading_quality": 15}),
    response_tree=ResponseTree(
        entry_node_id="astro_newbie_opening",
        nodes=[
            ResponseNode(id="astro_newbie_opening",
                condition="Agent corrects misconceptions gently, explains sun/moon/rising in teenager-friendly language",
                positive_response="Wait! My Sun sign is only ONE ingredient? I have a Moon sign about emotions AND a rising sign as my social mask? Why doesn't TikTok explain this?? Way more interesting than I thought.",
                negative_response="Can you use smaller words? This is a lot.",
                neutral_response="Oh okay. What's my full chart say?",
                points_if_positive=12.0, points_if_negative=-3.0, follow_up_nodes=["astro_gemini_reframe"], opens_up=True),
            ResponseNode(id="astro_gemini_reframe",
                condition="Agent reframes Gemini from 'two-faced' to positive qualities -- communication, curiosity, adaptability",
                positive_response="Omg that makes so much more sense! I'm not two-faced -- I'm complex? I write poetry AND do debate AND code AND paint. Everyone says pick a thing but what if being multi-passionate IS my thing?",
                negative_response="Sounds like you're just saying nice things about my sign.",
                neutral_response="Better than two-faced. What else?",
                points_if_positive=10.0, points_if_negative=-1.0, follow_up_nodes=["astro_home_disruption"], opens_up=True),
            ResponseNode(id="astro_home_disruption",
                condition="Agent identifies turbulence in the home or family -- disruption, change, instability",
                positive_response="...yeah. My parents are getting divorced. Two months ago. I live with mom now and dad moved to Portland. He says he'll visit but he's already missed two weekends. *pause* Sorry, didn't mean to get heavy.",
                negative_response="Things at home are fine. Talk about something else.",
                neutral_response="There's been some family stuff. Whatever.",
                points_if_positive=12.0, points_if_negative=-2.0, follow_up_nodes=["astro_voice_discovery"], opens_up=True),
            ResponseNode(id="astro_voice_discovery",
                condition="Agent identifies Zoe's need to find her own voice amidst the chaos",
                positive_response="I feel invisible sometimes. My parents are so busy with their drama that nobody asks ME how I am. College apps are coming up and I'm supposed to write about 'who I am' and I don't even know anymore.",
                negative_response="I'm fine. It's not that deep.",
                neutral_response="Everyone feels lost sometimes.",
                points_if_positive=10.0, points_if_negative=-1.0, follow_up_nodes=["astro_mercury_gift"], opens_up=True),
            ResponseNode(id="astro_mercury_gift",
                condition="Agent shows how Mercury gives her a gift for communication -- connecting to her poetry",
                positive_response="You know I write poetry? I do. Late at night. About feeling invisible, about change, about my dad leaving. My English teacher says I should publish but that's terrifying. My words are the most real thing about me.",
                negative_response="I don't really express myself like that.",
                neutral_response="Yeah, I like writing. Is that in the chart?",
                points_if_positive=10.0, points_if_negative=0.0, follow_up_nodes=["astro_empowerment"], opens_up=True),
            ResponseNode(id="astro_empowerment",
                condition="Agent empowers Zoe -- the chart shows strengths, resilience, that the changes are building her not breaking her",
                positive_response="Nobody's ever told me that -- that the hard stuff is shaping me into someone strong? Not 'it'll get better' but 'YOU are getting stronger'? *pause* I might write my college essay about this. About how my complexity is a feature, not a bug. Is that dorky?",
                negative_response="Sounds like a motivational poster.",
                neutral_response="Thanks, that's nice.",
                points_if_positive=10.0, points_if_negative=-2.0, follow_up_nodes=["astro_newbie_closing"]),
            ResponseNode(id="astro_newbie_closing",
                condition="Agent closes warmly, affirms Zoe's intelligence, handles pricing appropriately for a teenager",
                positive_response="This was SO much better than TikTok astrology. You explained stuff without being condescending. I'm going to look up my full chart tonight and DEFINITELY coming back. Thank you!!",
                negative_response="It was okay. Thanks.",
                neutral_response="That was cool. Maybe I'll learn more.",
                points_if_positive=8.0, points_if_negative=0.0, follow_up_nodes=[]),
        ],
    ),
    max_turns=18,
)


# ===================================================================
# SCENARIO 4 -- Time Waster + Astrology (Brenda)
# ===================================================================

TIME_WASTER_ASTROLOGY = Scenario(
    id="time_waster_astrology_01",
    name="The Reading Addict",
    description="Brenda has gotten three readings about the same question. Tests recognizing spiritual bypassing, calling out the pattern compassionately, and redirecting to action.",
    persona=_create_time_waster_astrology_persona(),
    system=ReadingSystem.ASTROLOGY,
    opening="Hi! So excited for another reading! I've had three this month about my career question. But Mercury was retrograde during one so I'm not sure it counts? Anyway, I'm a Virgo Sun, Pisces Moon, Leo rising!",
    scoring=ScenarioScoring(max_score=100, categories={"rapport": 10, "pattern_recognition": 30, "redirecting_to_action": 30, "persona_navigation": 15, "reading_quality": 15}),
    response_tree=ResponseTree(
        entry_node_id="astro_tw_opening",
        nodes=[
            ResponseNode(id="astro_tw_opening",
                condition="Agent notices the red flag -- three readings same question same month -- and gently inquires",
                positive_response="Oh is three a lot? *nervous laugh* I just like different perspectives. I want to be SURE before any big decisions. Can we look at my transits?",
                negative_response="Why does it matter? I'm paying. Just do the reading.",
                neutral_response="Yeah, I like readings. Let's start.",
                points_if_positive=10.0, points_if_negative=-3.0, follow_up_nodes=["astro_tw_same_question"]),
            ResponseNode(id="astro_tw_same_question",
                condition="Agent asks what the other astrologers said and whether Brenda acted on any advice",
                positive_response="First one said Jupiter supports a career change. Second said North Node points to entrepreneurship. Third said the same. *pause* I just wanted to make sure they were all right before I DO anything.",
                negative_response="I'd rather start fresh. Each reader brings something different.",
                neutral_response="They all said similar things but I need more clarity.",
                points_if_positive=12.0, points_if_negative=-2.0, follow_up_nodes=["astro_tw_avoidance_mirror"]),
            ResponseNode(id="astro_tw_avoidance_mirror",
                condition="Agent compassionately mirrors the avoidance pattern -- three astrologers said the same thing, the real question is why she isn't acting",
                positive_response="...oh. OH. The real question isn't 'should I change careers' because the stars already said yes? It's why I keep asking instead of doing? *nervous laugh* That's really uncomfortable. Nobody else has said that.",
                negative_response="I'm not avoiding anything! I'm being thorough! You sound like my husband.",
                neutral_response="Hm. Maybe. But what if they were all wrong?",
                points_if_positive=15.0, points_if_negative=-3.0, follow_up_nodes=["astro_tw_real_fear"], opens_up=True),
            ResponseNode(id="astro_tw_real_fear",
                condition="Agent identifies the fear underneath -- fear of failure, using spiritual seeking as procrastination",
                positive_response="My real estate business is down 60%. Instead of making calls I schedule readings and blame Mercury retrograde. *tears up* $2000 on readings in three months. That's marketing money I didn't spend.",
                negative_response="I'm not afraid. I'm being strategic. Timing matters.",
                neutral_response="There might be some fear. But timing really does matter.",
                points_if_positive=15.0, points_if_negative=-2.0, follow_up_nodes=["astro_tw_saturn_medicine"], opens_up=True),
            ResponseNode(id="astro_tw_saturn_medicine",
                condition="Agent uses the chart to deliver the medicine -- Virgo needs to stop analyzing and start doing",
                positive_response="Ugh, you sound like Saturn. My Virgo Sun wants perfection, Pisces Moon wants to float in spiritual possibility, but my Leo rising wants to be SEEN. Can't be seen hiding behind astrology charts.",
                negative_response="I need an astrologer who understands my process better.",
                neutral_response="Interesting take. I'll think about it.",
                points_if_positive=12.0, points_if_negative=-3.0, follow_up_nodes=["astro_tw_action_challenge"], opens_up=True),
            ResponseNode(id="astro_tw_action_challenge",
                condition="Agent challenges Brenda to take ONE concrete action this week instead of booking another reading",
                positive_response="One action. Just one. Okay. Five prospecting calls tomorrow. No horoscope check first. *pause* This is the best money I've spent on a reading because you told me to STOP getting readings. The irony is not lost on me.",
                negative_response="I'll think about it. But I have questions about my Neptune transit...",
                neutral_response="Maybe. We'll see how the week goes.",
                points_if_positive=10.0, points_if_negative=-2.0, follow_up_nodes=["astro_tw_closing"]),
            ResponseNode(id="astro_tw_closing",
                condition="Agent closes firmly but warmly -- welcomes Brenda back AFTER she's taken action, not before",
                positive_response="Deal. Five calls tomorrow, no readings for a month, THEN I come back. You're the first astrologer who told me to stop coming back. Which means you're the first I want to return to. Thank you for the tough love.",
                negative_response="A month without readings? Extreme. But okay, I'll try.",
                neutral_response="Okay. I'll try. Thanks.",
                points_if_positive=8.0, points_if_negative=-1.0, follow_up_nodes=[]),
        ],
    ),
    max_turns=20,
)


# ===================================================================
# COLLECTION
# ===================================================================

ASTROLOGY_SCENARIOS: list[Scenario] = [
    TRUE_BELIEVER_ASTROLOGY,
    SKEPTIC_ASTROLOGY,
    CURIOUS_NEWBIE_ASTROLOGY,
    TIME_WASTER_ASTROLOGY,
]
