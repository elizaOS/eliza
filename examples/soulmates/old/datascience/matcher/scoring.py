from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple

from matcher.signals import CofounderSignals, DatingSignals, FriendshipSignals, clamp_int


@dataclass(frozen=True)
class ScoreComponent:
    name: str
    contribution: int
    detail: str


def _importance_scale(importance: int) -> float:
    if importance < 1:
        importance = 1
    if importance > 10:
        importance = 10
    return 0.5 + (importance / 10.0)


def score_dating(a: DatingSignals, b: DatingSignals) -> Tuple[int, List[ScoreComponent]]:
    comps: List[ScoreComponent] = []

    # Mutual compatibility gates: these should be used as filters (candidate set),
    # not as a numeric score. The scoring function assumes eligibility.
    comps.append(ScoreComponent("gender_compatibility_gate", 0, "assumed eligible"))
    comps.append(ScoreComponent("age_compatibility_gate", 0, "assumed eligible"))
    total = 0.0

    goal_map = {
        "long_term": 1.0,
        "serious_but_slow": 0.8,
        "exploring": 0.3,
        "casual": -0.3,
        "open_to_kids": 0.9,
        "no_kids": 0.2,
    }
    ga = goal_map.get(a.relationship_goal, 0.0)
    gb = goal_map.get(b.relationship_goal, 0.0)
    goal_points = 45.0 * (1.0 - abs(ga - gb))
    total += goal_points
    comps.append(ScoreComponent("goal_alignment", clamp_int(goal_points, -100, 100), f"{a.relationship_goal} vs {b.relationship_goal}"))

    lifestyle_pairs_good = {
        ("early_gym", "early_gym"),
        ("late_night", "late_night"),
        ("outdoors_weekends", "outdoors_weekends"),
        ("homebody", "homebody"),
        ("balanced", "balanced"),
        ("social_foodie", "social_foodie"),
        ("sober_or_rarely", "sober_or_rarely"),
    }
    lifestyle_points = 6.0
    if (a.lifestyle, b.lifestyle) in lifestyle_pairs_good:
        lifestyle_points = 20.0
    elif ("late_night" in (a.lifestyle, b.lifestyle)) and ("early_gym" in (a.lifestyle, b.lifestyle)):
        lifestyle_points = -15.0
    total += lifestyle_points
    comps.append(ScoreComponent("lifestyle", clamp_int(lifestyle_points, -100, 100), f"{a.lifestyle} vs {b.lifestyle}"))

    comm_points = 4.0
    if a.communication == b.communication:
        comm_points = 14.0
    elif ("low_texting" in (a.communication, b.communication)) and ("high_texting" in (a.communication, b.communication)):
        comm_points = -10.0
    elif ("conflict_needs_space" in (a.communication, b.communication)) and ("direct" in (a.communication, b.communication)):
        comm_points = -6.0
    total += comm_points
    comps.append(ScoreComponent("communication", clamp_int(comm_points, -100, 100), f"{a.communication} vs {b.communication}"))

    shared = set(a.interest_tags).intersection(set(b.interest_tags))
    interest_points = 6.0 * float(len(shared))
    total += interest_points
    comps.append(ScoreComponent("shared_interests", clamp_int(interest_points, -100, 100), ", ".join(sorted(shared)) or "none"))

    deal_collisions = set(a.dealbreaker_tags).intersection(set(b.dealbreaker_tags))
    deal_points = -8.0 * float(len(deal_collisions))
    total += deal_points
    comps.append(ScoreComponent("dealbreaker_overlap_soft", clamp_int(deal_points, -100, 100), ", ".join(sorted(deal_collisions)) or "none"))

    kids_mismatch_points = 0.0
    if ("wants_kids_mismatch" in a.dealbreaker_tags) != ("wants_kids_mismatch" in b.dealbreaker_tags):
        kids_mismatch_points = -12.0
    total += kids_mismatch_points
    comps.append(ScoreComponent("kids_mismatch_heuristic", clamp_int(kids_mismatch_points, -100, 100), "mismatch" if kids_mismatch_points else "ok"))

    # Life goals (marriage/kids/timeline) - soft unless must-match triggers filtered earlier.
    if a.life_goals_present and b.life_goals_present:
        lg_scale = _importance_scale(int(round((a.life_goals_importance + b.life_goals_importance) / 2)))
        marriage_points = 0.0
        if a.marriage_intent == b.marriage_intent and a.marriage_intent != "unsure":
            marriage_points = 12.0 * lg_scale
        elif "open" in (a.marriage_intent, b.marriage_intent):
            marriage_points = 4.0 * lg_scale
        elif a.marriage_intent != "unsure" and b.marriage_intent != "unsure":
            marriage_points = -14.0 * lg_scale
        total += marriage_points
        comps.append(ScoreComponent("marriage_intent", clamp_int(marriage_points, -100, 100), f"{a.marriage_intent} vs {b.marriage_intent}"))

        kids_points = 0.0
        if a.kids_intent == b.kids_intent and a.kids_intent != "unsure":
            kids_points = 12.0 * lg_scale
        elif "open" in (a.kids_intent, b.kids_intent):
            kids_points = 4.0 * lg_scale
        elif a.kids_intent != "unsure" and b.kids_intent != "unsure":
            kids_points = -16.0 * lg_scale
        total += kids_points
        comps.append(ScoreComponent("kids_intent", clamp_int(kids_points, -100, 100), f"{a.kids_intent} vs {b.kids_intent}"))

        timeline_points = 0.0
        if a.kids_timeline == b.kids_timeline and a.kids_timeline != "unsure":
            timeline_points = 6.0 * lg_scale
        elif a.kids_timeline != "unsure" and b.kids_timeline != "unsure":
            timeline_points = -6.0 * lg_scale
        total += timeline_points
        comps.append(ScoreComponent("kids_timeline", clamp_int(timeline_points, -100, 100), f"{a.kids_timeline} vs {b.kids_timeline}"))

    # Love needs (soft; lack of overlap can be meaningful if importance is high).
    if a.love_needs_present and b.love_needs_present:
        ln_scale = _importance_scale(int(round((a.love_needs_importance + b.love_needs_importance) / 2)))
        overlap = set(a.love_needs_primary).intersection(set(b.love_needs_primary))
        if overlap:
            love_points = 4.0 * float(len(overlap)) * ln_scale
            detail = ", ".join(sorted(overlap))
        elif a.love_needs_primary and b.love_needs_primary:
            love_points = -8.0 * ln_scale
            detail = "no overlap"
        else:
            love_points = 0.0
            detail = "missing"
        total += love_points
        comps.append(ScoreComponent("love_needs_overlap", clamp_int(love_points, -100, 100), detail))

        texting_points = 0.0
        if a.love_needs_texting == b.love_needs_texting and a.love_needs_texting != "unsure":
            texting_points = 6.0 * ln_scale
        elif a.love_needs_texting != "unsure" and b.love_needs_texting != "unsure":
            texting_points = -6.0 * ln_scale
        total += texting_points
        comps.append(ScoreComponent("texting_frequency", clamp_int(texting_points, -100, 100), f"{a.love_needs_texting} vs {b.love_needs_texting}"))

    # Sexual needs (monogamy conflict is handled as hard filter; libido/preference is soft).
    if a.sexual_present and b.sexual_present:
        sx_scale = _importance_scale(int(round((a.sexual_importance + b.sexual_importance) / 2)))
        libido_points = 0.0
        if a.libido_level == b.libido_level and a.libido_level != "unsure":
            libido_points = 6.0 * sx_scale
        elif a.libido_level != "unsure" and b.libido_level != "unsure":
            libido_points = -6.0 * sx_scale
        total += libido_points
        comps.append(ScoreComponent("libido_alignment", clamp_int(libido_points, -100, 100), f"{a.libido_level} vs {b.libido_level}"))

        pref_overlap = set(a.sexual_preferences).intersection(set(b.sexual_preferences))
        pref_points = 3.0 * float(len(pref_overlap)) * sx_scale if pref_overlap else 0.0
        total += pref_points
        comps.append(ScoreComponent("sexual_preferences_overlap", clamp_int(pref_points, -100, 100), ", ".join(sorted(pref_overlap)) or "none"))

    # Intellect / activities (soft).
    if a.intellect_present and b.intellect_present:
        iq_scale = _importance_scale(int(round((a.intellect_importance + b.intellect_importance) / 2)))
        style_points = 0.0
        if a.intellect_style == b.intellect_style and a.intellect_style != "unsure":
            style_points = 6.0 * iq_scale
        elif a.intellect_style != "unsure" and b.intellect_style != "unsure":
            style_points = -6.0 * iq_scale
        total += style_points
        comps.append(ScoreComponent("intellect_style", clamp_int(style_points, -100, 100), f"{a.intellect_style} vs {b.intellect_style}"))

        curiosity_points = 0.0
        if a.curiosity_level == b.curiosity_level and a.curiosity_level != "unsure":
            curiosity_points = 6.0 * iq_scale
        elif a.curiosity_level != "unsure" and b.curiosity_level != "unsure":
            curiosity_points = -6.0 * iq_scale
        total += curiosity_points
        comps.append(ScoreComponent("curiosity_level", clamp_int(curiosity_points, -100, 100), f"{a.curiosity_level} vs {b.curiosity_level}"))

        culture_overlap = set(a.culture_tags).intersection(set(b.culture_tags))
        culture_points = 3.0 * float(len(culture_overlap)) * iq_scale if culture_overlap else 0.0
        total += culture_points
        comps.append(ScoreComponent("culture_overlap", clamp_int(culture_points, -100, 100), ", ".join(sorted(culture_overlap)) or "none"))

    # Communication preferences (soft; avoidant vs direct can hurt).
    if a.communication_prefs_present and b.communication_prefs_present:
        com_scale = _importance_scale(int(round((a.communication_importance + b.communication_importance) / 2)))
        conflict_points = 0.0
        if a.conflict_style == b.conflict_style and a.conflict_style != "unsure":
            conflict_points = 6.0 * com_scale
        elif (a.conflict_style, b.conflict_style) in {("avoidant", "direct"), ("direct", "avoidant")}:
            conflict_points = -10.0 * com_scale
        elif a.conflict_style != "unsure" and b.conflict_style != "unsure":
            conflict_points = -4.0 * com_scale
        total += conflict_points
        comps.append(ScoreComponent("conflict_style", clamp_int(conflict_points, -100, 100), f"{a.conflict_style} vs {b.conflict_style}"))

        openness_points = 0.0
        if a.emotional_openness == b.emotional_openness and a.emotional_openness != "unsure":
            openness_points = 6.0 * com_scale
        elif a.emotional_openness != "unsure" and b.emotional_openness != "unsure":
            openness_points = -6.0 * com_scale
        total += openness_points
        comps.append(ScoreComponent("emotional_openness", clamp_int(openness_points, -100, 100), f"{a.emotional_openness} vs {b.emotional_openness}"))

        reassurance_points = 0.0
        if a.reassurance_need == b.reassurance_need and a.reassurance_need != "unsure":
            reassurance_points = 4.0 * com_scale
        elif a.reassurance_need != "unsure" and b.reassurance_need != "unsure":
            reassurance_points = -4.0 * com_scale
        total += reassurance_points
        comps.append(ScoreComponent("reassurance_need", clamp_int(reassurance_points, -100, 100), f"{a.reassurance_need} vs {b.reassurance_need}"))

    # Religion (soft unless must-match filtered).
    if a.religion_present and b.religion_present:
        rel_scale = _importance_scale(int(round((a.religion_importance + b.religion_importance) / 2)))
        belief_points = 0.0
        if a.belief == b.belief and a.belief != "unsure":
            belief_points = 8.0 * rel_scale
        elif a.belief != "unsure" and b.belief != "unsure":
            belief_points = -10.0 * rel_scale
        total += belief_points
        comps.append(ScoreComponent("religion_belief", clamp_int(belief_points, -100, 100), f"{a.belief} vs {b.belief}"))

        practice_points = 0.0
        if a.practice == b.practice and a.practice != "unsure":
            practice_points = 6.0 * rel_scale
        elif a.practice != "unsure" and b.practice != "unsure":
            practice_points = -6.0 * rel_scale
        total += practice_points
        comps.append(ScoreComponent("religion_practice", clamp_int(practice_points, -100, 100), f"{a.practice} vs {b.practice}"))

    # Financial alignment (soft unless must-match filtered).
    if a.finance_present and b.finance_present:
        fin_scale = _importance_scale(int(round((a.finance_importance + b.finance_importance) / 2)))
        spend_points = 0.0
        if a.spender_saver == b.spender_saver and a.spender_saver != "unsure":
            spend_points = 8.0 * fin_scale
        elif a.spender_saver != "unsure" and b.spender_saver != "unsure":
            spend_points = -8.0 * fin_scale
        total += spend_points
        comps.append(ScoreComponent("spender_saver", clamp_int(spend_points, -100, 100), f"{a.spender_saver} vs {b.spender_saver}"))

        risk_points = 0.0
        if a.risk_tolerance == b.risk_tolerance and a.risk_tolerance != "unsure":
            risk_points = 6.0 * fin_scale
        elif a.risk_tolerance != "unsure" and b.risk_tolerance != "unsure":
            risk_points = -6.0 * fin_scale
        total += risk_points
        comps.append(ScoreComponent("risk_tolerance", clamp_int(risk_points, -100, 100), f"{a.risk_tolerance} vs {b.risk_tolerance}"))

        debt_points = 0.0
        if a.debt_comfort == b.debt_comfort and a.debt_comfort != "unsure":
            debt_points = 5.0 * fin_scale
        elif a.debt_comfort != "unsure" and b.debt_comfort != "unsure":
            debt_points = -5.0 * fin_scale
        total += debt_points
        comps.append(ScoreComponent("debt_comfort", clamp_int(debt_points, -100, 100), f"{a.debt_comfort} vs {b.debt_comfort}"))

    # Attractiveness scoring - weighted by how much each person cares
    # Maximum contribution: +/- 20 points per person's perspective
    attractiveness_gap = abs(a.own_attractiveness - b.own_attractiveness)

    # A's perspective on B's attractiveness
    if a.attractiveness_importance >= 5:  # They care at least somewhat
        # Scale: importance 5 = 0.5x weight, importance 10 = 1.0x weight
        a_weight = (a.attractiveness_importance - 4) / 6.0  # 0.17 to 1.0
        # Bonus/penalty based on how attractive B is relative to A's "standards"
        # If B is more attractive than A, bonus. If B is much less attractive, penalty.
        a_attr_delta = b.own_attractiveness - a.own_attractiveness
        if a_attr_delta >= 0:
            # B is as attractive or more - bonus scaled by how much A cares
            a_attr_points = a_weight * min(a_attr_delta * 3.0, 15.0)
        else:
            # B is less attractive - penalty scaled by gap and how much A cares
            a_attr_points = a_weight * max(a_attr_delta * 4.0, -20.0)
        total += a_attr_points
        comps.append(
            ScoreComponent(
                "attractiveness_A_view",
                clamp_int(a_attr_points, -100, 100),
                f"A(imp={a.attractiveness_importance}) sees B({b.own_attractiveness})",
            )
        )

    # B's perspective on A's attractiveness
    if b.attractiveness_importance >= 5:
        b_weight = (b.attractiveness_importance - 4) / 6.0
        b_attr_delta = a.own_attractiveness - b.own_attractiveness
        if b_attr_delta >= 0:
            b_attr_points = b_weight * min(b_attr_delta * 3.0, 15.0)
        else:
            b_attr_points = b_weight * max(b_attr_delta * 4.0, -20.0)
        total += b_attr_points
        comps.append(
            ScoreComponent(
                "attractiveness_B_view",
                clamp_int(b_attr_points, -100, 100),
                f"B(imp={b.attractiveness_importance}) sees A({a.own_attractiveness})",
            )
        )

    # Fitness/build compatibility scoring
    # Build compatibility matrix
    build_rank = {"thin": 1, "fit": 2, "average": 3, "above_average": 4, "overweight": 5}
    a_build_rank = build_rank.get(a.own_build, 3)
    b_build_rank = build_rank.get(b.own_build, 3)
    _ = abs(a_build_rank - b_build_rank)

    # If either cares about fitness, apply scoring
    if a.fitness_importance >= 5:
        a_fit_weight = (a.fitness_importance - 4) / 6.0
        # Fit (rank 2) is most desirable, penalty increases with distance from fit
        b_fitness_score = 2 - abs(b_build_rank - 2)  # fit=2, thin=1, average=1, above_average=0, overweight=-1
        a_fit_points = a_fit_weight * b_fitness_score * 6.0
        total += a_fit_points
        comps.append(
            ScoreComponent(
                "fitness_A_view",
                clamp_int(a_fit_points, -100, 100),
                f"A(imp={a.fitness_importance}) sees B({b.own_build})",
            )
        )

    if b.fitness_importance >= 5:
        b_fit_weight = (b.fitness_importance - 4) / 6.0
        a_fitness_score = 2 - abs(a_build_rank - 2)
        b_fit_points = b_fit_weight * a_fitness_score * 6.0
        total += b_fit_points
        comps.append(
            ScoreComponent(
                "fitness_B_view",
                clamp_int(b_fit_points, -100, 100),
                f"B(imp={b.fitness_importance}) sees A({a.own_build})",
            )
        )

    final = clamp_int(total - 20.0, -100, 100)
    comps.append(ScoreComponent("bias", -20, "normalize"))
    comps.append(ScoreComponent("final", final, "sum+clamp"))
    return final, comps


def score_cofounder(a: CofounderSignals, b: CofounderSignals) -> Tuple[int, List[ScoreComponent]]:
    comps: List[ScoreComponent] = []
    total = 0.0

    role_points = 16.0 if a.role != b.role else -12.0
    total += role_points
    comps.append(ScoreComponent("role_complementarity", clamp_int(role_points, -100, 100), f"{a.role} vs {b.role}"))

    stage_points = 22.0 if a.stage_pref == b.stage_pref else 6.0
    total += stage_points
    comps.append(ScoreComponent("stage_alignment", clamp_int(stage_points, -100, 100), f"{a.stage_pref} vs {b.stage_pref}"))

    commitment_rank = {"full_time": 1.0, "part_time": 0.6, "weekends_only": 0.3, "exploring": 0.1}
    ca = commitment_rank.get(a.commitment, 0.1)
    cb = commitment_rank.get(b.commitment, 0.1)
    commit_points = 35.0 * (1.0 - abs(ca - cb))
    if (a.commitment == "full_time") != (b.commitment == "full_time"):
        commit_points -= 10.0
    total += commit_points
    comps.append(ScoreComponent("commitment_alignment", clamp_int(commit_points, -100, 100), f"{a.commitment} vs {b.commitment}"))

    speed_points = 12.0 if a.speed == b.speed else 4.0
    total += speed_points
    comps.append(ScoreComponent("speed_alignment", clamp_int(speed_points, -100, 100), f"{a.speed} vs {b.speed}"))

    risk_rank = {"high_risk": 1.0, "medium_risk": 0.6, "low_risk": 0.2}
    ra = risk_rank.get(a.risk, 0.6)
    rb = risk_rank.get(b.risk, 0.6)
    risk_points = 12.0 * (1.0 - abs(ra - rb))
    total += risk_points
    comps.append(ScoreComponent("risk_alignment", clamp_int(risk_points, -100, 100), f"{a.risk} vs {b.risk}"))

    shared_domains = set(a.domain_tags).intersection(set(b.domain_tags))
    domain_points = 8.0 * float(len(shared_domains))
    total += domain_points
    comps.append(ScoreComponent("shared_domains", clamp_int(domain_points, -100, 100), ", ".join(sorted(shared_domains)) or "none"))

    shared_skills = set(a.skill_tags).intersection(set(b.skill_tags))
    skill_points = 3.0 * float(len(shared_skills))
    if ("sales" in a.skill_tags and "backend" in b.skill_tags) or ("sales" in b.skill_tags and "backend" in a.skill_tags):
        skill_points += 8.0
    if ("product" in a.skill_tags and "ml" in b.skill_tags) or ("product" in b.skill_tags and "ml" in a.skill_tags):
        skill_points += 6.0
    total += skill_points
    comps.append(ScoreComponent("skills_signal", clamp_int(skill_points, -100, 100), ", ".join(sorted(shared_skills)) or "none"))

    final = clamp_int(total - 18.0, -100, 100)
    comps.append(ScoreComponent("bias", -18, "normalize"))
    comps.append(ScoreComponent("final", final, "sum+clamp"))
    return final, comps


def score_friendship(a: FriendshipSignals, b: FriendshipSignals) -> Tuple[int, List[ScoreComponent]]:
    comps: List[ScoreComponent] = []
    total = 0.0

    vibe_points = 22.0 if a.vibe == b.vibe else 8.0
    total += vibe_points
    comps.append(ScoreComponent("vibe_alignment", clamp_int(vibe_points, -100, 100), f"{a.vibe} vs {b.vibe}"))

    style_points = 16.0 if a.social_style == b.social_style else 6.0
    total += style_points
    comps.append(ScoreComponent("social_style_alignment", clamp_int(style_points, -100, 100), f"{a.social_style} vs {b.social_style}"))

    energy_rank = {"low_key": 0.2, "balanced": 0.6, "high_energy": 1.0}
    ea = energy_rank.get(a.energy, 0.6)
    eb = energy_rank.get(b.energy, 0.6)
    energy_points = 20.0 * (1.0 - abs(ea - eb))
    if ("low_key" in (a.energy, b.energy)) and ("high_energy" in (a.energy, b.energy)):
        energy_points -= 10.0
    total += energy_points
    comps.append(ScoreComponent("energy_alignment", clamp_int(energy_points, -100, 100), f"{a.energy} vs {b.energy}"))

    weekend_points = 10.0 if a.weekend == b.weekend else 4.0
    total += weekend_points
    comps.append(ScoreComponent("weekend_alignment", clamp_int(weekend_points, -100, 100), f"{a.weekend} vs {b.weekend}"))

    shared = set(a.interest_tags).intersection(set(b.interest_tags))
    interest_points = 7.0 * float(len(shared))
    total += interest_points
    comps.append(ScoreComponent("shared_interests", clamp_int(interest_points, -100, 100), ", ".join(sorted(shared)) or "none"))

    boundary_points = 4.0 if set(a.boundaries).intersection(set(b.boundaries)) else 0.0
    total += boundary_points
    comps.append(ScoreComponent("shared_boundaries", clamp_int(boundary_points, -100, 100), "some" if boundary_points else "none"))

    final = clamp_int(total - 18.0, -100, 100)
    comps.append(ScoreComponent("bias", -18, "normalize"))
    comps.append(ScoreComponent("final", final, "sum+clamp"))
    return final, comps
