"""Scorer v2 — with relationship type accuracy and full item traces.

Port of the TypeScript scorer.ts.
"""

from __future__ import annotations

import re

from .types import (
    Conversation,
    Extraction,
    GroundTruthWorld,
    ItemTrace,
    Metrics,
    RelationshipMetrics,
    Resolution,
)


def compute_metrics(tp: int, fp: int, fn: int) -> Metrics:
    """Compute precision, recall, and F1 from raw counts."""
    precision = tp / (tp + fp) if (tp + fp) > 0 else 1.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 1.0
    f1 = (2 * precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0
    return Metrics(tp=tp, fp=fp, fn=fn, precision=precision, recall=recall, f1=f1)


def _norm(handle: str) -> str:
    """Normalize a handle for comparison: strip @, lowercase, strip whitespace."""
    return re.sub(r"^@", "", handle).lower().strip()


# ── Identity scoring ──────────────────────────────


def score_identities(
    conv: Conversation,
    ext: Extraction,
) -> tuple[Metrics, list[ItemTrace]]:
    """Score extracted identities against expected."""
    expected = conv.expected.identities
    actual = ext.identities
    items: list[ItemTrace] = []
    matched: set[int] = set()

    for a in actual:
        found_idx = -1
        for i, e in enumerate(expected):
            if (
                i not in matched
                and e.entity_id == a.entity_id
                and e.platform == a.platform
                and _norm(e.handle) == _norm(a.handle)
            ):
                found_idx = i
                break
        if found_idx >= 0:
            matched.add(found_idx)
            items.append(ItemTrace(
                status="TP",
                label=f"{a.entity_id}/{a.platform}:{a.handle}",
                detail="Match",
            ))
        else:
            items.append(ItemTrace(
                status="FP",
                label=f"{a.entity_id}/{a.platform}:{a.handle}",
                detail="Extra",
            ))

    for i, e in enumerate(expected):
        if i not in matched:
            items.append(ItemTrace(
                status="FN",
                label=f"{e.entity_id}/{e.platform}:{e.handle}",
                detail="Missed",
            ))

    tp = sum(1 for it in items if it.status == "TP")
    fp = sum(1 for it in items if it.status == "FP")
    fn = sum(1 for it in items if it.status == "FN")
    return compute_metrics(tp, fp, fn), items


# ── Relationship scoring ──────────────────────────


def score_relationships(
    conv: Conversation,
    ext: Extraction,
) -> tuple[RelationshipMetrics, list[ItemTrace]]:
    """Score extracted relationships against expected."""
    expected = conv.expected.relationships
    actual = ext.relationships
    items: list[ItemTrace] = []
    matched: set[int] = set()
    type_matches = 0
    total_matches = 0

    for a in actual:
        found_idx = -1
        for i, e in enumerate(expected):
            if i not in matched and (
                (e.entity_a == a.entity_a and e.entity_b == a.entity_b)
                or (e.entity_a == a.entity_b and e.entity_b == a.entity_a)
            ):
                found_idx = i
                break
        if found_idx >= 0:
            matched.add(found_idx)
            total_matches += 1
            type_ok = expected[found_idx].type == a.type
            if type_ok:
                type_matches += 1
            items.append(ItemTrace(
                status="TP" if type_ok else "PARTIAL",
                label=f"{a.entity_a}<->{a.entity_b} [{a.type}]",
                detail="Match" if type_ok else (
                    f"Pair correct, type wrong "
                    f"(expected: {expected[found_idx].type}, got: {a.type})"
                ),
            ))
        else:
            items.append(ItemTrace(
                status="FP",
                label=f"{a.entity_a}<->{a.entity_b} [{a.type}]",
                detail="Extra",
            ))

    for i, e in enumerate(expected):
        if i not in matched:
            items.append(ItemTrace(
                status="FN",
                label=f"{e.entity_a}<->{e.entity_b} [{e.type}]",
                detail="Missed",
            ))

    tp = sum(1 for it in items if it.status in ("TP", "PARTIAL"))
    fp = sum(1 for it in items if it.status == "FP")
    fn = sum(1 for it in items if it.status == "FN")
    type_accuracy = type_matches / total_matches if total_matches > 0 else 1.0

    base = compute_metrics(tp, fp, fn)
    return (
        RelationshipMetrics(
            tp=base.tp,
            fp=base.fp,
            fn=base.fn,
            precision=base.precision,
            recall=base.recall,
            f1=base.f1,
            type_accuracy=type_accuracy,
        ),
        items,
    )


# ── Trust signal scoring ──────────────────────────


def score_trust(
    conv: Conversation,
    ext: Extraction,
) -> tuple[Metrics, list[ItemTrace]]:
    """Score extracted trust signals against expected."""
    expected = conv.expected.trust_signals
    actual = ext.trust_signals
    items: list[ItemTrace] = []
    matched: set[int] = set()

    for a in actual:
        found_idx = -1
        for i, e in enumerate(expected):
            if i not in matched and e.entity_id == a.entity_id and e.signal == a.signal:
                found_idx = i
                break
        if found_idx >= 0:
            matched.add(found_idx)
            items.append(ItemTrace(
                status="TP",
                label=f"{a.entity_id}:{a.signal}",
                detail="Match",
            ))
        else:
            items.append(ItemTrace(
                status="FP",
                label=f"{a.entity_id}:{a.signal}",
                detail="Extra",
            ))

    for i, e in enumerate(expected):
        if i not in matched:
            items.append(ItemTrace(
                status="FN",
                label=f"{e.entity_id}:{e.signal}",
                detail="Missed",
            ))

    tp = sum(1 for it in items if it.status == "TP")
    fp = sum(1 for it in items if it.status == "FP")
    fn = sum(1 for it in items if it.status == "FN")
    return compute_metrics(tp, fp, fn), items


# ── Resolution scoring ────────────────────────────


def score_resolution(
    world: GroundTruthWorld,
    res: Resolution,
) -> tuple[Metrics, float, list[ItemTrace]]:
    """Score entity resolution.

    Returns ``(metrics, false_merge_rate, items)``.
    """
    items: list[ItemTrace] = []
    matched_links: set[int] = set()

    for prop in res.links:
        # Check anti-links
        is_anti = any(
            (al.entity_a == prop.entity_a and al.entity_b == prop.entity_b)
            or (al.entity_a == prop.entity_b and al.entity_b == prop.entity_a)
            for al in world.anti_links
        )
        if is_anti:
            items.append(ItemTrace(
                status="FP",
                label=f"{prop.entity_a}<->{prop.entity_b}",
                detail="FALSE MERGE (anti-link)",
            ))
            continue

        found_idx = -1
        for i, link in enumerate(world.links):
            if i not in matched_links and (
                (link.entity_a == prop.entity_a and link.entity_b == prop.entity_b)
                or (link.entity_a == prop.entity_b and link.entity_b == prop.entity_a)
            ):
                found_idx = i
                break
        if found_idx >= 0:
            matched_links.add(found_idx)
            items.append(ItemTrace(
                status="TP",
                label=f"{prop.entity_a}<->{prop.entity_b} ({prop.confidence:.2f})",
                detail=f"Signals: {'; '.join(prop.signals)}",
            ))
        else:
            items.append(ItemTrace(
                status="FP",
                label=f"{prop.entity_a}<->{prop.entity_b}",
                detail="No ground truth link",
            ))

    for i, link in enumerate(world.links):
        if i not in matched_links:
            items.append(ItemTrace(
                status="FN",
                label=f"{link.entity_a}<->{link.entity_b}",
                detail=f"Missed [{link.difficulty}]: {link.reason}",
            ))

    tp = sum(1 for it in items if it.status == "TP")
    fp = sum(1 for it in items if it.status == "FP")
    fn = sum(1 for it in items if it.status == "FN")
    false_merge_rate = fp / (tp + fp) if (tp + fp) > 0 else 0.0

    return compute_metrics(tp, fp, fn), false_merge_rate, items
