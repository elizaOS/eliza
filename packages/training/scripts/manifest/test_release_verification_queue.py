"""Tests for the Eliza-1 one-bundle-at-a-time verification queue."""

from __future__ import annotations

import sys
from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest.release_verification_queue import build_queue, filter_queue, render_markdown  # noqa: E402


def test_build_queue_expands_grouped_audit_failures() -> None:
    summary = {
        "ok": False,
        "failuresByCategory": {
            "missingReleaseFiles": [
                {
                    "name": "4b required release files present",
                    "detail": "evals/cuda_verify.json, evals/rocm_verify.json",
                }
            ],
            "backendVerification": [
                {
                    "name": "0_8b required backend verification passed",
                    "detail": "metal: fail, vulkan: fail, cpu: fail",
                }
            ],
            "manifestEvalGates": [
                {
                    "name": "0_8b manifest eval gates passed",
                    "detail": "evals.textEval.passed: False",
                }
            ],
        },
    }

    items = build_queue(summary, bundle_root="/bundles", eval_python="python3")

    assert [item.id for item in items] == [
        "4b:missing-release-files",
        "0_8b:backend:cpu",
        "0_8b:backend:metal",
        "0_8b:backend:vulkan",
        "0_8b:eval-suite",
    ]
    missing = items[0]
    assert missing.requires_hardware is True
    assert "bundles/4b/evals/cuda_verify.json" in missing.evidence
    cpu = items[1]
    assert cpu.requires_hardware is False
    assert "ELIZA_EVAL_ALLOW_CONCURRENT_LLM=0" in cpu.command
    assert "--bundle-dir /bundles/eliza-1-0_8b.bundle" in cpu.command
    assert "make -C plugins/plugin-local-inference/native/verify reference-test" in cpu.command
    assert "evals/cpu_reference.json" in cpu.evidence[1]
    metal = items[2]
    assert metal.requires_hardware is True
    assert "darwin-arm64-metal" in metal.command
    assert "make -C plugins/plugin-local-inference/native/verify metal-verify dispatch-smoke" in metal.command


def test_render_markdown_names_commands_and_evidence() -> None:
    summary = {
        "ok": False,
        "failuresByCategory": {
            "manifestEvalGates": [
                {
                    "name": "2b manifest eval gates passed",
                    "detail": "evals.thirtyTurnOk: False",
                }
            ]
        },
    }
    items = build_queue(summary, bundle_root="/tmp/bundles", eval_python="python3")

    text = render_markdown(items)

    assert "# Eliza-1 Verification Queue" in text
    assert "## 2b:eval-suite" in text
    assert "bundles/2b/evals/aggregate.json" in text
    assert "ELIZA_EVAL_ALLOW_CONCURRENT_LLM=0 python3 -m scripts.eval.eliza1_eval_suite" in text


def test_filter_queue_selects_next_local_item() -> None:
    summary = {
        "ok": False,
        "failuresByCategory": {
            "backendVerification": [
                {
                    "name": "0_8b required backend verification passed",
                    "detail": "metal: fail, vulkan: fail, cpu: fail",
                },
                {
                    "name": "2b required backend verification passed",
                    "detail": "metal: fail, cpu: fail",
                },
            ],
            "manifestEvalGates": [
                {
                    "name": "0_8b manifest eval gates passed",
                    "detail": "evals.textEval.passed: False",
                }
            ],
        },
    }
    items = build_queue(summary, bundle_root="/bundles", eval_python="python3")

    selected = filter_queue(items, local_only=True, limit=1)

    assert [item.id for item in selected] == ["0_8b:backend:cpu"]


def test_filter_queue_can_select_hardware_for_tier_and_category() -> None:
    summary = {
        "ok": False,
        "failuresByCategory": {
            "backendVerification": [
                {
                    "name": "4b required backend verification passed",
                    "detail": "metal: fail, cuda: skipped, cpu: fail",
                }
            ],
            "manifestEvalGates": [
                {
                    "name": "4b manifest eval gates passed",
                    "detail": "evals.textEval.passed: False",
                }
            ],
        },
    }
    items = build_queue(summary, bundle_root="/bundles", eval_python="python3")

    selected = filter_queue(
        items,
        tier="4b",
        category="backendVerification",
        hardware_only=True,
    )

    assert [item.id for item in selected] == ["4b:backend:metal", "4b:backend:cuda"]


def test_build_queue_accepts_custom_verify_dir() -> None:
    summary = {
        "ok": False,
        "failuresByCategory": {
            "backendVerification": [
                {
                    "name": "0_8b required backend verification passed",
                    "detail": "cpu: fail",
                }
            ],
        },
    }

    items = build_queue(summary, bundle_root="/bundles", verify_dir="/verify", eval_python="python3")

    assert items[0].command.startswith("make -C /verify reference-test")


def test_build_queue_can_use_explicit_eval_python() -> None:
    summary = {
        "ok": False,
        "failuresByCategory": {
            "manifestEvalGates": [
                {
                    "name": "2b manifest eval gates passed",
                    "detail": "evals.textEval.passed: False",
                }
            ]
        },
    }

    items = build_queue(summary, bundle_root="/bundles", eval_python="/opt/miniconda3/bin/python3")

    assert items[0].command.startswith(
        "ELIZA_EVAL_ALLOW_CONCURRENT_LLM=0 /opt/miniconda3/bin/python3 -m scripts.eval.eliza1_eval_suite"
    )


def test_build_queue_expands_imagegen_hardware_evidence() -> None:
    summary = {
        "ok": False,
        "failuresByCategory": {
            "imagegenEvidence": [
                {
                    "name": "imagegen runtime evidence passed",
                    "detail": (
                        "status: 'blocked', probe.accelerators.cuda: missing, "
                        "probe.accelerators.vulkan: missing, smoke.status: 'partial', "
                        "smoke.platforms.cuda.status: 'not-run', "
                        "smoke.platforms.vulkan.status: 'not-run'"
                    ),
                }
            ],
        },
    }

    items = build_queue(summary, bundle_root="/bundles", eval_python="python3")

    assert [item.id for item in items] == ["imagegen:vulkan", "imagegen:cuda"]
    assert all(item.requires_hardware for item in items)
    assert all(item.category == "imagegenEvidence" for item in items)
    assert "plugins/plugin-local-inference/scripts/probe-sd-cpp.mjs --json" in items[0].command
    assert "evidence/imagegen/sd-cpp-runtime.json" in items[0].evidence
    assert "evidence/imagegen/vulkan.json" in items[0].evidence


def test_filter_queue_can_select_imagegen_hardware_category() -> None:
    summary = {
        "ok": False,
        "failuresByCategory": {
            "backendVerification": [
                {
                    "name": "0_8b required backend verification passed",
                    "detail": "vulkan: fail",
                }
            ],
            "imagegenEvidence": [
                {
                    "name": "imagegen runtime evidence passed",
                    "detail": "probe.accelerators.cuda: missing, smoke.platforms.cuda.status: 'not-run'",
                }
            ],
        },
    }
    items = build_queue(summary, bundle_root="/bundles", eval_python="python3")

    selected = filter_queue(items, category="imagegenEvidence", hardware_only=True)

    assert [item.id for item in selected] == ["imagegen:cuda"]
