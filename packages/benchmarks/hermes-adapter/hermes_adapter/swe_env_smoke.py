"""Real smoke evaluator for ``hermes_swe_env``.

The upstream hermes-agent ``HermesSweEnv.evaluate`` implementation currently
writes only an ``eval/placeholder`` metric. This module keeps the benchmark
publishable without accepting that placeholder: it evaluates real
HumanEvalPack Python tasks through the selected harness client and executes the
dataset tests locally.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import textwrap
import time
from pathlib import Path
from typing import Any, Mapping

from .env_runner import HermesEnvResult


_CODE_BLOCK_RE = re.compile(r"```(?:python|py)?\s*(?P<body>.*?)```", re.DOTALL | re.IGNORECASE)


def run_humanevalpack_swe_smoke(
    *,
    output_dir: Path,
    harness: str,
    provider: str,
    model: str,
    max_tasks: int | None,
    timeout_s: float,
) -> HermesEnvResult:
    """Run a real SWE-style smoke eval using HumanEvalPack Python tests."""

    from datasets import load_dataset  # noqa: WPS433

    started = time.monotonic()
    output_dir = Path(output_dir)
    evals_root = output_dir / "evals" / "hermes_swe_env"
    evals_root.mkdir(parents=True, exist_ok=True)
    samples_path = evals_root / "samples.jsonl"
    summary_path = evals_root / "eval-summary.json"

    limit = max_tasks if isinstance(max_tasks, int) and max_tasks > 0 else 1
    dataset = load_dataset("bigcode/humanevalpack", "python", split="test")
    client, server_handle = _build_client(harness=harness, provider=provider, model=model)

    rows: list[dict[str, Any]] = []
    passed = 0
    try:
        for index, item in enumerate(dataset.select(range(min(limit, len(dataset))))):
            task_id = str(item.get("task_id") or f"humanevalpack-python-{index}")
            prompt = _build_prompt(item)
            try:
                reset = getattr(client, "reset", None)
                if callable(reset):
                    reset(task_id=task_id, benchmark="hermes_swe_env")
            except Exception:
                pass
            response = client.send_message(
                prompt,
                context={
                    "benchmark": "hermes_swe_env",
                    "task_id": task_id,
                    "tool_choice": "none",
                    "temperature": 0,
                    "max_tokens": 1024,
                    "system_prompt": (
                        "You are solving a Python HumanEvalPack task. Return only "
                        "working Python code for the requested function."
                    ),
                },
            )
            raw_text = str(getattr(response, "text", "") or "")
            candidate_code = _extract_python(raw_text, prompt=prompt)
            ok, error = _execute_candidate(
                candidate_code=candidate_code,
                item=item,
                timeout_s=min(float(timeout_s), 30.0),
            )
            if ok:
                passed += 1
            rows.append(
                {
                    "task_id": task_id,
                    "harness": harness,
                    "passed": ok,
                    "prompt": prompt,
                    "response": raw_text,
                    "candidate_code": candidate_code,
                    "error": error,
                    "messages": [
                        {"role": "user", "content": prompt},
                        {"role": "assistant", "content": raw_text},
                    ],
                }
            )
    finally:
        stop = getattr(server_handle, "stop", None)
        if callable(stop):
            stop()

    samples_path.write_text(
        "".join(json.dumps(row, ensure_ascii=True) + "\n" for row in rows),
        encoding="utf-8",
    )
    total = len(rows)
    pass_rate = (passed / total) if total else 0.0
    duration_s = time.monotonic() - started
    metrics: dict[str, Any] = {
        "accuracy": pass_rate,
        "pass_rate": pass_rate,
        "passed": passed,
        "total_tasks": total,
        "sample_rows": total,
        "incomplete_rollouts": 0,
        "dataset": "bigcode/humanevalpack/python/test",
        "harness": harness,
    }
    summary_path.write_text(
        json.dumps(
            {
                "metrics": metrics,
                "results": rows,
                "config_general": {"total_evaluation_time_seconds": duration_s},
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return HermesEnvResult(
        env_id="hermes_swe_env",
        score=pass_rate,
        higher_is_better=True,
        samples_path=samples_path,
        summary_path=summary_path,
        duration_s=duration_s,
        metrics=metrics,
    )


def _build_client(*, harness: str, provider: str, model: str) -> tuple[Any, Any | None]:
    if harness == "eliza":
        from eliza_adapter import ElizaClient, ElizaServerManager  # noqa: WPS433

        if not os.environ.get("ELIZA_BENCH_URL"):
            server = ElizaServerManager()
            server.start()
            return server.client, server
        client = ElizaClient()
        client.wait_until_ready(timeout=180)
        return client, None
    if harness == "hermes":
        from hermes_adapter.client import HermesClient  # noqa: WPS433

        return HermesClient(provider=provider or "cerebras", model=model, mode="in_process"), None
    if harness == "openclaw":
        from openclaw_adapter.client import OpenClawClient  # noqa: WPS433

        return (
            OpenClawClient(
                provider=provider or "cerebras",
                model=model,
                direct_openai_compatible=True,
            ),
            None,
        )
    raise ValueError(f"unsupported hermes_swe_env harness: {harness!r}")


def _build_prompt(item: Mapping[str, Any]) -> str:
    return (
        "Complete the Python function below so that it passes the hidden tests.\n"
        "Return only Python code, with no markdown or commentary.\n\n"
        f"{item.get('prompt') or item.get('declaration') or ''}\n"
    )


def _extract_python(text: str, *, prompt: str = "") -> str:
    match = _CODE_BLOCK_RE.search(text)
    if match:
        code = textwrap.dedent(match.group("body")).strip()
        return _with_prompt_imports(code, prompt) + "\n"
    stripped = text.lstrip()
    for opener in ("```python", "```py", "```"):
        if stripped.lower().startswith(opener):
            text = stripped[len(opener) :]
            break
    marker = "from typing"
    if marker in text:
        code = textwrap.dedent(text[text.index(marker) :]).strip()
        return code + "\n"
    code = textwrap.dedent(text).strip()
    return _with_prompt_imports(code, prompt) + "\n"


def _with_prompt_imports(code: str, prompt: str) -> str:
    if not prompt:
        return code
    existing_lines = {line.strip() for line in code.splitlines()}
    imports: list[str] = []
    for line in textwrap.dedent(prompt).splitlines():
        stripped = line.strip()
        if not (stripped.startswith("import ") or stripped.startswith("from ")):
            continue
        if stripped in existing_lines or stripped in imports:
            continue
        imports.append(stripped)
    if not imports:
        return code
    return "\n".join([*imports, code]).strip()


def _execute_candidate(
    *,
    candidate_code: str,
    item: Mapping[str, Any],
    timeout_s: float,
) -> tuple[bool, str | None]:
    test_code = str(item.get("test") or "")
    setup = str(item.get("test_setup") or "")
    program = "\n\n".join(part for part in (candidate_code, setup, test_code) if part.strip())
    with tempfile.TemporaryDirectory(prefix="hermes-swe-env-") as tmp:
        target = Path(tmp) / "candidate.py"
        target.write_text(program, encoding="utf-8")
        proc = subprocess.run(
            ["python3", str(target)],
            cwd=tmp,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    if proc.returncode == 0:
        return True, None
    detail = (proc.stderr or proc.stdout or f"exit code {proc.returncode}").strip()
    return False, detail[-2000:] if detail else f"exit code {proc.returncode}"
