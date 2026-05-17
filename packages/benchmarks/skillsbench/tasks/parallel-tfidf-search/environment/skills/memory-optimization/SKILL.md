---
name: memory-optimization
description: Optimize Python code for reduced memory usage and improved memory efficiency. Use when asked to reduce memory footprint, fix memory leaks, optimize data structures for memory, handle large datasets efficiently, or diagnose memory issues. Covers object sizing, generator patterns, efficient data structures, and memory profiling strategies.
---

# Memory Optimization Skill

Transform Python code to minimize memory usage while maintaining functionality.

## Workflow

1. **Profile** to identify memory bottlenecks (largest allocations, leak patterns)
2. **Analyze** data structures and object lifecycles
3. **Select** optimization strategies based on access patterns
4. **Transform** code with memory-efficient alternatives
5. **Verify** memory reduction without correctness loss

## Memory Optimization Decision Tree

```
What's consuming memory?

Large collections:
├── List of objects → __slots__, namedtuple, or dataclass(slots=True)
├── List built all at once → Generator/iterator pattern
├── Storing strings → String interning, categorical encoding
└── Numeric data → NumPy arrays instead of lists

Data processing:
├── Loading full file → Chunked reading, memory-mapped files
├── Intermediate copies → In-place operations, views
├── Keeping processed data → Process-and-discard pattern
└── DataFrame operations → Downcast dtypes, sparse arrays

Object lifecycle:
├── Objects never freed → Check circular refs, use weakref
├── Cache growing unbounded → LRU cache with maxsize
├── Global accumulation → Explicit cleanup, context managers
└── Large temporary objects → Delete explicitly, gc.collect()
```

## Transformation Patterns

### Pattern 1: Class to __slots__

Reduces per-instance memory by 40-60%:

**Before:**
```python
class Point:
    def __init__(self, x, y, z):
        self.x = x
        self.y = y
        self.z = z
```

**After:**
```python
class Point:
    __slots__ = ('x', 'y', 'z')

    def __init__(self, x, y, z):
        self.x = x
        self.y = y
        self.z = z
```

### Pattern 2: List to Generator

Avoid materializing entire sequences:

**Before:**
```python
def get_all_records(files):
    records = []
    for f in files:
        records.extend(parse_file(f))
    return records

all_data = get_all_records(files)
for record in all_data:
    process(record)
```

**After:**
```python
def get_all_records(files):
    for f in files:
        yield from parse_file(f)

for record in get_all_records(files):
    process(record)
```

### Pattern 3: Downcast Numeric Types

Reduce NumPy/Pandas memory by 2-8x:

**Before:**
```python
df = pd.read_csv('data.csv')  # Default int64, float64
```

**After:**
```python
def optimize_dtypes(df):
    for col in df.select_dtypes(include=['int']):
        df[col] = pd.to_numeric(df[col], downcast='integer')
    for col in df.select_dtypes(include=['float']):
        df[col] = pd.to_numeric(df[col], downcast='float')
    return df

df = optimize_dtypes(pd.read_csv('data.csv'))
```

### Pattern 4: String Deduplication

For repeated strings:

**Before:**
```python
records = [{'status': 'active', 'type': 'user'} for _ in range(1000000)]
```

**After:**
```python
import sys

STATUS_ACTIVE = sys.intern('active')
TYPE_USER = sys.intern('user')

records = [{'status': STATUS_ACTIVE, 'type': TYPE_USER} for _ in range(1000000)]
```

Or with Pandas:
```python
df['status'] = df['status'].astype('category')
```

### Pattern 5: Memory-Mapped File Processing

Process files larger than RAM:

```python
import mmap
import numpy as np

# For binary data
with open('large_file.bin', 'rb') as f:
    mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    # Process chunks without loading entire file

# For NumPy arrays
arr = np.memmap('large_array.dat', dtype='float32', mode='r', shape=(1000000, 100))
```

### Pattern 6: Chunked DataFrame Processing

```python
def process_large_csv(filepath, chunksize=10000):
    results = []
    for chunk in pd.read_csv(filepath, chunksize=chunksize):
        result = process_chunk(chunk)
        results.append(result)
        del chunk  # Explicit cleanup
    return pd.concat(results)
```

## Data Structure Memory Comparison

| Structure | Memory per item | Use case |
|-----------|----------------|----------|
| `list` of `dict` | ~400+ bytes | Flexible, small datasets |
| `list` of `class` | ~300 bytes | Object-oriented, small |
| `list` of `__slots__` class | ~120 bytes | Many similar objects |
| `namedtuple` | ~80 bytes | Immutable records |
| `numpy.ndarray` | 8 bytes (float64) | Numeric, vectorized ops |
| `pandas.DataFrame` | ~10-50 bytes/cell | Tabular, analysis |

## Memory Leak Detection

Common leak patterns and fixes:

| Pattern | Cause | Fix |
|---------|-------|-----|
| Growing cache | No eviction policy | `@lru_cache(maxsize=1000)` |
| Event listeners | Not unregistered | Weak references or explicit removal |
| Circular references | Objects reference each other | `weakref`, break cycles |
| Global lists | Append without cleanup | Bounded deque, periodic clear |
| Closures | Capture large objects | Capture only needed values |

## Profiling Commands

```python
# Object size
import sys
sys.getsizeof(obj)  # Shallow size only

# Deep size with pympler
from pympler import asizeof
asizeof.asizeof(obj)  # Includes referenced objects

# Memory profiler decorator
from memory_profiler import profile
@profile
def my_function():
    pass

# Tracemalloc for allocation tracking
import tracemalloc
tracemalloc.start()
# ... code ...
snapshot = tracemalloc.take_snapshot()
top_stats = snapshot.statistics('lineno')
```

## Verification Checklist

Before finalizing optimized code:

- [ ] Memory usage reduced (measure with profiler)
- [ ] Functionality preserved (same outputs)
- [ ] No new memory leaks introduced
- [ ] Performance acceptable (generators may add iteration overhead)
- [ ] Code remains readable and maintainable
