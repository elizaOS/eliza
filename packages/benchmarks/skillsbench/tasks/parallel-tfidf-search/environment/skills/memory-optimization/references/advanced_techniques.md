# Advanced Memory Patterns

## Object Pool Pattern

Reuse objects instead of creating new ones:

```python
class ObjectPool:
    def __init__(self, factory, max_size=100):
        self._factory = factory
        self._pool = []
        self._max_size = max_size

    def acquire(self):
        if self._pool:
            return self._pool.pop()
        return self._factory()

    def release(self, obj):
        if len(self._pool) < self._max_size:
            self._pool.append(obj)

# Usage
pool = ObjectPool(lambda: bytearray(1024))
buffer = pool.acquire()
# ... use buffer ...
pool.release(buffer)
```

## Weak Reference Caching

Cache without preventing garbage collection:

```python
import weakref

class WeakCache:
    def __init__(self):
        self._cache = weakref.WeakValueDictionary()

    def get_or_create(self, key, factory):
        obj = self._cache.get(key)
        if obj is None:
            obj = factory(key)
            self._cache[key] = obj
        return obj
```

## Copy-on-Write Pattern

Share data until modification:

```python
class COWList:
    def __init__(self, data=None):
        self._data = data if data is not None else []
        self._shared = data is not None

    def _ensure_writable(self):
        if self._shared:
            self._data = self._data.copy()
            self._shared = False

    def append(self, item):
        self._ensure_writable()
        self._data.append(item)

    def __iter__(self):
        return iter(self._data)

    def copy(self):
        """Create a shallow copy that shares data."""
        return COWList(self._data)
```

## Array-of-Structs to Struct-of-Arrays

Better memory locality and smaller footprint:

**Before (AoS):**
```python
particles = [
    {'x': 1.0, 'y': 2.0, 'mass': 1.0},
    {'x': 3.0, 'y': 4.0, 'mass': 2.0},
    # ... millions more
]
```

**After (SoA):**
```python
import numpy as np

particles = {
    'x': np.array([1.0, 3.0, ...]),
    'y': np.array([2.0, 4.0, ...]),
    'mass': np.array([1.0, 2.0, ...])
}
```

## Flyweight Pattern

Share common state across instances:

```python
class CharacterFlyweight:
    _cache = {}

    def __new__(cls, char):
        if char not in cls._cache:
            instance = super().__new__(cls)
            instance.char = char
            instance.glyph = load_glyph(char)  # Expensive
            cls._cache[char] = instance
        return cls._cache[char]

# All 'a' characters share the same glyph data
chars = [CharacterFlyweight(c) for c in "aaabbbccc"]
```

## Sparse Data Structures

For mostly-empty data:

```python
from scipy.sparse import csr_matrix, dok_matrix
import numpy as np

# Dense: 80MB for 10000x1000 float64
dense = np.zeros((10000, 1000))

# Sparse: Only stores non-zero values
sparse = dok_matrix((10000, 1000))
sparse[0, 0] = 1.0
sparse[5000, 500] = 2.0
# Convert to efficient format for computation
sparse_csr = sparse.tocsr()
```

## Pandas Memory Optimization

```python
def optimize_dataframe(df):
    """Comprehensive DataFrame memory optimization."""

    # Downcast integers
    for col in df.select_dtypes(include=['int64']).columns:
        df[col] = pd.to_numeric(df[col], downcast='integer')

    # Downcast floats
    for col in df.select_dtypes(include=['float64']).columns:
        df[col] = pd.to_numeric(df[col], downcast='float')

    # Convert low-cardinality strings to category
    for col in df.select_dtypes(include=['object']).columns:
        num_unique = df[col].nunique()
        num_total = len(df[col])
        if num_unique / num_total < 0.5:  # Less than 50% unique
            df[col] = df[col].astype('category')

    # Use nullable integer types for columns with NaN
    for col in df.select_dtypes(include=['float']).columns:
        if df[col].dropna().apply(float.is_integer).all():
            df[col] = df[col].astype('Int64')

    return df
```

## Context Manager for Memory Cleanup

```python
import gc
from contextlib import contextmanager

@contextmanager
def memory_scope():
    """Ensure cleanup of allocations within scope."""
    try:
        yield
    finally:
        gc.collect()

# Usage
with memory_scope():
    large_data = load_huge_dataset()
    result = process(large_data)
    del large_data
# large_data guaranteed to be collected here
```

## Streaming JSON Processing

Process large JSON without loading into memory:

```python
import ijson

def process_large_json(filepath):
    """Stream process JSON array items."""
    with open(filepath, 'rb') as f:
        for item in ijson.items(f, 'records.item'):
            yield process_item(item)
```

## Memory-Efficient String Building

```python
# Bad: O(n²) memory for string concatenation
result = ""
for chunk in chunks:
    result += chunk

# Good: O(n) memory
result = "".join(chunks)

# Better for large data: write to file or StringIO
from io import StringIO
buffer = StringIO()
for chunk in chunks:
    buffer.write(chunk)
result = buffer.getvalue()
```
