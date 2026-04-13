"""
GAIA Dataset Loader

Loads GAIA benchmark data from HuggingFace and handles file downloads.
"""

import json
import logging
from pathlib import Path

from elizaos_gaia.types import (
    AnnotatorMetadata,
    GAIALevel,
    GAIAQuestion,
    TaskCategory,
    ToolType,
)

logger = logging.getLogger(__name__)

# HuggingFace dataset info
DATASET_REPO = "gaia-benchmark/GAIA"
DATASET_FILES = {
    "validation": "2023/validation/metadata.jsonl",
    "test": "2023/test/metadata.jsonl",
}


class DatasetAccessError(RuntimeError):
    """Raised when the GAIA dataset cannot be accessed (e.g., gated/403)."""

    def __init__(self, message: str, *, is_gated: bool = False) -> None:
        super().__init__(message)
        self.is_gated = is_gated


class GAIADataset:
    """Loader for GAIA benchmark dataset from HuggingFace."""

    def __init__(self, cache_dir: str = ".cache/gaia"):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.validation_set: list[GAIAQuestion] = []
        self.test_set: list[GAIAQuestion] = []
        self._files_dir: Path | None = None

    async def load(
        self,
        split: str = "validation",
        hf_token: str | None = None,
        *,
        source: str = "gaia",
        dataset_path: str | None = None,
    ) -> list[GAIAQuestion]:
        """
        Load GAIA dataset from HuggingFace.

        Args:
            split: Dataset split ('validation' or 'test')
            hf_token: Optional HuggingFace token for gated datasets
            source: Dataset source ("gaia", "sample", or "jsonl")
            dataset_path: Path to local JSONL file when source="jsonl"

        Returns:
            List of GAIAQuestion objects

        Raises:
            ValueError: If split is not 'validation' or 'test'
            FileNotFoundError: If dataset cannot be found
            DatasetAccessError: If the GAIA dataset is gated or inaccessible
        """
        if split not in ("validation", "test"):
            raise ValueError(f"Invalid split '{split}'. Must be 'validation' or 'test'")

        if source == "sample":
            questions = self._load_sample_questions(split=split)
            if split == "validation":
                self.validation_set = questions
            else:
                self.test_set = questions
            logger.info(f"Loaded {len(questions)} sample questions ({split} split)")
            return questions

        if source == "jsonl":
            if not dataset_path:
                raise ValueError("dataset_path is required when source='jsonl'")
            path = Path(dataset_path)
            questions = await self._load_from_jsonl(path)
            if split == "validation":
                self.validation_set = questions
            else:
                self.test_set = questions
            logger.info(f"Loaded {len(questions)} questions from local JSONL: {path}")
            return questions

        if source != "gaia":
            raise ValueError(f"Invalid dataset source '{source}'. Must be 'gaia', 'sample', or 'jsonl'")

        logger.info(f"Loading GAIA dataset ({split} split) from HuggingFace...")

        try:
            # Try to use huggingface_hub for downloading
            from huggingface_hub import snapshot_download

            # Download the entire dataset snapshot to get files
            dataset_dir = snapshot_download(
                repo_id=DATASET_REPO,
                repo_type="dataset",
                cache_dir=str(self.cache_dir),
                token=hf_token,
                allow_patterns=[f"2023/{split}/*"],
            )

            self._files_dir = Path(dataset_dir) / "2023" / split

            # Load metadata
            metadata_path = self._files_dir / "metadata.jsonl"
            if not metadata_path.exists():
                raise FileNotFoundError(f"Metadata file not found: {metadata_path}")

            questions = await self._parse_metadata(metadata_path)

            if split == "validation":
                self.validation_set = questions
            else:
                self.test_set = questions

            logger.info(f"Loaded {len(questions)} questions from {split} split")
            return questions

        except ImportError:
            logger.warning("huggingface_hub not installed, trying local cache...")
            return await self._load_from_cache(split)
        except Exception as e:
            message = str(e)
            is_gated = (
                "Cannot access gated repo" in message
                or "Access to dataset" in message
                or "403" in message
            )
            if is_gated:
                raise DatasetAccessError(
                    "GAIA dataset access denied (gated). "
                    "Request access at https://huggingface.co/datasets/gaia-benchmark/GAIA "
                    "and provide a token via HF_TOKEN or --hf-token.",
                    is_gated=True,
                ) from e
            raise

    async def _load_from_jsonl(self, path: Path) -> list[GAIAQuestion]:
        """Load questions from a local JSONL file."""
        if not path.exists():
            raise FileNotFoundError(f"Dataset file not found: {path}")

        # If the JSONL is alongside attachments, allow resolving relative file_name
        self._files_dir = path.parent

        questions: list[GAIAQuestion] = []
        with open(path, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                data = json.loads(line)
                if not isinstance(data, dict):
                    continue
                normalized: dict[str, object] = {str(k): v for k, v in data.items()}
                questions.append(self._parse_question(normalized))

        return questions

    def _load_sample_questions(self, *, split: str) -> list[GAIAQuestion]:
        """
        Load a built-in sample dataset.

        This is used to validate the benchmark end-to-end without requiring gated
        GAIA HuggingFace access. These are NOT official GAIA questions.
        """
        _ = split  # Sample dataset is split-agnostic

        sample: list[dict[str, object]] = [
            {
                "task_id": "S1-001",
                "question": "What is 25 times 4?",
                "level": "1",
                "final_answer": "100",
            },
            {
                "task_id": "S1-002",
                "question": "If a train travels 120 kilometers in 2 hours, what is its speed in km/h?",
                "level": "1",
                "final_answer": "60",
            },
            {
                "task_id": "S2-001",
                "question": "A rectangular garden is 20 meters long and 15 meters wide. A path 2 meters wide surrounds it. What is the area of the path?",
                "level": "2",
                "final_answer": "156",
            },
            {
                "task_id": "S2-002",
                "question": "What is 15% of 200?",
                "level": "2",
                "final_answer": "30",
            },
            {
                "task_id": "S3-001",
                "question": "Compute 2 to the power of 10.",
                "level": "3",
                "final_answer": "1024",
            },
        ]

        return [self._parse_question(item) for item in sample]
    async def _parse_metadata(self, metadata_path: Path) -> list[GAIAQuestion]:
        """Parse metadata JSONL file into GAIAQuestion objects."""
        questions: list[GAIAQuestion] = []

        with open(metadata_path, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue

                data = json.loads(line)
                question = self._parse_question(data)
                questions.append(question)

        return questions

    def _parse_question(self, data: dict[str, object]) -> GAIAQuestion:
        """Parse a single question from JSON data.

        Args:
            data: Dictionary containing question data from GAIA dataset

        Returns:
            Validated GAIAQuestion object

        Raises:
            ValueError: If required fields are missing or invalid
        """
        # Validate required fields
        task_id = data.get("task_id") or data.get("Task ID")
        if not task_id:
            raise ValueError("Missing required field: task_id")

        question_text = data.get("Question") or data.get("question")
        if not question_text:
            raise ValueError(f"Missing required field 'question' for task {task_id}")

        final_answer = data.get("Final answer") or data.get("final_answer")
        if final_answer is None:
            # For test set, final_answer may be hidden
            final_answer = ""

        # Parse level with validation
        level_raw = data.get("Level", data.get("level", "1"))
        level_str = str(level_raw)
        if level_str not in ("1", "2", "3"):
            raise ValueError(f"Invalid level '{level_str}' for task {task_id}. Must be 1, 2, or 3")
        level = GAIALevel(level_str)

        # Parse annotator metadata if present
        annotator_metadata = None
        if "Annotator Metadata" in data:
            meta = data["Annotator Metadata"]
            if isinstance(meta, dict):
                annotator_metadata = AnnotatorMetadata(
                    steps=meta.get("Steps", []),
                    tools=meta.get("Tools", []),
                    number_of_steps=meta.get("Number of steps", 0),
                    time_taken_in_mins=meta.get("How long did this take?", 0.0),
                )

        # Determine file path if file is attached
        file_name = data.get("file_name") or data.get("File name")
        file_path = None
        if file_name and self._files_dir:
            potential_path = self._files_dir / file_name
            if potential_path.exists():
                file_path = potential_path

        # Create question object with validated fields
        question = GAIAQuestion(
            task_id=str(task_id),
            question=str(question_text),
            level=level,
            final_answer=str(final_answer),
            file_name=file_name,
            file_path=file_path,
            annotator_metadata=annotator_metadata,
        )

        # Infer required tools from metadata
        question.required_tools = self._infer_tools(question)
        question.categories = self._infer_categories(question)

        return question

    def _infer_tools(self, question: GAIAQuestion) -> list[ToolType]:
        """Infer required tools from question metadata and content."""
        tools: list[ToolType] = []

        # From annotator metadata
        if question.annotator_metadata:
            for tool in question.annotator_metadata.tools:
                tool_lower = tool.lower()
                if "search" in tool_lower or "google" in tool_lower:
                    tools.append(ToolType.WEB_SEARCH)
                elif "browser" in tool_lower or "navigate" in tool_lower:
                    tools.append(ToolType.WEB_BROWSE)
                elif "python" in tool_lower or "code" in tool_lower:
                    tools.append(ToolType.CODE_EXEC)
                elif "calculator" in tool_lower:
                    tools.append(ToolType.CALCULATOR)
                elif "image" in tool_lower or "vision" in tool_lower:
                    tools.append(ToolType.IMAGE_ANALYSIS)

        # From file type
        if question.file_name:
            ext = Path(question.file_name).suffix.lower()
            if ext == ".pdf":
                tools.append(ToolType.PDF_READ)
            elif ext in [".png", ".jpg", ".jpeg", ".gif", ".webp"]:
                tools.append(ToolType.IMAGE_ANALYSIS)
            elif ext in [".xlsx", ".xls", ".csv"]:
                tools.append(ToolType.SPREADSHEET_READ)
            elif ext in [".mp3", ".wav", ".m4a"]:
                tools.append(ToolType.AUDIO_TRANSCRIBE)
            else:
                tools.append(ToolType.FILE_READ)

        # From question content
        question_lower = question.question.lower()
        if "search" in question_lower or "find online" in question_lower:
            if ToolType.WEB_SEARCH not in tools:
                tools.append(ToolType.WEB_SEARCH)
        if "website" in question_lower or "webpage" in question_lower or "url" in question_lower:
            if ToolType.WEB_BROWSE not in tools:
                tools.append(ToolType.WEB_BROWSE)
        if "calculate" in question_lower or "compute" in question_lower:
            if ToolType.CALCULATOR not in tools:
                tools.append(ToolType.CALCULATOR)

        return list(set(tools))

    def _infer_categories(self, question: GAIAQuestion) -> list[TaskCategory]:
        """Infer task categories from question content and tools."""
        categories: list[TaskCategory] = []

        tools = question.required_tools

        if ToolType.WEB_SEARCH in tools or ToolType.WEB_BROWSE in tools:
            categories.append(TaskCategory.WEB_BROWSING)

        file_tools = [
            ToolType.FILE_READ, ToolType.PDF_READ,
            ToolType.SPREADSHEET_READ, ToolType.AUDIO_TRANSCRIBE
        ]
        if any(t in tools for t in file_tools):
            categories.append(TaskCategory.FILE_PROCESSING)

        if ToolType.CALCULATOR in tools or ToolType.CODE_EXEC in tools:
            categories.append(TaskCategory.CALCULATIONS)

        if ToolType.IMAGE_ANALYSIS in tools:
            categories.append(TaskCategory.MULTIMODAL)

        # Multi-step reasoning for Level 2+
        if question.level in [GAIALevel.LEVEL_2, GAIALevel.LEVEL_3]:
            categories.append(TaskCategory.MULTI_STEP_REASONING)

        if len(tools) > 0:
            categories.append(TaskCategory.TOOL_USE)

        return list(set(categories))

    async def _load_from_cache(self, split: str) -> list[GAIAQuestion]:
        """Load from local cache if HuggingFace download fails."""
        cache_file = self.cache_dir / f"{split}_questions.json"

        if not cache_file.exists():
            raise FileNotFoundError(
                f"No cached data found at {cache_file}. "
                "Please install huggingface_hub: pip install huggingface_hub"
            )

        with open(cache_file) as f:
            data = json.load(f)

        questions = [self._parse_question(q) for q in data]

        if split == "validation":
            self.validation_set = questions
        else:
            self.test_set = questions

        return questions

    def get_by_level(
        self,
        level: GAIALevel,
        split: str = "validation"
    ) -> list[GAIAQuestion]:
        """Filter questions by difficulty level."""
        questions = self.validation_set if split == "validation" else self.test_set
        return [q for q in questions if q.level == level]

    def get_by_category(
        self,
        category: TaskCategory,
        split: str = "validation"
    ) -> list[GAIAQuestion]:
        """Filter questions by task category."""
        questions = self.validation_set if split == "validation" else self.test_set
        return [q for q in questions if category in q.categories]

    def get_with_files(self, split: str = "validation") -> list[GAIAQuestion]:
        """Get questions that have associated files."""
        questions = self.validation_set if split == "validation" else self.test_set
        return [q for q in questions if q.file_name is not None]

    def get_stats(self, split: str = "validation") -> dict:
        """Get dataset statistics."""
        questions = self.validation_set if split == "validation" else self.test_set

        stats = {
            "total": len(questions),
            "by_level": {},
            "by_category": {},
            "with_files": 0,
            "tool_distribution": {},
        }

        for level in GAIALevel:
            count = len([q for q in questions if q.level == level])
            stats["by_level"][level.value] = count

        for category in TaskCategory:
            count = len([q for q in questions if category in q.categories])
            stats["by_category"][category.value] = count

        stats["with_files"] = len([q for q in questions if q.file_name])

        for question in questions:
            for tool in question.required_tools:
                stats["tool_distribution"][tool.value] = (
                    stats["tool_distribution"].get(tool.value, 0) + 1
                )

        return stats
