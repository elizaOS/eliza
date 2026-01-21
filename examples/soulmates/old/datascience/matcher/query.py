from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

from matcher.scoring import score_cofounder, score_dating, score_friendship
from matcher.signals import cofounder_from_persona, dating_from_persona, dating_ineligibility_reason, friendship_from_persona
from matcher.types import Domain


@dataclass(frozen=True)
class Match:
    other_id: str
    score: int


def load_personas(root: Path, domain: Domain) -> Dict[str, Dict[str, object]]:
    d = _domain_dir(root, domain)
    sf = _load_json(d / "personas_sf.json")
    ny = _load_json(d / "personas_ny.json")
    if not isinstance(sf, list) or not isinstance(ny, list):
        raise ValueError("personas files must be lists")
    out: Dict[str, Dict[str, object]] = {}
    for p in (sf + ny):
        if isinstance(p, dict) and isinstance(p.get("id"), str):
            out[p["id"]] = p
    return out


def load_matrix(root: Path, domain: Domain) -> Dict[str, object]:
    return _load_json(_domain_dir(root, domain) / "match_matrix.json")


def score_row(matrix: Dict[str, object], persona_id: str) -> Dict[str, int]:
    scores = matrix["scores"]
    if not isinstance(scores, dict):
        raise ValueError("scores must be object")
    row = scores[persona_id]
    if not isinstance(row, dict):
        raise ValueError("scores row must be object")
    out: Dict[str, int] = {}
    for k, v in row.items():
        if isinstance(k, str) and isinstance(v, int):
            out[k] = v
    return out


def basic_card(p: Dict[str, object]) -> str:
    req = p.get("required")
    if not isinstance(req, dict):
        return "unknown"
    name = req.get("name", "")
    age = req.get("age", "")
    loc = req.get("location")
    city = ""
    neighborhood = ""
    if isinstance(loc, dict):
        city = str(loc.get("city", ""))
        neighborhood = str(loc.get("neighborhood", ""))
    return f"{name} ({age}) — {neighborhood}, {city}"


def city_of(p: Dict[str, object]) -> str:
    req = p.get("required")
    if not isinstance(req, dict):
        return ""
    loc = req.get("location")
    if not isinstance(loc, dict):
        return ""
    city = loc.get("city")
    return city if isinstance(city, str) else ""


def persona_summary(p: Dict[str, object]) -> List[str]:
    lines: List[str] = []
    req = p.get("required")
    opt = p.get("optional")

    if isinstance(req, dict):
        name = req.get("name")
        age = req.get("age")
        loc = req.get("location")
        if isinstance(loc, dict):
            city = loc.get("city")
            neighborhood = loc.get("neighborhood")
            country = loc.get("country")
            lines.append(f"Name: {name}")
            lines.append(f"Age: {age}")
            lines.append(f"Location: {neighborhood}, {city}, {country}")

    if isinstance(opt, dict):
        def show_if(k: str, label: str) -> None:
            v = opt.get(k)
            if isinstance(v, str) and v:
                lines.append(f"{label}: {v}")

        def show_list(k: str, label: str, max_items: int = 6) -> None:
            v = opt.get(k)
            if isinstance(v, list) and all(isinstance(x, str) for x in v) and v:
                lines.append(f"{label}: {', '.join(v[:max_items])}{'…' if len(v) > max_items else ''}")

        show_if("jobTitle", "Job")
        show_if("industry", "Industry")
        show_if("genderIdentity", "Gender")
        show_if("pronouns", "Pronouns")
        show_if("sexualOrientation", "Orientation")
        show_if("relationshipGoal", "Relationship goal")
        show_if("communicationStyle", "Communication style")
        show_if("friendshipStyle", "Friendship style")
        show_if("vibe", "Vibe")
        show_list("interests", "Interests")
        show_list("skills", "Skills")
        dp = opt.get("datingPreferences")
        if isinstance(dp, dict):
            pg = dp.get("preferredGenders")
            amin = dp.get("preferredAgeMin")
            amax = dp.get("preferredAgeMax")
            if isinstance(pg, list) and all(isinstance(x, str) for x in pg) and pg:
                lines.append(f"Dating prefs (genders): {', '.join(pg)}")
            if isinstance(amin, int) and isinstance(amax, int):
                lines.append(f"Dating prefs (age): {amin}-{amax}")

        ss = opt.get("scoringSignals")
        if isinstance(ss, dict):
            # Keep this compact; it's the stable truth used by scoring.
            keys = sorted(k for k in ss.keys() if isinstance(k, str))
            preview: List[str] = []
            for k in keys:
                v = ss.get(k)
                if isinstance(v, str):
                    preview.append(f"{k}={v}")
                elif isinstance(v, list) and all(isinstance(x, str) for x in v):
                    preview.append(f"{k}=[{', '.join(v[:4])}{'…' if len(v) > 4 else ''}]")
            if preview:
                lines.append("scoringSignals: " + "; ".join(preview[:8]) + ("; …" if len(preview) > 8 else ""))

    return lines


def breakdown(domain: Domain, a: Dict[str, object], b: Dict[str, object]) -> List[str]:
    if domain == "dating":
        aa = dating_from_persona(a)
        bb = dating_from_persona(b)
        reason = dating_ineligibility_reason(aa, bb)
        if reason:
            return [f"Filtered out (hard constraints): {reason}"]
        s, comps = score_dating(aa, bb)
    elif domain == "business":
        s, comps = score_cofounder(cofounder_from_persona(a), cofounder_from_persona(b))
    else:
        s, comps = score_friendship(friendship_from_persona(a), friendship_from_persona(b))

    lines: List[str] = [f"Recomputed score (from scoringSignals): {s}"]
    for c in comps:
        if c.name in ("final",):
            continue
        lines.append(f"{c.name}: {c.contribution} ({c.detail})")
    return lines


def query_matches(
    root: Path,
    domain: Domain,
    persona_id: str,
    top_n: int,
    worst_n: int,
    same_city: bool,
    city: str | None,
    explain: bool,
) -> Dict[str, object]:
    personas = load_personas(root, domain)
    matrix = load_matrix(root, domain)

    if persona_id not in personas:
        raise ValueError(f"Unknown persona id: {persona_id}")

    base_city = city_of(personas[persona_id])
    city_filter = city if city is not None else (base_city if same_city else None)

    row = score_row(matrix, persona_id)
    raw_items: List[Match] = [Match(other_id=k, score=v) for k, v in row.items() if k != persona_id]

    # Filter by city (default same-city).
    if isinstance(city_filter, str) and city_filter:
        raw_items = [m for m in raw_items if city_of(personas.get(m.other_id, {})) == city_filter]

    # Filter out hard-constraint mismatches from ranking (dating only).
    if domain == "dating":
        base = dating_from_persona(personas[persona_id])
        eligible: List[Match] = []
        for m in raw_items:
            other = personas.get(m.other_id)
            if not isinstance(other, dict):
                continue
            reason = dating_ineligibility_reason(base, dating_from_persona(other))
            if reason:
                continue
            eligible.append(m)
        items = eligible
        filtered_count = len(raw_items) - len(items)
    else:
        items = raw_items
        filtered_count = 0

    items_sorted = sorted(items, key=lambda m: m.score, reverse=True)
    items_worst = sorted(items, key=lambda m: m.score)

    top_items = items_sorted[:top_n] if top_n > 0 else []
    worst_items = items_worst[:worst_n] if worst_n > 0 else []

    details: Dict[str, List[str]] = {}
    if explain:
        for m in top_items + worst_items:
            details[m.other_id] = breakdown(domain, personas[persona_id], personas[m.other_id])

    return {
        "persona": personas[persona_id],
        "personas": personas,
        "city_filter": city_filter if isinstance(city_filter, str) and city_filter else None,
        "filtered_count": filtered_count,
        "candidate_count": len(items),
        "top": top_items,
        "worst": worst_items,
        "details": details,
    }


def _domain_dir(root: Path, domain: Domain) -> Path:
    if domain == "business":
        return root / "data" / "cofounders"
    return root / "data" / domain


def _load_json(path: Path) -> Dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))
