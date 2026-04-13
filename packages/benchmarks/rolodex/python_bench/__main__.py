"""Allow running the benchmark as ``python -m benchmarks.rolodex.python_bench``."""

from .run import main
import asyncio

asyncio.run(main())
