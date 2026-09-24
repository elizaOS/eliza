"""WebShop dataset loader.

Loads either:

1. **Upstream data** under ``suites/webshop/data/`` (fetched via
   ``scripts/fetch_data.py``): an ``items_shuffle*.json`` product catalog
   plus ``items_ins_v2*.json`` attributes and ``items_human_ins.json``
   instructions. This is the standard 1.18M (or 1k for ``small``) product
   benchmark.

2. **Sample catalog** — a hand-crafted, ~6-product in-memory catalog used
   for tests and ``--use-sample-tasks``. It does not exercise the full
   reward function (no human_attributes file) but lets the harness run
   without any external downloads.

Tasks are surfaced as :class:`elizaos_webshop.types.WebShopTask`. The
upstream goal dict (with ``attributes`` / ``goal_options`` / ``price_upper``)
is preserved verbatim under ``WebShopTask.metadata["upstream_goal"]`` so the
evaluator can recompute reward without re-loading anything.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import runpy
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass, replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from elizaos_webshop.types import WebShopTask

logger = logging.getLogger(__name__)

REPO_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
FETCH_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "fetch_data.py"

EDGE_VARIANTS: tuple[dict[str, str], ...] = (
    {
        "id": "budget_explicit",
        "label": "Explicit budget reminder",
        "suffix": " Stay within the stated budget and do not buy a pricier substitute.",
    },
    {
        "id": "option_strict",
        "label": "Strict option matching",
        "suffix": " Match every requested option exactly, including color, size, flavor, or temperature.",
    },
    {
        "id": "avoid_sponsored",
        "label": "Avoid sponsored-looking distractors",
        "suffix": " Ignore sponsored-looking or irrelevant search results if they do not satisfy the request.",
    },
    {
        "id": "synonym_query",
        "label": "Search synonym pressure",
        "prefix": "Use reasonable search synonyms if the first query is too narrow. ",
    },
    {
        "id": "reviews_noise",
        "label": "Review noise caution",
        "suffix": " Do not choose based on review text alone; verify the product title and attributes.",
    },
    {
        "id": "inventory_caution",
        "label": "Inventory caution",
        "suffix": " If multiple variants appear, select the purchasable variant that satisfies the goal.",
    },
    {
        "id": "accessory_distractor",
        "label": "Accessory distractor",
        "suffix": " Avoid accessories, bundles, or replacement parts unless the instruction asks for them.",
    },
    {
        "id": "compact_goal",
        "label": "Compact terse instruction",
        "prefix": "Terse shopping request: ",
    },
    {
        "id": "brand_agnostic",
        "label": "Brand-agnostic match",
        "suffix": " Brand is less important than matching the requested product type, attributes, options, and price.",
    },
    {
        "id": "final_check",
        "label": "Final check before purchase",
        "suffix": " Before buying, confirm the selected item satisfies all stated constraints.",
    },
)

EXPECTED_FULL_HUMAN_GOALS = 12_087
EXPECTED_FULL_CATALOG_ENTRIES = 1_181_436
EXPECTED_FULL_PRODUCTS = 1_181_430
CANONICAL_GOAL_SHUFFLE_SEED = 233
CANONICAL_SPLIT_BOUNDS: dict[str, tuple[int, int | None]] = {
    "test": (0, 500),
    "eval": (500, 1_500),
    "train": (1_500, None),
}
UPSTREAM_GDRIVE_FILE_IDS: dict[str, str] = {
    "items_shuffle_1000.json": "1EgHdxQ_YxqIQlvvq5iKlCrkEKR6-j0Ib",
    "items_ins_v2_1000.json": "1IduG0xl544V_A_jv3tHXC0kyFi7PnyBu",
    "items_shuffle.json": "1A2whVgOO0euk5O13n2iYDM0bQRkkRduB",
    "items_ins_v2.json": "1s2j6NgHljiZzQNL3veZaAiyW_qDEgBNi",
    "items_human_ins.json": "14Kb5SPBk_jfdLZ_CDBNitW98QLDlKR5O",
}
UPSTREAM_FILE_MANIFEST: dict[str, tuple[int, str]] = {
    "items_shuffle_1000.json": (
        4_467_013,
        "30a4765c3a327af72d9a9a95a6b2486d516f0fa1d3ecd83681901ce82a21b269",
    ),
    "items_ins_v2_1000.json": (
        147_099,
        "f88a36314a397b53b3d9c3fa5878e5f7b26d35019a51ec83fbedeca61a948f6f",
    ),
    "items_shuffle.json": (
        5_479_720_229,
        "2ef591d65df3af89e972ab72468eb82cbf124d876552d9f3678667edd620a6c8",
    ),
    "items_ins_v2.json": (
        186_295_270,
        "1d36af476bdb8f82a5da62bd8acdabe54cd8de2fa84010d37da5c4890feb447e",
    ),
    "items_human_ins.json": (
        5_137_548,
        "cf78667548a71786e1d9049c24b802e48e1084ad4bb021cae56ce1f6d96954a3",
    ),
}
_CATALOG_STREAM_CHUNK_SIZE = 8 * 1024 * 1024


@dataclass
class WebShopDataPaths:
    """Resolved paths to the three WebShop JSON files."""

    items: Path
    attributes: Path
    human_instructions: Path

    @property
    def has_human_goals(self) -> bool:
        return self.human_instructions.exists() and self.human_instructions.stat().st_size > 0


def resolve_paths(
    *,
    data_dir: Path | None = None,
    profile: str = "small",
) -> WebShopDataPaths | None:
    """Resolve dataset paths for the requested profile.

    Returns ``None`` if any required file is missing.
    """
    base = data_dir or REPO_DATA_DIR
    if profile == "small":
        items = base / "items_shuffle_1000.json"
        attrs = base / "items_ins_v2_1000.json"
    elif profile == "full":
        items = base / "items_shuffle.json"
        attrs = base / "items_ins_v2.json"
    else:
        raise ValueError(f"Unknown profile {profile!r}; use 'small' or 'full'.")
    human = base / "items_human_ins.json"

    if not all(path.exists() and path.stat().st_size > 0 for path in (items, attrs, human)):
        return None
    return WebShopDataPaths(items=items, attributes=attrs, human_instructions=human)


def _load_fetch_module() -> Any:
    namespace = runpy.run_path(str(FETCH_SCRIPT))
    if "download_profile" not in namespace and "fetch_profile" in namespace:
        namespace["download_profile"] = namespace["fetch_profile"]
    return SimpleNamespace(**namespace)


def ensure_profile_downloaded(profile: str, data_dir: Path) -> WebShopDataPaths:
    existing = resolve_paths(data_dir=data_dir, profile=profile)
    if existing is not None:
        return existing

    if os.environ.get("WEBSHOP_NO_AUTOFETCH"):
        raise FileNotFoundError(
            "WebShop data not found and WEBSHOP_NO_AUTOFETCH is set. "
            f"Run `python scripts/fetch_data.py --profile {profile}` first, "
            "or pass --use-sample-tasks for a tiny built-in catalog."
        )

    fetch_module = _load_fetch_module()
    download_profile = getattr(fetch_module, "download_profile", None)
    if not callable(download_profile):
        raise RuntimeError("scripts/fetch_data.py does not expose download_profile()")
    download_profile(profile, data_dir)

    paths = resolve_paths(data_dir=data_dir, profile=profile)
    if paths is None:
        raise FileNotFoundError(
            f"WebShop profile {profile!r} did not produce required files in {data_dir}"
        )
    return paths


def verify_upstream_data(paths: WebShopDataPaths) -> dict[str, str | int]:
    """Hash the exact upstream bytes and return report-ready provenance."""

    provenance: dict[str, str | int] = {}
    for label, path in (
        ("items", paths.items),
        ("attributes", paths.attributes),
        ("human_goals", paths.human_instructions),
    ):
        expected = UPSTREAM_FILE_MANIFEST.get(path.name)
        if expected is None:
            raise ValueError(f"WebShop has no pinned manifest for {path.name}")
        expected_size, expected_sha256 = expected
        actual_size = path.stat().st_size
        if actual_size != expected_size:
            raise ValueError(
                f"WebShop {path.name} size mismatch: expected {expected_size}, "
                f"found {actual_size}"
            )
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        actual_sha256 = digest.hexdigest()
        if actual_sha256 != expected_sha256:
            raise ValueError(
                f"WebShop {path.name} checksum mismatch: expected "
                f"{expected_sha256}, found {actual_sha256}"
            )
        provenance[f"{label}_source_id"] = UPSTREAM_GDRIVE_FILE_IDS[path.name]
        provenance[f"{label}_file_size"] = actual_size
        provenance[f"{label}_sha256"] = actual_sha256
    return provenance


def _iter_catalog_products(path: Path) -> Iterator[dict[str, Any]]:
    """Decode a top-level JSON array without retaining the 5.5 GB catalog."""

    decoder = json.JSONDecoder()
    file_size = path.stat().st_size
    with path.open(encoding="utf-8") as catalog:
        buffer = ""
        cursor = 0
        eof = False

        def read_more() -> None:
            nonlocal buffer, cursor, eof
            buffer = buffer[cursor:] + catalog.read(_CATALOG_STREAM_CHUNK_SIZE)
            cursor = 0
            eof = catalog.tell() == file_size

        def skip_whitespace() -> None:
            nonlocal cursor
            while True:
                while cursor < len(buffer) and buffer[cursor].isspace():
                    cursor += 1
                if cursor < len(buffer) or eof:
                    return
                read_more()

        read_more()
        skip_whitespace()
        if cursor >= len(buffer) or buffer[cursor] != "[":
            raise ValueError("WebShop product catalog must be a JSON array")
        cursor += 1
        first = True

        while True:
            skip_whitespace()
            if cursor >= len(buffer):
                raise ValueError("WebShop product catalog has an unterminated JSON array")
            if buffer[cursor] == "]":
                cursor += 1
                break
            if not first:
                if buffer[cursor] != ",":
                    raise ValueError("WebShop product catalog entries must be comma-separated")
                cursor += 1
                skip_whitespace()
                if cursor >= len(buffer) or buffer[cursor] == "]":
                    raise ValueError("WebShop product catalog has a trailing comma")

            while True:
                try:
                    product, next_cursor = decoder.raw_decode(buffer, cursor)
                    cursor = next_cursor
                    break
                except json.JSONDecodeError as error:
                    if eof:
                        raise ValueError("WebShop product catalog contains invalid JSON") from error
                    read_more()

            if not isinstance(product, dict):
                raise ValueError("WebShop product catalog entries must be objects")
            yield product
            first = False

            if cursor >= _CATALOG_STREAM_CHUNK_SIZE:
                buffer = buffer[cursor:]
                cursor = 0

        skip_whitespace()
        if cursor < len(buffer) or not eof:
            while not eof:
                read_more()
                skip_whitespace()
            if cursor < len(buffer):
                raise ValueError("WebShop product catalog has trailing data")


def _catalog_asins(
    path: Path,
    *,
    stream: bool,
    expected_count: int | None = None,
) -> set[str]:
    if stream:
        products: Iterator[dict[str, Any]] = _iter_catalog_products(path)
    else:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, list):
            raise ValueError("WebShop product catalog must be a JSON array")
        products = iter(payload)

    asins: set[str] = set()
    for product in products:
        if not isinstance(product, dict):
            raise ValueError("WebShop product catalog entries must be objects")
        asin = product.get("asin")
        if not isinstance(asin, str):
            raise ValueError("WebShop product catalog entry has no ASIN")
        if asin and asin != "nan" and len(asin) <= 10:
            asins.add(asin)

    if not asins:
        raise ValueError("WebShop product catalog contains no valid ASINs")
    if expected_count is not None and len(asins) != expected_count:
        raise ValueError(
            f"WebShop product catalog is incomplete: expected {expected_count} "
            f"unique products, found {len(asins)}"
        )
    return asins


def _apply_edge_variant(task: WebShopTask, variant: dict[str, str]) -> WebShopTask:
    metadata = dict(task.metadata)
    metadata.update(
        {
            "base_task_id": task.task_id,
            "scenario_id": variant["id"],
            "scenario_label": variant["label"],
        }
    )
    instruction = (
        f"{variant.get('prefix', '')}{task.instruction}{variant.get('suffix', '')}"
    )
    return replace(
        task,
        task_id=f"{task.task_id}__edge_{variant['id']}",
        instruction=instruction,
        metadata=metadata,
    )


def expand_tasks(tasks: list[WebShopTask]) -> list[WebShopTask]:
    """Return each selected WebShop task plus exactly ten edge variants."""
    expanded: list[WebShopTask] = []
    for task in tasks:
        expanded.append(task)
        expanded.extend(_apply_edge_variant(task, variant) for variant in EDGE_VARIANTS)
    return expanded


def count_tasks(tasks: list[WebShopTask], include_edge_scenarios: bool = False) -> dict[str, int]:
    base = len(tasks)
    edge = base * len(EDGE_VARIANTS) if include_edge_scenarios else 0
    return {
        "base": base,
        "edge": edge,
        "edge_multiplier": len(EDGE_VARIANTS),
        "total": base + edge,
    }


def validate_tasks(tasks: list[WebShopTask], include_edge_scenarios: bool = False) -> None:
    ids = [task.task_id for task in tasks]
    duplicates = {task_id for task_id in ids if ids.count(task_id) > 1}
    if duplicates:
        raise ValueError(f"Duplicate WebShop task ids: {sorted(duplicates)[:5]}")
    for task in tasks:
        if not task.instruction.strip():
            raise ValueError(f"WebShop task {task.task_id} has an empty instruction")
        if not task.target_product_ids or not all(task.target_product_ids):
            raise ValueError(f"WebShop task {task.task_id} has no target product")

    if not include_edge_scenarios:
        return

    expanded = expand_tasks(tasks)
    expanded_ids = [task.task_id for task in expanded]
    expanded_duplicates = {
        task_id for task_id in expanded_ids if expanded_ids.count(task_id) > 1
    }
    if expanded_duplicates:
        raise ValueError(f"Duplicate expanded WebShop task ids: {sorted(expanded_duplicates)[:5]}")
    for task in expanded:
        if "__edge_" not in task.task_id:
            continue
        if "base_task_id" not in task.metadata or "scenario_id" not in task.metadata:
            raise ValueError(f"Expanded WebShop task {task.task_id} is missing scenario metadata")
        if not task.target_product_ids:
            raise ValueError(f"Expanded WebShop task {task.task_id} has no target product")


class WebShopDataset:
    """Loader for WebShop tasks.

    Parameters
    ----------
    split:
        ``"test"`` selects canonical indices 0–499, ``"eval"`` selects
        500–1,499, and ``"train"`` selects 1,500 onward.
    profile:
        ``"small"`` (1k products, default) or ``"full"`` (1.18M products).
    use_sample_tasks:
        Bypass on-disk data and return the tiny sample catalog. Intended for
        smoke tests and harness validation.
    data_dir:
        Override the default data dir (``suites/webshop/data``).
    human_goals:
        Use human instructions (recommended) vs. synthetic goals.
    """

    def __init__(
        self,
        *,
        split: str = "test",
        profile: str = "small",
        use_sample_tasks: bool = False,
        data_dir: Path | None = None,
        human_goals: bool = True,
    ) -> None:
        if split not in CANONICAL_SPLIT_BOUNDS:
            raise ValueError(
                f"split must be one of {sorted(CANONICAL_SPLIT_BOUNDS)}, got {split!r}"
            )
        self.split = split
        self.profile = profile
        self.use_sample_tasks = use_sample_tasks
        self.data_dir = data_dir or REPO_DATA_DIR
        self.human_goals = human_goals

        self.paths: WebShopDataPaths | None = None
        self.tasks: list[WebShopTask] = []
        self.catalog_product_count = 0
        self.published_goal_count = 0
        self.data_provenance: dict[str, str | int] = {}

    # ------------------------------------------------------------------
    # Loading
    # ------------------------------------------------------------------

    async def load(self, **_kwargs: Any) -> None:
        """Backwards-compatible async entry point used by ``WebShopRunner``."""
        self.load_sync()

    def load_sync(self) -> None:
        if self.use_sample_tasks:
            self.paths = self._materialize_sample_catalog()
            self.tasks = self._load_from_upstream(self.paths)
            logger.info(
                "[WebShopDataset] Sample catalog loaded: %d products, %d tasks",
                len(self.sample_products()),
                len(self.tasks),
            )
            return

        paths = resolve_paths(data_dir=self.data_dir, profile=self.profile)
        if paths is None:
            paths = ensure_profile_downloaded(self.profile, self.data_dir)
        self.paths = paths
        if self.profile == "full":
            self.data_provenance = verify_upstream_data(paths)
        self.tasks = self._load_from_upstream(paths)
        logger.info(
            "[WebShopDataset] Loaded %d %s tasks (profile=%s)",
            len(self.tasks),
            self.split,
            self.profile,
        )

    def load_manifest_sync(self) -> None:
        """Load task identities for count/validation without the web runtime."""
        if self.use_sample_tasks:
            self.paths = self._materialize_sample_catalog()
        else:
            paths = resolve_paths(data_dir=self.data_dir, profile=self.profile)
            paths = paths or ensure_profile_downloaded(self.profile, self.data_dir)
            self.paths = paths
            if self.profile == "full":
                self.data_provenance = verify_upstream_data(paths)

        manifest = json.loads(self.paths.human_instructions.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            raise ValueError("WebShop human-goal manifest must be an object keyed by ASIN")
        if self.profile == "full" and not self.use_sample_tasks:
            products: Iterator[dict[str, Any]] = _iter_catalog_products(self.paths.items)
        else:
            product_payload = json.loads(self.paths.items.read_text(encoding="utf-8"))
            if not isinstance(product_payload, list):
                raise ValueError("WebShop product catalog must be a JSON array")
            products = iter(product_payload)

        catalog_asins: set[str] = set()
        catalog_entries = 0
        goals: list[dict[str, Any]] = []
        for product in products:
            catalog_entries += 1
            if not isinstance(product, dict):
                raise ValueError("WebShop product catalog entries must be objects")
            asin = product.get("asin")
            if not isinstance(asin, str):
                raise ValueError("WebShop product catalog entry has no ASIN")
            if not asin or asin == "nan" or len(asin) > 10 or asin in catalog_asins:
                continue
            catalog_asins.add(asin)
            instructions = manifest.get(asin)
            if instructions is None:
                continue
            if not isinstance(asin, str) or not asin.strip():
                raise ValueError("WebShop human-goal manifest contains an empty ASIN")
            if not isinstance(instructions, list):
                raise ValueError(f"WebShop human goals for {asin} must be a list")
            if asin not in catalog_asins:
                continue
            for entry in instructions:
                if not isinstance(entry, dict):
                    raise ValueError(f"WebShop human goal for {asin} must be an object")
                attributes = entry.get("instruction_attributes")
                if not isinstance(attributes, list):
                    raise ValueError(
                        f"WebShop human goal for {asin} is missing instruction_attributes"
                    )
                if not attributes:
                    continue
                instruction = entry.get("instruction")
                if not isinstance(instruction, str) or not instruction.strip():
                    raise ValueError(f"WebShop human goal for {asin} has an empty instruction")
                goals.append(
                    {
                        "asin": asin,
                        "instruction_text": instruction.strip("."),
                        "attributes": attributes,
                        "price_upper": 1_000_000,
                        "goal_options": entry.get("instruction_options", {}),
                        "category": product.get("category", ""),
                        "query": str(product.get("query", "")).lower().strip(),
                        "name": product.get("name", ""),
                        "product_category": product.get("product_category", ""),
                    }
                )

        if (
            self.profile == "full"
            and not self.use_sample_tasks
            and catalog_entries != EXPECTED_FULL_CATALOG_ENTRIES
        ):
            raise ValueError(
                "WebShop full catalog is incomplete: expected "
                f"{EXPECTED_FULL_CATALOG_ENTRIES} raw entries, found {catalog_entries}"
            )
        if (
            self.profile == "full"
            and not self.use_sample_tasks
            and len(catalog_asins) != EXPECTED_FULL_PRODUCTS
        ):
            raise ValueError(
                "WebShop full catalog is incomplete: expected "
                f"{EXPECTED_FULL_PRODUCTS} executable products, found {len(catalog_asins)}"
            )
        self.catalog_product_count = len(catalog_asins)

        if self.profile == "full" and len(goals) != EXPECTED_FULL_HUMAN_GOALS:
            raise ValueError(
                "WebShop full profile is incomplete: expected "
                f"{EXPECTED_FULL_HUMAN_GOALS} published human goals, found {len(goals)}"
            )

        random.Random(CANONICAL_GOAL_SHUFFLE_SEED).shuffle(goals)
        self.published_goal_count = len(goals)
        start, end = CANONICAL_SPLIT_BOUNDS[self.split]
        selected = goals[start:end]
        if self.profile == "full":
            expected_split = self._expected_full_split_count()
            if len(selected) != expected_split:
                raise ValueError(
                    f"WebShop canonical {self.split} split is incomplete: expected "
                    f"{expected_split} tasks, found {len(selected)}"
                )
        self.tasks = [
            self._goal_to_task(start + i, goal) for i, goal in enumerate(selected)
        ]

    def install_runtime_goals(
        self,
        goals: list[dict[str, Any]],
        *,
        catalog_product_count: int,
    ) -> None:
        """Install the exact shuffled goals generated by the upstream server."""

        if self.profile == "full" and catalog_product_count != EXPECTED_FULL_PRODUCTS:
            raise ValueError(
                "WebShop full catalog is incomplete: expected "
                f"{EXPECTED_FULL_PRODUCTS} executable products, "
                f"found {catalog_product_count}"
            )
        if (
            self.profile == "full"
            and self.human_goals
            and len(goals) != EXPECTED_FULL_HUMAN_GOALS
        ):
            raise ValueError(
                "WebShop full profile is incomplete: expected "
                f"{EXPECTED_FULL_HUMAN_GOALS} published human goals, found {len(goals)}"
            )

        self.catalog_product_count = catalog_product_count
        self.published_goal_count = len(goals)
        start, end = CANONICAL_SPLIT_BOUNDS[self.split]
        selected = goals[start:end]
        if self.profile == "full" and self.human_goals:
            expected_split = self._expected_full_split_count()
            if len(selected) != expected_split:
                raise ValueError(
                    f"WebShop canonical {self.split} split is incomplete: expected "
                    f"{expected_split} tasks, found {len(selected)}"
                )
        self.tasks = [
            self._goal_to_task(start + index, goal)
            for index, goal in enumerate(selected)
        ]

    def get_tasks(self, *, limit: int | None = None) -> list[WebShopTask]:
        if limit is None:
            return list(self.tasks)
        return list(self.tasks[: max(0, int(limit))])

    # ------------------------------------------------------------------
    # Upstream goal loading
    # ------------------------------------------------------------------

    def _load_from_upstream(self, paths: WebShopDataPaths) -> list[WebShopTask]:
        # Lazy: defer importing upstream until needed (it imports spaCy).
        from elizaos_webshop.environment import (  # circular-safe
            _ensure_upstream_on_path,
            _install_bm25_after_load_products,
            _patch_search_engine_for_bm25_fallback,
        )

        _ensure_upstream_on_path()
        _patch_search_engine_for_bm25_fallback(force_bm25=True)
        _install_bm25_after_load_products()

        from web_agent_site import utils as _utils  # type: ignore[import-not-found]
        from web_agent_site.engine import engine as _engine_mod  # type: ignore[import-not-found]
        from web_agent_site.engine.engine import load_products  # type: ignore[import-not-found]
        from web_agent_site.engine.goal import get_goals  # type: ignore[import-not-found]

        _utils.DEFAULT_ATTR_PATH = str(paths.attributes)
        _utils.HUMAN_ATTR_PATH = str(paths.human_instructions)
        _engine_mod.DEFAULT_ATTR_PATH = str(paths.attributes)
        _engine_mod.HUMAN_ATTR_PATH = str(paths.human_instructions)

        if self.human_goals and not paths.has_human_goals:
            raise FileNotFoundError(
                "WebShop human-goal instructions are required; synthetic goals are not "
                "a substitute for the published benchmark corpus"
            )
        human_goals = self.human_goals

        all_products, _items, product_prices, _attr_to_asins = load_products(
            filepath=str(paths.items),
            num_products=None,
            human_goals=human_goals,
        )
        goals = get_goals(all_products, product_prices, human_goals=human_goals)
        random.Random(CANONICAL_GOAL_SHUFFLE_SEED).shuffle(goals)
        self.install_runtime_goals(goals, catalog_product_count=len(all_products))
        return list(self.tasks)

    def _expected_full_split_count(self) -> int:
        start, end = CANONICAL_SPLIT_BOUNDS[self.split]
        return max(0, min(end or EXPECTED_FULL_HUMAN_GOALS, EXPECTED_FULL_HUMAN_GOALS) - start)

    @staticmethod
    def _goal_to_task(idx: int, goal: dict[str, Any]) -> WebShopTask:
        instruction = str(goal.get("instruction_text", "")).strip()
        # Upstream's reward operates on the entire ``goal`` dict, not on a
        # per-attribute key/value map. Preserve it verbatim.
        return WebShopTask(
            task_id=f"webshop_{idx:06d}_{goal.get('asin', 'unknown')}",
            instruction=instruction,
            target_product_ids=[str(goal.get("asin", ""))],
            goal_attributes={},
            budget=(
                float(goal["price_upper"])
                if goal.get("price_upper") and goal["price_upper"] < 1e6
                else None
            ),
            metadata={
                "upstream_goal_json": json.dumps(goal, default=str),
                "category": str(goal.get("category", "")),
                "query": str(goal.get("query", "")),
            },
        )

    # ------------------------------------------------------------------
    # Tiny sample catalog (no external downloads)
    # ------------------------------------------------------------------

    def sample_products(self) -> list[dict[str, Any]]:
        """A minimal upstream-compatible product list.

        Each item matches the schema expected by upstream's ``load_products``:
        ``asin``, ``name``, ``category``, ``query``, ``product_category``,
        ``small_description``, ``full_description``, ``pricing``, ``images``,
        ``customization_options``.
        """
        return _SAMPLE_PRODUCTS

    def _materialize_sample_catalog(self) -> WebShopDataPaths:
        """Write the sample catalog to a temp dir and return paths to it."""
        tmp = Path(tempfile.mkdtemp(prefix="elizaos_webshop_sample_"))
        items_path = tmp / "items_shuffle_sample.json"
        attrs_path = tmp / "items_ins_v2_sample.json"
        human_path = tmp / "items_human_ins_sample.json"

        items_path.write_text(json.dumps(_SAMPLE_PRODUCTS), encoding="utf-8")
        attrs_path.write_text(
            json.dumps(_SAMPLE_ATTRIBUTES, default=str),
            encoding="utf-8",
        )
        human_path.write_text(
            json.dumps(_SAMPLE_HUMAN_INSTRUCTIONS, default=str),
            encoding="utf-8",
        )

        # Ensure the env can resolve relative paths for `../data/...`.
        return WebShopDataPaths(items=items_path, attributes=attrs_path, human_instructions=human_path)


# ----------------------------------------------------------------------
# Sample catalog (~6 products) for smoke tests
# ----------------------------------------------------------------------

_SAMPLE_PRODUCTS: list[dict[str, Any]] = [
    {
        "asin": "B000HEADPH",
        "name": "Wireless Bluetooth Headphones Black",
        "category": "electronics",
        "query": "wireless bluetooth headphones",
        "product_category": "Electronics › Headphones › Over-Ear",
        "small_description": ["wireless", "bluetooth", "noise cancelling"],
        "full_description": "Over-ear wireless bluetooth headphones with active noise cancellation and 40-hour battery life.",
        "pricing": "$79.99",
        "images": ["https://example.com/headph.jpg"],
        "customization_options": {
            "color": [{"value": "black", "image": None}, {"value": "white", "image": None}],
        },
    },
    {
        "asin": "B000RUNNER",
        "name": "Lightweight Running Shoes",
        "category": "sports",
        "query": "running shoes",
        "product_category": "Sports › Footwear › Running",
        "small_description": ["breathable", "cushioned"],
        "full_description": "Lightweight breathable running shoes with cushioned sole.",
        "pricing": "$129.99",
        "images": ["https://example.com/shoes.jpg"],
        "customization_options": {
            "size": [{"value": s, "image": None} for s in ("7", "8", "9", "10", "11")],
            "color": [{"value": "gray", "image": None}, {"value": "black", "image": None}],
        },
    },
    {
        "asin": "B000GREENT",
        "name": "Organic Green Tea 100 Bags",
        "category": "grocery",
        "query": "green tea",
        "product_category": "Grocery › Beverages › Tea",
        "small_description": ["organic", "antioxidants"],
        "full_description": "Organic green tea, 100 bags per box; available in decaf.",
        "pricing": "$15.99",
        "images": ["https://example.com/tea.jpg"],
        "customization_options": {
            "caffeine": [{"value": "regular", "image": None}, {"value": "decaf", "image": None}],
        },
    },
    {
        "asin": "B000WATER1",
        "name": "Stainless Steel Water Bottle",
        "category": "sports",
        "query": "water bottle",
        "product_category": "Sports › Hydration › Bottles",
        "small_description": ["insulated", "leak-proof"],
        "full_description": "Vacuum-insulated leak-proof stainless steel bottle.",
        "pricing": "$24.99",
        "images": ["https://example.com/bottle.jpg"],
        "customization_options": {
            "size": [{"value": s, "image": None} for s in ("500ml", "750ml", "1l")],
            "color": [{"value": "silver", "image": None}, {"value": "blue", "image": None}],
        },
    },
    {
        "asin": "B000CHARG1",
        "name": "USB-C Laptop Charger 65W",
        "category": "electronics",
        "query": "usb c charger",
        "product_category": "Electronics › Power › Chargers",
        "small_description": ["usb-c", "65w", "fast charging"],
        "full_description": "Compact 65 watt USB-C laptop charger.",
        "pricing": "$45.99",
        "images": ["https://example.com/charg.jpg"],
        "customization_options": {},
    },
    {
        "asin": "B000DESKLP",
        "name": "Adjustable LED Desk Lamp",
        "category": "home",
        "query": "desk lamp",
        "product_category": "Home › Lighting › Desk Lamps",
        "small_description": ["led", "adjustable"],
        "full_description": "Eye-care LED desk lamp with adjustable arm.",
        "pricing": "$32.50",
        "images": ["https://example.com/lamp.jpg"],
        "customization_options": {
            "color_temperature": [
                {"value": "warm", "image": None},
                {"value": "cool", "image": None},
            ],
        },
    },
]

# items_ins_v2_*.json: per-ASIN dict of {attributes, instruction, instruction_attributes}
_SAMPLE_ATTRIBUTES: dict[str, dict[str, Any]] = {
    "B000HEADPH": {
        "attributes": ["wireless", "bluetooth", "noise cancelling"],
        "instruction": "I am looking for over-ear wireless bluetooth headphones with noise cancelling, in black",
        "instruction_attributes": ["wireless", "bluetooth", "noise cancelling"],
    },
    "B000RUNNER": {
        "attributes": ["breathable", "cushioned", "lightweight"],
        "instruction": "buy a pair of lightweight breathable cushioned running shoes",
        "instruction_attributes": ["breathable", "cushioned", "lightweight"],
    },
    "B000GREENT": {
        "attributes": ["organic", "decaf"],
        "instruction": "i want organic decaf green tea bags",
        "instruction_attributes": ["organic", "decaf"],
    },
    "B000WATER1": {
        "attributes": ["insulated", "leak-proof"],
        "instruction": "buy an insulated leak-proof stainless steel water bottle, 750ml, silver",
        "instruction_attributes": ["insulated", "leak-proof"],
    },
    "B000CHARG1": {
        "attributes": ["usb-c", "65w", "fast charging"],
        "instruction": "i need a 65 watt usb-c laptop charger with fast charging",
        "instruction_attributes": ["usb-c", "65w"],
    },
    "B000DESKLP": {
        "attributes": ["led", "adjustable"],
        "instruction": "buy an adjustable led desk lamp with warm color temperature",
        "instruction_attributes": ["led", "adjustable"],
    },
}

# items_human_ins.json schema: per-ASIN list of instruction dicts
_SAMPLE_INSTRUCTION_OPTIONS: dict[str, dict[str, str]] = {
    "B000HEADPH": {"color": "black"},
    "B000WATER1": {"size": "750ml", "color": "silver"},
    "B000GREENT": {"caffeine": "decaf"},
}

_SAMPLE_HUMAN_INSTRUCTIONS: dict[str, list[dict[str, Any]]] = {
    asin: [
        {
            "instruction": v["instruction"],
            "instruction_attributes": v["instruction_attributes"],
            "instruction_options": _SAMPLE_INSTRUCTION_OPTIONS.get(asin, {}),
        }
    ]
    for asin, v in _SAMPLE_ATTRIBUTES.items()
}
