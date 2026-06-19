"""
Tinker Client for Feed Training

Replaces local vLLM + PyTorch training with Tinker's cloud API.
This provides a unified interface for both training and inference.

Based on: https://tinker-docs.thinkingmachines.ai/training-sampling
Integration pattern from: tinker-atropos (Nous Research)

Key features:
- TrainingClient for forward_backward + optim_step
- SamplingClient for inference during rollouts
- Weight synchronization between training and sampling
- Automatic tokenization and format conversion
"""

import asyncio
import logging
import os
import urllib.request
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import numpy as np

logger = logging.getLogger(__name__)

DEFAULT_TINKER_OPENAI_BASE_URL = os.getenv(
    "TINKER_OPENAI_BASE_URL",
    "https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1",
)
DEFAULT_TINKER_BASE_MODEL = os.getenv("TINKER_BASE_MODEL", "Qwen/Qwen3.5-4B")
TINKER_API_KEY_ENV_VARS = (
    "TINKER_API_KEY",
    "TM_API_KEY",
    "THINKINGMACHINES_API_KEY",
)
STALE_TINKER_MODEL_ALIASES = {
    "Qwen/Qwen3-30B-A3B-Instruct": "Qwen/Qwen3-30B-A3B-Instruct-2507",
    "Qwen/Qwen3-4B-Instruct": "Qwen/Qwen3-4B-Instruct-2507",
}

# Lazy import tinker to allow graceful degradation
try:
    import tinker
    from tinker import types as tinker_types

    TINKER_AVAILABLE = True
except ImportError:
    TINKER_AVAILABLE = False
    tinker = None  # type: ignore
    tinker_types = None  # type: ignore
    logger.warning("Tinker not installed. Install with: pip install tinker")


def resolve_tinker_api_key() -> str | None:
    for env_name in TINKER_API_KEY_ENV_VARS:
        value = os.environ.get(env_name)
        if value and value.strip():
            return value.strip()
    return None


def ensure_tinker_api_key_env() -> str | None:
    api_key = resolve_tinker_api_key()
    if api_key and not os.environ.get("TINKER_API_KEY"):
        os.environ["TINKER_API_KEY"] = api_key
    return api_key


def resolve_tinker_base_model(
    requested_model: str,
    available_models: Sequence[str],
) -> str:
    if requested_model in available_models:
        return requested_model

    alias = STALE_TINKER_MODEL_ALIASES.get(requested_model)
    if alias in available_models:
        return alias

    dated_matches = sorted(
        model_name
        for model_name in available_models
        if model_name.startswith(f"{requested_model}-")
    )
    if len(dated_matches) == 1:
        return dated_matches[0]

    qwen_models = [model_name for model_name in available_models if "qwen" in model_name.lower()]
    suggested_models = qwen_models[:5] if qwen_models else list(available_models[:5])
    suggestion_text = ", ".join(suggested_models)
    raise RuntimeError(
        f"Tinker base model {requested_model} is not supported. "
        f"Supported examples: {suggestion_text}"
    )


@dataclass
class TinkerConfig:
    """Configuration for Tinker client"""

    # Model settings
    base_model: str = DEFAULT_TINKER_BASE_MODEL
    lora_rank: int = 32
    resume_from_state: str | None = None

    # Training hyperparameters
    learning_rate: float = 4e-5
    beta1: float = 0.9
    beta2: float = 0.95
    epsilon: float = 1e-8

    # Sampling settings
    default_max_tokens: int = 512
    default_temperature: float = 0.7
    stop_sequences: list[str] = field(
        default_factory=lambda: ["\n\n", "<|endoftext|>", "<|im_end|>"]
    )

    # Weight sync settings
    checkpoint_name_prefix: str = "feed"

    # Timeout settings
    capabilities_timeout_seconds: int = 30
    setup_timeout_seconds: int = 120
    sampling_timeout_seconds: int = 120
    training_step_timeout_seconds: int = 300
    checkpoint_timeout_seconds: int = 180
    download_timeout_seconds: int = 300


class TinkerDatum:
    """
    Wrapper for Tinker Datum to avoid direct tinker_types dependency.

    This allows code to work even when tinker is not installed.
    """

    def __init__(
        self,
        input_tokens: list[int],
        target_tokens: list[int],
        weights: list[float],
    ):
        self.input_tokens = input_tokens
        self.target_tokens = target_tokens
        self.weights = weights
        self._tinker_datum: object = None

    def to_tinker(self) -> object:
        """Convert to actual Tinker Datum"""
        if not TINKER_AVAILABLE:
            raise RuntimeError("Tinker not installed")

        if self._tinker_datum is None:
            self._tinker_datum = tinker_types.Datum(
                model_input=tinker_types.ModelInput.from_ints(tokens=self.input_tokens),
                loss_fn_inputs=dict(
                    weights=self.weights,
                    target_tokens=self.target_tokens,
                ),
            )
        return self._tinker_datum

    def set_weights(self, weights: Sequence[float]) -> None:
        """Update datum weights while preserving the SDK's TensorData shape."""
        tinker_datum = self.to_tinker()
        weights_array = np.asarray(list(weights), dtype=np.float32)
        tinker_datum.loss_fn_inputs["weights"] = tinker_types.TensorData.from_numpy(weights_array)


@dataclass
class TrainStepResult:
    """Result from a training step"""

    loss: float
    num_samples: int
    logprobs_mean: float = 0.0
    pos_advantage_mean: float = 0.0
    neg_advantage_mean: float = 0.0


@dataclass
class SampleResult:
    """Result from sampling"""

    completions: list[str]
    logprobs: list[list[float]] = field(default_factory=list)
    finish_reasons: list[str] = field(default_factory=list)


class FeedTinkerClient:
    """
    Unified Tinker client for training and inference.

    This replaces local vLLM + PyTorch training with Tinker's cloud API:
    - No local GPU required for training
    - Training happens in Tinker cloud
    - Fast weight sync between training and sampling
    - Automatic format conversion

    Usage:
        client = FeedTinkerClient(config)
        client.setup()

        # Training
        data = [client.prepare_datum(messages, completion) for ...]
        result = client.train_step(data, scores)

        # Inference
        completions = client.sample(messages)

        # Sync weights after training
        client.sync_weights("checkpoint-name")
    """

    def __init__(self, config: TinkerConfig | None = None):
        if not TINKER_AVAILABLE:
            raise RuntimeError("Tinker not installed. Install with: pip install tinker")

        ensure_tinker_api_key_env()

        self.config = config or TinkerConfig()
        self._service_client: object = None
        self._training_client: object = None
        self._sampling_client: object = None
        self._tokenizer: object = None
        self._initialized = False
        self._current_step = 0
        self._initial_sampler_path: str | None = None
        self._current_sampler_path: str | None = None
        self._initial_state_path: str | None = config.resume_from_state if config else None
        self._current_state_path: str | None = config.resume_from_state if config else None

    @property
    def service_client(self) -> object:
        """Lazily initialize service client"""
        if self._service_client is None:
            self._service_client = tinker.ServiceClient()
        return self._service_client

    @property
    def training_client(self) -> object:
        """Get training client (must call setup first)"""
        if self._training_client is None:
            raise RuntimeError("Client not initialized. Call setup() first.")
        return self._training_client

    @property
    def sampling_client(self) -> object:
        """Get sampling client (must call setup first)"""
        if self._sampling_client is None:
            raise RuntimeError("Client not initialized. Call setup() first.")
        return self._sampling_client

    @property
    def tokenizer(self) -> object:
        """Get tokenizer (must call setup first)"""
        if self._tokenizer is None:
            raise RuntimeError("Client not initialized. Call setup() first.")
        return self._tokenizer

    @property
    def initial_sampler_path(self) -> str | None:
        return self._initial_sampler_path

    @property
    def current_sampler_path(self) -> str | None:
        return self._current_sampler_path

    @property
    def initial_state_path(self) -> str | None:
        return self._initial_state_path

    @property
    def current_state_path(self) -> str | None:
        return self._current_state_path

    def _extract_sampling_client_path(self, client: object) -> str | None:
        for attr in ("model_path", "path", "sampler_path"):
            value = getattr(client, attr, None)
            if isinstance(value, str) and value:
                return value
        return None

    def _normalize_tinker_exception(self, exc: Exception) -> RuntimeError:
        message = str(exc)
        lowered = message.lower()
        if "billing status" in lowered or "error code: 402" in lowered:
            return RuntimeError(
                "Tinker API access is blocked by billing status. "
                "Add payment at https://tinker-console.thinkingmachines.ai/billing/balance "
                "and retry."
            )
        if "error code: 401" in lowered or "unauthorized" in lowered:
            return RuntimeError(
                "Tinker rejected the API key. Verify TINKER_API_KEY or its configured alias and retry."
            )
        return RuntimeError(f"Tinker API request failed: {message}")

    async def _await_tinker_async(
        self,
        awaitable,
        *,
        operation: str,
        timeout_seconds: int,
    ):
        try:
            return await asyncio.wait_for(awaitable, timeout=timeout_seconds)
        except asyncio.TimeoutError as exc:
            raise RuntimeError(f"Tinker {operation} timed out after {timeout_seconds}s") from exc
        except Exception as exc:
            raise self._normalize_tinker_exception(exc) from exc

    async def _await_with_timeout(
        self,
        awaitable,
        *,
        operation: str,
        timeout_seconds: int,
    ):
        try:
            return await asyncio.wait_for(awaitable, timeout=timeout_seconds)
        except asyncio.TimeoutError as exc:
            raise RuntimeError(f"{operation} timed out after {timeout_seconds}s") from exc

    def _save_sampler_checkpoint(self, name: str) -> tuple[object, str | None]:
        save_for_sampler = getattr(self.training_client, "save_weights_for_sampler", None)
        if callable(save_for_sampler):
            response = save_for_sampler(name=name).result()
            model_path = getattr(response, "path", None)
            if not isinstance(model_path, str) or not model_path:
                raise RuntimeError("Tinker save_weights_for_sampler returned no path")

            create_sampling_client = getattr(
                self.training_client,
                "create_sampling_client",
                None,
            )
            if callable(create_sampling_client):
                sampling_client = create_sampling_client(model_path)
            else:
                sampling_client = self.service_client.create_sampling_client(model_path=model_path)
            return sampling_client, model_path

        sampling_client = self.training_client.save_weights_and_get_sampling_client(name=name)
        return sampling_client, self._extract_sampling_client_path(sampling_client)

    async def _save_sampler_checkpoint_async(self, name: str) -> tuple[object, str | None]:
        save_for_sampler = getattr(self.training_client, "save_weights_for_sampler_async", None)
        if callable(save_for_sampler):
            future = await self._await_tinker_async(
                save_for_sampler(name=name),
                operation="checkpoint save submission",
                timeout_seconds=self.config.checkpoint_timeout_seconds,
            )
            response = await self._await_tinker_async(
                future.result_async(),
                operation="checkpoint save completion",
                timeout_seconds=self.config.checkpoint_timeout_seconds,
            )
            model_path = getattr(response, "path", None)
            if not isinstance(model_path, str) or not model_path:
                raise RuntimeError("Tinker save_weights_for_sampler returned no path")

            create_sampling_client = getattr(
                self.training_client,
                "create_sampling_client_async",
                None,
            )
            if callable(create_sampling_client):
                sampling_client = await self._await_tinker_async(
                    create_sampling_client(model_path),
                    operation="sampling client creation",
                    timeout_seconds=self.config.setup_timeout_seconds,
                )
            else:
                sampling_client = await self._await_tinker_async(
                    self.service_client.create_sampling_client_async(model_path=model_path),
                    operation="sampling client creation",
                    timeout_seconds=self.config.setup_timeout_seconds,
                )
            return sampling_client, model_path

        save_and_get = getattr(
            self.training_client,
            "save_weights_and_get_sampling_client_async",
            None,
        )
        if callable(save_and_get):
            sampling_client = await self._await_tinker_async(
                save_and_get(name=name),
                operation="checkpoint save-and-sampler creation",
                timeout_seconds=self.config.checkpoint_timeout_seconds,
            )
            return sampling_client, self._extract_sampling_client_path(sampling_client)

        return self._save_sampler_checkpoint(name)

    def setup(self) -> None:
        """
        Initialize training client, sampling client, and tokenizer.

        Must be called before any training or sampling operations.
        """
        if self._initialized:
            logger.info("Client already initialized")
            return

        logger.info(f"Initializing Tinker client with model: {self.config.base_model}")

        # Verify API key is set
        if not ensure_tinker_api_key_env():
            raise ValueError(
                "TINKER_API_KEY environment variable not set. "
                "Set TINKER_API_KEY, TM_API_KEY, or THINKINGMACHINES_API_KEY."
            )

        # Check model availability
        try:
            capabilities = self.service_client.get_server_capabilities()
        except Exception as exc:
            raise self._normalize_tinker_exception(exc) from exc
        available_models = [m.model_name for m in capabilities.supported_models]
        resolved_model = resolve_tinker_base_model(
            self.config.base_model,
            available_models,
        )
        if resolved_model != self.config.base_model:
            logger.info(
                "Resolved Tinker model %s -> %s",
                self.config.base_model,
                resolved_model,
            )
            self.config.base_model = resolved_model

        resume_from_state = self.config.resume_from_state
        if resume_from_state:
            logger.info("Resuming Tinker training from state: %s", resume_from_state)
            create_from_state = getattr(
                self.service_client,
                "create_training_client_from_state",
                None,
            )
            if callable(create_from_state):
                self._training_client = create_from_state(resume_from_state)
            else:
                self._training_client = self.service_client.create_lora_training_client(
                    base_model=self.config.base_model,
                    rank=self.config.lora_rank,
                )
                self._training_client.load_state(resume_from_state).result()
            self._initial_state_path = resume_from_state
            self._current_state_path = resume_from_state
        else:
            # Create training client with LoRA
            self._training_client = self.service_client.create_lora_training_client(
                base_model=self.config.base_model,
                rank=self.config.lora_rank,
            )

        # Get tokenizer
        self._tokenizer = self._training_client.get_tokenizer()

        # Create initial sampling client
        initial_name = f"{self.config.checkpoint_name_prefix}-initial"
        self._sampling_client, self._initial_sampler_path = self._save_sampler_checkpoint(
            initial_name
        )
        self._current_sampler_path = self._initial_sampler_path

        self._initialized = True
        logger.info("Tinker client initialized successfully")

    async def setup_async(self) -> None:
        """Async variant of setup() for use inside asyncio code."""
        if self._initialized:
            logger.info("Client already initialized")
            return

        logger.info(f"Initializing Tinker client with model: {self.config.base_model}")

        if not ensure_tinker_api_key_env():
            raise ValueError(
                "TINKER_API_KEY environment variable not set. "
                "Set TINKER_API_KEY, TM_API_KEY, or THINKINGMACHINES_API_KEY."
            )

        capabilities = await self._await_tinker_async(
            self.service_client.get_server_capabilities_async(),
            operation="capability lookup",
            timeout_seconds=self.config.capabilities_timeout_seconds,
        )
        available_models = [m.model_name for m in capabilities.supported_models]
        resolved_model = resolve_tinker_base_model(
            self.config.base_model,
            available_models,
        )
        if resolved_model != self.config.base_model:
            logger.info(
                "Resolved Tinker model %s -> %s",
                self.config.base_model,
                resolved_model,
            )
            self.config.base_model = resolved_model

        resume_from_state = self.config.resume_from_state
        if resume_from_state:
            logger.info("Resuming Tinker training from state: %s", resume_from_state)
            create_from_state = getattr(
                self.service_client,
                "create_training_client_from_state_async",
                None,
            )
            if callable(create_from_state):
                self._training_client = await self._await_tinker_async(
                    create_from_state(resume_from_state),
                    operation="training client resume",
                    timeout_seconds=self.config.setup_timeout_seconds,
                )
            else:
                self._training_client = await self._await_tinker_async(
                    self.service_client.create_lora_training_client_async(
                        base_model=self.config.base_model,
                        rank=self.config.lora_rank,
                    ),
                    operation="training client creation",
                    timeout_seconds=self.config.setup_timeout_seconds,
                )
                load_state = getattr(self._training_client, "load_state_async", None)
                if not callable(load_state):
                    raise RuntimeError("Tinker SDK does not expose async state loading")
                future = await self._await_tinker_async(
                    load_state(resume_from_state),
                    operation="training state load submission",
                    timeout_seconds=self.config.checkpoint_timeout_seconds,
                )
                await self._await_tinker_async(
                    future.result_async(),
                    operation="training state load completion",
                    timeout_seconds=self.config.checkpoint_timeout_seconds,
                )
            self._initial_state_path = resume_from_state
            self._current_state_path = resume_from_state
        else:
            self._training_client = await self._await_tinker_async(
                self.service_client.create_lora_training_client_async(
                    base_model=self.config.base_model,
                    rank=self.config.lora_rank,
                ),
                operation="training client creation",
                timeout_seconds=self.config.setup_timeout_seconds,
            )

        self._tokenizer = self._training_client.get_tokenizer()

        initial_name = f"{self.config.checkpoint_name_prefix}-initial"
        (
            self._sampling_client,
            self._initial_sampler_path,
        ) = await self._save_sampler_checkpoint_async(initial_name)
        self._current_sampler_path = self._initial_sampler_path

        self._initialized = True
        logger.info("Tinker client initialized successfully")

    def prepare_datum(
        self,
        messages: list[dict],
        completion: str,
        max_sequence_length: int | None = None,
    ) -> TinkerDatum:
        """
        Convert chat messages + completion to Tinker Datum.

        Args:
            messages: List of chat messages (role/content dicts)
            completion: The assistant completion to train on

        Returns:
            TinkerDatum ready for training
        """
        # Render messages to prompt using chat template
        prompt = self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )

        # Tokenize prompt (no loss on prompt tokens)
        prompt_tokens = self.tokenizer.encode(prompt, add_special_tokens=True)
        prompt_weights = [0.0] * len(prompt_tokens)

        # Tokenize completion (loss on these tokens)
        completion_tokens = self.tokenizer.encode(completion, add_special_tokens=False)
        completion_weights = [1.0] * len(completion_tokens)

        # Keep the latest prompt context and the full completion when possible.
        if max_sequence_length and max_sequence_length > 1:
            if len(completion_tokens) >= max_sequence_length:
                completion_tokens = completion_tokens[:max_sequence_length]
                completion_weights = completion_weights[:max_sequence_length]
                prompt_tokens = []
                prompt_weights = []
            else:
                keep_prompt_tokens = max_sequence_length - len(completion_tokens)
                prompt_tokens = (
                    prompt_tokens[-keep_prompt_tokens:] if keep_prompt_tokens > 0 else []
                )
                prompt_weights = (
                    prompt_weights[-keep_prompt_tokens:] if keep_prompt_tokens > 0 else []
                )

        all_tokens = prompt_tokens + completion_tokens
        all_weights = prompt_weights + completion_weights

        # Shift for next-token prediction
        input_tokens = all_tokens[:-1]
        target_tokens = all_tokens[1:]
        weights = all_weights[1:]

        return TinkerDatum(
            input_tokens=input_tokens,
            target_tokens=target_tokens,
            weights=weights,
        )

    def prepare_datum_from_tokens(
        self,
        tokens: list[int],
        masks: list[int],
        max_sequence_length: int | None = None,
    ) -> TinkerDatum:
        """
        Create Datum from pre-tokenized data (e.g., from Atropos).

        Args:
            tokens: Token IDs
            masks: Mask values (-100 for no loss, token_id for loss)

        Returns:
            TinkerDatum ready for training
        """
        if max_sequence_length and max_sequence_length > 1 and len(tokens) > max_sequence_length:
            tokens = tokens[-max_sequence_length:]
            masks = masks[-max_sequence_length:]

        # Convert masks to weights (0 for -100, 1 otherwise)
        weights = [0.0 if m == -100 else 1.0 for m in masks]

        # Shift for next-token prediction
        input_tokens = tokens[:-1]
        target_tokens = tokens[1:]
        weights = weights[1:]

        return TinkerDatum(
            input_tokens=input_tokens,
            target_tokens=target_tokens,
            weights=weights,
        )

    def train_step(
        self,
        data: Sequence[TinkerDatum],
        scores: list[float],
        loss_fn: Literal["cross_entropy", "importance_sampling"] = "cross_entropy",
    ) -> TrainStepResult:
        """
        Execute one training step with Tinker.

        Args:
            data: List of TinkerDatum objects
            scores: Advantage scores for each datum (should be centered at 0)
            loss_fn: Loss function to use

        Returns:
            TrainStepResult with loss and metrics
        """
        if not data:
            return TrainStepResult(loss=0.0, num_samples=0)

        # Convert to Tinker format and apply advantage weights
        tinker_data = []
        for datum, score in zip(data, scores, strict=False):
            tinker_datum = datum.to_tinker()

            # Scale weights by advantage for GRPO/IS
            # Positive advantage = learn this behavior
            # Negative advantage = unlearn this behavior
            scaled_weights = [w * score for w in datum.weights]
            datum.set_weights(scaled_weights)

            tinker_data.append(tinker_datum)

        # Forward-backward pass (async submission)
        fwdbwd_future = self.training_client.forward_backward(tinker_data, loss_fn)

        # Optimizer step (async submission)
        optim_future = self.training_client.optim_step(
            tinker_types.AdamParams(
                learning_rate=self.config.learning_rate,
                beta1=self.config.beta1,
                beta2=self.config.beta2,
                eps=self.config.epsilon,
            )
        )

        # Wait for results
        fwdbwd_result = fwdbwd_future.result()
        _ = optim_future.result()  # Just wait for completion

        # Compute metrics
        all_logprobs = []
        all_weights = []
        for output, datum in zip(fwdbwd_result.loss_fn_outputs, tinker_data, strict=False):
            logprobs = output["logprobs"].tolist()
            weights = datum.loss_fn_inputs["weights"]
            all_logprobs.extend(logprobs)
            all_weights.extend(weights if isinstance(weights, list) else weights.tolist())

        # Compute weighted loss
        logprobs_arr = np.array(all_logprobs)
        weights_arr = np.array(all_weights)

        weight_sum = np.sum(np.abs(weights_arr))
        if weight_sum > 1e-8:
            loss = float(-np.dot(logprobs_arr, weights_arr) / weight_sum)
            logprobs_mean = float(np.mean(logprobs_arr))
        else:
            loss = 0.0
            logprobs_mean = 0.0

        # Compute advantage statistics
        scores_arr = np.array(scores)
        pos_mask = scores_arr > 0
        neg_mask = scores_arr <= 0

        pos_advantage_mean = float(np.mean(scores_arr[pos_mask])) if np.any(pos_mask) else 0.0
        neg_advantage_mean = float(np.mean(scores_arr[neg_mask])) if np.any(neg_mask) else 0.0

        self._current_step += 1

        return TrainStepResult(
            loss=loss,
            num_samples=len(data),
            logprobs_mean=logprobs_mean,
            pos_advantage_mean=pos_advantage_mean,
            neg_advantage_mean=neg_advantage_mean,
        )

    async def train_step_async(
        self,
        data: Sequence[TinkerDatum],
        scores: list[float],
        loss_fn: Literal["cross_entropy", "importance_sampling"] = "cross_entropy",
    ) -> TrainStepResult:
        if not data:
            return TrainStepResult(loss=0.0, num_samples=0)

        tinker_data = []
        for datum, score in zip(data, scores, strict=False):
            tinker_datum = datum.to_tinker()
            scaled_weights = [w * score for w in datum.weights]
            datum.set_weights(scaled_weights)
            tinker_data.append(tinker_datum)

        fwdbwd_future = await self._await_tinker_async(
            self.training_client.forward_backward_async(tinker_data, loss_fn),
            operation="forward_backward submission",
            timeout_seconds=self.config.training_step_timeout_seconds,
        )
        optim_future = await self._await_tinker_async(
            self.training_client.optim_step_async(
                tinker_types.AdamParams(
                    learning_rate=self.config.learning_rate,
                    beta1=self.config.beta1,
                    beta2=self.config.beta2,
                    eps=self.config.epsilon,
                )
            ),
            operation="optimizer step submission",
            timeout_seconds=self.config.training_step_timeout_seconds,
        )

        fwdbwd_result = await self._await_tinker_async(
            fwdbwd_future.result_async(),
            operation="forward_backward completion",
            timeout_seconds=self.config.training_step_timeout_seconds,
        )
        await self._await_tinker_async(
            optim_future.result_async(),
            operation="optimizer step completion",
            timeout_seconds=self.config.training_step_timeout_seconds,
        )

        all_logprobs = []
        all_weights = []
        for output, datum in zip(fwdbwd_result.loss_fn_outputs, tinker_data, strict=False):
            logprobs = output["logprobs"].tolist()
            weights = datum.loss_fn_inputs["weights"]
            all_logprobs.extend(logprobs)
            all_weights.extend(weights if isinstance(weights, list) else weights.tolist())

        logprobs_arr = np.array(all_logprobs)
        weights_arr = np.array(all_weights)

        weight_sum = np.sum(np.abs(weights_arr))
        if weight_sum > 1e-8:
            loss = float(-np.dot(logprobs_arr, weights_arr) / weight_sum)
            logprobs_mean = float(np.mean(logprobs_arr))
        else:
            loss = 0.0
            logprobs_mean = 0.0

        scores_arr = np.array(scores)
        pos_mask = scores_arr > 0
        neg_mask = scores_arr <= 0

        pos_advantage_mean = float(np.mean(scores_arr[pos_mask])) if np.any(pos_mask) else 0.0
        neg_advantage_mean = float(np.mean(scores_arr[neg_mask])) if np.any(neg_mask) else 0.0

        self._current_step += 1

        return TrainStepResult(
            loss=loss,
            num_samples=len(data),
            logprobs_mean=logprobs_mean,
            pos_advantage_mean=pos_advantage_mean,
            neg_advantage_mean=neg_advantage_mean,
        )

    def sync_weights(self, name: str | None = None) -> str | None:
        """
        Sync training weights to sampling client.

        This updates the sampling client to use the latest trained weights.
        Should be called periodically during training.

        Args:
            name: Checkpoint name (auto-generated if not provided)
        """
        if name is None:
            name = f"{self.config.checkpoint_name_prefix}-step-{self._current_step}"

        logger.info(f"Syncing weights to sampling client: {name}")

        self._sampling_client, self._current_sampler_path = self._save_sampler_checkpoint(name)
        return self._current_sampler_path

    async def sync_weights_async(self, name: str | None = None) -> str | None:
        if name is None:
            name = f"{self.config.checkpoint_name_prefix}-step-{self._current_step}"

        logger.info(f"Syncing weights to sampling client: {name}")
        (
            self._sampling_client,
            self._current_sampler_path,
        ) = await self._save_sampler_checkpoint_async(name)
        return self._current_sampler_path

    def checkpoint_openai_base_url(self) -> str:
        return DEFAULT_TINKER_OPENAI_BASE_URL

    def save_state(self, name: str | None = None) -> str | None:
        """Persist a resumable training-state checkpoint."""
        if name is None:
            name = f"{self.config.checkpoint_name_prefix}-state-{self._current_step}"

        logger.info("Saving Tinker training state: %s", name)
        response = self.training_client.save_state(name=name).result()
        state_path = getattr(response, "path", None)
        if not isinstance(state_path, str) or not state_path:
            raise RuntimeError("Tinker save_state returned no path")
        if self._initial_state_path is None:
            self._initial_state_path = state_path
        self._current_state_path = state_path
        return state_path

    async def save_state_async(self, name: str | None = None) -> str | None:
        if name is None:
            name = f"{self.config.checkpoint_name_prefix}-state-{self._current_step}"

        logger.info("Saving Tinker training state: %s", name)
        future = await self._await_tinker_async(
            self.training_client.save_state_async(name=name),
            operation="state save submission",
            timeout_seconds=self.config.checkpoint_timeout_seconds,
        )
        response = await self._await_tinker_async(
            future.result_async(),
            operation="state save completion",
            timeout_seconds=self.config.checkpoint_timeout_seconds,
        )
        state_path = getattr(response, "path", None)
        if not isinstance(state_path, str) or not state_path:
            raise RuntimeError("Tinker save_state returned no path")
        if self._initial_state_path is None:
            self._initial_state_path = state_path
        self._current_state_path = state_path
        return state_path

    def download_checkpoint_archive(
        self,
        *,
        tinker_path: str,
        output_path: str | Path,
    ) -> Path:
        rest_client_factory = getattr(self.service_client, "create_rest_client", None)
        if callable(rest_client_factory):
            rest_client = rest_client_factory()
        elif hasattr(tinker, "RestClient"):
            rest_client = tinker.RestClient()
        else:
            raise RuntimeError("Tinker SDK does not expose a RestClient")

        future = rest_client.get_checkpoint_archive_url_from_tinker_path(tinker_path)
        response = future.result()
        signed_url = getattr(response, "url", None)
        if not isinstance(signed_url, str) or not signed_url:
            raise RuntimeError("Tinker checkpoint archive response did not include a URL")

        destination = Path(output_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(signed_url, destination)
        return destination

    async def download_checkpoint_archive_async(
        self,
        *,
        tinker_path: str,
        output_path: str | Path,
    ) -> Path:
        rest_client_factory = getattr(self.service_client, "create_rest_client", None)
        if callable(rest_client_factory):
            rest_client = rest_client_factory()
        elif hasattr(tinker, "RestClient"):
            rest_client = tinker.RestClient()
        else:
            raise RuntimeError("Tinker SDK does not expose a RestClient")

        response = await self._await_tinker_async(
            asyncio.to_thread(
                lambda: rest_client.get_checkpoint_archive_url_from_tinker_path(
                    tinker_path
                ).result()
            ),
            operation="checkpoint archive URL lookup",
            timeout_seconds=self.config.download_timeout_seconds,
        )

        signed_url = getattr(response, "url", None)
        if not isinstance(signed_url, str) or not signed_url:
            raise RuntimeError("Tinker checkpoint archive response did not include a URL")

        destination = Path(output_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        await self._await_with_timeout(
            asyncio.to_thread(urllib.request.urlretrieve, signed_url, destination),
            operation="checkpoint archive download",
            timeout_seconds=self.config.download_timeout_seconds,
        )
        return destination

    def sample(
        self,
        messages: list[dict],
        max_tokens: int | None = None,
        temperature: float | None = None,
        n: int = 1,
        stop: list[str] | None = None,
        include_logprobs: bool = False,
    ) -> SampleResult:
        """
        Sample completions from current model.

        Args:
            messages: Chat messages to complete
            max_tokens: Maximum tokens to generate
            temperature: Sampling temperature
            n: Number of completions to generate
            stop: Stop sequences
            include_logprobs: Whether to include logprobs

        Returns:
            SampleResult with completions and optional logprobs
        """
        max_tokens = max_tokens or self.config.default_max_tokens
        temperature = temperature if temperature is not None else self.config.default_temperature
        stop = stop or self.config.stop_sequences

        # Render prompt
        prompt = self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )

        # Tokenize
        prompt_tokens = tinker_types.ModelInput.from_ints(self.tokenizer.encode(prompt))

        # Sampling params
        params = tinker_types.SamplingParams(
            max_tokens=max_tokens,
            temperature=temperature,
            stop=stop,
        )

        # Sample
        result = self.sampling_client.sample(
            prompt=prompt_tokens,
            sampling_params=params,
            num_samples=n,
            include_prompt_logprobs=include_logprobs,
        ).result()

        # Decode completions
        completions = [self.tokenizer.decode(seq.tokens) for seq in result.sequences]

        # Extract logprobs if requested
        logprobs = []
        if include_logprobs and hasattr(result, "prompt_logprobs"):
            logprobs = [result.prompt_logprobs] * n

        # Extract finish reasons
        finish_reasons = [getattr(seq, "finish_reason", "stop") for seq in result.sequences]

        return SampleResult(
            completions=completions,
            logprobs=logprobs,
            finish_reasons=finish_reasons,
        )

    async def sample_async(
        self,
        messages: list[dict],
        max_tokens: int | None = None,
        temperature: float | None = None,
        n: int = 1,
        stop: list[str] | None = None,
        include_logprobs: bool = False,
    ) -> SampleResult:
        max_tokens = max_tokens or self.config.default_max_tokens
        temperature = temperature if temperature is not None else self.config.default_temperature
        stop = stop or self.config.stop_sequences

        prompt = self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        prompt_tokens = tinker_types.ModelInput.from_ints(self.tokenizer.encode(prompt))
        params = tinker_types.SamplingParams(
            max_tokens=max_tokens,
            temperature=temperature,
            stop=stop,
        )

        result = await self._await_tinker_async(
            self.sampling_client.sample_async(
                prompt=prompt_tokens,
                sampling_params=params,
                num_samples=n,
                include_prompt_logprobs=include_logprobs,
            ),
            operation="sampling request",
            timeout_seconds=self.config.sampling_timeout_seconds,
        )

        completions = [self.tokenizer.decode(seq.tokens) for seq in result.sequences]
        logprobs = []
        if include_logprobs and hasattr(result, "prompt_logprobs"):
            logprobs = [result.prompt_logprobs] * n
        finish_reasons = [getattr(seq, "finish_reason", "stop") for seq in result.sequences]

        return SampleResult(
            completions=completions,
            logprobs=logprobs,
            finish_reasons=finish_reasons,
        )

    async def get_available_models_async(self) -> list[str]:
        capabilities = await self._await_tinker_async(
            self.service_client.get_server_capabilities_async(),
            operation="capability lookup",
            timeout_seconds=self.config.capabilities_timeout_seconds,
        )
        return [m.model_name for m in capabilities.supported_models]

    def compute_logprobs(
        self,
        messages: list[dict],
        completion: str,
    ) -> list[float]:
        """
        Compute logprobs for a specific completion.

        Useful for importance sampling and evaluation.

        Args:
            messages: Chat messages
            completion: Completion to compute logprobs for

        Returns:
            List of logprobs for each token
        """
        # Build full sequence
        prompt = self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        full_text = prompt + completion

        prompt_tokens = tinker_types.ModelInput.from_ints(self.tokenizer.encode(full_text))

        # Compute logprobs via prefill
        result = self.sampling_client.sample(
            prompt=prompt_tokens,
            num_samples=1,
            sampling_params=tinker_types.SamplingParams(max_tokens=1),
            include_prompt_logprobs=True,
        ).result()

        # Return logprobs (first is None for first token)
        logprobs = result.prompt_logprobs or []
        return [lp if lp is not None else 0.0 for lp in logprobs]

    def save_weights(self, name: str) -> str:
        """
        Save current weights to Tinker storage.

        Args:
            name: Name for the saved weights

        Returns:
            Weight identifier
        """
        logger.info(f"Saving weights: {name}")
        return self.training_client.save_weights(name=name)

    def load_state(self, path: str) -> None:
        """
        Load a saved Tinker training-state checkpoint into a fresh training client.

        Args:
            path: Fully qualified Tinker checkpoint path returned by save_state()
        """
        logger.info("Loading Tinker training state: %s", path)
        create_from_state = getattr(
            self.service_client,
            "create_training_client_from_state",
            None,
        )
        if not callable(create_from_state):
            raise RuntimeError("Tinker SDK does not expose create_training_client_from_state")

        self._training_client = create_from_state(path)
        self._tokenizer = self._training_client.get_tokenizer()
        self._current_state_path = path
        if self._initial_state_path is None:
            self._initial_state_path = path
        self.sync_weights(name=f"{self.config.checkpoint_name_prefix}-loaded")

    async def load_state_async(self, path: str) -> None:
        """
        Async variant of load_state() for use inside asyncio code.

        Args:
            path: Fully qualified Tinker checkpoint path returned by save_state()
        """
        logger.info("Loading Tinker training state: %s", path)
        create_from_state = getattr(
            self.service_client,
            "create_training_client_from_state_async",
            None,
        )
        if callable(create_from_state):
            self._training_client = await self._await_tinker_async(
                create_from_state(path),
                operation="training client resume",
                timeout_seconds=self.config.setup_timeout_seconds,
            )
        else:
            self._training_client = await self._await_tinker_async(
                self.service_client.create_lora_training_client_async(
                    base_model=self.config.base_model,
                    rank=self.config.lora_rank,
                ),
                operation="training client creation",
                timeout_seconds=self.config.setup_timeout_seconds,
            )
            load_state = getattr(self._training_client, "load_state_async", None)
            if not callable(load_state):
                raise RuntimeError("Tinker SDK does not expose async state loading")
            future = await self._await_tinker_async(
                load_state(path),
                operation="training state load submission",
                timeout_seconds=self.config.checkpoint_timeout_seconds,
            )
            await self._await_tinker_async(
                future.result_async(),
                operation="training state load completion",
                timeout_seconds=self.config.checkpoint_timeout_seconds,
            )

        self._tokenizer = self._training_client.get_tokenizer()
        self._current_state_path = path
        if self._initial_state_path is None:
            self._initial_state_path = path
        await self.sync_weights_async(name=f"{self.config.checkpoint_name_prefix}-loaded")

    def load_weights(self, path: str) -> None:
        """Backwards-compatible alias for loading a saved state path."""
        self.load_state(path)

    def get_available_models(self) -> list[str]:
        """Get list of available base models from Tinker"""
        try:
            capabilities = self.service_client.get_server_capabilities()
        except Exception as exc:
            raise self._normalize_tinker_exception(exc) from exc
        return [m.model_name for m in capabilities.supported_models]

    @property
    def current_step(self) -> int:
        """Get current training step"""
        return self._current_step

    @property
    def is_initialized(self) -> bool:
        """Check if client is initialized"""
        return self._initialized
