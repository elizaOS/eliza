---
name: parallel-processing
description: Parallel processing with joblib for grid search and batch computations. Use when speeding up computationally intensive tasks across multiple CPU cores.
---

# Parallel Processing with joblib

Speed up computationally intensive tasks by distributing work across multiple CPU cores.

## Basic Usage

```python
from joblib import Parallel, delayed

def process_item(x):
    """Process a single item."""
    return x ** 2

# Sequential
results = [process_item(x) for x in range(100)]

# Parallel (uses all available cores)
results = Parallel(n_jobs=-1)(
    delayed(process_item)(x) for x in range(100)
)
```

## Key Parameters

- **n_jobs**: `-1` for all cores, `1` for sequential, or specific number
- **verbose**: `0` (silent), `10` (progress), `50` (detailed)
- **backend**: `'loky'` (CPU-bound, default) or `'threading'` (I/O-bound)

## Grid Search Example

```python
from joblib import Parallel, delayed
from itertools import product

def evaluate_params(param_a, param_b):
    """Evaluate one parameter combination."""
    score = expensive_computation(param_a, param_b)
    return {'param_a': param_a, 'param_b': param_b, 'score': score}

# Define parameter grid
params = list(product([0.1, 0.5, 1.0], [10, 20, 30]))

# Parallel grid search
results = Parallel(n_jobs=-1, verbose=10)(
    delayed(evaluate_params)(a, b) for a, b in params
)

# Filter results
results = [r for r in results if r is not None]
best = max(results, key=lambda x: x['score'])
```

## Pre-computing Shared Data

When all tasks need the same data, pre-compute it once:

```python
# Pre-compute once
shared_data = load_data()

def process_with_shared(params, data):
    return compute(params, data)

# Pass shared data to each task
results = Parallel(n_jobs=-1)(
    delayed(process_with_shared)(p, shared_data)
    for p in param_list
)
```

## Performance Tips

- Only worth it for tasks taking >0.1s per item (overhead cost)
- Watch memory usage - each worker gets a copy of data
- Use `verbose=10` to monitor progress
