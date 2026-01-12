import math
import random
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple


@dataclass
class VectorSearchResult:
    id: str
    distance: float
    similarity: float


@dataclass
class HNSWNode:
    id: str
    vector: List[float]
    level: int
    neighbors: Dict[int, Set[str]] = field(default_factory=dict)


def cosine_distance(a: List[float], b: List[float]) -> float:
    if len(a) != len(b):
        return 1.0

    dot_product = sum(ai * bi for ai, bi in zip(a, b))
    norm_a = math.sqrt(sum(ai * ai for ai in a))
    norm_b = math.sqrt(sum(bi * bi for bi in b))

    if norm_a == 0 or norm_b == 0:
        return 1.0

    return 1.0 - (dot_product / (norm_a * norm_b))


class SimpleHNSW:
    def __init__(
        self,
        m: int = 16,
        ef_construction: int = 200,
        ef_search: int = 50,
        save_callback: Optional[Callable[[], None]] = None,
        load_callback: Optional[Callable[[], Optional[Dict[str, Any]]]] = None,
    ):
        self.m = m
        self.ef_construction = ef_construction
        self.ef_search = ef_search
        self.ml = 1.0 / math.log(m)
        self.save_callback = save_callback
        self.load_callback = load_callback

        self.nodes: Dict[str, HNSWNode] = {}
        self.entry_point: Optional[str] = None
        self.max_level = 0
        self.dimension = 0

    async def init(self, dimension: int) -> None:
        self.dimension = dimension
        if self.load_callback:
            index = self.load_callback()
            if index and index.get("dimension") == dimension:
                self._load_from_dict(index)

    def _get_random_level(self) -> int:
        level = 0
        while random.random() < math.exp(-level * self.ml) and level < 16:
            level += 1
        return level

    async def add(self, id: str, vector: List[float]) -> None:
        if len(vector) != self.dimension:
            raise ValueError(
                f"Vector dimension mismatch: expected {self.dimension}, got {len(vector)}"
            )

        if id in self.nodes:
            self.nodes[id].vector = vector
            return

        level = self._get_random_level()
        new_node = HNSWNode(
            id=id,
            vector=vector,
            level=level,
            neighbors={lvl: set() for lvl in range(level + 1)},
        )

        if self.entry_point is None:
            self.entry_point = id
            self.max_level = level
            self.nodes[id] = new_node
            return

        current = self.entry_point

        for lvl in range(self.max_level, level, -1):
            closest = self._search_layer(vector, current, 1, lvl)
            if closest:
                current = closest[0][0]

        for lvl in range(min(level, self.max_level), -1, -1):
            neighbors = self._search_layer(vector, current, self.ef_construction, lvl)
            selected = [n[0] for n in neighbors[: self.m]]

            for neighbor_id in selected:
                new_node.neighbors[lvl].add(neighbor_id)

                if neighbor_id in self.nodes:
                    neighbor_node = self.nodes[neighbor_id]
                    if lvl not in neighbor_node.neighbors:
                        neighbor_node.neighbors[lvl] = set()
                    neighbor_node.neighbors[lvl].add(id)

                    if len(neighbor_node.neighbors[lvl]) > self.m:
                        neighbor_node.neighbors[lvl] = set(
                            n
                            for n, _ in sorted(
                                [
                                    (
                                        nid,
                                        cosine_distance(
                                            neighbor_node.vector, self.nodes[nid].vector
                                        ),
                                    )
                                    for nid in neighbor_node.neighbors[lvl]
                                    if nid in self.nodes
                                ],
                                key=lambda x: x[1],
                            )[: self.m]
                        )

            if selected:
                current = selected[0]

        self.nodes[id] = new_node

        if level > self.max_level:
            self.max_level = level
            self.entry_point = id

    def _search_layer(
        self,
        query: List[float],
        entry: str,
        ef: int,
        level: int,
    ) -> List[Tuple[str, float]]:
        if entry not in self.nodes:
            return []

        entry_node = self.nodes[entry]
        entry_dist = cosine_distance(query, entry_node.vector)

        visited = {entry}
        candidates = [(entry_dist, entry)]
        results = [(entry_dist, entry)]

        while candidates:
            candidates.sort(key=lambda x: x[0])
            current_dist, current_id = candidates.pop(0)

            results.sort(key=lambda x: x[0])
            if results and current_dist > results[-1][0]:
                break

            if current_id not in self.nodes:
                continue

            current_node = self.nodes[current_id]
            neighbors = current_node.neighbors.get(level, set())

            for neighbor_id in neighbors:
                if neighbor_id in visited or neighbor_id not in self.nodes:
                    continue
                visited.add(neighbor_id)

                neighbor_node = self.nodes[neighbor_id]
                dist = cosine_distance(query, neighbor_node.vector)

                results.sort(key=lambda x: x[0])
                if len(results) < ef or dist < results[-1][0]:
                    candidates.append((dist, neighbor_id))
                    results.append((dist, neighbor_id))

                    if len(results) > ef:
                        results.sort(key=lambda x: x[0])
                        results = results[:ef]

        results.sort(key=lambda x: x[0])
        return [(r[1], r[0]) for r in results]

    async def remove(self, id: str) -> None:
        if id not in self.nodes:
            return

        node = self.nodes.pop(id)

        for level, neighbors in node.neighbors.items():
            for neighbor_id in neighbors:
                if neighbor_id in self.nodes:
                    neighbor_node = self.nodes[neighbor_id]
                    if level in neighbor_node.neighbors:
                        neighbor_node.neighbors[level].discard(id)

        if self.entry_point == id:
            if not self.nodes:
                self.entry_point = None
                self.max_level = 0
            else:
                new_entry, new_level = max(
                    ((nid, n.level) for nid, n in self.nodes.items()),
                    key=lambda x: x[1],
                    default=(None, 0),
                )
                self.entry_point = new_entry
                self.max_level = new_level

    async def search(
        self,
        query: List[float],
        k: int,
        threshold: float = 0.0,
    ) -> List[VectorSearchResult]:
        if self.entry_point is None or not self.nodes:
            return []

        if len(query) != self.dimension:
            return []

        current = self.entry_point

        for lvl in range(self.max_level, 0, -1):
            closest = self._search_layer(query, current, 1, lvl)
            if closest:
                current = closest[0][0]

        results = self._search_layer(query, current, max(k, self.ef_search), 0)

        return [
            VectorSearchResult(
                id=id,
                distance=dist,
                similarity=1.0 - dist,
            )
            for id, dist in results[:k]
            if (1.0 - dist) >= threshold
        ]

    async def save(self) -> None:
        if self.save_callback:
            self.save_callback()

    def get_index(self) -> Dict[str, Any]:
        return {
            "dimension": self.dimension,
            "m": self.m,
            "ef_construction": self.ef_construction,
            "ef_search": self.ef_search,
            "entry_point": self.entry_point,
            "max_level": self.max_level,
            "nodes": {
                nid: {
                    "id": node.id,
                    "vector": node.vector,
                    "level": node.level,
                    "neighbors": {
                        str(lvl): list(neighbors)
                        for lvl, neighbors in node.neighbors.items()
                    },
                }
                for nid, node in self.nodes.items()
            },
        }

    def _load_from_dict(self, data: Dict[str, Any]) -> None:
        self.dimension = data.get("dimension", 0)
        self.m = data.get("m", 16)
        self.ef_construction = data.get("ef_construction", 200)
        self.ef_search = data.get("ef_search", 50)
        self.entry_point = data.get("entry_point")
        self.max_level = data.get("max_level", 0)

        self.nodes = {}
        for nid, node_data in data.get("nodes", {}).items():
            self.nodes[nid] = HNSWNode(
                id=node_data["id"],
                vector=node_data["vector"],
                level=node_data["level"],
                neighbors={
                    int(lvl): set(neighbors)
                    for lvl, neighbors in node_data.get("neighbors", {}).items()
                },
            )

    def size(self) -> int:
        return len(self.nodes)
