"""
BFCL Dataset Loader

Loads the Berkeley Function-Calling Leaderboard dataset from HuggingFace
or local files and converts to internal types.
"""

import json
import logging
from pathlib import Path
from typing import Iterator, Optional

from benchmarks.bfcl.types import (
    ArgumentValue,
    BFCLCategory,
    BFCLConfig,
    BFCLLanguage,
    BFCLTestCase,
    FunctionCall,
    FunctionDefinition,
    FunctionParameter,
)

logger = logging.getLogger(__name__)


class BFCLDataset:
    """Loader and iterator for BFCL benchmark dataset."""

    # Mapping from BFCL dataset file names to categories
    CATEGORY_FILES: dict[str, BFCLCategory] = {
        "simple": BFCLCategory.SIMPLE,
        "multiple_function": BFCLCategory.MULTIPLE,
        "parallel_function": BFCLCategory.PARALLEL,
        "parallel_multiple_function": BFCLCategory.PARALLEL_MULTIPLE,
        "relevance": BFCLCategory.RELEVANCE,
        "rest": BFCLCategory.REST_API,
        "sql": BFCLCategory.SQL,
        "java": BFCLCategory.JAVA,
        "javascript": BFCLCategory.JAVASCRIPT,
    }
    
    # V3 file name to category mapping
    V3_CATEGORY_FILES: dict[str, BFCLCategory] = {
        "BFCL_v3_simple": BFCLCategory.SIMPLE,
        "BFCL_v3_multiple": BFCLCategory.MULTIPLE,
        "BFCL_v3_parallel": BFCLCategory.PARALLEL,
        "BFCL_v3_parallel_multiple": BFCLCategory.PARALLEL_MULTIPLE,
        "BFCL_v3_relevance": BFCLCategory.RELEVANCE,
        "BFCL_v3_irrelevance": BFCLCategory.RELEVANCE,
        "BFCL_v3_rest": BFCLCategory.REST_API,
        "BFCL_v3_sql": BFCLCategory.SQL,
        "BFCL_v3_java": BFCLCategory.JAVA,
        "BFCL_v3_javascript": BFCLCategory.JAVASCRIPT,
    }

    def __init__(self, config: BFCLConfig):
        self.config = config
        self._test_cases: list[BFCLTestCase] = []
        self._loaded = False
        self._ground_truth: dict[str, list[dict[str, object]]] = {}  # id -> ground_truth calls

    async def load(self) -> None:
        """Load BFCL dataset from HuggingFace or local files."""
        if self._loaded:
            return

        if self.config.use_huggingface:
            await self._load_from_huggingface()
        else:
            await self._load_from_local()

        self._loaded = True
        logger.info(f"Loaded {len(self._test_cases)} BFCL test cases")

    async def _load_from_huggingface(self) -> None:
        """Load dataset from HuggingFace cache or download."""
        logger.info(f"Loading BFCL from HuggingFace: {self.config.huggingface_dataset}")
        
        # First, ensure data is downloaded to cache
        await self._ensure_dataset_cached()
        
        # Load all ground truth from possible_answer directory
        await self._load_ground_truth_from_cache()

        # Load data files directly from cache (NDJSON format)
        # This bypasses HuggingFace's schema inconsistency issues
        data_files_to_load = [
            ("simple", "BFCL_v3_simple.json", BFCLCategory.SIMPLE),
            ("multiple", "BFCL_v3_multiple.json", BFCLCategory.MULTIPLE),
            ("parallel", "BFCL_v3_parallel.json", BFCLCategory.PARALLEL),
            ("parallel_multiple", "BFCL_v3_parallel_multiple.json", BFCLCategory.PARALLEL_MULTIPLE),
            ("rest", "BFCL_v3_rest.json", BFCLCategory.REST_API),
            ("sql", "BFCL_v3_sql.json", BFCLCategory.SQL),
            ("java", "BFCL_v3_java.json", BFCLCategory.JAVA),
            ("javascript", "BFCL_v3_javascript.json", BFCLCategory.JAVASCRIPT),
            # Relevance tests (check if model correctly declines irrelevant queries)
            ("relevance", "BFCL_v3_live_relevance.json", BFCLCategory.RELEVANCE),
            ("irrelevance", "BFCL_v3_irrelevance.json", BFCLCategory.RELEVANCE),
        ]

        for file_key, file_name, category in data_files_to_load:
            # Skip if category not in configured categories
            if self.config.categories and category not in self.config.categories:
                continue

            count = await self._load_from_cache_file(file_key, file_name, category)
            if count > 0:
                logger.info(f"Loaded {count} test cases from {file_name}")
    
    async def _ensure_dataset_cached(self) -> None:
        """Ensure dataset is downloaded to HuggingFace cache."""
        from pathlib import Path
        
        cache_base = Path.home() / ".cache" / "huggingface" / "hub"
        dataset_dir = cache_base / "datasets--gorilla-llm--Berkeley-Function-Calling-Leaderboard"
        
        if dataset_dir.exists():
            snapshots_dir = dataset_dir / "snapshots"
            if snapshots_dir.exists() and list(snapshots_dir.iterdir()):
                logger.debug("BFCL dataset already in cache")
                return
        
        # Download dataset to cache using huggingface_hub
        logger.info("Downloading BFCL dataset to cache...")
        try:
            from huggingface_hub import snapshot_download
            snapshot_download(
                repo_id="gorilla-llm/Berkeley-Function-Calling-Leaderboard",
                repo_type="dataset",
            )
            logger.info("BFCL dataset downloaded to cache")
        except ImportError:
            logger.warning("huggingface_hub not installed, trying datasets library")
            try:
                from datasets import load_dataset
                # Just load one split to trigger caching
                load_dataset(
                    self.config.huggingface_dataset,
                    data_files="BFCL_v3_simple.json",
                    split="train",
                )
            except Exception as e:
                logger.warning(f"Could not download dataset: {e}")
    
    async def _load_from_cache_file(
        self,
        file_key: str,
        file_name: str,
        category: BFCLCategory,
    ) -> int:
        """Load data from a cached NDJSON file."""
        from pathlib import Path
        
        cache_base = Path.home() / ".cache" / "huggingface" / "hub"
        dataset_dir = cache_base / "datasets--gorilla-llm--Berkeley-Function-Calling-Leaderboard"
        
        if not dataset_dir.exists():
            logger.warning(f"Dataset not in cache: {dataset_dir}")
            return 0
        
        # Find snapshot directory
        snapshots_dir = dataset_dir / "snapshots"
        if not snapshots_dir.exists():
            return 0
        
        snapshot_dirs = list(snapshots_dir.iterdir())
        if not snapshot_dirs:
            return 0
        
        snapshot_dir = snapshot_dirs[0]
        data_file = snapshot_dir / file_name
        
        if not data_file.exists():
            logger.debug(f"Data file not found: {data_file}")
            return 0
        
        count = 0
        max_tests = self.config.max_tests_per_category
        
        try:
            with open(data_file, encoding="utf-8") as f:
                for idx, line in enumerate(f):
                    if max_tests and count >= max_tests:
                        break
                    
                    line = line.strip()
                    if not line:
                        continue
                    
                    try:
                        item = json.loads(line)
                        test_case = self._parse_test_case(item, category, f"{file_key}_{idx}")
                        if test_case:
                            self._test_cases.append(test_case)
                            count += 1
                    except json.JSONDecodeError as e:
                        logger.debug(f"Failed to parse line {idx} in {file_name}: {e}")
        
        except Exception as e:
            logger.warning(f"Error loading {file_name}: {e}")
        
        return count
    
    async def _load_ground_truth_from_cache(self) -> None:
        """Load ground truth from HuggingFace cache's possible_answer directory."""
        from pathlib import Path
        
        # Find the HuggingFace cache directory
        cache_base = Path.home() / ".cache" / "huggingface" / "hub"
        dataset_dir = cache_base / "datasets--gorilla-llm--Berkeley-Function-Calling-Leaderboard"
        
        if not dataset_dir.exists():
            logger.debug("BFCL dataset not in cache, ground truth not available yet")
            return
        
        # Find the snapshots directory
        snapshots_dir = dataset_dir / "snapshots"
        if not snapshots_dir.exists():
            return
        
        # Get the latest snapshot
        snapshot_dirs = list(snapshots_dir.iterdir())
        if not snapshot_dirs:
            return
        
        # Use the first (usually only) snapshot
        snapshot_dir = snapshot_dirs[0]
        possible_answer_dir = snapshot_dir / "possible_answer"
        
        if not possible_answer_dir.exists():
            logger.debug("possible_answer directory not found in BFCL cache")
            return
        
        # Load all ground truth files
        for gt_file in possible_answer_dir.glob("*.json"):
            try:
                with open(gt_file) as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        item = json.loads(line)
                        test_id = item.get("id", "")
                        ground_truth = item.get("ground_truth", [])
                        if test_id and ground_truth:
                            self._ground_truth[test_id] = ground_truth
            except Exception as e:
                logger.debug(f"Error loading ground truth from {gt_file}: {e}")
        
        if self._ground_truth:
            logger.info(f"Loaded ground truth for {len(self._ground_truth)} test cases")

    async def _load_from_local(self) -> None:
        """Load dataset from local JSON files."""
        data_path = Path(self.config.data_path)

        if not data_path.exists():
            raise FileNotFoundError(f"BFCL data path not found: {data_path}")

        for file_name, category in self.CATEGORY_FILES.items():
            # Skip if category not in configured categories
            if (
                self.config.categories
                and category not in self.config.categories
            ):
                continue

            file_path = data_path / f"{file_name}.json"
            if not file_path.exists():
                logger.warning(f"Category file not found: {file_path}")
                continue

            with open(file_path) as f:
                data = json.load(f)

            count = 0
            max_tests = self.config.max_tests_per_category

            for idx, item in enumerate(data):
                if max_tests and count >= max_tests:
                    break

                test_case = self._parse_test_case(item, category, f"{file_name}_{idx}")
                if test_case:
                    self._test_cases.append(test_case)
                    count += 1

            logger.info(f"Loaded {count} test cases for category {category.value}")


    def _parse_test_case(
        self,
        item: dict[str, object],
        category: BFCLCategory,
        default_id: str,
    ) -> Optional[BFCLTestCase]:
        """Parse a raw dataset item into a BFCLTestCase."""
        try:
            test_id = str(item.get("id", default_id))
            question = str(item.get("question", item.get("prompt", "")))

            # Parse functions
            functions_raw = item.get("function", item.get("functions", []))
            if isinstance(functions_raw, dict):
                functions_raw = [functions_raw]
            elif not isinstance(functions_raw, list):
                functions_raw = []

            functions: list[FunctionDefinition] = []
            for f in functions_raw:
                if isinstance(f, dict):
                    functions.append(self._parse_function_definition(f))

            # Parse expected calls - check ground truth from possible_answer files first
            expected_calls: list[FunctionCall] = []
            
            # First check if we have ground truth from the possible_answer directory
            if test_id in self._ground_truth:
                gt_list = self._ground_truth[test_id]
                expected_calls = self._parse_ground_truth_calls(gt_list)
            else:
                # Fall back to expected_call or ground_truth in the item
                expected_raw = item.get("expected_call", item.get("ground_truth", []))
                if isinstance(expected_raw, dict):
                    expected_raw = [expected_raw]
                elif isinstance(expected_raw, str):
                    # Try to parse as JSON
                    try:
                        expected_raw = json.loads(expected_raw)
                        if isinstance(expected_raw, dict):
                            expected_raw = [expected_raw]
                    except json.JSONDecodeError:
                        expected_raw = []
                elif not isinstance(expected_raw, list):
                    expected_raw = []

                expected_calls = [
                    self._parse_function_call(c) for c in expected_raw if c
                ]

            # Determine if relevant (for relevance detection tests)
            is_relevant = True
            if category == BFCLCategory.RELEVANCE:
                # Relevance tests check if model correctly identifies relevant queries
                # If file name contains "irrelevance", these are negative examples
                test_id_lower = test_id.lower()
                if "irrelevance" in test_id_lower or "irrelevant" in test_id_lower:
                    is_relevant = False
                else:
                    # For relevance tests, is_relevant is True if expected calls exist
                    is_relevant = len(expected_calls) > 0 or bool(item.get("is_relevant", True))

            # Determine language
            language = BFCLLanguage.PYTHON
            if category == BFCLCategory.JAVA:
                language = BFCLLanguage.JAVA
            elif category == BFCLCategory.JAVASCRIPT:
                language = BFCLLanguage.JAVASCRIPT
            elif category == BFCLCategory.SQL:
                language = BFCLLanguage.SQL
            elif category == BFCLCategory.REST_API:
                language = BFCLLanguage.REST

            # Validate and convert ground_truth_output
            ground_truth_raw = item.get("expected_output")
            ground_truth_output: Optional[str] = None
            if ground_truth_raw is not None:
                ground_truth_output = str(ground_truth_raw)

            # Determine if we have valid ground truth for AST evaluation
            # REST API category uses execution-based evaluation, not AST matching
            # Relevance tests evaluate detection, not function call accuracy
            has_ground_truth = len(expected_calls) > 0
            
            # For relevance tests, we evaluate detection accuracy, not AST
            if category == BFCLCategory.RELEVANCE:
                # Relevance tests always have ground truth (the is_relevant flag)
                has_ground_truth = True
            
            # REST API has no ground truth in possible_answer directory
            if category == BFCLCategory.REST_API and not expected_calls:
                has_ground_truth = False
                logger.debug(f"Test {test_id} (REST API) requires execution-based evaluation")

            return BFCLTestCase(
                id=test_id,
                category=category,
                question=question,
                functions=functions,
                expected_calls=expected_calls,
                is_relevant=is_relevant,
                language=language,
                ground_truth_output=ground_truth_output,
                has_ground_truth=has_ground_truth,
                metadata={
                    k: v
                    for k, v in item.items()
                    if k not in ("id", "question", "function", "functions",
                                 "expected_call", "ground_truth", "prompt",
                                 "expected_output")
                    and isinstance(v, (str, int, float, bool))
                },
            )

        except Exception as e:
            logger.error(f"Failed to parse test case {default_id}: {e}")
            return None

    def _parse_function_definition(self, func: dict[str, object]) -> FunctionDefinition:
        """Parse a function definition from raw dict."""
        name = str(func.get("name", "unknown"))
        description = str(func.get("description", ""))

        # Parse parameters
        params_raw = func.get("parameters", {})
        if isinstance(params_raw, dict):
            properties = params_raw.get("properties", {})
            required = params_raw.get("required", [])
        else:
            properties = {}
            required = []

        parameters = {}
        if isinstance(properties, dict):
            for param_name, param_info in properties.items():
                if not isinstance(param_info, dict):
                    continue
                parameters[param_name] = FunctionParameter(
                    name=param_name,
                    param_type=str(param_info.get("type", "string")),
                    description=str(param_info.get("description", "")),
                    required=param_name in required,
                    enum=param_info.get("enum"),
                    default=param_info.get("default"),
                    items=param_info.get("items"),
                    properties=param_info.get("properties"),
                )

        return FunctionDefinition(
            name=name,
            description=description,
            parameters=parameters,
            required_params=list(required) if isinstance(required, list) else [],
            return_type=str(func.get("return_type", "")),
        )

    def _parse_ground_truth_calls(self, gt_list: list[dict[str, object]]) -> list[FunctionCall]:
        """
        Parse BFCL ground truth format into FunctionCall objects.
        
        BFCL format: [{"function_name": {"param1": [value1], "param2": [value2]}}, ...]
        Each value is a list of acceptable values.
        """
        calls: list[FunctionCall] = []
        
        for item in gt_list:
            if not isinstance(item, dict):
                continue
            
            # Each item is {"function_name": {"arg1": [val1], ...}}
            for func_name, params in item.items():
                if not isinstance(params, dict):
                    continue
                
                # Convert the BFCL format to our FunctionCall format
                # Take the first value from each parameter's list
                arguments: dict[str, object] = {}
                for param_name, param_values in params.items():
                    if isinstance(param_values, list) and len(param_values) > 0:
                        # Take the first acceptable value (or empty string if empty)
                        value = param_values[0]
                        if value == "":
                            # Empty string means use the second value if available
                            if len(param_values) > 1:
                                value = param_values[1]
                        arguments[param_name] = value
                    else:
                        arguments[param_name] = param_values
                
                calls.append(FunctionCall(name=func_name, arguments=arguments))
        
        return calls

    def _parse_function_call(self, call: dict[str, object]) -> FunctionCall:
        """Parse a function call from raw dict."""
        name = str(call.get("name", "unknown"))
        arguments_raw = call.get("arguments", call.get("parameters", {}))

        if isinstance(arguments_raw, str):
            try:
                arguments_raw = json.loads(arguments_raw)
            except json.JSONDecodeError:
                arguments_raw = {}

        # Ensure arguments is a dict with valid types
        arguments: dict[str, ArgumentValue] = {}
        if isinstance(arguments_raw, dict):
            arguments = self._validate_arguments(arguments_raw)

        return FunctionCall(name=name, arguments=arguments)

    def _validate_arguments(self, args: dict[str, object]) -> dict[str, ArgumentValue]:
        """Validate and normalize argument values."""
        validated: dict[str, ArgumentValue] = {}
        for key, value in args.items():
            if not isinstance(key, str):
                continue
            validated[key] = self._validate_argument_value(value)
        return validated

    def _validate_argument_value(self, value: object) -> ArgumentValue:
        """Validate a single argument value, recursively if needed."""
        if value is None:
            return None
        if isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, list):
            return [self._validate_argument_value(v) for v in value]
        if isinstance(value, dict):
            return {
                str(k): self._validate_argument_value(v)
                for k, v in value.items()
            }
        # Convert unknown types to string
        return str(value)

    def __iter__(self) -> Iterator[BFCLTestCase]:
        """Iterate over all test cases."""
        return iter(self._test_cases)

    def __len__(self) -> int:
        """Return number of test cases."""
        return len(self._test_cases)

    def get_by_category(self, category: BFCLCategory) -> Iterator[BFCLTestCase]:
        """Get test cases for a specific category."""
        for test_case in self._test_cases:
            if test_case.category == category:
                yield test_case

    def get_categories(self) -> list[BFCLCategory]:
        """Get list of categories present in the dataset."""
        return list(set(tc.category for tc in self._test_cases))

    def get_sample(
        self,
        n: int,
        categories: Optional[list[BFCLCategory]] = None,
    ) -> list[BFCLTestCase]:
        """Get a stratified sample of test cases."""
        import random

        if categories is None:
            categories = self.get_categories()

        samples_per_category = max(1, n // len(categories))
        samples: list[BFCLTestCase] = []

        for category in categories:
            category_cases = list(self.get_by_category(category))
            if category_cases:
                sample_size = min(samples_per_category, len(category_cases))
                samples.extend(random.sample(category_cases, sample_size))

        # If we need more samples, add randomly
        remaining = n - len(samples)
        if remaining > 0:
            remaining_cases = [tc for tc in self._test_cases if tc not in samples]
            if remaining_cases:
                samples.extend(
                    random.sample(remaining_cases, min(remaining, len(remaining_cases)))
                )

        return samples[:n]

    def get_statistics(self) -> dict[str, int | float]:
        """Get dataset statistics."""
        stats: dict[str, int | float] = {
            "total_test_cases": len(self._test_cases),
        }

        # Count per category
        for category in BFCLCategory:
            count = sum(1 for tc in self._test_cases if tc.category == category)
            stats[f"category_{category.value}"] = count

        # Count relevance split
        relevant = sum(1 for tc in self._test_cases if tc.is_relevant)
        stats["relevant_tests"] = relevant
        stats["irrelevant_tests"] = len(self._test_cases) - relevant

        # Average functions per test
        total_functions = sum(len(tc.functions) for tc in self._test_cases)
        if self._test_cases:
            stats["avg_functions_per_test"] = total_functions / len(self._test_cases)
        else:
            stats["avg_functions_per_test"] = 0.0

        return stats
