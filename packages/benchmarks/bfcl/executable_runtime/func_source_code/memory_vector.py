import json
from typing import List, Optional

import numpy as np
from benchmarks.bfcl.executable_runtime.func_source_code.memory_api_metaclass import (
    MemoryAPI,
)

# isort: off
# Note: This import order is necessary to avoid segfault issue due to FAISS and PyTorch each load a different OpenMP runtime
# See https://github.com/pytorch/pytorch/issues/149201#issuecomment-2725586827
# TODO: Find a common OpenMP runtime to avoid this issue
from sentence_transformers import SentenceTransformer
import faiss

# isort: on

# https://lilianweng.github.io/posts/2023-06-23-agent/#component-two-memory
MAX_CORE_MEMORY_SIZE = 7
MAX_CORE_MEMORY_ENTRY_LENGTH = 300
MAX_ARCHIVAL_MEMORY_SIZE = 50
MAX_ARCHIVAL_MEMORY_ENTRY_LENGTH = 2000


# Use a global SentenceTransformer model for all vector stores.
ENCODER = SentenceTransformer("all-MiniLM-L6-v2", device="cpu")
ENCODER_DIM = ENCODER.get_sentence_embedding_dimension()


class MemoryAPI_vector(MemoryAPI):
    """
    A class that provides APIs to manage short-term and long-term memory data using vector embeddings.
    """

    def __init__(self):
        self.core_memory = VectorStore(
            max_size=MAX_CORE_MEMORY_SIZE,
            max_entry_length=MAX_CORE_MEMORY_ENTRY_LENGTH,
        )
        self.archival_memory = VectorStore(
            max_size=MAX_ARCHIVAL_MEMORY_SIZE,
            max_entry_length=MAX_ARCHIVAL_MEMORY_ENTRY_LENGTH,
        )
        self._api_description = """This tool belongs to the memory suite, which provides APIs to interact with a key-value based memory system."""
        self.snapshot_folder = None

    def _load_scenario(self, initial_config: dict, long_context: bool = False):
        # Set up paths & load snapshots
        memory_data = self._prepare_snapshot(initial_config)

        if memory_data:
            self.core_memory.load_from_snapshot(memory_data["core_memory"])
            self.archival_memory.load_from_snapshot(memory_data["archival_memory"])

    def _flush_memory_to_local_file(self):
        """
        Flush (save) current memory (both core and archival) to a local JSON file.
        """

        # Write the snapshot file for the current test entry
        with open(self.snapshot_folder / f"{self.test_id}.json", "w") as f:
            json.dump(
                {
                    "core_memory": self.core_memory.export(),
                    "archival_memory": self.archival_memory.export(),
                },
                f,
                indent=4,
            )

        # Update the latest snapshot file content
        with open(self.latest_snapshot_file, "w") as f:
            json.dump(
                {
                    "core_memory": self.core_memory.export(),
                    "archival_memory": self.archival_memory.export(),
                },
                f,
                indent=4,
            )

    def _dump_core_memory_to_context(self) -> str:
        if not self.core_memory:
            return "There is no content in the core memory at this point."

        return json.dumps(self.core_memory._store, indent=4)

    def core_memory_add(self, text: str) -> dict[str, str]:
        """
        Add a new entry to the core memory.

        Args:
            text (str): The text to be added to the core memory.

        Returns:
            id (int): The ID of the added entry, which can be used later for deletion or retrieval.
        """
        return self.core_memory.add(text)

    def core_memory_remove(self, vec_id: int) -> dict[str, str]:
        """
        Remove an entry from the core memory.

        Args:
            vec_id (int): The ID of the entry to be removed.

        Returns:
            status (str): Status of the operation.
        """
        return self.core_memory.remove(vec_id)

    def core_memory_update(self, vec_id: int, new_text: str) -> dict[str, str]:
        """
        Update an entry in the core memory.

        Args:
            vec_id (int): The ID of the entry to be updated.
            new_text (str): The new text to replace the old text.

        Returns:
            status (str): Status of the operation.
        """
        return self.core_memory.update(vec_id, new_text)

    def core_memory_clear(self) -> dict[str, str]:
        """
        Clear all entries in the core memory.

        Returns:
            status (str): Status of the operation.
        """
        return self.core_memory.clear()

    def core_memory_retrieve(
        self, query: str, top_k: Optional[int] = 5
    ) -> list[dict[str, str]]:
        """
        Retrieve the most similar entries from the core memory.

        Args:
            query (str): The query text to search for.
            top_k (int): [Optional] The number of top similar entries to retrieve.

        Returns:
            results (list[dict]): A list of dictionaries containing the ID, similarity score, and text of the retrieved entries.
                - id (int): The ID of the entry.
                - similarity_score (float): The similarity score of the entry with respect to the query.
                - text (str): The text of the entry.
        """
        return {"result": self.core_memory.retrieve(query, top_k)}

    def core_memory_retrieve_all(self) -> list[dict[str, str]]:
        """
        Retrieve all entries from the core memory.

        Returns:
            results (list[dict]): A list of dictionaries containing the ID and text of all entries.
                - id (int): The ID of the entry.
                - text (str): The text of the entry.
        """
        return {"result": self.core_memory.retrieve_all()}

    def archival_memory_add(self, text: str) -> dict[str, str]:
        """
        Add a new entry to the archival memory.

        Args:
            text (str): The text to be added to the archival memory.

        Returns:
            id (int): The ID of the added entry, which can be used later for deletion or retrieval.
        """
        return self.archival_memory.add(text)

    def archival_memory_remove(self, vec_id: int) -> dict[str, str]:
        """
        Remove an entry from the archival memory.

        Args:
            vec_id (int): The ID of the entry to be removed.

        Returns:
            status (str): Status of the operation.
        """
        return self.archival_memory.remove(vec_id)

    def archival_memory_update(self, vec_id: int, new_text: str) -> dict[str, str]:
        """
        Update an entry in the archival memory.

        Args:
            vec_id (int): The ID of the entry to be updated.
            new_text (str): The new text to replace the old text.

        Returns:
            status (str): Status of the operation.
        """
        return self.archival_memory.update(vec_id, new_text)

    def archival_memory_clear(self) -> dict[str, str]:
        """
        Clear all entries in the archival memory.

        Returns:
            status (str): Status of the operation.
        """
        return self.archival_memory.clear()

    def archival_memory_retrieve(
        self, query: str, top_k: Optional[int] = 5
    ) -> list[dict[str, str]]:
        """
        Retrieve the most similar entries from the archival memory.
        Args:
            query (str): The query text to search for.
            top_k (int): [Optional] The number of top similar entries to retrieve.
        Returns:
            results (list[dict]): A list of dictionaries containing the ID, similarity score, and text of the retrieved entries.
                - id (int): The ID of the entry.
                - similarity_score (float): The similarity score of the entry with respect to the query.
                - text (str): The text of the entry.
        """
        return {"result": self.archival_memory.retrieve(query, top_k)}

    def archival_memory_retrieve_all(self) -> list[dict[str, str]]:
        """
        Retrieve all entries from the archival memory.

        Returns:
            results (list[dict]): A list of dictionaries containing the ID and text of all entries.
                - id (int): The ID of the entry.
                - text (str): The text of the entry.
        """
        return {"result": self.archival_memory.retrieve_all()}


class VectorStore:

    def __init__(self, max_size, max_entry_length):
        self.max_size = max_size
        self.max_entry_length = max_entry_length

        # Cosine similarity via inner product on L2‑normalised vectors.
        index_flat = faiss.IndexFlatIP(ENCODER_DIM)
        self._index = faiss.IndexIDMap(index_flat)

        self._store: dict[int, str] = {}
        # _next_id will always be unique and sequential
        self._next_id: int = 0

    def _embed(self, text: str | List[str]) -> np.ndarray:
        """Return an L2-normalised NumPy array suitable for FAISS."""
        vecs = ENCODER.encode(
            text if isinstance(text, list) else [text], normalize_embeddings=True
        )
        return np.asarray(vecs, dtype=np.float32)

    def add(self, text: str) -> dict[str, str]:
        if len(text) > self.max_entry_length:
            return {
                "error": f"Entry length exceeds maximum length of {self.max_entry_length} characters."
            }

        if len(self._store) >= self.max_size:
            return {
                "error": f"Memory size exceeds maximum size of {self.max_size} entries."
            }

        vec_id = self._next_id
        self._next_id += 1

        vector = self._embed(text)
        self._index.add_with_ids(vector, np.array([vec_id], dtype=np.int64))
        self._store[vec_id] = text

        return {"id": vec_id}

    def remove(self, vec_id: int) -> dict[str, str]:
        if vec_id not in self._store:
            return {"error": f"ID {vec_id} not present in store."}

        self._index.remove_ids(np.array([vec_id], dtype=np.int64))
        del self._store[vec_id]

        return {"status": f"ID {vec_id} removed from store."}

    def update(self, vec_id: int, new_text: str) -> dict[str, str]:
        if vec_id not in self._store:
            return {"error": f"ID {vec_id} not present in store."}
        if len(new_text) > self.max_entry_length:
            return {
                "error": f"Entry length exceeds maximum length of {self.max_entry_length} characters."
            }

        self._index.remove_ids(np.array([vec_id], dtype=np.int64))
        vector = self._embed(new_text)
        self._index.add_with_ids(vector, np.array([vec_id], dtype=np.int64))
        self._store[vec_id] = new_text

        return {"status": f"ID {vec_id} updated."}

    def clear(self) -> dict[str, str]:
        self._index.reset()
        self._store.clear()
        self._next_id = 0

        return {"status": "Memory cleared."}

    def retrieve(self, query: str, top_k: int = 5) -> list[dict[str, str]]:
        """Return the *top_k* most similar texts.

        Return a list of dictionary with keys 'id', 'similarity_score', and 'text'.
        """
        if not self._store:
            return []
        # q_vec has just one row (shape == (1, dim))
        q_vec = self._embed(query)

        # scores and ids come back with one row each (shape == (1, top_k))
        scores, ids = self._index.search(q_vec, min(top_k, len(self._store)))

        results = []
        for score, vid in zip(scores[0], ids[0]):
            # FAISS pads the id slots it can’t fill with ‑1, so we skip those
            if vid != -1:
                results.append(
                    {
                        "id": int(vid),
                        "similarity_score": float(score),
                        "text": self._store[int(vid)],
                    }
                )
        return results

    def retrieve_all(self) -> list[dict[str, str]]:
        """Return all entries in the vector store."""
        results = []
        for vid, text in self._store.items():
            results.append(
                {
                    "id": int(vid),
                    "text": text,
                }
            )
        return results

    def export(self) -> dict:
        """
        Export the vector store snapshot to a dictionary.
        """
        return {
            "next_id": self._next_id,
            "store": self._store,
        }

    def load_from_snapshot(self, snapshot_data: dict) -> None:
        """
        Load the vector store from a snapshot.
        """
        self._next_id = snapshot_data["next_id"]
        self._store = {int(k): v for k, v in snapshot_data["store"].items()}
        self._index.reset()

        if self._store:
            # Re-embed every stored text in one batch
            # To keep IDs aligned with vectors, sort by ID
            ids = np.array(sorted(self._store.keys()), dtype=np.int64)
            texts = [self._store[i] for i in ids]
            vectors = self._embed(texts)

            # Re-populate the index with the known IDs
            self._index.add_with_ids(vectors, ids)
