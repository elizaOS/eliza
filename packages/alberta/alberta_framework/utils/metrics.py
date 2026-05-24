"""Metrics and analysis utilities for continual learning experiments.

Provides functions for computing tracking error, learning curves,
and other metrics useful for evaluating continual learners.
"""

import numpy as np
from numpy.typing import NDArray


def compute_cumulative_error(
    metrics_history: list[dict[str, float]],
    error_key: str = "squared_error",
) -> NDArray[np.float64]:
    """Compute cumulative error over time.

    Args:
        metrics_history: List of metric dictionaries from learning loop
        error_key: Key to extract error values

    Returns:
        Array of cumulative errors at each time step
    """
    errors = np.array([m[error_key] for m in metrics_history])
    return np.cumsum(errors)


def compute_running_mean(
    values: NDArray[np.float64] | list[float],
    window_size: int = 100,
) -> NDArray[np.float64]:
    """Compute running mean of values.

    Args:
        values: Array of values
        window_size: Size of the moving average window

    Returns:
        Array of running mean values (same length as input, padded at start)
    """
    values_arr = np.asarray(values)
    cumsum = np.cumsum(np.insert(values_arr, 0, 0))
    running_mean = (cumsum[window_size:] - cumsum[:-window_size]) / window_size

    # Pad the beginning with the first computed mean
    if len(running_mean) > 0:
        padding = np.full(window_size - 1, running_mean[0])
        return np.concatenate([padding, running_mean])
    return values_arr


def compute_tracking_error(
    metrics_history: list[dict[str, float]],
    window_size: int = 100,
) -> NDArray[np.float64]:
    """Compute tracking error (running mean of squared error).

    This is the key metric for evaluating continual learners:
    how well can the learner track the non-stationary target?

    Args:
        metrics_history: List of metric dictionaries from learning loop
        window_size: Size of the moving average window

    Returns:
        Array of tracking errors at each time step
    """
    errors = np.array([m["squared_error"] for m in metrics_history])
    return compute_running_mean(errors, window_size)


def extract_metric(
    metrics_history: list[dict[str, float]],
    key: str,
) -> NDArray[np.float64]:
    """Extract a single metric from the history.

    Args:
        metrics_history: List of metric dictionaries
        key: Key to extract

    Returns:
        Array of values for that metric
    """
    return np.array([m[key] for m in metrics_history])


def compare_learners(
    results: dict[str, list[dict[str, float]]],
    metric: str = "squared_error",
) -> dict[str, dict[str, float]]:
    """Compare multiple learners on a given metric.

    Args:
        results: Dictionary mapping learner name to metrics history
        metric: Metric to compare

    Returns:
        Dictionary with summary statistics for each learner
    """
    summary = {}
    for name, metrics_history in results.items():
        values = extract_metric(metrics_history, metric)
        summary[name] = {
            "mean": float(np.mean(values)),
            "std": float(np.std(values)),
            "cumulative": float(np.sum(values)),
            "final_100_mean": (
                float(np.mean(values[-100:])) if len(values) >= 100 else float(np.mean(values))
            ),
        }
    return summary
