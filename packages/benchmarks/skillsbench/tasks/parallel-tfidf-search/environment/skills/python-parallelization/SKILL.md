---
name: python-parallelization
description: Transform sequential Python code into parallel/concurrent implementations. Use when asked to parallelize Python code, improve code performance through concurrency, convert loops to parallel execution, or identify parallelization opportunities. Handles CPU-bound (multiprocessing), I/O-bound (asyncio, threading), and data-parallel (vectorization) scenarios.
---

# Python Parallelization Skill

Transform sequential Python code to leverage parallel and concurrent execution patterns.

## Workflow

1. **Analyze** the code to identify parallelization candidates
2. **Classify** the workload type (CPU-bound, I/O-bound, or data-parallel)
3. **Select** the appropriate parallelization strategy
4. **Transform** the code with proper synchronization and error handling
5. **Verify** correctness and measure expected speedup

## Parallelization Decision Tree

```
Is the bottleneck CPU-bound or I/O-bound?

CPU-bound (computation-heavy):
├── Independent iterations? → multiprocessing.Pool / ProcessPoolExecutor
├── Shared state needed? → multiprocessing with Manager or shared memory
├── NumPy/Pandas operations? → Vectorization first, then consider numba/dask
└── Large data chunks? → chunked processing with Pool.map

I/O-bound (network, disk, database):
├── Many independent requests? → asyncio with aiohttp/aiofiles
├── Legacy sync code? → ThreadPoolExecutor
├── Mixed sync/async? → asyncio.to_thread()
└── Database queries? → Connection pooling + async drivers

Data-parallel (array/matrix ops):
├── NumPy arrays? → Vectorize, avoid Python loops
├── Pandas DataFrames? → Use built-in vectorized methods
├── Large datasets? → Dask for out-of-core parallelism
└── GPU available? → Consider CuPy or JAX
```

## Transformation Patterns

### Pattern 1: Loop to ProcessPoolExecutor (CPU-bound)

**Before:**
```python
results = []
for item in items:
    results.append(expensive_computation(item))
```

**After:**
```python
from concurrent.futures import ProcessPoolExecutor

with ProcessPoolExecutor() as executor:
    results = list(executor.map(expensive_computation, items))
```

### Pattern 2: Sequential I/O to Async (I/O-bound)

**Before:**
```python
import requests

def fetch_all(urls):
    return [requests.get(url).json() for url in urls]
```

**After:**
```python
import asyncio
import aiohttp

async def fetch_all(urls):
    async with aiohttp.ClientSession() as session:
        tasks = [fetch_one(session, url) for url in urls]
        return await asyncio.gather(*tasks)

async def fetch_one(session, url):
    async with session.get(url) as response:
        return await response.json()
```

### Pattern 3: Nested Loops to Vectorization

**Before:**
```python
result = []
for i in range(len(a)):
    row = []
    for j in range(len(b)):
        row.append(a[i] * b[j])
    result.append(row)
```

**After:**
```python
import numpy as np
result = np.outer(a, b)
```

### Pattern 4: Mixed CPU/IO with asyncio

```python
import asyncio
from concurrent.futures import ProcessPoolExecutor

async def hybrid_pipeline(data, urls):
    loop = asyncio.get_event_loop()

    # CPU-bound in process pool
    with ProcessPoolExecutor() as pool:
        processed = await loop.run_in_executor(pool, cpu_heavy_fn, data)

    # I/O-bound with async
    results = await asyncio.gather(*[fetch(url) for url in urls])

    return processed, results
```

## Parallelization Candidates

Look for these patterns in code:

| Pattern | Indicator | Strategy |
|---------|-----------|----------|
| `for item in collection` with independent iterations | No shared mutation | `Pool.map` / `executor.map` |
| Multiple `requests.get()` or file reads | Sequential I/O | `asyncio.gather()` |
| Nested loops over arrays | Numerical computation | NumPy vectorization |
| `time.sleep()` or blocking waits | Waiting on external | Threading or async |
| Large list comprehensions | Independent transforms | `Pool.map` with chunking |

## Safety Requirements

Always preserve correctness when parallelizing:

1. **Identify shared state** - variables modified across iterations break parallelism
2. **Check dependencies** - iteration N depending on N-1 requires sequential execution
3. **Handle exceptions** - wrap parallel code in try/except, use `executor.submit()` for granular error handling
4. **Manage resources** - use context managers, limit worker count to avoid exhaustion
5. **Preserve ordering** - use `map()` over `submit()` when order matters

## Common Pitfalls

- **GIL trap**: Threading doesn't help CPU-bound Python code—use multiprocessing
- **Pickle failures**: Lambda functions and nested classes can't be pickled for multiprocessing
- **Memory explosion**: ProcessPoolExecutor copies data to each process—use shared memory for large data
- **Async in sync**: Can't just add `async` to existing code—requires restructuring call chain
- **Over-parallelization**: Parallel overhead exceeds gains for small workloads (<1000 items typically)

## Verification Checklist

Before finalizing transformed code:

- [ ] Output matches sequential version for test inputs
- [ ] No race conditions (shared mutable state properly synchronized)
- [ ] Exceptions are caught and handled appropriately
- [ ] Resources are properly cleaned up (pools closed, connections released)
- [ ] Worker count is bounded (default or explicit limit)
- [ ] Added appropriate imports
