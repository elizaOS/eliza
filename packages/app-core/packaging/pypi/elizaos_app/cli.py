"""Console entry point for the elizaOS App launcher."""

from __future__ import annotations

import sys
from collections.abc import Sequence

from .loader import ElizaOSAppError, run


def main(argv: Sequence[str] | None = None) -> int:
    """Run the npm-backed elizaOS App command."""
    try:
        return run(argv)
    except ElizaOSAppError as error:
        print(f"elizaos-app: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
