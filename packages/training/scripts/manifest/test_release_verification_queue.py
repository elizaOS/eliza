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
            "other": [
                {
                    "name": "4b manifest files cover required runtime artifacts",
                    "detail": "dflash/validation-real.json, evals/dflash-tuning-report.json",
                }
            ],
            "checksumIntegrity": [
                {
                    "name": "4b checksums cover required release files",
                    "detail": "dflash/validation-real.json",
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
        "4b:manifest-runtime-surface",
        "4b:checksum-surface",
        "0_8b:backend:cpu",
        "0_8b:backend:metal",
        "0_8b:backend:vulkan",
        "0_8b:eval-suite",
    ]
    missing = items[0]
    assert missing.requires_hardware is True
    assert "bundles/4b/evals/cuda_verify.json" in missing.evidence
    manifest = items[1]
    assert manifest.requires_hardware is False
    assert manifest.category == "manifestIntegrity"
    assert "bundles/4b/eliza-1.manifest.json" in manifest.evidence
    assert "bundles/4b/dflash/validation-real.json" in manifest.evidence
    assert "bundles/4b/evals/dflash-tuning-report.json" in manifest.evidence
    checksum = items[2]
    assert checksum.requires_hardware is False
    assert checksum.category == "checksumIntegrity"
    assert "bundles/4b/checksums/SHA256SUMS" in checksum.evidence
    cpu = items[3]
    assert cpu.requires_hardware is False
    assert cpu.command.startswith("python3 packages/training/scripts/manifest/release_process_guard.py && ")
    assert "ELIZA_EVAL_ALLOW_CONCURRENT_LLM=0" in cpu.command
    assert "--bundle-dir /bundles/eliza-1-0_8b.bundle" in cpu.command
    assert "make -C plugins/plugin-local-inference/native/verify reference-test" in cpu.command
    assert "evals/cpu_reference.json" in cpu.evidence[1]
    metal = items[4]
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
    assert "python3 packages/training/scripts/manifest/release_process_guard.py &&" in text
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

    assert items[0].command.startswith(
        "python3 packages/training/scripts/manifest/release_process_guard.py && "
        "make -C /verify reference-test"
    )


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
        "/opt/miniconda3/bin/python3 packages/training/scripts/manifest/release_process_guard.py && "
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
    assert items[0].command.startswith("python3 packages/training/scripts/manifest/release_process_guard.py && ")
    assert "plugins/plugin-local-inference/scripts/probe-sd-cpp.mjs --json" in items[0].command
    assert "p.get('requiredAccelerator') == 'vulkan'" in items[0].command
    assert "'vulkan' in p.get('accelerators', [])" in items[0].command
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


def test_build_queue_expands_mtp_and_finetune_blockers() -> None:
    summary = {
        "ok": False,
        "failuresByCategory": {
            "mtpDrafter": [
                {
                    "name": "4b MTP drafter release evidence passed",
                    "detail": "acceptanceRollout.status: 'fail', acceptanceRate: 0.0625 < gate 0.5",
                }
            ],
            "fineTuneComparison": [
                {
                    "name": "fine-tune comparison evidence passed",
                    "detail": "status: 'blocked', comparisons.0_8b: missing",
                }
            ],
        },
    }

    items = build_queue(summary, bundle_root="/bundles", eval_python="python3")

    assert [item.id for item in items] == ["4b:mtp-drafter", "0_8b:fine-tune-comparison"]
    mtp = items[0]
    assert mtp.requires_hardware is True
    assert mtp.category == "mtpDrafter"
    assert mtp.command.startswith("python3 packages/training/scripts/manifest/release_process_guard.py && ")
    assert "scripts/dflash/validate_drafter.py" in mtp.command
    assert "--tier 4b" in mtp.command
    assert "--target-gguf /bundles/eliza-1-4b.bundle/text/eliza-1-4b-256k.gguf" in mtp.command
    assert "--drafter-gguf /bundles/eliza-1-4b.bundle/dflash/drafter-4b.gguf" in mtp.command
    assert "--skip-acceptance-rollout" in mtp.command
    assert "--report-out /bundles/eliza-1-4b.bundle/dflash/validation-real.json" in mtp.command
    assert "dflash_drafter_runtime_smoke.mjs" in mtp.command
    assert "--target-model /bundles/eliza-1-4b.bundle/text/eliza-1-4b-256k.gguf" in mtp.command
    assert "--spec-type dflash" in mtp.command
    assert "--bench --bench-tokens 128 --bench-context 128" in mtp.command
    assert "--report /bundles/eliza-1-4b.bundle/dflash/runtime-smoke-native.json" in mtp.command
    assert "--bench-report /bundles/eliza-1-4b.bundle/evals/dflash-native-bench.json" in mtp.command
    assert "dflash_tuning_report.py" in mtp.command
    assert "bundles/4b/dflash/runtime-smoke-native.json" in mtp.evidence
    assert "bundles/4b/evals/dflash-accept.json" in mtp.evidence
    assert "bundles/4b/evals/dflash-tuning-report.json" in mtp.evidence
    finetune = items[1]
    assert finetune.requires_hardware is True
    assert finetune.category == "fineTuneComparison"
    assert "scripts/run_pipeline.py" in finetune.command
    assert "scripts/benchmark/native_tool_call_bench.py" in finetune.command
    assert "--model checkpoints/eliza-1-0_8b-finetuned-v2/final" in finetune.command
    assert "--test-file /tmp/eliza-1-training/sft/0_8b/test.jsonl" in finetune.command
    assert "--out-dir /tmp/eliza-1-finetune-native-tool-call" in finetune.command
    assert "bundles/0_8b/finetuned-v2/eliza-1-0_8b-sft.gguf" in finetune.evidence


def test_build_queue_maps_27b_256k_mtp_to_validation_tier_27b() -> None:
    summary = {
        "ok": False,
        "failuresByCategory": {
            "mtpDrafter": [
                {
                    "name": "27b-256k MTP drafter release evidence passed",
                    "detail": "acceptanceRate: 0.125 < gate 0.5",
                }
            ],
        },
    }

    items = build_queue(summary, bundle_root="/bundles", eval_python="python3")

    assert [item.id for item in items] == ["27b-256k:mtp-drafter"]
    command = items[0].command
    assert "--tier 27b" in command
    assert "--target-gguf /bundles/eliza-1-27b-256k.bundle/text/eliza-1-27b-256k.gguf" in command
    assert "--drafter-gguf /bundles/eliza-1-27b-256k.bundle/dflash/drafter-27b-256k.gguf" in command


def test_filter_queue_can_select_mtp_hardware_category() -> None:
    summary = {
        "ok": False,
        "failuresByCategory": {
            "mtpDrafter": [
                {
                    "name": "9b MTP drafter release evidence passed",
                    "detail": "acceptanceRate: 0.0833 < gate 0.5",
                },
                {
                    "name": "27b MTP drafter release evidence passed",
                    "detail": "acceptanceRate: 0.125 < gate 0.5",
                },
            ],
        },
    }
    items = build_queue(summary, bundle_root="/bundles", eval_python="python3")

    selected = filter_queue(items, tier="9b", category="mtpDrafter", hardware_only=True)

    assert [item.id for item in selected] == ["9b:mtp-drafter"]


def test_build_queue_expands_release_evidence_blockers() -> None:
    summary = {
        "ok": False,
        "failuresByCategory": {
            "releaseEvidence": [
                {
                    "name": "2b release evidence is publishable",
                    "detail": (
                        "releaseState: 'local-standin', publishEligible: False, "
                        "final.weights: False, final.evals: False, publishBlockingReasons: 7"
                    ),
                }
            ],
        },
    }

    items = build_queue(summary, bundle_root="/bundles", eval_python="python3")

    assert [item.id for item in items] == ["2b:release-evidence"]
    item = items[0]
    assert item.requires_hardware is True
    assert item.category == "releaseEvidence"
    assert "finalize_eliza1_evidence.py /bundles/eliza-1-2b.bundle" in item.command
    assert "publish_eliza1_model_repo.py" in item.command
    assert "--bundles-root /bundles --tier 2b --dry-run" in item.command
    assert "--bundle-dir" not in item.command
    assert "bundles/2b/evidence/release.json" in item.evidence


def test_filter_queue_can_select_release_evidence_category() -> None:
    summary = {
        "ok": False,
        "failuresByCategory": {
            "releaseEvidence": [
                {
                    "name": "0_8b release evidence is publishable",
                    "detail": "publishBlockingReasons: 6",
                },
                {
                    "name": "2b release evidence is publishable",
                    "detail": "publishBlockingReasons: 7",
                },
            ],
        },
    }
    items = build_queue(summary, bundle_root="/bundles", eval_python="python3")

    selected = filter_queue(items, tier="2b", category="releaseEvidence", hardware_only=True)

    assert [item.id for item in selected] == ["2b:release-evidence"]
