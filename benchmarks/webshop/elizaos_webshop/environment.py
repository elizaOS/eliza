from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from elizaos_webshop.types import PageObservation, PageType, Product, SearchResult, WebShopTask

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class StepOutcome:
    observation: PageObservation
    reward: float
    done: bool
    info: dict[str, str | int | float | bool]


class WebShopEnvironment:
    """
    A lightweight WebShop-style environment (no browser, no server).

    Action space (string actions):
    - search[query]
    - click[product_id]
    - select_option[option_name, value]
    - back
    - buy
    """

    def __init__(self, *, products: dict[str, Product]) -> None:
        self._products = products
        self._task: WebShopTask | None = None

        self._page: PageType = PageType.SEARCH
        self._query: str = ""
        self._results: list[Product] = []
        self._selected_product: Product | None = None
        self._selected_options: dict[str, str] = {}
        self._purchased_product_id: str | None = None
        self._done: bool = False
        self._final_reward: float = 0.0

    @property
    def purchased_product_id(self) -> str | None:
        return self._purchased_product_id

    @property
    def done(self) -> bool:
        return self._done

    @property
    def final_reward(self) -> float:
        return self._final_reward

    def reset(self, task: WebShopTask) -> PageObservation:
        self._task = task
        self._page = PageType.SEARCH
        self._query = ""
        self._results = []
        self._selected_product = None
        self._selected_options = {}
        self._purchased_product_id = None
        self._done = False
        self._final_reward = 0.0
        return self._observe(message="Welcome to WebShop. Use search[query] to find products.")

    def step(self, action: str) -> StepOutcome:
        if self._done:
            obs = self._observe(message="Episode already completed.")
            return StepOutcome(
                observation=obs,
                reward=0.0,
                done=True,
                info={"error": "episode_done"},
            )

        parsed = self._parse_action(action)
        action_type = parsed["type"]
        params = parsed["params"]

        reward = 0.0
        done = False

        if action_type == "search":
            query = params.get("query", "")
            self._query = query
            self._results = self._search(query)
            self._page = PageType.RESULTS
            self._selected_product = None
            self._selected_options = {}
            msg = f"Found {len(self._results)} products for '{query}'."
            reward = 0.05 if self._results else 0.0
            obs = self._observe(message=msg)
            return StepOutcome(obs, reward, False, {"action_type": "search", "query": query})

        if action_type == "click":
            pid = params.get("product_id", "")
            product = self._products.get(pid)
            if product is None:
                obs = self._observe(message=f"Product '{pid}' not found.")
                return StepOutcome(obs, -0.05, False, {"action_type": "click", "error": "not_found"})
            self._selected_product = product
            self._selected_options = {}
            self._page = PageType.PRODUCT
            obs = self._observe(message=f"Viewing product: {product.name}")
            return StepOutcome(obs, 0.05, False, {"action_type": "click", "product_id": pid})

        if action_type == "select_option":
            if self._page != PageType.PRODUCT or self._selected_product is None:
                obs = self._observe(message="No product selected. Click a product first.")
                return StepOutcome(
                    obs, -0.05, False, {"action_type": "select_option", "error": "no_product"}
                )
            opt = params.get("option", "")
            val = params.get("value", "")
            options = self._selected_product.options
            if opt not in options:
                obs = self._observe(message=f"Option '{opt}' not available for this product.")
                return StepOutcome(
                    obs, -0.05, False, {"action_type": "select_option", "error": "bad_option"}
                )
            if val not in options[opt]:
                obs = self._observe(message=f"Value '{val}' not available for option '{opt}'.")
                return StepOutcome(
                    obs, -0.05, False, {"action_type": "select_option", "error": "bad_value"}
                )
            self._selected_options[opt] = val
            obs = self._observe(message=f"Selected {opt}: {val}")
            return StepOutcome(
                obs,
                0.05,
                False,
                {"action_type": "select_option", "option": opt, "value": val},
            )

        if action_type == "back":
            if self._page == PageType.PRODUCT:
                self._page = PageType.RESULTS
                self._selected_product = None
                self._selected_options = {}
                obs = self._observe(message="Back to search results.")
                return StepOutcome(obs, 0.0, False, {"action_type": "back"})
            if self._page == PageType.RESULTS:
                self._page = PageType.SEARCH
                self._query = ""
                self._results = []
                obs = self._observe(message="Back to search.")
                return StepOutcome(obs, 0.0, False, {"action_type": "back"})

            obs = self._observe(message="You're already at the start.")
            return StepOutcome(obs, 0.0, False, {"action_type": "back"})

        if action_type == "buy":
            if self._page != PageType.PRODUCT or self._selected_product is None:
                obs = self._observe(message="You must view a product before buying.")
                return StepOutcome(obs, -0.1, False, {"action_type": "buy", "error": "no_product"})

            missing = self._missing_required_options()
            if missing:
                obs = self._observe(
                    message=f"Select required options before buying: {', '.join(sorted(missing))}"
                )
                return StepOutcome(
                    obs,
                    -0.05,
                    False,
                    {"action_type": "buy", "error": "missing_options"},
                )

            self._purchased_product_id = self._selected_product.product_id
            self._page = PageType.CONFIRMATION
            self._done = True
            reward = self._calculate_reward()
            self._final_reward = reward
            done = True
            obs = self._observe(message=f"Purchase completed. Reward: {reward:.2f}")
            return StepOutcome(
                obs,
                reward,
                done,
                {"action_type": "buy", "purchased_product_id": self._purchased_product_id},
            )

        obs = self._observe(
            message="Invalid action. Use: search[...], click[...], select_option[...], back, buy"
        )
        return StepOutcome(obs, -0.1, False, {"action_type": "invalid"})

    # ---------------------------------------------------------------------
    # Observation / formatting
    # ---------------------------------------------------------------------

    def _observe(self, *, message: str) -> PageObservation:
        results: list[SearchResult] | None = None
        if self._page == PageType.RESULTS:
            results = [
                SearchResult(
                    product_id=p.product_id,
                    name=p.name,
                    price=p.price,
                    rating=p.rating,
                    category=p.category,
                )
                for p in self._results[:10]
            ]

        available = self._available_actions()
        return PageObservation(
            page_type=self._page,
            message=message,
            query=self._query if self._page in (PageType.RESULTS,) else None,
            results=results,
            product=self._selected_product if self._page == PageType.PRODUCT else None,
            selected_options=dict(self._selected_options),
            available_actions=available,
        )

    def _available_actions(self) -> list[str]:
        if self._page == PageType.SEARCH:
            return ["search[query]"]
        if self._page == PageType.RESULTS:
            actions = ["search[query]", "back"]
            for r in self._results[:10]:
                actions.append(f"click[{r.product_id}]")
            return actions
        if self._page == PageType.PRODUCT and self._selected_product is not None:
            actions = ["back", "buy"]
            for opt, vals in self._selected_product.options.items():
                for v in vals:
                    actions.append(f"select_option[{opt}, {v}]")
            return actions
        if self._page == PageType.CONFIRMATION:
            return []
        return []

    # ---------------------------------------------------------------------
    # Parsing / search / reward
    # ---------------------------------------------------------------------

    def _parse_action(self, action: str) -> dict[str, object]:
        a = action.strip()

        m = re.search(r"search\[([^\]]+)\]", a, re.IGNORECASE)
        if m:
            return {"type": "search", "params": {"query": m.group(1).strip()}}

        m = re.search(r"click\[([^\]]+)\]", a, re.IGNORECASE)
        if m:
            return {"type": "click", "params": {"product_id": m.group(1).strip()}}

        m = re.search(
            r"select[_\s]?option\[([^,]+),\s*([^\]]+)\]",
            a,
            re.IGNORECASE,
        )
        if m:
            return {
                "type": "select_option",
                "params": {"option": m.group(1).strip(), "value": m.group(2).strip()},
            }

        if re.fullmatch(r"\s*back\s*", a, re.IGNORECASE):
            return {"type": "back", "params": {}}

        if re.fullmatch(r"\s*(buy|purchase|checkout)\s*", a, re.IGNORECASE):
            return {"type": "buy", "params": {}}

        return {"type": "invalid", "params": {}}

    def _search(self, query: str) -> list[Product]:
        q = query.lower().strip()
        if not q:
            return []

        budget_max: float | None = None
        m = re.search(r"(?:under|below|less than|max)\s*\$?\s*(\d+(?:\.\d+)?)", q)
        if m:
            try:
                budget_max = float(m.group(1))
            except ValueError:
                budget_max = None

        tokens = [t for t in re.findall(r"[a-z0-9]+", q) if t]
        stop = {
            "under",
            "below",
            "less",
            "than",
            "max",
            "with",
            "and",
            "or",
            "for",
            "a",
            "an",
            "the",
            "to",
            "of",
            "in",
            "on",
            "usd",
            "dollar",
            "dollars",
            "buy",
            "purchase",
        }
        tokens = [t for t in tokens if t not in stop]
        if not tokens:
            tokens = [q]

        scored: list[tuple[int, Product]] = []
        for p in self._products.values():
            if budget_max is not None and p.price > budget_max:
                continue
            score = 0
            name_l = p.name.lower()
            cat_l = p.category.lower()
            feats_l = [f.lower() for f in p.features]
            for tok in tokens:
                if tok in name_l:
                    score += 3
                if tok in cat_l:
                    score += 2
                if any(tok in f for f in feats_l):
                    score += 1
            if score > 0:
                scored.append((score, p))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [p for _, p in scored]

    def _missing_required_options(self) -> set[str]:
        if self._selected_product is None:
            return set()
        required = set(self._selected_product.options.keys())
        selected = set(self._selected_options.keys())
        return required - selected

    def _calculate_reward(self) -> float:
        task = self._task
        product = self._selected_product
        if task is None or product is None:
            return 0.0

        # Perfect reward if we buy an explicit target product.
        if product.product_id in task.target_product_ids:
            base = 1.0
        else:
            # Partial reward by attribute matches.
            # We only use goal_attributes keys that exist for the product or selected options.
            goals = task.goal_attributes
            if not goals:
                base = 0.0
            else:
                matches = 0.0
                total = 0.0
                merged_attrs: dict[str, str] = dict(product.attributes)
                for k, v in self._selected_options.items():
                    merged_attrs[k] = v
                for k, v in goals.items():
                    total += 1.0
                    actual = merged_attrs.get(k)
                    if actual is None:
                        continue
                    if actual.strip().lower() == v.strip().lower():
                        matches += 1.0
                    elif v.strip().lower() in actual.strip().lower():
                        matches += 0.5
                base = matches / total if total > 0.0 else 0.0

        # Budget penalty
        if task.budget is not None and product.price > task.budget:
            base *= 0.5
        return max(0.0, min(1.0, base))

