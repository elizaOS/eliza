---
name: custom-distance-metrics
description: Define custom distance/similarity metrics for clustering and ML algorithms. Use when working with DBSCAN, sklearn, or scipy distance functions with application-specific metrics.
---

# Custom Distance Metrics

Custom distance metrics allow you to define application-specific notions of similarity or distance between data points.

## Defining Custom Metrics for sklearn

sklearn's DBSCAN accepts a callable as the `metric` parameter:

```python
from sklearn.cluster import DBSCAN

def my_distance(point_a, point_b):
    """Custom distance between two points."""
    # point_a and point_b are 1D arrays
    return some_calculation(point_a, point_b)

db = DBSCAN(eps=5, min_samples=3, metric=my_distance)
```

## Parameterized Distance Functions

To use a distance function with configurable parameters, use a closure or factory function:

```python
def create_weighted_distance(weight_x, weight_y):
    """Create a distance function with specific weights."""
    def distance(a, b):
        dx = a[0] - b[0]
        dy = a[1] - b[1]
        return np.sqrt((weight_x * dx)**2 + (weight_y * dy)**2)
    return distance

# Create distances with different weights
dist_equal = create_weighted_distance(1.0, 1.0)
dist_x_heavy = create_weighted_distance(2.0, 0.5)

# Use with DBSCAN
db = DBSCAN(eps=10, min_samples=3, metric=dist_x_heavy)
```

## Example: Manhattan Distance with Parameter

As an example, Manhattan distance (L1 norm) can be parameterized with a scale factor:

```python
def create_manhattan_distance(scale=1.0):
    """
    Manhattan distance with optional scaling.
    Measures distance as sum of absolute differences.
    This is just one example - you can design custom metrics for your specific needs.
    """
    def distance(a, b):
        return scale * (abs(a[0] - b[0]) + abs(a[1] - b[1]))
    return distance

# Use with DBSCAN
manhattan_metric = create_manhattan_distance(scale=1.5)
db = DBSCAN(eps=10, min_samples=3, metric=manhattan_metric)
```


## Using scipy.spatial.distance

For computing distance matrices efficiently:

```python
from scipy.spatial.distance import cdist, pdist, squareform

# Custom distance for cdist
def custom_metric(u, v):
    return np.sqrt(np.sum((u - v)**2))

# Distance matrix between two sets of points
dist_matrix = cdist(points_a, points_b, metric=custom_metric)

# Pairwise distances within one set
pairwise = pdist(points, metric=custom_metric)
dist_matrix = squareform(pairwise)
```

## Performance Considerations

- Custom Python functions are slower than built-in metrics
- For large datasets, consider vectorizing operations
- Pre-compute distance matrices when doing multiple lookups
