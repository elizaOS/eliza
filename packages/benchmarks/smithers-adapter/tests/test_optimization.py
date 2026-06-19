"""Offline tests for GEPA optimization-artifact resolution (optimization.mjs).

`optimization.mjs` is dependency-free, so these drive it with a tiny node/bun
runner — no Smithers install, no model calls.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

_MJS = Path(__file__).resolve().parent.parent / "smithers_adapter" / "optimization.mjs"


def _runtime() -> str:
    runtime = shutil.which("bun") or shutil.which("node")
    if not runtime:
        pytest.skip("node/bun not available")
    return runtime


def _run_driver(driver: str, *args: str) -> object:
    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False) as handle:
        handle.write(driver)
        driver_path = handle.name
    try:
        proc = subprocess.run(
            [_runtime(), driver_path, *args],
            capture_output=True,
            text=True,
            timeout=60,
        )
    finally:
        os.unlink(driver_path)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def _resolve(artifact: object, benchmark: str | None = None) -> object:
    driver = (
        f"import {{ resolveOptimizedSystemPrompt }} from {json.dumps(_MJS.as_uri())};\n"
        "const out = resolveOptimizedSystemPrompt(JSON.parse(process.argv[2]), process.argv[3] || null);\n"
        "process.stdout.write(JSON.stringify(out ?? null));\n"
    )
    return _run_driver(driver, json.dumps(artifact), benchmark or "")


def _load_and_resolve(path: str, benchmark: str | None = None) -> object:
    driver = (
        f"import {{ loadOptimizationArtifact, resolveOptimizedSystemPrompt }} from {json.dumps(_MJS.as_uri())};\n"
        "const a = loadOptimizationArtifact(process.argv[2] || null);\n"
        'const out = a ? resolveOptimizedSystemPrompt(a, process.argv[3] || null) : "__NULL_ARTIFACT__";\n'
        "process.stdout.write(JSON.stringify(out ?? null));\n"
    )
    return _run_driver(driver, path or "", benchmark or "")


def test_patch_matched_by_benchmark_nodeid() -> None:
    artifact = {
        "patches": [
            {"nodeId": "other", "prompt": "wrong"},
            {"nodeId": "bfcl", "prompt": "BFCL optimized prompt."},
        ]
    }
    assert _resolve(artifact, "bfcl") == "BFCL optimized prompt."


def test_patch_matched_by_system_alias() -> None:
    artifact = {"patches": [{"nodeId": "system", "prompt": "Optimized system prompt."}]}
    assert _resolve(artifact, "tau_bench") == "Optimized system prompt."


def test_global_system_prompt() -> None:
    assert _resolve({"systemPrompt": "Global optimized."}, "bfcl") == "Global optimized."


def test_per_benchmark_map_beats_global() -> None:
    artifact = {
        "benchmarks": {"mint": {"systemPrompt": "Mint optimized."}},
        "systemPrompt": "Global optimized.",
    }
    assert _resolve(artifact, "mint") == "Mint optimized."
    assert _resolve(artifact, "bfcl") == "Global optimized."


def test_no_usable_prompt_returns_null() -> None:
    assert _resolve({"patches": []}, "bfcl") is None
    assert _resolve({}, "bfcl") is None
    assert _resolve({"patches": [{"nodeId": "x", "prompt": "  "}]}, "bfcl") is None


def test_loads_artifact_from_file(tmp_path: Path) -> None:
    artifact = tmp_path / "bfcl-gepa.json"
    artifact.write_text(
        json.dumps({"patches": [{"nodeId": "system", "prompt": "Loaded from file."}]}),
        encoding="utf-8",
    )
    assert _load_and_resolve(str(artifact), "bfcl") == "Loaded from file."


def test_missing_artifact_file_is_ignored() -> None:
    # loadOptimizationArtifact returns null for a missing path; the harness then
    # keeps the benchmark's default prompt (sentinel proves the null branch ran).
    assert _load_and_resolve("/nonexistent/does-not-exist.json", "bfcl") == "__NULL_ARTIFACT__"
