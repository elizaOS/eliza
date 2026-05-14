import json
import re
from copy import deepcopy
from typing import Dict, List, Tuple

from bfcl_eval.eval_checker.multi_turn_eval.func_source_code.memory_api_metaclass import (
    MemoryAPI,
)
from rank_bm25 import BM25Plus

# https://lilianweng.github.io/posts/2023-06-23-agent/#component-two-memory
MAX_CORE_MEMORY_SIZE = 7
MAX_CORE_MEMORY_ENTRY_LENGTH = 300
MAX_ARCHIVAL_MEMORY_SIZE = 50
MAX_ARCHIVAL_MEMORY_ENTRY_LENGTH = 2000


class MemoryAPI_kv(MemoryAPI):
    """
    A class that provides APIs to manage short-term and long-term memory data in a key-value format.
    """

    def __init__(self):
        self.core_memory = {}
        self.archival_memory = {}
        self._api_description = """This tool belongs to the memory suite, which provides APIs to interact with a key-value based memory system."""
        self.snapshot_folder = None

    def _load_scenario(self, initial_config: dict, long_context: bool = False):
        # Set up paths & load snapshots
        memory_data = self._prepare_snapshot(initial_config)

        # Populate in-memory structures if we have a previous snapshot
        if memory_data:
            self.core_memory = deepcopy(memory_data["core_memory"])
            self.archival_memory = deepcopy(memory_data["archival_memory"])

    def _flush_memory_to_local_file(self):
        """
        Flush (save) current memory (both core and archival) to a local JSON file.
        """

        # Write the snapshot file for the current test entry
        with open(self.snapshot_folder / f"{self.test_id}.json", "w") as f:
            json.dump(
                {
                    "core_memory": self.core_memory,
                    "archival_memory": self.archival_memory,
                },
                f,
                indent=4,
            )

        # Update the latest snapshot file content
        with open(self.latest_snapshot_file, "w") as f:
            json.dump(
                {
                    "core_memory": self.core_memory,
                    "archival_memory": self.archival_memory,
                },
                f,
                indent=4,
            )

    def _dump_core_memory_to_context(self) -> str:
        if not self.core_memory:
            return "There is no content in the core memory at this point."
        return json.dumps(self.core_memory, indent=4)

    @staticmethod
    def _similarity_search(query: str, corpus: list[str], k: int = 5):
        """
        Search for the most similar text in the corpus to the query using BM25+ algorithm.

        Args:
            query (str): The query text to search for.
            corpus (list[str]): A list of text strings to search in.
            k (int): The number of results to return.

        Returns:
            ranked_results (list[tuple[float, str]]): A list of tuples containing the BM25+ score and the text string.
        """
        tokenized_corpus = [text.replace("_", " ").lower().split() for text in corpus]
        bm25 = BM25Plus(tokenized_corpus)
        tokenized_query = query.replace("_", " ").lower().split()
        scores = bm25.get_scores(tokenized_query)
        ranked_results = sorted(zip(scores, corpus), key=lambda x: x[0], reverse=True)
        return {"ranked_results": ranked_results[:k]}

    @staticmethod
    def _is_valid_key_format(s):
        """
        Check if the key is in snake_case format and does not contain spaces.
        """
        pattern = r"^[a-z]+(_[a-z0-9]+)*$"
        return bool(re.match(pattern, s))

    def core_memory_add(self, key: str, value: str) -> Dict[str, str]:
        """
        Add a key-value pair to the short-term memory. Make sure to use meaningful keys for easy retrieval later.

        Args:
            key (str): The key under which the value is stored. The key should be unique and case-sensitive. Keys must be snake_case and cannot contain spaces.
            value (str): The value to store in the short-term memory.

        Returns:
            status (str): Status of the operation.
        """
        key, value = str(key), str(value)
        if len(self.core_memory) >= MAX_CORE_MEMORY_SIZE:
            return {"error": "Core memory is full. Please clear some entries."}
        if len(value) > MAX_CORE_MEMORY_ENTRY_LENGTH:
            return {
                "error": f"Entry is too long. Please shorten the entry to less than {MAX_CORE_MEMORY_ENTRY_LENGTH} characters."
            }

        if not self._is_valid_key_format(key):
            return {"error": "Key must be in snake_case format and cannot contain spaces."}
        if key in self.core_memory:
            return {"error": "Key name must be unique."}

        self.core_memory[key] = value
        return {"status": "Key-value pair added."}

    def core_memory_remove(self, key: str) -> Dict[str, str]:
        """
        Remove a key-value pair from the short-term memory.

        Args:
            key (str): The key to remove from the short-term memory. Case-sensitive.

        Returns:
            status (str): Status of the operation.
        """
        if key in self.core_memory:
            del self.core_memory[key]
            return {"status": "Key removed."}
        else:
            return {"error": "Key not found."}

    def core_memory_replace(self, key: str, value: str) -> Dict[str, str]:
        """
        Replace a key-value pair in the short-term memory with a new value.

        Args:
            key (str): The key to replace in the short-term memory. Case-sensitive.
            value (str): The new value associated with the key.

        Returns:
            status (str): Status of the operation.
        """
        key, value = str(key), str(value)
        if key not in self.core_memory:
            return {"error": "Key not found."}
        if len(value) > MAX_CORE_MEMORY_ENTRY_LENGTH:
            return {
                "error": f"Entry is too long. Please shorten the entry to less than {MAX_CORE_MEMORY_ENTRY_LENGTH} characters."
            }

        self.core_memory[key] = value
        return {"status": "Key replaced."}

    def core_memory_clear(self) -> Dict[str, str]:
        """
        Clear all key-value pairs from the short-term memory, including those from previous interactions. This operation is irreversible.

        Returns:
            status (str): Status of the operation.
        """
        self.core_memory = {}
        return {"status": "Short term memory cleared."}

    def core_memory_retrieve(self, key: str) -> Dict[str, str]:
        """
        Retrieve the value associated with a key from the short-term memory. This function does not support partial key matching or similarity search.

        Args:
            key (str): The key to retrieve. Case-sensitive. The key must match exactly with the key stored in the memory.

        Returns:
            value (str): The value associated with the key.

        """
        if key not in self.core_memory:
            return {"error": "Key not found."}
        return {"value": self.core_memory[key]}

    def core_memory_list_keys(self) -> Dict[str, List[str]]:
        """
        List all keys currently in the short-term memory.

        Returns:
            keys (List[str]): A list of all keys in the short-term memory.
        """
        return {"keys": list(self.core_memory.keys())}

    def core_memory_key_search(
        self, query: str, k: int = 5
    ) -> Dict[str, List[Tuple[float, str]]]:
        """
        Search for key names in the short-term memory that are similar to the query using BM25+ algorithm.

        Args:
            query (str): The query text to search for.
            k (int): [Optional] The number of results to return.

        Returns:
            ranked_results (List[Tuple[float, str]]): A list of tuples containing the BM25+ score and the key.
        """
        keys = deepcopy(list(self.core_memory.keys()))
        return self._similarity_search(query, keys, k)

    def core_memory_retrieve_all(self) -> Dict[str, str]:
        """
        Retrieve all key-value pairs from the short-term memory.

        Returns:
            key (str): Each key in the short-term memory.
            value (str): The value associated with each key.
        """
        return self.core_memory

    def archival_memory_add(self, key: str, value: str) -> Dict[str, str]:
        """
        Add a key-value pair to the long-term memory. Make sure to use meaningful keys for easy retrieval later.
        Args:
            key (str): The key under which the value is stored. The key should be unique and case-sensitive. Keys must be snake_case and cannot contain spaces.
            value (str): The value to store in the long-term memory.

        Returns:
            status (str): Status of the operation.
        """
        key, value = str(key), str(value)
        if len(self.archival_memory) >= MAX_ARCHIVAL_MEMORY_SIZE:
            return {"error": "Long term memory is full. Please clear some entries."}
        if len(value) > MAX_ARCHIVAL_MEMORY_ENTRY_LENGTH:
            return {
                "error": f"Entry is too long. Please shorten the entry to less than {MAX_ARCHIVAL_MEMORY_ENTRY_LENGTH} characters."
            }

        if not self._is_valid_key_format(key):
            return {"error": "Key must be in snake_case format and cannot contain spaces."}
        if key in self.archival_memory:
            return {"error": "Key name must be unique."}

        self.archival_memory[key] = value
        return {"status": "Key added."}

    def archival_memory_remove(self, key: str) -> Dict[str, str]:
        """
        Remove a key-value pair from the long-term memory.

        Args:
            key (str): The key to remove from the long-term memory. Case-sensitive.

        Returns:
            status (str): Status of the operation.
        """
        if key in self.archival_memory:
            del self.archival_memory[key]
            return {"status": "Key removed."}
        else:
            return {"error": "Key not found."}

    def archival_memory_replace(self, key: str, value: str) -> Dict[str, str]:
        """
        Replace a key-value pair in the long-term memory with a new value.

        Args:
            key (str): The key to replace in the long-term memory. Case-sensitive.
            value (str): The new value associated with the key.

        Returns:
            status (str): Status of the operation.
        """
        key, value = str(key), str(value)
        if key not in self.archival_memory:
            return {"error": "Key not found."}
        if len(value) > MAX_ARCHIVAL_MEMORY_ENTRY_LENGTH:
            return {
                "error": f"Entry is too long. Please shorten the entry to less than {MAX_ARCHIVAL_MEMORY_ENTRY_LENGTH} characters."
            }

        self.archival_memory[key] = value
        return {"status": "Key replaced."}

    def archival_memory_clear(self) -> Dict[str, str]:
        """
        Clear all key-value pairs from the long-term memory, including those from previous interactions. This operation is irreversible.

        Returns:
            status (str): Status of the operation.
        """
        self.archival_memory = {}
        return {"status": "Long term memory cleared."}

    def archival_memory_retrieve(self, key: str) -> Dict[str, str]:
        """
        Retrieve the value associated with a key from the long-term memory. This function does not support partial key matching or similarity search.

        Args:
            key (str): The key to retrieve. Case-sensitive. The key must match exactly with the key stored in the memory.

        Returns:
            value (str): The value associated with the key.
        """
        if key not in self.archival_memory:
            return {"error": "Key not found."}
        return {"value": self.archival_memory[key]}

    def archival_memory_list_keys(self) -> Dict[str, List[str]]:
        """
        List all keys currently in the long-term memory.

        Returns:
            keys (List[str]): A list of all keys in the long-term memory.
        """
        return {"keys": list(self.archival_memory.keys())}

    def archival_memory_key_search(
        self, query: str, k: int = 5
    ) -> Dict[str, List[Tuple[float, str]]]:
        """
        Search for key names in the long-term memory that are similar to the query using BM25+ algorithm.

        Args:
            query (str): The query text to search for.
            k (int): [Optional] The number of results to return.

        Returns:
            ranked_results (List[Tuple[float, str]]): A list of tuples containing the BM25+ score and the key.
        """
        keys = deepcopy(list(self.archival_memory.keys()))
        return self._similarity_search(query, keys, k)
