"""
WebShop environment adapter for AgentBench.

This adapter handles online shopping tasks - product search and purchase.
"""

import logging
import re
from collections.abc import Callable
from typing import TypedDict

from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentRuntimeProtocol,
    AgentBenchTask,
    EnvironmentConfig,
    ObservationType,
)
from elizaos_agentbench.adapters.base import EnvironmentAdapter

logger = logging.getLogger(__name__)


# Type alias for step info
StepInfoType = dict[str, str | int | float | bool | None]


class ProductType(TypedDict, total=False):
    """Type definition for a product."""
    id: str
    name: str
    price: float
    category: str
    rating: float
    features: list[str]
    options: dict[str, list[str]]


class CartItemType(TypedDict):
    """Type definition for a cart item."""
    product: ProductType
    options: dict[str, str]
    quantity: int


class ParsedActionType(TypedDict):
    """Type definition for parsed action."""
    type: str
    params: dict[str, str]

class ProductSummaryType(TypedDict):
    id: str
    name: str
    price: str
    rating: float
    category: str


class ProductDetailType(TypedDict):
    id: str
    name: str
    price: str
    rating: float
    category: str
    features: list[str]
    options: dict[str, list[str]]


class CartDisplayItemType(TypedDict):
    name: str
    price: str
    options: dict[str, str]


# Simulated product database for testing
SAMPLE_PRODUCTS = [
    {
        "id": "P001",
        "name": "Wireless Bluetooth Headphones",
        "price": 79.99,
        "category": "Electronics",
        "rating": 4.5,
        "features": ["noise cancelling", "40h battery", "comfortable"],
        "options": {"color": ["black", "white", "blue"]},
    },
    {
        "id": "P002",
        "name": "Running Shoes - Lightweight",
        "price": 129.99,
        "category": "Sports",
        "rating": 4.3,
        "features": ["breathable", "cushioned", "lightweight"],
        "options": {"size": ["7", "8", "9", "10", "11"], "color": ["gray", "black"]},
    },
    {
        "id": "P003",
        "name": "Organic Green Tea - 100 Bags",
        "price": 15.99,
        "category": "Food",
        "rating": 4.7,
        "features": ["organic", "antioxidants", "caffeine-free option"],
        "options": {"type": ["regular", "decaf"]},
    },
    {
        "id": "P004",
        "name": "Stainless Steel Water Bottle",
        "price": 24.99,
        "category": "Sports",
        "rating": 4.6,
        "features": ["insulated", "leak-proof", "eco-friendly"],
        "options": {"size": ["500ml", "750ml", "1L"], "color": ["silver", "blue", "green"]},
    },
    {
        "id": "P005",
        "name": "USB-C Laptop Charger 65W",
        "price": 45.99,
        "category": "Electronics",
        "rating": 4.4,
        "features": ["fast charging", "compact", "universal"],
        "options": {},
    },
]


class WebShopEnvironmentAdapter(EnvironmentAdapter):
    """
    Adapter for WebShop environment.

    Tasks include product search, filtering, comparison, and purchase.
    """

    environment = AgentBenchEnvironment.WEB_SHOPPING

    def __init__(
        self,
        runtime: AgentRuntimeProtocol | None = None,
        config: EnvironmentConfig | None = None,
    ) -> None:
        super().__init__(runtime, config)
        self._products: list[ProductType] = []
        self._current_page: str = "home"
        self._search_results: list[ProductType] = []
        self._cart: list[CartItemType] = []
        self._selected_product: ProductType | None = None
        self._selected_options: dict[str, str] = {}
        self._action_history: list[str] = []

    async def initialize(self) -> None:
        """Initialize WebShop environment."""
        if self._initialized:
            return

        logger.info("[WebShop] Initializing WebShop environment adapter...")

        # Load product catalog (can be extended to load from file/API)
        self._products = SAMPLE_PRODUCTS.copy()

        self._initialized = True
        logger.info("[WebShop] WebShop environment adapter initialized")

    async def reset(self, task: AgentBenchTask) -> ObservationType:
        """Reset environment for a new task."""
        self._current_page = "home"
        self._search_results = []
        self._cart = []
        self._selected_product = None
        self._selected_options = {}
        self._action_history = []

        # Load custom products if specified in task
        custom_products = task.initial_state.get("products")
        if isinstance(custom_products, list):
            # Validate custom products (strong validation, no casting)
            validated_products: list[ProductType] = []
            for p in custom_products:
                if not isinstance(p, dict):
                    continue
                pid = p.get("id")
                name = p.get("name")
                price = p.get("price")
                category = p.get("category")
                rating = p.get("rating")
                features = p.get("features", [])
                options = p.get("options", {})

                if not isinstance(pid, str) or not pid:
                    continue
                if not isinstance(name, str) or not name:
                    continue
                if not isinstance(price, (int, float)) or float(price) < 0:
                    continue
                if not isinstance(category, str) or not category:
                    continue
                if not isinstance(rating, (int, float)) or not (0 <= float(rating) <= 5):
                    continue
                if not isinstance(features, list) or not all(isinstance(f, str) for f in features):
                    continue
                if not isinstance(options, dict) or not all(
                    isinstance(k, str) and isinstance(v, list) and all(isinstance(x, str) for x in v)
                    for k, v in options.items()
                ):
                    continue

                validated_products.append(
                    {
                        "id": pid,
                        "name": name,
                        "price": float(price),
                        "category": category,
                        "rating": float(rating),
                        "features": features,
                        "options": options,
                    }
                )
            if validated_products:
                self._products = validated_products

        # Set budget constraint if specified with validation
        raw_budget = task.initial_state.get("budget")
        if isinstance(raw_budget, (int, float)) and raw_budget > 0:
            budget: float = float(raw_budget)
        else:
            budget = float("inf")

        return {
            "page": self._current_page,
            "task_description": task.description,
            "goal": task.goal,
            "budget": budget,
            "cart": [],
            "message": "Welcome to WebShop! Use search[query] to find products.",
        }

    async def step(self, action: str) -> tuple[ObservationType, float, bool, StepInfoType]:
        """Execute shopping action and return result."""
        parsed_action = self._parse_shopping_action(action)
        action_type = parsed_action.get("type", "invalid")
        params = parsed_action.get("params", {})

        self._action_history.append(action)
        reward = 0.0
        done = False

        if action_type == "search":
            query = params.get("query", "")
            self._search_results = self._search_products(query)
            self._current_page = "search_results"
            reward = 0.05 if self._search_results else 0.0

            observation = {
                "page": "search_results",
                "query": query,
                "results": [self._format_product_summary(p) for p in self._search_results[:5]],
                "total_results": len(self._search_results),
                "message": f"Found {len(self._search_results)} products matching '{query}'",
            }

        elif action_type == "click":
            product_id = params.get("product_id", "")
            product = self._find_product(product_id)
            if product:
                self._selected_product = product
                self._selected_options = {}
                self._current_page = "product_detail"
                reward = 0.05

                observation = {
                    "page": "product_detail",
                    "product": self._format_product_detail(product),
                    "message": f"Viewing product: {product['name']}",
                }
            else:
                observation = {
                    "page": self._current_page,
                    "error": f"Product {product_id} not found",
                    "message": "Product not found. Please try another.",
                }
                reward = -0.05

        elif action_type == "select_option":
            option_name = params.get("option", "")
            option_value = params.get("value", "")

            if self._selected_product:
                available_options = self._selected_product.get("options", {})
                if option_name in available_options:
                    if option_value in available_options[option_name]:
                        self._selected_options[option_name] = option_value
                        reward = 0.05
                        observation = {
                            "page": "product_detail",
                            "product": self._format_product_detail(self._selected_product),
                            "selected_options": self._selected_options,
                            "message": f"Selected {option_name}: {option_value}",
                        }
                    else:
                        observation = {
                            "page": "product_detail",
                            "error": f"Option value '{option_value}' not available",
                            "available": available_options[option_name],
                            "message": f"Invalid option value for {option_name}",
                        }
                        reward = -0.05
                else:
                    observation = {
                        "page": "product_detail",
                        "error": f"Option '{option_name}' not found",
                        "message": "Invalid option name",
                    }
                    reward = -0.05
            else:
                observation = {"error": "No product selected", "message": "Please select a product first"}
                reward = -0.05

        elif action_type == "add_to_cart":
            if self._selected_product:
                # Check if all required options are selected
                required_options = set(self._selected_product.get("options", {}).keys())
                selected = set(self._selected_options.keys())

                if required_options <= selected:
                    cart_item = {
                        "product": self._selected_product,
                        "options": self._selected_options.copy(),
                        "quantity": 1,
                    }
                    self._cart.append(cart_item)
                    reward = 0.2

                    observation = {
                        "page": "product_detail",
                        "cart": self._format_cart(),
                        "message": f"Added {self._selected_product['name']} to cart! Use checkout to complete purchase.",
                    }
                else:
                    missing = required_options - selected
                    observation = {
                        "page": "product_detail",
                        "error": f"Please select options: {missing}",
                        "message": "Please select all options before adding to cart",
                    }
                    reward = -0.05
            else:
                observation = {"error": "No product selected", "message": "Please select a product first"}
                reward = -0.05

        elif action_type == "checkout":
            if self._cart:
                total = sum(item["product"]["price"] for item in self._cart)
                done = True
                reward = 0.5
                self._current_page = "checkout_complete"

                observation = {
                    "page": "checkout_complete",
                    "cart": self._format_cart(),
                    "total": total,
                    "message": f"Order placed successfully! Total: ${total:.2f}",
                }
            else:
                observation = {"error": "Cart is empty", "message": "Add items to cart before checkout"}
                reward = -0.1

        elif action_type == "back":
            if self._current_page == "product_detail":
                self._current_page = "search_results"
                self._selected_product = None
                self._selected_options = {}
                observation = {
                    "page": "search_results",
                    "results": [self._format_product_summary(p) for p in self._search_results[:5]],
                    "message": "Back to search results",
                }
            else:
                self._current_page = "home"
                observation = {"page": "home", "message": "Back to home"}

        elif action_type == "think":
            # Allow agent to think without taking action
            observation = {
                "page": self._current_page,
                "message": "Thinking...",
                "cart": self._format_cart() if self._cart else [],
            }
            reward = 0.0

        else:
            observation = {
                "page": self._current_page,
                "error": f"Unknown action: {action_type}",
                "message": "Invalid action. Try: search[query], click[id], select_option[name, value], add_to_cart, checkout, back",
            }
            reward = -0.1

        observation["cart_count"] = len(self._cart)
        observation["cart_total"] = sum(item["product"]["price"] for item in self._cart)
        if self._cart and "cart" not in observation:
            observation["cart"] = self._format_cart()

        # info must be primitives only (stable JSON logging)
        return observation, reward, done, {"action_type": action_type, "params": str(params)}

    def _parse_shopping_action(self, action: str) -> ParsedActionType:
        """Parse shopping action from text."""
        action = action.strip().lower()

        # Try to extract action type and params
        ParamExtractor = Callable[[re.Match[str]], dict[str, str]]
        PatternSpec = tuple[str, str, ParamExtractor]

        patterns: list[PatternSpec] = [
            (r"search\[([^\]]+)\]", "search", lambda m: {"query": m.group(1)}),
            (r"search[:\s]+(.+)", "search", lambda m: {"query": m.group(1)}),
            (r"click\[([^\]]+)\]", "click", lambda m: {"product_id": m.group(1)}),
            (r"click[:\s]+(\S+)", "click", lambda m: {"product_id": m.group(1)}),
            (
                r"select[_\s]?option\[([^,]+),\s*([^\]]+)\]",
                "select_option",
                lambda m: {"option": m.group(1).strip(), "value": m.group(2).strip()},
            ),
            (r"add[_\s]?to[_\s]?cart", "add_to_cart", lambda _m: {}),
            (r"checkout|buy|purchase", "checkout", lambda _m: {}),
            (r"back|return", "back", lambda _m: {}),
            (r"think", "think", lambda _m: {}),
        ]

        for pattern, action_type, param_extractor in patterns:
            match = re.search(pattern, action, re.IGNORECASE)
            if match:
                return {"type": action_type, "params": param_extractor(match)}

        return {"type": "invalid", "params": {}}

    def _search_products(self, query: str) -> list[ProductType]:
        """Search products by query."""
        query_l = query.lower().strip()
        if not query_l:
            return []

        # Heuristic query understanding:
        # - allow natural queries like "black wireless headphones under $100"
        # - ignore common stopwords and budget phrasing for matching
        # - apply a simple budget filter when we can infer it
        budget_max: float | None = None
        if any(k in query_l for k in (" under ", " below ", " less than ", " at most ", " max ")):
            m = re.search(r"\$?\s*(\d+(?:\.\d+)?)", query_l)
            if m:
                try:
                    budget_max = float(m.group(1))
                except ValueError:
                    budget_max = None

        stopwords = {
            "under",
            "below",
            "less",
            "than",
            "at",
            "most",
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
        }
        tokens = [t for t in re.findall(r"[a-z]+", query_l) if t and t not in stopwords]
        if not tokens:
            # Fallback to the full query as a single term if tokenization produced nothing.
            tokens = [query_l]

        results: list[tuple[int, ProductType]] = []

        for product in self._products:
            if budget_max is not None:
                price_val = product.get("price")
                price = float(price_val) if isinstance(price_val, (int, float)) else None
                if price is None or price > budget_max:
                    continue

            name = product.get("name")
            category = product.get("category")
            if not isinstance(name, str) or not isinstance(category, str):
                continue

            name_l = name.lower()
            category_l = category.lower()

            raw_features = product.get("features", [])
            features = raw_features if isinstance(raw_features, list) else []
            features_l = [f.lower() for f in features if isinstance(f, str)]

            score = 0
            for tok in tokens:
                if tok in name_l:
                    score += 3
                if tok in category_l:
                    score += 2
                if any(tok in f for f in features_l):
                    score += 1

            if score > 0:
                results.append((score, product))

        # Sort by score and return products
        results.sort(key=lambda x: x[0], reverse=True)
        return [p for _, p in results]

    def _find_product(self, product_id: str) -> ProductType | None:
        """Find product by ID."""
        for product in self._products:
            pid = product.get("id")
            if isinstance(pid, str) and pid.lower() == product_id.lower():
                return product
        return None

    def _format_product_summary(self, product: ProductType) -> ProductSummaryType:
        """Format product for search results."""
        return {
            "id": product["id"],
            "name": product["name"],
            "price": f"${product['price']:.2f}",
            "rating": float(product["rating"]),
            "category": product["category"],
        }

    def _format_product_detail(self, product: ProductType) -> ProductDetailType:
        """Format full product details."""
        return {
            "id": product["id"],
            "name": product["name"],
            "price": f"${product['price']:.2f}",
            "rating": float(product["rating"]),
            "category": product["category"],
            "features": list(product.get("features", [])),
            "options": dict(product.get("options", {})),
        }

    def _format_cart(self) -> list[CartDisplayItemType]:
        """Format cart contents."""
        return [
            {
                "name": item["product"]["name"],
                "price": f"${item['product']['price']:.2f}",
                "options": dict(item["options"]),
            }
            for item in self._cart
        ]

    async def evaluate(self, task: AgentBenchTask, trajectory: list[str]) -> bool:
        """Evaluate if shopping task was completed correctly."""
        # Must have completed checkout for a successful purchase
        if self._current_page != "checkout_complete":
            return False

        if not self._cart:
            return False

        # Check if target product was purchased
        target_product = task.metadata.get("target_product")
        if isinstance(target_product, str) and target_product:
            for item in self._cart:
                if item["product"]["id"] == target_product:
                    # Check required options
                    required_options = task.metadata.get("required_options", {})
                    if isinstance(required_options, dict):
                        for opt, val in required_options.items():
                            if not isinstance(opt, str) or not isinstance(val, str):
                                return False
                            if item["options"].get(opt) != val:
                                return False
                    return True
            return False

        # Category-based selection (e.g., highest-rated Sports product)
        target_category_val = task.metadata.get("target_category")
        selection_val = task.metadata.get("selection_criteria")
        if isinstance(target_category_val, str) and isinstance(selection_val, str):
            target_category = target_category_val.strip().lower()
            selection = selection_val.strip().lower()
            if target_category and selection == "highest_rating":
                candidates = [
                    p
                    for p in self._products
                    if isinstance(p.get("category"), str)
                    and p.get("category", "").strip().lower() == target_category
                    and isinstance(p.get("rating"), (int, float))
                ]
                if not candidates:
                    return False
                expected = max(candidates, key=lambda p: float(p.get("rating", 0.0)))
                expected_id = expected.get("id")
                if not isinstance(expected_id, str):
                    return False
                return any(item["product"]["id"] == expected_id for item in self._cart)

        # Check budget constraint
        raw_budget = task.initial_state.get("budget", float("inf"))
        budget = float(raw_budget) if isinstance(raw_budget, (int, float)) else float("inf")
        total = sum(item["product"]["price"] for item in self._cart)
        if total > budget:
            return False

        return True

    async def cleanup(self) -> None:
        """Cleanup resources."""
        self._products = []
        self._cart = []
        self._search_results = []
        self._selected_product = None
        self._initialized = False

    def get_action_space(self) -> list[str]:
        """Get available shopping actions."""
        return [
            "search[query]",
            "click[product_id]",
            "select_option[name, value]",
            "add_to_cart",
            "checkout",
            "back",
            "think",
        ]

    def format_prompt(self, task: AgentBenchTask, observation: ObservationType) -> str:
        """Format observation into prompt for LLM."""
        page = observation.get("page", "home")
        message = observation.get("message", "")
        error = observation.get("error", "")

        content_section = ""
        if page == "search_results":
            results = observation.get("results", [])
            if isinstance(results, list) and results:
                content_section = "**Search Results:**\n"
                for r in results:
                    if isinstance(r, dict):
                        rid = r.get("id", "")
                        rname = r.get("name", "")
                        rprice = r.get("price", "")
                        rrating = r.get("rating", "")
                        content_section += f"- [{rid}] {rname} - {rprice} (★{rrating})\n"
            else:
                content_section = "No products found.\n"

        elif page == "product_detail":
            raw_product = observation.get("product", {})
            product = raw_product if isinstance(raw_product, dict) else {}
            raw_features = product.get("features", [])
            features = raw_features if isinstance(raw_features, list) else []
            features_str = ", ".join([f for f in features if isinstance(f, str)])

            content_section = f"""**Product Details:**
- Name: {product.get('name', 'N/A')}
- Price: {product.get('price', 'N/A')}
- Rating: ★{product.get('rating', 'N/A')}
- Features: {features_str}
"""
            options_obj = product.get("options", {})
            if isinstance(options_obj, dict) and options_obj:
                content_section += "- Options:\n"
                for opt, vals in options_obj.items():
                    if isinstance(opt, str):
                        selected = self._selected_options.get(opt, "not selected")
                        content_section += f"  - {opt}: {vals} (selected: {selected})\n"

        cart_section = ""
        cart = observation.get("cart")
        if isinstance(cart, list) and cart:
            cart_section = "\n**Cart:**\n"
            for item in cart:
                if isinstance(item, dict):
                    cart_section += f"- {item.get('name', '')} - {item.get('price', '')}\n"
            cart_section += f"Total: ${observation.get('cart_total', 0):.2f}\n"

        return f"""You are an AI shopping assistant. Complete the following shopping task.

**Task:** {task.description}
**Goal:** {task.goal}
**Budget:** ${task.initial_state.get('budget', 'unlimited')}

IMPORTANT:
- Respond with exactly ONE action line (no explanation).
- Typical flow is: search[...] -> click[...] -> select_option[...] -> add_to_cart -> checkout
- You cannot add items directly from search results; you must click a product first.
- If the correct item is already in your cart, do NOT add duplicates — use checkout.

**Current Page:** {page}
{f"**Message:** {message}" if message else ""}
{f"**Error:** {error}" if error else ""}

{content_section}
{cart_section}

**Available Actions:**
- search[query]: Search for products
- click[product_id]: View product details
- select_option[option_name, value]: Select a product option (if needed)
- add_to_cart: Add current product to cart (REQUIRED before checkout!)
- checkout: Complete purchase (only after add_to_cart)
- back: Go back to previous page
- think: Think about next steps

IMPORTANT: You MUST use add_to_cart before checkout. The typical flow is:
search -> click -> (optional: select_option) -> add_to_cart -> checkout

Respond with your next action."""

    def parse_action(self, response: str) -> str:
        """Parse LLM response to extract shopping action."""
        # Try to find action in response
        action_patterns = [
            r"```\n?(.+?)\n?```",
            r"action:\s*(.+)",
            r"^(search\[.+\])",
            r"^(click\[.+\])",
            r"^(select_option\[.+\])",
            r"^(add_to_cart)",
            r"^(checkout)",
            r"^(back)",
        ]

        for pattern in action_patterns:
            match = re.search(pattern, response, re.IGNORECASE | re.MULTILINE)
            if match:
                return match.group(1).strip()

        # Return the first line as fallback
        first_line = response.strip().split("\n")[0]
        return first_line
