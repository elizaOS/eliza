"""Expected-response encoders for ElizaRecord generation.

Native v5 training exports are JSON documents. The legacy TOON encoder remains
available only for compatibility corpus rebuilds that explicitly opt in.
"""

from __future__ import annotations

import json
from typing import Any, Protocol


class ExpectedResponseEncoder(Protocol):
    def encode(self, value: Any) -> str: ...

    def close(self) -> None: ...


class JsonExpectedResponseEncoder:
    """Encode supervised targets as compact JSON for native tool calling."""

    def encode(self, value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    def close(self) -> None:
        return None


def make_expected_response_encoder(fmt: str = "json") -> ExpectedResponseEncoder:
    normalized = fmt.strip().lower().replace("_", "-")
    if normalized in {"json", "native-json"}:
        return JsonExpectedResponseEncoder()
    if normalized in {"legacy-toon", "toon"}:
        from .toon import ToonEncoder

        return ToonEncoder()
    raise ValueError(f"unsupported expected response format: {fmt}")
