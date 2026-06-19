"""Publication-quality visualization utilities.

Provides functions for creating figures suitable for academic papers,
including learning curves, bar plots, heatmaps, and multi-panel figures.
"""

from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import numpy as np

if TYPE_CHECKING:
    from matplotlib.axes import Axes
    from matplotlib.figure import Figure

    from alberta_framework.utils.experiments import AggregatedResults
    from alberta_framework.utils.statistics import SignificanceResult


# Default publication style settings
_DEFAULT_STYLE = {
    "font_size": 10,
    "figure_width": 3.5,  # Single column width in inches
    "figure_height": 2.8,
    "line_width": 1.5,
    "marker_size": 4,
    "dpi": 300,
    "use_latex": False,
}

_current_style = _DEFAULT_STYLE.copy()


def set_publication_style(
    font_size: int = 10,
    use_latex: bool = False,
    figure_width: float = 3.5,
    figure_height: float | None = None,
    style: str = "seaborn-v0_8-whitegrid",
) -> None:
    """Set matplotlib style for publication-quality figures.

    Args:
        font_size: Base font size
        use_latex: Whether to use LaTeX for text rendering
        figure_width: Default figure width in inches
        figure_height: Default figure height (auto if None)
        style: Matplotlib style to use
    """
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        raise ImportError("matplotlib is required. Install with: pip install matplotlib")

    # Update current style
    _current_style["font_size"] = font_size
    _current_style["figure_width"] = figure_width
    _current_style["use_latex"] = use_latex
    if figure_height is not None:
        _current_style["figure_height"] = figure_height
    else:
        _current_style["figure_height"] = figure_width * 0.8

    # Try to use the requested style, fall back to default if not available
    try:
        plt.style.use(style)
    except OSError:
        # Style not available, use defaults
        pass

    # Configure matplotlib
    plt.rcParams.update(
        {
            "font.size": font_size,
            "axes.labelsize": font_size,
            "axes.titlesize": font_size + 1,
            "xtick.labelsize": font_size - 1,
            "ytick.labelsize": font_size - 1,
            "legend.fontsize": font_size - 1,
            "figure.figsize": (_current_style["figure_width"], _current_style["figure_height"]),
            "figure.dpi": _current_style["dpi"],
            "savefig.dpi": _current_style["dpi"],
            "lines.linewidth": _current_style["line_width"],
            "lines.markersize": _current_style["marker_size"],
            "axes.linewidth": 0.8,
            "grid.linewidth": 0.5,
            "grid.alpha": 0.3,
        }
    )

    if use_latex:
        plt.rcParams.update(
            {
                "text.usetex": True,
                "font.family": "serif",
                "font.serif": ["Computer Modern Roman"],
            }
        )


def plot_learning_curves(
    results: dict[str, "AggregatedResults"],
    metric: str = "squared_error",
    show_ci: bool = True,
    log_scale: bool = True,
    window_size: int = 100,
    ax: "Axes | None" = None,
    colors: dict[str, str] | None = None,
    labels: dict[str, str] | None = None,
) -> tuple["Figure", "Axes"]:
    """Plot learning curves with confidence intervals.

    Args:
        results: Dictionary mapping config name to AggregatedResults
        metric: Metric to plot
        show_ci: Whether to show confidence intervals
        log_scale: Whether to use log scale for y-axis
        window_size: Window size for running mean smoothing
        ax: Existing axes to plot on (creates new figure if None)
        colors: Optional custom colors for each method
        labels: Optional custom labels for legend

    Returns:
        Tuple of (figure, axes)
    """
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        raise ImportError("matplotlib is required. Install with: pip install matplotlib")

    from alberta_framework.utils.metrics import compute_running_mean
    from alberta_framework.utils.statistics import compute_timeseries_statistics

    if ax is None:
        fig, ax = plt.subplots()
    else:
        fig = cast("Figure", ax.figure)
    # Default colors
    default_colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]

    for i, (name, agg) in enumerate(results.items()):
        color = (colors or {}).get(name, default_colors[i % len(default_colors)])
        label = (labels or {}).get(name, name)

        # Compute smoothed mean and CI
        metric_array = agg.metric_arrays[metric]

        # Smooth each seed individually, then compute statistics
        smoothed = np.array(
            [
                compute_running_mean(metric_array[seed_idx], window_size)
                for seed_idx in range(metric_array.shape[0])
            ]
        )

        mean, ci_lower, ci_upper = compute_timeseries_statistics(smoothed)

        steps = np.arange(len(mean))
        ax.plot(steps, mean, color=color, label=label, linewidth=_current_style["line_width"])

        if show_ci:
            ax.fill_between(steps, ci_lower, ci_upper, color=color, alpha=0.2)

    ax.set_xlabel("Time Step")
    ax.set_ylabel(_metric_to_label(metric))
    if log_scale:
        ax.set_yscale("log")
    ax.legend(loc="best", framealpha=0.9)
    ax.grid(True, alpha=0.3)

    fig.tight_layout()
    return fig, ax


def plot_final_performance_bars(
    results: dict[str, "AggregatedResults"],
    metric: str = "squared_error",
    show_significance: bool = True,
    significance_results: dict[tuple[str, str], "SignificanceResult"] | None = None,
    ax: "Axes | None" = None,
    colors: dict[str, str] | None = None,
    lower_is_better: bool = True,
) -> tuple["Figure", "Axes"]:
    """Plot final performance as bar chart with error bars.

    Args:
        results: Dictionary mapping config name to AggregatedResults
        metric: Metric to plot
        show_significance: Whether to show significance markers
        significance_results: Pairwise significance test results
        ax: Existing axes to plot on (creates new figure if None)
        colors: Optional custom colors for each method
        lower_is_better: Whether lower values are better

    Returns:
        Tuple of (figure, axes)
    """
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        raise ImportError("matplotlib is required. Install with: pip install matplotlib")

    if ax is None:
        fig, ax = plt.subplots()
    else:
        fig = cast("Figure", ax.figure)
    names = list(results.keys())
    means = [results[name].summary[metric].mean for name in names]
    stds = [results[name].summary[metric].std for name in names]

    # Default colors
    default_colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]

    x = np.arange(len(names))
    bar_colors = [
        (colors or {}).get(name, default_colors[i % len(default_colors)])
        for i, name in enumerate(names)
    ]

    bars = ax.bar(
        x, means, yerr=stds, capsize=3, color=bar_colors, edgecolor="black", linewidth=0.5
    )

    # Find best and mark it
    if lower_is_better:
        best_idx = int(np.argmin(means))
    else:
        best_idx = int(np.argmax(means))

    bars[best_idx].set_edgecolor("gold")
    bars[best_idx].set_linewidth(2)

    ax.set_xticks(x)
    ax.set_xticklabels(names, rotation=45, ha="right")
    ax.set_ylabel(_metric_to_label(metric))

    # Add significance markers if provided
    if show_significance and significance_results:
        best_name = names[best_idx]
        y_max = max(m + s for m, s in zip(means, stds, strict=False))
        y_offset = y_max * 0.05

        for i, name in enumerate(names):
            if name == best_name:
                continue

            marker = _get_significance_marker_for_plot(name, best_name, significance_results)
            if marker:
                ax.annotate(
                    marker,
                    (i, means[i] + stds[i] + y_offset),
                    ha="center",
                    fontsize=_current_style["font_size"],
                )

    fig.tight_layout()
    return fig, ax


def plot_hyperparameter_heatmap(
    results: dict[str, "AggregatedResults"],
    param1_name: str,
    param1_values: list[Any],
    param2_name: str,
    param2_values: list[Any],
    metric: str = "squared_error",
    name_pattern: str = "{p1}_{p2}",
    ax: "Axes | None" = None,
    cmap: str = "viridis_r",
    lower_is_better: bool = True,
) -> tuple["Figure", "Axes"]:
    """Plot hyperparameter sensitivity heatmap.

    Args:
        results: Dictionary mapping config name to AggregatedResults
        param1_name: Name of first parameter (y-axis)
        param1_values: Values of first parameter
        param2_name: Name of second parameter (x-axis)
        param2_values: Values of second parameter
        metric: Metric to plot
        name_pattern: Pattern to generate config names (use {p1}, {p2})
        ax: Existing axes to plot on
        cmap: Colormap to use
        lower_is_better: Whether lower values are better

    Returns:
        Tuple of (figure, axes)
    """
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        raise ImportError("matplotlib is required. Install with: pip install matplotlib")

    if ax is None:
        fig, ax = plt.subplots()
    else:
        fig = cast("Figure", ax.figure)
    # Build heatmap data
    data = np.zeros((len(param1_values), len(param2_values)))
    for i, p1 in enumerate(param1_values):
        for j, p2 in enumerate(param2_values):
            name = name_pattern.format(p1=p1, p2=p2)
            if name in results:
                data[i, j] = results[name].summary[metric].mean
            else:
                data[i, j] = np.nan

    if lower_is_better:
        cmap_to_use = cmap
    else:
        cmap_to_use = cmap.replace("_r", "") if "_r" in cmap else f"{cmap}_r"

    im = ax.imshow(data, cmap=cmap_to_use, aspect="auto")
    ax.set_xticks(np.arange(len(param2_values)))
    ax.set_yticks(np.arange(len(param1_values)))
    ax.set_xticklabels([str(v) for v in param2_values])
    ax.set_yticklabels([str(v) for v in param1_values])
    ax.set_xlabel(param2_name)
    ax.set_ylabel(param1_name)

    # Add colorbar
    cbar = fig.colorbar(im, ax=ax)
    cbar.set_label(_metric_to_label(metric))

    # Add value annotations
    for i in range(len(param1_values)):
        for j in range(len(param2_values)):
            if not np.isnan(data[i, j]):
                text_color = "white" if data[i, j] > np.nanmean(data) else "black"
                ax.annotate(
                    f"{data[i, j]:.3f}",
                    (j, i),
                    ha="center",
                    va="center",
                    color=text_color,
                    fontsize=_current_style["font_size"] - 2,
                )

    fig.tight_layout()
    return fig, ax


def plot_step_size_evolution(
    results: dict[str, "AggregatedResults"],
    metric: str = "mean_step_size",
    show_ci: bool = True,
    ax: "Axes | None" = None,
    colors: dict[str, str] | None = None,
) -> tuple["Figure", "Axes"]:
    """Plot step-size evolution over time.

    Args:
        results: Dictionary mapping config name to AggregatedResults
        metric: Step-size metric to plot
        show_ci: Whether to show confidence intervals
        ax: Existing axes to plot on
        colors: Optional custom colors

    Returns:
        Tuple of (figure, axes)
    """
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        raise ImportError("matplotlib is required. Install with: pip install matplotlib")

    from alberta_framework.utils.statistics import compute_timeseries_statistics

    if ax is None:
        fig, ax = plt.subplots()
    else:
        fig = cast("Figure", ax.figure)
    default_colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]

    for i, (name, agg) in enumerate(results.items()):
        if metric not in agg.metric_arrays:
            continue

        color = (colors or {}).get(name, default_colors[i % len(default_colors)])
        metric_array = agg.metric_arrays[metric]

        mean, ci_lower, ci_upper = compute_timeseries_statistics(metric_array)
        steps = np.arange(len(mean))

        ax.plot(steps, mean, color=color, label=name, linewidth=_current_style["line_width"])
        if show_ci:
            ax.fill_between(steps, ci_lower, ci_upper, color=color, alpha=0.2)

    ax.set_xlabel("Time Step")
    ax.set_ylabel("Step Size")
    ax.set_yscale("log")
    ax.legend(loc="best", framealpha=0.9)
    ax.grid(True, alpha=0.3)

    fig.tight_layout()
    return fig, ax


def create_comparison_figure(
    results: dict[str, "AggregatedResults"],
    significance_results: dict[tuple[str, str], "SignificanceResult"] | None = None,
    metric: str = "squared_error",
    step_size_metric: str = "mean_step_size",
) -> "Figure":
    """Create a 2x2 multi-panel comparison figure.

    Panels:
    - Top-left: Learning curves
    - Top-right: Final performance bars
    - Bottom-left: Step-size evolution
    - Bottom-right: Cumulative error

    Args:
        results: Dictionary mapping config name to AggregatedResults
        significance_results: Optional pairwise significance test results
        metric: Error metric to use
        step_size_metric: Step-size metric to use

    Returns:
        Figure with 4 subplots
    """
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        raise ImportError("matplotlib is required. Install with: pip install matplotlib")

    fig, axes = plt.subplots(2, 2, figsize=(7, 5.6))

    # Top-left: Learning curves
    plot_learning_curves(results, metric=metric, ax=axes[0, 0])
    axes[0, 0].set_title("Learning Curves")

    # Top-right: Final performance bars
    plot_final_performance_bars(
        results,
        metric=metric,
        significance_results=significance_results,
        ax=axes[0, 1],
    )
    axes[0, 1].set_title("Final Performance")

    # Bottom-left: Step-size evolution (if available)
    has_step_sizes = any(step_size_metric in agg.metric_arrays for agg in results.values())
    if has_step_sizes:
        plot_step_size_evolution(results, metric=step_size_metric, ax=axes[1, 0])
        axes[1, 0].set_title("Step-Size Evolution")
    else:
        axes[1, 0].text(
            0.5,
            0.5,
            "Step-size data\nnot available",
            ha="center",
            va="center",
            transform=axes[1, 0].transAxes,
        )
        axes[1, 0].set_title("Step-Size Evolution")

    # Bottom-right: Cumulative error
    _plot_cumulative_error(results, metric=metric, ax=axes[1, 1])
    axes[1, 1].set_title("Cumulative Error")

    fig.tight_layout()
    return fig


def _plot_cumulative_error(
    results: dict[str, "AggregatedResults"],
    metric: str,
    ax: "Axes",
) -> None:
    """Plot cumulative error."""
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        return

    from alberta_framework.utils.statistics import compute_timeseries_statistics

    default_colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]

    for i, (name, agg) in enumerate(results.items()):
        color = default_colors[i % len(default_colors)]
        metric_array = agg.metric_arrays[metric]

        # Compute cumulative sum for each seed
        cumsum_array = np.cumsum(metric_array, axis=1)
        mean, ci_lower, ci_upper = compute_timeseries_statistics(cumsum_array)
        steps = np.arange(len(mean))

        ax.plot(steps, mean, color=color, label=name, linewidth=_current_style["line_width"])
        ax.fill_between(steps, ci_lower, ci_upper, color=color, alpha=0.2)

    ax.set_xlabel("Time Step")
    ax.set_ylabel("Cumulative Error")
    ax.legend(loc="best", framealpha=0.9)
    ax.grid(True, alpha=0.3)


def save_figure(
    fig: "Figure",
    filename: str | Path,
    formats: list[str] | None = None,
    dpi: int = 300,
    transparent: bool = False,
) -> list[Path]:
    """Save figure to multiple formats.

    Args:
        fig: Matplotlib figure to save
        filename: Base filename (without extension)
        formats: List of formats to save (default: ["pdf", "png"])
        dpi: Resolution for raster formats
        transparent: Whether to use transparent background

    Returns:
        List of saved file paths
    """
    if formats is None:
        formats = ["pdf", "png"]

    filename = Path(filename)
    filename.parent.mkdir(parents=True, exist_ok=True)

    saved_paths = []
    for fmt in formats:
        path = filename.with_suffix(f".{fmt}")
        fig.savefig(
            path,
            format=fmt,
            dpi=dpi,
            bbox_inches="tight",
            transparent=transparent,
        )
        saved_paths.append(path)

    return saved_paths


def _metric_to_label(metric: str) -> str:
    """Convert metric name to human-readable label."""
    labels = {
        "squared_error": "Squared Error",
        "error": "Error",
        "mean_step_size": "Mean Step Size",
        "max_step_size": "Max Step Size",
        "min_step_size": "Min Step Size",
    }
    return labels.get(metric, metric.replace("_", " ").title())


def _get_significance_marker_for_plot(
    name: str,
    best_name: str,
    significance_results: dict[tuple[str, str], "SignificanceResult"],
) -> str:
    """Get significance marker for plot annotation."""
    key1 = (name, best_name)
    key2 = (best_name, name)

    if key1 in significance_results:
        result = significance_results[key1]
    elif key2 in significance_results:
        result = significance_results[key2]
    else:
        return ""

    if not result.significant:
        return ""

    p = result.p_value
    if p < 0.001:
        return "***"
    elif p < 0.01:
        return "**"
    elif p < 0.05:
        return "*"
    return ""
