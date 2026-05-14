import json
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional
from overrides import final

from bfcl_eval.utils import (
    get_directory_structure_by_id,
    is_first_memory_prereq_entry,
    is_memory_prereq,
)


class MemoryAPI(ABC):
    """
    A class that provides APIs to manage short-term and long-term memory data in a key-value format.
    """

    def __init__(self):
        self.core_memory = {}
        self.archival_memory = {}
        self.snapshot_folder: Path | None = None

    @final
    def _prepare_snapshot(self, initial_config: dict) -> Optional[dict]:
        """Helper to prepare snapshot folders/files and load previous memory data.

        Sub-classes should call this method and then load the specific portions of the snapshot
        they are interested in (e.g. `core_memory` or `archival_memory`) into their own in-memory
        representation.

        Args:
            initial_config (dict): The configuration dict passed from the evaluation harness.

        Returns:
            Optional[dict]: The previously saved memory snapshot if it exists, otherwise `None`.
        """
        # We don't care about the ``long_context`` parameter here – subclasses keep that
        model_result_dir: Path = initial_config["model_result_dir"]
        self.test_id: str = initial_config["test_id"]
        self.scenario: str = initial_config["scenario"]

        memory_snapshot_folder = (
            model_result_dir
            / get_directory_structure_by_id(self.test_id)
            / "memory_snapshot"
        )

        # Keep prerequisite checkpoints in a dedicated sub-folder so that multiple prerequisite
        # entries for the same scenario do not overwrite each other.
        if is_memory_prereq(self.test_id):
            self.snapshot_folder = memory_snapshot_folder / "prereq_checkpoints"
        else:
            self.snapshot_folder = memory_snapshot_folder

        self.snapshot_folder.mkdir(parents=True, exist_ok=True)
        self.latest_snapshot_file = memory_snapshot_folder / f"{self.scenario}_final.json"

        if is_first_memory_prereq_entry(self.test_id):
            # The very first entry of a prerequisite chain should start with a clean state.
            return None

        # For non-first entries we MUST have a snapshot to load from.
        # But if the first entry got a error during inference, then there will be no snapshot file
        if not self.latest_snapshot_file.exists():
            msg = (
                "⚠️" * 100
                + f"\nWarning: Not first memory entry, but no snapshot file found in this path: {self.latest_snapshot_file}. The memory will start empty for {initial_config['test_id']}.\n"
                + "⚠️" * 100
            )
            print(msg)

            return None

        with open(self.latest_snapshot_file, "r") as f:
            return json.load(f)

    @abstractmethod
    def _load_scenario(self, initial_config: dict, long_context: bool = False):
        pass

    @abstractmethod
    def _flush_memory_to_local_file(self):
        pass

    @abstractmethod
    def _dump_core_memory_to_context(self) -> str:
        pass
