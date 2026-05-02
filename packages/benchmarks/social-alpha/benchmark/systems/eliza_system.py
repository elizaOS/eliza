"""
ElizaSystem — Benchmark system that routes through a real ElizaOS AgentRuntime.

Instead of standalone Python logic, this system:
  1. Creates an AgentRuntime with a social-alpha Character
  2. Registers the social-alpha benchmark plugin (actions + provider + model handler)
  3. Implements SocialAlphaSystem by sending messages through handle_message()
  4. Extracts structured results from action outputs

For extraction: sends the message to the agent, which uses the
EXTRACT_RECOMMENDATION action (backed by an LLM call through the runtime).

For process_call / update_price / get_trust_score / get_leaderboard / is_scam:
these operate on the plugin's shared in-process state, which is the same state
the agent's actions mutate.  This keeps the benchmark harness's synchronous
protocol working while still routing LLM calls through the Eliza runtime.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
import uuid
from pathlib import Path

from ..protocol import ExtractionResult, SocialAlphaSystem, UserTrustScore


class ElizaSystem(SocialAlphaSystem):
    """
    Production system backed by an ElizaOS AgentRuntime.

    Uses the social-alpha benchmark plugin for LLM extraction and the shared
    plugin state for trust scoring / leaderboard / scam detection.
    """

    def __init__(
        self,
        cache_dir: str | Path = ".benchmark_cache",
        model: str = "gpt-4o-mini",
    ) -> None:
        self._model = model
        self._cache_dir = Path(cache_dir)
        self._cache_dir.mkdir(parents=True, exist_ok=True)

        # Extraction cache (same format as FullSystem for interoperability)
        self._cache: dict[str, dict[str, str | bool]] = {}
        self._cache_file = self._cache_dir / "eliza_extraction_cache.json"
        self._load_cache()

        self._runtime_initialized = False
        self._runtime: object | None = None  # lazily created AgentRuntime
        self._loop: asyncio.AbstractEventLoop | None = None

        self._extract_calls = 0
        self._cache_hits = 0
        self._api_calls = 0
        self._start_time = time.time()

    # ------------------------------------------------------------------
    # Cache
    # ------------------------------------------------------------------

    def _load_cache(self) -> None:
        if self._cache_file.exists():
            with open(self._cache_file) as f:
                self._cache = json.load(f)

    def _save_cache(self) -> None:
        with open(self._cache_file, "w") as f:
            json.dump(self._cache, f)

    def _cache_key(self, text: str) -> str:
        return hashlib.sha256(text.encode()).hexdigest()[:16]

    # ------------------------------------------------------------------
    # Runtime lifecycle
    # ------------------------------------------------------------------

    def _ensure_runtime(self) -> None:
        """Lazily create and initialise the AgentRuntime."""
        if self._runtime_initialized:
            return

        from elizaos.runtime import AgentRuntime
        from elizaos.types.agent import Character
        from elizaos.prompts import MESSAGE_HANDLER_TEMPLATE

        # Re-use the InMemoryBenchmarkAdapter from the GAIA benchmark
        # (it lives in the sibling gaia package; import from there)
        try:
            from elizaos_gaia.inmemory_adapter import InMemoryBenchmarkAdapter
        except ImportError:
            # Fallback: define a minimal adapter inline
            InMemoryBenchmarkAdapter = _build_minimal_adapter()  # type: ignore[assignment,misc]

        from ..plugin import social_alpha_benchmark_plugin

        system = (
            "You are a crypto trading signal extraction agent.\n"
            "Your ONLY job is to analyse messages and extract structured trading signals.\n"
            "When the EXTRACT_RECOMMENDATION action is invoked, return its JSON result.\n"
            "Do NOT chit-chat. Do NOT ask questions. Do NOT add commentary."
        )

        benchmark_instructions = (
            "\n\nSOCIAL ALPHA BENCHMARK RULES:\n"
            "- Always select EXTRACT_RECOMMENDATION when given a chat message to analyse.\n"
            "- Your <text> should contain the JSON output from the action.\n"
        )

        message_handler_template = MESSAGE_HANDLER_TEMPLATE.replace(
            "</instructions>",
            benchmark_instructions + "\n</instructions>",
        )

        character = Character(
            name="SocialAlphaAgent",
            bio="A crypto social intelligence agent that analyses trading recommendations",
            system=system,
            templates={"messageHandlerTemplate": message_handler_template},
        )

        adapter = InMemoryBenchmarkAdapter()

        self._runtime = AgentRuntime(
            character=character,
            adapter=adapter,
            plugins=[social_alpha_benchmark_plugin],
            disable_basic_capabilities=False,
            enable_extended_capabilities=False,
            enable_autonomy=False,
            log_level="ERROR",
        )

        # Configure model
        runtime = self._runtime
        runtime.set_setting("OPENAI_API_KEY", os.environ.get("OPENAI_API_KEY", ""))
        runtime.set_setting("OPENAI_BASE_URL", os.environ.get("OPENAI_BASE_URL", ""))
        runtime.set_setting("OPENAI_LARGE_MODEL", self._model)

        # Run async init
        self._loop = asyncio.new_event_loop()
        self._loop.run_until_complete(runtime.initialize())
        self._runtime_initialized = True

    def _run_async(self, coro):  # noqa: ANN001, ANN201
        """Run an async coroutine in our dedicated event loop."""
        if self._loop is None:
            self._loop = asyncio.new_event_loop()
        return self._loop.run_until_complete(coro)

    # ------------------------------------------------------------------
    # SocialAlphaSystem protocol
    # ------------------------------------------------------------------

    def extract_recommendation(self, message_text: str) -> ExtractionResult:
        self._extract_calls += 1

        # Check cache
        key = self._cache_key(message_text)
        if key in self._cache:
            self._cache_hits += 1
            return self._parse_cached(self._cache[key])

        # Route through Eliza runtime
        self._ensure_runtime()
        result = self._run_async(self._extract_via_runtime(message_text))
        self._api_calls += 1

        # Cache
        cache_entry: dict[str, str | bool] = {
            "is_recommendation": result.is_recommendation,
            "recommendation_type": result.recommendation_type,
            "conviction": result.conviction,
            "token_mentioned": result.token_mentioned,
        }
        self._cache[key] = cache_entry

        # Periodic save
        if self._api_calls % 100 == 0:
            self._save_cache()
            elapsed = time.time() - self._start_time
            rate = self._api_calls / max(elapsed, 1)
            print(
                f"  [ElizaSystem] {self._extract_calls:,} extractions | "
                f"{self._api_calls} API | {self._cache_hits} cache | "
                f"{rate:.1f}/sec",
                flush=True,
            )

        return result

    async def _extract_via_runtime(self, message_text: str) -> ExtractionResult:
        """Send a message through the Eliza runtime and parse the extraction."""
        from elizaos.types.memory import Memory
        from elizaos.types.primitives import Content, as_uuid, string_to_uuid

        runtime = self._runtime
        if runtime is None:
            raise RuntimeError("runtime not initialised")

        room_id = string_to_uuid("social-alpha-benchmark")
        user_id = string_to_uuid("benchmark-user")
        message_id = as_uuid(str(uuid.uuid4()))

        message = Memory(
            id=message_id,
            entity_id=user_id,
            agent_id=runtime.agent_id,
            room_id=room_id,
            content=Content(text=message_text[:500]),
            created_at=int(time.time() * 1000),
        )

        emitted_texts: list[str] = []

        async def capture_callback(content: Content) -> list[Memory]:
            if content.text:
                emitted_texts.append(str(content.text))
            return []

        result = await runtime.message_service.handle_message(
            runtime, message, capture_callback,
        )

        # Try to extract from action results first
        action_results = runtime.get_action_results(message_id)
        for ar in action_results:
            if ar.data and isinstance(ar.data, dict):
                action_name = ar.data.get("actionName")
                if action_name == "EXTRACT_RECOMMENDATION":
                    return self._parse_action_result(ar.data)

        # Fallback: parse the emitted text or response
        response_text = ""
        if emitted_texts:
            response_text = emitted_texts[-1]
        elif result.response_content and result.response_content.text:
            response_text = str(result.response_content.text)

        return self._parse_response_text(response_text)

    def _parse_action_result(self, data: dict[str, str | bool | int | float]) -> ExtractionResult:
        rec_type = str(data.get("recommendation_type", "NOISE"))
        if rec_type not in ("BUY", "SELL", "NOISE"):
            rec_type = "NOISE"
        conv = str(data.get("conviction", "NONE"))
        if conv not in ("HIGH", "MEDIUM", "LOW", "NONE"):
            conv = "NONE"
        is_rec = bool(data.get("is_recommendation", False)) and rec_type != "NOISE"
        return ExtractionResult(
            is_recommendation=is_rec,
            recommendation_type=rec_type,
            conviction=conv,
            token_mentioned=str(data.get("token_mentioned", "")),
            token_address="",
        )

    def _parse_response_text(self, text: str) -> ExtractionResult:
        """Attempt to parse JSON from the agent's text response."""
        from ..plugin import _parse_extraction_json

        parsed = _parse_extraction_json(text)
        rec_type = str(parsed.get("recommendation_type", "NOISE"))
        conv = str(parsed.get("conviction", "NONE"))
        is_rec = bool(parsed.get("is_recommendation", False))
        return ExtractionResult(
            is_recommendation=is_rec,
            recommendation_type=rec_type,
            conviction=conv,
            token_mentioned=str(parsed.get("token_mentioned", "")),
            token_address="",
        )

    def _parse_cached(self, entry: dict[str, str | bool]) -> ExtractionResult:
        rec_type = str(entry.get("recommendation_type", "NOISE"))
        if rec_type not in ("BUY", "SELL", "NOISE"):
            rec_type = "NOISE"
        conv = str(entry.get("conviction", "NONE"))
        if conv not in ("HIGH", "MEDIUM", "LOW", "NONE"):
            conv = "NONE"
        is_rec = bool(entry.get("is_recommendation", False)) and rec_type != "NOISE"
        return ExtractionResult(
            is_recommendation=is_rec,
            recommendation_type=rec_type,
            conviction=conv,
            token_mentioned=str(entry.get("token_mentioned", "")),
            token_address="",
        )

    def process_call(
        self,
        user_id: str,
        token_address: str,
        recommendation_type: str,
        conviction: str,
        price_at_call: float,
        timestamp: int,
    ) -> None:
        from ..plugin import _add_call, _token_initial_prices

        _add_call(user_id, token_address, recommendation_type, conviction, price_at_call, timestamp)
        if token_address not in _token_initial_prices:
            _token_initial_prices[token_address] = price_at_call

    def update_price(self, token_address: str, price: float, timestamp: int) -> None:
        from ..plugin import _update_token_price

        _update_token_price(token_address, price)

    def get_user_trust_score(self, user_id: str) -> UserTrustScore | None:
        from ..plugin import _user_calls, _compute_trust_score, _compute_user_metrics, _classify_archetype

        if user_id not in _user_calls:
            return None

        trust = _compute_trust_score(user_id)
        metrics = _compute_user_metrics(user_id)
        archetype = _classify_archetype(user_id)

        return UserTrustScore(
            user_id=user_id,
            trust_score=trust,
            win_rate=float(metrics["win_rate"]),
            total_calls=len(_user_calls[user_id]),
            archetype=archetype,
        )

    def get_leaderboard(self, top_k: int = 50) -> list[UserTrustScore]:
        from ..plugin import _user_calls

        scores: list[UserTrustScore] = []
        for uid in _user_calls:
            score = self.get_user_trust_score(uid)
            if score is not None:
                scores.append(score)
        scores.sort(key=lambda s: s.trust_score, reverse=True)
        return scores[:top_k]

    def is_scam_token(self, token_address: str) -> bool:
        from ..plugin import _token_initial_prices, _token_worst_prices

        initial = _token_initial_prices.get(token_address)
        worst = _token_worst_prices.get(token_address)
        if initial is None or worst is None or initial <= 0:
            return False
        drop = ((worst - initial) / initial) * 100
        return drop <= -80

    def reset(self) -> None:
        from ..plugin import reset_plugin_state

        reset_plugin_state()

    # ------------------------------------------------------------------
    # Cache warming (parallel batch processing)
    # ------------------------------------------------------------------

    def warm_cache(self, messages: list[str]) -> None:
        """Pre-populate cache using batched LLM calls through the runtime.

        For messages not already cached, sends them through the Eliza runtime
        in serial (the runtime itself will batch via the model handler).
        """
        uncached = [m for m in messages if self._cache_key(m) not in self._cache]
        if not uncached:
            print(f"  [ElizaSystem] Cache already warm ({len(self._cache)} entries)")
            return

        print(
            f"  [ElizaSystem] Warming cache: {len(uncached):,} messages "
            f"({len(self._cache)} already cached)",
            flush=True,
        )

        self._ensure_runtime()

        for i, msg in enumerate(uncached):
            key = self._cache_key(msg)
            if key in self._cache:
                continue

            result = self._run_async(self._extract_via_runtime(msg))
            self._api_calls += 1

            cache_entry: dict[str, str | bool] = {
                "is_recommendation": result.is_recommendation,
                "recommendation_type": result.recommendation_type,
                "conviction": result.conviction,
                "token_mentioned": result.token_mentioned,
            }
            self._cache[key] = cache_entry

            if (i + 1) % 100 == 0:
                self._save_cache()
                elapsed = time.time() - self._start_time
                rate = (i + 1) / max(elapsed, 1)
                remaining = (len(uncached) - i - 1) / max(rate, 0.1) / 60
                print(
                    f"  [ElizaSystem] Cache warm: {i + 1:,}/{len(uncached):,} "
                    f"({rate:.1f} msg/sec, ~{remaining:.0f}m remaining)",
                    flush=True,
                )

        self._save_cache()
        print(
            f"  [ElizaSystem] Cache warm complete: {len(self._cache)} total entries",
            flush=True,
        )

    def finalize(self) -> None:
        """Save cache and print final stats."""
        self._save_cache()
        pct = self._cache_hits / max(self._extract_calls, 1) * 100
        print(
            f"\n  [ElizaSystem] Final stats: {self._extract_calls} extractions, "
            f"{self._cache_hits} cache hits ({pct:.0f}%), "
            f"{self._api_calls} API calls, {len(self._cache)} cached total",
        )


# ---------------------------------------------------------------------------
# Minimal adapter fallback (if GAIA benchmark not installed)
# ---------------------------------------------------------------------------


def _build_minimal_adapter() -> type:
    """Build a minimal in-memory adapter class for when GAIA is not available."""
    import time as _time
    import uuid as _uuid
    from elizaos.types.memory import Memory, MessageMetadata, MemoryType
    from elizaos.types.primitives import UUID, as_uuid

    class _MinimalAdapter:
        def __init__(self) -> None:
            self._ready = False
            self._memories: dict[str, tuple[Memory, str]] = {}

        @property
        def db(self) -> "_MinimalAdapter":
            return self

        async def initialize(self) -> None:
            await self.init()

        async def init(self) -> None:
            self._ready = True

        async def is_ready(self) -> bool:
            return self._ready

        async def close(self) -> None:
            self._memories.clear()
            self._ready = False

        async def get_connection(self) -> "_MinimalAdapter":
            return self

        async def ensure_embedding_dimension(self, _dimension: int) -> None:
            return None

        async def create_memory(self, memory: Memory, table_name: str, unique: bool = False) -> UUID:
            if memory.id is None:
                memory.id = as_uuid(str(_uuid.uuid4()))
            if memory.created_at is None:
                memory.created_at = int(_time.time() * 1000)
            if memory.metadata is None:
                memory.metadata = MessageMetadata(type=MemoryType.MESSAGE)
            memory.unique = bool(unique) if unique is not None else False
            self._memories[str(memory.id)] = (memory, table_name)
            return memory.id

        async def update_memory(self, memory: Memory) -> bool:
            if memory.id is None:
                return False
            key = str(memory.id)
            if key not in self._memories:
                return False
            _, tn = self._memories[key]
            self._memories[key] = (memory, tn)
            return True

        async def get_memory_by_id(self, id_: UUID) -> Memory | None:
            pair = self._memories.get(str(id_))
            return pair[0] if pair else None

        async def get_memories(self, params: dict[str, object]) -> list[Memory]:
            room_id = params.get("room_id")
            limit = params.get("limit")
            order_dir = params.get("orderDirection")
            table_name = params.get("tableName")
            items = list(self._memories.values())
            if isinstance(table_name, str) and table_name:
                items = [(m, tn) for m, tn in items if tn == table_name]
            if isinstance(room_id, str) and room_id:
                items = [(m, tn) for m, tn in items if str(m.room_id) == room_id]
            reverse = True
            if isinstance(order_dir, str) and order_dir.lower() == "asc":
                reverse = False
            items.sort(key=lambda x: int(x[0].created_at or 0), reverse=reverse)
            if isinstance(limit, int) and limit > 0:
                items = items[:limit]
            return [m for m, _ in items]

        async def get_memories_by_ids(self, ids: list[UUID], _tn: str | None = None) -> list[Memory]:
            result: list[Memory] = []
            for id_ in ids:
                mem = await self.get_memory_by_id(id_)
                if mem is not None:
                    result.append(mem)
            return result

        async def delete_memory(self, memory_id: UUID) -> None:
            self._memories.pop(str(memory_id), None)

        async def delete_many_memories(self, memory_ids: list[UUID]) -> None:
            for mid in memory_ids:
                self._memories.pop(str(mid), None)

        async def delete_all_memories(self, room_id: UUID, table_name: str) -> None:
            to_del = [k for k, (m, tn) in self._memories.items()
                      if str(m.room_id) == str(room_id) and tn == table_name]
            for k in to_del:
                self._memories.pop(k, None)

        async def count_memories(self, room_id: UUID, unique: bool = False, table_name: str | None = None) -> int:
            return sum(
                1 for m, tn in self._memories.values()
                if str(m.room_id) == str(room_id)
                and (table_name is None or tn == table_name)
            )

        async def get_entities_by_ids(self, _ids: list[UUID]) -> list[object] | None:
            return None

        async def get_entities_for_room(self, _rid: UUID, _inc: bool = False) -> list[object]:
            return []

        async def create_entities(self, _entities: list[object]) -> bool:
            return True

        async def update_entity(self, _entity: object) -> None:
            return None

        async def get_rooms_by_ids(self, _rids: list[UUID]) -> list[object] | None:
            return None

        async def create_rooms(self, _rooms: list[object]) -> list[UUID]:
            return []

        async def get_rooms_by_world(self, _wid: UUID) -> list[object]:
            return []

        async def create_world(self, _world: object) -> UUID:
            return as_uuid(str(_uuid.uuid4()))

        async def get_world(self, _id: UUID) -> object | None:
            return None

        async def add_participants_room(self, _eids: list[UUID], _rid: UUID) -> bool:
            return True

        async def is_room_participant(self, _rid: UUID, _eid: UUID) -> bool:
            return False

    return _MinimalAdapter
