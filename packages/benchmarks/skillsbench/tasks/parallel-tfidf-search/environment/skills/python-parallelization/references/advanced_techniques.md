# Advanced Parallelization Techniques

## Shared Memory for Large Data

When passing large arrays between processes, avoid serialization overhead:

```python
import numpy as np
from multiprocessing import shared_memory, Pool

def create_shared_array(data):
    """Create a shared memory array from numpy data."""
    shm = shared_memory.SharedMemory(create=True, size=data.nbytes)
    shared_arr = np.ndarray(data.shape, dtype=data.dtype, buffer=shm.buf)
    shared_arr[:] = data[:]
    return shm, shared_arr

def worker_with_shared(args):
    """Worker that accesses shared memory."""
    shm_name, shape, dtype, chunk_start, chunk_end = args
    existing_shm = shared_memory.SharedMemory(name=shm_name)
    arr = np.ndarray(shape, dtype=dtype, buffer=existing_shm.buf)
    result = process_chunk(arr[chunk_start:chunk_end])
    existing_shm.close()
    return result
```

## Chunked Processing for Memory Efficiency

Process large datasets in chunks to control memory:

```python
from concurrent.futures import ProcessPoolExecutor
from itertools import islice

def chunked(iterable, size):
    """Yield successive chunks from iterable."""
    it = iter(iterable)
    while chunk := list(islice(it, size)):
        yield chunk

def process_large_dataset(items, chunk_size=1000, max_workers=4):
    results = []
    with ProcessPoolExecutor(max_workers=max_workers) as executor:
        for chunk in chunked(items, chunk_size):
            chunk_results = list(executor.map(process_item, chunk))
            results.extend(chunk_results)
    return results
```

## Progress Tracking with tqdm

```python
from concurrent.futures import ProcessPoolExecutor, as_completed
from tqdm import tqdm

def parallel_with_progress(items, process_fn, max_workers=4):
    results = []
    with ProcessPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(process_fn, item): item for item in items}
        for future in tqdm(as_completed(futures), total=len(futures)):
            results.append(future.result())
    return results
```

## Async Semaphore for Rate Limiting

```python
import asyncio
import aiohttp

async def rate_limited_fetch(urls, max_concurrent=10):
    semaphore = asyncio.Semaphore(max_concurrent)

    async def fetch_with_limit(session, url):
        async with semaphore:
            async with session.get(url) as response:
                return await response.json()

    async with aiohttp.ClientSession() as session:
        tasks = [fetch_with_limit(session, url) for url in urls]
        return await asyncio.gather(*tasks, return_exceptions=True)
```

## Async Queue Pattern for Producer-Consumer

```python
import asyncio

async def producer_consumer(items, num_workers=4):
    queue = asyncio.Queue()
    results = []

    async def producer():
        for item in items:
            await queue.put(item)
        for _ in range(num_workers):
            await queue.put(None)  # Poison pills

    async def consumer():
        while True:
            item = await queue.get()
            if item is None:
                break
            result = await process_async(item)
            results.append(result)
            queue.task_done()

    await asyncio.gather(
        producer(),
        *[consumer() for _ in range(num_workers)]
    )
    return results
```

## ThreadPoolExecutor for Blocking Libraries

Use when async alternatives don't exist:

```python
import asyncio
from concurrent.futures import ThreadPoolExecutor

async def async_wrapper_for_blocking(items):
    loop = asyncio.get_event_loop()
    with ThreadPoolExecutor(max_workers=10) as executor:
        tasks = [
            loop.run_in_executor(executor, blocking_library_call, item)
            for item in items
        ]
        return await asyncio.gather(*tasks)
```

## Numba JIT for CPU-Intensive Loops

When Python loops can't be easily vectorized:

```python
from numba import jit, prange
import numpy as np

@jit(nopython=True, parallel=True)
def parallel_computation(arr):
    result = np.zeros_like(arr)
    for i in prange(len(arr)):
        result[i] = expensive_math(arr[i])
    return result
```

## Dask for Out-of-Core Computation

For datasets larger than memory:

```python
import dask.dataframe as dd
import dask.array as da

# DataFrame operations
ddf = dd.read_csv('large_file_*.csv')
result = ddf.groupby('category').agg({'value': 'sum'}).compute()

# Array operations
arr = da.from_delayed([delayed_load(f) for f in files], shape=..., dtype=...)
result = arr.mean(axis=0).compute()
```

## Error Handling Patterns

### Graceful degradation with ProcessPoolExecutor:

```python
from concurrent.futures import ProcessPoolExecutor, as_completed

def robust_parallel_process(items, process_fn):
    results = []
    errors = []

    with ProcessPoolExecutor() as executor:
        future_to_item = {executor.submit(process_fn, item): item for item in items}

        for future in as_completed(future_to_item):
            item = future_to_item[future]
            try:
                results.append(future.result())
            except Exception as e:
                errors.append((item, str(e)))

    return results, errors
```

### Async error handling with return_exceptions:

```python
async def safe_gather(tasks):
    results = await asyncio.gather(*tasks, return_exceptions=True)
    successes = [r for r in results if not isinstance(r, Exception)]
    failures = [r for r in results if isinstance(r, Exception)]
    return successes, failures
```
