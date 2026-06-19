"""Benchmark stdout parsers.

Each module exposes parse(text) -> dict matching the primary-metric block
in docs/benchmarks/report-schema.yaml. Parsers raise ParseError when the
required primary metric is missing or malformed.
"""

from __future__ import annotations


class ParseError(ValueError):
    """Raised when a parser cannot extract its required primary metric."""


__all__ = ["ParseError"]
