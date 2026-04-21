"""Eliza Handler — LLM-based extraction via a real AgentRuntime.

This handler creates a real Eliza AgentRuntime with:
  - The plugin-rolodex (evaluator, services)
  - The plugin-openai (model handlers for LLM calls)

For each conversation, it:
  1. Creates entities & a room
  2. Stores messages as memories
  3. Invokes the relationship extraction evaluator on the last message
  4. Maps the LLM extraction back to the benchmark Extraction format

Resolution uses the same signal-based approach as the rolodex handler
but operates on LLM-extracted data instead of regex-extracted data.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Protocol

from ..types import (
    Conversation,
    Extraction,
    GroundTruthWorld,
    IdentityExtraction,
    RelationshipExtraction,
    Resolution,
    ResolutionLink,
    TrustSignalExtraction,
)

logger = logging.getLogger(__name__)

# ── Constants (same as rolodex handler) ───────────

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


def _normalize_handle(handle: str) -> str:
    h = re.sub(r"^@+", "", handle)
    h = re.sub(r"[_\-. ]+", "", h)
    h = re.sub(r"#\d+$", "", h)
    return h.lower().strip()


def _score_signals(signals: list[dict[str, float | str]]) -> float:
    if not signals:
        return 0.0
    by_type: dict[str, list[dict[str, float | str]]] = {}
    for s in signals:
        by_type.setdefault(str(s["type"]), []).append(s)
    total = 0.0
    for sig_type, sigs in by_type.items():
        w = SIGNAL_WEIGHTS.get(sig_type, 0.1)
        sorted_sigs = sorted(sigs, key=lambda x: float(x["weight"]), reverse=True)
        ts = float(sorted_sigs[0]["weight"]) * w
        for i in range(1, len(sorted_sigs)):
            ts += float(sorted_sigs[i]["weight"]) * w * (0.3 ** i)
        total += ts
    return max(0.0, min(1.0, total))


def _deterministic_uuid(seed: str) -> str:
    """Create a deterministic UUID-like string from a seed."""
    return hashlib.sha256(seed.encode()).hexdigest()[:32]


# ── Name resolution ──────────────────────────────


def _build_name_map(conv: Conversation) -> dict[str, str]:
    """Build display-name -> entity-ID map from a conversation."""
    name_map: dict[str, str] = {}
    for msg in conv.messages:
        name_map[msg.display_name.lower()] = msg.from_entity
    return name_map


def _resolve_name(name: str, name_map: dict[str, str]) -> str | None:
    """Resolve an LLM-produced name to a benchmark entity ID."""
    lower = name.lower().strip()
    # Exact match
    exact = name_map.get(lower)
    if exact:
        return exact
    # Partial match
    for display_name, entity_id in name_map.items():
        if display_name in lower or lower in display_name:
            return entity_id
    return None


# ── Minimal in-memory runtime stubs ──────────────


@dataclass
class _MemoryObj:
    """Minimal memory object for the evaluator."""

    id: str
    entity_id: str
    room_id: str
    content: dict[str, str]
    created_at: int = 0
    _bench_context: str = ""


@dataclass
class _EntityObj:
    """Minimal entity object."""

    id: str
    names: list[str] = field(default_factory=list)
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass
class _RoomObj:
    """Minimal room object."""

    id: str
    name: str = ""
    source: str = ""


class _BenchmarkRuntime:
    """Minimal runtime implementation that satisfies the evaluator's needs.

    This provides the ``use_model`` method that the evaluator calls, by
    delegating to the real model provider. Everything else (memories,
    entities, rooms) is stored in-memory.
    """

    def __init__(self) -> None:
        self.agent_id: str = _deterministic_uuid("bench-agent")
        self._memories: dict[str, list[_MemoryObj]] = {}
        self._entities: dict[str, _EntityObj] = {}
        self._rooms: dict[str, _RoomObj] = {}
        self._room_participants: dict[str, set[str]] = {}
        self._participant_cache: dict[str, list[_EntityObj]] = {}
        self._model_provider: object | None = None

    async def initialize(self) -> None:
        """Initialize the model provider."""
        try:
            # Try importing the openai model provider
            import openai  # noqa: F401

            self._model_provider = "openai"
        except ImportError:
            logger.warning(
                "openai package not available; Eliza handler will not "
                "work without a model provider"
            )

    def create_room(self, room: _RoomObj) -> None:
        self._rooms[room.id] = room

    def create_entity(self, entity: _EntityObj) -> None:
        self._entities[entity.id] = entity

    def add_participant(self, room_id: str, entity_id: str) -> None:
        self._room_participants.setdefault(room_id, set()).add(entity_id)
        # Update participant cache
        entities = []
        for eid in self._room_participants.get(room_id, set()):
            e = self._entities.get(eid)
            if e:
                entities.append(e)
        self._participant_cache[room_id] = entities

    def create_memory(self, memory: _MemoryObj) -> None:
        self._memories.setdefault(memory.room_id, []).append(memory)

    def get_memories(self, room_id: str, count: int = 15) -> list[_MemoryObj]:
        memories = self._memories.get(room_id, [])
        return memories[-count:]

    def get_entity_by_id(self, entity_id: str) -> _EntityObj | None:
        return self._entities.get(entity_id)

    def get_entities_for_room(self, room_id: str) -> list[_EntityObj]:
        return self._participant_cache.get(room_id, [])

    async def use_model(
        self,
        model_type: object,
        params: dict[str, object],
    ) -> dict[str, object] | None:
        """Call the LLM via OpenAI."""
        try:
            import openai

            prompt = str(params.get("prompt", ""))
            if not prompt:
                return None

            client = openai.AsyncOpenAI()
            model_name = os.getenv("OPENAI_LARGE_MODEL", "gpt-4o-mini")
            response = await client.chat.completions.create(
                model=model_name,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are an expert at analyzing conversations to "
                            "extract structured information. Return valid JSON only."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                response_format={"type": "json_object"},
                temperature=0.1,
            )

            import json

            content = response.choices[0].message.content
            if content:
                return json.loads(content)  # type: ignore[no-any-return]
            return None

        except Exception:
            logger.exception("[ElizaHandler] Model call failed")
            return None


# ── Handler ───────────────────────────────────────


class ElizaHandler:
    """LLM-based handler that uses a real model provider.

    Creates an in-memory runtime, sends messages through the
    relationship extraction evaluator, and collects results.
    """

    name: str = "Eliza (LLM)"

    def __init__(self) -> None:
        self._runtime: _BenchmarkRuntime | None = None

    async def setup(self) -> None:
        self._runtime = _BenchmarkRuntime()
        await self._runtime.initialize()

    async def teardown(self) -> None:
        self._runtime = None

    async def extract(
        self, conv: Conversation, world: GroundTruthWorld
    ) -> Extraction:
        if not self._runtime:
            raise RuntimeError("Eliza handler not initialized — call setup() first")

        start = time.perf_counter()
        traces: list[str] = []
        name_map = _build_name_map(conv)
        rt = self._runtime

        # 1. Create a room
        room_id = _deterministic_uuid(f"bench-room-{conv.id}")
        rt.create_room(_RoomObj(id=room_id, name=conv.name, source=conv.platform))

        # 2. Create entities
        participant_ids = list(dict.fromkeys(m.from_entity for m in conv.messages))
        for pid in participant_ids:
            display_name = next(
                (m.display_name for m in conv.messages if m.from_entity == pid),
                pid,
            )
            entity_id = _deterministic_uuid(f"bench-entity-{pid}")
            if not rt.get_entity_by_id(entity_id):
                rt.create_entity(_EntityObj(
                    id=entity_id, names=[display_name],
                ))
                traces.append(f"[SETUP] Created entity {display_name} ({pid})")
            rt.add_participant(room_id, entity_id)

        # Add agent as participant
        rt.add_participant(room_id, rt.agent_id)

        # 3. Store messages
        for i, msg in enumerate(conv.messages):
            entity_id = _deterministic_uuid(f"bench-entity-{msg.from_entity}")
            memory_id = _deterministic_uuid(f"bench-msg-{conv.id}-{i}")
            rt.create_memory(_MemoryObj(
                id=memory_id,
                entity_id=entity_id,
                room_id=room_id,
                content={"type": "text", "text": msg.text, "source": conv.platform},
                created_at=int(time.time() * 1000) - (len(conv.messages) - i) * 1000,
            ))

        # 4. Build context for the evaluator
        messages_text = "\n".join(
            f"[{m.display_name}]: {m.text}" for m in conv.messages
        )

        # 5. Call the evaluator directly
        from elizaos_plugin_rolodex.evaluator import (
            EXTRACTION_PROMPT,
            LLMExtractionOutput,
        )

        participants_str = "\n".join(
            f"- {m.display_name}"
            for m in conv.messages
            if m.from_entity in participant_ids
        )
        # Deduplicate participant lines
        seen_names: set[str] = set()
        deduped_lines: list[str] = []
        for line in participants_str.split("\n"):
            if line not in seen_names:
                seen_names.add(line)
                deduped_lines.append(line)
        participants_str = "\n".join(deduped_lines)

        prompt = EXTRACTION_PROMPT.format(
            participants=participants_str,
            recent_messages=messages_text,
        )

        raw_result = await rt.use_model(None, {"prompt": prompt})

        extraction: LLMExtractionOutput | None = None
        if raw_result and isinstance(raw_result, dict):
            try:
                extraction = LLMExtractionOutput.model_validate(raw_result)
                traces.append("[LLM] Evaluator returned: extraction data")
            except Exception as exc:
                traces.append(f"[LLM] Parse error: {exc}")
        else:
            traces.append("[LLM] Evaluator returned: no data")

        # 6. Map LLM extraction -> benchmark Extraction format
        identities: list[IdentityExtraction] = []
        relationships: list[RelationshipExtraction] = []
        trust_signals: list[TrustSignalExtraction] = []

        if extraction:
            # Identities
            for pi in extraction.platform_identities:
                if not pi.platform or not pi.handle or not pi.belongs_to:
                    continue
                entity_id = _resolve_name(pi.belongs_to, name_map)
                if entity_id:
                    identities.append(IdentityExtraction(
                        entity_id=entity_id,
                        platform=pi.platform.lower(),
                        handle=pi.handle,
                    ))
                    traces.append(
                        f"[MAP] Identity: {pi.belongs_to} -> {entity_id} "
                        f"[{pi.platform}:{pi.handle}]"
                    )
                else:
                    traces.append(
                        f"[MAP] Could not resolve name '{pi.belongs_to}' "
                        f"for identity {pi.platform}:{pi.handle}"
                    )

            # Relationships
            for rel in extraction.relationships:
                entity_a = _resolve_name(rel.person_a, name_map)
                entity_b = _resolve_name(rel.person_b, name_map)
                if entity_a and entity_b and entity_a != entity_b:
                    relationships.append(RelationshipExtraction(
                        entity_a=entity_a,
                        entity_b=entity_b,
                        type=rel.type or "community",
                        sentiment=rel.sentiment or "positive",
                    ))
                    traces.append(
                        f"[MAP] Relationship: {rel.person_a}({entity_a}) <-> "
                        f"{rel.person_b}({entity_b}) [{rel.type}]"
                    )

            # Trust signals
            for ts in extraction.trust_signals:
                if ts.signal in ("suspicious", "deceptive"):
                    entity_id = _resolve_name(ts.entity_name, name_map)
                    if entity_id:
                        trust_signals.append(TrustSignalExtraction(
                            entity_id=entity_id, signal="suspicious",
                        ))
                        traces.append(
                            f"[MAP] Trust: {ts.entity_name} -> "
                            f"{entity_id} [suspicious]"
                        )

        # Deduplicate identities
        seen_ids: set[str] = set()
        unique_identities: list[IdentityExtraction] = []
        for ident in identities:
            key = f"{ident.entity_id}:{ident.platform}:{_normalize_handle(ident.handle)}"
            if key not in seen_ids:
                seen_ids.add(key)
                unique_identities.append(ident)

        elapsed = (time.perf_counter() - start) * 1000
        return Extraction(
            conversation_id=conv.id,
            identities=unique_identities,
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
        """Resolution uses the same signal-based approach as the rolodex handler."""
        start = time.perf_counter()
        traces: list[str] = []

        # Collect extracted identities per entity
        entity_extracted: dict[str, list[dict[str, str]]] = {}
        for ext in extractions:
            for ident in ext.identities:
                arr = entity_extracted.setdefault(ident.entity_id, [])
                if not any(
                    x["platform"] == ident.platform
                    and _normalize_handle(x["handle"])
                    == _normalize_handle(ident.handle)
                    for x in arr
                ):
                    arr.append({"platform": ident.platform, "handle": ident.handle})

        traces.append(
            f"Entities with extracted identities: {len(entity_extracted)}"
        )
        for eid, ids in entity_extracted.items():
            ids_str = ", ".join(f"{i['platform']}:{i['handle']}" for i in ids)
            traces.append(f"  {eid}: {ids_str}")

        # Build platform handle index
        platform_index: dict[str, str] = {}
        for entity in world.entities:
            key = f"{entity.platform}:{_normalize_handle(entity.platform_handle)}"
            platform_index[key] = entity.id
        traces.append(f"Platform handle index: {len(platform_index)} entries")

        # Compare extracted identities against world entity platform handles
        links: list[ResolutionLink] = []
        proposed_pairs: set[str] = set()

        for entity_id, extracted in entity_extracted.items():
            for ext in extracted:
                key = f"{ext['platform']}:{_normalize_handle(ext['handle'])}"
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
                                f"{ext['platform']}:{ext['handle']} matching "
                                f"{matched_entity_id}'s platform handle"
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
                            signals=[
                                f"[{s['type']}] {s['evidence']}" for s in signals
                            ],
                        ))
                        traces.append("  -> PROPOSED LINK")

        # Compare extracted handles across entities
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
                            and _normalize_handle(id_a["handle"])
                            == _normalize_handle(id_b["handle"])
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


eliza_handler = ElizaHandler()
