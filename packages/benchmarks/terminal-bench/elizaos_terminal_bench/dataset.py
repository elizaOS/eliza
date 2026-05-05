"""
Terminal-Bench Dataset Loader

Loads and manages Terminal-Bench task data from the official dataset
or sample tasks for testing.
"""

import json
import logging
from pathlib import Path
from typing import Iterator, Optional

import aiofiles
import httpx

from elizaos_terminal_bench.types import (
    SAMPLE_TASKS,
    TaskCategory,
    TaskDifficulty,
    TerminalTask,
)

logger = logging.getLogger(__name__)


class TerminalBenchDataset:
    """Loads and manages Terminal-Bench task data."""

    OFFICIAL_REPO = "https://github.com/laude-institute/terminal-bench"
    DATASET_URL_TEMPLATE = (
        "https://raw.githubusercontent.com/laude-institute/terminal-bench/"
        "{version}/data/tasks.json"
    )

    def __init__(
        self,
        data_path: Optional[Path | str] = None,
        version: str = "2.0",
        use_sample_tasks: bool = False,
    ):
        """
        Initialize the dataset loader.

        Args:
            data_path: Path to local dataset directory. If None, uses cache.
            version: Terminal-Bench version to use (e.g., "2.0")
            use_sample_tasks: If True, use built-in sample tasks for testing
        """
        self.data_path = Path(data_path) if data_path else None
        self.version = version
        self.use_sample_tasks = use_sample_tasks
        self.tasks: list[TerminalTask] = []
        self._loaded = False

    async def load(self) -> None:
        """Load tasks from the Terminal-Bench dataset."""
        if self._loaded:
            return

        if self.use_sample_tasks:
            self._load_sample_tasks()
            self._loaded = True
            logger.info(f"Loaded {len(self.tasks)} sample tasks")
            return

        if self.data_path and self.data_path.exists():
            await self._load_from_directory()
        else:
            await self._load_from_remote()

        self._loaded = True
        logger.info(f"Loaded {len(self.tasks)} tasks from Terminal-Bench {self.version}")

    def _load_sample_tasks(self) -> None:
        """Load built-in sample tasks for testing."""
        for task_data in SAMPLE_TASKS:
            try:
                task = TerminalTask(
                    task_id=str(task_data["task_id"]),
                    instruction=str(task_data["instruction"]),
                    category=TaskCategory(task_data.get("category", "scripting")),
                    difficulty=TaskDifficulty(task_data.get("difficulty", "medium")),
                    test_script=str(task_data["test_script"]),
                    reference_solution=str(task_data["reference_solution"]),
                    timeout_seconds=int(task_data.get("timeout_seconds", 300)),
                    required_tools=list(task_data.get("required_tools", [])),
                    setup_script=(
                        str(task_data["setup_script"]) if "setup_script" in task_data else None
                    ),
                    initial_state=(
                        str(task_data["initial_state"])
                        if "initial_state" in task_data
                        else None
                    ),
                    docker_image=str(task_data.get("docker_image", "ubuntu:22.04")),
                )
                self.tasks.append(task)
            except (KeyError, ValueError) as e:
                logger.warning(f"Failed to load sample task: {e}")

    async def _load_from_directory(self) -> None:
        """Load tasks from a local directory."""
        if not self.data_path:
            raise ValueError("data_path is required for directory loading")

        tasks_dir = self.data_path / "tasks"
        if not tasks_dir.exists():
            # Try loading from a single JSON file
            tasks_file = self.data_path / "tasks.json"
            if tasks_file.exists():
                await self._load_from_json_file(tasks_file)
                return
            raise FileNotFoundError(f"No tasks found in {self.data_path}")

        for task_dir in tasks_dir.iterdir():
            if not task_dir.is_dir():
                continue

            task = await self._load_task_from_directory(task_dir)
            if task:
                self.tasks.append(task)

    async def _load_task_from_directory(
        self, task_dir: Path
    ) -> Optional[TerminalTask]:
        """Load a single task from its directory."""
        metadata_path = task_dir / "metadata.json"
        if not metadata_path.exists():
            logger.warning(f"No metadata.json found in {task_dir}")
            return None

        try:
            async with aiofiles.open(metadata_path, "r") as f:
                content = await f.read()
                metadata = json.loads(content)

            # Load instruction
            instruction_path = task_dir / "instruction.txt"
            instruction = ""
            if instruction_path.exists():
                async with aiofiles.open(instruction_path, "r") as f:
                    instruction = await f.read()

            # Load test script
            test_script_path = task_dir / "test.sh"
            test_script = ""
            if test_script_path.exists():
                async with aiofiles.open(test_script_path, "r") as f:
                    test_script = await f.read()

            # Load reference solution
            solution_path = task_dir / "solution.sh"
            reference_solution = ""
            if solution_path.exists():
                async with aiofiles.open(solution_path, "r") as f:
                    reference_solution = await f.read()

            # Load setup script if exists
            setup_script = None
            setup_path = task_dir / "setup.sh"
            if setup_path.exists():
                async with aiofiles.open(setup_path, "r") as f:
                    setup_script = await f.read()

            return TerminalTask(
                task_id=task_dir.name,
                instruction=instruction.strip(),
                category=TaskCategory(metadata.get("category", "scripting")),
                difficulty=TaskDifficulty(metadata.get("difficulty", "medium")),
                test_script=test_script.strip(),
                reference_solution=reference_solution.strip(),
                timeout_seconds=metadata.get("timeout", 300),
                required_tools=metadata.get("required_tools", []),
                initial_state=metadata.get("initial_state"),
                setup_script=setup_script,
                docker_image=metadata.get("docker_image", "ubuntu:22.04"),
                network_enabled=metadata.get("network_enabled", False),
                expected_files=metadata.get("expected_files", []),
                metadata=metadata.get("extra", {}),
            )

        except Exception as e:
            logger.error(f"Failed to load task from {task_dir}: {e}")
            return None

    async def _load_from_json_file(self, json_path: Path) -> None:
        """Load tasks from a single JSON file."""
        async with aiofiles.open(json_path, "r") as f:
            content = await f.read()
            data = json.loads(content)

        tasks_data = data.get("tasks", data) if isinstance(data, dict) else data

        for task_data in tasks_data:
            try:
                task = TerminalTask(
                    task_id=task_data["task_id"],
                    instruction=task_data["instruction"],
                    category=TaskCategory(task_data.get("category", "scripting")),
                    difficulty=TaskDifficulty(task_data.get("difficulty", "medium")),
                    test_script=task_data["test_script"],
                    reference_solution=task_data.get("reference_solution", ""),
                    timeout_seconds=task_data.get("timeout", 300),
                    required_tools=task_data.get("required_tools", []),
                    initial_state=task_data.get("initial_state"),
                    setup_script=task_data.get("setup_script"),
                    docker_image=task_data.get("docker_image", "ubuntu:22.04"),
                    network_enabled=task_data.get("network_enabled", False),
                    expected_files=task_data.get("expected_files", []),
                    metadata=task_data.get("metadata", {}),
                )
                self.tasks.append(task)
            except (KeyError, ValueError) as e:
                logger.warning(f"Failed to parse task: {e}")

    async def _load_from_remote(self) -> None:
        """Download and load tasks from the official repository."""
        # For now, fall back to sample tasks if remote loading fails
        logger.warning(
            "Remote dataset loading not fully implemented. "
            "Using sample tasks instead."
        )
        self._load_sample_tasks()

    async def download_dataset(
        self, target_dir: Path, version: Optional[str] = None
    ) -> None:
        """
        Download the official Terminal-Bench dataset.

        Args:
            target_dir: Directory to save the dataset
            version: Version to download (defaults to self.version)
        """
        version = version or self.version
        target_dir.mkdir(parents=True, exist_ok=True)

        url = self.DATASET_URL_TEMPLATE.format(version=version)

        async with httpx.AsyncClient() as client:
            try:
                response = await client.get(url)
                response.raise_for_status()

                tasks_file = target_dir / "tasks.json"
                async with aiofiles.open(tasks_file, "w") as f:
                    await f.write(response.text)

                logger.info(f"Downloaded dataset to {tasks_file}")

            except httpx.HTTPError as e:
                logger.error(f"Failed to download dataset: {e}")
                raise

    def filter_by_category(self, category: TaskCategory) -> list[TerminalTask]:
        """Filter tasks by category."""
        return [t for t in self.tasks if t.category == category]

    def filter_by_difficulty(self, difficulty: TaskDifficulty) -> list[TerminalTask]:
        """Filter tasks by difficulty."""
        return [t for t in self.tasks if t.difficulty == difficulty]

    def filter_by_categories(
        self, categories: list[TaskCategory]
    ) -> list[TerminalTask]:
        """Filter tasks by multiple categories."""
        return [t for t in self.tasks if t.category in categories]

    def filter_by_difficulties(
        self, difficulties: list[TaskDifficulty]
    ) -> list[TerminalTask]:
        """Filter tasks by multiple difficulties."""
        return [t for t in self.tasks if t.difficulty in difficulties]

    def filter_by_ids(self, task_ids: list[str]) -> list[TerminalTask]:
        """Filter tasks by specific IDs."""
        id_set = set(task_ids)
        return [t for t in self.tasks if t.task_id in id_set]

    def get_task(self, task_id: str) -> Optional[TerminalTask]:
        """Get a specific task by ID."""
        for task in self.tasks:
            if task.task_id == task_id:
                return task
        return None

    def get_statistics(self) -> dict[str, int | float | dict[str, int]]:
        """Get statistics about the loaded dataset."""
        category_counts: dict[str, int] = {}
        difficulty_counts: dict[str, int] = {}

        for task in self.tasks:
            cat = task.category.value
            diff = task.difficulty.value
            category_counts[cat] = category_counts.get(cat, 0) + 1
            difficulty_counts[diff] = difficulty_counts.get(diff, 0) + 1

        avg_timeout = (
            sum(t.timeout_seconds for t in self.tasks) / len(self.tasks)
            if self.tasks
            else 0
        )

        return {
            "total_tasks": len(self.tasks),
            "by_category": category_counts,
            "by_difficulty": difficulty_counts,
            "average_timeout_seconds": avg_timeout,
        }

    def __iter__(self) -> Iterator[TerminalTask]:
        """Iterate over all tasks."""
        return iter(self.tasks)

    def __len__(self) -> int:
        """Return the number of tasks."""
        return len(self.tasks)

    def __getitem__(self, index: int) -> TerminalTask:
        """Get a task by index."""
        return self.tasks[index]
