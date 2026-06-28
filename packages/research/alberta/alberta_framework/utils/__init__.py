"""Utility functions for the Alberta Framework."""

# Experiment runner (no external deps)
from alberta_framework.utils.experiments import (
    AggregatedResults,
    ExperimentConfig,
    MetricSummary,
    SingleRunResult,
    aggregate_metrics,
    get_final_performance,
    get_metric_timeseries,
    run_multi_seed_experiment,
    run_single_experiment,
)

# Export utilities (no external deps for basic functionality)
from alberta_framework.utils.export import (
    export_to_csv,
    export_to_json,
    generate_latex_table,
    generate_markdown_table,
    save_experiment_report,
)
from alberta_framework.utils.metrics import (
    compare_learners,
    compute_cumulative_error,
    compute_running_mean,
    compute_tracking_error,
    extract_metric,
)

__all__ = [
    # Metrics
    "compare_learners",
    "compute_cumulative_error",
    "compute_running_mean",
    "compute_tracking_error",
    "extract_metric",
    # Experiments
    "AggregatedResults",
    "ExperimentConfig",
    "MetricSummary",
    "SingleRunResult",
    "aggregate_metrics",
    "get_final_performance",
    "get_metric_timeseries",
    "run_multi_seed_experiment",
    "run_single_experiment",
    # Export
    "export_to_csv",
    "export_to_json",
    "generate_latex_table",
    "generate_markdown_table",
    "save_experiment_report",
]

# Optional: Statistics (requires scipy for full functionality)
try:
    from alberta_framework.utils.statistics import (
        SignificanceResult,
        StatisticalSummary,
        bonferroni_correction,
        bootstrap_ci,
        cohens_d,
        compute_statistics,
        compute_timeseries_statistics,
        holm_correction,
        mann_whitney_comparison,
        pairwise_comparisons,
        ttest_comparison,
        wilcoxon_comparison,
    )

    __all__ += [
        "SignificanceResult",
        "StatisticalSummary",
        "bonferroni_correction",
        "bootstrap_ci",
        "cohens_d",
        "compute_statistics",
        "compute_timeseries_statistics",
        "holm_correction",
        "mann_whitney_comparison",
        "pairwise_comparisons",
        "ttest_comparison",
        "wilcoxon_comparison",
    ]
except ImportError:
    pass

# Optional: Visualization (requires matplotlib)
try:
    from alberta_framework.utils.visualization import (
        create_comparison_figure,
        plot_final_performance_bars,
        plot_hyperparameter_heatmap,
        plot_learning_curves,
        plot_step_size_evolution,
        save_figure,
        set_publication_style,
    )

    __all__ += [
        "create_comparison_figure",
        "plot_final_performance_bars",
        "plot_hyperparameter_heatmap",
        "plot_learning_curves",
        "plot_step_size_evolution",
        "save_figure",
        "set_publication_style",
    ]
except ImportError:
    pass
