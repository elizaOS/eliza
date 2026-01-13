from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

from elizaos_plugin_inmemorydb.types import IVectorStorage, VectorSearchResult


@dataclass
class HNSWNode:
    id: str
    vector: list[float]
    level: int
    neighbors: dict[int, set[str]] = field(default_factory=dict)


@dataclass
class HNSWConfig:
    M: int = 16  # noqa: N815
    ef_construction: int = 200
    ef_search: int = 50
    mL: float = field(default=0.0)  # noqa: N815

    def __post_init__(self) -> None:
        if self.mL == 0.0:
            self.mL = 1.0 / math.log(self.M)


def cosine_distance(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        raise ValueError(f"Vector dimension mismatch: {len(a)} vs {len(b)}")

    dot_product = 0.0
    norm_a = 0.0
    norm_b = 0.0

    for i in range(len(a)):
        dot_product += a[i] * b[i]
        norm_a += a[i] * a[i]
        norm_b += b[i] * b[i]

    magnitude = math.sqrt(norm_a) * math.sqrt(norm_b)
    if magnitude == 0:
        return 1.0

    return 1.0 - (dot_product / magnitude)


class EphemeralHNSW(IVectorStorage):
    def __init__(self) -> None:
        self._nodes: dict[str, HNSWNode] = {}
        self._entry_point: str | None = None
        self._max_level = 0
        self._dimension = 0
        self._config = HNSWConfig()

    async def init(self, dimension: int) -> None:
        self._dimension = dimension

    def _get_random_level(self) -> int:
        level = 0
        while random.random() < math.exp(-level * self._config.mL) and level < 16:
            level += 1
        return level

    async def add(self, id_: str, vector: list[float]) -> None:
        if len(vector) != self._dimension:
            raise ValueError(
                f"Vector dimension mismatch: expected {self._dimension}, got {len(vector)}"
            )

        if id_ in self._nodes:
            self._nodes[id_].vector = vector
            return

        level = self._get_random_level()
        new_node = HNSWNode(
            id=id_,
            vector=vector,
            level=level,
            neighbors={lvl: set() for lvl in range(level + 1)},
        )

        if self._entry_point is None:
            self._entry_point = id_
            self._max_level = level
            self._nodes[id_] = new_node
            return

        current_node = self._entry_point

        for lvl in range(self._max_level, level, -1):
            results = self._search_layer(vector, current_node, 1, lvl)
            if results:
                current_node = results[0]["id"]

        for lvl in range(min(level, self._max_level), -1, -1):
            neighbors = self._search_layer(vector, current_node, self._config.ef_construction, lvl)

            max_neighbors = self._config.M
            selected_neighbors = neighbors[:max_neighbors]

            for neighbor in selected_neighbors:
                new_node.neighbors[lvl].add(neighbor["id"])

                neighbor_node = self._nodes.get(neighbor["id"])
                if neighbor_node:
                    if lvl not in neighbor_node.neighbors:
                        neighbor_node.neighbors[lvl] = set()
                    neighbor_node.neighbors[lvl].add(id_)

                    if len(neighbor_node.neighbors[lvl]) > max_neighbors:
                        to_keep = self._select_best_neighbors(
                            neighbor_node.vector, neighbor_node.neighbors[lvl], max_neighbors
                        )
                        neighbor_node.neighbors[lvl] = set(n["id"] for n in to_keep)

            if neighbors:
                current_node = neighbors[0]["id"]

        self._nodes[id_] = new_node

        if level > self._max_level:
            self._max_level = level
            self._entry_point = id_

    def _search_layer(
        self, query: list[float], entry_id: str, ef: int, level: int
    ) -> list[dict[str, float | str]]:
        visited: set[str] = {entry_id}
        entry_node = self._nodes.get(entry_id)
        if not entry_node:
            return []

        entry_dist = cosine_distance(query, entry_node.vector)

        candidates: list[dict[str, float | str]] = [{"id": entry_id, "distance": entry_dist}]
        results: list[dict[str, float | str]] = [{"id": entry_id, "distance": entry_dist}]

        while candidates:
            candidates.sort(key=lambda x: x["distance"])
            current = candidates.pop(0)

            results.sort(key=lambda x: x["distance"], reverse=True)
            furthest_result = results[0]

            if current["distance"] > furthest_result["distance"]:
                break

            current_node = self._nodes.get(str(current["id"]))
            if not current_node:
                continue

            neighbors = current_node.neighbors.get(level, set())

            for neighbor_id in neighbors:
                if neighbor_id in visited:
                    continue
                visited.add(neighbor_id)

                neighbor_node = self._nodes.get(neighbor_id)
                if not neighbor_node:
                    continue

                dist = cosine_distance(query, neighbor_node.vector)

                if len(results) < ef or dist < float(furthest_result["distance"]):
                    candidates.append({"id": neighbor_id, "distance": dist})
                    results.append({"id": neighbor_id, "distance": dist})

                    if len(results) > ef:
                        results.sort(key=lambda x: x["distance"], reverse=True)
                        results.pop()

        results.sort(key=lambda x: x["distance"])
        return results

    def _select_best_neighbors(
        self, node_vector: list[float], neighbor_ids: set[str], max_neighbors: int
    ) -> list[dict[str, float | str]]:
        neighbors: list[dict[str, float | str]] = []

        for id_ in neighbor_ids:
            node = self._nodes.get(id_)
            if node:
                neighbors.append({"id": id_, "distance": cosine_distance(node_vector, node.vector)})

        neighbors.sort(key=lambda x: x["distance"])
        return neighbors[:max_neighbors]

    async def remove(self, id_: str) -> None:
        node = self._nodes.get(id_)
        if not node:
            return

        for level, neighbors in node.neighbors.items():
            for neighbor_id in neighbors:
                neighbor_node = self._nodes.get(neighbor_id)
                if neighbor_node and level in neighbor_node.neighbors:
                    neighbor_node.neighbors[level].discard(id_)

        del self._nodes[id_]

        if self._entry_point == id_:
            if not self._nodes:
                self._entry_point = None
                self._max_level = 0
            else:
                max_level = 0
                new_entry: str | None = None
                for node_id, n in self._nodes.items():
                    if n.level >= max_level:
                        max_level = n.level
                        new_entry = node_id
                self._entry_point = new_entry
                self._max_level = max_level

    async def search(
        self, query: list[float], k: int, threshold: float = 0.5
    ) -> list[VectorSearchResult]:
        if self._entry_point is None or not self._nodes:
            return []

        if len(query) != self._dimension:
            raise ValueError(
                f"Query dimension mismatch: expected {self._dimension}, got {len(query)}"
            )

        current_node = self._entry_point

        for level in range(self._max_level, 0, -1):
            closest = self._search_layer(query, current_node, 1, level)
            if closest:
                current_node = str(closest[0]["id"])

        results = self._search_layer(query, current_node, max(k, self._config.ef_search), 0)

        return [
            VectorSearchResult(
                id=str(r["id"]),
                distance=float(r["distance"]),
                similarity=1.0 - float(r["distance"]),
            )
            for r in results[:k]
            if (1.0 - float(r["distance"])) >= threshold
        ]

    async def clear(self) -> None:
        self._nodes.clear()
        self._entry_point = None
        self._max_level = 0

    def size(self) -> int:
        return len(self._nodes)
