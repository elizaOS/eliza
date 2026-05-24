"""Render Alberta-vs-PPO continual obstacle-course demo evidence.

The obstacle-course benchmark is intentionally CPU-cheap: it is a 2D
task-conditioned point-robot course, not a MuJoCo humanoid. This renderer turns
the benchmark matrices into a short MP4 that shows each learner's performance on
old and new obstacle tasks after every sequential training phase.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np

PKG_ROOT = Path(__file__).resolve().parents[1]


def _load_json(path: Path) -> dict[str, Any]:
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise ValueError(f"{path} root is not an object")
    return loaded


def _first_result(bundle: dict[str, Any], learner: str) -> dict[str, Any]:
    results = bundle.get("results")
    if not isinstance(results, list):
        raise ValueError("benchmark bundle missing results list")
    for item in results:
        if isinstance(item, dict) and item.get("name") == learner:
            return item
    raise ValueError(f"benchmark bundle missing {learner!r} result")


def _learner_results(bundle: dict[str, Any]) -> list[dict[str, Any]]:
    results = bundle.get("results")
    if not isinstance(results, list):
        raise ValueError("benchmark bundle missing results list")
    configured = bundle.get("config", {}).get("learners") if isinstance(bundle.get("config"), dict) else None
    names = (
        [name for name in configured if isinstance(name, str)]
        if isinstance(configured, list)
        else ["alberta", "ppo"]
    )
    ordered: list[dict[str, Any]] = []
    for name in names:
        ordered.append(_first_result(bundle, name))
    return ordered


def _matrix(result: dict[str, Any]) -> np.ndarray:
    matrix = np.asarray(result.get("matrix"), dtype=np.float64)
    if matrix.ndim != 2 or matrix.shape[0] != matrix.shape[1] or matrix.shape[0] == 0:
        raise ValueError(f"invalid result matrix for {result.get('name')!r}: {matrix.shape}")
    return matrix


def _baseline(result: dict[str, Any], n_tasks: int) -> np.ndarray:
    baseline = np.asarray(result.get("baseline"), dtype=np.float64)
    if baseline.shape != (n_tasks,):
        raise ValueError(f"invalid baseline shape for {result.get('name')!r}: {baseline.shape}")
    return baseline


def _frame_rgb(fig) -> np.ndarray:
    fig.canvas.draw()
    width, height = fig.canvas.get_width_height()
    rgba = np.asarray(fig.canvas.buffer_rgba(), dtype=np.uint8).reshape(height, width, 4)
    return rgba[:, :, :3].copy()


def render_demo(
    benchmark_dir: Path,
    *,
    out_video: Path | None = None,
    out_json: Path | None = None,
    hold_frames: int = 18,
    fps: int = 12,
) -> dict[str, Any]:
    benchmark_dir = benchmark_dir.resolve()
    bundle = _load_json(benchmark_dir / "continual_benchmark.json")
    learner_results = _learner_results(bundle)
    if len(learner_results) < 2:
        raise ValueError("demo rendering requires at least two learners")
    matrices = {str(result["name"]): _matrix(result) for result in learner_results}
    first_shape = next(iter(matrices.values())).shape
    if any(matrix.shape != first_shape for matrix in matrices.values()):
        raise ValueError("learner result matrices have different shapes")
    n_tasks = int(first_shape[0])
    baselines = {
        str(result["name"]): _baseline(result, n_tasks) for result in learner_results
    }
    out_video = out_video or benchmark_dir / "obstacle_course_demo.mp4"
    out_json = out_json or benchmark_dir / "obstacle_course_demo.json"

    try:
        import imageio.v2 as imageio
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError as exc:  # pragma: no cover - dependency gate
        raise RuntimeError("demo rendering requires matplotlib and imageio[ffmpeg]") from exc

    out_video.parent.mkdir(parents=True, exist_ok=True)
    min_value = float(
        min(
            min(matrix.min() for matrix in matrices.values()),
            min(baseline.min() for baseline in baselines.values()),
        )
    )
    max_value = float(
        max(
            max(matrix.max() for matrix in matrices.values()),
            max(baseline.max() for baseline in baselines.values()),
        )
    )
    if min_value == max_value:
        max_value = min_value + 1.0

    writer = imageio.get_writer(
        out_video,
        fps=fps,
        codec="libx264",
        quality=8,
        macro_block_size=None,
    )
    try:
        n_learners = len(learner_results)
        ncols = max(2, n_learners)
        for phase in range(n_tasks):
            for _ in range(max(1, hold_frames)):
                fig, axes = plt.subplots(2, ncols, figsize=(5.2 * ncols, 7), dpi=120)
                axes = np.asarray(axes).reshape(2, ncols)
                for ax, result in zip(axes[0], learner_results, strict=False):
                    name = str(result["name"])
                    matrix = matrices[name]
                    display = np.full_like(matrix, np.nan)
                    display[: phase + 1, :] = matrix[: phase + 1, :]
                    image = ax.imshow(display, vmin=min_value, vmax=max_value, cmap="viridis")
                    ax.set_title(f"{name.upper()}: eval return matrix after phase {phase}")
                    ax.set_xlabel("evaluated obstacle task")
                    ax.set_ylabel("latest trained task phase")
                    ax.set_xticks(range(n_tasks))
                    ax.set_yticks(range(n_tasks))
                    for row in range(phase + 1):
                        for col in range(n_tasks):
                            ax.text(
                                col,
                                row,
                                f"{matrix[row, col]:.1f}",
                                ha="center",
                                va="center",
                                color="white" if matrix[row, col] < (min_value + max_value) / 2 else "black",
                                fontsize=8,
                            )
                    fig.colorbar(image, ax=ax, fraction=0.046, pad=0.04)
                for ax in axes[0, n_learners:]:
                    ax.axis("off")

                phases = np.arange(phase + 1)
                retention_ax = axes[1, 0]
                for result in learner_results:
                    name = str(result["name"])
                    retention_ax.plot(
                        phases,
                        matrices[name][: phase + 1, 0],
                        marker="o",
                        label=name.upper(),
                    )
                    retention_ax.axhline(baselines[name][0], linestyle=":", alpha=0.35)
                retention_ax.set_title("Old-task retention while new obstacles arrive")
                retention_ax.set_xlabel("training phase")
                retention_ax.set_ylabel("task 0 eval return")
                retention_ax.set_xticks(range(n_tasks))
                retention_ax.grid(alpha=0.25)
                retention_ax.legend()

                labels = ["ACC", "Forgetting"]
                x = np.arange(len(labels))
                width = min(0.8 / n_learners, 0.28)
                offset_center = (n_learners - 1) / 2
                metrics_ax = axes[1, 1]
                for idx, result in enumerate(learner_results):
                    metrics = result.get("metrics", {})
                    values = [
                        float(metrics.get("acc", np.nan)),
                        float(metrics.get("forgetting", np.nan)),
                    ]
                    name = str(result["name"])
                    metrics_ax.bar(
                        x + (idx - offset_center) * width,
                        values,
                        width,
                        label=name.upper(),
                    )
                metrics_ax.set_title("Final continual-learning metrics")
                metrics_ax.set_xticks(x)
                metrics_ax.set_xticklabels(labels)
                metrics_ax.grid(alpha=0.25, axis="y")
                metrics_ax.legend()
                for ax in axes[1, 2:]:
                    ax.axis("off")

                cfg = bundle.get("config", {})
                fig.suptitle(
                    "Obstacle-course continual learning: new route adaptation and no-forgetting check\n"
                    f"tasks={cfg.get('n_tasks')} steps/task={cfg.get('steps_per_task')} "
                    f"learners={', '.join(str(result.get('name')) for result in learner_results)}",
                    fontsize=12,
                )
                fig.tight_layout()
                writer.append_data(_frame_rgb(fig))
                plt.close(fig)
    finally:
        writer.close()

    learners_summary = {
        str(result["name"]): {
            "seed": result.get("seed"),
            "metrics": result.get("metrics"),
            "baseline": baselines[str(result["name"])].tolist(),
            "matrix": matrices[str(result["name"])].tolist(),
        }
        for result in learner_results
    }
    summary = {
        "schema": "robot-alberta-obstacle-demo-v1",
        "ok": out_video.is_file() and out_video.stat().st_size > 0,
        "benchmark_dir": str(benchmark_dir),
        "video": str(out_video),
        "video_bytes": out_video.stat().st_size if out_video.is_file() else 0,
        "fps": fps,
        "frames": int(n_tasks * max(1, hold_frames)),
        "n_tasks": n_tasks,
        "learners": list(learners_summary),
        "adaptation": bundle.get("adaptation") if isinstance(bundle.get("adaptation"), dict) else {},
        "learner_results": learners_summary,
    }
    if "alberta" in learners_summary:
        summary["alberta"] = learners_summary["alberta"]
    if "ppo" in learners_summary:
        summary["ppo"] = learners_summary["ppo"]
    if "sac" in learners_summary:
        summary["sac"] = learners_summary["sac"]
    out_json.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "benchmark_dir",
        type=Path,
        nargs="?",
        default=PKG_ROOT / "evidence" / "alberta_obstacle_course",
    )
    parser.add_argument("--out-video", type=Path)
    parser.add_argument("--out-json", type=Path)
    parser.add_argument("--hold-frames", type=int, default=18)
    parser.add_argument("--fps", type=int, default=12)
    args = parser.parse_args(argv)
    report = render_demo(
        args.benchmark_dir,
        out_video=args.out_video,
        out_json=args.out_json,
        hold_frames=args.hold_frames,
        fps=args.fps,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
