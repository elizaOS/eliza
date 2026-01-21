from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple

from matcher.types import (
    Belief,
    ConflictStyle,
    CuriosityLevel,
    DebtComfort,
    Domain,
    IntellectStyle,
    KidsIntent,
    KidsTimeline,
    LibidoLevel,
    LifeGoalIntent,
    LoveNeed,
    MonogamyPref,
    OpennessLevel,
    PracticeLevel,
    ReassuranceNeed,
    RiskTolerance,
    SpenderSaver,
    TextingFrequency,
)


@dataclass(frozen=True)
class DatingSignals:
    age: int
    gender_identity: str
    seeking_genders: Tuple[str, ...]
    preferred_age_min: int
    preferred_age_max: int
    relationship_goal: str
    lifestyle: str
    communication: str
    weekend: str
    dealbreaker_tags: Tuple[str, ...]
    interest_tags: Tuple[str, ...]
    # Appearance fields
    own_attractiveness: int  # 1-10, this person's attractiveness
    own_build: str  # thin, fit, average, above_average, overweight
    attractiveness_importance: int  # 1-10, how much they care about partner's looks
    fitness_importance: int  # 1-10, how much they care about partner's fitness
    # Compatibility dimensions (optional / sparse)
    life_goals_present: bool
    marriage_intent: LifeGoalIntent
    kids_intent: KidsIntent
    kids_timeline: KidsTimeline
    life_goals_must_match: bool
    life_goals_importance: int
    love_needs_present: bool
    love_needs_primary: Tuple[LoveNeed, ...]
    love_needs_texting: TextingFrequency
    love_needs_must_match: bool
    love_needs_importance: int
    sexual_present: bool
    monogamy_pref: MonogamyPref
    libido_level: LibidoLevel
    sexual_preferences: Tuple[str, ...]
    sexual_must_match: bool
    sexual_importance: int
    intellect_present: bool
    intellect_style: IntellectStyle
    curiosity_level: CuriosityLevel
    culture_tags: Tuple[str, ...]
    intellect_importance: int
    communication_prefs_present: bool
    conflict_style: ConflictStyle
    emotional_openness: OpennessLevel
    reassurance_need: ReassuranceNeed
    communication_importance: int
    religion_present: bool
    belief: Belief
    practice: PracticeLevel
    religion_must_match: bool
    religion_importance: int
    finance_present: bool
    spender_saver: SpenderSaver
    risk_tolerance: RiskTolerance
    debt_comfort: DebtComfort
    finance_must_match: bool
    finance_importance: int


@dataclass(frozen=True)
class CofounderSignals:
    role: str
    stage_pref: str
    commitment: str
    speed: str
    risk: str
    domain_tags: Tuple[str, ...]
    skill_tags: Tuple[str, ...]


@dataclass(frozen=True)
class FriendshipSignals:
    vibe: str
    energy: str
    weekend: str
    social_style: str
    interest_tags: Tuple[str, ...]
    boundaries: Tuple[str, ...]


def clamp_int(v: float, lo: int, hi: int) -> int:
    n = int(round(v))
    return max(lo, min(hi, n))


def _as_str(v: object) -> str:
    return v if isinstance(v, str) else ""


def _as_str_list(v: object) -> List[str]:
    if isinstance(v, list) and all(isinstance(x, str) for x in v):
        return list(v)
    return []


def _as_bool(v: object) -> bool:
    return v is True


def _as_int(v: object, default: int) -> int:
    return int(v) if isinstance(v, int) else default


def _as_literal(v: object, allowed: List[str], default: str) -> str:
    if isinstance(v, str) and v in allowed:
        return v
    return default


def extract_scoring_signals(domain: Domain, persona: Dict[str, object]) -> Dict[str, object]:
    _ = domain
    opt = persona.get("optional")
    if not isinstance(opt, dict):
        return {}
    ss = opt.get("scoringSignals")
    return ss if isinstance(ss, dict) else {}


def dating_from_persona(persona: Dict[str, object]) -> DatingSignals:
    ss = extract_scoring_signals("dating", persona)
    req = persona.get("required")
    opt = persona.get("optional")
    age = 0
    if isinstance(req, dict):
        a = req.get("age")
        age = int(a) if isinstance(a, int) else 0

    # Extract appearance data
    appearance: Dict[str, object] = {}
    if isinstance(opt, dict):
        app = opt.get("appearance")
        if isinstance(app, dict):
            appearance = app

    life_goals = ss.get("lifeGoals")
    love_needs = ss.get("loveNeeds")
    sexual = ss.get("sexual")
    intellect = ss.get("intellect")
    communication_prefs = ss.get("communicationPreferences")
    religion = ss.get("religion")
    finance = ss.get("finance")

    life_goals_present = isinstance(life_goals, dict)
    love_needs_present = isinstance(love_needs, dict)
    sexual_present = isinstance(sexual, dict)
    intellect_present = isinstance(intellect, dict)
    communication_prefs_present = isinstance(communication_prefs, dict)
    religion_present = isinstance(religion, dict)
    finance_present = isinstance(finance, dict)

    return DatingSignals(
        age=age,
        gender_identity=_as_str(ss.get("genderIdentity")),
        seeking_genders=tuple(_as_str_list(ss.get("seekingGenders"))),
        preferred_age_min=int(ss.get("preferredAgeMin")) if isinstance(ss.get("preferredAgeMin"), int) else 18,
        preferred_age_max=int(ss.get("preferredAgeMax")) if isinstance(ss.get("preferredAgeMax"), int) else 99,
        relationship_goal=_as_str(ss.get("relationshipGoal")),
        lifestyle=_as_str(ss.get("lifestyle")),
        communication=_as_str(ss.get("communication")),
        weekend=_as_str(ss.get("weekend")),
        dealbreaker_tags=tuple(_as_str_list(ss.get("dealbreakers"))),
        interest_tags=tuple(_as_str_list(ss.get("interests"))),
        # Appearance fields
        own_attractiveness=int(appearance.get("attractiveness", 5)) if isinstance(appearance.get("attractiveness"), int) else 5,
        own_build=_as_str(appearance.get("build")) or "average",
        attractiveness_importance=int(ss.get("attractivenessImportance", 5)) if isinstance(ss.get("attractivenessImportance"), int) else 5,
        fitness_importance=int(ss.get("fitnessImportance", 5)) if isinstance(ss.get("fitnessImportance"), int) else 5,
        life_goals_present=life_goals_present,
        marriage_intent=_as_literal(
            life_goals.get("marriageIntent") if isinstance(life_goals, dict) else None,
            ["yes", "no", "open", "unsure"],
            "unsure",
        ),
        kids_intent=_as_literal(
            life_goals.get("kidsIntent") if isinstance(life_goals, dict) else None,
            ["yes", "no", "open", "unsure"],
            "unsure",
        ),
        kids_timeline=_as_literal(
            life_goals.get("kidsTimeline") if isinstance(life_goals, dict) else None,
            ["soon", "later", "unsure"],
            "unsure",
        ),
        life_goals_must_match=_as_bool(life_goals.get("mustMatch")) if isinstance(life_goals, dict) else False,
        life_goals_importance=_as_int(life_goals.get("importance"), 5) if isinstance(life_goals, dict) else 5,
        love_needs_present=love_needs_present,
        love_needs_primary=tuple(
            _as_str_list(love_needs.get("primaryNeeds")) if isinstance(love_needs, dict) else []
        ),
        love_needs_texting=_as_literal(
            love_needs.get("textingFrequency") if isinstance(love_needs, dict) else None,
            ["low", "medium", "high", "unsure"],
            "unsure",
        ),
        love_needs_must_match=_as_bool(love_needs.get("mustMatch")) if isinstance(love_needs, dict) else False,
        love_needs_importance=_as_int(love_needs.get("importance"), 5) if isinstance(love_needs, dict) else 5,
        sexual_present=sexual_present,
        monogamy_pref=_as_literal(
            sexual.get("monogamy") if isinstance(sexual, dict) else None,
            ["yes", "no", "flexible", "unsure"],
            "unsure",
        ),
        libido_level=_as_literal(
            sexual.get("libido") if isinstance(sexual, dict) else None,
            ["low", "medium", "high", "unsure"],
            "unsure",
        ),
        sexual_preferences=tuple(
            _as_str_list(sexual.get("preferences")) if isinstance(sexual, dict) else []
        ),
        sexual_must_match=_as_bool(sexual.get("mustMatch")) if isinstance(sexual, dict) else False,
        sexual_importance=_as_int(sexual.get("importance"), 5) if isinstance(sexual, dict) else 5,
        intellect_present=intellect_present,
        intellect_style=_as_literal(
            intellect.get("intellectStyle") if isinstance(intellect, dict) else None,
            ["academic", "creative", "practical", "balanced", "unsure"],
            "unsure",
        ),
        curiosity_level=_as_literal(
            intellect.get("curiosityLevel") if isinstance(intellect, dict) else None,
            ["low", "medium", "high", "unsure"],
            "unsure",
        ),
        culture_tags=tuple(
            _as_str_list(intellect.get("cultureTags")) if isinstance(intellect, dict) else []
        ),
        intellect_importance=_as_int(intellect.get("importance"), 5) if isinstance(intellect, dict) else 5,
        communication_prefs_present=communication_prefs_present,
        conflict_style=_as_literal(
            communication_prefs.get("conflictStyle") if isinstance(communication_prefs, dict) else None,
            ["avoidant", "direct", "collaborative", "unsure"],
            "unsure",
        ),
        emotional_openness=_as_literal(
            communication_prefs.get("emotionalOpenness") if isinstance(communication_prefs, dict) else None,
            ["low", "medium", "high", "unsure"],
            "unsure",
        ),
        reassurance_need=_as_literal(
            communication_prefs.get("reassuranceNeed") if isinstance(communication_prefs, dict) else None,
            ["low", "medium", "high", "unsure"],
            "unsure",
        ),
        communication_importance=_as_int(communication_prefs.get("importance"), 5) if isinstance(communication_prefs, dict) else 5,
        religion_present=religion_present,
        belief=_as_literal(
            religion.get("belief") if isinstance(religion, dict) else None,
            ["religious", "spiritual", "agnostic", "atheist", "unsure"],
            "unsure",
        ),
        practice=_as_literal(
            religion.get("practice") if isinstance(religion, dict) else None,
            ["low", "medium", "high", "unsure"],
            "unsure",
        ),
        religion_must_match=_as_bool(religion.get("mustMatch")) if isinstance(religion, dict) else False,
        religion_importance=_as_int(religion.get("importance"), 5) if isinstance(religion, dict) else 5,
        finance_present=finance_present,
        spender_saver=_as_literal(
            finance.get("spenderSaver") if isinstance(finance, dict) else None,
            ["spender", "balanced", "saver", "unsure"],
            "unsure",
        ),
        risk_tolerance=_as_literal(
            finance.get("riskTolerance") if isinstance(finance, dict) else None,
            ["low", "medium", "high", "unsure"],
            "unsure",
        ),
        debt_comfort=_as_literal(
            finance.get("debtComfort") if isinstance(finance, dict) else None,
            ["low", "medium", "high", "unsure"],
            "unsure",
        ),
        finance_must_match=_as_bool(finance.get("mustMatch")) if isinstance(finance, dict) else False,
        finance_importance=_as_int(finance.get("importance"), 5) if isinstance(finance, dict) else 5,
    )


def cofounder_from_persona(persona: Dict[str, object]) -> CofounderSignals:
    ss = extract_scoring_signals("business", persona)
    return CofounderSignals(
        role=_as_str(ss.get("role")),
        stage_pref=_as_str(ss.get("stagePreference")),
        commitment=_as_str(ss.get("commitment")),
        speed=_as_str(ss.get("speed")),
        risk=_as_str(ss.get("risk")),
        domain_tags=tuple(_as_str_list(ss.get("domains"))),
        skill_tags=tuple(_as_str_list(ss.get("skills"))),
    )


def friendship_from_persona(persona: Dict[str, object]) -> FriendshipSignals:
    ss = extract_scoring_signals("friendship", persona)
    return FriendshipSignals(
        vibe=_as_str(ss.get("vibe")),
        energy=_as_str(ss.get("energy")),
        weekend=_as_str(ss.get("weekend")),
        social_style=_as_str(ss.get("socialStyle")),
        interest_tags=tuple(_as_str_list(ss.get("interests"))),
        boundaries=tuple(_as_str_list(ss.get("boundaries"))),
    )


def dating_ineligibility_reason(a: DatingSignals, b: DatingSignals) -> str:
    # Return "" if eligible; otherwise a human-readable reason for filtering out.
    gender_ok = (not a.seeking_genders or b.gender_identity in a.seeking_genders) and (
        not b.seeking_genders or a.gender_identity in b.seeking_genders
    )
    if not gender_ok:
        return (
            f"gender prefs mismatch: A seeks {list(a.seeking_genders) if a.seeking_genders else ['any']} but B is {b.gender_identity}; "
            f"B seeks {list(b.seeking_genders) if b.seeking_genders else ['any']} but A is {a.gender_identity}"
        )

    age_ok = (a.preferred_age_min <= b.age <= a.preferred_age_max) and (b.preferred_age_min <= a.age <= b.preferred_age_max)
    if not age_ok:
        return (
            f"age prefs mismatch: A range {a.preferred_age_min}-{a.preferred_age_max} vs B age {b.age}; "
            f"B range {b.preferred_age_min}-{b.preferred_age_max} vs A age {a.age}"
        )

    # Hard cut for attractiveness: if someone cares a lot (>=7) and gap is > 5 points
    attractiveness_gap = abs(a.own_attractiveness - b.own_attractiveness)
    if a.attractiveness_importance >= 7 and attractiveness_gap > 5:
        return (
            f"attractiveness gap too large: A (importance={a.attractiveness_importance}) is {a.own_attractiveness}, "
            f"B is {b.own_attractiveness} (gap={attractiveness_gap})"
        )
    if b.attractiveness_importance >= 7 and attractiveness_gap > 5:
        return (
            f"attractiveness gap too large: B (importance={b.attractiveness_importance}) is {b.own_attractiveness}, "
            f"A is {a.own_attractiveness} (gap={attractiveness_gap})"
        )

    # Life goals / kids intent hard conflicts (if either says must match).
    if a.life_goals_present and b.life_goals_present and (a.life_goals_must_match or b.life_goals_must_match):
        if a.marriage_intent in ("yes", "no") and b.marriage_intent in ("yes", "no") and a.marriage_intent != b.marriage_intent:
            return f"marriage intent mismatch: {a.marriage_intent} vs {b.marriage_intent}"
        if a.kids_intent in ("yes", "no") and b.kids_intent in ("yes", "no") and a.kids_intent != b.kids_intent:
            return f"kids intent mismatch: {a.kids_intent} vs {b.kids_intent}"

    # Sexual monogamy hard conflict (if either says must match).
    if a.sexual_present and b.sexual_present and (a.sexual_must_match or b.sexual_must_match):
        if a.monogamy_pref in ("yes", "no") and b.monogamy_pref in ("yes", "no") and a.monogamy_pref != b.monogamy_pref:
            return f"monogamy mismatch: {a.monogamy_pref} vs {b.monogamy_pref}"

    # Religion hard conflict (if either says must match).
    if a.religion_present and b.religion_present and (a.religion_must_match or b.religion_must_match):
        if a.belief != "unsure" and b.belief != "unsure" and a.belief != b.belief:
            return f"religion mismatch: {a.belief} vs {b.belief}"

    # Finance hard conflict (if either says must match).
    if a.finance_present and b.finance_present and (a.finance_must_match or b.finance_must_match):
        if a.spender_saver != "unsure" and b.spender_saver != "unsure":
            if "balanced" not in (a.spender_saver, b.spender_saver) and a.spender_saver != b.spender_saver:
                return f"spender/saver mismatch: {a.spender_saver} vs {b.spender_saver}"

    return ""
