"""Entry point for running SWE-bench as a module."""

import asyncio
from .cli import main

if __name__ == "__main__":
    asyncio.run(main())
