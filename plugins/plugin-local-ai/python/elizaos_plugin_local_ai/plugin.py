import os
from pathlib import Path

from elizaos_plugin_local_ai.types import (
    EmbeddingParams,
    EmbeddingResult,
    LocalAIConfig,
    TextGenerationParams,
    TextGenerationResult,
    TranscriptionParams,
    TranscriptionResult,
)


class LocalAIPlugin:
    def __init__(self, config: LocalAIConfig) -> None:
        self.config = config
        self._small_model: object | None = None
        self._large_model: object | None = None
        self._embedding_model: object | None = None
        self._initialized = False

        home = Path.home()
        self.models_dir = (
            Path(config.models_dir) if config.models_dir else home / ".eliza" / "models"
        )
        self.cache_dir = Path(config.cache_dir) if config.cache_dir else home / ".eliza" / "cache"

        self.models_dir.mkdir(parents=True, exist_ok=True)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _get_small_model(self) -> object:
        if self._small_model is None:
            try:
                from llama_cpp import Llama

                model_path = self.models_dir / self.config.small_model
                if not model_path.exists():
                    raise FileNotFoundError(
                        f"Small model not found at {model_path}. Please download the model first."
                    )

                self._small_model = Llama(
                    model_path=str(model_path),
                    n_ctx=self.config.context_size,
                    n_gpu_layers=self.config.gpu_layers,
                    verbose=False,
                )
            except ImportError as e:
                raise ImportError(
                    "llama-cpp-python is required for local AI. "
                    "Install with: pip install llama-cpp-python"
                ) from e

        return self._small_model

    def _get_large_model(self) -> object:
        if self._large_model is None:
            try:
                from llama_cpp import Llama

                model_path = self.models_dir / self.config.large_model
                if not model_path.exists():
                    raise FileNotFoundError(
                        f"Large model not found at {model_path}. Please download the model first."
                    )

                self._large_model = Llama(
                    model_path=str(model_path),
                    n_ctx=self.config.context_size,
                    n_gpu_layers=self.config.gpu_layers,
                    verbose=False,
                )
            except ImportError as e:
                raise ImportError(
                    "llama-cpp-python is required for local AI. "
                    "Install with: pip install llama-cpp-python"
                ) from e

        return self._large_model

    def _get_embedding_model(self) -> object:
        if self._embedding_model is None:
            try:
                from llama_cpp import Llama

                model_path = self.models_dir / self.config.embedding_model
                if not model_path.exists():
                    raise FileNotFoundError(
                        f"Embedding model not found at {model_path}. "
                        "Please download the model first."
                    )

                self._embedding_model = Llama(
                    model_path=str(model_path),
                    n_ctx=512,
                    n_gpu_layers=0,
                    embedding=True,
                    verbose=False,
                )
            except ImportError as e:
                raise ImportError(
                    "llama-cpp-python is required for local AI. "
                    "Install with: pip install llama-cpp-python"
                ) from e

        return self._embedding_model

    def generate_text(self, params: TextGenerationParams) -> TextGenerationResult:
        model = self._get_large_model() if params.use_large_model else self._get_small_model()
        model_name = self.config.large_model if params.use_large_model else self.config.small_model

        from llama_cpp import Llama

        assert isinstance(model, Llama)

        response = model(
            params.prompt,
            max_tokens=params.max_tokens,
            temperature=params.temperature,
            top_p=params.top_p,
            stop=params.stop_sequences if params.stop_sequences else None,
        )

        text = response["choices"][0]["text"]
        tokens_used = response["usage"]["total_tokens"]

        return TextGenerationResult(
            text=text,
            tokens_used=tokens_used,
            model=model_name,
        )

    def create_embedding(self, params: EmbeddingParams) -> EmbeddingResult:
        model = self._get_embedding_model()

        from llama_cpp import Llama

        assert isinstance(model, Llama)

        embedding = model.embed(params.text)

        import numpy as np

        embedding_array = np.array(embedding)
        norm = np.linalg.norm(embedding_array)
        if norm > 0:
            embedding_array = embedding_array / norm

        return EmbeddingResult(
            embedding=embedding_array.tolist(),
            dimensions=len(embedding_array),
            model=self.config.embedding_model,
        )

    def transcribe_audio(self, params: TranscriptionParams) -> TranscriptionResult:
        try:
            import tempfile

            import whisper

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(params.audio_data)
                temp_path = f.name

            try:
                model = whisper.load_model("tiny")
                result = model.transcribe(temp_path, language=params.language)

                return TranscriptionResult(
                    text=result["text"],
                    language=params.language,
                )
            finally:
                os.unlink(temp_path)

        except ImportError as e:
            raise ImportError(
                "openai-whisper is required for transcription. "
                "Install with: pip install openai-whisper"
            ) from e


def get_local_ai_plugin() -> LocalAIPlugin:
    config = LocalAIConfig(
        models_dir=os.environ.get("MODELS_DIR"),
        cache_dir=os.environ.get("CACHE_DIR"),
        small_model=os.environ.get("LOCAL_SMALL_MODEL", "DeepHermes-3-Llama-3-3B-Preview-q4.gguf"),
        large_model=os.environ.get("LOCAL_LARGE_MODEL", "DeepHermes-3-Llama-3-8B-q4.gguf"),
        embedding_model=os.environ.get("LOCAL_EMBEDDING_MODEL", "bge-small-en-v1.5.Q4_K_M.gguf"),
        embedding_dimensions=int(os.environ.get("LOCAL_EMBEDDING_DIMENSIONS", "384")),
    )

    return LocalAIPlugin(config)


def create_plugin(config: LocalAIConfig | None = None) -> LocalAIPlugin:
    if config is None:
        return get_local_ai_plugin()
    return LocalAIPlugin(config)
