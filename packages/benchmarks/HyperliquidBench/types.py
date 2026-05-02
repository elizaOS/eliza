"""
HyperliquidBench Type Definitions

Defines all data classes and enums used by the Eliza agent wrapper
for the HyperliquidBench benchmark.  These types mirror the Rust plan
schema from ``crates/hl-common/src/plan.rs`` so that the Python agent
can generate plans in the exact JSON format the Rust runner expects.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional


# ── Plan primitives ─────────────────────────────────────────────────

class OrderSide(str, Enum):
    """Order side – maps to the Rust ``OrderSide`` enum."""
    BUY = "buy"
    SELL = "sell"


class PerpTif(str, Enum):
    """Time-in-force – maps to the Rust ``PerpTif`` enum."""
    ALO = "ALO"
    GTC = "GTC"
    IOC = "IOC"


class StepKind(str, Enum):
    """Discriminator for action-step variants."""
    PERP_ORDERS = "perp_orders"
    CANCEL_LAST = "cancel_last"
    CANCEL_OIDS = "cancel_oids"
    CANCEL_ALL = "cancel_all"
    USD_CLASS_TRANSFER = "usd_class_transfer"
    SET_LEVERAGE = "set_leverage"
    SLEEP_MS = "sleep_ms"


# ── Individual step payloads ────────────────────────────────────────

@dataclass
class PerpOrder:
    """Single perpetual order inside a ``PerpOrdersStep``."""
    coin: str
    side: OrderSide
    sz: float
    px: float | str  # absolute ``float`` or ``"mid±X%"`` string
    tif: PerpTif = PerpTif.GTC
    reduce_only: bool = False
    builder_code: Optional[str] = None
    cloid: Optional[str] = None

    def to_dict(self) -> dict[str, object]:
        d: dict[str, object] = {
            "coin": self.coin,
            "side": self.side.value,
            "sz": self.sz,
            "px": self.px,
            "tif": self.tif.value,
            "reduceOnly": self.reduce_only,
            "trigger": {"kind": "none"},
        }
        if self.builder_code is not None:
            d["builderCode"] = self.builder_code
        if self.cloid is not None:
            d["cloid"] = self.cloid
        return d


@dataclass
class PerpOrdersStep:
    """Place one or more perpetual orders."""
    orders: list[PerpOrder]
    builder_code: Optional[str] = None

    def to_dict(self) -> dict[str, object]:
        d: dict[str, object] = {"orders": [o.to_dict() for o in self.orders]}
        if self.builder_code is not None:
            d["builderCode"] = self.builder_code
        return {"perp_orders": d}


@dataclass
class CancelLastStep:
    """Cancel the most recently placed order."""
    coin: Optional[str] = None

    def to_dict(self) -> dict[str, object]:
        inner: dict[str, object] = {}
        if self.coin is not None:
            inner["coin"] = self.coin
        return {"cancel_last": inner}


@dataclass
class CancelOidsStep:
    """Cancel specific order IDs."""
    coin: str
    oids: list[int]

    def to_dict(self) -> dict[str, object]:
        return {"cancel_oids": {"coin": self.coin, "oids": self.oids}}


@dataclass
class CancelAllStep:
    """Cancel all resting orders (optionally for one coin)."""
    coin: Optional[str] = None

    def to_dict(self) -> dict[str, object]:
        inner: dict[str, object] = {}
        if self.coin is not None:
            inner["coin"] = self.coin
        return {"cancel_all": inner}


@dataclass
class UsdClassTransferStep:
    """Transfer USDC between spot and perp wallets."""
    to_perp: bool
    usdc: float

    def to_dict(self) -> dict[str, object]:
        return {"usd_class_transfer": {"toPerp": self.to_perp, "usdc": self.usdc}}


@dataclass
class SetLeverageStep:
    """Set leverage for a given coin."""
    coin: str
    leverage: int
    cross: bool = False

    def to_dict(self) -> dict[str, object]:
        return {
            "set_leverage": {
                "coin": self.coin,
                "leverage": self.leverage,
                "cross": self.cross,
            }
        }


@dataclass
class SleepStep:
    """Pause execution for a specified duration."""
    duration_ms: int

    def to_dict(self) -> dict[str, object]:
        return {"sleep_ms": {"duration_ms": self.duration_ms}}


# Union of all step types
ActionStep = (
    PerpOrdersStep
    | CancelLastStep
    | CancelOidsStep
    | CancelAllStep
    | UsdClassTransferStep
    | SetLeverageStep
    | SleepStep
)


@dataclass
class Plan:
    """A complete trading plan that the Rust runner can execute."""
    steps: list[ActionStep]

    def to_dict(self) -> dict[str, list[dict[str, object]]]:
        return {"steps": [s.to_dict() for s in self.steps]}


# ── Scenario / task types ───────────────────────────────────────────

class ScenarioKind(str, Enum):
    """Kind of benchmark scenario."""
    COVERAGE = "coverage"
    HIAN = "hian"
    CUSTOM = "custom"


@dataclass
class TradingScenario:
    """A single benchmark task / scenario that the agent must solve."""
    scenario_id: str
    kind: ScenarioKind
    description: str
    allowed_coins: list[str] = field(default_factory=lambda: ["ETH", "BTC"])
    max_steps: int = 5
    builder_code: Optional[str] = None
    plan_spec: Optional[str] = None  # e.g. ``dataset/tasks/hl_perp_basic_01.jsonl:1``
    hian_prompt_path: Optional[str] = None


# ── Result types ────────────────────────────────────────────────────

@dataclass
class RunnerResult:
    """Result from the ``hl-runner`` subprocess."""
    success: bool
    out_dir: str
    run_meta_path: str
    per_action_path: str
    stdout: str
    stderr: str
    exit_code: int


@dataclass
class EvaluatorResult:
    """Result from the ``hl-evaluator`` subprocess."""
    success: bool
    final_score: float
    base: float
    bonus: float
    penalty: float
    unique_signatures: list[str]
    eval_score_path: str
    stdout: str
    stderr: str
    exit_code: int


@dataclass
class BenchmarkResult:
    """Aggregate result for one scenario."""
    scenario_id: str
    plan: Plan
    runner: RunnerResult
    evaluator: Optional[EvaluatorResult]
    error_message: Optional[str] = None


# ── Config ──────────────────────────────────────────────────────────

@dataclass
class HLBenchConfig:
    """Configuration for the Eliza HyperliquidBench agent."""
    # Paths (relative to the HyperliquidBench root)
    bench_root: Path = field(default_factory=lambda: Path(__file__).resolve().parent)
    dataset_dir: str = "dataset"
    domains_file: str = "dataset/domains-hl.yaml"
    runs_dir: str = "runs"

    # Runner settings
    demo_mode: bool = True
    network: str = "testnet"
    builder_code: Optional[str] = None
    effect_timeout_ms: int = 2000

    # LLM / model settings
    model_name: str = "gpt-4o"
    temperature: float = 0.2

    # Agent settings
    max_iterations: int = 3
    verbose: bool = False
