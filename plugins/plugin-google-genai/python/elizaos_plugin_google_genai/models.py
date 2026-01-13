from __future__ import annotations

from enum import Enum
from typing import Final

from elizaos_plugin_google_genai.errors import InvalidParameterError


class ModelSize(Enum):
    SMALL = "small"
    LARGE = "large"
    EMBEDDING = "embedding"


class Model:
    GEMINI_2_0_FLASH: Final[str] = "gemini-2.0-flash-001"
    GEMINI_2_5_PRO: Final[str] = "gemini-2.5-pro-preview-03-25"
    GEMINI_2_5_PRO_EXP: Final[str] = "gemini-2.5-pro-exp-03-25"
    TEXT_EMBEDDING_004: Final[str] = "text-embedding-004"

    _id: str
    _size: ModelSize
    _default_max_tokens: int

    def __init__(self, model_id: str) -> None:
        if not model_id or not model_id.strip():
            raise InvalidParameterError("model", "Model ID cannot be empty")

        self._id = model_id
        self._size = self._infer_size(model_id)
        self._default_max_tokens = self._infer_max_tokens(model_id)

    @classmethod
    def small(cls) -> Model:
        return cls(cls.GEMINI_2_0_FLASH)

    @classmethod
    def large(cls) -> Model:
        return cls(cls.GEMINI_2_5_PRO)

    @classmethod
    def embedding(cls) -> Model:
        return cls(cls.TEXT_EMBEDDING_004)

    @property
    def id(self) -> str:
        return self._id

    @property
    def size(self) -> ModelSize:
        return self._size

    @property
    def default_max_tokens(self) -> int:
        return self._default_max_tokens

    def is_small(self) -> bool:
        return self._size == ModelSize.SMALL

    def is_large(self) -> bool:
        return self._size == ModelSize.LARGE

    def is_embedding(self) -> bool:
        return self._size == ModelSize.EMBEDDING

    @staticmethod
    def _infer_size(model_id: str) -> ModelSize:
        model_lower = model_id.lower()
        if "embedding" in model_lower:
            return ModelSize.EMBEDDING
        if "flash" in model_lower:
            return ModelSize.SMALL
        return ModelSize.LARGE

    @staticmethod
    def _infer_max_tokens(model_id: str) -> int:
        model_lower = model_id.lower()
        if "embedding" in model_lower:
            return 0
        return 8192

    def __str__(self) -> str:
        return self._id

    def __repr__(self) -> str:
        return f"Model(id={self._id!r}, size={self._size.value})"

    def __eq__(self, other: object) -> bool:
        if isinstance(other, Model):
            return self._id == other._id
        return False

    def __hash__(self) -> int:
        return hash(self._id)
