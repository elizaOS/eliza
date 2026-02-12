"""
Tinker client for RL training.

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

import logging
import os
from dataclasses import dataclass, field
from typing import List, Literal, Sequence

import numpy as np

logger = logging.getLogger(__name__)

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


@dataclass
class TinkerConfig:
    """Configuration for Tinker client"""

    # Model settings
    base_model: str = "Qwen/Qwen3-30B-A3B-Instruct"
    lora_rank: int = 32

    # Training hyperparameters
    learning_rate: float = 4e-5
    beta1: float = 0.9
    beta2: float = 0.95
    epsilon: float = 1e-8

    # Sampling settings
    default_max_tokens: int = 512
    default_temperature: float = 0.7
    stop_sequences: List[str] = field(
        default_factory=lambda: ["\n\n", "<|endoftext|>", "<|im_end|>"]
    )

    # Weight sync settings
    checkpoint_name_prefix: str = "eliza"


class TinkerDatum:
    """
    Wrapper for Tinker Datum to avoid direct tinker_types dependency.

    This allows code to work even when tinker is not installed.
    """

    def __init__(
        self,
        input_tokens: List[int],
        target_tokens: List[int],
        weights: List[float],
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

    completions: List[str]
    logprobs: List[List[float]] = field(default_factory=list)
    finish_reasons: List[str] = field(default_factory=list)


class TinkerClient:
    """
    Unified Tinker client for training and inference.

    This replaces local vLLM + PyTorch training with Tinker's cloud API:
    - No local GPU required for training
    - Training happens in Tinker cloud
    - Fast weight sync between training and sampling
    - Automatic format conversion

    Usage:
        client = TinkerClient(config)
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
            raise RuntimeError(
                "Tinker not installed. Install with: pip install tinker"
            )

        self.config = config or TinkerConfig()
        self._service_client: object = None
        self._training_client: object = None
        self._sampling_client: object = None
        self._tokenizer: object = None
        self._initialized = False
        self._current_step = 0

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
        if not os.environ.get("TINKER_API_KEY"):
            raise ValueError(
                "TINKER_API_KEY environment variable not set. "
                "Get your API key from Thinking Machines."
            )

        # Check model availability
        capabilities = self.service_client.get_server_capabilities()
        available_models = [m.model_name for m in capabilities.supported_models]

        if self.config.base_model not in available_models:
            logger.warning(
                f"Model {self.config.base_model} not in available models. "
                f"Available: {available_models[:5]}..."
            )

        # Create training client with LoRA
        self._training_client = self.service_client.create_lora_training_client(
            base_model=self.config.base_model,
            lora_rank=self.config.lora_rank,
        )

        # Get tokenizer
        self._tokenizer = self._training_client.get_tokenizer()

        # Create initial sampling client
        initial_name = f"{self.config.checkpoint_name_prefix}-initial"
        self._sampling_client = self._training_client.save_weights_and_get_sampling_client(
            name=initial_name
        )

        self._initialized = True
        logger.info("Tinker client initialized successfully")

    def prepare_datum(
        self,
        messages: List[dict],
        completion: str,
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

        # Combine
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
        tokens: List[int],
        masks: List[int],
    ) -> TinkerDatum:
        """
        Create Datum from pre-tokenized data (e.g., from Atropos).

        Args:
            tokens: Token IDs
            masks: Mask values (-100 for no loss, token_id for loss)

        Returns:
            TinkerDatum ready for training
        """
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
        scores: List[float],
        loss_fn: Literal["cross_entropy", "importance_sampling"] = "importance_sampling",
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
        for datum, score in zip(data, scores):
            tinker_datum = datum.to_tinker()

            # Scale weights by advantage for GRPO/IS
            # Positive advantage = learn this behavior
            # Negative advantage = unlearn this behavior
            scaled_weights = [w * score for w in datum.weights]
            tinker_datum.loss_fn_inputs["weights"] = scaled_weights

            tinker_data.append(tinker_datum)

        # Forward-backward pass (async submission)
        fwdbwd_future = self.training_client.forward_backward(tinker_data, loss_fn)

        # Optimizer step (async submission)
        optim_future = self.training_client.optim_step(
            tinker_types.AdamParams(
                learning_rate=self.config.learning_rate,
                beta1=self.config.beta1,
                beta2=self.config.beta2,
                epsilon=self.config.epsilon,
            )
        )

        # Wait for results
        fwdbwd_result = fwdbwd_future.result()
        _ = optim_future.result()  # Just wait for completion

        # Compute metrics
        all_logprobs = []
        all_weights = []
        for output, datum in zip(fwdbwd_result.loss_fn_outputs, tinker_data):
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

    def sync_weights(self, name: str | None = None) -> None:
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

        self._sampling_client = self.training_client.save_weights_and_get_sampling_client(
            name=name
        )

    def sample(
        self,
        messages: List[dict],
        max_tokens: int | None = None,
        temperature: float | None = None,
        n: int = 1,
        stop: List[str] | None = None,
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
        prompt_tokens = tinker_types.ModelInput.from_ints(
            self.tokenizer.encode(prompt)
        )

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
        completions = [
            self.tokenizer.decode(seq.tokens)
            for seq in result.sequences
        ]

        # Extract logprobs if requested
        logprobs = []
        if include_logprobs and hasattr(result, "prompt_logprobs"):
            logprobs = [result.prompt_logprobs] * n

        # Extract finish reasons
        finish_reasons = [
            getattr(seq, "finish_reason", "stop")
            for seq in result.sequences
        ]

        return SampleResult(
            completions=completions,
            logprobs=logprobs,
            finish_reasons=finish_reasons,
        )

    def compute_logprobs(
        self,
        messages: List[dict],
        completion: str,
    ) -> List[float]:
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

        prompt_tokens = tinker_types.ModelInput.from_ints(
            self.tokenizer.encode(full_text)
        )

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

    def load_weights(self, name: str) -> None:
        """
        Load weights from Tinker storage.

        Args:
            name: Name of weights to load
        """
        logger.info(f"Loading weights: {name}")
        self.training_client.load_weights(name=name)

        # Update sampling client with loaded weights
        self.sync_weights(name=f"{name}-loaded")

    def get_available_models(self) -> List[str]:
        """Get list of available base models from Tinker"""
        capabilities = self.service_client.get_server_capabilities()
        return [m.model_name for m in capabilities.supported_models]

    @property
    def current_step(self) -> int:
        """Get current training step"""
        return self._current_step

    @property
    def is_initialized(self) -> bool:
        """Check if client is initialized"""
        return self._initialized


# Backward compatibility alias while imports migrate.
BabylonTinkerClient = TinkerClient
