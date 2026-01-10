"""
Simple HNSW (Hierarchical Navigable Small World) implementation for Python.

This is a basic implementation for local testing and development.
Not optimized for large-scale production use.
"""

import json
import math
import random
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple


@dataclass
class VectorSearchResult:
    """Result of a vector similarity search."""

    id: str
    distance: float
    similarity: float


@dataclass
class HNSWNode:
    """A node in the HNSW graph."""

    id: str
    vector: List[float]
    level: int
    neighbors: Dict[int, Set[str]] = field(default_factory=dict)


@dataclass
class HNSWConfig:
    """Configuration for HNSW index."""

    M: int = 16  # Max connections per layer
    ef_construction: int = 200  # Size of dynamic candidate list during construction
    ef_search: int = 50  # Size of dynamic candidate list during search
    mL: float = field(default=0.0)  # Level multiplier (1/ln(M))

    def __post_init__(self):
        if self.mL == 0.0:
            self.mL = 1.0 / math.log(self.M)


def cosine_distance(a: List[float], b: List[float]) -> float:
    """Calculate cosine distance between two vectors."""
    if len(a) != len(b):
        raise ValueError(f"Vector dimension mismatch: {len(a)} vs {len(b)}")

    dot_product = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))

    magnitude = norm_a * norm_b
    if magnitude == 0:
        return 1.0

    return 1.0 - (dot_product / magnitude)


class SimpleHNSW:
    """
    Simple HNSW implementation for vector similarity search.
    """

    def __init__(
        self,
        save_callback: Optional[Callable[[], None]] = None,
        load_callback: Optional[Callable[[], Optional[Dict[str, Any]]]] = None,
    ):
        self.nodes: Dict[str, HNSWNode] = {}
        self.entry_point: Optional[str] = None
        self.max_level: int = 0
        self.dimension: int = 0
        self.config = HNSWConfig()
        self._save_callback = save_callback
        self._load_callback = load_callback

    async def init(self, dimension: int) -> None:
        """Initialize the HNSW index with a given dimension."""
        self.dimension = dimension

        # Try to load existing index
        if self._load_callback:
            index = self._load_callback()
            if index and index.get("dimension") == dimension:
                self._deserialize(index)

    def _get_random_level(self) -> int:
        """Generate a random level for a new node."""
        level = 0
        while random.random() < math.exp(-level * self.config.mL) and level < 16:
            level += 1
        return level

    async def add(self, item_id: str, vector: List[float]) -> None:
        """Add a vector to the index."""
        if len(vector) != self.dimension:
            raise ValueError(
                f"Vector dimension mismatch: expected {self.dimension}, got {len(vector)}"
            )

        # Update existing node
        if item_id in self.nodes:
            self.nodes[item_id].vector = vector
            return

        level = self._get_random_level()
        new_node = HNSWNode(
            id=item_id,
            vector=vector,
            level=level,
            neighbors={l: set() for l in range(level + 1)},
        )

        if self.entry_point is None:
            # First node
            self.entry_point = item_id
            self.max_level = level
            self.nodes[item_id] = new_node
            return

        current_node = self.entry_point

        # Search from top level down to level+1
        for l in range(self.max_level, level, -1):
            results = self._search_layer(vector, current_node, 1, l)
            if results:
                current_node = results[0][0]

        # Insert at each level from level down to 0
        for l in range(min(level, self.max_level), -1, -1):
            neighbors = self._search_layer(vector, current_node, self.config.ef_construction, l)

            # Connect to M closest neighbors
            selected = neighbors[: self.config.M]

            for neighbor_id, _ in selected:
                new_node.neighbors[l].add(neighbor_id)

                neighbor_node = self.nodes.get(neighbor_id)
                if neighbor_node:
                    if l not in neighbor_node.neighbors:
                        neighbor_node.neighbors[l] = set()
                    neighbor_node.neighbors[l].add(item_id)

                    # Prune if over limit
                    if len(neighbor_node.neighbors[l]) > self.config.M:
                        to_keep = self._select_best_neighbors(
                            neighbor_node.vector,
                            neighbor_node.neighbors[l],
                            self.config.M,
                        )
                        neighbor_node.neighbors[l] = set(n[0] for n in to_keep)

            if neighbors:
                current_node = neighbors[0][0]

        self.nodes[item_id] = new_node

        # Update entry point if new node has higher level
        if level > self.max_level:
            self.max_level = level
            self.entry_point = item_id

    def _search_layer(
        self,
        query: List[float],
        entry_id: str,
        ef: int,
        level: int,
    ) -> List[Tuple[str, float]]:
        """Search a single layer for nearest neighbors."""
        visited: Set[str] = {entry_id}
        entry_node = self.nodes.get(entry_id)
        if not entry_node:
            return []

        entry_dist = cosine_distance(query, entry_node.vector)
        candidates = [(entry_id, entry_dist)]
        results = [(entry_id, entry_dist)]

        while candidates:
            candidates.sort(key=lambda x: x[1])
            current_id, current_dist = candidates.pop(0)

            results.sort(key=lambda x: -x[1])
            if current_dist > results[0][1]:
                break

            current_node = self.nodes.get(current_id)
            if not current_node:
                continue

            neighbors = current_node.neighbors.get(level, set())

            for neighbor_id in neighbors:
                if neighbor_id in visited:
                    continue
                visited.add(neighbor_id)

                neighbor_node = self.nodes.get(neighbor_id)
                if not neighbor_node:
                    continue

                dist = cosine_distance(query, neighbor_node.vector)

                if len(results) < ef or dist < results[0][1]:
                    candidates.append((neighbor_id, dist))
                    results.append((neighbor_id, dist))

                    if len(results) > ef:
                        results.sort(key=lambda x: -x[1])
                        results.pop(0)

        results.sort(key=lambda x: x[1])
        return results

    def _select_best_neighbors(
        self,
        node_vector: List[float],
        neighbor_ids: Set[str],
        M: int,
    ) -> List[Tuple[str, float]]:
        """Select the best M neighbors for a node."""
        neighbors = []
        for neighbor_id in neighbor_ids:
            node = self.nodes.get(neighbor_id)
            if node:
                neighbors.append((neighbor_id, cosine_distance(node_vector, node.vector)))

        neighbors.sort(key=lambda x: x[1])
        return neighbors[:M]

    async def remove(self, item_id: str) -> None:
        """Remove a vector from the index."""
        node = self.nodes.get(item_id)
        if not node:
            return

        # Remove from all neighbors' neighbor lists
        for level, neighbors in node.neighbors.items():
            for neighbor_id in neighbors:
                neighbor_node = self.nodes.get(neighbor_id)
                if neighbor_node and level in neighbor_node.neighbors:
                    neighbor_node.neighbors[level].discard(item_id)

        del self.nodes[item_id]

        # Update entry point if needed
        if self.entry_point == item_id:
            if not self.nodes:
                self.entry_point = None
                self.max_level = 0
            else:
                # Find new entry point with highest level
                max_level = 0
                new_entry = None
                for node_id, n in self.nodes.items():
                    if n.level >= max_level:
                        max_level = n.level
                        new_entry = node_id
                self.entry_point = new_entry
                self.max_level = max_level

    async def search(
        self,
        query: List[float],
        k: int,
        threshold: float = 0.5,
    ) -> List[VectorSearchResult]:
        """Search for nearest neighbors."""
        if self.entry_point is None or not self.nodes:
            return []

        if len(query) != self.dimension:
            raise ValueError(
                f"Query dimension mismatch: expected {self.dimension}, got {len(query)}"
            )

        current_node = self.entry_point

        # Search from top to level 1
        for l in range(self.max_level, 0, -1):
            closest = self._search_layer(query, current_node, 1, l)
            if closest:
                current_node = closest[0][0]

        # Search at level 0 with ef
        results = self._search_layer(
            query, current_node, max(k, self.config.ef_search), 0
        )

        return [
            VectorSearchResult(id=r[0], distance=r[1], similarity=1 - r[1])
            for r in results[:k]
            if (1 - r[1]) >= threshold
        ]

    async def save(self) -> None:
        """Persist the index."""
        if self._save_callback:
            self._save_callback()

    async def load(self) -> None:
        """Load the index."""
        if self._load_callback:
            index = self._load_callback()
            if index:
                self._deserialize(index)

    def serialize(self) -> Dict[str, Any]:
        """Serialize the index to a dictionary."""
        nodes = {}
        for node_id, node in self.nodes.items():
            nodes[node_id] = {
                "id": node.id,
                "vector": node.vector,
                "level": node.level,
                "neighbors": {
                    str(level): list(neighbors)
                    for level, neighbors in node.neighbors.items()
                },
            }

        return {
            "dimension": self.dimension,
            "config": {
                "M": self.config.M,
                "ef_construction": self.config.ef_construction,
                "ef_search": self.config.ef_search,
                "mL": self.config.mL,
            },
            "nodes": nodes,
            "entry_point": self.entry_point,
            "max_level": self.max_level,
        }

    def _deserialize(self, index: Dict[str, Any]) -> None:
        """Deserialize the index from a dictionary."""
        self.dimension = index["dimension"]
        config = index.get("config", {})
        self.config = HNSWConfig(
            M=config.get("M", 16),
            ef_construction=config.get("ef_construction", 200),
            ef_search=config.get("ef_search", 50),
            mL=config.get("mL", 1.0 / math.log(16)),
        )
        self.entry_point = index.get("entry_point")
        self.max_level = index.get("max_level", 0)
        self.nodes.clear()

        for node_id, serialized in index.get("nodes", {}).items():
            neighbors = {
                int(level): set(ids)
                for level, ids in serialized.get("neighbors", {}).items()
            }
            self.nodes[node_id] = HNSWNode(
                id=serialized["id"],
                vector=serialized["vector"],
                level=serialized["level"],
                neighbors=neighbors,
            )

    def get_index(self) -> Dict[str, Any]:
        """Get the serialized index for external persistence."""
        return self.serialize()

    def size(self) -> int:
        """Get count of vectors in the index."""
        return len(self.nodes)

