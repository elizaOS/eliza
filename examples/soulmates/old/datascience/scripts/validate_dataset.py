#!/usr/bin/env python3
from __future__ import annotations

import _bootstrap  # noqa: F401
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

from matcher.types import Domain


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    errors: Tuple[str, ...]


def _load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _validate_personas(domain: Domain, personas: List[object]) -> List[str]:
    errors: List[str] = []
    if not isinstance(personas, list):
        return [f"{domain}: personas file must be a list"]
    for idx, p in enumerate(personas):
        if not isinstance(p, dict):
            errors.append(f"{domain}: persona[{idx}] must be an object")
            continue
        for key in ("id", "domain", "required", "optional", "conversations", "facts"):
            if key not in p:
                errors.append(f"{domain}: persona[{idx}] missing key {key}")
        if p.get("domain") != domain:
            errors.append(f"{domain}: persona[{idx}] has wrong domain {p.get('domain')}")
        pid = p.get("id")
        if not isinstance(pid, str):
            errors.append(f"{domain}: persona[{idx}] id must be string")
        req = p.get("required")
        if not isinstance(req, dict):
            errors.append(f"{domain}: persona[{idx}] required must be object")
            continue
        for key in ("name", "age", "location"):
            if key not in req:
                errors.append(f"{domain}: persona[{idx}] required missing {key}")
        loc = req.get("location")
        if not isinstance(loc, dict):
            errors.append(f"{domain}: persona[{idx}] required.location must be object")
        else:
            for k in ("city", "neighborhood", "country"):
                if k not in loc:
                    errors.append(f"{domain}: persona[{idx}] required.location missing {k}")
    return errors


def _validate_matrix(domain: Domain, matrix: Dict[str, object], persona_ids: List[str]) -> List[str]:
    errors: List[str] = []
    if matrix.get("domain") != domain:
        errors.append(f"{domain}: matrix domain mismatch: {matrix.get('domain')}")
    ids = matrix.get("personaIds")
    if not isinstance(ids, list):
        errors.append(f"{domain}: matrix personaIds must be list")
        return errors
    ids_str = [x for x in ids if isinstance(x, str)]
    if len(ids_str) != len(ids):
        errors.append(f"{domain}: matrix personaIds must all be strings")
        return errors
    if set(ids_str) != set(persona_ids):
        errors.append(f"{domain}: matrix personaIds must match persona ids exactly")

    scores = matrix.get("scores")
    if not isinstance(scores, dict):
        errors.append(f"{domain}: matrix scores must be object")
        return errors

    # Ensure symmetry for present scores and no diagonal. (Pairs may be filtered out and omitted.)
    for a in persona_ids:
        row = scores.get(a)
        if not isinstance(row, dict):
            errors.append(f"{domain}: scores missing row for {a}")
            continue
        for b in persona_ids:
            if a == b:
                if b in row:
                    errors.append(f"{domain}: scores must not contain diagonal {a}->{b}")
                continue
            if b in row:
                v = row[b]
                if not isinstance(v, int):
                    errors.append(f"{domain}: score {a}->{b} must be int")
                    continue
                if v < -100 or v > 100:
                    errors.append(f"{domain}: score {a}->{b} out of range: {v}")

    for a in persona_ids:
        for b in persona_ids:
            if a == b:
                continue
            ra = scores.get(a)
            rb = scores.get(b)
            if not isinstance(ra, dict) or not isinstance(rb, dict):
                continue
            a_has = b in ra
            b_has = a in rb
            if a_has != b_has:
                errors.append(f"{domain}: symmetry violated presence {a}<->{b}: {a_has} vs {b_has}")
                continue
            if a_has and b_has:
                va = ra[b]
                vb = rb[a]
                if isinstance(va, int) and isinstance(vb, int) and va != vb:
                    errors.append(f"{domain}: symmetry violated {a}<->{b}: {va} vs {vb}")

    # Ensure top/worst lists only reference pairs that exist in scores.
    def _check_rank_lists(key: str) -> None:
        v = matrix.get(key)
        if not isinstance(v, dict):
            errors.append(f"{domain}: {key} must be object")
            return
        for pid, items in v.items():
            if pid not in persona_ids:
                errors.append(f"{domain}: {key} contains unknown persona id {pid}")
                continue
            if not isinstance(items, list):
                errors.append(f"{domain}: {key}[{pid}] must be list")
                continue
            row = scores.get(pid)
            if not isinstance(row, dict):
                continue
            for it in items:
                if not isinstance(it, dict):
                    errors.append(f"{domain}: {key}[{pid}] item must be object")
                    continue
                other = it.get("otherId")
                sc = it.get("score")
                if not isinstance(other, str) or not isinstance(sc, int):
                    errors.append(f"{domain}: {key}[{pid}] item must have otherId(str) and score(int)")
                    continue
                if other not in row:
                    errors.append(f"{domain}: {key}[{pid}] references filtered-out pair {pid}->{other}")
                    continue
                if row[other] != sc:
                    errors.append(f"{domain}: {key}[{pid}] score mismatch for {pid}->{other}: {sc} vs {row[other]}")

    _check_rank_lists("topMatches")
    _check_rank_lists("worstMatches")

    return errors


def validate_repo(root: Path) -> ValidationResult:
    errors: List[str] = []

    domains: List[Domain] = ["dating", "business", "friendship"]
    for domain in domains:
        data_dir = root / "data" / (domain if domain != "business" else "cofounders")
        sf_path = data_dir / "personas_sf.json"
        ny_path = data_dir / "personas_ny.json"
        mat_path = data_dir / "match_matrix.json"

        sf = _load_json(sf_path)
        ny = _load_json(ny_path)
        errors.extend(_validate_personas(domain, sf))
        errors.extend(_validate_personas(domain, ny))

        persona_ids: List[str] = []
        for p in (sf + ny):
            if isinstance(p, dict) and isinstance(p.get("id"), str):
                persona_ids.append(p["id"])

        if len(persona_ids) != 50:
            errors.append(f"{domain}: expected 50 personas, got {len(persona_ids)}")

        if len(set(persona_ids)) != len(persona_ids):
            errors.append(f"{domain}: persona ids must be unique")

        mat = _load_json(mat_path)
        if not isinstance(mat, dict):
            errors.append(f"{domain}: match_matrix.json must be an object")
        else:
            errors.extend(_validate_matrix(domain, mat, persona_ids))

    return ValidationResult(ok=len(errors) == 0, errors=tuple(errors))


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    res = validate_repo(root)
    if res.ok:
        print("OK: dataset validated")
        return
    print("FAILED: dataset validation errors:")
    for e in res.errors:
        print(f"- {e}")
    raise SystemExit(1)


if __name__ == "__main__":
    main()

