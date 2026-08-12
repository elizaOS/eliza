#!/usr/bin/env python3
"""Rejects offline corpus translation while no safe backend is supported.

The previously generated multilingual rows remain part of the published
training corpus and are cataloged by the ``translated-*`` tasks in
``datasets.yaml``. This boundary performs no imports, network access, or file
writes so an unsupported regeneration attempt fails before creating artifacts.
"""

from __future__ import annotations

import sys


UNSUPPORTED_MESSAGE = (
    "Offline corpus translation is currently unsupported: the previous backend "
    "requires an advisory-affected dependency with no safe compatible release. "
    "Use the existing pre-generated translated-* rows cataloged in datasets.yaml "
    "(published under data/synthesized/translated/) while translation remains "
    "disabled pending a safe backend."
)


def main() -> int:
    """Report the disabled workflow without importing or writing anything."""
    print(UNSUPPORTED_MESSAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
