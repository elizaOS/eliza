"""WebShop dataset loader.

Loads either:

1. **Upstream data** under ``packages/benchmarks/webshop/data/`` (fetched via
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

import json
import logging
import os
import random
import runpy
import tempfile
from dataclasses import dataclass
from types import SimpleNamespace
from pathlib import Path
from typing import Any

from elizaos_webshop.types import WebShopTask

logger = logging.getLogger(__name__)

REPO_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
FETCH_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "fetch_data.py"


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

    if not items.exists() or not attrs.exists():
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


class WebShopDataset:
    """Loader for WebShop tasks.

    Parameters
    ----------
    split:
        Either ``"train"`` or ``"test"``. The 12,087 human goals are split
        90/10 deterministically (seed=42) following the upstream convention.
    profile:
        ``"small"`` (1k products, default) or ``"full"`` (1.18M products).
    use_sample_tasks:
        Bypass on-disk data and return the tiny sample catalog. Intended for
        smoke tests and harness validation.
    data_dir:
        Override the default data dir (``packages/benchmarks/webshop/data``).
    human_goals:
        Use human instructions (recommended) vs. synthetic goals.
    """

    SPLIT_SEED = 42
    TEST_FRACTION = 0.1

    def __init__(
        self,
        *,
        split: str = "test",
        profile: str = "small",
        use_sample_tasks: bool = False,
        data_dir: Path | None = None,
        human_goals: bool = True,
    ) -> None:
        if split not in ("train", "test"):
            raise ValueError(f"split must be 'train' or 'test', got {split!r}")
        self.split = split
        self.profile = profile
        self.use_sample_tasks = use_sample_tasks
        self.data_dir = data_dir or REPO_DATA_DIR
        self.human_goals = human_goals

        self.paths: WebShopDataPaths | None = None
        self.tasks: list[WebShopTask] = []

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
        self.tasks = self._load_from_upstream(paths)
        logger.info(
            "[WebShopDataset] Loaded %d %s tasks (profile=%s)",
            len(self.tasks),
            self.split,
            self.profile,
        )

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
        _patch_search_engine_for_bm25_fallback()
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
            logger.warning(
                "[WebShopDataset] human_instructions file missing; "
                "falling back to synthetic goals"
            )
            human_goals = False
        else:
            human_goals = self.human_goals

        all_products, _items, product_prices, _attr_to_asins = load_products(
            filepath=str(paths.items),
            num_products=None,
            human_goals=human_goals,
        )
        goals = get_goals(all_products, product_prices, human_goals=human_goals)

        # Deterministic shuffle + split (mirrors upstream's random.seed(233)
        # for goal ordering but with our own fixed split seed).
        rng = random.Random(self.SPLIT_SEED)
        rng.shuffle(goals)
        n_test = max(1, int(len(goals) * self.TEST_FRACTION))
        if self.split == "test":
            goals = goals[:n_test]
        else:
            goals = goals[n_test:]

        return [self._goal_to_task(i, g) for i, g in enumerate(goals)]

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
