"""
Knowledge Graph environment adapter for AgentBench.

This adapter provides a minimal, strongly-typed, in-memory knowledge graph for
development/testing. It is structured to be replaced with the official
AgentBench Freebase/KB backends when integrating full datasets.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from typing import TypedDict

from elizaos_agentbench.adapters.base import EnvironmentAdapter
from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentBenchTask,
    AgentRuntimeProtocol,
    EnvironmentConfig,
    JSONPrimitive,
    JSONValue,
    ObservationType,
)

logger = logging.getLogger(__name__)

StepInfoType = dict[str, str | int | float | bool | None]


class KGRelation(TypedDict):
    subject: str
    predicate: str
    object: str


KGEntity = dict[str, JSONPrimitive]


class ParsedQuery(TypedDict):
    type: str
    params: dict[str, JSONValue]


SAMPLE_ENTITIES: dict[str, KGEntity] = {
    "e001": {"name": "Albert Einstein", "type": "person", "birth_year": 1879, "death_year": 1955},
    "e002": {"name": "Germany", "type": "country", "continent": "Europe"},
    "e003": {"name": "United States", "type": "country", "continent": "North America"},
    "e004": {"name": "Physics", "type": "field"},
    "e005": {"name": "Nobel Prize in Physics", "type": "award"},
    "e006": {"name": "Theory of Relativity", "type": "theory"},
    "e007": {"name": "Marie Curie", "type": "person", "birth_year": 1867, "death_year": 1934},
    "e008": {"name": "Poland", "type": "country", "continent": "Europe"},
    "e009": {"name": "France", "type": "country", "continent": "Europe"},
    "e010": {"name": "Chemistry", "type": "field"},
    "e011": {"name": "Nobel Prize in Chemistry", "type": "award"},
    "e012": {"name": "Radioactivity", "type": "concept"},
}

SAMPLE_RELATIONS: list[KGRelation] = [
    {"subject": "e001", "predicate": "born_in", "object": "e002"},
    {"subject": "e001", "predicate": "worked_in", "object": "e003"},
    {"subject": "e001", "predicate": "field", "object": "e004"},
    {"subject": "e001", "predicate": "won", "object": "e005"},
    {"subject": "e001", "predicate": "developed", "object": "e006"},
    {"subject": "e007", "predicate": "born_in", "object": "e008"},
    {"subject": "e007", "predicate": "worked_in", "object": "e009"},
    {"subject": "e007", "predicate": "field", "object": "e004"},
    {"subject": "e007", "predicate": "field", "object": "e010"},
    {"subject": "e007", "predicate": "won", "object": "e005"},
    {"subject": "e007", "predicate": "won", "object": "e011"},
    {"subject": "e007", "predicate": "discovered", "object": "e012"},
]


class KnowledgeGraphAdapter(EnvironmentAdapter):
    """
    Adapter for Knowledge Graph environment.

    Tasks include SPARQL-like queries, entity relationship traversal, and reasoning.
    """

    environment = AgentBenchEnvironment.KNOWLEDGE_GRAPH

    def __init__(
        self,
        runtime: AgentRuntimeProtocol | None = None,
        config: EnvironmentConfig | None = None,
    ) -> None:
        super().__init__(runtime, config)
        self._entities: dict[str, KGEntity] = {}
        self._relations: list[KGRelation] = []
        self._query_history: list[str] = []
        self._max_results = 50

    async def initialize(self) -> None:
        if self._initialized:
            return
        self._entities = SAMPLE_ENTITIES.copy()
        self._relations = SAMPLE_RELATIONS.copy()
        self._initialized = True

    def _validate_entities(self, raw: object) -> dict[str, KGEntity]:
        if not isinstance(raw, dict):
            return {}
        entities: dict[str, KGEntity] = {}
        for entity_id, attrs in raw.items():
            if not isinstance(entity_id, str) or not entity_id:
                continue
            if not isinstance(attrs, dict):
                continue
            validated: KGEntity = {}
            for k, v in attrs.items():
                if isinstance(k, str) and isinstance(v, (str, int, float, bool, type(None))):
                    validated[k] = v
            if validated:
                entities[entity_id] = validated
        return entities

    def _validate_relations(self, raw: object) -> list[KGRelation]:
        if not isinstance(raw, list):
            return []
        relations: list[KGRelation] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            subject = item.get("subject")
            predicate = item.get("predicate")
            obj = item.get("object")
            if isinstance(subject, str) and isinstance(predicate, str) and isinstance(obj, str):
                relations.append({"subject": subject, "predicate": predicate, "object": obj})
        return relations

    async def reset(self, task: AgentBenchTask) -> ObservationType:
        self._query_history = []

        entities_raw = task.initial_state.get("entities")
        relations_raw = task.initial_state.get("relations")

        entities = self._validate_entities(entities_raw)
        relations = self._validate_relations(relations_raw)

        if entities:
            self._entities = entities
        if relations:
            self._relations = relations

        entity_types: set[str] = set()
        for e in self._entities.values():
            t = e.get("type")
            if isinstance(t, str) and t:
                entity_types.add(t)
            else:
                entity_types.add("unknown")

        relation_types = {r["predicate"] for r in self._relations}

        return {
            "entity_count": len(self._entities),
            "relation_count": len(self._relations),
            "entity_types": sorted(entity_types),
            "relation_types": sorted(relation_types),
            "task_description": task.description,
            "goal": task.goal,
            "message": "Knowledge graph loaded. Use queries to explore.",
        }

    async def step(self, action: str) -> tuple[ObservationType, float, bool, StepInfoType]:
        query = self._parse_query(action)
        query_type = query["type"]
        params = query["params"]
        self._query_history.append(action)

        reward = 0.0
        done = False

        if query_type == "get_entity":
            entity_id_val = params.get("id")
            entity_id_raw = entity_id_val if isinstance(entity_id_val, str) else ""
            entity_id = self._resolve_entity_id(entity_id_raw)
            entity = self._entities.get(entity_id)
            if entity is not None:
                reward = 0.1
                name = entity.get("name")
                name_str = name if isinstance(name, str) else entity_id
                observation: ObservationType = {
                    "query_type": "get_entity",
                    "entity_id": entity_id,
                    "result": entity,
                    "message": f"Found entity: {name_str}",
                }
            else:
                reward = -0.05
                observation = {
                    "query_type": "get_entity",
                    "error": f"Entity {entity_id} not found",
                    "message": "Entity not found",
                }

        elif query_type == "find_relations":
            subject_val = params.get("subject")
            predicate_val = params.get("predicate")
            object_val = params.get("object")

            subject_raw = subject_val if isinstance(subject_val, str) else ""
            predicate_raw = predicate_val if isinstance(predicate_val, str) else ""
            object_raw = object_val if isinstance(object_val, str) else ""

            subject = self._resolve_entity_id(subject_raw) if subject_raw else ""
            predicate_norm = self._normalize_predicate(predicate_raw) if predicate_raw else ""
            obj = self._resolve_entity_id(object_raw) if object_raw else ""

            predicate = predicate_norm if predicate_norm else None

            results: list[KGRelation] = []
            for rel in self._relations:
                match = True
                if subject and rel["subject"] != subject:
                    match = False
                if predicate and rel["predicate"].lower() != predicate:
                    match = False
                if obj and rel["object"] != obj:
                    match = False
                if match:
                    results.append(rel)

            reward = 0.1 if results else 0.0
            observation = {
                "query_type": "find_relations",
                "results": results[: self._max_results],
                "total": len(results),
                "message": f"Found {len(results)} relations",
            }

        elif query_type == "find_entities":
            entity_type_val = params.get("type")
            name_contains_val = params.get("name_contains", "")
            entity_type_raw = entity_type_val if isinstance(entity_type_val, str) else ""
            entity_type_norm = entity_type_raw.strip().lower()
            entity_type = entity_type_norm if entity_type_norm else None
            name_contains = name_contains_val.lower() if isinstance(name_contains_val, str) else ""

            results: list[dict[str, JSONValue]] = []
            for eid, entity in self._entities.items():
                match = True
                if entity_type:
                    etype_val = entity.get("type")
                    etype = etype_val.lower() if isinstance(etype_val, str) else ""
                    if not etype or etype != entity_type:
                        match = False
                if not match:
                    match = False
                name = entity.get("name")
                if name_contains and (not isinstance(name, str) or name_contains not in name.lower()):
                    match = False
                if match:
                    results.append({"id": eid, **entity})

            reward = 0.1 if results else 0.0
            observation = {
                "query_type": "find_entities",
                "results": results[: self._max_results],
                "total": len(results),
                "message": f"Found {len(results)} entities",
            }

        elif query_type == "traverse":
            start_val = params.get("start")
            path_val = params.get("path")

            start_raw = start_val if isinstance(start_val, str) else ""
            start = self._resolve_entity_id(start_raw)
            path = (
                [p for p in path_val if isinstance(p, str)] if isinstance(path_val, list) else []
            )
            path = [self._normalize_predicate(p) for p in path if p]

            if not start or not path:
                observation = {
                    "error": "Traverse requires start entity and path",
                    "message": "Invalid traverse query",
                }
                reward = -0.05
            else:
                current = [start]
                for predicate in path:
                    next_entities: list[str] = []
                    for eid in current:
                        for rel in self._relations:
                            if rel["subject"] == eid and rel["predicate"] == predicate:
                                next_entities.append(rel["object"])
                            elif rel["object"] == eid and rel["predicate"] == predicate:
                                next_entities.append(rel["subject"])
                    current = list({x for x in next_entities})
                    if not current:
                        break

                results = [{"id": eid, **self._entities.get(eid, {})} for eid in current]
                reward = 0.15 if results else 0.0
                observation = {
                    "query_type": "traverse",
                    "start": start,
                    "path": path,
                    "results": results,
                    "message": f"Traversal found {len(results)} entities",
                }

        elif query_type == "answer":
            answer_val = params.get("answer", "")
            answer = answer_val if isinstance(answer_val, str) else ""
            observation = {"query_type": "answer", "answer": answer, "message": f"Answer submitted: {answer}"}
            reward = 0.0
            done = True

        elif query_type == "think":
            observation = {"query_type": "think", "message": "Thinking..."}
            reward = 0.0

        else:
            observation = {
                "error": f"Unknown query type: {query_type}",
                "message": "Invalid query. Try: get_entity[id], find_relations[subject=, predicate=, object=], find_entities[type=, name_contains=], traverse[start=, path=pred1|pred2], answer[text]",
            }
            reward = -0.1

        return observation, reward, done, {"query_type": query_type, "params": str(params)}

    def _strip_quotes(self, value: str) -> str:
        """
        Strip a single layer of surrounding quotes from a parameter value.

        This makes parsing more robust to model outputs like:
        - type='person'
        - name_contains="Albert Einstein"
        """
        v = value.strip()
        if v.lower() in {"none", "null"}:
            return ""
        if len(v) >= 2 and v[0] == v[-1] and v[0] in {"'", '"'}:
            return v[1:-1].strip()
        return v

    def _resolve_entity_id(self, value: str) -> str:
        """
        Resolve either an entity id (e.g. e001) or an entity name (e.g. "Albert Einstein")
        to a canonical entity id, if possible.
        """
        v = value.strip()
        if not v:
            return ""
        if v in self._entities:
            return v
        v_l = v.lower()
        for eid, entity in self._entities.items():
            name_val = entity.get("name")
            name = name_val.lower() if isinstance(name_val, str) else ""
            if name and name == v_l:
                return eid
        return v

    def _normalize_predicate(self, value: str) -> str:
        """
        Normalize common predicate aliases produced by models.

        Our bundled sample graph uses `born_in`; many models produce `birthplace` / `place_of_birth`.
        """
        v = value.strip().lower().replace(" ", "_")
        aliases = {
            "birthplace": "born_in",
            "placeofbirth": "born_in",
            "place_of_birth": "born_in",
            "birth_place": "born_in",
            "born": "born_in",
        }
        return aliases.get(v, v)

    def _parse_relation_params(self, params_str: str) -> dict[str, JSONValue]:
        params: dict[str, JSONValue] = {}
        for part in params_str.split(","):
            if "=" in part:
                key, value = part.split("=", 1)
                v = self._strip_quotes(value.strip())
                # Models often copy placeholder variables from examples (X/Y/Z).
                # Treat these as "unspecified" so they don't overconstrain matching.
                if v.upper() in {"X", "Y", "Z"}:
                    v = ""
                params[key.strip()] = v
        return params

    def _parse_entity_params(self, params_str: str) -> dict[str, JSONValue]:
        params: dict[str, JSONValue] = {}
        for part in params_str.split(","):
            if "=" in part:
                key, value = part.split("=", 1)
                v = self._strip_quotes(value.strip())
                if v.upper() in {"X", "Y"}:
                    v = ""
                params[key.strip()] = v
        return params

    def _parse_traverse_params(self, params_str: str) -> dict[str, JSONValue]:
        params: dict[str, JSONValue] = {}
        for part in params_str.split(","):
            if "=" in part:
                key, value = part.split("=", 1)
                key = key.strip()
                value = self._strip_quotes(value.strip())
                if value.upper() in {"X", "Y", "Z"}:
                    value = ""
                if key == "path":
                    params["path"] = [self._normalize_predicate(p.strip()) for p in value.split("|") if p.strip()]
                else:
                    params[key] = value
        return params

    def _parse_query(self, action: str) -> ParsedQuery:
        action = action.strip()

        ParamExtractor = Callable[[re.Match[str]], dict[str, JSONValue]]
        PatternSpec = tuple[str, str, ParamExtractor]

        patterns: list[PatternSpec] = [
            (
                r"get[_\s]?entity\[([^\]]+)\]",
                "get_entity",
                lambda m: {"id": self._strip_quotes(m.group(1).strip())},
            ),
            (
                r"find[_\s]?relations\[([^\]]+)\]",
                "find_relations",
                lambda m: self._parse_relation_params(m.group(1)),
            ),
            (
                r"find[_\s]?entities\[([^\]]+)\]",
                "find_entities",
                lambda m: self._parse_entity_params(m.group(1)),
            ),
            (r"traverse\[([^\]]+)\]", "traverse", lambda m: self._parse_traverse_params(m.group(1))),
            (r"answer\[([^\]]+)\]", "answer", lambda m: {"answer": m.group(1).strip()}),
            (r"think", "think", lambda _m: {}),
        ]

        for pattern, query_type, extractor in patterns:
            match = re.search(pattern, action, re.IGNORECASE)
            if match:
                return {"type": query_type, "params": extractor(match)}

        return {"type": "invalid", "params": {}}

    async def evaluate(self, task: AgentBenchTask, trajectory: list[str]) -> bool:
        if not task.ground_truth:
            return False

        expected = task.ground_truth.lower().strip()
        expected_parts = [p.strip() for p in expected.split(",") if p.strip()]
        if not expected_parts:
            return False

        # 1) Prefer an explicit submitted answer, if present.
        for action in reversed(trajectory):
            parsed = self._parse_query(action)
            if parsed["type"] != "answer":
                continue
            answer_val = parsed["params"].get("answer", "")
            answer = answer_val.lower() if isinstance(answer_val, str) else ""
            return all(part in answer for part in expected_parts)

        # 2) Otherwise, treat evidence from executed queries as success.
        #
        # Many LLMs will (a) include quotes, (b) use predicate aliases, or (c) stop
        # after retrieving the answer but forget to emit `answer[...]`.
        found_parts: set[str] = set()

        def mark_entity(entity_id: str) -> None:
            entity = self._entities.get(entity_id)
            if not entity:
                return
            name_val = entity.get("name")
            name = name_val.lower() if isinstance(name_val, str) else ""
            if not name:
                return
            for part in expected_parts:
                if part in name:
                    found_parts.add(part)

        for action in trajectory:
            parsed = self._parse_query(action)
            qtype = parsed["type"]
            params = parsed["params"]

            if qtype == "get_entity":
                entity_id_val = params.get("id", "")
                entity_id_raw = entity_id_val if isinstance(entity_id_val, str) else ""
                entity_id = self._resolve_entity_id(entity_id_raw)
                if entity_id:
                    mark_entity(entity_id)

            elif qtype == "find_entities":
                entity_type_val = params.get("type")
                entity_type_raw = entity_type_val if isinstance(entity_type_val, str) else ""
                entity_type = entity_type_raw.strip().lower()
                name_contains_val = params.get("name_contains", "")
                name_contains = (
                    name_contains_val.lower() if isinstance(name_contains_val, str) else ""
                )

                for eid, entity in self._entities.items():
                    if entity_type:
                        etype_val = entity.get("type")
                        etype = etype_val.lower() if isinstance(etype_val, str) else ""
                        if not etype or etype != entity_type:
                            continue
                    if name_contains:
                        name_val = entity.get("name")
                        name = name_val.lower() if isinstance(name_val, str) else ""
                        if name_contains not in name:
                            continue
                    mark_entity(eid)

            elif qtype == "find_relations":
                subject_val = params.get("subject")
                predicate_val = params.get("predicate")
                object_val = params.get("object")

                subject_raw = subject_val if isinstance(subject_val, str) else ""
                predicate_raw = predicate_val if isinstance(predicate_val, str) else ""
                object_raw = object_val if isinstance(object_val, str) else ""

                subject = self._resolve_entity_id(subject_raw) if subject_raw else ""
                predicate = self._normalize_predicate(predicate_raw) if predicate_raw else ""
                obj = self._resolve_entity_id(object_raw) if object_raw else ""

                for rel in self._relations:
                    if subject and rel["subject"] != subject:
                        continue
                    if predicate and rel["predicate"].lower() != predicate:
                        continue
                    if obj and rel["object"] != obj:
                        continue
                    mark_entity(rel["subject"])
                    mark_entity(rel["object"])

            elif qtype == "traverse":
                start_val = params.get("start")
                path_val = params.get("path")

                start_raw = start_val if isinstance(start_val, str) else ""
                start = self._resolve_entity_id(start_raw)
                raw_path = (
                    [p for p in path_val if isinstance(p, str)] if isinstance(path_val, list) else []
                )
                path = [self._normalize_predicate(p) for p in raw_path if p]

                if start and path:
                    current = [start]
                    for pred in path:
                        next_entities: list[str] = []
                        for eid in current:
                            for rel in self._relations:
                                if rel["subject"] == eid and rel["predicate"].lower() == pred:
                                    next_entities.append(rel["object"])
                                elif rel["object"] == eid and rel["predicate"].lower() == pred:
                                    next_entities.append(rel["subject"])
                        current = list({x for x in next_entities})
                        if not current:
                            break
                    for eid in current:
                        mark_entity(eid)

            if len(found_parts) == len(expected_parts):
                return True

        return False

    async def cleanup(self) -> None:
        self._entities = {}
        self._relations = []
        self._initialized = False

    def get_action_space(self) -> list[str]:
        return [
            "get_entity[id]",
            "find_relations[subject=, predicate=, object=]",
            "find_entities[type=, name_contains=]",
            "traverse[start=, path=pred1|pred2]",
            "answer[text]",
            "think",
        ]

    def format_prompt(self, task: AgentBenchTask, observation: ObservationType) -> str:
        query_result = ""
        results_obj = observation.get("results")
        if isinstance(results_obj, list) and results_obj:
            total_val = observation.get("total")
            total = int(total_val) if isinstance(total_val, int) else len(results_obj)
            query_result = f"\n**Query Results ({total} items):**\n"
            for item in results_obj[:10]:
                query_result += f"- {item}\n"
        elif "result" in observation:
            query_result = f"\n**Result:** {observation.get('result')}\n"
        elif "error" in observation:
            query_result = f"\n**Error:** {observation.get('error')}\n"

        return f"""You are an AI assistant querying a knowledge graph. Answer the question using the available operations.

**Question:** {task.description}
**Goal:** {task.goal}

**Knowledge Graph Info:**
- Entities: {observation.get('entity_count', 'N/A')}
- Relations: {observation.get('relation_count', 'N/A')}
- Entity Types: {observation.get('entity_types', [])}
- Relation Types: {observation.get('relation_types', [])}

{query_result}

**Available Operations:**
- get_entity[e001]
- find_relations[subject=e001, predicate=born_in]          (predicate/object optional)
- find_entities[type=person, name_contains=Einstein]      (type optional)
- traverse[start=e001, path=born_in|continent]
- answer[Germany]
- think

**Important formatting rules:**
- Do NOT use placeholder values like X/Y/Z; omit the parameter instead.
- Do NOT add quotes unless strictly necessary (prefer `type=person`, not `type='person'`).
- As soon as you have the answer, submit `answer[...]` immediately.

Respond with your next operation."""

    def parse_action(self, response: str) -> str:
        # Prefer fenced block content
        fenced = re.search(r"```\n?(.+?)\n?```", response, re.DOTALL)
        if fenced:
            return fenced.group(1).strip().split("\n")[0]

        # Common prefixes
        for prefix in ("operation:", "query:", "action:"):
            m = re.search(rf"{prefix}\\s*(.+)", response, re.IGNORECASE)
            if m:
                return m.group(1).strip().split("\n")[0]

        # Direct patterns
        for pat in (
            r"(get_entity\[[^\]]+\])",
            r"(find_relations\[[^\]]+\])",
            r"(find_entities\[[^\]]+\])",
            r"(traverse\[[^\]]+\])",
            r"(answer\[[^\]]+\])",
            r"(think)",
        ):
            m = re.search(pat, response, re.IGNORECASE)
            if m:
                return m.group(1)

        return response.strip().split("\n")[0]

