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
    DATASET_SPLITS_API,
    MODEL_API,
    audit_hf_release,
)
from scripts.manifest.eliza1_manifest import (  # noqa: E402
    ELIZA_1_HF_REPO,
    ELIZA_1_TIERS,
    SUPPORTED_BACKENDS_BY_TIER,
)
from scripts.manifest.eliza1_platform_plan import build_plan  # noqa: E402


DATASET_REPO = "elizaos/eliza-1-training"


def _api_url(template: str, repo: str) -> str:
    from urllib.parse import quote

    safe = "/" if "{repo}" in template.split("?", 1)[0] else ""
    return template.format(repo=quote(repo, safe=safe))


def _siblings(paths: list[str], *, lfs_sha256s: Mapping[str, str] | None = None) -> dict[str, Any]:
    siblings: list[dict[str, Any]] = []
    for path in paths:
        item: dict[str, Any] = {"rfilename": path}
        if lfs_sha256s and path in lfs_sha256s:
            item["lfs"] = {"sha256": lfs_sha256s[path], "size": 1}
        siblings.append(item)
    return {"siblings": siblings}


def _complete_model_paths() -> list[str]:
    paths: list[str] = []
    for tier, tier_plan in build_plan().items():
        paths.append(f"bundles/{tier}/eliza-1.manifest.json")
        paths.extend(f"bundles/{tier}/{rel}" for rel in tier_plan.required_files)
    return sorted(set(paths))


def _complete_dataset_paths() -> list[str]:
    return [
        "README.md",
        "manifest.json",
        "train.jsonl",
        "val.jsonl",
        "test.jsonl",
    ]


def _fetcher(
    *,
    model_paths: list[str] | None = None,
    model_lfs_sha256s: Mapping[str, str] | None = None,
    dataset_paths: list[str] | None = None,
    splits: list[str] | None = None,
):
    payloads: dict[str, Mapping[str, Any]] = {
        _api_url(MODEL_API, ELIZA_1_HF_REPO): _siblings(
            model_paths if model_paths is not None else _complete_model_paths(),
            lfs_sha256s=model_lfs_sha256s,
        ),
        _api_url(DATASET_API, DATASET_REPO): _siblings(
            dataset_paths if dataset_paths is not None else _complete_dataset_paths()
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
    readme: str = "Eliza-1 training dataset\n",
    manifest: str = '{"schema":"eliza.eliza1_training_manifest.v1"}\n',
    model_manifests: Mapping[str, str] | None = None,
    aggregate_reports: Mapping[str, str] | None = None,
):
    payloads = {
        "https://huggingface.co/datasets/elizaos/eliza-1-training/raw/main/README.md": readme,
        "https://huggingface.co/datasets/elizaos/eliza-1-training/raw/main/manifest.json": manifest,
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
            f"https://huggingface.co/elizaos/eliza-1/raw/main/bundles/{tier}/evals/aggregate.json"
        ] = (
            aggregate_reports[tier]
            if aggregate_reports and tier in aggregate_reports
            else '{"passed":true,"gateReport":{"passed":true,"failures":[]}}\n'
        )

    def fetch(url: str) -> str:
        return payloads[url]

    return fetch


def _passing_model_manifest(tier: str) -> str:
    files_by_dir: dict[str, list[dict[str, str]]] = {}
    for rel in build_plan()[tier].required_files:
        root = rel.split("/", 1)[0]
        files_by_dir.setdefault(root, []).append({"path": rel, "sha256": "a" * 64})
    return __import__("json").dumps(
        {
            "tier": tier,
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


def test_hf_release_audit_requires_dataset_splits() -> None:
    report = audit_hf_release(fetch_json=_fetcher(splits=["train", "test"]), fetch_text=_text_fetcher())
    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(check["name"] == "dataset exposes train/validation/test splits" for check in failed)


def test_hf_release_audit_requires_dataset_viewer_root_split_files() -> None:
    paths = _complete_dataset_paths()
    paths.remove("val.jsonl")
    report = audit_hf_release(fetch_json=_fetcher(dataset_paths=paths), fetch_text=_text_fetcher())
    assert not report.ok
    failed = [check for check in report.checks if not check["ok"]]
    assert any(
        check["name"] == "dataset has Dataset Viewer-compatible root split files"
        and "val.jsonl" in check["detail"]
        for check in failed
    )


def test_hf_release_audit_accepts_dataset_viewer_parquet_layout() -> None:
    paths = [
        "README.md",
        "manifest.json",
        "data/train-00000-of-00001.parquet",
        "data/validation-00000-of-00001.parquet",
        "data/test-00000-of-00001.parquet",
    ]
    report = audit_hf_release(fetch_json=_fetcher(dataset_paths=paths), fetch_text=_text_fetcher())
    assert report.ok, report.render()


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
