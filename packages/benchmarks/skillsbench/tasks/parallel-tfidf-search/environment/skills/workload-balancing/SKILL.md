---
name: workload-balancing
description: Optimize workload distribution across workers, processes, or nodes for efficient parallel execution. Use when asked to balance work distribution, improve parallel efficiency, reduce stragglers, implement load balancing, or optimize task scheduling. Covers static/dynamic partitioning, work stealing, and adaptive load balancing strategies.
---

# Workload Balancing Skill

Distribute work efficiently across parallel workers to maximize throughput and minimize completion time.

## Workflow

1. **Characterize** the workload (uniform vs. variable task times)
2. **Identify** bottlenecks (stragglers, uneven distribution)
3. **Select** balancing strategy based on workload characteristics
4. **Implement** partitioning and scheduling logic
5. **Monitor** and adapt to runtime conditions

## Load Balancing Decision Tree

```
What's the workload characteristic?

Uniform task times:
├── Known count → Static partitioning (equal chunks)
├── Streaming input → Round-robin distribution
└── Large items → Size-aware partitioning

Variable task times:
├── Predictable variance → Weighted distribution
├── Unpredictable → Dynamic scheduling / work stealing
└── Long-tail distribution → Work stealing + time limits

Resource constraints:
├── Memory-bound workers → Memory-aware assignment
├── Heterogeneous workers → Capability-based routing
└── Network costs → Locality-aware placement
```

## Balancing Strategies

### Strategy 1: Static Chunking (Uniform Workloads)

Best for: predictable, similar-sized tasks

```python
from concurrent.futures import ProcessPoolExecutor
import numpy as np

def static_balanced_process(items, num_workers=4):
    """Divide work into equal chunks upfront."""
    chunks = np.array_split(items, num_workers)

    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        results = list(executor.map(process_chunk, chunks))

    return [item for chunk_result in results for item in chunk_result]
```

### Strategy 2: Dynamic Task Queue (Variable Workloads)

Best for: unpredictable task durations

```python
from concurrent.futures import ProcessPoolExecutor, as_completed
from queue import Queue

def dynamic_balanced_process(items, num_workers=4):
    """Workers pull tasks dynamically as they complete."""
    results = []

    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        # Submit one task per worker initially
        futures = {executor.submit(process_item, item): item
                   for item in items[:num_workers]}
        pending = list(items[num_workers:])

        while futures:
            done, _ = wait(futures, return_when=FIRST_COMPLETED)

            for future in done:
                results.append(future.result())
                del futures[future]

                # Submit next task if available
                if pending:
                    next_item = pending.pop(0)
                    futures[executor.submit(process_item, next_item)] = next_item

    return results
```

### Strategy 3: Work Stealing (Long-Tail Tasks)

Best for: when some tasks take much longer than others

```python
import asyncio
from collections import deque

class WorkStealingPool:
    def __init__(self, num_workers):
        self.queues = [deque() for _ in range(num_workers)]
        self.num_workers = num_workers

    def distribute(self, items):
        """Initial round-robin distribution."""
        for i, item in enumerate(items):
            self.queues[i % self.num_workers].append(item)

    async def worker(self, worker_id, process_fn):
        """Process own queue, steal from others when empty."""
        while True:
            # Try own queue first
            if self.queues[worker_id]:
                item = self.queues[worker_id].popleft()
            else:
                # Steal from busiest queue
                item = self._steal_work(worker_id)
                if item is None:
                    break

            await process_fn(item)

    def _steal_work(self, worker_id):
        """Steal from the queue with most items."""
        busiest = max(range(self.num_workers),
                      key=lambda i: len(self.queues[i]) if i != worker_id else 0)
        if self.queues[busiest]:
            return self.queues[busiest].pop()  # Steal from end
        return None
```

### Strategy 4: Weighted Distribution

Best for: when task costs are known or estimable

```python
def weighted_partition(items, weights, num_workers):
    """Partition items to balance total weight per worker."""
    # Sort by weight descending (largest first fit)
    sorted_items = sorted(zip(items, weights), key=lambda x: -x[1])

    worker_loads = [0] * num_workers
    worker_items = [[] for _ in range(num_workers)]

    for item, weight in sorted_items:
        # Assign to least loaded worker
        min_worker = min(range(num_workers), key=lambda i: worker_loads[i])
        worker_items[min_worker].append(item)
        worker_loads[min_worker] += weight

    return worker_items
```

### Strategy 5: Async Semaphore Balancing (I/O Workloads)

Best for: limiting concurrent I/O operations

```python
import asyncio

async def semaphore_balanced_fetch(urls, max_concurrent=10):
    """Limit concurrent operations while processing queue."""
    semaphore = asyncio.Semaphore(max_concurrent)

    async def bounded_fetch(url):
        async with semaphore:
            return await fetch(url)

    return await asyncio.gather(*[bounded_fetch(url) for url in urls])
```

## Partitioning Strategies

| Strategy | Best For | Implementation |
|----------|----------|----------------|
| Equal chunks | Uniform tasks | `np.array_split(items, n)` |
| Round-robin | Streaming | `items[i::n_workers]` |
| Size-weighted | Known sizes | Bin packing algorithm |
| Hash-based | Consistent routing | `hash(key) % n_workers` |
| Range-based | Sorted/ordered data | Contiguous ranges |

## Handling Stragglers

Techniques to mitigate slow workers:

```python
# 1. Timeout with fallback
from concurrent.futures import TimeoutError

try:
    result = future.result(timeout=30)
except TimeoutError:
    result = fallback_value

# 2. Speculative execution (backup tasks)
async def speculative_execute(task, timeout=10):
    primary = asyncio.create_task(execute(task))
    try:
        return await asyncio.wait_for(primary, timeout)
    except asyncio.TimeoutError:
        backup = asyncio.create_task(execute(task))  # Retry
        done, pending = await asyncio.wait(
            [primary, backup], return_when=asyncio.FIRST_COMPLETED
        )
        for p in pending:
            p.cancel()
        return done.pop().result()

# 3. Dynamic rebalancing
def rebalance_on_straggler(futures, threshold_ratio=2.0):
    """Redistribute work if one worker falls behind."""
    avg_completion = statistics.mean(completion_times)
    for future, worker_id in futures.items():
        if future.running() and elapsed(future) > threshold_ratio * avg_completion:
            # Cancel and redistribute
            remaining_work = cancel_and_get_remaining(future)
            redistribute(remaining_work, fast_workers)
```

## Monitoring Metrics

Track these for balanced execution:

| Metric | Calculation | Target |
|--------|-------------|--------|
| Load imbalance | `max(load) / avg(load)` | < 1.2 |
| Straggler ratio | `max(time) / median(time)` | < 2.0 |
| Worker utilization | `busy_time / total_time` | > 90% |
| Queue depth variance | `std(queue_lengths)` | Low |

## Anti-Patterns

| Problem | Cause | Fix |
|---------|-------|-----|
| Starvation | Large tasks block queue | Break into subtasks |
| Thundering herd | All workers wake at once | Jittered scheduling |
| Hot spots | Uneven key distribution | Better hash function |
| Convoy effect | Workers wait on same resource | Fine-grained locking |
| Over-partitioning | Too many small tasks | Batch small items |

## Verification Checklist

Before finalizing balanced code:

- [ ] Work distribution is roughly even (measure completion times)
- [ ] No starvation (all workers stay busy)
- [ ] Stragglers are handled (timeout/retry logic)
- [ ] Overhead is acceptable (partitioning cost vs. task cost)
- [ ] Results are complete and correct
- [ ] Resource utilization is high across workers
