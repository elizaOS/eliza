"""Run hermes-agent's native benchmark environments as new top-level benchmarks.

Each hermes-agent ``BaseEnv`` subclass exposes a CLI via the ``BaseEnv.cli()``
classmethod (registered in atroposlib). The canonical invocation is::

    python <env_module_path> evaluate --config <yaml>

The env writes its results — both ``samples.jsonl`` and an
``eval-summary.json`` — under ``<config.env.data_dir_to_save_evals>``. We
override ``data_dir_to_save_evals`` to point inside ``output_dir`` so we can
locate the artifacts deterministically.

The four supported env_ids are mapped to their module paths in
:data:`ENV_MODULES`. Pass ``extra_args`` to forward additional flags
(``--env.task_filter``, ``--openai.model_name``, etc.) to the underlying CLI.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


DEFAULT_REPO_PATH = Path.home() / ".eliza" / "agents" / "hermes-agent-src"


# Maps the public env_id we expose to the CLI module path inside the
# hermes-agent repo. These are passed as the script argument to
# ``python <module_path> evaluate``.
ENV_MODULES: dict[str, str] = {
    "tblite": "environments/benchmarks/tblite/tblite_env.py",
    "terminalbench_2": "environments/benchmarks/terminalbench_2/terminalbench2_env.py",
    "yc_bench": "environments/benchmarks/yc_bench/yc_bench_env.py",
    "hermes_swe_env": "environments/hermes_swe_env/hermes_swe_env.py",
}


@dataclass(frozen=True)
class HermesEnvResult:
    """Normalized result of running a single hermes-agent env."""

    env_id: str
    score: float
    higher_is_better: bool
    samples_path: Path
    summary_path: Path
    duration_s: float
    metrics: dict[str, Any]


def build_evaluate_command(
    env_id: str,
    *,
    venv_python: Path,
    repo_path: Path,
    output_dir: Path,
    model: str,
    extra_args: list[str] | None = None,
) -> list[str]:
    """Construct the exact argv used to invoke a hermes-agent eval.

    Exposed for unit tests so they can inspect the command shape without
    actually spawning the subprocess.
    """
    if env_id not in ENV_MODULES:
        raise ValueError(
            f"Unknown hermes env_id {env_id!r}; expected one of {sorted(ENV_MODULES)}"
        )
    module_path = repo_path / ENV_MODULES[env_id]
    save_dir = output_dir / "evals" / env_id
    cmd = [
        str(venv_python),
        "-u",
        str(module_path),
        "evaluate",
        f"--openai.model_name={model}",
        f"--env.data_dir_to_save_evals={save_dir}",
        "--env.use_wandb=false",
    ]
    if extra_args:
        cmd.extend(extra_args)
    return cmd


def run_hermes_env(
    env_id: str,
    *,
    output_dir: Path,
    provider: str = "cerebras",
    model: str = "gpt-oss-120b",
    api_key: str | None = None,
    base_url: str | None = None,
    repo_path: Path | None = None,
    max_tasks: int | None = None,
    extra_args: list[str] | None = None,
    timeout_s: float = 7200.0,
) -> HermesEnvResult:
    """Run one of the four native hermes-agent envs and return a normalized result.

    Sets the env vars expected by hermes-agent's server config::

        OPENAI_BASE_URL = <base_url>
        OPENAI_API_KEY  = <api_key>
        OPENAI_MODEL    = <model>
        TERMINAL_ENV    = local   # default — override via extra_args if needed

    The env writes ``samples.jsonl`` and ``eval-summary.json`` under
    ``output_dir/evals/<env_id>/...``. We locate them, parse the summary, and
    return a :class:`HermesEnvResult`.
    """
    del provider  # accepted for API parity; OpenAI-compatible only for now
    if env_id not in ENV_MODULES:
        raise ValueError(
            f"Unknown env_id {env_id!r}; expected one of {sorted(ENV_MODULES)}"
        )

    repo = Path(repo_path) if repo_path else DEFAULT_REPO_PATH
    venv_python = repo / ".venv" / "bin" / "python"
    if not venv_python.exists():
        raise FileNotFoundError(
            f"hermes-agent venv python not found at {venv_python}. "
            f"Did you run `python -m venv .venv && pip install -e .` in {repo}?"
        )

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    resolved_api_key = api_key if api_key is not None else os.environ.get("CEREBRAS_API_KEY", "")
    resolved_base_url = (
        base_url
        if base_url is not None
        else os.environ.get("CEREBRAS_BASE_URL", "https://api.cerebras.ai/v1")
    )

    forwarded_args: list[str] = list(extra_args or [])
    if max_tasks is not None:
        # hermes-agent envs accept max_eval_samples via the standard
        # BaseEnvConfig fields. Different envs expose different names; the
        # safest, env-wide knob is the generic group/eval size cap. Callers
        # who want tighter control can pass --env.task_filter via extra_args.
        forwarded_args.append(f"--env.max_eval_samples={int(max_tasks)}")

    cmd = build_evaluate_command(
        env_id,
        venv_python=venv_python,
        repo_path=repo,
        output_dir=output_dir,
        model=model,
        extra_args=forwarded_args,
    )

    env = {**os.environ}
    env["OPENAI_API_KEY"] = resolved_api_key
    env["OPENAI_BASE_URL"] = resolved_base_url
    env["OPENAI_MODEL"] = model
    env.setdefault("TERMINAL_ENV", "local")
    env.setdefault("PYTHONUNBUFFERED", "1")

    stdout_path = output_dir / f"{env_id}.stdout.log"
    stderr_path = output_dir / f"{env_id}.stderr.log"

    logger.info("Running hermes env %s: %s", env_id, " ".join(cmd))
    start = time.monotonic()
    with open(stdout_path, "w", encoding="utf-8") as stdout_f, open(
        stderr_path, "w", encoding="utf-8"
    ) as stderr_f:
        try:
            completed = subprocess.run(  # noqa: S603
                cmd,
                cwd=str(repo),
                env=env,
                stdout=stdout_f,
                stderr=stderr_f,
                text=True,
                timeout=timeout_s,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(
                f"hermes env {env_id} timed out after {timeout_s}s. "
                f"stdout={stdout_path}, stderr={stderr_path}"
            ) from exc
    duration = time.monotonic() - start

    if completed.returncode != 0:
        tail = stderr_path.read_text(encoding="utf-8", errors="replace")[-4000:]
        raise RuntimeError(
            f"hermes env {env_id} exited rc={completed.returncode}. "
            f"stderr tail:\n{tail}\n(full: {stderr_path})"
        )

    return parse_hermes_env_result(
        env_id=env_id,
        evals_root=output_dir / "evals" / env_id,
        duration_s=duration,
    )


def parse_hermes_env_result(
    env_id: str,
    *,
    evals_root: Path,
    duration_s: float,
) -> HermesEnvResult:
    """Parse the samples.jsonl + eval-summary.json hermes-agent writes.

    Public for tests so they can feed in a fake directory structure.
    """
    evals_root = Path(evals_root)
    summary_path = _find_first(evals_root, "eval-summary.json") or _find_first(
        evals_root, "summary.json"
    )
    samples_path = _find_first(evals_root, "samples.jsonl")
    if summary_path is None or samples_path is None:
        raise FileNotFoundError(
            f"hermes env {env_id} did not produce expected artifacts under {evals_root}. "
            f"Looked for eval-summary.json + samples.jsonl. "
            f"Found summary={summary_path}, samples={samples_path}"
        )

    summary_raw = json.loads(summary_path.read_text(encoding="utf-8"))
    metrics = _coerce_metrics(summary_raw)
    score, higher_is_better = _pick_score(metrics)

    return HermesEnvResult(
        env_id=env_id,
        score=score,
        higher_is_better=higher_is_better,
        samples_path=samples_path,
        summary_path=summary_path,
        duration_s=float(duration_s),
        metrics=metrics,
    )


def _find_first(root: Path, filename: str) -> Path | None:
    if not root.exists():
        return None
    matches = sorted(root.rglob(filename))
    return matches[0] if matches else None


def _coerce_metrics(summary_raw: object) -> dict[str, Any]:
    """Extract a metrics dict from the eval-summary.json shape.

    atroposlib's ``evaluate_log`` writes a dict with at minimum a ``metrics``
    key. Some envs put metrics at the top level instead. Handle both.
    """
    if isinstance(summary_raw, dict):
        nested = summary_raw.get("metrics")
        if isinstance(nested, dict):
            return dict(nested)
        return dict(summary_raw)
    return {}


def _pick_score(metrics: dict[str, Any]) -> tuple[float, bool]:
    """Pick the canonical score from a metrics dict.

    Preference order: ``accuracy`` > ``pass_rate`` > ``mean_reward`` >
    ``reward`` > ``score``. Falls back to ``0.0`` when nothing recognisable
    is present. All recognised scores are higher-is-better.
    """
    for key in ("accuracy", "pass_rate", "mean_reward", "reward", "score"):
        val = metrics.get(key)
        if isinstance(val, (int, float)):
            return float(val), True
    return 0.0, True
