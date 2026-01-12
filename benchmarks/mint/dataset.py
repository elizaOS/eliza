"""
MINT Dataset Loader

Loads and manages MINT benchmark tasks from various sources.
Includes built-in test cases representative of MINT categories.
"""

import json
import logging
from pathlib import Path
from typing import Optional

from benchmarks.mint.types import MINTCategory, MINTTask

logger = logging.getLogger(__name__)


class MINTDataset:
    """Dataset loader for MINT benchmark tasks."""

    def __init__(self, data_path: str = "./data/mint") -> None:
        self.data_path = Path(data_path)
        self.tasks: dict[MINTCategory, list[MINTTask]] = {cat: [] for cat in MINTCategory}
        self._loaded = False

    async def load(self) -> None:
        """Load MINT dataset from files or generate built-in tasks."""
        if self._loaded:
            return

        logger.info(f"[MINTDataset] Loading dataset from {self.data_path}")

        # Try to load from files first
        loaded_from_files = await self._load_from_files()

        # If no files found, use built-in tasks
        if not loaded_from_files:
            logger.info("[MINTDataset] No data files found, using built-in tasks")
            await self._load_builtin_tasks()

        total_tasks = sum(len(tasks) for tasks in self.tasks.values())
        logger.info(f"[MINTDataset] Loaded {total_tasks} tasks across {len(MINTCategory)} categories")
        self._loaded = True

    async def _load_from_files(self) -> bool:
        """Load tasks from JSON files. Returns True if any files were loaded."""
        if not self.data_path.exists():
            return False

        loaded_any = False
        for category in MINTCategory:
            category_path = self.data_path / f"{category.value}.json"
            if category_path.exists():
                try:
                    with open(category_path) as f:
                        data = json.load(f)
                        self.tasks[category] = [
                            self._parse_task(item, category) for item in data
                        ]
                        loaded_any = True
                        logger.debug(
                            f"[MINTDataset] Loaded {len(self.tasks[category])} "
                            f"{category.value} tasks"
                        )
                except Exception as e:
                    logger.error(f"[MINTDataset] Error loading {category_path}: {e}")

        return loaded_any

    def _parse_task(
        self,
        data: dict[str, str | int | float | bool | list[str] | None],
        category: MINTCategory,
    ) -> MINTTask:
        """Parse a task from JSON data with validation."""
        # Validate required fields
        task_id = str(data.get("id", ""))
        if not task_id:
            raise ValueError("Task must have an 'id' field")

        description = str(data.get("description", ""))
        initial_prompt = str(data.get("initial_prompt", data.get("prompt", "")))
        ground_truth = str(data.get("ground_truth", data.get("answer", "")))

        if not initial_prompt:
            raise ValueError(f"Task {task_id} must have 'initial_prompt' or 'prompt'")
        if not ground_truth:
            raise ValueError(f"Task {task_id} must have 'ground_truth' or 'answer'")

        # Parse tools_allowed with validation
        tools_raw = data.get("tools_allowed", ["python"])
        if isinstance(tools_raw, list):
            tools_allowed = [str(t) for t in tools_raw]
        else:
            tools_allowed = ["python"]

        # Parse max_turns with bounds checking
        max_turns_raw = data.get("max_turns", 5)
        try:
            max_turns = int(max_turns_raw) if max_turns_raw is not None else 5
            max_turns = max(1, min(max_turns, 20))  # Clamp between 1 and 20
        except (ValueError, TypeError):
            max_turns = 5

        # Validate difficulty
        difficulty_raw = str(data.get("difficulty", "medium"))
        if difficulty_raw not in ("easy", "medium", "hard"):
            difficulty_raw = "medium"

        # Validate evaluation_metric
        metric_raw = str(data.get("evaluation_metric", "exact_match"))
        valid_metrics = ("exact_match", "numeric", "code_output", "partial_match", "semantic")
        if metric_raw not in valid_metrics:
            logger.warning(f"[MINTDataset] Unknown metric '{metric_raw}' for task {task_id}, using exact_match")
            metric_raw = "exact_match"

        subcategory_raw = data.get("subcategory")
        subcategory = str(subcategory_raw) if subcategory_raw else None

        return MINTTask(
            id=task_id,
            category=category,
            description=description,
            initial_prompt=initial_prompt,
            ground_truth=ground_truth,
            max_turns=max_turns,
            tools_allowed=tools_allowed,
            evaluation_metric=metric_raw,
            difficulty=difficulty_raw,
            subcategory=subcategory,
        )

    async def _load_builtin_tasks(self) -> None:
        """Load built-in representative tasks for each category."""
        # Reasoning tasks
        self.tasks[MINTCategory.REASONING] = [
            MINTTask(
                id="reasoning-001",
                category=MINTCategory.REASONING,
                description="Solve a multi-step math word problem",
                initial_prompt=(
                    "A farmer has 15 chickens. Each chicken lays 4 eggs per week. "
                    "If the farmer sells eggs for $0.50 each and sells 80% of all eggs, "
                    "how much money does the farmer make in 4 weeks?"
                ),
                ground_truth="96",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="numeric",
                difficulty="medium",
                subcategory="math_word_problems",
            ),
            MINTTask(
                id="reasoning-002",
                category=MINTCategory.REASONING,
                description="Calculate compound interest",
                initial_prompt=(
                    "If you invest $1000 at 5% annual interest compounded quarterly, "
                    "how much will you have after 3 years? Round to 2 decimal places."
                ),
                ground_truth="1160.75",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="numeric",
                difficulty="medium",
                subcategory="finance",
            ),
            MINTTask(
                id="reasoning-003",
                category=MINTCategory.REASONING,
                description="Solve a logic puzzle",
                initial_prompt=(
                    "There are 5 houses in a row, numbered 1 to 5 from left to right.\n"
                    "Each house is painted a different color: red, blue, green, yellow, white.\n\n"
                    "Clues:\n"
                    "1. The red house is somewhere to the LEFT of the blue house.\n"
                    "2. The green house is in the MIDDLE (position 3).\n"
                    "3. The yellow house is NOT at either end (not position 1 or 5).\n"
                    "4. The white house is at the RIGHT end (position 5).\n\n"
                    "What is the order of house colors from left to right?\n"
                    "Answer format: color1,color2,color3,color4,color5 (no spaces)"
                ),
                ground_truth="red,yellow,green,blue,white",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="exact_match",
                difficulty="hard",
                subcategory="logic_puzzles",
            ),
            MINTTask(
                id="reasoning-004",
                category=MINTCategory.REASONING,
                description="Calculate probability",
                initial_prompt=(
                    "A bag contains 5 red balls, 3 blue balls, and 2 green balls (10 total).\n"
                    "You draw 2 balls WITHOUT replacement.\n\n"
                    "What is the probability that BOTH balls are red?\n"
                    "Hint: P(both red) = (5/10) × (4/9)\n\n"
                    "Express as a decimal rounded to 4 decimal places. Give just the number."
                ),
                ground_truth="0.2222",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="numeric",
                difficulty="medium",
                subcategory="probability",
            ),
            MINTTask(
                id="reasoning-005",
                category=MINTCategory.REASONING,
                description="Solve algebraic equation",
                initial_prompt=(
                    "Solve for x: 3x^2 - 12x + 9 = 0. "
                    "Give the larger solution as a decimal."
                ),
                ground_truth="3",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="numeric",
                difficulty="easy",
                subcategory="algebra",
            ),
        ]

        # Coding tasks
        self.tasks[MINTCategory.CODING] = [
            MINTTask(
                id="coding-001",
                category=MINTCategory.CODING,
                description="Implement a function to find prime numbers",
                initial_prompt=(
                    "Write a Python function that returns all prime numbers up to n. "
                    "Then use it to find the sum of all primes up to 100."
                ),
                ground_truth="1060",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="numeric",
                difficulty="medium",
                subcategory="algorithms",
            ),
            MINTTask(
                id="coding-002",
                category=MINTCategory.CODING,
                description="Implement binary search",
                initial_prompt=(
                    "Implement binary search to find the index of 42 in this sorted list: "
                    "[1, 5, 12, 23, 34, 42, 56, 67, 78, 89, 100]. "
                    "Return the index (0-based)."
                ),
                ground_truth="5",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="numeric",
                difficulty="easy",
                subcategory="algorithms",
            ),
            MINTTask(
                id="coding-003",
                category=MINTCategory.CODING,
                description="Debug and fix code",
                initial_prompt=(
                    "The following code is supposed to calculate factorial but has bugs:\n"
                    "```python\n"
                    "def factorial(n):\n"
                    "    if n = 0:\n"
                    "        return 0\n"
                    "    return n * factorial(n)\n"
                    "```\n"
                    "Fix the bugs and calculate factorial(5)."
                ),
                ground_truth="120",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="numeric",
                difficulty="medium",
                subcategory="debugging",
            ),
            MINTTask(
                id="coding-004",
                category=MINTCategory.CODING,
                description="String manipulation",
                initial_prompt=(
                    "Count the total number of vowels (a, e, i, o, u) in this string:\n"
                    "'The quick brown fox jumps over the lazy dog'\n\n"
                    "Count both uppercase and lowercase vowels. Give just the number."
                ),
                ground_truth="11",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="numeric",
                difficulty="easy",
                subcategory="strings",
            ),
            MINTTask(
                id="coding-005",
                category=MINTCategory.CODING,
                description="Data structure manipulation",
                initial_prompt=(
                    "Given a list [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5], "
                    "find the mode (most frequent element)."
                ),
                ground_truth="5",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="numeric",
                difficulty="easy",
                subcategory="data_structures",
            ),
        ]

        # Decision Making tasks
        self.tasks[MINTCategory.DECISION_MAKING] = [
            MINTTask(
                id="decision-001",
                category=MINTCategory.DECISION_MAKING,
                description="Optimize resource allocation",
                initial_prompt=(
                    "You have $1000 to invest. Option A gives 5% return, "
                    "Option B gives 8% return but has 20% chance of losing 10%. "
                    "Option C gives 3% guaranteed return. "
                    "Calculate the expected value of investing $500 in B and $500 in C "
                    "after one year. Round to 2 decimal places."
                ),
                ground_truth="1037.00",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="numeric",
                difficulty="medium",
                subcategory="optimization",
            ),
            MINTTask(
                id="decision-002",
                category=MINTCategory.DECISION_MAKING,
                description="Game theory decision",
                initial_prompt=(
                    "In a game, you can choose to cooperate (C) or defect (D). "
                    "If both cooperate, each gets 3 points. "
                    "If both defect, each gets 1 point. "
                    "If one defects and one cooperates, defector gets 5, cooperator gets 0. "
                    "In a one-shot game, what is the Nash equilibrium strategy? "
                    "Answer with 'cooperate' or 'defect'."
                ),
                ground_truth="defect",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="exact_match",
                difficulty="medium",
                subcategory="game_theory",
            ),
            MINTTask(
                id="decision-003",
                category=MINTCategory.DECISION_MAKING,
                description="Scheduling problem",
                initial_prompt=(
                    "You have 4 tasks with durations [2, 4, 1, 3] hours and deadlines "
                    "[4, 8, 2, 6] hours from now. Each task must be completed by its deadline. "
                    "What is the maximum number of tasks you can complete? "
                    "Assume tasks cannot be interrupted once started."
                ),
                ground_truth="3",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="numeric",
                difficulty="hard",
                subcategory="scheduling",
            ),
            MINTTask(
                id="decision-004",
                category=MINTCategory.DECISION_MAKING,
                description="Path finding",
                initial_prompt=(
                    "Find the shortest path length from node A to node D in this weighted graph.\n\n"
                    "Edges (bidirectional with weights):\n"
                    "- A to B: weight 4\n"
                    "- A to C: weight 2\n"
                    "- B to C: weight 1\n"
                    "- B to D: weight 5\n"
                    "- C to D: weight 8\n\n"
                    "What is the total weight of the shortest path from A to D? "
                    "Give just the number."
                ),
                ground_truth="7",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="numeric",
                difficulty="medium",
                subcategory="graph_algorithms",
            ),
        ]

        # Information Seeking tasks
        self.tasks[MINTCategory.INFORMATION_SEEKING] = [
            MINTTask(
                id="info-001",
                category=MINTCategory.INFORMATION_SEEKING,
                description="Extract and calculate from data",
                initial_prompt=(
                    "Given this sales data:\n"
                    "Q1: $15000, Q2: $22000, Q3: $18000, Q4: $25000\n"
                    "Calculate the average quarterly sales and the percentage increase "
                    "from Q1 to Q4. Format answer as: avg,percentage (e.g., 20000,50)"
                ),
                ground_truth="20000,66.67",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="partial_match",
                difficulty="easy",
                subcategory="data_analysis",
            ),
            MINTTask(
                id="info-002",
                category=MINTCategory.INFORMATION_SEEKING,
                description="Parse and process structured data",
                initial_prompt=(
                    "Parse this JSON and find the total age of all people:\n"
                    '{"people": [{"name": "Alice", "age": 30}, '
                    '{"name": "Bob", "age": 25}, {"name": "Charlie", "age": 35}]}'
                ),
                ground_truth="90",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="numeric",
                difficulty="easy",
                subcategory="data_parsing",
            ),
            MINTTask(
                id="info-003",
                category=MINTCategory.INFORMATION_SEEKING,
                description="Pattern recognition in data",
                initial_prompt=(
                    "Find the next number in this sequence: 2, 6, 12, 20, 30, ?"
                ),
                ground_truth="42",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="numeric",
                difficulty="medium",
                subcategory="patterns",
            ),
            MINTTask(
                id="info-004",
                category=MINTCategory.INFORMATION_SEEKING,
                description="Statistical analysis",
                initial_prompt=(
                    "Calculate the POPULATION standard deviation of this dataset:\n"
                    "[10, 12, 23, 23, 16, 23, 21, 16]\n\n"
                    "Use the formula: sqrt(sum((x - mean)^2) / n)\n"
                    "Round your final answer to 2 decimal places. Give just the number."
                ),
                ground_truth="4.90",
                max_turns=5,
                tools_allowed=["python"],
                evaluation_metric="numeric",
                difficulty="medium",
                subcategory="statistics",
            ),
        ]

        logger.info("[MINTDataset] Loaded built-in tasks for all categories")

    def get_tasks(
        self,
        categories: Optional[list[MINTCategory]] = None,
        limit: Optional[int] = None,
        difficulty: Optional[str] = None,
    ) -> list[MINTTask]:
        """
        Get tasks, optionally filtered by category and difficulty.

        Args:
            categories: List of categories to include (None = all)
            limit: Maximum number of tasks per category (None = all)
            difficulty: Filter by difficulty level (None = all)

        Returns:
            List of MINTTask objects
        """
        tasks: list[MINTTask] = []

        for cat, cat_tasks in self.tasks.items():
            if categories is not None and cat not in categories:
                continue

            filtered_tasks = cat_tasks
            if difficulty:
                filtered_tasks = [t for t in filtered_tasks if t.difficulty == difficulty]

            if limit:
                filtered_tasks = filtered_tasks[:limit]

            tasks.extend(filtered_tasks)

        return tasks

    def get_tasks_by_category(self, category: MINTCategory) -> list[MINTTask]:
        """Get all tasks for a specific category."""
        return self.tasks.get(category, [])

    def get_task_by_id(self, task_id: str) -> Optional[MINTTask]:
        """Get a specific task by ID."""
        for tasks in self.tasks.values():
            for task in tasks:
                if task.id == task_id:
                    return task
        return None

    def get_category_stats(self) -> dict[str, dict[str, int]]:
        """Get statistics about loaded tasks per category."""
        return {
            cat.value: {
                "total": len(tasks),
                "easy": len([t for t in tasks if t.difficulty == "easy"]),
                "medium": len([t for t in tasks if t.difficulty == "medium"]),
                "hard": len([t for t in tasks if t.difficulty == "hard"]),
            }
            for cat, tasks in self.tasks.items()
        }
