"""
CLI entry point for the elizaos-app dynamic loader.

Delegates all commands to the elizaOS App Node.js runtime,
installing it automatically if needed.
"""

from __future__ import annotations

import sys

from elizaos_app.loader import ElizaOSAppError, run


def main() -> None:
    """Main CLI entry point — forwards all args to the Node.js elizaos-app CLI."""
    try:
        args = sys.argv[1:]
        exit_code = run(args)
        sys.exit(exit_code)
    except ElizaOSAppError as exc:
        print(f"elizaos-app: {exc}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
