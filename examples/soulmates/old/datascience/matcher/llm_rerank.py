from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Dict, List

from matcher.signals import dating_from_persona, dating_ineligibility_reason


@dataclass(frozen=True)
class Candidate:
    other_id: str
    baseline_score: int


def persona_card(p: Dict[str, object]) -> Dict[str, object]:
    req = p.get("required")
    opt = p.get("optional")
    out: Dict[str, object] = {}
    if isinstance(req, dict):
        out["name"] = req.get("name")
        out["age"] = req.get("age")
        loc = req.get("location")
        if isinstance(loc, dict):
            out["city"] = loc.get("city")
            out["neighborhood"] = loc.get("neighborhood")
    if isinstance(opt, dict):
        for k in (
            "genderIdentity",
            "pronouns",
            "sexualOrientation",
            "relationshipGoal",
            "communicationStyle",
            "jobTitle",
            "industry",
            "lifeGoals",
            "loveNeeds",
            "sexual",
            "intellect",
            "communicationPreferences",
            "religion",
            "finance",
        ):
            if k in opt:
                out[k] = opt.get(k)
        dp = opt.get("datingPreferences")
        if isinstance(dp, dict):
            out["datingPreferences"] = {
                "preferredGenders": dp.get("preferredGenders"),
                "preferredAgeMin": dp.get("preferredAgeMin"),
                "preferredAgeMax": dp.get("preferredAgeMax"),
                "monogamy": dp.get("monogamy"),
                "wantsKids": dp.get("wantsKids"),
                "pace": dp.get("pace"),
            }
        out["interests"] = opt.get("interests")
        out["dealbreakers"] = opt.get("dealbreakers")
        out["values"] = opt.get("values")
    return out


def facts_summary(p: Dict[str, object], max_facts: int = 14) -> List[Dict[str, object]]:
    facts = p.get("facts")
    if not isinstance(facts, list):
        return []
    out: List[Dict[str, object]] = []
    for f in facts[:max_facts]:
        if not isinstance(f, dict):
            continue
        out.append(
            {
                "type": f.get("type"),
                "key": f.get("key"),
                "value": f.get("value"),
                "confidence": f.get("confidence"),
            }
        )
    return out


def build_candidates(
    by_id: Dict[str, Dict[str, object]],
    scores: Dict[str, Dict[str, int]],
    persona_id: str,
    top_k: int,
    candidate_ids: List[str] | None = None,
) -> List[Candidate]:
    base = dating_from_persona(by_id[persona_id])
    row = scores.get(persona_id, {})
    candidates: List[Candidate] = []
    for other_id, sc in row.items():
        if candidate_ids is not None and other_id not in candidate_ids:
            continue
        other = by_id.get(other_id)
        if other is None:
            continue
        if dating_ineligibility_reason(base, dating_from_persona(other)):
            continue
        candidates.append(Candidate(other_id=other_id, baseline_score=int(sc)))
    candidates.sort(key=lambda c: c.baseline_score, reverse=True)
    return candidates[: max(1, int(top_k))]


def build_llm_payload(
    persona_id: str,
    persona: Dict[str, object],
    candidates: List[Candidate],
    by_id: Dict[str, Dict[str, object]],
    top_n: int,
) -> Dict[str, object]:
    payload = {
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a careful matchmaking evaluator. You will be given one user profile and a list of candidate profiles.\n"
                    "Use only the provided information. Output strict JSON.\n"
                    "Goal: choose top 10 matches with a high likelihood of success, with a ranked order and per-candidate reasoning.\n\n"
                    "## HARD DEALBREAKERS (MUST EXCLUDE from top 10 - NO EXCEPTIONS):\n"
                    "1. **Relationship goal mismatch** (commitment level):\n"
                    "   - casual ↔ long_term (EXCLUDE)\n"
                    "   - casual ↔ serious_but_slow (EXCLUDE)\n"
                    "   - casual ↔ marriage_minded (EXCLUDE)\n"
                    "   - exploring ↔ long_term (EXCLUDE)\n"
                    "   - exploring ↔ serious_but_slow (EXCLUDE)\n"
                    "   - exploring ↔ marriage_minded (EXCLUDE)\n"
                    "2. **Kids preference conflict** (SEPARATE from relationship goal):\n"
                    "   - wantsKids='no' ↔ wantsKids='yes' (EXCLUDE - direct conflict)\n"
                    "   - wantsKids='no' ↔ wantsKids='open' is acceptable (open means flexible)\n"
                    "   - Note: Someone can want long_term AND no kids - these are orthogonal\n"
                    "3. **Monogamy conflict**: yes ↔ no is incompatible; 'flexible' or null is acceptable.\n"
                    "4. **Explicit dealbreaker triggered**: If user A lists 'smoking' and B smokes, exclude.\n\n"
                    "## SOFT FACTORS (for ranking, not exclusion):\n"
                    "- Communication style compatibility\n"
                    "- Shared interests and values\n"
                    "- Lifestyle alignment (fitness, drinking, etc.)\n"
                    "- Location proximity\n\n"
                    "CRITICAL RULES:\n"
                    "- Do NOT recommend candidates with goal mismatches even if they share interests. Goal alignment is essential.\n"
                    "- Do NOT include bad matches just to 'fill' the top 10. Return fewer than 10 if there aren't 10 good matches.\n"
                    "- Relationship goal (casual/long_term/etc) and kids preference (wantsKids) are SEPARATE dimensions.\n"
                    "- Someone wanting long_term + no kids is valid - check both dimensions independently.\n"
                    "Return JSON with keys: topMatches (array of {id, llmScore0to100, reason}), notes (string).\n"
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "user": {"id": persona_id, "profile": persona_card(persona), "facts": facts_summary(persona)},
                        "candidates": [
                            {
                                "id": c.other_id,
                                "baselineScore": c.baseline_score,
                                "profile": persona_card(by_id[c.other_id]),
                                "facts": facts_summary(by_id[c.other_id]),
                            }
                            for c in candidates
                        ],
                        "instructions": {
                            "returnTopN": int(top_n),
                            "includeReasons": True,
                            "scoreScale": "0-100",
                            "notes": "baselineScore is only for coarse sorting; you must rerank with deeper reasoning.",
                        },
                    },
                    ensure_ascii=False,
                ),
            },
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
    }
    return payload
