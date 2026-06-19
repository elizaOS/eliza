import json
from copy import deepcopy
from typing import Dict

from benchmarks.bfcl.executable_runtime.func_source_code.memory_api_metaclass import (
    MemoryAPI,
)

MAX_MEMORY_ENTRY_LENGTH = 10000  # 10k characters


class MemoryAPI_rec_sum(MemoryAPI):
    """
    A class that provides APIs to manage memory data via recursive summarization.
    """

    def __init__(self):
        self.memory = ""
        self._api_description = """This tool belongs to the memory suite, which provides APIs to manage memory data via recursive summarization."""
        self.snapshot_folder = None

    def _load_scenario(self, initial_config: dict, long_context: bool = False):
        # Set up paths & load snapshots
        memory_data = self._prepare_snapshot(initial_config)

        # Populate in-memory structures if we have a previous snapshot
        if memory_data:
            self.memory = deepcopy(memory_data["memory"])
            assert isinstance(
                self.memory, str
            ), f"Memory data should be a string, but got {type(self.memory)} instead."

    def _flush_memory_to_local_file(self):
        """
        Flush (save) current memory to a local JSON file.
        """

        # Write the snapshot file for the current test entry
        with open(self.snapshot_folder / f"{self.test_id}.json", "w") as f:
            json.dump(
                {
                    "memory": self.memory,
                },
                f,
                indent=4,
            )

        # Update the latest snapshot file content
        with open(self.latest_snapshot_file, "w") as f:
            json.dump(
                {
                    "memory": self.memory,
                },
                f,
                indent=4,
            )

    def _dump_core_memory_to_context(self) -> str:
        if not self.memory:
            return "There is no content in the memory at this point."

        return str(self.memory)

    def memory_append(self, text: str) -> Dict[str, str]:
        """
        Append a new text to the end of the memory.

        Args:
            text (str): The text to append to the memory.

        Returns:
            status (str): Status of the operation.
        """
        text = str(text)
        combined_text = self.memory + text
        if len(combined_text) > MAX_MEMORY_ENTRY_LENGTH:
            return {
                "error": f"Entry will be too long after appending. Please shorten the entry to less than {MAX_MEMORY_ENTRY_LENGTH} characters."
            }

        self.memory += text
        return {"status": "Memory appended."}

    def memory_update(self, text: str) -> Dict[str, str]:
        """
        Update the memory with new text. This will replace the existing memory content.

        Args:
            text (str): The new text to set as the memory.

        Returns:
            status (str): Status of the operation.
        """
        text = str(text)
        if len(text) > MAX_MEMORY_ENTRY_LENGTH:
            return {
                "error": f"Entry will be too long after updating. Please shorten the entry to less than {MAX_MEMORY_ENTRY_LENGTH} characters."
            }

        self.memory = text
        return {"status": "Memory updated."}

    def memory_clear(self) -> Dict[str, str]:
        """
        Clear all content in the memory, including any from previous interactions. This operation is irreversible.

        Returns:
            status (str): Status of the operation.
        """
        self.memory = ""
        return {"status": "Short term memory cleared."}

    def memory_replace(self, old_text: str, new_text: str) -> Dict[str, str]:
        """
        Replace a specific text in the memory with new text.
        Args:
            old_text (str): The text to be replaced in the memory.
            new_text (str): The new text to replace the old text.
        Returns:
            status (str): Status of the operation.
        """
        old_text = str(old_text)
        new_text = str(new_text)

        if old_text not in self.memory:
            return {"error": f"Text '{old_text}' not found in memory."}

        if len(new_text) > MAX_MEMORY_ENTRY_LENGTH:
            return {
                "error": f"Entry will be too long after replacing. Please shorten the entry to less than {MAX_MEMORY_ENTRY_LENGTH} characters."
            }

        self.memory = self.memory.replace(old_text, new_text)
        return {"status": "Memory updated."}

    def memory_retrieve(self) -> Dict[str, str]:
        """
        Retrieve the current content of the memory.

        Returns:
            memory_content (str): The current content of the memory.
        """

        if not self.memory:
            return {"error": "Memory is empty."}

        return {"memory_content": self.memory}
