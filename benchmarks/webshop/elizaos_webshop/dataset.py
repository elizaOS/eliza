from __future__ import annotations

import logging

from elizaos_webshop.types import Product, WebShopTask

logger = logging.getLogger(__name__)


class WebShopDataset:
    """
    Minimal WebShop dataset wrapper.

    This benchmark can run end-to-end without external data by using built-in
    sample products + tasks. Optionally, tasks can be loaded from HuggingFace
    if `datasets` is installed.
    """

    def __init__(self, *, split: str = "test") -> None:
        self.split = split
        self.products: dict[str, Product] = {}
        self.tasks: list[WebShopTask] = []

    async def load(self, *, use_huggingface: bool = False) -> None:
        if use_huggingface:
            loaded = await self._try_load_from_huggingface()
            if loaded:
                return
            logger.warning(
                "[WebShopDataset] HuggingFace load requested but unavailable; using sample data."
            )

        self.products = {p.product_id: p for p in self.create_sample_products()}
        self.tasks = self.create_sample_tasks()

    def get_tasks(self, *, limit: int | None = None) -> list[WebShopTask]:
        if limit is None:
            return list(self.tasks)
        return list(self.tasks[: max(0, int(limit))])

    # ---------------------------------------------------------------------
    # Sample data (no external dependencies)
    # ---------------------------------------------------------------------

    def create_sample_products(self) -> list[Product]:
        return [
            Product(
                product_id="P001",
                name="Wireless Bluetooth Headphones",
                price=79.99,
                category="Electronics",
                rating=4.5,
                features=["wireless", "bluetooth", "noise cancelling", "40h battery"],
                options={"color": ["black", "white", "blue"]},
                attributes={"type": "headphones"},
            ),
            Product(
                product_id="P002",
                name="Running Shoes - Lightweight",
                price=129.99,
                category="Sports",
                rating=4.3,
                features=["breathable", "cushioned", "lightweight"],
                options={"size": ["7", "8", "9", "10", "11"], "color": ["gray", "black"]},
                attributes={"type": "shoes"},
            ),
            Product(
                product_id="P003",
                name="Organic Green Tea - 100 Bags",
                price=15.99,
                category="Food",
                rating=4.7,
                features=["organic", "green tea", "antioxidants", "decaf option"],
                options={"type": ["regular", "decaf"]},
                attributes={"type": "tea"},
            ),
            Product(
                product_id="P004",
                name="Stainless Steel Water Bottle",
                price=24.99,
                category="Sports",
                rating=4.6,
                features=["insulated", "leak-proof", "eco-friendly"],
                options={"size": ["500ml", "750ml", "1L"], "color": ["silver", "blue", "green"]},
                attributes={"type": "bottle"},
            ),
            Product(
                product_id="P005",
                name="USB-C Laptop Charger 65W",
                price=45.99,
                category="Electronics",
                rating=4.4,
                features=["usb-c", "65w", "fast charging", "compact"],
                options={},
                attributes={"type": "charger"},
            ),
        ]

    def create_sample_tasks(self) -> list[WebShopTask]:
        # These tasks are designed to be solvable by a simple search -> click -> select -> buy flow.
        return [
            WebShopTask(
                task_id="webshop_sample_001",
                instruction="Buy wireless bluetooth headphones under $100. Prefer black if there is a color option.",
                target_product_ids=["P001"],
                goal_attributes={"type": "headphones", "color": "black"},
                budget=100.0,
            ),
            WebShopTask(
                task_id="webshop_sample_002",
                instruction="Purchase an insulated leak-proof water bottle. Select size 750ml if available.",
                target_product_ids=["P004"],
                goal_attributes={"type": "bottle", "size": "750ml"},
                budget=50.0,
            ),
            WebShopTask(
                task_id="webshop_sample_003",
                instruction="Get organic green tea. Choose decaf if possible.",
                target_product_ids=["P003"],
                goal_attributes={"type": "tea", "type_option": "decaf"},
                budget=30.0,
            ),
        ]

    # ---------------------------------------------------------------------
    # HuggingFace load (optional)
    # ---------------------------------------------------------------------

    async def _try_load_from_huggingface(self) -> bool:
        try:
            from datasets import load_dataset  # type: ignore[import-not-found]
        except Exception:
            return False

        # Best-effort: tasks only. Product catalogs are huge; we intentionally
        # keep this benchmark runnable without downloading 1M products.
        try:
            ds = load_dataset("web_agent_bench/webshop", split=self.split)
        except Exception as e:
            logger.warning(f"[WebShopDataset] Failed to load HF dataset: {e}")
            return False

        tasks: list[WebShopTask] = []
        for row in ds:
            # We intentionally validate conservatively (no casts, no Any).
            task_id = row.get("id")
            instruction = row.get("instruction")
            targets = row.get("target_asins") or row.get("target_asin")

            if not isinstance(task_id, str) or not isinstance(instruction, str):
                continue
            if not isinstance(targets, list) or not all(isinstance(x, str) for x in targets):
                continue

            tasks.append(
                WebShopTask(
                    task_id=task_id,
                    instruction=instruction,
                    target_product_ids=list(targets),
                    goal_attributes={},
                    budget=None,
                )
            )

        # No products loaded in HF mode; environment must be provided externally.
        self.products = {}
        self.tasks = tasks
        logger.info(f"[WebShopDataset] Loaded {len(self.tasks)} tasks from HuggingFace ({self.split})")
        return True

