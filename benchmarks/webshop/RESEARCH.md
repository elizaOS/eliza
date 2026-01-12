# WebShop Benchmark Research

## Overview

WebShop is a benchmark for evaluating LLM agents in simulated online shopping environments. It tests an agent's ability to navigate e-commerce websites, search for products, compare options, and make purchasing decisions based on user instructions.

## Official Resources

- **GitHub Repository**: [princeton-nlp/WebShop](https://github.com/princeton-nlp/WebShop)
- **Paper**: "WebShop: Towards Scalable Real-World Web Interaction with Grounded Language Agents" (NeurIPS 2022)
- **arXiv**: https://arxiv.org/abs/2207.01206

## Benchmark Details

### Dataset Statistics

- **Products**: 1.18 million real products from Amazon
- **Instructions**: 12,087 crowd-sourced shopping instructions
- **Attributes**: Products have titles, descriptions, prices, options (size, color), and reviews
- **Categories**: Wide range including electronics, clothing, home goods, etc.

### Task Format

Each task consists of:
1. **Instruction**: Natural language description of what the user wants to buy
   - Example: "I need a pink bluetooth speaker that is waterproof and under $50"
2. **Goal Attributes**: Extracted attributes the product should match
3. **Target Product(s)**: One or more products that satisfy the instruction

### Action Space

Agents can perform the following actions:

| Action | Description |
|--------|-------------|
| `search[query]` | Search for products using a text query |
| `click[element]` | Click on a page element (product, button, option) |
| `back` | Return to previous page |
| `buy` | Complete the purchase (terminal action) |

### Page Types

1. **Search Page**: Shows search results with product listings
2. **Product Page**: Detailed product information with options
3. **Results Page**: Filtered/sorted search results

### Evaluation Metrics

1. **Reward Score** (0-1): Measures attribute match between purchased and target product
   - Exact attribute matches contribute to score
   - Partial credit for similar attributes
   - Price constraint satisfaction

2. **Success Rate**: Binary success (reward >= threshold, typically 1.0)

3. **Average Reward**: Mean reward across all episodes

4. **Task Completion Rate**: Percentage of episodes where agent clicks "buy"

## Technical Requirements

### Dependencies

```
flask>=2.0.0
selenium>=4.0.0
beautifulsoup4>=4.9.0
rich>=10.0.0
datasets>=2.0.0
transformers>=4.0.0
numpy>=1.21.0
faiss-cpu>=1.7.0  # For product search
```

### Environment Setup

1. **Web Server**: Flask-based server simulating e-commerce site
2. **Product Database**: Pre-loaded product catalog (can use subset for testing)
3. **Search Index**: FAISS or similar for product search functionality

### Data Download

```python
from datasets import load_dataset

# Load WebShop dataset from HuggingFace
dataset = load_dataset("web_agent_bench/webshop")

# Or download from GitHub
# git clone https://github.com/princeton-nlp/WebShop.git
# cd WebShop && ./setup.sh
```

## Existing Implementations

### Original Implementation (Princeton NLP)

The original repo provides:
- Flask web server simulating Amazon-like interface
- Baseline agents (rule-based, IL, RL)
- Evaluation scripts
- Product database loading utilities

### Key Components

1. **Web Environment** (`web_agent_site/`):
   - HTML templates for pages
   - Product database integration
   - Session management

2. **Agent Interface** (`baseline_models/`):
   - Observation parsing
   - Action formatting
   - Episode management

## ElizaOS Implementation Plan

### Phase 1: Core Types and Data Structures

```python
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
from decimal import Decimal

class PageType(Enum):
    SEARCH = "search"
    RESULTS = "results"
    PRODUCT = "product"
    CONFIRMATION = "confirmation"

class ActionType(Enum):
    SEARCH = "search"
    CLICK = "click"
    BACK = "back"
    BUY = "buy"

@dataclass
class ProductOption:
    """Represents a product option (size, color, etc.)."""
    name: str
    values: list[str]
    selected: Optional[str] = None

@dataclass
class Product:
    """Represents a product in WebShop."""
    asin: str
    title: str
    description: str
    price: Decimal
    category: str
    attributes: dict[str, str]
    options: list[ProductOption]
    rating: float
    review_count: int
    image_url: Optional[str] = None

@dataclass
class SearchResult:
    """A single search result."""
    asin: str
    title: str
    price: Decimal
    rating: float
    thumbnail_url: Optional[str] = None

@dataclass
class PageObservation:
    """Current page state observation."""
    page_type: PageType
    url: str
    available_actions: list[str]
    search_results: Optional[list[SearchResult]] = None
    current_product: Optional[Product] = None
    selected_options: dict[str, str] = field(default_factory=dict)

@dataclass
class WebShopAction:
    """Represents an action in WebShop."""
    action_type: ActionType
    argument: Optional[str] = None  # Query for search, element for click

@dataclass
class ShoppingTask:
    """A WebShop shopping task."""
    task_id: str
    instruction: str
    goal_attributes: dict[str, str]
    target_asins: list[str]
    price_upper: Optional[Decimal] = None
    price_lower: Optional[Decimal] = None

@dataclass
class EpisodeStep:
    """A single step in an episode."""
    observation: PageObservation
    action: WebShopAction
    reward: float

@dataclass
class WebShopResult:
    """Result of a single WebShop episode."""
    task_id: str
    purchased_asin: Optional[str]
    purchased_options: dict[str, str]
    reward: float
    steps: list[EpisodeStep]
    success: bool
    total_steps: int
    tokens_used: int = 0

@dataclass
class WebShopReport:
    """Aggregate report for WebShop evaluation."""
    total_tasks: int
    completed_tasks: int
    success_count: int
    success_rate: float
    average_reward: float
    average_steps: float
    total_tokens: int
    results: list[WebShopResult]
```

### Phase 2: Dataset Loader

```python
import json
from pathlib import Path
from typing import Iterator
from datasets import load_dataset

class WebShopDataset:
    """Loads and manages WebShop task data."""
    
    def __init__(self, split: str = "test"):
        self.split = split
        self.tasks: list[ShoppingTask] = []
        self.products: dict[str, Product] = {}
        
    async def load(self, use_huggingface: bool = True) -> None:
        """Load WebShop dataset."""
        if use_huggingface:
            await self._load_from_huggingface()
        else:
            await self._load_from_local()
    
    async def _load_from_huggingface(self) -> None:
        """Load from HuggingFace datasets."""
        dataset = load_dataset("webshop", split=self.split)
        
        for item in dataset:
            task = ShoppingTask(
                task_id=item["id"],
                instruction=item["instruction"],
                goal_attributes=self._parse_attributes(item["attributes"]),
                target_asins=item["target_asins"],
                price_upper=Decimal(str(item.get("price_upper"))) if item.get("price_upper") else None,
                price_lower=Decimal(str(item.get("price_lower"))) if item.get("price_lower") else None
            )
            self.tasks.append(task)
    
    async def _load_from_local(self, data_path: Path = Path("data/webshop")) -> None:
        """Load from local files."""
        tasks_file = data_path / "tasks.json"
        products_file = data_path / "products.json"
        
        # Load tasks
        with open(tasks_file) as f:
            tasks_data = json.load(f)
            for item in tasks_data:
                task = ShoppingTask(
                    task_id=item["id"],
                    instruction=item["instruction"],
                    goal_attributes=item["attributes"],
                    target_asins=item["target_asins"],
                    price_upper=Decimal(str(item["price_upper"])) if item.get("price_upper") else None
                )
                self.tasks.append(task)
        
        # Load products
        with open(products_file) as f:
            products_data = json.load(f)
            for asin, data in products_data.items():
                product = Product(
                    asin=asin,
                    title=data["title"],
                    description=data.get("description", ""),
                    price=Decimal(str(data["price"])),
                    category=data.get("category", ""),
                    attributes=data.get("attributes", {}),
                    options=[
                        ProductOption(name=k, values=v)
                        for k, v in data.get("options", {}).items()
                    ],
                    rating=data.get("rating", 0.0),
                    review_count=data.get("review_count", 0)
                )
                self.products[asin] = product
    
    def _parse_attributes(self, attr_str: str) -> dict[str, str]:
        """Parse attribute string into dictionary."""
        attributes = {}
        if attr_str:
            for pair in attr_str.split("|"):
                if ":" in pair:
                    key, value = pair.split(":", 1)
                    attributes[key.strip()] = value.strip()
        return attributes
    
    def get_task(self, task_id: str) -> Optional[ShoppingTask]:
        """Get a specific task by ID."""
        return next((t for t in self.tasks if t.task_id == task_id), None)
    
    def get_product(self, asin: str) -> Optional[Product]:
        """Get a product by ASIN."""
        return self.products.get(asin)
    
    def __iter__(self) -> Iterator[ShoppingTask]:
        return iter(self.tasks)
    
    def __len__(self) -> int:
        return len(self.tasks)
```

### Phase 3: Web Environment Simulation

```python
from typing import Optional
import re

class WebShopEnvironment:
    """Simulates the WebShop web environment."""
    
    def __init__(self, dataset: WebShopDataset):
        self.dataset = dataset
        self.current_task: Optional[ShoppingTask] = None
        self.current_page: PageType = PageType.SEARCH
        self.search_results: list[SearchResult] = []
        self.current_product: Optional[Product] = None
        self.selected_options: dict[str, str] = {}
        self.history: list[PageObservation] = []
        self.purchased: bool = False
        
    def reset(self, task: ShoppingTask) -> PageObservation:
        """Reset environment for a new task."""
        self.current_task = task
        self.current_page = PageType.SEARCH
        self.search_results = []
        self.current_product = None
        self.selected_options = {}
        self.history = []
        self.purchased = False
        
        return self._get_observation()
    
    def step(self, action: WebShopAction) -> tuple[PageObservation, float, bool]:
        """Execute an action and return new observation, reward, done."""
        if self.purchased:
            raise RuntimeError("Episode already ended")
        
        if action.action_type == ActionType.SEARCH:
            self._do_search(action.argument or "")
        elif action.action_type == ActionType.CLICK:
            self._do_click(action.argument or "")
        elif action.action_type == ActionType.BACK:
            self._do_back()
        elif action.action_type == ActionType.BUY:
            return self._do_buy()
        
        obs = self._get_observation()
        self.history.append(obs)
        
        return obs, 0.0, False
    
    def _do_search(self, query: str) -> None:
        """Execute search action."""
        # Simple keyword matching search
        query_terms = query.lower().split()
        results = []
        
        for asin, product in self.dataset.products.items():
            title_lower = product.title.lower()
            score = sum(1 for term in query_terms if term in title_lower)
            
            if score > 0:
                results.append((score, SearchResult(
                    asin=asin,
                    title=product.title,
                    price=product.price,
                    rating=product.rating
                )))
        
        # Sort by relevance score
        results.sort(key=lambda x: x[0], reverse=True)
        self.search_results = [r for _, r in results[:50]]
        self.current_page = PageType.RESULTS
        self.current_product = None
    
    def _do_click(self, element: str) -> None:
        """Execute click action."""
        # Check if clicking on a search result (ASIN)
        if element.startswith("B") and len(element) == 10:
            product = self.dataset.get_product(element)
            if product:
                self.current_product = product
                self.current_page = PageType.PRODUCT
                self.selected_options = {}
                return
        
        # Check if selecting an option
        if self.current_product:
            for option in self.current_product.options:
                if element in option.values:
                    self.selected_options[option.name] = element
                    return
        
        # Check if clicking search result by index
        if element.isdigit():
            idx = int(element)
            if 0 <= idx < len(self.search_results):
                result = self.search_results[idx]
                product = self.dataset.get_product(result.asin)
                if product:
                    self.current_product = product
                    self.current_page = PageType.PRODUCT
                    self.selected_options = {}
    
    def _do_back(self) -> None:
        """Execute back action."""
        if self.current_page == PageType.PRODUCT:
            self.current_page = PageType.RESULTS
            self.current_product = None
            self.selected_options = {}
        elif self.current_page == PageType.RESULTS:
            self.current_page = PageType.SEARCH
            self.search_results = []
    
    def _do_buy(self) -> tuple[PageObservation, float, bool]:
        """Execute buy action."""
        if not self.current_product:
            obs = self._get_observation()
            return obs, 0.0, True
        
        self.purchased = True
        self.current_page = PageType.CONFIRMATION
        
        # Calculate reward
        reward = self._calculate_reward()
        
        obs = self._get_observation()
        return obs, reward, True
    
    def _calculate_reward(self) -> float:
        """Calculate reward based on purchased product vs goal."""
        if not self.current_product or not self.current_task:
            return 0.0
        
        # Check if purchased product is in target list
        if self.current_product.asin in self.current_task.target_asins:
            base_reward = 1.0
        else:
            # Calculate attribute match score
            goal_attrs = self.current_task.goal_attributes
            product_attrs = self.current_product.attributes
            product_attrs.update(self.selected_options)
            
            matches = 0
            total = len(goal_attrs)
            
            for key, value in goal_attrs.items():
                if key in product_attrs:
                    if product_attrs[key].lower() == value.lower():
                        matches += 1
                    elif value.lower() in product_attrs[key].lower():
                        matches += 0.5
            
            base_reward = matches / total if total > 0 else 0.0
        
        # Check price constraint
        if self.current_task.price_upper:
            if self.current_product.price > self.current_task.price_upper:
                base_reward *= 0.5  # Penalty for exceeding budget
        
        return base_reward
    
    def _get_observation(self) -> PageObservation:
        """Get current page observation."""
        available_actions = self._get_available_actions()
        
        return PageObservation(
            page_type=self.current_page,
            url=self._get_url(),
            available_actions=available_actions,
            search_results=self.search_results if self.current_page == PageType.RESULTS else None,
            current_product=self.current_product if self.current_page == PageType.PRODUCT else None,
            selected_options=self.selected_options.copy()
        )
    
    def _get_available_actions(self) -> list[str]:
        """Get list of available actions."""
        actions = []
        
        if self.current_page == PageType.SEARCH:
            actions.append("search[query]")
        elif self.current_page == PageType.RESULTS:
            actions.append("search[query]")
            actions.append("back")
            for i, result in enumerate(self.search_results[:10]):
                actions.append(f"click[{result.asin}]")
        elif self.current_page == PageType.PRODUCT:
            actions.append("back")
            actions.append("buy")
            if self.current_product:
                for option in self.current_product.options:
                    for value in option.values:
                        actions.append(f"click[{value}]")
        
        return actions
    
    def _get_url(self) -> str:
        """Get current page URL."""
        if self.current_page == PageType.SEARCH:
            return "/search"
        elif self.current_page == PageType.RESULTS:
            return "/results"
        elif self.current_page == PageType.PRODUCT:
            return f"/product/{self.current_product.asin}" if self.current_product else "/product"
        else:
            return "/confirmation"
```

### Phase 4: ElizaOS Agent

```python
from elizaos import Action, Plugin, Provider
from elizaos.runtime import AgentRuntime
from elizaos.types import Memory, State, Content

# Search action
search_action = Action(
    name="WEBSHOP_SEARCH",
    description="Search for products using a text query",
    parameters={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query for finding products"
            }
        },
        "required": ["query"]
    },
    handler=None
)

# Click action
click_action = Action(
    name="WEBSHOP_CLICK",
    description="Click on an element (product, option, or button)",
    parameters={
        "type": "object",
        "properties": {
            "element": {
                "type": "string",
                "description": "Element to click (product ASIN, option value, or button)"
            }
        },
        "required": ["element"]
    },
    handler=None
)

# Back action
back_action = Action(
    name="WEBSHOP_BACK",
    description="Go back to the previous page",
    parameters={
        "type": "object",
        "properties": {},
        "required": []
    },
    handler=None
)

# Buy action
buy_action = Action(
    name="WEBSHOP_BUY",
    description="Purchase the currently selected product",
    parameters={
        "type": "object",
        "properties": {},
        "required": []
    },
    handler=None
)


class WebShopAgent:
    """ElizaOS agent for WebShop tasks."""
    
    def __init__(self, runtime: AgentRuntime, environment: WebShopEnvironment):
        self.runtime = runtime
        self.environment = environment
        self.episode_steps: list[EpisodeStep] = []
        self._setup_actions()
    
    def _setup_actions(self) -> None:
        """Configure action handlers."""
        
        async def search_handler(params: dict, state: State) -> Content:
            query = params["query"]
            action = WebShopAction(ActionType.SEARCH, query)
            obs, reward, done = self.environment.step(action)
            
            self.episode_steps.append(EpisodeStep(obs, action, reward))
            
            return Content(text=self._format_observation(obs))
        
        async def click_handler(params: dict, state: State) -> Content:
            element = params["element"]
            action = WebShopAction(ActionType.CLICK, element)
            obs, reward, done = self.environment.step(action)
            
            self.episode_steps.append(EpisodeStep(obs, action, reward))
            
            return Content(text=self._format_observation(obs))
        
        async def back_handler(params: dict, state: State) -> Content:
            action = WebShopAction(ActionType.BACK)
            obs, reward, done = self.environment.step(action)
            
            self.episode_steps.append(EpisodeStep(obs, action, reward))
            
            return Content(text=self._format_observation(obs))
        
        async def buy_handler(params: dict, state: State) -> Content:
            action = WebShopAction(ActionType.BUY)
            obs, reward, done = self.environment.step(action)
            
            self.episode_steps.append(EpisodeStep(obs, action, reward))
            
            return Content(text=f"Purchase completed! Reward: {reward:.2f}")
        
        search_action.handler = search_handler
        click_action.handler = click_handler
        back_action.handler = back_handler
        buy_action.handler = buy_handler
    
    async def solve_task(self, task: ShoppingTask, max_steps: int = 20) -> WebShopResult:
        """Attempt to complete a shopping task."""
        self.episode_steps = []
        
        # Reset environment
        initial_obs = self.environment.reset(task)
        
        system_prompt = self._build_system_prompt()
        user_prompt = self._build_task_prompt(task, initial_obs)
        
        tokens_used = 0
        final_reward = 0.0
        purchased_asin = None
        purchased_options = {}
        
        for step in range(max_steps):
            # Get agent's next action
            response = await self.runtime.generate_response(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                actions=[search_action, click_action, back_action, buy_action]
            )
            
            tokens_used += response.tokens_used
            
            # Execute action
            if response.action:
                action_result = await response.action.handler(
                    response.action.parameters, {}
                )
                
                # Check if episode ended
                if response.action.name == "WEBSHOP_BUY":
                    final_reward = self.episode_steps[-1].reward
                    if self.environment.current_product:
                        purchased_asin = self.environment.current_product.asin
                        purchased_options = self.environment.selected_options.copy()
                    break
                
                user_prompt = self._build_continuation_prompt(action_result)
        
        return WebShopResult(
            task_id=task.task_id,
            purchased_asin=purchased_asin,
            purchased_options=purchased_options,
            reward=final_reward,
            steps=self.episode_steps,
            success=final_reward >= 1.0,
            total_steps=len(self.episode_steps),
            tokens_used=tokens_used
        )
    
    def _format_observation(self, obs: PageObservation) -> str:
        """Format observation for agent."""
        lines = [f"Page: {obs.page_type.value}", f"URL: {obs.url}", ""]
        
        if obs.page_type == PageType.RESULTS and obs.search_results:
            lines.append("Search Results:")
            for i, result in enumerate(obs.search_results[:10]):
                lines.append(f"  [{i}] {result.title}")
                lines.append(f"      ASIN: {result.asin} | Price: ${result.price} | Rating: {result.rating}★")
        
        elif obs.page_type == PageType.PRODUCT and obs.current_product:
            product = obs.current_product
            lines.append(f"Product: {product.title}")
            lines.append(f"ASIN: {product.asin}")
            lines.append(f"Price: ${product.price}")
            lines.append(f"Rating: {product.rating}★ ({product.review_count} reviews)")
            lines.append(f"Description: {product.description[:500]}...")
            
            if product.options:
                lines.append("\nOptions:")
                for option in product.options:
                    selected = obs.selected_options.get(option.name, "None")
                    lines.append(f"  {option.name}: {', '.join(option.values)} (selected: {selected})")
        
        lines.append("\nAvailable Actions:")
        for action in obs.available_actions[:15]:
            lines.append(f"  - {action}")
        
        return "\n".join(lines)
    
    def _build_system_prompt(self) -> str:
        """Build system prompt for the agent."""
        return """You are a shopping assistant helping to find and purchase products online.

Available actions:
- WEBSHOP_SEARCH: Search for products (use specific keywords from the instruction)
- WEBSHOP_CLICK: Click on a product (by ASIN), select an option, or interact with the page
- WEBSHOP_BACK: Go back to the previous page
- WEBSHOP_BUY: Purchase the current product (only when you've found the right product)

Strategy:
1. Analyze the shopping instruction carefully for required attributes
2. Search using relevant keywords from the instruction
3. Review search results and click on promising products
4. On product pages, verify the product matches requirements
5. Select required options (size, color, etc.) before buying
6. Only buy when confident the product matches the instruction

Important:
- Check price constraints if mentioned in the instruction
- Make sure to select all required options before buying
- Consider product ratings and reviews"""
    
    def _build_task_prompt(self, task: ShoppingTask, obs: PageObservation) -> str:
        """Build initial task prompt."""
        prompt = f"""Shopping Task:
{task.instruction}

"""
        if task.price_upper:
            prompt += f"Budget: Under ${task.price_upper}\n"
        
        prompt += f"\nCurrent Page:\n{self._format_observation(obs)}"
        prompt += "\n\nStart searching for the product that best matches this description."
        
        return prompt
    
    def _build_continuation_prompt(self, action_result: Content) -> str:
        """Build continuation prompt with action results."""
        return f"""Result of your action:

{action_result.text}

What would you like to do next?"""


# Benchmark Runner
import asyncio
from pathlib import Path
from datetime import datetime
import json

class WebShopRunner:
    """Orchestrates WebShop benchmark evaluation."""
    
    def __init__(
        self,
        runtime: AgentRuntime,
        output_path: Path,
        split: str = "test"
    ):
        self.runtime = runtime
        self.output_path = output_path
        self.split = split
        self.dataset: Optional[WebShopDataset] = None
    
    async def setup(self) -> None:
        """Initialize the benchmark runner."""
        self.dataset = WebShopDataset(split=self.split)
        await self.dataset.load()
        self.output_path.mkdir(parents=True, exist_ok=True)
    
    async def run(
        self,
        task_ids: Optional[list[str]] = None,
        max_tasks: Optional[int] = None,
        max_steps_per_task: int = 20
    ) -> WebShopReport:
        """Run the WebShop benchmark evaluation."""
        if not self.dataset:
            raise RuntimeError("Runner not initialized. Call setup() first.")
        
        # Filter tasks
        tasks = list(self.dataset.tasks)
        if task_ids:
            tasks = [t for t in tasks if t.task_id in task_ids]
        if max_tasks:
            tasks = tasks[:max_tasks]
        
        results: list[WebShopResult] = []
        
        for task in tasks:
            print(f"Running task: {task.task_id}")
            print(f"  Instruction: {task.instruction[:80]}...")
            
            # Create fresh environment and agent
            environment = WebShopEnvironment(self.dataset)
            agent = WebShopAgent(self.runtime, environment)
            
            try:
                result = await agent.solve_task(task, max_steps=max_steps_per_task)
                results.append(result)
                
                print(f"  Reward: {result.reward:.2f}")
                print(f"  Steps: {result.total_steps}")
                print(f"  Purchased: {result.purchased_asin or 'None'}")
                
            except Exception as e:
                results.append(WebShopResult(
                    task_id=task.task_id,
                    purchased_asin=None,
                    purchased_options={},
                    reward=0.0,
                    steps=[],
                    success=False,
                    total_steps=0,
                    tokens_used=0
                ))
                print(f"  Error: {e}")
        
        # Calculate aggregate metrics
        completed = sum(1 for r in results if r.purchased_asin)
        success_count = sum(1 for r in results if r.success)
        total_reward = sum(r.reward for r in results)
        total_steps = sum(r.total_steps for r in results)
        total_tokens = sum(r.tokens_used for r in results)
        
        report = WebShopReport(
            total_tasks=len(results),
            completed_tasks=completed,
            success_count=success_count,
            success_rate=success_count / len(results) if results else 0,
            average_reward=total_reward / len(results) if results else 0,
            average_steps=total_steps / len(results) if results else 0,
            total_tokens=total_tokens,
            results=results
        )
        
        await self._save_report(report)
        
        return report
    
    async def _save_report(self, report: WebShopReport) -> None:
        """Save benchmark report to disk."""
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        
        # JSON report
        report_path = self.output_path / f"report_{timestamp}.json"
        with open(report_path, 'w') as f:
            json.dump({
                "total_tasks": report.total_tasks,
                "completed_tasks": report.completed_tasks,
                "success_count": report.success_count,
                "success_rate": report.success_rate,
                "average_reward": report.average_reward,
                "average_steps": report.average_steps,
                "total_tokens": report.total_tokens,
                "results": [
                    {
                        "task_id": r.task_id,
                        "purchased_asin": r.purchased_asin,
                        "reward": r.reward,
                        "success": r.success,
                        "total_steps": r.total_steps
                    }
                    for r in report.results
                ]
            }, f, indent=2)
        
        # Markdown report
        markdown_path = self.output_path / f"report_{timestamp}.md"
        markdown = self._generate_markdown_report(report)
        with open(markdown_path, 'w') as f:
            f.write(markdown)
    
    def _generate_markdown_report(self, report: WebShopReport) -> str:
        """Generate markdown summary report."""
        return f"""# WebShop Benchmark Report

## Summary

| Metric | Value |
|--------|-------|
| Total Tasks | {report.total_tasks} |
| Completed | {report.completed_tasks} |
| Successful | {report.success_count} |
| Success Rate | {report.success_rate:.2%} |
| Average Reward | {report.average_reward:.3f} |
| Average Steps | {report.average_steps:.1f} |
| Total Tokens | {report.total_tokens:,} |

## Results by Task

| Task ID | Purchased | Reward | Steps | Success |
|---------|-----------|--------|-------|---------|
{''.join(f"| {r.task_id} | {r.purchased_asin or 'None'} | {r.reward:.2f} | {r.total_steps} | {'✅' if r.success else '❌'} |" + chr(10) for r in report.results[:50])}

## Reward Distribution

- Perfect (1.0): {sum(1 for r in report.results if r.reward == 1.0)}
- High (0.7-1.0): {sum(1 for r in report.results if 0.7 <= r.reward < 1.0)}
- Medium (0.3-0.7): {sum(1 for r in report.results if 0.3 <= r.reward < 0.7)}
- Low (0-0.3): {sum(1 for r in report.results if r.reward < 0.3)}
"""


# Plugin definition
webshop_plugin = Plugin(
    name="webshop-bench",
    description="WebShop benchmark evaluation for ElizaOS",
    actions=[
        search_action,
        click_action,
        back_action,
        buy_action
    ],
    providers=[],
    evaluators=[]
)
```

## Integration with ElizaOS

### Usage Example

```python
from elizaos.runtime import AgentRuntime
from pathlib import Path

async def run_webshop_benchmark():
    # Initialize runtime
    runtime = AgentRuntime()
    await runtime.initialize()
    
    # Create runner
    runner = WebShopRunner(
        runtime=runtime,
        output_path=Path("./results/webshop"),
        split="test"
    )
    
    # Setup and run
    await runner.setup()
    report = await runner.run(max_tasks=100, max_steps_per_task=20)
    
    print(f"Success Rate: {report.success_rate:.2%}")
    print(f"Average Reward: {report.average_reward:.3f}")
    
    return report

if __name__ == "__main__":
    import asyncio
    asyncio.run(run_webshop_benchmark())
```

## Implementation Phases

### Phase 1: Core Infrastructure (Week 1)
- [ ] Define all type classes
- [ ] Implement dataset loader (HuggingFace + local)
- [ ] Set up project structure

### Phase 2: Environment (Week 2)
- [ ] Implement web environment simulation
- [ ] Add product search functionality
- [ ] Implement reward calculation

### Phase 3: Agent Integration (Week 3)
- [ ] Create ElizaOS actions
- [ ] Implement agent class with action handlers
- [ ] Add observation formatting

### Phase 4: Benchmark Runner (Week 4)
- [ ] Implement runner with task management
- [ ] Add report generation
- [ ] Create evaluation metrics

### Phase 5: Testing & Optimization (Week 5)
- [ ] Unit tests for all components
- [ ] Integration tests
- [ ] Performance optimization
- [ ] Documentation

## Key Differences from Other Benchmarks

1. **Web Navigation**: Unlike other benchmarks, WebShop focuses on web-style navigation with pages and clickable elements
2. **Reward Calculation**: Uses attribute matching rather than binary success
3. **Action Simplicity**: Smaller action space (search, click, back, buy) compared to terminal-based benchmarks
4. **Partial Credit**: Agents can receive partial rewards for purchasing similar but not perfect products

## Challenges and Considerations

1. **Search Quality**: The simulated search may not perfectly match real e-commerce search behavior
2. **Large Product Catalog**: Efficient product search/indexing needed for full dataset
3. **Option Selection**: Agent must understand which options to select based on instruction
4. **Price Sensitivity**: Balancing product quality with price constraints

## References

1. Yao, S., et al. "WebShop: Towards Scalable Real-World Web Interaction with Grounded Language Agents." NeurIPS 2022.
2. [GitHub Repository](https://github.com/princeton-nlp/WebShop)
3. [HuggingFace Dataset](https://huggingface.co/datasets/webshop)
