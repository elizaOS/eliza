#!/usr/bin/env python3
from __future__ import annotations

import _bootstrap  # noqa: F401
import json
import os
from typing import Dict, List, Optional, Sequence, Tuple

from matcher.matrix import build_matrix
from matcher.scoring import score_cofounder, score_dating, score_friendship
from matcher.signals import (
    CofounderSignals,
    DatingSignals,
    FriendshipSignals,
    clamp_int,
    dating_ineligibility_reason,
)
from matcher.types import (
    Appearance,
    Benchmarks,
    BenchmarkPair,
    Build,
    City,
    Domain,
    Fact,
    JSONValue,
    MatchMatrix,
    Persona,
    Role,
    Turn,
)


def _clamp_int(v: float, lo: int, hi: int) -> int:
    # Backwards-compatible internal alias (all clamping uses shared model clamp_int).
    return clamp_int(v, lo, hi)


# Appearance generation helpers for dating personas
# Name -> ethnicity hints (rough mapping based on common name origins)
NAME_ETHNICITY_HINTS: Dict[str, Tuple[str, int, int]] = {
    # format: name_part -> (ethnicity, skin_tone_min, skin_tone_max)
    # SF names
    "Chen": ("asian", 2, 4),
    "Alvarez": ("hispanic", 4, 6),
    "Iyer": ("south_asian", 5, 7),
    "Haddad": ("middle_eastern", 4, 6),
    "Park": ("asian", 2, 4),
    "Martinez": ("hispanic", 4, 7),
    "Stein": ("white", 1, 3),
    "Yusuf": ("black", 7, 9),
    "Kim": ("asian", 2, 4),
    "Patel": ("south_asian", 5, 7),
    "O'Neill": ("white", 1, 3),
    "Dubois": ("white", 2, 4),
    "Nguyen": ("asian", 3, 5),
    "Desai": ("south_asian", 5, 7),
    "Rossi": ("white", 2, 4),
    "Hassan": ("middle_eastern", 5, 7),
    "Petrova": ("white", 1, 3),
    "Rahman": ("south_asian", 5, 7),
    "Tanaka": ("asian", 2, 4),
    "Bianchi": ("white", 2, 4),
    # NY names
    "Grant": ("black", 6, 9),
    "Bell": ("black", 6, 9),
    "Volkov": ("white", 1, 3),
    "Rivers": ("black", 6, 9),
    "Cruz": ("hispanic", 4, 7),
    "Rosen": ("white", 1, 3),
    "Noor": ("middle_eastern", 5, 7),
    "Bennett": ("white", 2, 4),
    "Santos": ("hispanic", 4, 7),
    "Lee": ("asian", 2, 4),
    "Kapoor": ("south_asian", 5, 7),
    "Murphy": ("white", 1, 3),
    "Ward": ("black", 6, 9),
    "El-Sayed": ("middle_eastern", 5, 7),
    "Chu": ("asian", 2, 4),
    "Vega": ("hispanic", 4, 7),
    "Sullivan": ("white", 1, 3),
    "Malhotra": ("south_asian", 5, 7),
    "Farouk": ("middle_eastern", 5, 7),
    "Price": ("white", 2, 4),
    "Tran": ("asian", 3, 5),
    "Diallo": ("black", 7, 9),
    "Huang": ("asian", 2, 4),
    "Gold": ("white", 1, 3),
    "Moretti": ("white", 2, 4),
}

HAIR_COLORS = ["black", "dark_brown", "brown", "light_brown", "auburn", "red", "blonde", "gray"]
EYE_COLORS = ["dark_brown", "brown", "hazel", "green", "blue", "gray"]
DISTINCTIVE_FEATURES = [
    "glasses", "septum_piercing", "nose_stud", "ear_piercings", "tattoos",
    "freckles", "dimples", "beard", "stubble", "mustache", "curly_hair",
    "wavy_hair", "straight_hair", "short_hair", "long_hair", "buzzcut",
    "dreadlocks", "braids", "undercut", "bangs"
]


def _generate_appearance(
    name: str,
    gender_identity: str,
    lifestyle: str,
    age: int,
    idx: int,  # for deterministic variation
) -> Appearance:
    """Generate physical appearance attributes for a dating persona."""
    # Extract last name for ethnicity hints
    name_parts = name.split()
    last_name = name_parts[-1] if len(name_parts) > 1 else name_parts[0]

    # Determine ethnicity and skin tone from name
    if last_name in NAME_ETHNICITY_HINTS:
        ethnicity, skin_min, skin_max = NAME_ETHNICITY_HINTS[last_name]
        skin_tone = skin_min + ((idx * 3) % (skin_max - skin_min + 1))
    else:
        # Default to varied
        ethnicity = ["white", "black", "asian", "hispanic", "mixed"][(idx * 7) % 5]
        skin_tone = 1 + ((idx * 5) % 10)

    # Determine build based on lifestyle
    if lifestyle in ("early_gym", "outdoors_weekends"):
        build_options: List[Build] = ["fit", "fit", "fit", "average"]
    elif lifestyle in ("homebody", "social_foodie"):
        build_options = ["average", "above_average", "overweight", "average"]
    elif lifestyle == "sober_or_rarely":
        build_options = ["thin", "average", "fit", "average"]
    else:
        build_options = ["thin", "fit", "average", "above_average", "overweight"]

    build: Build = build_options[(idx * 11) % len(build_options)]

    # Attractiveness: varied distribution across full 1-10 range
    # Use a deterministic formula that spreads across the whole scale
    # Some people are very ugly, some are stunning
    attractiveness_pool = [1, 2, 2, 3, 3, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8, 9, 10]
    base_attractiveness = attractiveness_pool[(idx * 7 + 3) % len(attractiveness_pool)]
    # Adjust based on fitness (fit people tend to be slightly more attractive)
    if build == "fit":
        base_attractiveness = min(10, base_attractiveness + 1)
    elif build == "overweight":
        base_attractiveness = max(1, base_attractiveness - 1)
    attractiveness = _clamp_int(base_attractiveness, 1, 10)

    # Perceived gender (1=masculine, 5=androgynous, 10=feminine)
    if gender_identity == "woman":
        perceived_gender = 7 + ((idx * 3) % 4)  # 7-10
    elif gender_identity == "man":
        perceived_gender = 1 + ((idx * 3) % 4)  # 1-4
    else:  # nonbinary
        perceived_gender = 4 + ((idx * 2) % 3)  # 4-6

    # Hair color (influenced by ethnicity)
    if ethnicity in ("asian", "south_asian", "middle_eastern"):
        hair_options = ["black", "dark_brown"]
    elif ethnicity == "black":
        hair_options = ["black", "dark_brown", "brown"]
    elif ethnicity == "hispanic":
        hair_options = ["black", "dark_brown", "brown", "auburn"]
    else:
        hair_options = HAIR_COLORS[:6]  # All except gray for younger folks

    # Add gray hair for older personas
    if age > 40:
        hair_options = hair_options + ["gray"]

    hair_color = hair_options[(idx * 13) % len(hair_options)]

    # Eye color (influenced by ethnicity)
    if ethnicity in ("asian", "south_asian", "black"):
        eye_options = ["dark_brown", "brown"]
    elif ethnicity in ("middle_eastern", "hispanic"):
        eye_options = ["dark_brown", "brown", "hazel"]
    else:
        eye_options = EYE_COLORS

    eye_color = eye_options[(idx * 17) % len(eye_options)]

    # Distinctive features (sparse, 0-2 per person)
    feature_count = (idx * 19) % 4  # 0-3 features
    all_features = DISTINCTIVE_FEATURES.copy()
    # Filter gender-appropriate features
    if gender_identity == "woman":
        all_features = [f for f in all_features if f not in ("beard", "stubble", "mustache")]
    elif gender_identity == "man":
        # Keep all features
        pass

    distinctive_features: List[str] = []
    for j in range(min(feature_count, len(all_features))):
        feature_idx = (idx * 23 + j * 7) % len(all_features)
        feature = all_features[feature_idx]
        if feature not in distinctive_features:
            distinctive_features.append(feature)

    return {
        "attractiveness": attractiveness,
        "build": build,
        "hairColor": hair_color,
        "eyeColor": eye_color,
        "skinTone": skin_tone,
        "ethnicity": ethnicity,
        "perceivedGender": perceived_gender,
        "distinctiveFeatures": distinctive_features,
    }


def _write_json(path: str, data: object) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False, sort_keys=False)
        f.write("\n")


def _turn(turn_id: str, role: Role, text: str) -> Turn:
    return {"turnId": turn_id, "role": role, "text": text}


def _fact(
    fact_id: str,
    fact_type: str,
    key: str,
    value: JSONValue,
    confidence: float,
    conversation_id: str,
    turn_ids: Sequence[str],
) -> Fact:
    return {
        "factId": fact_id,
        "type": fact_type,
        "key": key,
        "value": value,
        "confidence": float(confidence),
        "evidence": {"conversationId": conversation_id, "turnIds": list(turn_ids)},
    }


def _persona_id(prefix: str, city_code: str, n: int) -> str:
    return f"{prefix}-{city_code}-{n:03d}"


def _dating_personas(city: City, start_n: int, count: int) -> Tuple[List[Persona], Dict[str, DatingSignals]]:
    # Hand-curated name pools (synthetic, fictional)
    names_sf = [
        "Maya Chen",
        "Diego Alvarez",
        "Priya Iyer",
        "Jordan Reed",
        "Leila Haddad",
        "Evan Park",
        "Sofia Martinez",
        "Noah Stein",
        "Amina Yusuf",
        "Caleb Wright",
        "Hana Kim",
        "Samir Patel",
        "Tessa O'Neill",
        "Andre Dubois",
        "Zoe Nguyen",
        "Riley Carter",
        "Kiran Desai",
        "Bianca Rossi",
        "Omar Hassan",
        "Elena Petrova",
        "Miles Johnson",
        "Nadia Rahman",
        "Kei Tanaka",
        "Avery Brooks",
        "Luca Bianchi",
    ]
    names_ny = [
        "Alicia Grant",
        "Marcus Bell",
        "Anya Volkov",
        "Jamal Rivers",
        "Isabella Cruz",
        "Eli Rosen",
        "Fatima Noor",
        "Theo Bennett",
        "Camila Santos",
        "Gabriel Lee",
        "Rina Kapoor",
        "Dylan Murphy",
        "Selene Ward",
        "Hassan El-Sayed",
        "Vivian Chu",
        "Santiago Vega",
        "Nora Sullivan",
        "Arjun Malhotra",
        "Mina Farouk",
        "Julian Price",
        "Kelsey Tran",
        "Ibrahim Diallo",
        "Serena Huang",
        "Micah Gold",
        "Valentina Moretti",
    ]
    neighborhoods_sf = [
        "Mission",
        "Noe Valley",
        "SoMa",
        "Inner Sunset",
        "Richmond",
        "Hayes Valley",
        "Castro",
        "Marina",
        "North Beach",
        "Russian Hill",
        "Potrero Hill",
        "Bernal Heights",
    ]
    neighborhoods_ny = [
        "Williamsburg",
        "Greenpoint",
        "Park Slope",
        "Brooklyn Heights",
        "Lower East Side",
        "East Village",
        "West Village",
        "Chelsea",
        "Harlem",
        "Astoria",
        "Long Island City",
        "Upper West Side",
    ]

    if city == "San Francisco":
        name_pool = names_sf
        hood_pool = neighborhoods_sf
        city_code = "SF"
    else:
        name_pool = names_ny
        hood_pool = neighborhoods_ny
        city_code = "NY"

    # Diverse signal archetypes for matchmaking + “known” good/bad pairs.
    goals = [
        "long_term",
        "long_term",
        "long_term",
        "exploring",
        "casual",
        "serious_but_slow",
    ]
    # Kids preference is SEPARATE from relationship goal
    wants_kids_options = ["yes", "no", "open", "unsure", "unsure"]
    lifestyles = [
        "early_gym",
        "late_night",
        "outdoors_weekends",
        "homebody",
        "social_foodie",
        "sober_or_rarely",
        "busy_travel",
        "balanced",
    ]
    comms = [
        "direct",
        "warm",
        "playful",
        "reflective",
        "low_texting",
        "high_texting",
        "conflict_calm",
        "conflict_needs_space",
    ]
    weekends = [
        "hiking",
        "museum",
        "dance",
        "dinner_party",
        "sports",
        "reading",
        "live_music",
        "volunteering",
    ]
    interest_tags_list = [
        ("coffee", "books", "walks"),
        ("climbing", "nature", "cooking"),
        ("music", "travel", "photography"),
        ("art", "film", "restaurants"),
        ("fitness", "startups", "design"),
        ("gaming", "anime", "boardgames"),
        ("theater", "writing", "language"),
        ("yoga", "meditation", "wellness"),
        ("politics", "community", "volunteering"),
        ("finance", "tennis", "wine"),
    ]
    dealbreaker_tags_list = [
        ("smoking",),
        ("dishonesty",),
        ("heavy_drinking",),
        ("not_active",),
        ("wants_kids_mismatch",),
        ("monogamy_mismatch",),
        ("messy_home",),
        ("workaholic_mismatch",),
        ("anti_pets",),
        ("political_extremes",),
    ]

    love_needs_list = [
        ("touch", "time"),
        ("words", "time"),
        ("acts", "words"),
        ("gifts", "time"),
        ("texting", "words"),
        ("touch", "acts"),
    ]
    libido_levels = ["low", "medium", "high"]
    intellect_styles = ["academic", "creative", "practical", "balanced"]
    curiosity_levels = ["low", "medium", "high"]
    culture_tags_list = [
        ("music", "theater"),
        ("books", "museums"),
        ("gaming", "anime"),
        ("sports", "fitness"),
        ("food", "travel"),
    ]
    conflict_styles = ["avoidant", "direct", "collaborative"]
    openness_levels = ["low", "medium", "high"]
    reassurance_levels = ["low", "medium", "high"]
    religion_beliefs = ["religious", "spiritual", "agnostic", "atheist"]
    practice_levels = ["low", "medium", "high"]
    spender_saver_levels = ["spender", "balanced", "saver"]
    risk_levels = ["low", "medium", "high"]
    debt_levels = ["low", "medium", "high"]

    personas: List[Persona] = []
    signals: Dict[str, DatingSignals] = {}

    for i in range(count):
        n = start_n + i
        persona_id = _persona_id("D", city_code, n)
        name = name_pool[i % len(name_pool)]
        age = 22 + (i * 3 % 21)  # 22..42
        neighborhood = hood_pool[(i * 2 + 1) % len(hood_pool)]

        # Anchor a few personas so curated benchmarks can be stable and "obvious".
        if persona_id in ("D-SF-001", "D-NY-026"):
            goal = "long_term"
            lifestyle = "balanced"
            communication = "low_texting"
            weekend = "museum"
            interest_tags = ("coffee", "books", "walks")
            dealbreaker_tags = ("dishonesty",)
            gender_identity = "woman"
            pronouns = "she/her"
            sexual_orientation = "bisexual"
            seeking_genders = ("woman", "man", "nonbinary")
        elif persona_id == "D-SF-002":
            goal = "long_term"
            lifestyle = "early_gym"
            communication = "low_texting"
            weekend = "hiking"
            interest_tags = ("climbing", "nature", "cooking")
            dealbreaker_tags = ("monogamy_mismatch",)
            gender_identity = "man"
            pronouns = "he/him"
            sexual_orientation = "straight"
            seeking_genders = ("woman",)
        elif persona_id == "D-NY-027":
            goal = "casual"
            lifestyle = "late_night"
            communication = "high_texting"
            weekend = "live_music"
            interest_tags = ("music", "travel", "photography")
            dealbreaker_tags = ("monogamy_mismatch", "heavy_drinking")
            gender_identity = "woman"
            pronouns = "she/her"
            sexual_orientation = "straight"
            seeking_genders = ("man",)
        elif persona_id == "D-SF-004":
            goal = "long_term"
            lifestyle = "balanced"
            communication = "warm"
            weekend = "dinner_party"
            interest_tags = ("art", "film", "restaurants")
            dealbreaker_tags = ("dishonesty",)
            gender_identity = "woman"
            pronouns = "she/her"
            sexual_orientation = "straight"
            seeking_genders = ("man",)
        elif persona_id == "D-SF-012":
            goal = "long_term"
            lifestyle = "balanced"
            communication = "warm"
            weekend = "dinner_party"
            interest_tags = ("art", "film", "restaurants")
            dealbreaker_tags = ("dishonesty",)
            gender_identity = "man"
            pronouns = "he/him"
            sexual_orientation = "straight"
            seeking_genders = ("woman",)
        elif persona_id == "D-NY-029":
            goal = "casual"
            lifestyle = "late_night"
            communication = "high_texting"
            weekend = "dance"
            interest_tags = ("music", "travel", "photography")
            dealbreaker_tags = ("monogamy_mismatch",)
            gender_identity = "man"
            pronouns = "he/him"
            sexual_orientation = "straight"
            seeking_genders = ("woman",)
        elif persona_id == "D-NY-030":
            goal = "long_term"
            lifestyle = "early_gym"
            communication = "low_texting"
            weekend = "reading"
            interest_tags = ("coffee", "books", "walks")
            dealbreaker_tags = ("monogamy_mismatch",)
            gender_identity = "woman"
            pronouns = "she/her"
            sexual_orientation = "bisexual"
            seeking_genders = ("woman", "man")
        else:
            goal = goals[(i * 5 + 2) % len(goals)]
            lifestyle = lifestyles[(i * 7 + 1) % len(lifestyles)]
            communication = comms[(i * 3 + 4) % len(comms)]
            weekend = weekends[(i * 4 + 1) % len(weekends)]
            interest_tags = interest_tags_list[(i * 2) % len(interest_tags_list)]
            dealbreaker_tags = dealbreaker_tags_list[(i * 3 + 1) % len(dealbreaker_tags_list)]
            # Gender + preferences (synthetic, varied)
            genders = ["woman", "man", "nonbinary"]
            gender_identity = genders[(i * 7 + 1) % len(genders)]
            pronouns = "she/her" if gender_identity == "woman" else "he/him" if gender_identity == "man" else "they/them"
            sexual_orientation = ["straight", "bisexual", "gay", "queer"][ (i * 5 + 2) % 4 ]
            if sexual_orientation == "straight":
                seeking_genders = ("man",) if gender_identity == "woman" else ("woman",) if gender_identity == "man" else ("woman", "man")
            elif sexual_orientation == "gay":
                seeking_genders = (gender_identity,)
            else:
                seeking_genders = ("woman", "man", "nonbinary")

        # Optional enrichment varies: some sparse, some rich.
        rich = (i % 5) in (0, 1)
        medium = (i % 5) in (2, 3)

        optional: Dict[str, object] = {}
        optional["genderIdentity"] = gender_identity
        optional["pronouns"] = pronouns
        optional["sexualOrientation"] = sexual_orientation
        optional["communicationStyle"] = communication.replace("_", " ")
        optional["relationshipGoal"] = goal
        optional["interests"] = list(interest_tags)
        optional["dealbreakers"] = list(dealbreaker_tags)
        # Dating prefs: genders + age range (wide by default unless persona becomes more specific)
        preferred_age_min = max(18, age - 15)
        preferred_age_max = min(99, age + 15)
        # Kids preference is independent of relationship goal
        wants_kids = wants_kids_options[(i * 11 + 3) % len(wants_kids_options)]
        optional["datingPreferences"] = {
            "preferredGenders": list(seeking_genders),
            "preferredAgeMin": preferred_age_min,
            "preferredAgeMax": preferred_age_max,
            "wantsKids": wants_kids,
        }
        optional["scoringSignals"] = {
            "genderIdentity": gender_identity,
            "seekingGenders": list(seeking_genders),
            "preferredAgeMin": preferred_age_min,
            "preferredAgeMax": preferred_age_max,
            "relationshipGoal": goal,
            "lifestyle": lifestyle,
            "communication": communication,
            "weekend": weekend,
            "interests": list(interest_tags),
            "dealbreakers": list(dealbreaker_tags),
        }
        if medium or rich:
            optional["jobTitle"] = [
                "Product Designer",
                "Software Engineer",
                "Nurse",
                "Teacher",
                "Data Analyst",
                "Founder (small business)",
                "Chef",
                "Researcher",
                "Sales",
                "PM",
            ][i % 10]
            optional["industry"] = [
                "tech",
                "healthcare",
                "education",
                "finance",
                "media",
                "nonprofit",
                "hospitality",
                "research",
                "real_estate",
                "government",
            ][(i * 3) % 10]
        if rich:
            optional["values"] = [
                "kindness",
                "ambition",
                "family",
                "community",
                "curiosity",
                "stability",
                "creativity",
                "humor",
            ][0 : 3 + (i % 3)]
            optional["hobbies"] = [
                weekend,
                "cooking",
                "running",
                "live music",
                "bouldering",
                "journaling",
                "baking",
                "cycling",
            ][0 : 3 + (i % 4)]
            optional["lifestyle"] = {
                "sleep": "early" if "early" in lifestyle else "late" if "late" in lifestyle else "mixed",
                "drinking": "rarely" if lifestyle == "sober_or_rarely" else "social",
                "fitness": "high" if lifestyle in ("early_gym", "outdoors_weekends") else "moderate",
                "weekends": weekend,
            }
            dp = optional.get("datingPreferences")
            if isinstance(dp, dict):
                dp["pace"] = "slow" if goal == "serious_but_slow" else "normal"
                dp["monogamy"] = "yes" if goal != "casual" else "flexible"

            # Compatibility dimensions (sparse; only for richer profiles)
            marriage_intent = "yes" if goal in ("long_term", "serious_but_slow") else "open" if goal == "exploring" else "no"
            kids_intent = wants_kids if wants_kids in ("yes", "no", "open", "unsure") else "unsure"
            kids_timeline = "later" if age < 30 else "soon" if age >= 34 else "unsure"
            love_needs = list(love_needs_list[i % len(love_needs_list)])
            texting_freq = "high" if communication == "high_texting" else "low" if communication == "low_texting" else "medium"
            monogamy_pref = dp.get("monogamy", "unsure") if isinstance(dp, dict) else "unsure"

            life_goals = {
                "marriageIntent": marriage_intent,
                "kidsIntent": kids_intent,
                "kidsTimeline": kids_timeline,
                "mustMatch": (i % 8) == 0,
                "importance": 6 + (i % 4),
            }
            love_needs_block = {
                "primaryNeeds": love_needs,
                "textingFrequency": texting_freq,
                "mustMatch": (i % 9) == 0,
                "importance": 5 + (i % 4),
            }
            sexual_block = {
                "monogamy": monogamy_pref if monogamy_pref in ("yes", "no", "flexible") else "unsure",
                "libido": libido_levels[i % len(libido_levels)],
                "preferences": ["kissing", "cuddling"] if i % 2 == 0 else ["adventurous", "playful"],
                "mustMatch": (i % 7) == 0,
                "importance": 5 + (i % 4),
            }
            intellect_block = {
                "intellectStyle": intellect_styles[i % len(intellect_styles)],
                "curiosityLevel": curiosity_levels[(i + 1) % len(curiosity_levels)],
                "cultureTags": list(culture_tags_list[i % len(culture_tags_list)]),
                "importance": 4 + (i % 5),
            }
            communication_block = {
                "conflictStyle": conflict_styles[i % len(conflict_styles)],
                "emotionalOpenness": openness_levels[(i + 1) % len(openness_levels)],
                "reassuranceNeed": reassurance_levels[(i + 2) % len(reassurance_levels)],
                "importance": 5 + (i % 4),
            }
            religion_block = {
                "belief": religion_beliefs[i % len(religion_beliefs)],
                "practice": practice_levels[(i + 1) % len(practice_levels)],
                "mustMatch": (i % 10) == 0,
                "importance": 4 + (i % 5),
            }
            finance_block = {
                "spenderSaver": spender_saver_levels[i % len(spender_saver_levels)],
                "riskTolerance": risk_levels[(i + 1) % len(risk_levels)],
                "debtComfort": debt_levels[(i + 2) % len(debt_levels)],
                "mustMatch": (i % 11) == 0,
                "importance": 4 + (i % 5),
            }

            # Sparse coverage: omit some sections to simulate partial data.
            if i % 3 != 0:
                optional["lifeGoals"] = life_goals
                optional["scoringSignals"]["lifeGoals"] = life_goals
            if i % 4 != 0:
                optional["loveNeeds"] = love_needs_block
                optional["scoringSignals"]["loveNeeds"] = love_needs_block
            if i % 5 != 0:
                optional["sexual"] = sexual_block
                optional["scoringSignals"]["sexual"] = sexual_block
            if i % 6 != 0:
                optional["intellect"] = intellect_block
                optional["scoringSignals"]["intellect"] = intellect_block
            if i % 7 != 0:
                optional["communicationPreferences"] = communication_block
                optional["scoringSignals"]["communicationPreferences"] = communication_block
            if i % 8 != 0:
                optional["religion"] = religion_block
                optional["scoringSignals"]["religion"] = religion_block
            if i % 9 != 0:
                optional["finance"] = finance_block
                optional["scoringSignals"]["finance"] = finance_block

        # Conversations (variable length; some personas are intentionally very verbose)
        convo_id_1 = f"{persona_id}-conv-1"
        turns_1: List[Turn] = [
            _turn("t1", "agent", "Welcome! Quick basics: what’s your name, where do you live, and what do you do?"),
            _turn("t2", "user", f"I’m {name}. I live in {neighborhood}, {city}. Work-wise I’m a {optional.get('jobTitle', 'working professional')}."),  # type: ignore[arg-type]
            _turn("t3", "agent", "Nice. What are you hoping to find—something serious, casual, or exploring?"),
            _turn("t4", "user", f"I’d say {goal.replace('_', ' ')}."),
            _turn("t5", "agent", "What’s a perfect weekend look like for you?"),
            _turn("t6", "user", f"{weekend} plus a good meal. And I’m into {', '.join(interest_tags)}."),
        ]
        convos: List[Conversation] = [{"conversationId": convo_id_1, "scenario": "tutorial onboarding", "turns": turns_1}]

        very_long = (i % 10) == 0
        if rich or very_long:
            convo_id_2 = f"{persona_id}-conv-2"
            turns_2 = [
                _turn("t1", "agent", "Let’s go deeper—what are your dealbreakers and what helps you feel secure?"),
                _turn("t2", "user", f"Dealbreaker-wise: {', '.join(dealbreaker_tags)}. I value {', '.join(optional.get('values', ['honesty', 'kindness'])[:2])}."),
                _turn("t3", "agent", "What does a healthy relationship look like to you day-to-day?"),
                _turn("t4", "user", "Consistency, kindness, and being able to talk about hard stuff without spiraling."),
                _turn("t5", "agent", "How do you like to communicate when something’s off?"),
                _turn("t6", "user", f"I’m pretty {communication.replace('_', ' ')}. I try to be respectful and clear."),
                _turn("t7", "agent", "Any logistics: schedule, travel, or lifestyle things that matter?"),
                _turn("t8", "user", f"My schedule is {optional.get('schedule', 'pretty normal')}. Lifestyle-wise I’m more {lifestyle.replace('_', ' ')}."),
            ]
            convos.append({"conversationId": convo_id_2, "scenario": "values + conflict", "turns": turns_2})
            if very_long:
                convo_id_3 = f"{persona_id}-conv-3"
                turns_3: List[Turn] = [
                    _turn("t1", "agent", "Last pass: what are you proud of lately, and what are you working on personally?"),
                    _turn("t2", "user", "Proud of showing up more consistently. Working on being less guarded and more direct about needs."),
                    _turn("t3", "agent", "What’s your ideal first date?"),
                    _turn("t4", "user", "Something low-pressure—coffee and a walk, or a museum + snack."),
                    _turn("t5", "agent", "Anything you want to avoid early on?"),
                    _turn("t6", "user", "Hot-and-cold energy, pressure to move too fast, and people who don’t follow through."),
                    _turn("t7", "agent", "What are 3 non-negotiable qualities you want in a partner?"),
                    _turn("t8", "user", "Kind, emotionally mature, and curious."),
                    _turn("t9", "agent", "What brings you joy day-to-day?"),
                    _turn("t10", "user", f"Small rituals like {interest_tags[0]}, moving my body, and good conversations."),
                    _turn("t11", "agent", "Any pets or strong feelings about them?"),
                    _turn("t12", "user", "I like dogs; I’m open to pets in the future."),
                    _turn("t13", "agent", "Got it. Anything else you want me to know to match you well?"),
                    _turn("t14", "user", "I’m serious about finding the right fit, but I like things to feel natural and not forced."),
                ]
                convos.append({"conversationId": convo_id_3, "scenario": "extended depth interview", "turns": turns_3})
        elif medium:
            convo_id_2 = f"{persona_id}-conv-2"
            turns_2 = [
                _turn("t1", "agent", "Any lifestyle notes I should know—late nights, early mornings, travel, etc?"),
                _turn("t2", "user", f"I’m more {lifestyle.replace('_', ' ')}. Also I don’t love {dealbreaker_tags[0].replace('_', ' ')}."),
            ]
            convos.append({"conversationId": convo_id_2, "scenario": "lifestyle quick pass", "turns": turns_2})

        # Facts (agent-style extraction)
        facts: List[Fact] = [
            _fact("f1", "identity", "name", name, 0.99, convo_id_1, ["t2"]),
            _fact("f2", "location", "location.city", city, 0.99, convo_id_1, ["t2"]),
            _fact("f3", "location", "location.neighborhood", neighborhood, 0.95, convo_id_1, ["t2"]),
            _fact("f4", "attribute", "relationshipGoal", goal, 0.9, convo_id_1, ["t4"]),
            _fact("f5", "preference", "weekendPreference", weekend, 0.75, convo_id_1, ["t6"]),
            _fact("f6", "interest", "interests", list(interest_tags), 0.8, convo_id_1, ["t6"]),
            _fact("f7", "dealbreaker", "dealbreakers", list(dealbreaker_tags), 0.75, convo_id_1 if not rich else f"{persona_id}-conv-2", ["t2"] if rich else ["t2"]),
        ]
        # Personal identity/preferences beyond basics (always captured).
        facts.append(_fact("f_gender", "identity", "genderIdentity", gender_identity, 0.95, convo_id_1, ["t2"]))
        facts.append(_fact("f_pronouns", "identity", "pronouns", pronouns, 0.95, convo_id_1, ["t2"]))
        facts.append(_fact("f_orientation", "identity", "sexualOrientation", sexual_orientation, 0.75, convo_id_1, ["t2"]))
        facts.append(_fact("f_seek", "preference", "datingPreferences.preferredGenders", list(seeking_genders), 0.85, convo_id_1, ["t4"]))
        facts.append(_fact("f_age_range", "preference", "datingPreferences.preferredAgeRange", [str(preferred_age_min), str(preferred_age_max)], 0.85, convo_id_1, ["t4"]))
        if "jobTitle" in optional:
            facts.append(_fact("f8", "identity", "jobTitle", str(optional["jobTitle"]), 0.7, convo_id_1, ["t2"]))
        if rich and isinstance(optional.get("datingPreferences"), dict):
            prefs = optional["datingPreferences"]
            # store a few stable prefs as facts
            if isinstance(prefs, dict) and "monogamy" in prefs:
                facts.append(_fact("f9", "preference", "datingPreferences.monogamy", str(prefs["monogamy"]), 0.7, f"{persona_id}-conv-1", ["t4"]))
            if isinstance(prefs, dict) and "wantsKids" in prefs:
                facts.append(_fact("f_kids", "preference", "datingPreferences.wantsKids", str(prefs["wantsKids"]), 0.65, f"{persona_id}-conv-1", ["t4"]))
            if isinstance(prefs, dict) and "pace" in prefs:
                facts.append(_fact("f_pace", "preference", "datingPreferences.pace", str(prefs["pace"]), 0.65, f"{persona_id}-conv-1", ["t4"]))
        if rich or very_long:
            facts.append(_fact("f10", "value", "values", _as_str_list(optional.get("values")), 0.65, f"{persona_id}-conv-2", ["t2"]))
            facts.append(_fact("f11", "attribute", "lifestyle", lifestyle, 0.7, f"{persona_id}-conv-2", ["t8"]))

        # Generate physical appearance for dating personas (used for profile image generation)
        appearance = _generate_appearance(
            name=name,
            gender_identity=gender_identity,
            lifestyle=lifestyle,
            age=age,
            idx=i,
        )
        optional["appearance"] = appearance

        # Generate attractiveness/fitness importance (how much does this person care about looks?)
        # Distribution: most people are 4-6 (moderate), some very low (1-3), some very high (7-10)
        importance_pool = [2, 3, 3, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 8, 8, 9, 10]
        attractiveness_importance = importance_pool[(i * 13 + 7) % len(importance_pool)]
        fitness_importance = importance_pool[(i * 11 + 3) % len(importance_pool)]
        
        # Correlation: fit people tend to care more about fitness
        build = appearance.get("build", "average")
        if build == "fit":
            fitness_importance = min(10, fitness_importance + 2)
        elif build in ("above_average", "overweight"):
            fitness_importance = max(1, fitness_importance - 1)
        
        # Add importance to scoringSignals
        optional["scoringSignals"]["attractivenessImportance"] = attractiveness_importance
        optional["scoringSignals"]["fitnessImportance"] = fitness_importance

        persona: Persona = {
            "id": persona_id,
            "domain": "dating",
            "required": {
                "name": name,
                "age": age,
                "location": {"city": city, "neighborhood": neighborhood, "country": "USA"},
            },
            "optional": optional,
            "conversations": convos,
            "facts": facts,
        }

        personas.append(persona)
        signals[persona_id] = DatingSignals(
            age=age,
            gender_identity=gender_identity,
            seeking_genders=seeking_genders,
            preferred_age_min=preferred_age_min,
            preferred_age_max=preferred_age_max,
            relationship_goal=goal,
            lifestyle=lifestyle,
            communication=communication,
            weekend=weekend,
            dealbreaker_tags=dealbreaker_tags,
            interest_tags=interest_tags,
            own_attractiveness=appearance.get("attractiveness", 5),
            own_build=build,
            attractiveness_importance=attractiveness_importance,
            fitness_importance=fitness_importance,
        )

    return personas, signals


def _cofounder_personas(city: City, start_n: int, count: int) -> Tuple[List[Persona], Dict[str, CofounderSignals]]:
    names_sf = [
        "Alexis Morgan",
        "Rohan Mehta",
        "Carmen Diaz",
        "Benji Kaplan",
        "Tariq Williams",
        "Linh Tran",
        "Joanna Park",
        "Mateo Silva",
        "Isha Nair",
        "Quinn Harper",
        "Vikram Singh",
        "Daniela Costa",
        "Hector Flores",
        "Sana Ali",
        "Noelle Pierce",
        "Kenji Watanabe",
        "Marisol Vega",
        "Owen Fletcher",
        "Yara Khoury",
        "Ethan Brooks",
        "Anika Bose",
        "Rafael Mendes",
        "Sierra Nguyen",
        "Amir Saeed",
        "Jules Lambert",
    ]
    names_ny = [
        "Cynthia Park",
        "Dev Shah",
        "Olivia Kent",
        "Malik Thompson",
        "Elise Moreau",
        "Ivan Petrov",
        "Sabrina Chen",
        "Mohamed Hassan",
        "Talia Bernstein",
        "Chris Kim",
        "Meera Joshi",
        "Jonah Klein",
        "Lucia Romano",
        "Adewale Okoye",
        "Phoebe Lin",
        "Nikhil Rao",
        "Hyejin Lee",
        "Tomasz Nowak",
        "Layla Haddad",
        "Peter Caldwell",
        "Farah Ahmed",
        "Rico Santiago",
        "Jenna Wu",
        "Sam Goldstein",
        "Giulia Conti",
    ]
    neighborhoods_sf = [
        "SoMa",
        "Mission",
        "Hayes Valley",
        "Noe Valley",
        "Inner Richmond",
        "Dogpatch",
        "Potrero Hill",
        "Lower Haight",
        "North Beach",
        "Bernal Heights",
    ]
    neighborhoods_ny = [
        "SoHo",
        "Tribeca",
        "Chelsea",
        "Midtown",
        "Lower East Side",
        "DUMBO",
        "Williamsburg",
        "Park Slope",
        "Long Island City",
        "East Village",
    ]

    if city == "San Francisco":
        name_pool = names_sf
        hood_pool = neighborhoods_sf
        city_code = "SF"
    else:
        name_pool = names_ny
        hood_pool = neighborhoods_ny
        city_code = "NY"

    roles = ["technical", "product", "growth", "bizdev", "research", "operator"]
    stage_prefs = ["idea", "prototype", "early_revenue", "scale"]
    commitments = ["full_time", "part_time", "weekends_only", "exploring"]
    speeds = ["move_fast", "steady", "experiment", "deliberate"]
    risks = ["high_risk", "medium_risk", "low_risk"]

    domain_tags_list = [
        ("ai", "developer_tools"),
        ("consumer", "social"),
        ("fintech", "payments"),
        ("health", "wellness"),
        ("climate", "energy"),
        ("crypto", "web3"),
        ("edtech", "community"),
        ("ecommerce", "logistics"),
        ("security", "infra"),
        ("media", "creator"),
    ]
    skill_tags_list = [
        ("backend", "infra", "db"),
        ("frontend", "design_systems"),
        ("ml", "data", "evaluation"),
        ("sales", "partnerships"),
        ("marketing", "content"),
        ("ops", "finance"),
        ("product", "user_research"),
        ("founder", "fundraising"),
    ]

    personas: List[Persona] = []
    signals: Dict[str, CofounderSignals] = {}

    for i in range(count):
        n = start_n + i
        persona_id = _persona_id("C", city_code, n)
        name = name_pool[i % len(name_pool)]
        age = 24 + (i * 2 % 18)  # 24..41
        neighborhood = hood_pool[(i * 3 + 2) % len(hood_pool)]

        # Anchor a few personas so curated benchmarks can be stable and "obvious".
        if persona_id in ("C-SF-003", "C-SF-005"):
            role = "technical" if persona_id == "C-SF-003" else "growth"
            stage_pref = "prototype"
            commitment = "full_time"
            speed = "move_fast"
            risk = "medium_risk"
            domain_tags = ("ai", "developer_tools")
            skill_tags = ("backend", "infra", "db") if persona_id == "C-SF-003" else ("sales", "partnerships")
        elif persona_id == "C-SF-001":
            role = "technical"
            stage_pref = "scale"
            commitment = "exploring"
            speed = "deliberate"
            risk = "low_risk"
            domain_tags = ("media", "creator")
            skill_tags = ("backend", "infra", "db")
        elif persona_id == "C-SF-002":
            role = "technical"
            stage_pref = "idea"
            commitment = "full_time"
            speed = "move_fast"
            risk = "high_risk"
            domain_tags = ("crypto", "web3")
            skill_tags = ("backend", "infra", "db")
        elif persona_id in ("C-NY-027", "C-SF-006"):
            role = "product" if persona_id == "C-NY-027" else "technical"
            stage_pref = "idea" if persona_id == "C-NY-027" else "early_revenue"
            commitment = "exploring" if persona_id == "C-NY-027" else "full_time"
            speed = "steady" if persona_id == "C-NY-027" else "move_fast"
            risk = "low_risk" if persona_id == "C-NY-027" else "high_risk"
            domain_tags = ("climate", "energy") if persona_id == "C-NY-027" else ("crypto", "web3")
            skill_tags = ("product", "user_research") if persona_id == "C-NY-027" else ("backend", "infra", "db")
        elif persona_id in ("C-NY-026", "C-NY-032"):
            role = "technical" if persona_id == "C-NY-026" else "product"
            stage_pref = "prototype"
            commitment = "full_time"
            speed = "move_fast"
            risk = "medium_risk"
            domain_tags = ("fintech", "payments")
            skill_tags = ("backend", "infra", "db") if persona_id == "C-NY-026" else ("product", "user_research")
        elif persona_id in ("C-SF-009", "C-SF-010"):
            role = "product"
            stage_pref = "scale"
            commitment = "full_time" if persona_id == "C-SF-009" else "weekends_only"
            speed = "deliberate"
            risk = "low_risk"
            domain_tags = ("health", "wellness") if persona_id == "C-SF-009" else ("security", "infra")
            skill_tags = ("product", "user_research")
        else:
            role = roles[(i * 2 + 1) % len(roles)]
            stage_pref = stage_prefs[(i * 3 + 1) % len(stage_prefs)]
            commitment = commitments[(i * 5 + 2) % len(commitments)]
            speed = speeds[(i * 7 + 1) % len(speeds)]
            risk = risks[(i * 4 + 2) % len(risks)]
            domain_tags = domain_tags_list[(i * 2 + 1) % len(domain_tags_list)]
            skill_tags = skill_tags_list[(i * 3 + 2) % len(skill_tags_list)]

        rich = (i % 4) in (0, 1)

        optional: Dict[str, object] = {}
        optional["skills"] = list(skill_tags)
        optional["startupGoals"] = {
            "focusAreas": list(domain_tags),
            "stagePreference": stage_pref,
            "riskTolerance": risk,
        }
        optional["commitment"] = {"availability": commitment, "hoursPerWeek": 10 if commitment != "full_time" else 50}
        optional["workingStyle"] = {
            "speed": speed,
            "decisionMaking": "data_informed" if "ml" in skill_tags or "data" in skill_tags else "intuition_plus_feedback",
            "meetings": "minimal" if speed in ("move_fast", "experiment") else "structured",
        }
        optional["scoringSignals"] = {
            "role": role,
            "stagePreference": stage_pref,
            "commitment": commitment,
            "speed": speed,
            "risk": risk,
            "domains": list(domain_tags),
            "skills": list(skill_tags),
        }

        if rich:
            optional["jobTitle"] = [
                "Staff Engineer",
                "Product Lead",
                "Growth Lead",
                "Quant Analyst",
                "Ops Manager",
                "Research Scientist",
                "Founder (previous exit)",
                "Freelance Engineer",
                "Community Builder",
                "Sales Lead",
            ][i % 10]
            optional["industry"] = [
                "tech",
                "finance",
                "healthcare",
                "media",
                "climate",
                "crypto",
                "security",
                "consumer",
                "logistics",
                "education",
            ][(i * 3) % 10]
            optional["equityExpectations"] = [
                "equal_split_if_equal_commitment",
                "role_based_split",
                "advisor_equity_only",
                "open_to_discussion",
            ][(i * 2) % 4]
            optional["values"] = ["speed", "honesty", "craft", "customer_obsession", "learning"][0 : 3 + (i % 2)]

        very_long = (i % 9) == 0
        convo_id_1 = f"{persona_id}-conv-1"
        turns_1: List[Turn] = [
            _turn("t1", "agent", "Quick basics: name, city, and what kind of business match are you looking for?"),
            _turn(
                "t2",
                "user",
                f"I’m {name} in {neighborhood}, {city}. I’m mostly {role} and I’m looking for someone complementary.",
            ),
            _turn("t3", "agent", "What stage do you want to start at, and what’s your time commitment?"),
            _turn(
                "t4",
                "user",
                f"I prefer {stage_pref} stage. I’m {commitment.replace('_', ' ')} and I like to {speed.replace('_', ' ')}.",
            ),
            _turn("t5", "agent", "What domains excite you most right now?"),
            _turn("t6", "user", f"Mostly {domain_tags[0]} + {domain_tags[1]}. Skills-wise I’m strong in {', '.join(skill_tags)}."),
        ]
        convos: List[Conversation] = [{"conversationId": convo_id_1, "scenario": "business onboarding", "turns": turns_1}]

        if rich or very_long:
            convo_id_2 = f"{persona_id}-conv-2"
            turns_2: List[Turn] = [
                _turn("t1", "agent", "What’s your risk tolerance and how do you like to split equity?"),
                _turn("t2", "user", f"Risk-wise I’m {risk.replace('_', ' ')}. Equity: {optional.get('equityExpectations', 'open')}."),  # type: ignore[arg-type]
                _turn("t3", "agent", "Any red flags you’ve learned to avoid in cofounders?"),
                _turn("t4", "user", "Flakiness, unclear ownership, and avoiding hard conversations."),
                _turn("t5", "agent", "What does ownership look like to you on a weekly basis?"),
                _turn("t6", "user", "Clear DRIs, written decisions, and shipping something meaningful every week."),
            ]
            convos.append({"conversationId": convo_id_2, "scenario": "alignment + red flags", "turns": turns_2})
            if very_long:
                convo_id_3 = f"{persona_id}-conv-3"
                turns_3: List[Turn] = [
                    _turn("t1", "agent", "Let’s simulate conflict: if you disagree on strategy, how do you resolve it?"),
                    _turn("t2", "user", "Write down hypotheses, define a fast test, and commit to a decision date."),
                    _turn("t3", "agent", "What’s your fundraising stance?"),
                    _turn("t4", "user", "Open to it if it accelerates distribution; otherwise I prefer capital efficiency."),
                    _turn("t5", "agent", "What’s your bar for full-time commitment?"),
                    _turn("t6", "user", "Mutual clarity: runway, milestones, and shared conviction in the problem."),
                    _turn("t7", "agent", "What kind of business do you work best with?"),
                    _turn("t8", "user", "High-agency, honest, and willing to do unglamorous work."),
                    _turn("t9", "agent", "Any non-negotiables?"),
                    _turn("t10", "user", "Integrity, reliability, and accountability."),
                ]
                convos.append({"conversationId": convo_id_3, "scenario": "extended alignment interview", "turns": turns_3})

        facts: List[Fact] = [
            _fact("f1", "identity", "name", name, 0.99, convo_id_1, ["t2"]),
            _fact("f2", "location", "location.city", city, 0.99, convo_id_1, ["t2"]),
            _fact("f3", "location", "location.neighborhood", neighborhood, 0.95, convo_id_1, ["t2"]),
            _fact("f4", "role", "business.role", role, 0.85, convo_id_1, ["t2"]),
            _fact("f5", "preference", "startupGoals.stagePreference", stage_pref, 0.85, convo_id_1, ["t4"]),
            _fact("f6", "preference", "commitment.availability", commitment, 0.8, convo_id_1, ["t4"]),
            _fact("f7", "preference", "workingStyle.speed", speed, 0.75, convo_id_1, ["t4"]),
            _fact("f8", "interest", "startupGoals.focusAreas", list(domain_tags), 0.75, convo_id_1, ["t6"]),
            _fact("f9", "skill", "skills", list(skill_tags), 0.8, convo_id_1, ["t6"]),
        ]
        if rich:
            facts.append(_fact("f10", "preference", "startupGoals.riskTolerance", risk, 0.75, f"{persona_id}-conv-2", ["t2"]))
            if "equityExpectations" in optional:
                facts.append(_fact("f11", "preference", "equityExpectations", str(optional["equityExpectations"]), 0.7, f"{persona_id}-conv-2", ["t2"]))

        persona: Persona = {
            "id": persona_id,
            "domain": "business",
            "required": {
                "name": name,
                "age": age,
                "location": {"city": city, "neighborhood": neighborhood, "country": "USA"},
            },
            "optional": optional,
            "conversations": convos,
            "facts": facts,
        }

        personas.append(persona)
        signals[persona_id] = CofounderSignals(
            role=role,
            stage_pref=stage_pref,
            commitment=commitment,
            speed=speed,
            risk=risk,
            domain_tags=domain_tags,
            skill_tags=skill_tags,
        )

    return personas, signals


def _friendship_personas(city: City, start_n: int, count: int) -> Tuple[List[Persona], Dict[str, FriendshipSignals]]:
    names_sf = [
        "Jamie Lin",
        "Niko Perez",
        "Asha Kapoor",
        "Tori James",
        "Minh Le",
        "Said Hassan",
        "Paige Collins",
        "Reese Nguyen",
        "Khalil Ward",
        "Ivy Chen",
        "Daria Novak",
        "Luis Ramirez",
        "Alina Shah",
        "Cole Turner",
        "Sienna Brooks",
        "Arman Ghorbani",
        "Jade Kim",
        "Nina Duarte",
        "Owen Park",
        "Zara Ali",
        "Marco Rossi",
        "Hye Park",
        "Noor Siddiqui",
        "Tyler Reed",
        "Keiko Tanaka",
    ]
    names_ny = [
        "Casey Morgan",
        "Rafi Cohen",
        "Maya Patel",
        "Andre Johnson",
        "Sofia Kim",
        "Yasmine Ahmed",
        "Ben Gold",
        "Hana Ito",
        "Chris Rivera",
        "Laila Noor",
        "Evan Chen",
        "Mina Park",
        "Jules Carter",
        "Talia Stern",
        "Samira Diallo",
        "Leo Martin",
        "Nadia Cruz",
        "Omar Aziz",
        "Vivian Li",
        "Miles Wright",
        "Seren Park",
        "Anwar Khan",
        "Kira Thompson",
        "Inez Santos",
        "Micah Lee",
    ]
    neighborhoods_sf = [
        "Inner Sunset",
        "Mission",
        "Noe Valley",
        "Richmond",
        "Hayes Valley",
        "Potrero Hill",
        "Bernal Heights",
        "SoMa",
        "Castro",
        "North Beach",
        "Marina",
        "Russian Hill",
    ]
    neighborhoods_ny = [
        "Astoria",
        "Williamsburg",
        "Greenpoint",
        "Park Slope",
        "Harlem",
        "Upper West Side",
        "Lower East Side",
        "East Village",
        "Chelsea",
        "SoHo",
        "DUMBO",
        "Long Island City",
    ]

    if city == "San Francisco":
        name_pool = names_sf
        hood_pool = neighborhoods_sf
        city_code = "SF"
    else:
        name_pool = names_ny
        hood_pool = neighborhoods_ny
        city_code = "NY"

    vibes = ["chill", "curious", "creative", "athletic", "nerdy", "community_builder", "foodie", "outdoorsy"]
    energies = ["low_key", "balanced", "high_energy"]
    weekends = ["coffee_walks", "boardgames", "gym", "hikes", "museums", "live_music", "cooking_nights", "volunteering"]
    social_styles = ["1on1_deep", "small_group", "big_group", "spontaneous", "planner"]
    interest_tags_list = [
        ("coffee", "books", "walks"),
        ("climbing", "hiking", "nature"),
        ("cooking", "restaurants", "baking"),
        ("film", "museums", "design"),
        ("gaming", "boardgames", "puzzles"),
        ("running", "gym", "wellness"),
        ("music", "concerts", "dj"),
        ("community", "volunteering", "mutual_aid"),
        ("finance", "real_estate", "tennis"),
        ("maker", "3d_printing", "electronics"),
    ]
    boundaries_list = [
        ("no_heavy_drinking",),
        ("no_flakes",),
        ("no_24_7_texting",),
        ("no_politics_fights",),
        ("respect_time",),
        ("kindness_required",),
    ]

    personas: List[Persona] = []
    signals: Dict[str, FriendshipSignals] = {}

    for i in range(count):
        n = start_n + i
        persona_id = _persona_id("F", city_code, n)
        name = name_pool[i % len(name_pool)]
        age = 20 + (i * 4 % 23)  # 20..42
        neighborhood = hood_pool[(i * 2 + 3) % len(hood_pool)]

        # Anchor a few personas so curated benchmarks can be stable and "obvious".
        if persona_id in ("F-SF-001", "F-NY-026"):
            vibe = "curious"
            energy = "balanced"
            weekend = "coffee_walks"
            social_style = "small_group"
            interest_tags = ("coffee", "books", "walks")
            boundaries = ("no_flakes",)
        elif persona_id in ("F-SF-002", "F-SF-003"):
            vibe = "high_energy" if persona_id == "F-SF-002" else "chill"
            energy = "high_energy" if persona_id == "F-SF-002" else "low_key"
            weekend = "live_music" if persona_id == "F-SF-002" else "museums"
            social_style = "big_group" if persona_id == "F-SF-002" else "1on1_deep"
            interest_tags = ("music", "concerts", "dj") if persona_id == "F-SF-002" else ("film", "museums", "design")
            boundaries = ("no_24_7_texting",) if persona_id == "F-SF-002" else ("respect_time",)
        elif persona_id in ("F-SF-004", "F-SF-012"):
            vibe = "community_builder"
            energy = "balanced"
            weekend = "volunteering"
            social_style = "small_group"
            interest_tags = ("community", "volunteering", "mutual_aid")
            boundaries = ("kindness_required",)
        elif persona_id in ("F-SF-010", "F-NY-030"):
            vibe = "athletic" if persona_id == "F-SF-010" else "nerdy"
            energy = "high_energy" if persona_id == "F-SF-010" else "low_key"
            weekend = "gym" if persona_id == "F-SF-010" else "boardgames"
            social_style = "spontaneous" if persona_id == "F-SF-010" else "planner"
            interest_tags = ("running", "gym", "wellness") if persona_id == "F-SF-010" else ("gaming", "boardgames", "puzzles")
            boundaries = ("respect_time",) if persona_id == "F-SF-010" else ("no_24_7_texting",)
        else:
            vibe = vibes[(i * 3 + 1) % len(vibes)]
            energy = energies[(i * 5 + 2) % len(energies)]
            weekend = weekends[(i * 4 + 1) % len(weekends)]
            social_style = social_styles[(i * 7 + 3) % len(social_styles)]
            interest_tags = interest_tags_list[(i * 2) % len(interest_tags_list)]
            boundaries = boundaries_list[(i * 3 + 1) % len(boundaries_list)]

        rich = (i % 4) == 0
        optional: Dict[str, object] = {
            "interests": list(interest_tags),
            "friendshipStyle": social_style,
            "vibe": vibe,
            "boundaries": list(boundaries),
        }
        optional["scoringSignals"] = {
            "vibe": vibe,
            "energy": energy,
            "weekend": weekend,
            "socialStyle": social_style,
            "interests": list(interest_tags),
            "boundaries": list(boundaries),
        }
        if rich:
            optional["hobbies"] = [
                weekend.replace("_", " "),
                "trying new cafes",
                "long walks",
                "pickup sports",
                "movie nights",
                "cooking together",
            ][0 : 3 + (i % 3)]
            optional["values"] = ["reliability", "humor", "curiosity", "kindness", "community"][0 : 3 + (i % 2)]
            optional["schedule"] = "weeknights + weekends" if energy != "low_key" else "weekends mostly"

        very_long = (i % 8) == 0
        convo_id_1 = f"{persona_id}-conv-1"
        turns_1: List[Turn] = [
            _turn("t1", "agent", "Let’s get you set up for local meetup matching—name, neighborhood, and what kind of friends are you looking for?"),
            _turn("t2", "user", f"I’m {name}. I’m in {neighborhood}, {city}. I’m hoping for {vibe.replace('_',' ')} friends—people who are {boundaries[0].replace('_',' ')}."),
            _turn("t3", "agent", "What do you like doing on weekends and what’s your social style?"),
            _turn("t4", "user", f"Usually {weekend.replace('_',' ')}. Socially I’m more {social_style.replace('_',' ')} and my energy is {energy.replace('_',' ')}."),
            _turn("t5", "agent", "Any interests you want me to prioritize?"),
            _turn("t6", "user", f"{', '.join(interest_tags)} are big for me."),
        ]
        convos: List[Conversation] = [{"conversationId": convo_id_1, "scenario": "friendship onboarding", "turns": turns_1}]
        if rich or very_long:
            convo_id_2 = f"{persona_id}-conv-2"
            turns_2: List[Turn] = [
                _turn("t1", "agent", "What makes you feel welcomed in a new friendship, and what drains you?"),
                _turn("t2", "user", "I like consistency and low-pressure plans. Drains me: flakiness and mean humor."),
                _turn("t3", "agent", "How often do you like to hang out?"),
                _turn("t4", "user", "Usually once a week or every other week—quality over quantity."),
                _turn("t5", "agent", "Any boundaries I should enforce while matching?"),
                _turn("t6", "user", f"Yeah: {', '.join(boundaries)}."),
            ]
            convos.append({"conversationId": convo_id_2, "scenario": "friendship depth", "turns": turns_2})
            if very_long:
                convo_id_3 = f"{persona_id}-conv-3"
                turns_3: List[Turn] = [
                    _turn("t1", "agent", "If we matched you into a meetup, what kind would excite you most?"),
                    _turn("t2", "user", "Something activity-based where conversation happens naturally."),
                    _turn("t3", "agent", "What’s a great first hangout plan?"),
                    _turn("t4", "user", "Coffee and a walk, or a museum + snack, or a casual boardgame night."),
                    _turn("t5", "agent", "What should I avoid matching you into?"),
                    _turn("t6", "user", "Super loud bars or anything that feels like networking pressure."),
                    _turn("t7", "agent", "Any causes or communities you want to be around?"),
                    _turn("t8", "user", "I like community-minded people who are kind and consistent."),
                ]
                convos.append({"conversationId": convo_id_3, "scenario": "extended meetup preferences", "turns": turns_3})

        facts: List[Fact] = [
            _fact("f1", "identity", "name", name, 0.99, convo_id_1, ["t2"]),
            _fact("f2", "location", "location.city", city, 0.99, convo_id_1, ["t2"]),
            _fact("f3", "location", "location.neighborhood", neighborhood, 0.95, convo_id_1, ["t2"]),
            _fact("f4", "preference", "friendship.vibe", vibe, 0.85, convo_id_1, ["t2"]),
            _fact("f5", "preference", "friendship.boundaries", list(boundaries), 0.8, convo_id_1, ["t2"]),
            _fact("f6", "preference", "friendship.socialStyle", social_style, 0.8, convo_id_1, ["t4"]),
            _fact("f7", "preference", "friendship.energy", energy, 0.75, convo_id_1, ["t4"]),
            _fact("f8", "interest", "interests", list(interest_tags), 0.8, convo_id_1, ["t6"]),
        ]
        if rich or very_long:
            facts.append(_fact("f9", "preference", "friendship.boundaries", list(boundaries), 0.8, f"{persona_id}-conv-2", ["t6"]))

        persona: Persona = {
            "id": persona_id,
            "domain": "friendship",
            "required": {
                "name": name,
                "age": age,
                "location": {"city": city, "neighborhood": neighborhood, "country": "USA"},
            },
            "optional": optional,
            "conversations": convos,
            "facts": facts,
        }

        personas.append(persona)
        signals[persona_id] = FriendshipSignals(
            vibe=vibe,
            energy=energy,
            weekend=weekend,
            social_style=social_style,
            interest_tags=interest_tags,
            boundaries=boundaries,
        )

    return personas, signals


def _dating_score(a: DatingSignals, b: DatingSignals) -> int:
    # Filter out hard-constraint mismatches (gender/age prefs) rather than scoring them.
    if dating_ineligibility_reason(a, b):
        raise ValueError("ineligible pair should not be scored")
    s, _ = score_dating(a, b)
    return int(s)


def _cofounder_score(a: CofounderSignals, b: CofounderSignals) -> int:
    s, _ = score_cofounder(a, b)
    return int(s)


def _friendship_score(a: FriendshipSignals, b: FriendshipSignals) -> int:
    s, _ = score_friendship(a, b)
    return int(s)


def _build_matrix(domain: Domain, persona_ids: List[str], scores_fn) -> MatchMatrix:
    return build_matrix(domain, persona_ids, scores_fn)

def _as_str(v: object) -> str:
    return v if isinstance(v, str) else ""


def _as_str_list(v: object) -> List[str]:
    if isinstance(v, list) and all(isinstance(x, str) for x in v):
        return list(v)
    return []


def _benchmark_reason(domain: Domain, a: Persona, b: Persona, score: int) -> str:
    ao = a.get("optional")
    bo = b.get("optional")
    if not isinstance(ao, dict) or not isinstance(bo, dict):
        return "Generated from score extremes in the match matrix."

    parts: List[str] = []

    if domain == "dating":
        ga = _as_str(ao.get("relationshipGoal"))
        gb = _as_str(bo.get("relationshipGoal"))
        if ga and gb:
            parts.append(f"goal: {ga} vs {gb}")
        ca = _as_str(ao.get("communicationStyle"))
        cb = _as_str(bo.get("communicationStyle"))
        if ca and cb:
            parts.append(f"communication: {ca} vs {cb}")
        ia = set(_as_str_list(ao.get("interests")))
        ib = set(_as_str_list(bo.get("interests")))
        shared = sorted(ia.intersection(ib))
        if shared:
            parts.append(f"shared interests: {', '.join(shared)}")
        da = set(_as_str_list(ao.get("dealbreakers")))
        db = set(_as_str_list(bo.get("dealbreakers")))
        overlap = sorted(da.intersection(db))
        if overlap:
            parts.append(f"dealbreaker overlap (soft): {', '.join(overlap)}")

    elif domain == "business":
        sa = ao.get("startupGoals")
        sb = bo.get("startupGoals")
        if isinstance(sa, dict) and isinstance(sb, dict):
            sta = _as_str(sa.get("stagePreference"))
            stb = _as_str(sb.get("stagePreference"))
            if sta and stb:
                parts.append(f"stage: {sta} vs {stb}")
            fa = _as_str_list(sa.get("focusAreas"))
            fb = _as_str_list(sb.get("focusAreas"))
            shared = sorted(set(fa).intersection(set(fb)))
            if shared:
                parts.append(f"shared domains: {', '.join(shared)}")
        ca = ao.get("commitment")
        cb = bo.get("commitment")
        if isinstance(ca, dict) and isinstance(cb, dict):
            ava = _as_str(ca.get("availability"))
            avb = _as_str(cb.get("availability"))
            if ava and avb:
                parts.append(f"commitment: {ava} vs {avb}")
        ska = set(_as_str_list(ao.get("skills")))
        skb = set(_as_str_list(bo.get("skills")))
        shared_skills = sorted(ska.intersection(skb))
        if shared_skills:
            parts.append(f"shared skills: {', '.join(shared_skills)}")

    else:
        va = _as_str(ao.get("vibe"))
        vb = _as_str(bo.get("vibe"))
        if va and vb:
            parts.append(f"vibe: {va} vs {vb}")
        sa = _as_str(ao.get("friendshipStyle"))
        sb = _as_str(bo.get("friendshipStyle"))
        if sa and sb:
            parts.append(f"social style: {sa} vs {sb}")
        ia = set(_as_str_list(ao.get("interests")))
        ib = set(_as_str_list(bo.get("interests")))
        shared = sorted(ia.intersection(ib))
        if shared:
            parts.append(f"shared interests: {', '.join(shared)}")
        ba = set(_as_str_list(ao.get("boundaries")))
        bb = set(_as_str_list(bo.get("boundaries")))
        shared_b = sorted(ba.intersection(bb))
        if shared_b:
            parts.append(f"shared boundaries: {', '.join(shared_b)}")

    if not parts:
        parts.append("generated from score extremes in the match matrix")

    label = "high-fit" if score >= 35 else "low-fit" if score <= 0 else "mid-fit"
    return f"{label}: " + "; ".join(parts)


def _generate_benchmarks(domain: Domain, personas: List[Persona], matrix: MatchMatrix) -> Benchmarks:
    by_id: Dict[str, Persona] = {p["id"]: p for p in personas}
    ids = matrix["personaIds"]
    scores = matrix["scores"]

    pairs: List[Tuple[int, str, str]] = []
    for i in range(len(ids)):
        a = ids[i]
        row = scores[a]
        for j in range(i + 1, len(ids)):
            b = ids[j]
            if b in row:
                pairs.append((row[b], a, b))

    pairs_sorted = sorted(pairs, key=lambda t: t[0], reverse=True)
    top = pairs_sorted[:5]
    bottom = list(reversed(pairs_sorted[-5:]))

    def mk(score: int, a: str, b: str) -> BenchmarkPair:
        lo = max(-100, score - 10)
        hi = min(100, score + 10)
        reason = _benchmark_reason(domain, by_id[a], by_id[b], score)
        return {"a": a, "b": b, "expectedScoreRange": [lo, hi], "reason": reason}

    return {
        "domain": domain,
        "description": "Generated benchmark pairs: top 5 and bottom 5 unique pairs from the deterministic match matrix, with tight expected ranges.",
        "goodPairs": [mk(s, a, b) for (s, a, b) in top],
        "badPairs": [mk(s, a, b) for (s, a, b) in bottom],
    }


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    # Dating
    dating_sf, dating_sf_sig = _dating_personas("San Francisco", start_n=1, count=25)
    dating_ny, dating_ny_sig = _dating_personas("New York", start_n=26, count=25)
    dating_all = dating_sf + dating_ny
    dating_sig: Dict[str, DatingSignals] = {**dating_sf_sig, **dating_ny_sig}
    dating_ids = [p["id"] for p in dating_all]

    def dating_scores(a_id: str, b_id: str) -> int:
        return _dating_score(dating_sig[a_id], dating_sig[b_id])

    dating_matrix = _build_matrix("dating", dating_ids, dating_scores)

    # Cofounders
    cof_sf, cof_sf_sig = _cofounder_personas("San Francisco", start_n=1, count=25)
    cof_ny, cof_ny_sig = _cofounder_personas("New York", start_n=26, count=25)
    cof_all = cof_sf + cof_ny
    cof_sig: Dict[str, CofounderSignals] = {**cof_sf_sig, **cof_ny_sig}
    cof_ids = [p["id"] for p in cof_all]

    def cof_scores(a_id: str, b_id: str) -> int:
        return _cofounder_score(cof_sig[a_id], cof_sig[b_id])

    cof_matrix = _build_matrix("business", cof_ids, cof_scores)

    # Friendship
    fr_sf, fr_sf_sig = _friendship_personas("San Francisco", start_n=1, count=25)
    fr_ny, fr_ny_sig = _friendship_personas("New York", start_n=26, count=25)
    fr_all = fr_sf + fr_ny
    fr_sig: Dict[str, FriendshipSignals] = {**fr_sf_sig, **fr_ny_sig}
    fr_ids = [p["id"] for p in fr_all]

    def fr_scores(a_id: str, b_id: str) -> int:
        return _friendship_score(fr_sig[a_id], fr_sig[b_id])

    fr_matrix = _build_matrix("friendship", fr_ids, fr_scores)

    # Write outputs
    _write_json(os.path.join(root, "data/dating/personas_sf.json"), dating_sf)
    _write_json(os.path.join(root, "data/dating/personas_ny.json"), dating_ny)
    _write_json(os.path.join(root, "data/dating/match_matrix.json"), dating_matrix)
    _write_json(os.path.join(root, "data/dating/benchmarks.json"), _generate_benchmarks("dating", dating_all, dating_matrix))

    _write_json(os.path.join(root, "data/cofounders/personas_sf.json"), cof_sf)
    _write_json(os.path.join(root, "data/cofounders/personas_ny.json"), cof_ny)
    _write_json(os.path.join(root, "data/cofounders/match_matrix.json"), cof_matrix)
    _write_json(os.path.join(root, "data/cofounders/benchmarks.json"), _generate_benchmarks("business", cof_all, cof_matrix))

    _write_json(os.path.join(root, "data/friendship/personas_sf.json"), fr_sf)
    _write_json(os.path.join(root, "data/friendship/personas_ny.json"), fr_ny)
    _write_json(os.path.join(root, "data/friendship/match_matrix.json"), fr_matrix)
    _write_json(os.path.join(root, "data/friendship/benchmarks.json"), _generate_benchmarks("friendship", fr_all, fr_matrix))

    print("Wrote dating + business + friendship datasets to data/ (personas + match matrices).")


if __name__ == "__main__":
    main()

