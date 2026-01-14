from dataclasses import dataclass, field


@dataclass
class ModelSpec:
    name: str
    repo: str
    size: str
    quantization: str
    context_size: int
    tokenizer_name: str
    tokenizer_type: str


@dataclass
class EmbeddingModelSpec(ModelSpec):
    dimensions: int = 384


@dataclass
class LocalAIConfig:
    models_dir: str | None = None
    cache_dir: str | None = None
    small_model: str = "DeepHermes-3-Llama-3-3B-Preview-q4.gguf"
    large_model: str = "DeepHermes-3-Llama-3-8B-q4.gguf"
    embedding_model: str = "bge-small-en-v1.5.Q4_K_M.gguf"
    embedding_dimensions: int = 384
    gpu_layers: int = 0
    context_size: int = 8192


@dataclass
class TextGenerationParams:
    prompt: str
    max_tokens: int = 8192
    temperature: float = 0.7
    top_p: float = 0.9
    stop_sequences: list[str] = field(default_factory=list)
    use_large_model: bool = False


@dataclass
class TextGenerationResult:
    text: str
    tokens_used: int
    model: str


@dataclass
class EmbeddingParams:
    text: str


@dataclass
class EmbeddingResult:
    embedding: list[float]
    dimensions: int
    model: str


@dataclass
class TranscriptionParams:
    audio_data: bytes
    language: str = "en"


@dataclass
class TranscriptionResult:
    text: str
    language: str
