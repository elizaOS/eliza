"""Export utilities for experiment results.

Provides functions for exporting results to CSV, JSON, LaTeX tables,
and markdown, suitable for academic publications.
"""

import csv
import json
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import pandas as pd

    from alberta_framework.utils.experiments import AggregatedResults
    from alberta_framework.utils.statistics import SignificanceResult


def export_to_csv(
    results: dict[str, "AggregatedResults"],
    filepath: str | Path,
    metric: str = "squared_error",
    include_timeseries: bool = False,
) -> None:
    """Export results to CSV file.

    Args:
        results: Dictionary mapping config name to AggregatedResults
        filepath: Path to output CSV file
        metric: Metric to export
        include_timeseries: Whether to include full timeseries (large!)
    """
    filepath = Path(filepath)
    filepath.parent.mkdir(parents=True, exist_ok=True)

    if include_timeseries:
        _export_timeseries_csv(results, filepath, metric)
    else:
        _export_summary_csv(results, filepath, metric)


def _export_summary_csv(
    results: dict[str, "AggregatedResults"],
    filepath: Path,
    metric: str,
) -> None:
    """Export summary statistics to CSV."""
    with open(filepath, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["config", "mean", "std", "min", "max", "n_seeds"])

        for name, agg in results.items():
            summary = agg.summary[metric]
            writer.writerow(
                [
                    name,
                    f"{summary.mean:.6f}",
                    f"{summary.std:.6f}",
                    f"{summary.min:.6f}",
                    f"{summary.max:.6f}",
                    summary.n_seeds,
                ]
            )


def _export_timeseries_csv(
    results: dict[str, "AggregatedResults"],
    filepath: Path,
    metric: str,
) -> None:
    """Export full timeseries to CSV."""
    with open(filepath, "w", newline="") as f:
        writer = csv.writer(f)

        # Determine max steps
        max_steps = max(agg.metric_arrays[metric].shape[1] for agg in results.values())

        # Header
        headers = ["step"]
        for name, agg in results.items():
            for seed in agg.seeds:
                headers.append(f"{name}_seed{seed}")
        writer.writerow(headers)

        # Data rows
        for step in range(max_steps):
            row: list[str | int] = [step]
            for agg in results.values():
                arr = agg.metric_arrays[metric]
                n_seeds = arr.shape[0]
                n_steps = arr.shape[1]
                for seed_idx in range(n_seeds):
                    if step < n_steps:
                        row.append(f"{arr[seed_idx, step]:.6f}")
                    else:
                        row.append("")
            writer.writerow(row)


def export_to_json(
    results: dict[str, "AggregatedResults"],
    filepath: str | Path,
    include_timeseries: bool = False,
) -> None:
    """Export results to JSON file.

    Args:
        results: Dictionary mapping config name to AggregatedResults
        filepath: Path to output JSON file
        include_timeseries: Whether to include full timeseries (large!)
    """
    filepath = Path(filepath)
    filepath.parent.mkdir(parents=True, exist_ok=True)

    from typing import Any

    data: dict[str, Any] = {}
    for name, agg in results.items():
        summary_data: dict[str, dict[str, Any]] = {}
        for metric_name, summary in agg.summary.items():
            summary_data[metric_name] = {
                "mean": summary.mean,
                "std": summary.std,
                "min": summary.min,
                "max": summary.max,
                "n_seeds": summary.n_seeds,
                "values": summary.values.tolist(),
            }

        config_data: dict[str, Any] = {
            "seeds": agg.seeds,
            "summary": summary_data,
        }

        if include_timeseries:
            config_data["timeseries"] = {
                metric: arr.tolist() for metric, arr in agg.metric_arrays.items()
            }

        data[name] = config_data

    with open(filepath, "w") as f:
        json.dump(data, f, indent=2)


def generate_latex_table(
    results: dict[str, "AggregatedResults"],
    significance_results: dict[tuple[str, str], "SignificanceResult"] | None = None,
    metric: str = "squared_error",
    caption: str = "Experimental Results",
    label: str = "tab:results",
    metric_label: str = "Error",
    lower_is_better: bool = True,
) -> str:
    """Generate a LaTeX table of results.

    Args:
        results: Dictionary mapping config name to AggregatedResults
        significance_results: Optional pairwise significance test results
        metric: Metric to display
        caption: Table caption
        label: LaTeX label for the table
        metric_label: Human-readable name for the metric
        lower_is_better: Whether lower metric values are better

    Returns:
        LaTeX table as a string
    """
    lines = []
    lines.append(r"\begin{table}[ht]")
    lines.append(r"\centering")
    lines.append(r"\caption{" + caption + "}")
    lines.append(r"\label{" + label + "}")
    lines.append(r"\begin{tabular}{lcc}")
    lines.append(r"\toprule")
    lines.append(r"Method & " + metric_label + r" & Seeds \\")
    lines.append(r"\midrule")

    # Find best result
    summaries = {name: agg.summary[metric] for name, agg in results.items()}
    if lower_is_better:
        best_name = min(summaries.keys(), key=lambda k: summaries[k].mean)
    else:
        best_name = max(summaries.keys(), key=lambda k: summaries[k].mean)

    for name, agg in results.items():
        summary = agg.summary[metric]
        mean_str = f"{summary.mean:.4f}"
        std_str = f"{summary.std:.4f}"

        # Bold if best
        if name == best_name:
            value_str = rf"\textbf{{{mean_str}}} $\pm$ {std_str}"
        else:
            value_str = rf"{mean_str} $\pm$ {std_str}"

        # Add significance marker if provided
        if significance_results:
            sig_marker = _get_significance_marker(name, best_name, significance_results)
            value_str += sig_marker

        # Escape underscores in method name
        escaped_name = name.replace("_", r"\_")
        lines.append(rf"{escaped_name} & {value_str} & {summary.n_seeds} \\")

    lines.append(r"\bottomrule")
    lines.append(r"\end{tabular}")

    if significance_results:
        lines.append(r"\vspace{0.5em}")
        lines.append(r"\footnotesize{$^*$ $p < 0.05$, $^{**}$ $p < 0.01$, $^{***}$ $p < 0.001$}")

    lines.append(r"\end{table}")

    return "\n".join(lines)


def _get_significance_marker(
    name: str,
    best_name: str,
    significance_results: dict[tuple[str, str], "SignificanceResult"],
) -> str:
    """Get significance marker for comparison with best method."""
    if name == best_name:
        return ""

    # Find comparison result
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
        return r"$^{***}$"
    elif p < 0.01:
        return r"$^{**}$"
    elif p < 0.05:
        return r"$^{*}$"
    return ""


def generate_markdown_table(
    results: dict[str, "AggregatedResults"],
    significance_results: dict[tuple[str, str], "SignificanceResult"] | None = None,
    metric: str = "squared_error",
    metric_label: str = "Error",
    lower_is_better: bool = True,
) -> str:
    """Generate a markdown table of results.

    Args:
        results: Dictionary mapping config name to AggregatedResults
        significance_results: Optional pairwise significance test results
        metric: Metric to display
        metric_label: Human-readable name for the metric
        lower_is_better: Whether lower metric values are better

    Returns:
        Markdown table as a string
    """
    lines = []
    lines.append(f"| Method | {metric_label} (mean ± std) | Seeds |")
    lines.append("|--------|-------------------------|-------|")

    # Find best result
    summaries = {name: agg.summary[metric] for name, agg in results.items()}
    if lower_is_better:
        best_name = min(summaries.keys(), key=lambda k: summaries[k].mean)
    else:
        best_name = max(summaries.keys(), key=lambda k: summaries[k].mean)

    for name, agg in results.items():
        summary = agg.summary[metric]
        mean_str = f"{summary.mean:.4f}"
        std_str = f"{summary.std:.4f}"

        # Bold if best
        if name == best_name:
            value_str = f"**{mean_str}** ± {std_str}"
        else:
            value_str = f"{mean_str} ± {std_str}"

        # Add significance marker if provided
        if significance_results:
            sig_marker = _get_md_significance_marker(name, best_name, significance_results)
            value_str += sig_marker

        lines.append(f"| {name} | {value_str} | {summary.n_seeds} |")

    if significance_results:
        lines.append("")
        lines.append("\\* p < 0.05, \\*\\* p < 0.01, \\*\\*\\* p < 0.001")

    return "\n".join(lines)


def _get_md_significance_marker(
    name: str,
    best_name: str,
    significance_results: dict[tuple[str, str], "SignificanceResult"],
) -> str:
    """Get significance marker for markdown."""
    if name == best_name:
        return ""

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
        return " ***"
    elif p < 0.01:
        return " **"
    elif p < 0.05:
        return " *"
    return ""


def generate_significance_table(
    significance_results: dict[tuple[str, str], "SignificanceResult"],
    format: str = "latex",
) -> str:
    """Generate a table of pairwise significance results.

    Args:
        significance_results: Pairwise significance test results
        format: Output format ("latex" or "markdown")

    Returns:
        Formatted table as string
    """
    if format == "latex":
        return _generate_significance_latex(significance_results)
    else:
        return _generate_significance_markdown(significance_results)


def _generate_significance_latex(
    significance_results: dict[tuple[str, str], "SignificanceResult"],
) -> str:
    """Generate LaTeX significance table."""
    lines = []
    lines.append(r"\begin{table}[ht]")
    lines.append(r"\centering")
    lines.append(r"\caption{Pairwise Significance Tests}")
    lines.append(r"\begin{tabular}{llcccc}")
    lines.append(r"\toprule")
    lines.append(r"Method A & Method B & Statistic & p-value & Effect Size & Sig. \\")
    lines.append(r"\midrule")

    for (name_a, name_b), result in significance_results.items():
        sig_str = "Yes" if result.significant else "No"
        escaped_a = name_a.replace("_", r"\_")
        escaped_b = name_b.replace("_", r"\_")
        lines.append(
            rf"{escaped_a} & {escaped_b} & {result.statistic:.3f} & "
            rf"{result.p_value:.4f} & {result.effect_size:.3f} & {sig_str} \\"
        )

    lines.append(r"\bottomrule")
    lines.append(r"\end{tabular}")
    lines.append(r"\end{table}")

    return "\n".join(lines)


def _generate_significance_markdown(
    significance_results: dict[tuple[str, str], "SignificanceResult"],
) -> str:
    """Generate markdown significance table."""
    lines = []
    lines.append("| Method A | Method B | Statistic | p-value | Effect Size | Sig. |")
    lines.append("|----------|----------|-----------|---------|-------------|------|")

    for (name_a, name_b), result in significance_results.items():
        sig_str = "Yes" if result.significant else "No"
        lines.append(
            f"| {name_a} | {name_b} | {result.statistic:.3f} | "
            f"{result.p_value:.4f} | {result.effect_size:.3f} | {sig_str} |"
        )

    return "\n".join(lines)


def save_experiment_report(
    results: dict[str, "AggregatedResults"],
    output_dir: str | Path,
    experiment_name: str,
    significance_results: dict[tuple[str, str], "SignificanceResult"] | None = None,
    metric: str = "squared_error",
) -> dict[str, Path]:
    """Save a complete experiment report with all artifacts.

    Args:
        results: Dictionary mapping config name to AggregatedResults
        output_dir: Directory to save artifacts
        experiment_name: Name for the experiment (used in filenames)
        significance_results: Optional pairwise significance test results
        metric: Primary metric to report

    Returns:
        Dictionary mapping artifact type to file path
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    artifacts: dict[str, Path] = {}

    # Export summary CSV
    csv_path = output_dir / f"{experiment_name}_summary.csv"
    export_to_csv(results, csv_path, metric=metric)
    artifacts["summary_csv"] = csv_path

    # Export JSON
    json_path = output_dir / f"{experiment_name}_results.json"
    export_to_json(results, json_path, include_timeseries=False)
    artifacts["json"] = json_path

    # Generate LaTeX table
    latex_path = output_dir / f"{experiment_name}_table.tex"
    latex_content = generate_latex_table(
        results,
        significance_results=significance_results,
        metric=metric,
        caption=f"{experiment_name} Results",
        label=f"tab:{experiment_name}",
    )
    with open(latex_path, "w") as f:
        f.write(latex_content)
    artifacts["latex_table"] = latex_path

    # Generate markdown table
    md_path = output_dir / f"{experiment_name}_table.md"
    md_content = generate_markdown_table(
        results,
        significance_results=significance_results,
        metric=metric,
    )
    with open(md_path, "w") as f:
        f.write(md_content)
    artifacts["markdown_table"] = md_path

    # If significance results provided, save those too
    if significance_results:
        sig_latex_path = output_dir / f"{experiment_name}_significance.tex"
        sig_latex = generate_significance_table(significance_results, format="latex")
        with open(sig_latex_path, "w") as f:
            f.write(sig_latex)
        artifacts["significance_latex"] = sig_latex_path

        sig_md_path = output_dir / f"{experiment_name}_significance.md"
        sig_md = generate_significance_table(significance_results, format="markdown")
        with open(sig_md_path, "w") as f:
            f.write(sig_md)
        artifacts["significance_md"] = sig_md_path

    return artifacts


def results_to_dataframe(
    results: dict[str, "AggregatedResults"],
    metric: str = "squared_error",
) -> "pd.DataFrame":
    """Convert results to a pandas DataFrame.

    Requires pandas to be installed.

    Args:
        results: Dictionary mapping config name to AggregatedResults
        metric: Metric to include

    Returns:
        DataFrame with results
    """
    try:
        import pandas as pd
    except ImportError:
        raise ImportError("pandas is required. Install with: pip install pandas")

    rows = []
    for name, agg in results.items():
        summary = agg.summary[metric]
        rows.append(
            {
                "method": name,
                "mean": summary.mean,
                "std": summary.std,
                "min": summary.min,
                "max": summary.max,
                "n_seeds": summary.n_seeds,
            }
        )

    return pd.DataFrame(rows)
