"""Rolodex Handler v2 — heuristic extraction + signal-based resolution.

Port of the TypeScript handlers/rolodex.ts.

Extraction: pattern-based identity / relationship / trust detection.
Resolution: compares extracted handles against ALL entities' platform handles,
  uses shared-handle evidence to propose cross-platform links.
"""

from __future__ import annotations

import re
import time

from ..types import (
    Conversation,
    Extraction,
    GroundTruthWorld,
    IdentityExtraction,
    Message,
    RelationshipExtraction,
    Resolution,
    ResolutionLink,
    TrustSignalExtraction,
    WorldEntity,
)

# ── Constants (mirroring TS) ──────────────────────

SIGNAL_WEIGHTS: dict[str, float] = {
    "name_match": 0.15,
    "handle_correlation": 0.25,
    "project_affinity": 0.15,
    "shared_connections": 0.1,
    "temporal_proximity": 0.05,
    "self_identification": 0.3,
    "admin_confirmation": 1.0,
    "llm_inference": 0.2,
}

RESOLUTION_THRESHOLD_PROPOSE = 0.25


# ── Utilities ─────────────────────────────────────


def normalize_handle(handle: str) -> str:
    """Normalize a handle: strip @, separators, discriminator, lowercase."""
    h = re.sub(r"^@+", "", handle)
    h = re.sub(r"[_\-. ]+", "", h)
    h = re.sub(r"#\d+$", "", h)
    return h.lower().strip()


def _find_owner_by_handle(
    world: GroundTruthWorld, platform: str, handle: str
) -> WorldEntity | None:
    """Find a world entity by platform handle."""
    n = normalize_handle(handle)
    for e in world.entities:
        if e.platform == platform and normalize_handle(e.platform_handle) == n:
            return e
    return None


def _is_suspicious(messages: list[Message]) -> bool:
    """Check if messages contain social-engineering patterns."""
    pat = re.compile(
        r"give me access|update my permissions|i'?m.*(?:new )?admin|"
        r"backup account|locked out|delete.*records|everyone'?s contact",
        re.IGNORECASE,
    )
    return any(pat.search(m.text) for m in messages)


def _classify_relationship(
    all_text: str,
) -> tuple[str | None, str]:
    """Classify a relationship type from combined message text."""
    if re.search(
        r"friend|buddy|pal|climbing|travel|weekend.*\?|game tonight",
        all_text,
        re.IGNORECASE,
    ):
        return "friend", "positive"
    if re.search(
        r"work together|colleague|project|roadmap|hackathon|pm\b|"
        r"dashboard|role|telegram|more active on",
        all_text,
        re.IGNORECASE,
    ):
        return "colleague", "positive"
    if re.search(
        r"welcome|just (?:found|joined)|nice|check.*out|migration|"
        r"demo|count me in|registrations",
        all_text,
        re.IGNORECASE,
    ):
        return "community", "positive"
    return None, "neutral"


def _score_signals(
    signals: list[dict[str, float | str]],
) -> float:
    """Score a set of resolution signals (same logic as TS)."""
    if not signals:
        return 0.0
    by_type: dict[str, list[dict[str, float | str]]] = {}
    for s in signals:
        t = str(s["type"])
        by_type.setdefault(t, []).append(s)

    total = 0.0
    for sig_type, sigs in by_type.items():
        w = SIGNAL_WEIGHTS.get(sig_type, 0.1)
        sorted_sigs = sorted(sigs, key=lambda x: float(x["weight"]), reverse=True)
        ts = float(sorted_sigs[0]["weight"]) * w
        for i in range(1, len(sorted_sigs)):
            ts += float(sorted_sigs[i]["weight"]) * w * (0.3 ** i)
        total += ts
    return max(0.0, min(1.0, total))


# ── Handler ───────────────────────────────────────


class RolodexHandler:
    """Algorithmic (regex + heuristic) handler."""

    name: str = "Rolodex (Algorithmic)"

    async def setup(self) -> None:
        pass

    async def teardown(self) -> None:
        pass

    async def extract(
        self, conv: Conversation, world: GroundTruthWorld
    ) -> Extraction:
        start = time.perf_counter()
        traces: list[str] = []

        # ── Identity extraction ──────────────
        identities: list[IdentityExtraction] = []

        for msg in conv.messages:
            # GitHub: github.com/username
            for m in re.finditer(r"github\.com/(\w+)", msg.text, re.IGNORECASE):
                user = m.group(1)
                identities.append(IdentityExtraction(
                    entity_id=msg.from_entity,
                    platform="github",
                    handle=user,
                ))
                traces.append(f"[ID] {msg.display_name}: github '{user}'")

            # Twitter self-report: "im @X on twitter", "my twitter is @X",
            #   "more active on twitter ... @X"
            for m in re.finditer(
                r"(?:im|my twitter is|find me (?:at|on twitter)|"
                r"more active on twitter.*?)\s+(@\w+)",
                msg.text,
                re.IGNORECASE,
            ):
                handle = m.group(1)
                identities.append(IdentityExtraction(
                    entity_id=msg.from_entity,
                    platform="twitter",
                    handle=handle,
                ))
                traces.append(
                    f"[ID] {msg.display_name}: self-reported twitter '{handle}'"
                )

            # Twitter: "twitter is @X"
            for m in re.finditer(r"twitter is\s+(@\w+)", msg.text, re.IGNORECASE):
                handle = m.group(1)
                identities.append(IdentityExtraction(
                    entity_id=msg.from_entity,
                    platform="twitter",
                    handle=handle,
                ))
                traces.append(
                    f"[ID] {msg.display_name}: 'twitter is' pattern '{handle}'"
                )

            # Twitter third-party: "she's @X on twitter"
            for m in re.finditer(
                r"(?:she|he|they)?'?s?\s+(@\w+)\s+on twitter",
                msg.text,
                re.IGNORECASE,
            ):
                handle = m.group(1)
                owner = _find_owner_by_handle(world, "twitter", handle)
                if owner and owner.id != msg.from_entity:
                    identities.append(IdentityExtraction(
                        entity_id=owner.id,
                        platform="twitter",
                        handle=handle,
                    ))
                    traces.append(
                        f"[ID] {msg.display_name}: third-party twitter "
                        f"'{handle}' -> {owner.id}"
                    )

            # Twitter: "Are you @X on twitter?" + confirmation
            for m in re.finditer(
                r"are you (?:the )?(@\w+) on twitter",
                msg.text,
                re.IGNORECASE,
            ):
                handle = m.group(1)
                confirmer = next(
                    (
                        m2
                        for m2 in conv.messages
                        if m2.from_entity != msg.from_entity
                        and re.search(
                            r"(?:ya|yep|yeah|yes)\s+that'?s?\s+me",
                            m2.text,
                            re.IGNORECASE,
                        )
                    ),
                    None,
                )
                if confirmer:
                    identities.append(IdentityExtraction(
                        entity_id=confirmer.from_entity,
                        platform="twitter",
                        handle=handle,
                    ))
                    traces.append(
                        f"[ID] {msg.display_name} asked, "
                        f"{confirmer.display_name} confirmed twitter '{handle}'"
                    )

            # Telegram: "@handle over there" or "@handle on telegram"
            for m in re.finditer(
                r"(@\w+)\s+(?:over )?(?:there|on telegram)",
                msg.text,
                re.IGNORECASE,
            ):
                handle = m.group(1)
                identities.append(IdentityExtraction(
                    entity_id=msg.from_entity,
                    platform="telegram",
                    handle=handle,
                ))
                traces.append(
                    f"[ID] {msg.display_name}: telegram '{handle}'"
                )

        # Deduplicate
        seen: set[str] = set()
        unique_ids: list[IdentityExtraction] = []
        for i in identities:
            k = f"{i.entity_id}:{i.platform}:{normalize_handle(i.handle)}"
            if k not in seen:
                seen.add(k)
                unique_ids.append(i)

        # ── Relationship detection ───────────
        relationships: list[RelationshipExtraction] = []
        senders = list(dict.fromkeys(m.from_entity for m in conv.messages))

        for i in range(len(senders)):
            for j in range(i + 1, len(senders)):
                a, b = senders[i], senders[j]

                msgs_a = [m for m in conv.messages if m.from_entity == a]
                msgs_b = [m for m in conv.messages if m.from_entity == b]

                if _is_suspicious(msgs_a) or _is_suspicious(msgs_b):
                    traces.append(f"[REL] Skip {a}<->{b}: suspicious participant")
                    continue

                all_text = " ".join(
                    m.text
                    for m in conv.messages
                    if m.from_entity in (a, b)
                ).lower()

                rel_type, sentiment = _classify_relationship(all_text)
                if rel_type:
                    relationships.append(RelationshipExtraction(
                        entity_a=a, entity_b=b, type=rel_type, sentiment=sentiment,
                    ))
                    traces.append(f"[REL] {a}<->{b}: {rel_type} ({sentiment})")
                else:
                    traces.append(f"[REL] {a}<->{b}: no signal")

        # ── Trust detection ──────────────────
        trust_signals: list[TrustSignalExtraction] = []
        suspicious_entities: set[str] = set()
        for msg in conv.messages:
            if _is_suspicious([msg]):
                suspicious_entities.add(msg.from_entity)
        for eid in suspicious_entities:
            trust_signals.append(TrustSignalExtraction(
                entity_id=eid, signal="suspicious",
            ))
            traces.append(f"[TRUST] {eid}: suspicious")

        elapsed = (time.perf_counter() - start) * 1000
        return Extraction(
            conversation_id=conv.id,
            identities=unique_ids,
            relationships=relationships,
            trust_signals=trust_signals,
            traces=traces,
            wall_time_ms=elapsed,
        )

    async def resolve(
        self,
        extractions: list[Extraction],
        world: GroundTruthWorld,
    ) -> Resolution:
        start = time.perf_counter()
        traces: list[str] = []

        # Collect extracted identities per entity
        entity_extracted: dict[str, list[dict[str, str]]] = {}
        for ext in extractions:
            for ident in ext.identities:
                arr = entity_extracted.setdefault(ident.entity_id, [])
                if not any(
                    x["platform"] == ident.platform
                    and normalize_handle(x["handle"]) == normalize_handle(ident.handle)
                    for x in arr
                ):
                    arr.append({"platform": ident.platform, "handle": ident.handle})

        traces.append(f"Entities with extracted identities: {len(entity_extracted)}")
        for eid, ids in entity_extracted.items():
            ids_str = ", ".join(f"{i['platform']}:{i['handle']}" for i in ids)
            traces.append(f"  {eid}: {ids_str}")

        # Build platform handle index
        platform_index: dict[str, str] = {}
        for entity in world.entities:
            key = f"{entity.platform}:{normalize_handle(entity.platform_handle)}"
            platform_index[key] = entity.id

        traces.append(f"Platform handle index: {len(platform_index)} entries")

        # Compare extracted identities against world entity platform handles
        links: list[ResolutionLink] = []
        proposed_pairs: set[str] = set()

        for entity_id, extracted in entity_extracted.items():
            for ext in extracted:
                key = f"{ext['platform']}:{normalize_handle(ext['handle'])}"
                matched_entity_id = platform_index.get(key)

                if matched_entity_id and matched_entity_id != entity_id:
                    pair_key = ":".join(sorted([entity_id, matched_entity_id]))
                    if pair_key in proposed_pairs:
                        continue
                    proposed_pairs.add(pair_key)

                    signals = [
                        {
                            "type": "self_identification",
                            "weight": 0.95,
                            "evidence": (
                                f"{entity_id} extracted "
                                f"{ext['platform']}:{ext['handle']} which "
                                f"matches {matched_entity_id}'s platform handle"
                            ),
                        }
                    ]
                    score = _score_signals(signals)
                    traces.append(
                        f"Pair {entity_id} <-> {matched_entity_id}: "
                        f"score={score:.3f} via {ext['platform']}:{ext['handle']}"
                    )

                    if score >= RESOLUTION_THRESHOLD_PROPOSE:
                        links.append(ResolutionLink(
                            entity_a=entity_id,
                            entity_b=matched_entity_id,
                            confidence=score,
                            signals=[f"[{s['type']}] {s['evidence']}" for s in signals],
                        ))
                        traces.append("  -> PROPOSED LINK")

        # Compare extracted handles across entities (shared handle = same person)
        entity_ids = list(entity_extracted.keys())
        for i in range(len(entity_ids)):
            for j in range(i + 1, len(entity_ids)):
                a, b = entity_ids[i], entity_ids[j]
                pair_key = ":".join(sorted([a, b]))
                if pair_key in proposed_pairs:
                    continue

                ids_a = entity_extracted.get(a, [])
                ids_b = entity_extracted.get(b, [])
                signals: list[dict[str, float | str]] = []

                for id_a in ids_a:
                    for id_b in ids_b:
                        if (
                            id_a["platform"] == id_b["platform"]
                            and normalize_handle(id_a["handle"])
                            == normalize_handle(id_b["handle"])
                        ):
                            signals.append({
                                "type": "self_identification",
                                "weight": 0.95,
                                "evidence": (
                                    f"Both {a} and {b} have extracted "
                                    f"{id_a['platform']}:{id_a['handle']}"
                                ),
                            })

                if signals:
                    score = _score_signals(signals)
                    traces.append(
                        f"Pair {a} <-> {b}: score={score:.3f} "
                        f"via shared extracted handles"
                    )
                    if score >= RESOLUTION_THRESHOLD_PROPOSE:
                        proposed_pairs.add(pair_key)
                        links.append(ResolutionLink(
                            entity_a=a,
                            entity_b=b,
                            confidence=score,
                            signals=[
                                f"[{s['type']}] {s['evidence']}" for s in signals
                            ],
                        ))
                        traces.append("  -> PROPOSED LINK")
                    else:
                        traces.append("  -> Below threshold")

        elapsed = (time.perf_counter() - start) * 1000
        return Resolution(links=links, traces=traces, wall_time_ms=elapsed)


rolodex_handler = RolodexHandler()
