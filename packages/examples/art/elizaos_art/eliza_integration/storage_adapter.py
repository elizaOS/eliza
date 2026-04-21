"""
Storage Adapter for ElizaOS plugin-localdb

Provides trajectory and checkpoint storage using:
- Local JSON files (compatible with plugin-localdb format)
- Vector search for similar trajectories
- Export to training datasets
"""

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


@dataclass
class TrajectoryRecord:
    """A stored trajectory record."""

    trajectory_id: str
    agent_id: str
    scenario_id: str | None
    total_reward: float
    episode_length: int
    final_status: str
    created_at: int
    data: dict


class SimpleHNSW:
    """
    Simple HNSW-like vector index.
    
    Compatible with plugin-localdb's SimpleHNSW implementation.
    Uses brute-force search for simplicity (good enough for <10k vectors).
    """

    def __init__(self, dimensions: int = 384):
        self.dimensions = dimensions
        self.vectors: list[tuple[str, list[float]]] = []

    def add(self, id: str, vector: list[float]) -> None:
        """Add a vector to the index."""
        if len(vector) != self.dimensions:
            raise ValueError(f"Vector must have {self.dimensions} dimensions")
        self.vectors.append((id, vector))

    def search(
        self,
        query: list[float],
        k: int = 10,
        threshold: float = 0.0,
    ) -> list[tuple[str, float]]:
        """Search for k nearest neighbors."""
        if len(query) != self.dimensions:
            raise ValueError(f"Query must have {self.dimensions} dimensions")

        results: list[tuple[str, float]] = []
        for id, vec in self.vectors:
            similarity = self._cosine_similarity(query, vec)
            if similarity >= threshold:
                results.append((id, similarity))

        results.sort(key=lambda x: x[1], reverse=True)
        return results[:k]

    def _cosine_similarity(self, a: list[float], b: list[float]) -> float:
        """Compute cosine similarity between two vectors."""
        dot_product = sum(x * y for x, y in zip(a, b))
        norm_a = sum(x * x for x in a) ** 0.5
        norm_b = sum(x * x for x in b) ** 0.5
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot_product / (norm_a * norm_b)

    def save(self, path: Path) -> None:
        """Save index to file."""
        with open(path, "w") as f:
            json.dump({
                "dimensions": self.dimensions,
                "vectors": self.vectors,
            }, f)

    def load(self, path: Path) -> None:
        """Load index from file."""
        with open(path) as f:
            data = json.load(f)
        self.dimensions = data["dimensions"]
        self.vectors = [(v[0], v[1]) for v in data["vectors"]]


class TrajectoryStore:
    """
    Trajectory storage with vector search capabilities.
    
    Compatible with plugin-localdb patterns:
    - JSON file per record
    - HNSW vector index
    - Query by predicates
    """

    COLLECTION = "trajectories"

    def __init__(
        self,
        data_dir: str | Path = "./data",
        embedding_dimensions: int = 384,
    ):
        self.data_dir = Path(data_dir)
        self.trajectories_dir = self.data_dir / self.COLLECTION
        self.trajectories_dir.mkdir(parents=True, exist_ok=True)

        self.vectors_dir = self.data_dir / "vectors"
        self.vectors_dir.mkdir(parents=True, exist_ok=True)

        self.vector_index = SimpleHNSW(embedding_dimensions)
        self._load_vector_index()

    def _load_vector_index(self) -> None:
        """Load existing vector index."""
        index_path = self.vectors_dir / "hnsw_index.json"
        if index_path.exists():
            self.vector_index.load(index_path)

    def _save_vector_index(self) -> None:
        """Save vector index."""
        index_path = self.vectors_dir / "hnsw_index.json"
        self.vector_index.save(index_path)

    async def save_trajectory(
        self,
        trajectory: dict,
        embedding: list[float] | None = None,
    ) -> str:
        """Save a trajectory and optionally index its embedding."""
        trajectory_id = trajectory["trajectoryId"]

        # Save JSON file
        file_path = self.trajectories_dir / f"{trajectory_id}.json"
        with open(file_path, "w") as f:
            json.dump(trajectory, f, indent=2)

        # Index embedding if provided
        if embedding:
            self.vector_index.add(trajectory_id, embedding)
            self._save_vector_index()

        return trajectory_id

    async def get_trajectory(self, trajectory_id: str) -> dict | None:
        """Get a trajectory by ID."""
        file_path = self.trajectories_dir / f"{trajectory_id}.json"
        if not file_path.exists():
            return None
        with open(file_path) as f:
            return json.load(f)

    async def get_all_trajectories(self) -> list[dict]:
        """Get all trajectories."""
        trajectories = []
        for file_path in self.trajectories_dir.glob("*.json"):
            with open(file_path) as f:
                trajectories.append(json.load(f))
        return trajectories

    async def get_trajectories_where(
        self,
        predicate: Callable[[dict], bool],
    ) -> list[dict]:
        """Get trajectories matching a predicate."""
        all_trajectories = await self.get_all_trajectories()
        return [t for t in all_trajectories if predicate(t)]

    async def search_similar(
        self,
        embedding: list[float],
        k: int = 10,
        threshold: float = 0.7,
    ) -> list[tuple[dict, float]]:
        """Search for similar trajectories by embedding."""
        results = self.vector_index.search(embedding, k, threshold)

        trajectories_with_scores = []
        for trajectory_id, score in results:
            trajectory = await self.get_trajectory(trajectory_id)
            if trajectory:
                trajectories_with_scores.append((trajectory, score))

        return trajectories_with_scores

    async def delete_trajectory(self, trajectory_id: str) -> bool:
        """Delete a trajectory."""
        file_path = self.trajectories_dir / f"{trajectory_id}.json"
        if file_path.exists():
            file_path.unlink()
            return True
        return False

    async def count(self, predicate: Callable[[dict], bool] | None = None) -> int:
        """Count trajectories, optionally filtered by predicate."""
        if predicate:
            trajectories = await self.get_trajectories_where(predicate)
            return len(trajectories)
        return len(list(self.trajectories_dir.glob("*.json")))


class ElizaStorageAdapter:
    """
    Full storage adapter compatible with plugin-localdb.
    
    Provides:
    - Trajectory storage
    - Checkpoint storage
    - Cache storage
    - Log storage
    """

    def __init__(self, data_dir: str | Path = "./data"):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)

        # Collections
        self.trajectories = TrajectoryStore(self.data_dir)
        self._cache: dict[str, tuple[dict, int | None]] = {}  # key -> (value, expires_at)
        self._logs_dir = self.data_dir / "logs"
        self._logs_dir.mkdir(exist_ok=True)

    # Trajectory operations
    async def save_trajectory(
        self,
        trajectory: dict,
        embedding: list[float] | None = None,
    ) -> str:
        return await self.trajectories.save_trajectory(trajectory, embedding)

    async def get_trajectory(self, trajectory_id: str) -> dict | None:
        return await self.trajectories.get_trajectory(trajectory_id)

    async def get_trajectories_by_scenario(self, scenario_id: str) -> list[dict]:
        return await self.trajectories.get_trajectories_where(
            lambda t: t.get("scenarioId") == scenario_id
        )

    async def get_trajectories_by_agent(self, agent_id: str) -> list[dict]:
        return await self.trajectories.get_trajectories_where(
            lambda t: t.get("agentId") == agent_id
        )

    # Cache operations
    async def get_cache(self, key: str) -> dict | None:
        """Get cached value."""
        if key not in self._cache:
            return None
        value, expires_at = self._cache[key]
        if expires_at and expires_at < int(time.time() * 1000):
            del self._cache[key]
            return None
        return value

    async def set_cache(
        self,
        key: str,
        value: dict,
        ttl_ms: int | None = None,
    ) -> None:
        """Set cached value with optional TTL."""
        expires_at = None
        if ttl_ms:
            expires_at = int(time.time() * 1000) + ttl_ms
        self._cache[key] = (value, expires_at)

    async def delete_cache(self, key: str) -> bool:
        """Delete cached value."""
        if key in self._cache:
            del self._cache[key]
            return True
        return False

    # Log operations
    async def log(
        self,
        log_type: str,
        body: dict,
        entity_id: str | None = None,
        room_id: str | None = None,
    ) -> None:
        """Write a log entry."""
        import uuid

        log_entry = {
            "id": str(uuid.uuid4()),
            "type": log_type,
            "body": body,
            "entityId": entity_id,
            "roomId": room_id,
            "createdAt": int(time.time() * 1000),
        }

        # Append to daily log file
        date_str = time.strftime("%Y-%m-%d")
        log_file = self._logs_dir / f"{date_str}.jsonl"
        with open(log_file, "a") as f:
            f.write(json.dumps(log_entry) + "\n")

    async def get_logs(
        self,
        log_type: str | None = None,
        entity_id: str | None = None,
        room_id: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        """Get log entries."""
        logs = []

        for log_file in sorted(self._logs_dir.glob("*.jsonl"), reverse=True):
            with open(log_file) as f:
                for line in f:
                    entry = json.loads(line)
                    if log_type and entry.get("type") != log_type:
                        continue
                    if entity_id and entry.get("entityId") != entity_id:
                        continue
                    if room_id and entry.get("roomId") != room_id:
                        continue
                    logs.append(entry)
                    if len(logs) >= limit:
                        return logs

        return logs

    # Checkpoint operations
    async def save_checkpoint(
        self,
        checkpoint_id: str,
        checkpoint_data: dict,
    ) -> None:
        """Save a training checkpoint."""
        checkpoints_dir = self.data_dir / "checkpoints"
        checkpoints_dir.mkdir(exist_ok=True)

        file_path = checkpoints_dir / f"{checkpoint_id}.json"
        with open(file_path, "w") as f:
            json.dump(checkpoint_data, f, indent=2)

    async def get_checkpoint(self, checkpoint_id: str) -> dict | None:
        """Get a training checkpoint."""
        file_path = self.data_dir / "checkpoints" / f"{checkpoint_id}.json"
        if not file_path.exists():
            return None
        with open(file_path) as f:
            return json.load(f)

    async def list_checkpoints(self) -> list[str]:
        """List all checkpoint IDs."""
        checkpoints_dir = self.data_dir / "checkpoints"
        if not checkpoints_dir.exists():
            return []
        return [p.stem for p in checkpoints_dir.glob("*.json")]
