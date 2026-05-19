"""Tests for the metadata-only Hugging Face Eliza-1 release audit."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Mapping

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest.audit_hf_eliza1_release import (  # noqa: E402
    DATASET_API,
    ACTIVE_TEXT_SFT_REQUIRED_FILES,
    ACTIVE_TEXT_SFT_ROOT,
    DATASET_SPLITS_API,
    FINETUNE_COMPARISON_EVIDENCE_PATH,
    IMAGEGEN_RUNTIME_EVIDENCE_PATH,
    MODEL_API,
    NATIVE_UPSTREAM_REVIEW_PATH,
    QUANTIZATION_SIDECARS,
    TEXT_CONTEXT_VARIANT_EVIDENCE_PATH,
    audit_hf_release,
)
from scripts.manifest.eliza1_manifest import (  # noqa: E402
    ELIZA_1_HF_REPO,
    ELIZA_1_TIERS,
    SUPPORTED_BACKENDS_BY_TIER,
)
from scripts.manifest.eliza1_platform_plan import build_plan  # noqa: E402
from scripts.quantization._kernel_manifest import kernel_manifest_fragment  # noqa: E402


DATASET_REPO = "elizaos/eliza-1-training"


def _api_url(template: str, repo: str) -> str:
    from urllib.parse import quote

    safe = "/" if "{repo}" in template.split("?", 1)[0] else ""
    return template.format(repo=quote(repo, safe=safe))


def _siblings(
    paths: list[str],
    *,
    lfs_sha256s: Mapping[str, str] | None = None,
    sha: str = "test-revision",
) -> dict[str, Any]:
    siblings: list[dict[str, Any]] = []
    for path in paths:
        item: dict[str, Any] = {"rfilename": path}
        if lfs_sha256s and path in lfs_sha256s:
            item["lfs"] = {"sha256": lfs_sha256s[path], "size": 1}
        siblings.append(item)
    return {"sha": sha, "siblings": siblings}


def _complete_model_paths() -> list[str]:
    paths: list[str] = [
        "README.md",
        NATIVE_UPSTREAM_REVIEW_PATH,
        IMAGEGEN_RUNTIME_EVIDENCE_PATH,
        FINETUNE_COMPARISON_EVIDENCE_PATH,
        TEXT_CONTEXT_VARIANT_EVIDENCE_PATH,
    ]
    for tier, tier_plan in build_plan().items():
        paths.append(f"bundles/{tier}/eliza-1.manifest.json")
        paths.extend(f"bundles/{tier}/{rel}" for rel in tier_plan.required_files)
        paths.extend(
            f"bundles/{tier}/{target.evidence_path}"
            for target in tier_plan.required_platform_evidence
        )
    return sorted(set(paths))


def _complete_dataset_paths() -> list[str]:
    return [
        "README.md",
        "manifest.json",
        "train.jsonl",
        "val.jsonl",
        "test.jsonl",
        "data/train-00000-of-00001.parquet",
        "data/validation-00000-of-00001.parquet",
        "data/test-00000-of-00001.parquet",
        "pipeline/docs/training/eliza1-smallest-finetunes.md",
        *ACTIVE_TEXT_SFT_REQUIRED_FILES,
        "validation/eliza1-trajectories-20260513-root-validation.json",
        "validation/eliza1-training-live-audit-2026-05-19.json",
    ]


def _fetcher(
    *,
    model_paths: list[str] | None = None,
    model_lfs_sha256s: Mapping[str, str] | None = None,
    dataset_paths: list[str] | None = None,
    dataset_sha: str = "test-revision",
    splits: list[str] | None = None,
):
    payloads: dict[str, Mapping[str, Any]] = {
        _api_url(MODEL_API, ELIZA_1_HF_REPO): _siblings(
            model_paths if model_paths is not None else _complete_model_paths(),
            lfs_sha256s=model_lfs_sha256s,
        ),
        _api_url(DATASET_API, DATASET_REPO): _siblings(
            dataset_paths if dataset_paths is not None else _complete_dataset_paths(),
            sha=dataset_sha,
        ),
        _api_url(DATASET_SPLITS_API, DATASET_REPO): {
            "splits": [
                {"dataset": DATASET_REPO, "config": "default", "split": split}
                for split in (splits if splits is not None else ["train", "validation", "test"])
            ]
        },
    }

    def fetch(url: str) -> Mapping[str, Any]:
        return payloads[url]

    return fetch


def _text_fetcher(
    *,
    model_readme: str | None = None,
    upstream_review: str | None = None,
    text_context_variants: str | None = None,
    imagegen_runtime: str | None = None,
    finetune_comparison: str | None = None,
    readme: str = "Eliza-1 training dataset\n",
    manifest: str | None = None,
    validation_report: str | None = None,
    dataset_live_audit: str | None = None,
    active_sft_manifest: str | None = None,
    active_sft_validation: str | None = None,
    model_manifests: Mapping[str, str] | None = None,
    dflash_target_meta: Mapping[str, str] | None = None,
    release_evidence: Mapping[str, str] | None = None,
    aggregate_reports: Mapping[str, str] | None = None,
    platform_evidence: Mapping[str, str] | None = None,
    quantization_sidecars: Mapping[str, str] | None = None,
):
    payloads = {
        "https://huggingface.co/elizaos/eliza-1/raw/main/README.md": model_readme
        if model_readme is not None
        else _passing_model_readme(),
        f"https://huggingface.co/elizaos/eliza-1/raw/main/{NATIVE_UPSTREAM_REVIEW_PATH}": upstream_review
        if upstream_review is not None
        else _passing_upstream_review(),
        f"https://huggingface.co/elizaos/eliza-1/raw/main/{TEXT_CONTEXT_VARIANT_EVIDENCE_PATH}": text_context_variants
        if text_context_variants is not None
        else _passing_text_context_variants(),
        f"https://huggingface.co/elizaos/eliza-1/raw/main/{IMAGEGEN_RUNTIME_EVIDENCE_PATH}": imagegen_runtime
        if imagegen_runtime is not None
        else _passing_imagegen_runtime(),
        f"https://huggingface.co/elizaos/eliza-1/raw/main/{FINETUNE_COMPARISON_EVIDENCE_PATH}": finetune_comparison
        if finetune_comparison is not None
        else _passing_finetune_comparison(),
        "https://huggingface.co/datasets/elizaos/eliza-1-training/raw/main/README.md": readme,
        "https://huggingface.co/datasets/elizaos/eliza-1-training/raw/main/manifest.json": manifest
        if manifest is not None
        else _passing_dataset_manifest(),
        "https://huggingface.co/datasets/elizaos/eliza-1-training/raw/main/validation/eliza1-trajectories-20260513-root-validation.json": validation_report
        if validation_report is not None
        else _passing_dataset_validation_report(),
        "https://huggingface.co/datasets/elizaos/eliza-1-training/raw/main/validation/eliza1-training-live-audit-2026-05-19.json": dataset_live_audit
        if dataset_live_audit is not None
        else _passing_dataset_live_audit(),
        f"https://huggingface.co/datasets/elizaos/eliza-1-training/raw/main/{ACTIVE_TEXT_SFT_ROOT}/manifest.json": active_sft_manifest
        if active_sft_manifest is not None
        else _passing_active_sft_manifest(),
        f"https://huggingface.co/datasets/elizaos/eliza-1-training/raw/main/{ACTIVE_TEXT_SFT_ROOT}/validation.json": active_sft_validation
        if active_sft_validation is not None
        else _passing_active_sft_validation(),
    }
    for tier in ELIZA_1_TIERS:
        payloads[
            f"https://huggingface.co/elizaos/eliza-1/raw/main/bundles/{tier}/eliza-1.manifest.json"
        ] = (
            model_manifests[tier]
            if model_manifests and tier in model_manifests
            else _passing_model_manifest(tier)
        )
        payloads[
            f"https://huggingface.co/elizaos/eliza-1/raw/main/bundles/{tier}/checksums/SHA256SUMS"
        ] = "\n".join(
            f"{'a' * 64}  {rel}" for rel in build_plan()[tier].required_files
        ) + "\n"
        payloads[
            f"https://huggingface.co/elizaos/eliza-1/raw/main/bundles/{tier}/dflash/target-meta.json"
        ] = (
            dflash_target_meta[tier]
            if dflash_target_meta and tier in dflash_target_meta
            else _passing_dflash_target_meta(tier)
        )
        payloads[
            f"https://huggingface.co/elizaos/eliza-1/raw/main/bundles/{tier}/evidence/release.json"
        ] = (
            release_evidence[tier]
            if release_evidence and tier in release_evidence
            else _passing_release_evidence(tier)
        )
        payloads[
            f"https://huggingface.co/elizaos/eliza-1/raw/main/bundles/{tier}/evals/aggregate.json"
        ] = (
            aggregate_reports[tier]
            if aggregate_reports and tier in aggregate_reports
            else '{"passed":true,"gateReport":{"passed":true,"failures":[]}}\n'
        )
        for target in build_plan()[tier].required_platform_evidence:
            repo_path = f"bundles/{tier}/{target.evidence_path}"
            payloads[f"https://huggingface.co/elizaos/eliza-1/raw/main/{repo_path}"] = (
                platform_evidence[repo_path]
                if platform_evidence and repo_path in platform_evidence
                else _passing_platform_evidence(tier, target.id, target.backend)
            )
        for rel, method in QUANTIZATION_SIDECARS.items():
            repo_path = f"bundles/{tier}/{rel}"
            payloads[f"https://huggingface.co/elizaos/eliza-1/raw/main/{repo_path}"] = (
                quantization_sidecars[repo_path]
                if quantization_sidecars and repo_path in quantization_sidecars
                else _passing_quantization_sidecar(tier, method)
            )

    def fetch(url: str) -> str:
        return payloads[url]

    return fetch


def _passing_model_readme() -> str:
    return "\n".join(
        [
            "# Eliza-1",
            "Runtime bundles: `bundles/0_8b/`, `bundles/2b/`, `bundles/4b/`, "
            "`bundles/9b/`, `bundles/27b/`, `bundles/27b-256k/`.",
            "Training data and fine-tuning examples are in `elizaos/eliza-1-training`.",
            "Each text tier ships native context and half context variants.",
            "The runtime includes image generation, structured response handling, "
            "MTP, DFlash, llama.cpp, omnivoice.cpp, and stable-diffusion.cpp.",
        ]
    )


def _passing_upstream_review() -> str:
    return "\n".join(
        [
            "# Native Upstream Review",
            "## llama.cpp",
            "- Upstream HEAD checked: abc123",
            "- Performance/platform commits to review: MTP cleanup and streaming fixes.",
            "- Release impact: MTP, streaming, Vulkan, and CUDA verification.",
            "- Next action: review and rerun backend matrix.",
            "## omnivoice.cpp",
            "- Upstream HEAD checked: def456",
            "- Performance/platform commits to review: CUDA and Vulkan voice runtime fixes.",
            "- Release impact: voice acceleration and memory behavior.",
            "- Next action: rebuild and rerun voice smoke tests.",
            "## stable-diffusion.cpp",
            "- Upstream HEAD checked: fed789",
            "- Performance/platform commits to review: memory mapping and max VRAM.",
            "- Release impact: image generation memory and platform support.",
            "- Next action: pin binary and rerun imagegen checks.",
        ]
    )


def _passing_text_context_variants() -> str:
    results = []
    for tier, tier_plan in build_plan().items():
        required = []
        for ctx in tier_plan.contexts:
            tokens = int(ctx[:-1]) * 1024
            if tier == "27b-256k":
                rel = f"text/eliza-1-27b-{ctx}.gguf"
            else:
                rel = f"text/eliza-1-{tier}-{ctx}.gguf"
            required.append(
                {
                    "context": ctx,
                    "expectedCtxTokens": tokens,
                    "path": f"bundles/{tier}/{rel}",
                    "existsOnHub": True,
                    "lfsSha256": "a" * 64,
                    "manifestEntry": {
                        "ctx": tokens,
                        "path": rel,
                        "sha256": "a" * 64,
                    },
                    "blockers": [],
                }
            )
        results.append(
            {
                "tier": tier,
                "requiredContexts": required,
                "extraTextGgufs": [],
                "passed": True,
            }
        )
    return __import__("json").dumps(
        {
            "schema": "eliza.eliza1_text_context_variant_audit.v1",
            "repo": ELIZA_1_HF_REPO,
            "passed": True,
            "expectedContexts": ["128k", "256k"],
            "blockers": [],
            "legacy27b1mPaths": [],
            "results": results,
        }
    )


def _passing_imagegen_runtime() -> str:
    return __import__("json").dumps(
        {
            "schemaVersion": 1,
            "status": "pass",
            "runtime": {
                "engine": "stable-diffusion.cpp",
                "upstreamRepo": "leejet/stable-diffusion.cpp",
                "upstreamCommit": "abc123",
                "binaryVersion": "stable-diffusion.cpp abc123",
            },
            "probe": {
                "available": True,
                "supportedModels": [
                    "imagegen-sd-1_5-q5_0",
                    "imagegen-z-image-turbo-q4_k_m",
                ],
                "accelerators": ["cpu", "cuda", "vulkan", "metal"],
            },
            "memory": {
                "mmap": True,
                "maxVramAuto": True,
                "segmentedOffload": True,
            },
            "smoke": {
                "status": "pass",
                "platforms": {
                    "cpu": {"status": "pass", "report": "evidence/imagegen/cpu.json"},
                    "cuda": {"status": "pass", "report": "evidence/imagegen/cuda.json"},
                    "vulkan": {"status": "pass", "report": "evidence/imagegen/vulkan.json"},
                    "metal": {"status": "pass", "report": "evidence/imagegen/metal.json"},
                },
                "models": {
                    "0_8b/sd-1.5-Q5_0.gguf": {
                        "status": "pass",
                        "report": "evidence/imagegen/sd15-0_8b-metal-smoke.json",
                    },
                    "9b/z-image-turbo-Q4_K_M.gguf": {
                        "status": "pass",
                        "report": "evidence/imagegen/zimage-9b-metal-smoke.json",
                    },
                },
            },
        }
    )


def _passing_finetune_comparison() -> str:
    return __import__("json").dumps(
        {
            "schemaVersion": 1,
            "status": "pass",
            "modelRepo": "elizaos/eliza-1",
            "datasetRepo": DATASET_REPO,
            "baselineReleaseState": "base-v1",
            "fineTunedReleaseState": "finetuned-v2",
            "activeTiers": list(ELIZA_1_TIERS),
            "comparisons": {
                "0_8b": {
                    "baselineModel": "bundles/0_8b/text/eliza-1-0_8b-128k.gguf",
                    "fineTunedModel": "bundles/0_8b/finetuned-v2/eliza-1-0_8b-sft.gguf",
                    "passed": True,
                    "beatsBaseline": True,
                    "reports": {
                        "eliza_bench": "evidence/training/0_8b/eliza-bench.json",
                        "native_tool_call": "evidence/training/0_8b/native-tool-call.json",
                        "structured_response": "evidence/training/0_8b/structured-response.json",
                    },
                }
            },
        }
    )


def _passing_platform_evidence(tier: str, target: str, backend: str) -> str:
    return __import__("json").dumps(
        {
            "schemaVersion": 1,
            "tier": tier,
            "target": target,
            "backend": backend,
            "status": "pass",
            "report": f"evidence/platform/{target}-verify.json",
            "device": f"verified {target}",
            "atCommit": "abc123",
        }
    )


def _passing_quantization_sidecar(tier: str, method: str) -> str:
    sidecar: dict[str, object] = {
        "schemaVersion": 1,
        "tier": tier,
        "method": method,
        "status": "release-sidecar",
        "contexts": list(build_plan()[tier].contexts),
        "source_model": f"elizaos/eliza-1/bundles/{tier}",
        "kernel_manifest": kernel_manifest_fragment(method),
    }
    if method in {"turboquant", "fused-turboquant"}:
        sidecar["text_quant"] = build_plan()[tier].text_quant
    return __import__("json").dumps(sidecar)


def _passing_dataset_manifest() -> str:
    return __import__("json").dumps(
        {
            "schema": "eliza.eliza1_training_manifest.v2",
            "datasetSchema": "eliza_native_v1",
            "recordSchema": "eliza.eliza1_trajectory_record.v1",
            "contract": {
                "rootJsonlSplitsAreCanonical": True,
                "parquetSplitsAreViewerMirrors": True,
                "datasetViewerCompatible": True,
                "legacyMillionToken27bPresent": False,
                "trainLocalReady": True,
                "trainingReadySchema": "eliza_native_v1",
            },
            "validation": {
                "schema": "eliza.eliza1_trajectory_validation_report.v1",
                "reportPath": "validation/eliza1-trajectories-20260513-root-validation.json",
                "totalRecords": 1426,
                "validRecords": 1426,
                "invalidRecords": 0,
                "errorsByCode": {},
            },
            "privacy": {
                "reviewed": True,
                "realUserExport": False,
                "attestationSource": "cli_flag",
                "note": "Human privacy review attested before write/push.",
            },
        }
    )


def _passing_dataset_validation_report() -> str:
    return __import__("json").dumps(
        {
            "schema": "eliza.eliza1_trajectory_validation_report.v1",
            "recordSchema": "eliza.eliza1_trajectory_record.v1",
            "totalRecords": 1426,
            "validRecords": 1426,
            "invalidRecords": 0,
            "errorsByCode": {},
            "errorsByFile": {},
            "errorsBySourceKind": {},
            "firstFailures": [],
        }
    )


def _passing_dataset_live_audit() -> str:
    return __import__("json").dumps(
        {
            "schema": "eliza.eliza1_training_dataset_live_audit.v1",
            "datasetRepo": DATASET_REPO,
            "datasetRevision": "test-revision",
            "passed": True,
            "validation": __import__("json").loads(_passing_dataset_validation_report()),
            "rowCounts": {
                "train.jsonl": 1140,
                "val.jsonl": 143,
                "test.jsonl": 143,
            },
            "hashMismatches": [],
            "legacy27b1m": {
                "passed": True,
                "pathOrRowHits": [],
                "readmeHits": [],
            },
            "secretScan": {
                "passed": True,
                "hits": {
                    "hf_token": 0,
                    "openai_key": 0,
                    "aws_access_key": 0,
                    "private_key_header": 0,
                },
            },
        }
    )


def _passing_active_sft_manifest() -> str:
    return __import__("json").dumps(
        {
            "schema": "eliza.eliza1_sft_0_8b_manifest.v1",
            "base_model": "Qwen/Qwen3.5-0.8B",
            "published_name": "eliza-1-0_8b",
            "counts": {"train": 116, "val": 6, "test": 3, "total": 125},
            "privacy_filter": {
                "backend": "privacy_filter_trajectories.redact_value (canonical inline filter)",
                "rows_changed": True,
                "markers_introduced": 10,
                "real_user_trajectories_consumed": 0,
            },
            "cerebras_augmented": 0,
        }
    )


def _passing_active_sft_validation() -> str:
    return __import__("json").dumps(
        {
            "schema": "eliza.eliza1_sft_0_8b_validation.v1",
            "passed": True,
            "blockers": [],
            "splits": {
                "train": {"rows": 116, "sha256": "a" * 64},
                "val": {"rows": 6, "sha256": "b" * 64},
                "test": {"rows": 3, "sha256": "c" * 64},
            },
        }
    )


def _passing_dflash_target_meta(tier: str) -> str:
    return __import__("json").dumps(
        {
            "schemaVersion": 3,
            "tier": tier,
            "status": "runtime-accepted",
            "publishEligible": True,
            "targetText": {
                "path": f"text/eliza-1-{tier}-128k.gguf",
                "sha256": "a" * 64,
                "finalElizaWeights": True,
            },
            "drafter": {
                "path": f"dflash/drafter-{tier}.gguf",
                "sha256": "b" * 64,
                "finalElizaWeights": True,
                "matchesTargetCheckpoint": True,
                "provenance": "dflash-drafter:h200-kd-runtime-accepted",
            },
            "acceptanceRate": 0.72,
            "acceptanceRollout": {"status": "pass", "gate": 0.48},
            "acceptanceWindow": {
                "draftedTokens": 2000,
                "acceptedTokens": 1440,
            },
        }
    )


def _passing_release_evidence(tier: str) -> str:
    required_weights = sorted(
        rel
        for rel in build_plan()[tier].required_files
        if rel.split("/", 1)[0]
        in {"text", "tts", "asr", "vad", "imagegen", "vision", "dflash", "embedding", "wakeword"}
    )
    return __import__("json").dumps(
        {
            "schemaVersion": 1,
            "tier": tier,
            "repoId": ELIZA_1_HF_REPO,
            "releaseState": "base-v1",
            "publishEligible": True,
            "finetuned": False,
            "final": {
                "weights": False,
                "hashes": True,
                "evals": True,
                "licenses": True,
                "kernelDispatchReports": True,
                "platformEvidence": True,
                "sizeFirstRepoIds": True,
            },
            "weights": required_weights,
            "checksumManifest": "checksums/SHA256SUMS",
            "publishBlockingReasons": [],
            "structuredResponse": {
                "status": "pass",
                "handler": "HANDLE_RESPONSE",
                "rules": [
                    "handle-response-tool-call",
                    "closed-action-enum",
                    "eliza-schema-guided-decode",
                    "dflash-prefill",
                    "deterministic-repair",
                ],
                "testReports": {
                    "plannerGrammar": "plugins/plugin-local-inference/src/services/__tests__/planner-grammar.test.ts",
                    "structuredOutput": "plugins/plugin-local-inference/src/services/structured-output.test.ts",
                    "dflashStructured": "plugins/plugin-local-inference/src/services/dflash-structured.test.ts",
                    "deterministicRepair": "plugins/plugin-local-inference/src/services/structured-output/deterministic-repair.test.ts",
                },
            },
            "hf": {
                "repoId": ELIZA_1_HF_REPO,
                "pathPrefix": f"bundles/{tier}",
                "status": "uploaded",
                "uploadEvidence": {
                    "repoId": ELIZA_1_HF_REPO,
                    "commit": "abc123",
                    "url": f"https://huggingface.co/{ELIZA_1_HF_REPO}/commit/abc123",
                    "uploadedPaths": [f"bundles/{tier}/eliza-1.manifest.json"],
                },
            },
        }
    )


def _passing_model_manifest(tier: str) -> str:
    files_by_dir: dict[str, list[dict[str, object]]] = {}
    for rel in build_plan()[tier].required_files:
        root = rel.split("/", 1)[0]
        entry: dict[str, object] = {"path": rel, "sha256": "a" * 64}
        if root == "text" and "-128k" in rel:
            entry["ctx"] = 131072
        elif root == "text" and "-256k" in rel:
            entry["ctx"] = 262144
        files_by_dir.setdefault(root, []).append(entry)
    return __import__("json").dumps(
        {
            "tier": tier,
            "lineage": {
                "text": {"base": f"Qwen/{tier}", "license": "apache-2.0"},
                "voice": {"base": "Qwen/Qwen3-TTS", "license": "apache-2.0"},
                "asr": {"base": "ggml-org/Qwen3-ASR-0.6B-GGUF", "license": "apache-2.0"},
                "vad": {"base": "voice/vad/silero-vad-v5.gguf", "license": "mit"},
                "imagegen": {
                    "base": (
                        "second-state/stable-diffusion-v1-5-GGUF"
                        if tier in {"0_8b", "2b", "4b"}
                        else "city96/z-image-turbo-gguf"
                    ),
                    "license": "model license",
                },
                "vision": {"base": "Qwen/Qwen3-VL", "license": "apache-2.0"},
                "drafter": {"base": f"eliza-1-{tier}-drafter", "license": "apache-2.0"},
            },
            "files": files_by_dir,
            "kernels": {
                "verifiedBackends": {
                    backend: {
                        "status": "pass",
                        "atCommit": "abc123",
                        "report": (
                            "evals/cpu_reference.json"
                            if backend == "cpu"
                            else f"evals/{backend}_verify.json"
                        ),
                    }
                    for backend in SUPPORTED_BACKENDS_BY_TIER[tier]
                }
            },
            "evals": {
                "textEval": {"passed": True},
                "voiceRtf": {"passed": True},
                "e2eLoopOk": True,
                "thirtyTurnOk": True,
                "asrWer": {"passed": True},
                "vadLatencyMs": {"passed": True},
            },
        }
    )


def test_complete_hf_release_audit_passes() -> None:
    report = audit_hf_release(fetch_json=_fetcher(), fetch_text=_text_fetcher())
    assert report.ok, report.render()
    checked_tiers = {
        check["name"].split(" ", 1)[0]
        for check in report.checks
        if check["name"].endswith("required release files present")
    }
    assert checked_tiers == set(ELIZA_1_TIERS)


def test_hf_release_audit_blocks_removed_27b_1m_model_artifacts() -> None:
    report = audit_hf_release(
        fetch_json=_fetcher(model_paths=[*_complete_model_paths(), "bundles/27b-1m/README.md"]),
        fetch_text=_text_fetcher(),
    )
    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(check["name"] == "model repo has no removed 27B-1m tier artifacts" for check in failed)


def test_hf_release_audit_requires_complete_model_readme() -> None:
    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(
            model_readme="# Eliza-1\nOnly `bundles/27b-256k/` is documented.\n"
        ),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "model README content passed"
        and "bundles/0_8b/: missing" in check["detail"]
        and "elizaos/eliza-1-training: missing" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_legacy_tier_mentions_in_model_readme() -> None:
    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(model_readme=_passing_model_readme() + "\nLegacy: 27B-1m\n"),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "model README content passed"
        and "removed 27B-1m tier referenced" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_native_upstream_review_evidence_file() -> None:
    paths = _complete_model_paths()
    paths.remove(NATIVE_UPSTREAM_REVIEW_PATH)
    report = audit_hf_release(fetch_json=_fetcher(model_paths=paths), fetch_text=_text_fetcher())

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "native upstream review evidence present"
        and NATIVE_UPSTREAM_REVIEW_PATH in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_incomplete_native_upstream_review() -> None:
    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(upstream_review="# Native Upstream Review\n## llama.cpp\n"),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "native upstream review content passed"
        and "omnivoice.cpp: missing" in check["detail"]
        and "stable-diffusion.cpp: missing" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_unresolved_native_upstream_placeholders() -> None:
    bad = _passing_upstream_review().replace(
        "Upstream HEAD checked: def456",
        "Upstream HEAD checked: {omni_upstream}",
    )

    report = audit_hf_release(fetch_json=_fetcher(), fetch_text=_text_fetcher(upstream_review=bad))

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "native upstream review content passed"
        and "unresolved template placeholders" in check["detail"]
        and "{omni_upstream}" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_text_context_variant_evidence_file() -> None:
    paths = _complete_model_paths()
    paths.remove(TEXT_CONTEXT_VARIANT_EVIDENCE_PATH)

    report = audit_hf_release(fetch_json=_fetcher(model_paths=paths), fetch_text=_text_fetcher())

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "text context variant audit evidence present"
        and TEXT_CONTEXT_VARIANT_EVIDENCE_PATH in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_dirty_text_context_variant_evidence() -> None:
    bad = __import__("json").loads(_passing_text_context_variants())
    bad["passed"] = False
    bad["blockers"] = ["missing required text context"]
    bad["results"][0]["passed"] = False
    bad["results"][0]["requiredContexts"][0]["existsOnHub"] = False
    bad["results"][0]["requiredContexts"][0]["blockers"] = ["missing from Hub"]

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(text_context_variants=__import__("json").dumps(bad)),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "text context variant audit evidence passed"
        and "passed: False" in check["detail"]
        and "blockers: non-empty" in check["detail"]
        and "0_8b.passed: False" in check["detail"]
        and "0_8b.128k.existsOnHub: False" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_missing_required_bundle_files() -> None:
    paths = _complete_model_paths()
    paths.remove("bundles/4b/evals/aggregate.json")
    report = audit_hf_release(fetch_json=_fetcher(model_paths=paths), fetch_text=_text_fetcher())
    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "4b required release files present"
        and "evals/aggregate.json" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_manifest_backend_failures() -> None:
    bad_manifest = __import__("json").loads(_passing_model_manifest("4b"))
    bad_manifest["kernels"]["verifiedBackends"]["cuda"]["status"] = "skipped"
    bad_manifest["kernels"]["verifiedBackends"]["rocm"]["status"] = "fail"

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(model_manifests={"4b": __import__("json").dumps(bad_manifest)}),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "4b required backend verification passed"
        and "cuda: skipped" in check["detail"]
        and "rocm: fail" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_missing_manifest_text_context_variant() -> None:
    bad_manifest = __import__("json").loads(_passing_model_manifest("2b"))
    bad_manifest["files"]["text"] = [
        entry for entry in bad_manifest["files"]["text"] if entry["path"] != "text/eliza-1-2b-256k.gguf"
    ]

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(model_manifests={"2b": __import__("json").dumps(bad_manifest)}),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "2b manifest records native and half context text variants"
        and "text/eliza-1-2b-256k.gguf" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_wrong_manifest_text_context_value() -> None:
    bad_manifest = __import__("json").loads(_passing_model_manifest("4b"))
    for entry in bad_manifest["files"]["text"]:
        if entry["path"] == "text/eliza-1-4b-128k.gguf":
            entry["ctx"] = 32768

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(model_manifests={"4b": __import__("json").dumps(bad_manifest)}),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "4b manifest records native and half context text variants"
        and "ctx=32768 expected 131072" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_required_file_missing_from_manifest_files() -> None:
    bad_manifest = __import__("json").loads(_passing_model_manifest("9b"))
    bad_manifest["files"]["imagegen"] = []

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(model_manifests={"9b": __import__("json").dumps(bad_manifest)}),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "9b manifest files cover required runtime artifacts"
        and "imagegen/z-image-turbo-Q4_K_M.gguf" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_missing_runtime_component_lineage() -> None:
    bad_manifest = __import__("json").loads(_passing_model_manifest("0_8b"))
    del bad_manifest["lineage"]["imagegen"]

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(model_manifests={"0_8b": __import__("json").dumps(bad_manifest)}),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "0_8b manifest records shipped runtime component lineage"
        and "lineage.imagegen: missing" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_missing_structured_response_evidence() -> None:
    bad_evidence = __import__("json").loads(_passing_release_evidence("2b"))
    del bad_evidence["structuredResponse"]

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(release_evidence={"2b": __import__("json").dumps(bad_evidence)}),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "2b structured response release evidence passed"
        and "missing structuredResponse block" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_non_publishable_release_evidence() -> None:
    bad_evidence = __import__("json").loads(_passing_release_evidence("2b"))
    bad_evidence["releaseState"] = "local-standin"
    bad_evidence["publishEligible"] = False
    bad_evidence["final"]["evals"] = False
    bad_evidence["hf"]["status"] = "blocked-local-standin"
    bad_evidence["publishBlockingReasons"] = ["not final"]

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(release_evidence={"2b": __import__("json").dumps(bad_evidence)}),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "2b release evidence is publishable"
        and "releaseState: 'local-standin'" in check["detail"]
        and "publishEligible: False" in check["detail"]
        and "final.evals: False" in check["detail"]
        and "publishBlockingReasons: 1" in check["detail"]
        and "hf.status: 'blocked-local-standin'" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_release_upload_evidence() -> None:
    bad_evidence = __import__("json").loads(_passing_release_evidence("4b"))
    del bad_evidence["hf"]["uploadEvidence"]

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(release_evidence={"4b": __import__("json").dumps(bad_evidence)}),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "4b release evidence is publishable"
        and "hf.uploadEvidence: missing" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_imagegen_release_payload_weight() -> None:
    bad_evidence = __import__("json").loads(_passing_release_evidence("9b"))
    bad_evidence["weights"].remove("imagegen/z-image-turbo-Q4_K_M.gguf")

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(release_evidence={"9b": __import__("json").dumps(bad_evidence)}),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "9b release evidence is publishable"
        and "weights.imagegen/z-image-turbo-Q4_K_M.gguf: missing" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_zimage_companion_release_payload_weights() -> None:
    bad_evidence = __import__("json").loads(_passing_release_evidence("9b"))
    bad_evidence["weights"].remove("imagegen/vae/ae.safetensors")
    bad_evidence["weights"].remove(
        "imagegen/text-encoders/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
    )

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(release_evidence={"9b": __import__("json").dumps(bad_evidence)}),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "9b release evidence is publishable"
        and "weights.imagegen/vae/ae.safetensors: missing" in check["detail"]
        and "weights.imagegen/text-encoders/Qwen3-4B-Instruct-2507-Q4_K_M.gguf: missing"
        in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_incomplete_structured_response_rules() -> None:
    bad_evidence = __import__("json").loads(_passing_release_evidence("4b"))
    bad_evidence["structuredResponse"]["rules"].remove("dflash-prefill")
    del bad_evidence["structuredResponse"]["testReports"]["dflashStructured"]

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(release_evidence={"4b": __import__("json").dumps(bad_evidence)}),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "4b structured response release evidence passed"
        and "rules.dflash-prefill: missing" in check["detail"]
        and "testReports.dflashStructured: missing" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_missing_mtp_acceptance_evidence() -> None:
    bad_meta = __import__("json").loads(_passing_dflash_target_meta("2b"))
    bad_meta["acceptanceRate"] = None
    bad_meta["acceptanceRollout"] = {"status": "not-run", "gate": 0.48}
    bad_meta["acceptanceWindow"] = None

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(dflash_target_meta={"2b": __import__("json").dumps(bad_meta)}),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "2b MTP drafter release evidence passed"
        and "acceptanceRate: missing" in check["detail"]
        and "acceptanceRollout.status: 'not-run'" in check["detail"]
        and "acceptanceWindow: missing" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_imagegen_runtime_evidence_file() -> None:
    paths = _complete_model_paths()
    paths.remove(IMAGEGEN_RUNTIME_EVIDENCE_PATH)

    report = audit_hf_release(fetch_json=_fetcher(model_paths=paths), fetch_text=_text_fetcher())

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "imagegen runtime evidence present"
        and IMAGEGEN_RUNTIME_EVIDENCE_PATH in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_incomplete_imagegen_runtime_evidence() -> None:
    bad = __import__("json").loads(_passing_imagegen_runtime())
    bad["status"] = "blocked"
    bad["runtime"]["upstreamCommit"] = ""
    bad["runtime"]["binaryVersion"] = ""
    bad["probe"]["available"] = False
    bad["probe"]["supportedModels"] = ["imagegen-sd-1_5-q5_0"]
    bad["probe"]["accelerators"] = ["cpu"]
    bad["memory"]["maxVramAuto"] = False
    bad["smoke"]["platforms"]["cuda"]["status"] = "not-run"

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(imagegen_runtime=__import__("json").dumps(bad)),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "imagegen runtime evidence passed"
        and "status: 'blocked'" in check["detail"]
        and "runtime.upstreamCommit: missing" in check["detail"]
        and "runtime.binaryVersion: missing" in check["detail"]
        and "probe.available: False" in check["detail"]
        and "probe.supportedModels.imagegen-z-image-turbo-q4_k_m: missing" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_failed_required_imagegen_model_smoke() -> None:
    bad = __import__("json").loads(_passing_imagegen_runtime())
    bad["smoke"]["models"]["9b/z-image-turbo-Q4_K_M.gguf"] = {
        "status": "fail",
        "report": "evidence/imagegen/zimage-9b-cpu-smoke.json",
        "error": "get sd version from file failed",
        "architecture": "lumina2",
    }

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(imagegen_runtime=__import__("json").dumps(bad)),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "imagegen runtime evidence passed"
        and "smoke.models.imagegen-z-image-turbo-q4_k_m.status: 'fail'" in check["detail"]
        and "get sd version from file failed" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_finetune_comparison_file() -> None:
    paths = _complete_model_paths()
    paths.remove(FINETUNE_COMPARISON_EVIDENCE_PATH)

    report = audit_hf_release(fetch_json=_fetcher(model_paths=paths), fetch_text=_text_fetcher())

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "fine-tune comparison evidence present"
        and FINETUNE_COMPARISON_EVIDENCE_PATH in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_finetune_comparison_pass() -> None:
    bad = __import__("json").loads(_passing_finetune_comparison())
    bad["status"] = "blocked"
    bad["comparisons"]["0_8b"]["beatsBaseline"] = False
    bad["comparisons"]["0_8b"]["reports"].pop("structured_response")

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(finetune_comparison=__import__("json").dumps(bad)),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "fine-tune comparison evidence passed"
        and "status: 'blocked'" in check["detail"]
        and "beatsBaseline" in check["detail"]
        and "structured_response" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_rejects_legacy_only_finetune_comparison() -> None:
    legacy = __import__("json").loads(_passing_finetune_comparison())
    legacy["activeTiers"] = ["0_6b"]
    legacy["legacyTiers"] = ["0_6b"]
    legacy["comparisons"] = {
        "0_6b": {
            "baselineModel": "evals/bench/0_6b/base",
            "fineTunedModel": "evals/bench/0_6b/finetuned",
            "passed": True,
            "beatsBaseline": True,
            "reports": {
                "eliza_bench": "evals/bench/0_6b/base-eliza_bench-summary.json",
                "native_tool_call": "evals/bench/0_6b/base-native_tool_call-summary.json",
                "structured_response": "evals/bench/0_6b/gate_report.json",
            },
        }
    }

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(finetune_comparison=__import__("json").dumps(legacy)),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "fine-tune comparison evidence passed"
        and "legacy 0_6b" in check["detail"]
        and "comparisons.0_8b: missing" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_platform_evidence_files() -> None:
    paths = _complete_model_paths()
    paths.remove("bundles/4b/evidence/platform/linux-x64-cuda.json")

    report = audit_hf_release(fetch_json=_fetcher(model_paths=paths), fetch_text=_text_fetcher())

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "4b required platform evidence passed"
        and "linux-x64-cuda: missing evidence/platform/linux-x64-cuda.json" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_pending_platform_evidence() -> None:
    bad = __import__("json").loads(_passing_platform_evidence("9b", "linux-x64-cuda", "cuda"))
    bad["status"] = "pending"
    bad["report"] = "not-run"

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(
            platform_evidence={
                "bundles/9b/evidence/platform/linux-x64-cuda.json": __import__("json").dumps(bad)
            }
        ),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "9b required platform evidence passed"
        and "linux-x64-cuda: status='pending'" in check["detail"]
        and "linux-x64-cuda: report='not-run'" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_mismatched_platform_evidence() -> None:
    bad = __import__("json").loads(_passing_platform_evidence("27b", "linux-x64-cuda", "cuda"))
    bad["target"] = "windows-x64-cuda"
    bad["backend"] = "vulkan"
    bad["tier"] = "9b"

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(
            platform_evidence={
                "bundles/27b/evidence/platform/linux-x64-cuda.json": __import__("json").dumps(bad)
            }
        ),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "27b required platform evidence passed"
        and "linux-x64-cuda: target='windows-x64-cuda'" in check["detail"]
        and "linux-x64-cuda: backend='vulkan'" in check["detail"]
        and "linux-x64-cuda: tier='9b'" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_quantization_sidecars() -> None:
    paths = _complete_model_paths()
    paths.remove("bundles/4b/quantization/qjl_config.json")

    report = audit_hf_release(fetch_json=_fetcher(model_paths=paths), fetch_text=_text_fetcher())

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "4b quantization sidecars passed"
        and "quantization/qjl_config.json: missing" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_stale_quantization_contexts() -> None:
    bad = __import__("json").loads(_passing_quantization_sidecar("0_8b", "turboquant"))
    bad["contexts"] = ["32k"]

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(
            quantization_sidecars={
                "bundles/0_8b/quantization/turboquant.json": __import__("json").dumps(bad)
            }
        ),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "0_8b quantization sidecars passed"
        and "quantization/turboquant.json.contexts.32k: unsupported" in check["detail"]
        and "quantization/turboquant.json.contexts.128k: missing" in check["detail"]
        and "quantization/turboquant.json.contexts.256k: missing" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_dirty_quantization_sidecar() -> None:
    bad = __import__("json").loads(_passing_quantization_sidecar("9b", "fused-turboquant"))
    bad["method"] = "turboquant"
    bad["status"] = "local-standin"
    bad["text_quant"] = "Q8_0"
    bad["kernel_manifest"]["kernel_target"] = ["turbo4"]
    del bad["kernel_manifest"]["codebook_hash"]["turbo3"]

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(
            quantization_sidecars={
                "bundles/9b/quantization/fused_turboquant.json": __import__("json").dumps(bad)
            }
        ),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "9b quantization sidecars passed"
        and "quantization/fused_turboquant.json.method: 'turboquant'" in check["detail"]
        and "quantization/fused_turboquant.json.status: 'local-standin'" in check["detail"]
        and "quantization/fused_turboquant.json.text_quant: 'Q8_0'" in check["detail"]
        and "quantization/fused_turboquant.json.kernel_target: ['turbo4']" in check["detail"]
        and "quantization/fused_turboquant.json.codebook_hash.turbo3: missing" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_stand_in_mtp_drafter() -> None:
    bad_meta = __import__("json").loads(_passing_dflash_target_meta("9b"))
    bad_meta["publishEligible"] = False
    bad_meta["targetText"]["finalElizaWeights"] = False
    bad_meta["drafter"]["finalElizaWeights"] = False
    bad_meta["drafter"]["provenance"] = "local-source-candidate"

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(dflash_target_meta={"9b": __import__("json").dumps(bad_meta)}),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "9b MTP drafter release evidence passed"
        and "publishEligible: False" in check["detail"]
        and "targetText.finalElizaWeights: False" in check["detail"]
        and "drafter.provenance: local-source-candidate" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_aggregate_eval_gate_failures() -> None:
    bad_manifest = __import__("json").loads(_passing_model_manifest("4b"))
    bad_aggregate = (
        '{"passed":false,"gateReport":{"passed":false,'
        '"failures":["text_eval: text_eval=0.4 >= 0.62",'
        '"thirty_turn_ok: missing measurement results.thirty_turn_ok"]}}\n'
    )

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(
            model_manifests={"4b": __import__("json").dumps(bad_manifest)},
            aggregate_reports={"4b": bad_aggregate},
        ),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "4b manifest eval gates passed"
        and "text_eval: text_eval=0.4 >= 0.62" in check["detail"]
        and "thirty_turn_ok: missing measurement" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_prefers_aggregate_over_provisional_manifest_flags() -> None:
    manifest = __import__("json").loads(_passing_model_manifest("0_8b"))
    manifest["evals"]["asrWer"]["passed"] = False
    manifest["evals"]["dflash"] = {"passed": False}
    manifest["evals"]["expressive"] = {"passed": False}

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(model_manifests={"0_8b": __import__("json").dumps(manifest)}),
    )

    assert report.ok, report.render()


def test_hf_release_audit_blocks_manifest_lfs_hash_mismatch() -> None:
    bad_manifest = __import__("json").loads(_passing_model_manifest("4b"))
    bad_manifest["files"] = {
        "text": [
            {
                "path": "text/eliza-1-4b-128k.gguf",
                "sha256": "a" * 64,
            }
        ]
    }
    path = "bundles/4b/text/eliza-1-4b-128k.gguf"

    report = audit_hf_release(
        fetch_json=_fetcher(model_lfs_sha256s={path: "b" * 64}),
        fetch_text=_text_fetcher(model_manifests={"4b": __import__("json").dumps(bad_manifest)}),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "4b manifest LFS hashes match Hub metadata"
        and "text/eliza-1-4b-128k.gguf" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_checksum_lfs_hash_mismatch() -> None:
    path = "bundles/4b/text/eliza-1-4b-128k.gguf"

    report = audit_hf_release(
        fetch_json=_fetcher(model_lfs_sha256s={path: "b" * 64}),
        fetch_text=_text_fetcher(),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "4b checksum LFS hashes match Hub metadata"
        and "text/eliza-1-4b-128k.gguf" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_summary_groups_failures() -> None:
    paths = _complete_model_paths()
    paths.remove("bundles/4b/evals/cuda_verify.json")
    bad_manifest = __import__("json").loads(_passing_model_manifest("4b"))
    bad_manifest["kernels"]["verifiedBackends"]["cuda"]["status"] = "skipped"
    bad_aggregate = '{"passed":false,"gateReport":{"passed":false,"failures":["text_eval: low"]}}\n'

    report = audit_hf_release(
        fetch_json=_fetcher(model_paths=paths),
        fetch_text=_text_fetcher(
            model_manifests={"4b": __import__("json").dumps(bad_manifest)},
            aggregate_reports={"4b": bad_aggregate},
        ),
    )

    summary = report.summary()
    failures = summary["failuresByCategory"]
    assert summary["failedCheckCount"] == 3
    assert failures["missingReleaseFiles"][0]["name"] == "4b required release files present"
    assert failures["backendVerification"][0]["name"] == "4b required backend verification passed"
    assert failures["manifestEvalGates"][0]["name"] == "4b manifest eval gates passed"


def test_hf_release_audit_summary_groups_model_card_and_upstream_review() -> None:
    paths = _complete_model_paths()
    paths.remove(NATIVE_UPSTREAM_REVIEW_PATH)
    report = audit_hf_release(
        fetch_json=_fetcher(model_paths=paths),
        fetch_text=_text_fetcher(
            model_readme="# Eliza-1\nOnly `bundles/27b-256k/` is documented.\n",
            upstream_review="# Native Upstream Review\n",
        ),
    )

    summary = report.summary()
    failures = summary["failuresByCategory"]
    assert failures["modelCard"][0]["name"] == "model README content passed"
    assert failures["upstreamReview"][0]["name"] == "native upstream review evidence present"
    assert failures["upstreamReview"][1]["name"] == "native upstream review content passed"


def test_hf_release_audit_requires_dataset_splits() -> None:
    report = audit_hf_release(fetch_json=_fetcher(splits=["train", "test"]), fetch_text=_text_fetcher())
    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(check["name"] == "dataset exposes train/validation/test splits" for check in failed)


def test_hf_release_audit_requires_smallest_tier_finetuning_runbook() -> None:
    paths = _complete_dataset_paths()
    paths.remove("pipeline/docs/training/eliza1-smallest-finetunes.md")
    report = audit_hf_release(fetch_json=_fetcher(dataset_paths=paths), fetch_text=_text_fetcher())
    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset pipeline includes smallest-tier fine-tuning runbook"
        and "pipeline/docs/training/eliza1-smallest-finetunes.md" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_dataset_validation_report_file() -> None:
    paths = _complete_dataset_paths()
    paths.remove("validation/eliza1-trajectories-20260513-root-validation.json")
    report = audit_hf_release(fetch_json=_fetcher(dataset_paths=paths), fetch_text=_text_fetcher())
    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset native-record validation report passed"
        and "validation/eliza1-trajectories-20260513-root-validation.json" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_dirty_dataset_validation_report() -> None:
    dirty_report = __import__("json").loads(_passing_dataset_validation_report())
    dirty_report["validRecords"] = 1425
    dirty_report["invalidRecords"] = 1
    dirty_report["errorsByCode"] = {"native_v1_invalid_shape": 1}

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(validation_report=__import__("json").dumps(dirty_report)),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset native-record validation report passed"
        and "validRecords: 1425 != manifest 1426" in check["detail"]
        and "invalidRecords: 1" in check["detail"]
        and "errorsByCode: 1" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_dataset_live_audit_file() -> None:
    paths = _complete_dataset_paths()
    paths.remove("validation/eliza1-training-live-audit-2026-05-19.json")
    report = audit_hf_release(fetch_json=_fetcher(dataset_paths=paths), fetch_text=_text_fetcher())
    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset live validation audit present"
        and "validation/eliza1-training-live-audit-2026-05-19.json" in check["detail"]
        for check in failed
    )
    assert any(
        check["name"] == "dataset live validation audit passed"
        and "validation/eliza1-training-live-audit-2026-05-19.json" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_dirty_dataset_live_audit() -> None:
    dirty = __import__("json").loads(_passing_dataset_live_audit())
    dirty["passed"] = False
    dirty["hashMismatches"] = [{"split": "train"}]
    dirty["secretScan"]["passed"] = False
    dirty["rowCounts"]["train.jsonl"] = 1139

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(dataset_live_audit=__import__("json").dumps(dirty)),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset live validation audit passed"
        and "passed: False" in check["detail"]
        and "hashMismatches: non-empty" in check["detail"]
        and "secretScan.passed: False" in check["detail"]
        and "rowCounts total: 1425 != manifest 1426" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_dataset_live_audit_revision() -> None:
    stale = __import__("json").loads(_passing_dataset_live_audit())
    stale.pop("datasetRevision")

    report = audit_hf_release(
        fetch_json=_fetcher(dataset_sha="new-revision"),
        fetch_text=_text_fetcher(dataset_live_audit=__import__("json").dumps(stale)),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset live validation audit passed"
        and "datasetRevision: missing" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_active_sft_package() -> None:
    paths = _complete_dataset_paths()
    paths.remove(f"{ACTIVE_TEXT_SFT_ROOT}/validation.json")

    report = audit_hf_release(fetch_json=_fetcher(dataset_paths=paths), fetch_text=_text_fetcher())

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset active 0_8b SFT package present"
        and f"{ACTIVE_TEXT_SFT_ROOT}/validation.json" in check["detail"]
        for check in failed
    )
    assert any(
        check["name"] == "dataset active 0_8b SFT validation passed"
        and f"{ACTIVE_TEXT_SFT_ROOT}/validation.json" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_dirty_active_sft_validation() -> None:
    manifest = __import__("json").loads(_passing_active_sft_manifest())
    validation = __import__("json").loads(_passing_active_sft_validation())
    manifest["base_model"] = "Qwen/Qwen3.5-0.8B-legacy"
    manifest["privacy_filter"]["real_user_trajectories_consumed"] = 1
    validation["passed"] = False
    validation["splits"]["train"]["rows"] = 115

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(
            active_sft_manifest=__import__("json").dumps(manifest),
            active_sft_validation=__import__("json").dumps(validation),
        ),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset active 0_8b SFT validation passed"
        and "manifest.base_model: 'Qwen/Qwen3.5-0.8B-legacy'" in check["detail"]
        and "validation.passed: False" in check["detail"]
        and "validation.splits.train.rows: 115 != 116" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_dataset_training_contract() -> None:
    manifest = __import__("json").loads(_passing_dataset_manifest())
    manifest["contract"]["rootJsonlSplitsAreCanonical"] = False
    manifest["contract"]["parquetSplitsAreViewerMirrors"] = False
    manifest["contract"]["legacyMillionToken27bPresent"] = True
    manifest["contract"]["trainingReadySchema"] = "legacy"

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(manifest=__import__("json").dumps(manifest)),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset training contract passed"
        and "rootJsonlSplitsAreCanonical: False != True" in check["detail"]
        and "parquetSplitsAreViewerMirrors: False != True" in check["detail"]
        and "legacyMillionToken27bPresent: True != False" in check["detail"]
        and "trainingReadySchema: 'legacy' != 'eliza_native_v1'" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_dataset_training_contract_block() -> None:
    manifest = __import__("json").loads(_passing_dataset_manifest())
    manifest.pop("contract")

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(manifest=__import__("json").dumps(manifest)),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset training contract passed"
        and "contract: missing" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_dataset_privacy_attestation() -> None:
    manifest = __import__("json").loads(_passing_dataset_manifest())
    manifest.pop("privacy")

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(manifest=__import__("json").dumps(manifest)),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset privacy attestation passed"
        and "privacy: missing" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_unreviewed_dataset_privacy_attestation() -> None:
    manifest = __import__("json").loads(_passing_dataset_manifest())
    manifest["privacy"]["reviewed"] = False
    manifest["privacy"]["realUserExport"] = True
    manifest["privacy"]["attestationSource"] = "unchecked"
    manifest["privacy"]["residualFindingsCount"] = 1

    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(manifest=__import__("json").dumps(manifest)),
    )

    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset privacy attestation passed"
        and "reviewed: False" in check["detail"]
        and "realUserExport: True" in check["detail"]
        and "attestationSource: 'unchecked'" in check["detail"]
        and "residualFindingsCount: 1" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_dataset_viewer_root_split_files() -> None:
    paths = _complete_dataset_paths()
    paths.remove("val.jsonl")
    report = audit_hf_release(fetch_json=_fetcher(dataset_paths=paths), fetch_text=_text_fetcher())
    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset has canonical native root JSONL split files"
        and "val.jsonl" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_dataset_parquet_mirror_split_files() -> None:
    paths = _complete_dataset_paths()
    paths.remove("data/validation-00000-of-00001.parquet")
    report = audit_hf_release(fetch_json=_fetcher(dataset_paths=paths), fetch_text=_text_fetcher())
    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset has HF datasets parquet mirror split files"
        and "data/validation-00000-of-00001.parquet" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_requires_jsonl_even_with_dataset_viewer_parquet_layout() -> None:
    paths = [
        "README.md",
        "manifest.json",
        "data/train-00000-of-00001.parquet",
        "data/validation-00000-of-00001.parquet",
        "data/test-00000-of-00001.parquet",
    ]
    report = audit_hf_release(fetch_json=_fetcher(dataset_paths=paths), fetch_text=_text_fetcher())
    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset has canonical native root JSONL split files"
        and "train.jsonl" in check["detail"]
        and "val.jsonl" in check["detail"]
        and "test.jsonl" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_blocks_legacy_tier_mentions_in_dataset_readme() -> None:
    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(readme="tiers: 0.8B, 27B-1m\n"),
    )
    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset README has no removed 27B-1m tier references"
        for check in failed
    )


def test_hf_release_audit_blocks_smoke_corpus_manifest() -> None:
    report = audit_hf_release(
        fetch_json=_fetcher(),
        fetch_text=_text_fetcher(
            manifest='{"schema":"eliza.eliza1_smoke_corpus_manifest.v1","purpose":"smoke only"}'
        ),
    )
    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset manifest is not a smoke-corpus manifest"
        for check in failed
    )
