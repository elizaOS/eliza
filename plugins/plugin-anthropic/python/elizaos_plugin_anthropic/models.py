from __future__ import annotations

from enum import Enum
from typing import Final

from elizaos_plugin_anthropic.errors import InvalidParameterError


class ModelSize(Enum):
    SMALL = "small"
    LARGE = "large"


class Model:
    CLAUDE_3_5_HAIKU: Final[str] = "claude-3-5-haiku-20241022"
    CLAUDE_3_HAIKU: Final[str] = "claude-3-haiku-20240307"
    CLAUDE_SONNET_4: Final[str] = "claude-sonnet-4-20250514"
    CLAUDE_3_5_SONNET: Final[str] = "claude-3-5-sonnet-20241022"
    CLAUDE_3_OPUS: Final[str] = "claude-3-opus-20240229"

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
        return cls(cls.CLAUDE_3_5_HAIKU)

    @classmethod
    def large(cls) -> Model:
        return cls(cls.CLAUDE_SONNET_4)

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

    def max_tokens(self) -> int:
        return self._default_max_tokens

    @staticmethod
    def _infer_size(model_id: str) -> ModelSize:
        if "haiku" in model_id.lower():
            return ModelSize.SMALL
        return ModelSize.LARGE

    @staticmethod
    def _infer_max_tokens(model_id: str) -> int:
        if "-3-" in model_id and "-3-5-" not in model_id:
            return 4096
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
