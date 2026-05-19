"""Text encoder for the meta-policy — sentence embeddings.

Primary: ``sentence-transformers/all-MiniLM-L6-v2`` (384-dim, ~90 MB).
Fallback: deterministic bag-of-words hash embedding (no dependencies).
"""

from __future__ import annotations

import hashlib
from typing import Any

import numpy as np

EMBEDDING_DIM = 384


class BagOfWordsEncoder:
    """Deterministic bag-of-words hash embedding (no external dependencies).

    Produces a ``dim``-vector by hashing each word and accumulating into
    fixed-size bins. Useful as a fallback when sentence-transformers is
    not installed.
    """

    def __init__(self, dim: int = EMBEDDING_DIM) -> None:
        self.dim = dim

    def encode(self, texts: list[str]) -> np.ndarray:
        """Encode a batch of texts into ``(N, dim)`` float32 array."""
        result = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, text in enumerate(texts):
            words = text.lower().split()
            for word in words:
                h = hashlib.md5(word.encode()).digest()
                for j in range(0, min(len(h), self.dim), 1):
                    idx = h[j % len(h)] % self.dim
                    val = (h[(j + 1) % len(h)] / 255.0) * 2 - 1  # [-1, 1]
                    result[i, idx] += val
            norm = np.linalg.norm(result[i])
            if norm > 1e-8:
                result[i] /= norm
        return result


class SentenceTransformerEncoder:
    """Wrapper around sentence-transformers for 384-dim embeddings."""

    def __init__(self, model_name: str = "all-MiniLM-L6-v2") -> None:
        from sentence_transformers import SentenceTransformer
        self._model = SentenceTransformer(model_name)
        self.dim = self._model.get_sentence_embedding_dimension()

    def encode(self, texts: list[str]) -> np.ndarray:
        return self._model.encode(texts, convert_to_numpy=True)


class TextEncoder:
    """Auto-selecting text encoder.

    Tries sentence-transformers first, falls back to bag-of-words hash.
    """

    def __init__(self, prefer_transformer: bool = True) -> None:
        self._encoder: Any = None
        self.dim = EMBEDDING_DIM

        if prefer_transformer:
            try:
                self._encoder = SentenceTransformerEncoder()
                self.dim = self._encoder.dim
                return
            except Exception:  # noqa: BLE001 — fall back to BoW deliberately
                pass

        self._encoder = BagOfWordsEncoder(dim=EMBEDDING_DIM)

    def encode(self, texts: list[str]) -> np.ndarray:
        return self._encoder.encode(texts)

    def encode_single(self, text: str) -> np.ndarray:
        return self.encode([text])[0]

    @property
    def uses_transformer(self) -> bool:
        return isinstance(self._encoder, SentenceTransformerEncoder)
