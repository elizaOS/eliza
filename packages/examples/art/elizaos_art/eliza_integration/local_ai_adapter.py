"""
Local AI Adapter for ElizaOS plugin-local-ai

Provides model inference using local GGUF models via:
- llama.cpp (via node-llama-cpp in TypeScript)
- llama-cpp-python (in Python)
- Direct integration with ART training

Supports:
- Llama 3.2 1B/3B Instruct models
- Custom GGUF models
- Embeddings generation
- Tokenization
"""

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, runtime_checkable


@dataclass
class LocalModelConfig:
    """Configuration for local model inference."""

    # Model paths
    models_dir: str = field(
        default_factory=lambda: os.environ.get(
            "MODELS_DIR",
            str(Path.home() / ".eliza" / "models"),
        )
    )

    # Small model (1-3B params)
    small_model: str = field(
        default_factory=lambda: os.environ.get(
            "LOCAL_SMALL_MODEL",
            "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
        )
    )

    # Large model (7-8B params)
    large_model: str = field(
        default_factory=lambda: os.environ.get(
            "LOCAL_LARGE_MODEL",
            "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        )
    )

    # Embedding model
    embedding_model: str = field(
        default_factory=lambda: os.environ.get(
            "LOCAL_EMBEDDING_MODEL",
            "bge-small-en-v1.5.Q4_K_M.gguf",
        )
    )

    # Inference settings
    context_length: int = 8192
    gpu_layers: int = 43  # Use GPU acceleration
    temperature: float = 0.7
    max_tokens: int = 2048

    # Embedding dimensions
    embedding_dimensions: int = 384

    @property
    def small_model_path(self) -> Path:
        return Path(self.models_dir) / self.small_model

    @property
    def large_model_path(self) -> Path:
        return Path(self.models_dir) / self.large_model

    @property
    def embedding_model_path(self) -> Path:
        return Path(self.models_dir) / self.embedding_model


@runtime_checkable
class ModelProvider(Protocol):
    """Protocol for model inference providers."""

    async def generate_text(
        self,
        prompt: str,
        system_prompt: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        stop_sequences: list[str] | None = None,
    ) -> str:
        """Generate text from prompt."""
        ...

    async def generate_embedding(self, text: str) -> list[float]:
        """Generate embedding vector for text."""
        ...


class ElizaLocalAIProvider:
    """
    Local AI provider for ART training.
    
    Wraps llama-cpp-python for local GGUF model inference,
    compatible with plugin-local-ai patterns.
    """

    def __init__(self, config: LocalModelConfig | None = None):
        self.config = config or LocalModelConfig()
        self._llm = None
        self._embedding_model = None
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize the local models."""
        if self._initialized:
            return

        try:
            from llama_cpp import Llama
        except ImportError:
            raise ImportError(
                "llama-cpp-python not installed. "
                "Install with: pip install llama-cpp-python"
            )

        # Initialize main model
        model_path = self.config.small_model_path
        if model_path.exists():
            self._llm = Llama(
                model_path=str(model_path),
                n_ctx=self.config.context_length,
                n_gpu_layers=self.config.gpu_layers,
                verbose=False,
            )
        else:
            # Try to download or raise error
            raise FileNotFoundError(
                f"Model not found at {model_path}. "
                f"Download a GGUF model to {self.config.models_dir}"
            )

        self._initialized = True

    async def generate_text(
        self,
        prompt: str,
        system_prompt: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        stop_sequences: list[str] | None = None,
    ) -> str:
        """Generate text using local model."""
        if not self._initialized:
            await self.initialize()

        if self._llm is None:
            raise RuntimeError("Model not initialized")

        temp = temperature if temperature is not None else self.config.temperature
        tokens = max_tokens if max_tokens is not None else self.config.max_tokens

        # Format as chat
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        response = self._llm.create_chat_completion(
            messages=messages,
            temperature=temp,
            max_tokens=tokens,
            stop=stop_sequences,
        )

        return response["choices"][0]["message"]["content"]

    async def generate_embedding(self, text: str) -> list[float]:
        """Generate embedding vector."""
        if not self._initialized:
            await self.initialize()

        if self._llm is None:
            raise RuntimeError("Model not initialized")

        # Use the model's embedding function if available
        # Otherwise use a simple hash-based embedding (for testing)
        try:
            embedding = self._llm.embed(text)
            return list(embedding)
        except (AttributeError, NotImplementedError):
            # Fallback: generate from model output
            # This is a placeholder - real implementation would use
            # a dedicated embedding model
            import hashlib

            hash_bytes = hashlib.sha384(text.encode()).digest()
            return [float(b) / 255.0 for b in hash_bytes]

    async def tokenize(self, text: str) -> list[int]:
        """Tokenize text."""
        if not self._initialized:
            await self.initialize()

        if self._llm is None:
            raise RuntimeError("Model not initialized")

        return self._llm.tokenize(text.encode())

    async def detokenize(self, tokens: list[int]) -> str:
        """Detokenize tokens."""
        if not self._initialized:
            await self.initialize()

        if self._llm is None:
            raise RuntimeError("Model not initialized")

        return self._llm.detokenize(tokens).decode()

    def get_model_info(self) -> dict:
        """Get information about loaded models."""
        return {
            "small_model": str(self.config.small_model_path),
            "small_model_exists": self.config.small_model_path.exists(),
            "large_model": str(self.config.large_model_path),
            "large_model_exists": self.config.large_model_path.exists(),
            "embedding_model": str(self.config.embedding_model_path),
            "embedding_model_exists": self.config.embedding_model_path.exists(),
            "initialized": self._initialized,
            "context_length": self.config.context_length,
            "gpu_layers": self.config.gpu_layers,
        }


class MockLocalAIProvider:
    """
    Mock provider for testing without actual models.
    
    Generates deterministic responses based on input hashing.
    """

    def __init__(self):
        self._initialized = True

    async def initialize(self) -> None:
        pass

    async def generate_text(
        self,
        prompt: str,
        system_prompt: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        stop_sequences: list[str] | None = None,
    ) -> str:
        """Generate mock response."""
        import hashlib

        # Generate deterministic response based on prompt
        prompt_hash = hashlib.md5(prompt.encode()).hexdigest()[:8]
        return f"Mock response for prompt hash {prompt_hash}"

    async def generate_embedding(self, text: str) -> list[float]:
        """Generate mock embedding."""
        import hashlib

        hash_bytes = hashlib.sha384(text.encode()).digest()
        return [float(b) / 255.0 for b in hash_bytes]


def get_recommended_model(available_memory_gb: float) -> str:
    """
    Get recommended model based on available memory.
    
    Based on plugin-local-ai's platform detection logic.
    """
    if available_memory_gb >= 16:
        return "Llama-3.2-3B-Instruct-Q4_K_M.gguf"
    elif available_memory_gb >= 8:
        return "Llama-3.2-1B-Instruct-Q4_K_M.gguf"
    else:
        return "Llama-3.2-1B-Instruct-Q4_K_S.gguf"  # Smaller quantization


async def download_model(
    model_name: str,
    models_dir: str | Path = "~/.eliza/models",
) -> Path:
    """
    Download a model from HuggingFace.
    
    Mirrors plugin-local-ai's download functionality.
    """
    from huggingface_hub import hf_hub_download

    models_dir = Path(models_dir).expanduser()
    models_dir.mkdir(parents=True, exist_ok=True)

    # Map common names to HuggingFace paths
    model_map = {
        "Llama-3.2-1B-Instruct-Q4_K_M.gguf": (
            "hugging-quants/Llama-3.2-1B-Instruct-Q4_K_M-GGUF",
            "llama-3.2-1b-instruct-q4_k_m.gguf",
        ),
        "Llama-3.2-3B-Instruct-Q4_K_M.gguf": (
            "hugging-quants/Llama-3.2-3B-Instruct-Q4_K_M-GGUF",
            "llama-3.2-3b-instruct-q4_k_m.gguf",
        ),
    }

    if model_name in model_map:
        repo_id, filename = model_map[model_name]
        local_path = hf_hub_download(
            repo_id=repo_id,
            filename=filename,
            local_dir=models_dir,
        )
        return Path(local_path)

    raise ValueError(f"Unknown model: {model_name}")
