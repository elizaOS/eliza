from __future__ import annotations


def main() -> int:
    from .cli import main as _main

    return _main()

__all__ = ["main"]
