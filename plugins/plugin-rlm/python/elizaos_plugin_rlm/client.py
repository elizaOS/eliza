"""
RLM (Recursive Language Model) client for elizaOS.

Wraps the RLM library with async support and stub fallback.
See: https://arxiv.org/abs/2512.24601
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Union

logger = logging.getLogger("elizaos.plugin-rlm")

# Pricing per 1M tokens (USD). Override via ELIZA_RLM_PRICING_JSON env var.
MODEL_PRICING: Dict[str, Dict[str, Dict[str, float]]] = {
    "openai": {
        "gpt-5": {"input": 10.0, "output": 30.0},
        "gpt-5-preview": {"input": 10.0, "output": 30.0},
        "gpt-5": {"input": 2.5, "output": 10.0},
        "gpt-5-mini": {"input": 0.15, "output": 0.60},
        "gpt-3.5-turbo": {"input": 0.50, "output": 1.50},
    },
    "anthropic": {
        "claude-3-5-sonnet-20241022": {"input": 3.0, "output": 15.0},
        "claude-3-5-haiku-20241022": {"input": 0.80, "output": 4.0},
        "claude-3-opus-20240229": {"input": 15.0, "output": 75.0},
        "claude-3-sonnet-20240229": {"input": 3.0, "output": 15.0},
        "claude-3-haiku-20240307": {"input": 0.25, "output": 1.25},
    },
    "gemini": {
        "gemini-2.0-flash-exp": {"input": 0.0, "output": 0.0},
        "gemini-2.0-flash": {"input": 0.075, "output": 0.30},
        "gemini-1.5-flash": {"input": 0.075, "output": 0.30},
        "gemini-1.5-pro": {"input": 1.25, "output": 5.0},
    },
    "groq": {
        "llama-3.1-70b-versatile": {"input": 0.59, "output": 0.79},
        "llama-3.1-8b-instant": {"input": 0.05, "output": 0.08},
        "mixtral-8x7b-32768": {"input": 0.24, "output": 0.24},
    },
}

DEFAULT_PRICING = {"input": 1.0, "output": 3.0}


def set_model_pricing(backend: str, model: str, input_cost: float, output_cost: float) -> None:
    """Set or override pricing for a model (costs per 1M tokens USD)."""
    if backend not in MODEL_PRICING:
        MODEL_PRICING[backend] = {}
    MODEL_PRICING[backend][model] = {"input": input_cost, "output": output_cost}


def load_pricing_from_env() -> None:
    """Load custom pricing from ELIZA_RLM_PRICING_JSON environment variable."""
    import json
    pricing_json = os.getenv("ELIZA_RLM_PRICING_JSON")
    if pricing_json:
        try:
            custom_pricing = json.loads(pricing_json)
            for backend, models in custom_pricing.items():
                for model, prices in models.items():
                    set_model_pricing(backend, model, prices.get("input", 1.0), prices.get("output", 3.0))
            logger.info("Loaded custom pricing from ELIZA_RLM_PRICING_JSON")
        except json.JSONDecodeError as e:
            logger.warning("Failed to parse ELIZA_RLM_PRICING_JSON: %s", e)


# Load custom pricing on module import
load_pricing_from_env()

# Optional dependency: RLM library
try:
    from rlm import RLM  # type: ignore[import-untyped]

    HAS_RLM = True
except ImportError:
    RLM = None
    HAS_RLM = False
    logger.debug("RLM library not available - stub mode enabled")


def _env_bool(key: str, default: str = "false") -> bool:
    return os.getenv(key, default).lower() in ("1", "true", "yes")


@dataclass
class RLMConfig:
    """Configuration for the RLM client. Supports dual-model config for cost optimization."""

    backend: str = field(default_factory=lambda: os.getenv("ELIZA_RLM_BACKEND", "gemini"))
    root_model: str = field(default_factory=lambda: os.getenv("ELIZA_RLM_ROOT_MODEL", ""))
    subcall_backend: str = field(default_factory=lambda: os.getenv("ELIZA_RLM_SUBCALL_BACKEND", ""))
    subcall_model: str = field(default_factory=lambda: os.getenv("ELIZA_RLM_SUBCALL_MODEL", ""))
    backend_kwargs: Dict[str, str] = field(default_factory=dict)
    environment: str = field(default_factory=lambda: os.getenv("ELIZA_RLM_ENV", "local"))
    max_iterations: int = field(default_factory=lambda: int(os.getenv("ELIZA_RLM_MAX_ITERATIONS", "4")))
    max_depth: int = field(default_factory=lambda: int(os.getenv("ELIZA_RLM_MAX_DEPTH", "1")))
    verbose: bool = field(default_factory=lambda: _env_bool("ELIZA_RLM_VERBOSE"))
    track_costs: bool = field(default_factory=lambda: _env_bool("ELIZA_RLM_TRACK_COSTS", "true"))
    log_trajectories: bool = field(default_factory=lambda: _env_bool("ELIZA_RLM_LOG_TRAJECTORIES", "true"))
    max_retries: int = field(default_factory=lambda: int(os.getenv("ELIZA_RLM_MAX_RETRIES", "3")))
    retry_base_delay: float = field(default_factory=lambda: float(os.getenv("ELIZA_RLM_RETRY_DELAY", "1.0")))
    retry_max_delay: float = field(default_factory=lambda: float(os.getenv("ELIZA_RLM_RETRY_MAX_DELAY", "30.0")))

    def validate(self, strict: bool = False) -> None:
        """Validate configuration. Use strict=True in production to raise on errors."""
        VALID_BACKENDS = {"openai", "anthropic", "gemini", "groq", "openrouter"}
        VALID_ENVS = {"local", "docker", "modal", "prime"}
        
        def _check_enum(value: str, valid: set, name: str) -> None:
            if value not in valid:
                msg = f"Unknown {name} '{value}'. Valid: {valid}"
                if strict:
                    raise ValueError(msg)
                logger.warning(msg)
        
        _check_enum(self.backend, VALID_BACKENDS, "RLM backend")
        _check_enum(self.environment, VALID_ENVS, "RLM environment")
        
        if self.max_iterations < 1:
            raise ValueError("max_iterations must be >= 1")
        if self.max_depth < 1:
            raise ValueError("max_depth must be >= 1")
        if self.max_retries < 0:
            raise ValueError("max_retries must be >= 0")
        if self.retry_base_delay < 0:
            raise ValueError("retry_base_delay must be >= 0")
        if self.retry_max_delay < self.retry_base_delay:
            raise ValueError("retry_max_delay must be >= retry_base_delay")
    
    @property
    def effective_subcall_backend(self) -> str:
        """Get the effective sub-call backend (falls back to main backend)."""
        return self.subcall_backend or self.backend
    
    @property
    def effective_subcall_model(self) -> str:
        """Get the effective sub-call model (falls back to root model)."""
        return self.subcall_model or self.root_model


@dataclass
class RLMCost:
    """Cost tracking for RLM inference."""

    root_input_tokens: int = 0
    root_output_tokens: int = 0
    subcall_input_tokens: int = 0
    subcall_output_tokens: int = 0
    
    root_cost_usd: float = 0.0
    subcall_cost_usd: float = 0.0
    
    @property
    def total_input_tokens(self) -> int:
        return self.root_input_tokens + self.subcall_input_tokens
    
    @property
    def total_output_tokens(self) -> int:
        return self.root_output_tokens + self.subcall_output_tokens
    
    @property
    def total_tokens(self) -> int:
        return self.total_input_tokens + self.total_output_tokens
    
    @property
    def total_cost_usd(self) -> float:
        return self.root_cost_usd + self.subcall_cost_usd
    
    def to_dict(self) -> Dict[str, object]:
        return {
            "root_input_tokens": self.root_input_tokens,
            "root_output_tokens": self.root_output_tokens,
            "subcall_input_tokens": self.subcall_input_tokens,
            "subcall_output_tokens": self.subcall_output_tokens,
            "total_tokens": self.total_tokens,
            "root_cost_usd": self.root_cost_usd,
            "subcall_cost_usd": self.subcall_cost_usd,
            "total_cost_usd": self.total_cost_usd,
        }


@dataclass
class RLMTrajectoryStep:
    """A single step in an RLM trajectory."""

    step_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    step_number: int = 0
    timestamp_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    code_executed: str = ""
    repl_output: str = ""
    variables_updated: List[str] = field(default_factory=list)
    strategy: str = ""  # peek, grep, chunk, stitch, subcall, other
    is_subcall: bool = False
    subcall_prompt: str = ""
    subcall_response: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    duration_ms: int = 0
    
    def to_dict(self) -> Dict[str, object]:
        return {
            "step_id": self.step_id,
            "step_number": self.step_number,
            "timestamp_ms": self.timestamp_ms,
            "code_executed": self.code_executed,
            "repl_output": self.repl_output[:500] if self.repl_output else "",  # Truncate
            "variables_updated": self.variables_updated,
            "strategy": self.strategy,
            "is_subcall": self.is_subcall,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "duration_ms": self.duration_ms,
        }


@dataclass
class RLMTrajectory:
    """Full trajectory of an RLM inference."""

    trajectory_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    start_time_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    end_time_ms: int = 0
    
    prompt_length: int = 0
    prompt_preview: str = ""
    steps: List[RLMTrajectoryStep] = field(default_factory=list)
    final_response: str = ""
    total_iterations: int = 0
    max_depth_reached: int = 0
    subcall_count: int = 0
    cost: Optional[RLMCost] = None
    strategies_used: List[str] = field(default_factory=list)
    
    @property
    def duration_ms(self) -> int:
        """Return duration in ms, or 0 if trajectory not yet finalized."""
        if self.end_time_ms == 0:
            return 0
        return max(0, self.end_time_ms - self.start_time_ms)
    
    def add_step(self, step: RLMTrajectoryStep) -> None:
        step.step_number = len(self.steps)
        self.steps.append(step)
        self.total_iterations = len(self.steps)
        if step.strategy and step.strategy not in self.strategies_used:
            self.strategies_used.append(step.strategy)
        if step.is_subcall:
            self.subcall_count += 1
    
    def to_dict(self) -> Dict[str, object]:
        return {
            "trajectory_id": self.trajectory_id,
            "start_time_ms": self.start_time_ms,
            "end_time_ms": self.end_time_ms,
            "duration_ms": self.duration_ms,
            "prompt_length": self.prompt_length,
            "prompt_preview": self.prompt_preview,
            "steps": [s.to_dict() for s in self.steps],
            "final_response": self.final_response[:500] if self.final_response else "",
            "total_iterations": self.total_iterations,
            "max_depth_reached": self.max_depth_reached,
            "subcall_count": self.subcall_count,
            "strategies_used": self.strategies_used,
            "cost": self.cost.to_dict() if self.cost else None,
        }


@dataclass
class RLMInferOptions:
    """Per-request inference options for dynamic override of config settings.
    
    Note: Custom REPL tool injection is NOT supported by the upstream RLM library.
    """
    
    max_iterations: Optional[int] = None
    max_depth: Optional[int] = None
    root_model: Optional[str] = None
    subcall_model: Optional[str] = None
    log_trajectories: Optional[bool] = None
    track_costs: Optional[bool] = None
    
    def to_dict(self) -> Dict[str, object]:
        return {
            k: v for k, v in {
                "max_iterations": self.max_iterations,
                "max_depth": self.max_depth,
                "root_model": self.root_model,
                "subcall_model": self.subcall_model,
                "log_trajectories": self.log_trajectories,
                "track_costs": self.track_costs,
            }.items() if v is not None
        }


@dataclass
class RLMResult:
    """Result from an RLM inference call."""

    text: str
    stub: bool = False
    iterations: Optional[int] = None
    depth: Optional[int] = None
    error: Optional[str] = None
    
    cost: Optional[RLMCost] = None
    trajectory: Optional[RLMTrajectory] = None

    def to_dict(self) -> Dict[str, object]:
        return {
            "text": self.text,
            "metadata": {
                "stub": self.stub,
                "iterations": self.iterations,
                "depth": self.depth,
                "error": self.error,
            },
            "cost": self.cost.to_dict() if self.cost else None,
            "trajectory": self.trajectory.to_dict() if self.trajectory else None,
        }


# Token counting strategy - can be overridden
_tokenizer = None
_tokenizer_loaded = False


def _try_load_tokenizer() -> bool:
    """Attempt to load tiktoken for accurate token counting."""
    global _tokenizer, _tokenizer_loaded
    if _tokenizer_loaded:
        return _tokenizer is not None
    
    _tokenizer_loaded = True
    try:
        import tiktoken  # type: ignore[import-untyped]
        _tokenizer = tiktoken.get_encoding("cl100k_base")  # GPT-4 / Claude tokenizer
        logger.debug("Using tiktoken for accurate token counting")
        return True
    except ImportError:
        logger.debug("tiktoken not available - using approximate token counting (len/4)")
        return False


def estimate_token_count(text: str, use_approximation: bool = False) -> int:
    """Estimate tokens. Uses tiktoken if available, otherwise len/4 approximation."""
    if not use_approximation and _try_load_tokenizer() and _tokenizer is not None:
        return len(_tokenizer.encode(text))
    return len(text) // 4


def estimate_cost(
    backend: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    warn_on_fallback: bool = True,
) -> float:
    """Estimate API cost in USD based on token counts."""
    pricing = MODEL_PRICING.get(backend, {}).get(model)
    
    if not pricing:
        if warn_on_fallback:
            logger.warning(
                "Unknown model '%s/%s' - using default pricing ($%.2f/$%.2f per 1M tokens). "
                "Override with set_model_pricing() or ELIZA_RLM_PRICING_JSON env var.",
                backend, model, DEFAULT_PRICING["input"], DEFAULT_PRICING["output"]
            )
        pricing = DEFAULT_PRICING
    
    input_cost = (input_tokens / 1_000_000) * pricing["input"]
    output_cost = (output_tokens / 1_000_000) * pricing["output"]
    return input_cost + output_cost


def detect_strategy(code: str) -> str:
    """Detect RLM strategy from code: peek, grep, chunk, stitch, subcall, other."""
    c = code.lower()
    
    if "[:=" in code or "[:-" in code or "prompt[" in c:
        return "peek"
    if any(p in c for p in ("re.search", "re.findall", "grep")):
        return "grep"
    if any(p in c for p in ("split(", "partition(", "chunk")):
        return "chunk"
    if "join(" in c or "concat" in c or "+=" in code:
        return "stitch"
    if any(p in c for p in ("rlm(", "completion(", "subcall")):
        return "subcall"
    return "other"



class RLMClient:
    """Async client for Recursive Language Models with stub fallback."""

    def __init__(self, config: Optional[RLMConfig] = None) -> None:
        self.config = config or RLMConfig()
        self.config.validate()
        self._rlm: object = None
        self._initialized = False
        self._current_trajectory: Optional[RLMTrajectory] = None
        self._trajectories: List[RLMTrajectory] = []

        if HAS_RLM:
            self._initialize_rlm()

    def _initialize_rlm(
        self,
        max_iterations: Optional[int] = None,
        max_depth: Optional[int] = None,
    ) -> None:
        """Initialize or reinitialize the RLM instance with optional overrides."""
        if not HAS_RLM or RLM is None:
            return

        try:
            self._rlm = RLM(
                backend=self.config.backend,
                backend_kwargs=self.config.backend_kwargs,
                environment=self.config.environment,
                max_iterations=max_iterations or self.config.max_iterations,
                max_depth=max_depth or self.config.max_depth,
                verbose=self.config.verbose,
            )
            self._initialized = True
            logger.info(
                "RLM client initialized: backend=%s, env=%s, max_iter=%d, max_depth=%d",
                self.config.backend,
                self.config.environment,
                max_iterations or self.config.max_iterations,
                max_depth or self.config.max_depth,
            )
        except Exception as e:
            logger.exception("Failed to initialize RLM: %s", e)
            self._rlm = None
            self._initialized = False
    
    # NOTE: Custom REPL tool injection is NOT supported by the upstream RLM library.
    # The RLM REPL environment (LocalREPL) has a fixed set of globals (llm_query,
    # FINAL_VAR, etc.) and does not provide a mechanism to inject arbitrary callables.
    # If this capability is needed, it would require upstream changes to the RLM library.

    @property
    def is_available(self) -> bool:
        return self._initialized and self._rlm is not None

    @property
    def trajectories(self) -> List[RLMTrajectory]:
        return self._trajectories

    @staticmethod
    def normalize_messages(messages: Union[str, List[Dict[str, str]]]) -> List[Dict[str, str]]:
        """Convert string prompt to message list format."""
        if isinstance(messages, str):
            return [{"role": "user", "content": messages}]
        return messages

    def _create_trajectory(self, prompt: str) -> RLMTrajectory:
        trajectory = RLMTrajectory(prompt_length=len(prompt), prompt_preview=prompt[:200])
        self._current_trajectory = trajectory
        return trajectory

    def _finalize_trajectory(
        self,
        trajectory: RLMTrajectory,
        response: str,
        input_tokens: int,
        output_tokens: int,
    ) -> None:
        trajectory.end_time_ms = int(time.time() * 1000)
        trajectory.final_response = response
        
        if self.config.track_costs:
            cost = RLMCost(root_input_tokens=input_tokens, root_output_tokens=output_tokens)
            cost.root_cost_usd = estimate_cost(
                self.config.backend, self.config.root_model or "default", input_tokens, output_tokens
            )
            for step in trajectory.steps:
                if step.is_subcall:
                    cost.subcall_input_tokens += step.input_tokens
                    cost.subcall_output_tokens += step.output_tokens
                    cost.subcall_cost_usd += estimate_cost(
                        self.config.effective_subcall_backend,
                        self.config.effective_subcall_model or "default",
                        step.input_tokens,
                        step.output_tokens,
                    )
            trajectory.cost = cost

        self._trajectories.append(trajectory)
        self._current_trajectory = None

    async def _run_completion(self, messages: List[Dict[str, str]]) -> object:
        """Run RLM completion with exponential backoff retry for transient failures."""
        RETRYABLE = ("timeout", "rate limit", "connection", "503", "429", "temporary")
        loop = asyncio.get_event_loop()
        last_error: Exception = Exception("No attempts made")
        
        for attempt in range(self.config.max_retries):
            try:
                return await loop.run_in_executor(
                    None, lambda: self._rlm.completion(messages)  # type: ignore[union-attr]
                )
            except asyncio.CancelledError:
                raise
            except Exception as e:
                last_error = e
                is_retryable = any(t in str(e).lower() for t in RETRYABLE)
                
                if not is_retryable or attempt == self.config.max_retries - 1:
                    raise
                
                # Exponential backoff with jitter
                delay = min(self.config.retry_base_delay * (2 ** attempt), self.config.retry_max_delay)
                delay *= (0.75 + random.random() * 0.5)  # 25% jitter
                
                logger.warning("RLM attempt %d/%d failed: %s. Retrying in %.1fs",
                               attempt + 1, self.config.max_retries, e, delay)
                await asyncio.sleep(delay)
        
        raise last_error

    async def infer(
        self,
        messages: Union[str, List[Dict[str, str]]],
        opts: Optional[Union[Dict[str, object], RLMInferOptions]] = None,
    ) -> RLMResult:
        """Perform inference with optional per-request overrides.
        
        Args:
            messages: Prompt string or message list
            opts: Optional per-request overrides (max_iterations, max_depth, etc.)
        
        Returns:
            RLMResult with generated text, metadata, and optional trajectory/cost
        """
        # Convert dict to RLMInferOptions if needed
        if isinstance(opts, dict):
            opts = RLMInferOptions(
                max_iterations=opts.get("max_iterations"),  # type: ignore[arg-type]
                max_depth=opts.get("max_depth"),  # type: ignore[arg-type]
                root_model=opts.get("root_model"),  # type: ignore[arg-type]
                subcall_model=opts.get("subcall_model"),  # type: ignore[arg-type]
                log_trajectories=opts.get("log_trajectories"),  # type: ignore[arg-type]
                track_costs=opts.get("track_costs"),  # type: ignore[arg-type]
            )
        
        # Check if we need trajectory logging
        log_traj = (opts and opts.log_trajectories is not None and opts.log_trajectories) or self.config.log_trajectories
        if log_traj:
            return await self.infer_with_trajectory(messages, opts)
        
        # Check if we need to reinitialize with different params
        if opts and (opts.max_iterations or opts.max_depth):
            self._initialize_rlm(
                max_iterations=opts.max_iterations,
                max_depth=opts.max_depth,
            )
        
        if not self.is_available:
            return RLMResult(
                text="[RLM STUB] RLM backend not available",
                stub=True,
            )

        normalized = self.normalize_messages(messages)

        try:
            result = await self._run_completion(normalized)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("RLM completion failed: %s", e)
            return RLMResult(
                text="[RLM ERROR] Failed to generate response",
                stub=False,
                error=str(e),
            )

        text = str(getattr(result, "response", None) or result)

        return RLMResult(
            text=text.strip(),
            stub=False,
        )
    
    async def infer_with_trajectory(
        self,
        messages: Union[str, List[Dict[str, str]]],
        opts: Optional[Union[Dict[str, object], RLMInferOptions]] = None,
    ) -> RLMResult:
        """Perform inference with trajectory logging for debugging.
        
        Supports per-request overrides for max_iterations, max_depth, and custom tools.
        """
        # Convert dict to RLMInferOptions if needed
        if isinstance(opts, dict):
            opts = RLMInferOptions(
                max_iterations=opts.get("max_iterations"),  # type: ignore[arg-type]
                max_depth=opts.get("max_depth"),  # type: ignore[arg-type]
                root_model=opts.get("root_model"),  # type: ignore[arg-type]
                subcall_model=opts.get("subcall_model"),  # type: ignore[arg-type]
                log_trajectories=opts.get("log_trajectories"),  # type: ignore[arg-type]
                track_costs=opts.get("track_costs"),  # type: ignore[arg-type]
            )
        
        # Reinitialize RLM with per-request overrides if provided
        if opts and (opts.max_iterations or opts.max_depth):
            self._initialize_rlm(
                max_iterations=opts.max_iterations,
                max_depth=opts.max_depth,
            )
        
        if not self.is_available:
            return RLMResult(
                text="[RLM STUB] RLM backend not available",
                stub=True,
            )
        
        normalized = self.normalize_messages(messages)
        prompt_text = "\n".join(m.get("content", "") for m in normalized)
        trajectory = self._create_trajectory(prompt_text)
        start_time = time.time()

        try:
            result = await self._run_completion(normalized)
            response_text = str(getattr(result, "response", None) or result)
            iterations = int(getattr(result, "iterations", 0) or 0)
            depth = int(getattr(result, "depth", 0) or 0)

            trace = getattr(result, "trace", None) or getattr(result, "trajectory", None)
            if trace and isinstance(trace, list):
                for i, step_data in enumerate(trace):
                    step = RLMTrajectoryStep(
                        step_number=i,
                        code_executed=str(step_data.get("code", "")),
                        repl_output=str(step_data.get("output", "")),
                        strategy=detect_strategy(str(step_data.get("code", ""))),
                        is_subcall="subcall" in str(step_data).lower(),
                        input_tokens=step_data.get("input_tokens", 0),
                        output_tokens=step_data.get("output_tokens", 0),
                    )
                    trajectory.add_step(step)

            if not trajectory.steps:
                step = RLMTrajectoryStep(
                    step_number=0,
                    code_executed="# Single completion call",
                    repl_output=response_text[:200],
                    strategy="other",
                    input_tokens=estimate_token_count(prompt_text),
                    output_tokens=estimate_token_count(response_text),
                    duration_ms=int((time.time() - start_time) * 1000),
                )
                trajectory.add_step(step)
            
            trajectory.total_iterations = iterations or len(trajectory.steps)
            trajectory.max_depth_reached = depth
            input_tokens = estimate_token_count(prompt_text)
            output_tokens = estimate_token_count(response_text)
            self._finalize_trajectory(trajectory, response_text, input_tokens, output_tokens)
            
            return RLMResult(
                text=response_text.strip(),
                stub=False,
                iterations=iterations or len(trajectory.steps),
                depth=depth,
                cost=trajectory.cost,
                trajectory=trajectory,
            )
            
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("RLM completion failed: %s", e)
            trajectory.end_time_ms = int(time.time() * 1000)
            return RLMResult(
                text="[RLM ERROR] Failed to generate response",
                stub=False,
                error=str(e),
                trajectory=trajectory,
            )
    
    def get_cost_summary(self) -> Dict[str, object]:
        """Aggregate cost summary across all trajectories."""
        total_cost = RLMCost()
        for traj in self._trajectories:
            if traj.cost:
                total_cost.root_input_tokens += traj.cost.root_input_tokens
                total_cost.root_output_tokens += traj.cost.root_output_tokens
                total_cost.subcall_input_tokens += traj.cost.subcall_input_tokens
                total_cost.subcall_output_tokens += traj.cost.subcall_output_tokens
                total_cost.root_cost_usd += traj.cost.root_cost_usd
                total_cost.subcall_cost_usd += traj.cost.subcall_cost_usd
        return {"trajectory_count": len(self._trajectories), **total_cost.to_dict()}

    def export_trajectories(self) -> List[Dict[str, object]]:
        return [t.to_dict() for t in self._trajectories]

    def clear_trajectories(self) -> None:
        self._trajectories.clear()

    async def close(self) -> None:
        self._rlm = None
        self._initialized = False

    async def __aenter__(self) -> "RLMClient":
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()
