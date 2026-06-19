---
name: pareto-optimization
description: Multi-objective optimization with Pareto frontiers. Use when optimizing multiple conflicting objectives simultaneously, finding trade-off solutions, or computing Pareto-optimal points.
---

# Pareto Optimization

Pareto optimization deals with multi-objective optimization where you want to optimize multiple conflicting objectives simultaneously.

## Key Concepts

### Pareto Dominance

Point A **dominates** point B if:
- A is at least as good as B in all objectives
- A is strictly better than B in at least one objective

### Pareto Frontier (Pareto Front)

The set of all non-dominated points. These represent optimal trade-offs where improving one objective requires sacrificing another.

## Computing the Pareto Frontier

### Using the paretoset Library

```python
from paretoset import paretoset
import pandas as pd

# Data with two objectives (e.g., model accuracy vs inference time)
df = pd.DataFrame({
    'accuracy': [0.95, 0.92, 0.88, 0.85, 0.80],
    'latency_ms': [120, 95, 75, 60, 45],
    'model_size': [100, 80, 60, 40, 20],
    'learning_rate': [0.001, 0.005, 0.01, 0.05, 0.1]
})

# Compute Pareto mask
# sense: "max" for objectives to maximize, "min" for objectives to minimize
objectives = df[['accuracy', 'latency_ms']]
pareto_mask = paretoset(objectives, sense=["max", "min"])

# Get Pareto-optimal points
pareto_points = df[pareto_mask]
```

### Manual Implementation

```python
import numpy as np

def is_dominated(point, other_points, maximize_indices, minimize_indices):
    """Check if point is dominated by any point in other_points."""
    for other in other_points:
        dominated = True
        strictly_worse = False

        for i in maximize_indices:
            if point[i] > other[i]:
                dominated = False
                break
            if point[i] < other[i]:
                strictly_worse = True

        if dominated:
            for i in minimize_indices:
                if point[i] < other[i]:
                    dominated = False
                    break
                if point[i] > other[i]:
                    strictly_worse = True

        if dominated and strictly_worse:
            return True

    return False

def compute_pareto_frontier(points, maximize_indices=[0], minimize_indices=[1]):
    """Compute Pareto frontier from array of points."""
    pareto = []
    points_list = list(points)

    for i, point in enumerate(points_list):
        others = points_list[:i] + points_list[i+1:]
        if not is_dominated(point, others, maximize_indices, minimize_indices):
            pareto.append(point)

    return np.array(pareto)
```

## Example: Model Selection

```python
import pandas as pd
from paretoset import paretoset

# Results from model training experiments
results = pd.DataFrame({
    'accuracy': [0.95, 0.92, 0.90, 0.88, 0.85],
    'inference_time': [150, 120, 100, 80, 60],
    'batch_size': [32, 64, 128, 256, 512],
    'hidden_units': [512, 256, 128, 64, 32]
})

# Filter by minimum accuracy threshold
results = results[results['accuracy'] >= 0.85]

# Compute Pareto frontier (maximize accuracy, minimize inference time)
mask = paretoset(results[['accuracy', 'inference_time']], sense=["max", "min"])
pareto_frontier = results[mask].sort_values('accuracy', ascending=False)

# Save to CSV
pareto_frontier.to_csv('pareto_models.csv', index=False)
```

## Visualization

```python
import matplotlib.pyplot as plt

# Plot all points
plt.scatter(results['inference_time'], results['accuracy'],
            alpha=0.5, label='All models')

# Highlight Pareto frontier
plt.scatter(pareto_frontier['inference_time'], pareto_frontier['accuracy'],
            color='red', s=100, marker='s', label='Pareto frontier')

plt.xlabel('Inference Time (ms) - minimize')
plt.ylabel('Accuracy - maximize')
plt.legend()
plt.show()
```

## Properties of Pareto Frontiers

1. **Trade-off curve**: Moving along the frontier improves one objective while worsening another
2. **No single best**: All Pareto-optimal solutions are equally "good" in a multi-objective sense
3. **Decision making**: Final choice depends on preference between objectives
