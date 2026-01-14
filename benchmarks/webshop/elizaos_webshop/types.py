from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class PageType(str, Enum):
    SEARCH = "search"
    RESULTS = "results"
    PRODUCT = "product"
    CONFIRMATION = "confirmation"


@dataclass(frozen=True)
class Product:
    product_id: str
    name: str
    price: float
    category: str
    rating: float
    features: list[str] = field(default_factory=list)
    options: dict[str, list[str]] = field(default_factory=dict)
    attributes: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class SearchResult:
    product_id: str
    name: str
    price: float
    rating: float
    category: str


@dataclass(frozen=True)
class PageObservation:
    page_type: PageType
    message: str
    query: str | None = None
    results: list[SearchResult] | None = None
    product: Product | None = None
    selected_options: dict[str, str] = field(default_factory=dict)
    available_actions: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class WebShopTask:
    task_id: str
    instruction: str
    target_product_ids: list[str]
    goal_attributes: dict[str, str] = field(default_factory=dict)
    budget: float | None = None
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)


@dataclass(frozen=True)
class EpisodeStep:
    action: str
    observation: PageObservation
    reward: float
    done: bool
    info: dict[str, str | int | float | bool] = field(default_factory=dict)


@dataclass(frozen=True)
class WebShopResult:
    task_id: str
    trial_number: int
    success: bool
    purchased_product_id: str | None
    reward: float
    turns_used: int
    duration_ms: float
    steps: list[EpisodeStep] = field(default_factory=list)
    final_response: str = ""
    error: str | None = None
    tokens_used: int = 0


@dataclass(frozen=True)
class WebShopReport:
    total_tasks: int
    total_trials: int
    success_rate: float
    average_reward: float
    average_turns: float
    average_steps: float
    average_duration_ms: float
    results: list[WebShopResult]
    summary: dict[str, str | int | float | bool] = field(default_factory=dict)


@dataclass(frozen=True)
class WebShopConfig:
    output_dir: str
    max_tasks: int | None = None
    num_trials: int = 1
    max_turns_per_task: int = 20
    timeout_ms: int = 120000
    verbose: bool = False
    save_detailed_logs: bool = True
    # ElizaOS integration
    use_mock: bool = True
    temperature: float = 0.0
    model_provider: str | None = None
    # Trajectory logging
    enable_trajectory_logging: bool = False
    trajectory_export_format: str = "art"  # "art" | "grpo"

