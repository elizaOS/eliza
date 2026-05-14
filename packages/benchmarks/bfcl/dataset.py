"""
BFCL Dataset Loader

Loads the Berkeley Function-Calling Leaderboard dataset from HuggingFace
or local files and converts to internal types.

Supports the full v3/v4 category taxonomy:
    - non-live single-turn: simple, multiple, parallel, parallel_multiple,
      relevance, irrelevance, rest, sql, java, javascript
    - live (user-contributed) single-turn: live_simple, live_multiple,
      live_parallel, live_parallel_multiple, live_relevance, live_irrelevance
    - multi-turn: multi_turn_base, multi_turn_miss_func,
      multi_turn_miss_param, multi_turn_long_context
    - agentic (v4): web_search_base, web_search_no_snippet, memory_kv,
      memory_vector, memory_rec_sum
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

    # V3 file name -> category. Includes the live_* and multi_turn_*
    # variants that ship in the v3 HuggingFace dataset.
    V3_CATEGORY_FILES: dict[str, BFCLCategory] = {
        "BFCL_v3_simple": BFCLCategory.SIMPLE,
        "BFCL_v3_multiple": BFCLCategory.MULTIPLE,
        "BFCL_v3_parallel": BFCLCategory.PARALLEL,
        "BFCL_v3_parallel_multiple": BFCLCategory.PARALLEL_MULTIPLE,
        "BFCL_v3_relevance": BFCLCategory.RELEVANCE,
        "BFCL_v3_irrelevance": BFCLCategory.IRRELEVANCE,
        "BFCL_v3_rest": BFCLCategory.REST_API,
        "BFCL_v3_sql": BFCLCategory.SQL,
        "BFCL_v3_java": BFCLCategory.JAVA,
        "BFCL_v3_javascript": BFCLCategory.JAVASCRIPT,
        # Live (user-contributed)
        "BFCL_v3_live_simple": BFCLCategory.LIVE_SIMPLE,
        "BFCL_v3_live_multiple": BFCLCategory.LIVE_MULTIPLE,
        "BFCL_v3_live_parallel": BFCLCategory.LIVE_PARALLEL,
        "BFCL_v3_live_parallel_multiple": BFCLCategory.LIVE_PARALLEL_MULTIPLE,
        "BFCL_v3_live_relevance": BFCLCategory.LIVE_RELEVANCE,
        "BFCL_v3_live_irrelevance": BFCLCategory.LIVE_IRRELEVANCE,
        # Multi-turn
        "BFCL_v3_multi_turn_base": BFCLCategory.MULTI_TURN_BASE,
        "BFCL_v3_multi_turn_miss_func": BFCLCategory.MULTI_TURN_MISS_FUNC,
        "BFCL_v3_multi_turn_miss_param": BFCLCategory.MULTI_TURN_MISS_PARAM,
        "BFCL_v3_multi_turn_long_context": BFCLCategory.MULTI_TURN_LONG_CONTEXT,
    }

    # V4 file name -> category (adds agentic / web_search / memory).
    V4_CATEGORY_FILES: dict[str, BFCLCategory] = {
        "BFCL_v4_simple_python": BFCLCategory.SIMPLE,
        "BFCL_v4_simple_java": BFCLCategory.JAVA,
        "BFCL_v4_simple_javascript": BFCLCategory.JAVASCRIPT,
        "BFCL_v4_multiple": BFCLCategory.MULTIPLE,
        "BFCL_v4_parallel": BFCLCategory.PARALLEL,
        "BFCL_v4_parallel_multiple": BFCLCategory.PARALLEL_MULTIPLE,
        "BFCL_v4_irrelevance": BFCLCategory.IRRELEVANCE,
        # Live
        "BFCL_v4_live_simple": BFCLCategory.LIVE_SIMPLE,
        "BFCL_v4_live_multiple": BFCLCategory.LIVE_MULTIPLE,
        "BFCL_v4_live_parallel": BFCLCategory.LIVE_PARALLEL,
        "BFCL_v4_live_parallel_multiple": BFCLCategory.LIVE_PARALLEL_MULTIPLE,
        "BFCL_v4_live_relevance": BFCLCategory.LIVE_RELEVANCE,
        "BFCL_v4_live_irrelevance": BFCLCategory.LIVE_IRRELEVANCE,
        # Multi-turn
        "BFCL_v4_multi_turn_base": BFCLCategory.MULTI_TURN_BASE,
        "BFCL_v4_multi_turn_miss_func": BFCLCategory.MULTI_TURN_MISS_FUNC,
        "BFCL_v4_multi_turn_miss_param": BFCLCategory.MULTI_TURN_MISS_PARAM,
        "BFCL_v4_multi_turn_long_context": BFCLCategory.MULTI_TURN_LONG_CONTEXT,
        # Agentic
        "BFCL_v4_web_search": BFCLCategory.WEB_SEARCH_BASE,
        "BFCL_v4_memory": BFCLCategory.MEMORY_KV,
        "BFCL_v4_format_sensitivity": BFCLCategory.FORMAT_SENSITIVITY,
    }

    def __init__(self, config: BFCLConfig):
        self.config = config
        self._test_cases: list[BFCLTestCase] = []
        self._loaded = False
        # Ground-truth payload is heterogeneous:
        #   - single-turn: list[dict{func_name: {param: [allowed_values]}}]
        #   - multi-turn:  list[list[str]] (per-turn list of python call strings)
        #   - agentic:     arbitrary (memory state, expected answer, ...)
        self._ground_truth: dict[str, object] = {}

    async def load(self) -> None:
        """Load BFCL dataset from HuggingFace or local files."""
        if self._loaded:
            return

        if self.config.use_huggingface:
            await self._load_from_huggingface()
        else:
            await self._load_from_local()

        # Upstream packs web_search_base and web_search_no_snippet into the
        # same source file, distinguishing them via a per-entry ``show_snippet``
        # flag tied to the test id. Split them apart now so consumers asking
        # for ``WEB_SEARCH_NO_SNIPPET`` get exactly those entries.
        self._finalize_web_search_split()

        self._loaded = True
        logger.info(f"Loaded {len(self._test_cases)} BFCL test cases")

    def _finalize_web_search_split(self) -> None:
        """Partition the loaded WEB_SEARCH_BASE entries into base + no_snippet
        buckets, mirroring upstream's ``process_web_search_test_case``.

        Upstream uses one source file for both categories and distinguishes
        them via a per-entry ``show_snippet`` initial-config flag. Without
        this method, the no_snippet bucket would always be empty.
        """
        cats_wanted = self.config.categories or []
        want_no_snippet = (
            not cats_wanted or BFCLCategory.WEB_SEARCH_NO_SNIPPET in cats_wanted
        )
        want_base = (
            not cats_wanted or BFCLCategory.WEB_SEARCH_BASE in cats_wanted
        )

        explicit_no_snippet: list[BFCLTestCase] = []
        kept_base: list[BFCLTestCase] = []
        for tc in self._test_cases:
            if tc.category != BFCLCategory.WEB_SEARCH_BASE:
                continue
            if "no_snippet" in tc.id.lower():
                explicit_no_snippet.append(tc)
            else:
                kept_base.append(tc)

        self._test_cases = [
            tc
            for tc in self._test_cases
            if tc.category != BFCLCategory.WEB_SEARCH_BASE
        ]

        for tc in explicit_no_snippet:
            tc.category = BFCLCategory.WEB_SEARCH_NO_SNIPPET

        synthesized_no_snippet: list[BFCLTestCase] = []
        if want_no_snippet:
            from dataclasses import replace as _replace
            for tc in kept_base:
                synthesized_no_snippet.append(
                    _replace(
                        tc,
                        id=tc.id.replace(
                            "web_search", "web_search_no_snippet", 1
                        ) if "web_search" in tc.id else f"{tc.id}_no_snippet",
                        category=BFCLCategory.WEB_SEARCH_NO_SNIPPET,
                    )
                )

        if want_base:
            for tc in kept_base:
                if (
                    "web_search" in tc.id
                    and "web_search_base" not in tc.id
                    and "no_snippet" not in tc.id
                ):
                    tc.id = tc.id.replace("web_search", "web_search_base", 1)

        if want_base:
            self._test_cases.extend(kept_base)
        if want_no_snippet:
            self._test_cases.extend(explicit_no_snippet)
            self._test_cases.extend(synthesized_no_snippet)

    async def _load_from_huggingface(self) -> None:
        """Load dataset from HuggingFace cache or download."""
        logger.info(f"Loading BFCL from HuggingFace: {self.config.huggingface_dataset}")

        # First, ensure data is downloaded to cache
        await self._ensure_dataset_cached()

        # Load all ground truth from possible_answer directory
        await self._load_ground_truth_from_cache()

        # Load data files directly from cache (NDJSON format).
        # This bypasses HuggingFace's schema inconsistency issues.
        data_files_to_load = [
            # Non-live single-turn
            ("simple", "BFCL_v3_simple.json", BFCLCategory.SIMPLE),
            ("multiple", "BFCL_v3_multiple.json", BFCLCategory.MULTIPLE),
            ("parallel", "BFCL_v3_parallel.json", BFCLCategory.PARALLEL),
            ("parallel_multiple", "BFCL_v3_parallel_multiple.json", BFCLCategory.PARALLEL_MULTIPLE),
            ("rest", "BFCL_v3_rest.json", BFCLCategory.REST_API),
            ("sql", "BFCL_v3_sql.json", BFCLCategory.SQL),
            ("java", "BFCL_v3_java.json", BFCLCategory.JAVA),
            ("javascript", "BFCL_v3_javascript.json", BFCLCategory.JAVASCRIPT),
            ("relevance", "BFCL_v3_live_relevance.json", BFCLCategory.RELEVANCE),
            ("irrelevance", "BFCL_v3_irrelevance.json", BFCLCategory.IRRELEVANCE),
            # Live (user-contributed)
            ("live_simple", "BFCL_v3_live_simple.json", BFCLCategory.LIVE_SIMPLE),
            ("live_multiple", "BFCL_v3_live_multiple.json", BFCLCategory.LIVE_MULTIPLE),
            ("live_parallel", "BFCL_v3_live_parallel.json", BFCLCategory.LIVE_PARALLEL),
            ("live_parallel_multiple", "BFCL_v3_live_parallel_multiple.json", BFCLCategory.LIVE_PARALLEL_MULTIPLE),
            ("live_irrelevance", "BFCL_v3_live_irrelevance.json", BFCLCategory.LIVE_IRRELEVANCE),
            # Multi-turn
            ("multi_turn_base", "BFCL_v3_multi_turn_base.json", BFCLCategory.MULTI_TURN_BASE),
            ("multi_turn_miss_func", "BFCL_v3_multi_turn_miss_func.json", BFCLCategory.MULTI_TURN_MISS_FUNC),
            ("multi_turn_miss_param", "BFCL_v3_multi_turn_miss_param.json", BFCLCategory.MULTI_TURN_MISS_PARAM),
            ("multi_turn_long_context", "BFCL_v3_multi_turn_long_context.json", BFCLCategory.MULTI_TURN_LONG_CONTEXT),
            # Agentic — v4 files, attempted opportunistically.
            ("web_search", "BFCL_v4_web_search.json", BFCLCategory.WEB_SEARCH_BASE),
            ("memory", "BFCL_v4_memory.json", BFCLCategory.MEMORY_KV),
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

        # Optionally pull ground truth from local possible_answer/ dir.
        await self._load_ground_truth_from_local(data_path)

        file_map = {
            **self.CATEGORY_FILES,
            **self.V3_CATEGORY_FILES,
            **self.V4_CATEGORY_FILES,
        }
        for file_name, category in file_map.items():
            # Skip if category not in configured categories
            if (
                self.config.categories
                and category not in self.config.categories
            ):
                continue

            file_path = data_path / f"{file_name}.json"
            if not file_path.exists():
                continue

            count = 0
            max_tests = self.config.max_tests_per_category

            for idx, item in enumerate(self._iter_local_records(file_path)):
                if max_tests and count >= max_tests:
                    break

                test_case = self._parse_test_case(item, category, f"{file_name}_{idx}")
                if test_case:
                    self._test_cases.append(test_case)
                    count += 1

            if count:
                logger.info(f"Loaded {count} test cases for category {category.value}")

    async def _load_ground_truth_from_local(self, data_path: Path) -> None:
        """Pick up local possible_answer/*.json files if present."""
        candidates = [
            data_path / "possible_answer",
            data_path.parent / "possible_answer",
        ]
        for gt_dir in candidates:
            if not gt_dir.exists():
                continue
            for gt_file in gt_dir.glob("*.json"):
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
                    logger.debug(f"Error loading local ground truth from {gt_file}: {e}")
            break

    @staticmethod
    def _iter_local_records(file_path: Path) -> Iterator[dict[str, object]]:
        """Yield records from either JSON arrays or BFCL NDJSON files."""
        with open(file_path) as f:
            content = f.read().strip()
        if not content:
            return
        if content.startswith("["):
            data = json.loads(content)
            if isinstance(data, list):
                for item in data:
                    if isinstance(item, dict):
                        yield item
            return
        for line in content.splitlines():
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            if isinstance(item, dict):
                yield item

    def _parse_test_case(
        self,
        item: dict[str, object],
        category: BFCLCategory,
        default_id: str,
    ) -> Optional[BFCLTestCase]:
        """Parse a raw dataset item into a BFCLTestCase."""
        try:
            test_id = str(item.get("id", default_id))
            # BFCL canonical `question` shape: list[list[dict{role,content}]].
            # The outer list is per-turn (multi-turn). Single-turn entries
            # are wrapped as [[{...}]].
            raw_question = item.get("question", item.get("prompt", ""))
            turns: Optional[list[list[dict[str, str]]]] = None
            question: str
            if isinstance(raw_question, list):
                normalised: list[list[dict[str, str]]] = []
                for turn in raw_question:
                    if isinstance(turn, list):
                        msgs: list[dict[str, str]] = []
                        for msg in turn:
                            if isinstance(msg, dict):
                                msgs.append({
                                    "role": str(msg.get("role", "user")),
                                    "content": str(msg.get("content", "")),
                                })
                        normalised.append(msgs)
                    elif isinstance(turn, dict):
                        normalised.append([
                            {
                                "role": str(turn.get("role", "user")),
                                "content": str(turn.get("content", "")),
                            }
                        ])
                turns = normalised
                # Flatten user turns for the single-turn `question` field
                flat_parts: list[str] = []
                for t in normalised:
                    for m in t:
                        if m.get("role") == "user":
                            flat_parts.append(m.get("content", ""))
                question = "\n".join(p for p in flat_parts if p)
            else:
                question = str(raw_question)

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

            # Parse expected calls — first check possible_answer/ ground truth.
            expected_calls: list[FunctionCall] = []

            # Single-turn ground truth is list[dict]; multi-turn is list[list[str]].
            if test_id in self._ground_truth:
                gt_raw = self._ground_truth[test_id]
                if isinstance(gt_raw, list) and all(isinstance(x, dict) for x in gt_raw):
                    expected_calls = self._parse_ground_truth_calls(gt_raw)  # type: ignore[arg-type]

            # Fall back to inline expected_call/ground_truth fields ONLY when
            # we had no possible_answer entry at all (otherwise we'd clobber
            # multi-turn entries that legitimately have empty single-turn GT).
            if not expected_calls and test_id not in self._ground_truth:
                expected_raw = item.get("expected_call", item.get("ground_truth", []))
                if isinstance(expected_raw, dict):
                    expected_raw = [expected_raw]
                elif isinstance(expected_raw, str):
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

            # Multi-turn ground truth lives in possible_answer files as
            # list[list[str]] (per-turn list of python call strings).
            multi_turn_gt: Optional[list[list[str]]] = None
            if category in {
                BFCLCategory.MULTI_TURN_BASE,
                BFCLCategory.MULTI_TURN_MISS_FUNC,
                BFCLCategory.MULTI_TURN_MISS_PARAM,
                BFCLCategory.MULTI_TURN_LONG_CONTEXT,
            } and test_id in self._ground_truth:
                raw_gt = self._ground_truth[test_id]
                if isinstance(raw_gt, list) and all(isinstance(x, list) for x in raw_gt):
                    multi_turn_gt = [[str(c) for c in turn] for turn in raw_gt]

            # Determine relevance (for relevance / irrelevance detection tests)
            is_relevant = True
            relevance_like = {
                BFCLCategory.RELEVANCE,
                BFCLCategory.IRRELEVANCE,
                BFCLCategory.LIVE_RELEVANCE,
                BFCLCategory.LIVE_IRRELEVANCE,
            }
            if category in relevance_like:
                test_id_lower = test_id.lower()
                if (
                    category in {BFCLCategory.IRRELEVANCE, BFCLCategory.LIVE_IRRELEVANCE}
                    or "irrelevance" in test_id_lower
                    or "irrelevant" in test_id_lower
                ):
                    is_relevant = False
                else:
                    is_relevant = (
                        len(expected_calls) > 0
                        or bool(item.get("is_relevant", True))
                    )

            # Language
            language = BFCLLanguage.PYTHON
            if category == BFCLCategory.JAVA:
                language = BFCLLanguage.JAVA
            elif category == BFCLCategory.JAVASCRIPT:
                language = BFCLLanguage.JAVASCRIPT
            elif category == BFCLCategory.SQL:
                language = BFCLLanguage.SQL
            elif category == BFCLCategory.REST_API:
                language = BFCLLanguage.REST

            # ground_truth_output
            ground_truth_raw = item.get("expected_output")
            ground_truth_output: Optional[str] = None
            if ground_truth_raw is not None:
                ground_truth_output = str(ground_truth_raw)

            # has_ground_truth determines whether we can AST-score this test.
            has_ground_truth = len(expected_calls) > 0

            if category in relevance_like:
                # Relevance/irrelevance is scored by detection (is_relevant flag).
                has_ground_truth = True

            if category == BFCLCategory.REST_API and not expected_calls:
                has_ground_truth = False
                logger.debug(
                    f"Test {test_id} (REST API) requires execution-based evaluation"
                )

            if multi_turn_gt is not None:
                has_ground_truth = True

            # Agentic categories: scored by upstream's stateful checker.
            if category in {
                BFCLCategory.WEB_SEARCH_BASE,
                BFCLCategory.WEB_SEARCH_NO_SNIPPET,
                BFCLCategory.MEMORY_KV,
                BFCLCategory.MEMORY_VECTOR,
                BFCLCategory.MEMORY_REC_SUM,
            }:
                has_ground_truth = test_id in self._ground_truth

            # Multi-turn / agentic config
            initial_config_raw = item.get("initial_config")
            initial_config = (
                initial_config_raw if isinstance(initial_config_raw, dict) else None
            )
            involved_classes_raw = item.get("involved_classes")
            involved_classes = (
                [str(c) for c in involved_classes_raw]
                if isinstance(involved_classes_raw, list)
                else None
            )
            excluded_function_raw = item.get("excluded_function")
            excluded_function = (
                [str(c) for c in excluded_function_raw]
                if isinstance(excluded_function_raw, list)
                else None
            )

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
                turns=turns,
                initial_config=initial_config,
                involved_classes=involved_classes,
                excluded_function=excluded_function,
                multi_turn_ground_truth=multi_turn_gt,
                metadata={
                    k: v
                    for k, v in item.items()
                    if k not in (
                        "id", "question", "function", "functions",
                        "expected_call", "ground_truth", "prompt",
                        "expected_output", "initial_config",
                        "involved_classes", "excluded_function",
                    )
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
        """Parse BFCL ground truth format into FunctionCall objects.

        BFCL format: [{"function_name": {"param1": [value1], "param2": [value2]}}, ...]
        Each value is a list of acceptable values.
        """
        calls: list[FunctionCall] = []

        for item in gt_list:
            if not isinstance(item, dict):
                continue

            for func_name, params in item.items():
                if not isinstance(params, dict):
                    continue

                arguments: dict[str, object] = {}
                for param_name, param_values in params.items():
                    if isinstance(param_values, list) and len(param_values) > 0:
                        value = param_values[0]
                        if value == "":
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
        require_ground_truth: bool = True,
        seed: int | None = 0,
    ) -> list[BFCLTestCase]:
        """Get a stratified sample of test cases."""
        import random

        rng = random.Random(seed)
        if categories is None:
            categories = self.get_categories()
        if not categories:
            return []

        ordered_categories = sorted(categories, key=lambda c: c.value)
        if n < len(ordered_categories):
            ordered_categories = sorted(
                rng.sample(ordered_categories, n),
                key=lambda c: c.value,
            )

        samples_per_category = max(1, n // len(ordered_categories))
        samples: list[BFCLTestCase] = []

        for category in ordered_categories:
            category_cases = sorted(
                [
                    tc
                    for tc in self.get_by_category(category)
                    if not require_ground_truth or tc.has_ground_truth
                ],
                key=lambda tc: tc.id,
            )
            if category_cases:
                sample_size = min(samples_per_category, len(category_cases))
                samples.extend(rng.sample(category_cases, sample_size))

        # If we need more samples, add randomly
        remaining = n - len(samples)
        if remaining > 0:
            sample_ids = {tc.id for tc in samples}
            remaining_cases = sorted(
                [
                    tc
                    for tc in self._test_cases
                    if tc.id not in sample_ids
                    and (not require_ground_truth or tc.has_ground_truth)
                ],
                key=lambda tc: (tc.category.value, tc.id),
            )
            if remaining_cases:
                samples.extend(
                    rng.sample(remaining_cases, min(remaining, len(remaining_cases)))
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
            if count:
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
