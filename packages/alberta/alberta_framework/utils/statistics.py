"""Statistical analysis utilities for publication-quality experiments.

Provides functions for computing confidence intervals, significance tests,
effect sizes, and multiple comparison corrections.
"""

from typing import TYPE_CHECKING, NamedTuple

import numpy as np
from numpy.typing import NDArray

if TYPE_CHECKING:
    from alberta_framework.utils.experiments import AggregatedResults


class StatisticalSummary(NamedTuple):
    """Summary statistics for a set of values.

    Attributes:
        mean: Arithmetic mean
        std: Standard deviation
        sem: Standard error of the mean
        ci_lower: Lower bound of confidence interval
        ci_upper: Upper bound of confidence interval
        median: Median value
        iqr: Interquartile range
        n_seeds: Number of samples
    """

    mean: float
    std: float
    sem: float
    ci_lower: float
    ci_upper: float
    median: float
    iqr: float
    n_seeds: int


class SignificanceResult(NamedTuple):
    """Result of a statistical significance test.

    Attributes:
        test_name: Name of the test performed
        statistic: Test statistic value
        p_value: P-value of the test
        significant: Whether the result is significant at the given alpha
        alpha: Significance level used
        effect_size: Effect size (e.g., Cohen's d)
        method_a: Name of first method
        method_b: Name of second method
    """

    test_name: str
    statistic: float
    p_value: float
    significant: bool
    alpha: float
    effect_size: float
    method_a: str
    method_b: str


def compute_statistics(
    values: NDArray[np.float64] | list[float],
    confidence_level: float = 0.95,
) -> StatisticalSummary:
    """Compute comprehensive statistics for a set of values.

    Args:
        values: Array of values (e.g., final performance across seeds)
        confidence_level: Confidence level for CI (default 0.95)

    Returns:
        StatisticalSummary with all statistics
    """
    arr = np.asarray(values)
    n = len(arr)

    mean = float(np.mean(arr))
    std = float(np.std(arr, ddof=1)) if n > 1 else 0.0
    sem = std / np.sqrt(n) if n > 1 else 0.0
    median = float(np.median(arr))
    q75, q25 = np.percentile(arr, [75, 25])
    iqr = float(q75 - q25)

    # Compute confidence interval
    try:
        from scipy import stats

        if n > 1:
            t_value = float(stats.t.ppf((1 + confidence_level) / 2, n - 1))
            margin = t_value * sem
            ci_lower = mean - margin
            ci_upper = mean + margin
        else:
            ci_lower = ci_upper = mean
    except ImportError:
        # Fallback without scipy: use normal approximation
        z_value = 1.96 if confidence_level == 0.95 else 2.576  # 95% or 99%
        margin = z_value * sem
        ci_lower = mean - margin
        ci_upper = mean + margin

    return StatisticalSummary(
        mean=mean,
        std=std,
        sem=sem,
        ci_lower=float(ci_lower),
        ci_upper=float(ci_upper),
        median=median,
        iqr=iqr,
        n_seeds=n,
    )


def compute_timeseries_statistics(
    metric_array: NDArray[np.float64],
    confidence_level: float = 0.95,
) -> tuple[NDArray[np.float64], NDArray[np.float64], NDArray[np.float64]]:
    """Compute mean and confidence intervals for timeseries data.

    Args:
        metric_array: Array of shape (n_seeds, n_steps)
        confidence_level: Confidence level for CI

    Returns:
        Tuple of (mean, ci_lower, ci_upper) arrays of shape (n_steps,)
    """
    n_seeds = metric_array.shape[0]
    mean = np.mean(metric_array, axis=0)
    std = np.std(metric_array, axis=0, ddof=1)
    sem = std / np.sqrt(n_seeds)

    try:
        from scipy import stats

        t_value = stats.t.ppf((1 + confidence_level) / 2, n_seeds - 1)
    except ImportError:
        t_value = 1.96 if confidence_level == 0.95 else 2.576

    margin = t_value * sem
    ci_lower = mean - margin
    ci_upper = mean + margin

    return mean, ci_lower, ci_upper


def cohens_d(
    values_a: NDArray[np.float64] | list[float],
    values_b: NDArray[np.float64] | list[float],
) -> float:
    """Compute Cohen's d effect size.

    Args:
        values_a: Values for first group
        values_b: Values for second group

    Returns:
        Cohen's d (positive means a > b)
    """
    a = np.asarray(values_a)
    b = np.asarray(values_b)

    mean_a = np.mean(a)
    mean_b = np.mean(b)

    n_a = len(a)
    n_b = len(b)

    # Pooled standard deviation
    var_a = np.var(a, ddof=1) if n_a > 1 else 0.0
    var_b = np.var(b, ddof=1) if n_b > 1 else 0.0

    pooled_std = np.sqrt(((n_a - 1) * var_a + (n_b - 1) * var_b) / (n_a + n_b - 2))

    if pooled_std == 0:
        return 0.0

    return float((mean_a - mean_b) / pooled_std)


def ttest_comparison(
    values_a: NDArray[np.float64] | list[float],
    values_b: NDArray[np.float64] | list[float],
    paired: bool = True,
    alpha: float = 0.05,
    method_a: str = "A",
    method_b: str = "B",
) -> SignificanceResult:
    """Perform t-test comparison between two methods.

    Args:
        values_a: Values for first method
        values_b: Values for second method
        paired: Whether to use paired t-test (default True for same seeds)
        alpha: Significance level
        method_a: Name of first method
        method_b: Name of second method

    Returns:
        SignificanceResult with test results
    """
    a = np.asarray(values_a)
    b = np.asarray(values_b)

    try:
        from scipy import stats

        if paired:
            result = stats.ttest_rel(a, b)
            test_name = "paired t-test"
        else:
            result = stats.ttest_ind(a, b)
            test_name = "independent t-test"
        # scipy returns (statistic, pvalue) tuple
        stat_val = float(result[0])
        p_val = float(result[1])
    except ImportError:
        raise ImportError("scipy is required for t-test. Install with: pip install scipy")

    effect = cohens_d(a, b)

    return SignificanceResult(
        test_name=test_name,
        statistic=stat_val,
        p_value=p_val,
        significant=p_val < alpha,
        alpha=alpha,
        effect_size=effect,
        method_a=method_a,
        method_b=method_b,
    )


def mann_whitney_comparison(
    values_a: NDArray[np.float64] | list[float],
    values_b: NDArray[np.float64] | list[float],
    alpha: float = 0.05,
    method_a: str = "A",
    method_b: str = "B",
) -> SignificanceResult:
    """Perform Mann-Whitney U test (non-parametric).

    Args:
        values_a: Values for first method
        values_b: Values for second method
        alpha: Significance level
        method_a: Name of first method
        method_b: Name of second method

    Returns:
        SignificanceResult with test results
    """
    a = np.asarray(values_a)
    b = np.asarray(values_b)

    try:
        from scipy import stats

        result = stats.mannwhitneyu(a, b, alternative="two-sided")
        # scipy returns (statistic, pvalue) tuple
        stat_val = float(result[0])
        p_val = float(result[1])
    except ImportError:
        raise ImportError(
            "scipy is required for Mann-Whitney test. Install with: pip install scipy"
        )

    # Compute rank-biserial correlation as effect size
    n_a, n_b = len(a), len(b)
    r = 1 - (2 * stat_val) / (n_a * n_b)

    return SignificanceResult(
        test_name="Mann-Whitney U",
        statistic=stat_val,
        p_value=p_val,
        significant=p_val < alpha,
        alpha=alpha,
        effect_size=r,
        method_a=method_a,
        method_b=method_b,
    )


def wilcoxon_comparison(
    values_a: NDArray[np.float64] | list[float],
    values_b: NDArray[np.float64] | list[float],
    alpha: float = 0.05,
    method_a: str = "A",
    method_b: str = "B",
) -> SignificanceResult:
    """Perform Wilcoxon signed-rank test (paired non-parametric).

    Args:
        values_a: Values for first method
        values_b: Values for second method
        alpha: Significance level
        method_a: Name of first method
        method_b: Name of second method

    Returns:
        SignificanceResult with test results
    """
    a = np.asarray(values_a)
    b = np.asarray(values_b)

    try:
        from scipy import stats

        result = stats.wilcoxon(a, b, alternative="two-sided")
        # scipy returns (statistic, pvalue) tuple
        stat_val = float(result[0])
        p_val = float(result[1])
    except ImportError:
        raise ImportError("scipy is required for Wilcoxon test. Install with: pip install scipy")

    effect = cohens_d(a, b)

    return SignificanceResult(
        test_name="Wilcoxon signed-rank",
        statistic=stat_val,
        p_value=p_val,
        significant=p_val < alpha,
        alpha=alpha,
        effect_size=effect,
        method_a=method_a,
        method_b=method_b,
    )


def bonferroni_correction(
    p_values: list[float],
    alpha: float = 0.05,
) -> tuple[list[bool], float]:
    """Apply Bonferroni correction for multiple comparisons.

    Args:
        p_values: List of p-values from multiple tests
        alpha: Family-wise significance level

    Returns:
        Tuple of (list of significant booleans, corrected alpha)
    """
    n_tests = len(p_values)
    corrected_alpha = alpha / n_tests
    significant = [p < corrected_alpha for p in p_values]
    return significant, corrected_alpha


def holm_correction(
    p_values: list[float],
    alpha: float = 0.05,
) -> list[bool]:
    """Apply Holm-Bonferroni step-down correction.

    More powerful than Bonferroni while still controlling FWER.

    Args:
        p_values: List of p-values from multiple tests
        alpha: Family-wise significance level

    Returns:
        List of significant booleans
    """
    n_tests = len(p_values)

    # Sort p-values and track original indices
    sorted_indices = np.argsort(p_values)
    sorted_p = [p_values[i] for i in sorted_indices]

    # Apply Holm correction
    significant_sorted = []
    for i, p in enumerate(sorted_p):
        corrected_alpha = alpha / (n_tests - i)
        if p < corrected_alpha:
            significant_sorted.append(True)
        else:
            # Once we fail to reject, all subsequent are not significant
            significant_sorted.extend([False] * (n_tests - i))
            break

    # Restore original order
    significant = [False] * n_tests
    for orig_idx, sig in zip(sorted_indices, significant_sorted, strict=False):
        significant[orig_idx] = sig

    return significant


def pairwise_comparisons(
    results: "dict[str, AggregatedResults]",  # noqa: F821
    metric: str = "squared_error",
    test: str = "ttest",
    correction: str = "bonferroni",
    alpha: float = 0.05,
    window: int = 100,
) -> dict[tuple[str, str], SignificanceResult]:
    """Perform all pairwise comparisons between methods.

    Args:
        results: Dictionary mapping config name to AggregatedResults
        metric: Metric to compare
        test: Test to use ("ttest", "mann_whitney", or "wilcoxon")
        correction: Multiple comparison correction ("bonferroni" or "holm")
        alpha: Significance level
        window: Number of final steps to average

    Returns:
        Dictionary mapping (method_a, method_b) to SignificanceResult
    """
    from alberta_framework.utils.experiments import AggregatedResults

    names = list(results.keys())
    n = len(names)

    if n < 2:
        return {}

    # Extract final values for each method
    final_values: dict[str, NDArray[np.float64]] = {}
    for name, agg in results.items():
        if not isinstance(agg, AggregatedResults):
            raise TypeError(f"Expected AggregatedResults, got {type(agg)}")
        arr = agg.metric_arrays[metric]
        final_window = min(window, arr.shape[1])
        final_values[name] = np.mean(arr[:, -final_window:], axis=1)

    if test not in ("ttest", "mann_whitney", "wilcoxon"):
        raise ValueError(f"Unknown test: {test}")

    # Perform all pairwise comparisons
    comparisons: dict[tuple[str, str], SignificanceResult] = {}
    p_values: list[float] = []

    for i in range(n):
        for j in range(i + 1, n):
            name_a, name_b = names[i], names[j]
            values_a = final_values[name_a]
            values_b = final_values[name_b]

            if test == "ttest":
                result = ttest_comparison(
                    values_a,
                    values_b,
                    paired=True,
                    alpha=alpha,
                    method_a=name_a,
                    method_b=name_b,
                )
            elif test == "mann_whitney":
                result = mann_whitney_comparison(
                    values_a,
                    values_b,
                    alpha=alpha,
                    method_a=name_a,
                    method_b=name_b,
                )
            else:  # wilcoxon
                result = wilcoxon_comparison(
                    values_a,
                    values_b,
                    alpha=alpha,
                    method_a=name_a,
                    method_b=name_b,
                )

            comparisons[(name_a, name_b)] = result
            p_values.append(result.p_value)

    # Apply multiple comparison correction
    if correction == "bonferroni":
        significant_list, _ = bonferroni_correction(p_values, alpha)
    elif correction == "holm":
        significant_list = holm_correction(p_values, alpha)
    else:
        raise ValueError(f"Unknown correction: {correction}")

    # Update significance based on correction
    corrected_comparisons: dict[tuple[str, str], SignificanceResult] = {}
    for (key, result), sig in zip(comparisons.items(), significant_list, strict=False):
        corrected_comparisons[key] = SignificanceResult(
            test_name=f"{result.test_name} ({correction})",
            statistic=result.statistic,
            p_value=result.p_value,
            significant=sig,
            alpha=alpha,
            effect_size=result.effect_size,
            method_a=result.method_a,
            method_b=result.method_b,
        )

    return corrected_comparisons


def bootstrap_ci(
    values: NDArray[np.float64] | list[float],
    statistic: str = "mean",
    confidence_level: float = 0.95,
    n_bootstrap: int = 10000,
    seed: int = 42,
) -> tuple[float, float, float]:
    """Compute bootstrap confidence interval.

    Args:
        values: Array of values
        statistic: Statistic to bootstrap ("mean" or "median")
        confidence_level: Confidence level
        n_bootstrap: Number of bootstrap samples
        seed: Random seed

    Returns:
        Tuple of (point_estimate, ci_lower, ci_upper)
    """
    arr = np.asarray(values)
    rng = np.random.default_rng(seed)

    stat_func = np.mean if statistic == "mean" else np.median
    point_estimate = float(stat_func(arr))

    # Generate bootstrap samples
    bootstrap_stats_list: list[float] = []
    for _ in range(n_bootstrap):
        sample = rng.choice(arr, size=len(arr), replace=True)
        bootstrap_stats_list.append(float(stat_func(sample)))

    bootstrap_stats = np.array(bootstrap_stats_list)

    # Percentile method
    lower_percentile = (1 - confidence_level) / 2 * 100
    upper_percentile = (1 + confidence_level) / 2 * 100
    ci_lower = float(np.percentile(bootstrap_stats, lower_percentile))
    ci_upper = float(np.percentile(bootstrap_stats, upper_percentile))

    return point_estimate, ci_lower, ci_upper
