#!/usr/bin/env python3
"""Audit the public Hugging Face Eliza-1 release surface without downloads.

This is a metadata-only gate for the long Eliza-1 release checklist. It uses
the Hub API file lists and Dataset Viewer split metadata, so it can run on a
developer laptop without pulling GGUFs, safetensors, or parquet shards.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

try:
    from scripts.manifest.eliza1_manifest import (
        ELIZA_1_HF_REPO,
        ELIZA_1_PUBLISHABLE_RELEASE_STATES,
        ELIZA_1_TIERS,
        SUPPORTED_BACKENDS_BY_TIER,
    )
    from scripts.manifest.eliza1_platform_plan import CONTEXTS_BY_TIER, build_plan, text_artifact_name
except ImportError:  # pragma: no cover - script execution path
    from eliza1_manifest import (
        ELIZA_1_HF_REPO,
        ELIZA_1_PUBLISHABLE_RELEASE_STATES,
        ELIZA_1_TIERS,
        SUPPORTED_BACKENDS_BY_TIER,
    )
    from eliza1_platform_plan import CONTEXTS_BY_TIER, build_plan, text_artifact_name

try:
    from scripts.manifest.eliza1_platform_plan import PlatformTarget
except ImportError:  # pragma: no cover - script execution path
    from eliza1_platform_plan import PlatformTarget

DEFAULT_DATASET_REPO = "elizaos/eliza-1-training"
LEGACY_TIER_MARKERS = ("27b-1m", "27B-1m", "27b_1m", "27B_1M")
LEGACY_TIER_RE = re.compile(r"27b[-_ ]?1m", re.IGNORECASE)
DATASET_VIEWER_PARQUET_SPLIT_FILES = (
    "data/train-00000-of-00001.parquet",
    "data/validation-00000-of-00001.parquet",
    "data/test-00000-of-00001.parquet",
)
DATASET_VIEWER_JSONL_SPLIT_FILES = ("train.jsonl", "val.jsonl", "test.jsonl")
DATASET_REQUIRED_PIPELINE_DOCS = (
    "pipeline/docs/training/eliza1-smallest-finetunes.md",
)
DATASET_LIVE_AUDIT_PATH = "validation/eliza1-training-live-audit-2026-05-19.json"
DATASET_VALIDATION_SCHEMA = "eliza.eliza1_trajectory_validation_report.v1"
DATASET_LIVE_AUDIT_SCHEMA = "eliza.eliza1_training_dataset_live_audit.v1"
ACTIVE_TEXT_SFT_TIER = "0_8b"
ACTIVE_TEXT_SFT_ROOT = f"sft/{ACTIVE_TEXT_SFT_TIER}"
ACTIVE_TEXT_SFT_REQUIRED_FILES = (
    f"{ACTIVE_TEXT_SFT_ROOT}/train.jsonl",
    f"{ACTIVE_TEXT_SFT_ROOT}/val.jsonl",
    f"{ACTIVE_TEXT_SFT_ROOT}/test.jsonl",
    f"{ACTIVE_TEXT_SFT_ROOT}/manifest.json",
    f"{ACTIVE_TEXT_SFT_ROOT}/validation.json",
)
ACTIVE_TEXT_SFT_MANIFEST_SCHEMA = "eliza.eliza1_sft_0_8b_manifest.v1"
ACTIVE_TEXT_SFT_VALIDATION_SCHEMA = "eliza.eliza1_sft_0_8b_validation.v1"
DATASET_PRIVACY_ATTESTATION_SOURCES = frozenset(
    {
        "cli_flag",
        "source_manifest",
        "review_attestation",
    }
)
DATASET_REQUIRED_CONTRACT_FLAGS = {
    "rootJsonlSplitsAreCanonical": True,
    "parquetSplitsAreViewerMirrors": True,
    "datasetViewerCompatible": True,
    "legacyMillionToken27bPresent": False,
    "trainLocalReady": True,
    "trainingReadySchema": "eliza_native_v1",
}
STRUCTURED_RESPONSE_REQUIRED_RULES = frozenset(
    {
        "handle-response-tool-call",
        "closed-action-enum",
        "eliza-schema-guided-decode",
        "dflash-prefill",
        "deterministic-repair",
    }
)
RELEASE_FINAL_FLAGS_ALL = (
    "weights",
    "hashes",
    "evals",
    "licenses",
    "kernelDispatchReports",
    "platformEvidence",
    "sizeFirstRepoIds",
)
RELEASE_FINAL_FLAGS_BASE_V1 = tuple(
    flag for flag in RELEASE_FINAL_FLAGS_ALL if flag != "weights"
)
WEIGHT_PAYLOAD_DIRS = frozenset(
    {
        "text",
        "tts",
        "asr",
        "vad",
        "imagegen",
        "vision",
        "dflash",
        "embedding",
        "wakeword",
    }
)
MODEL_CARD_REQUIRED_FRAGMENTS = (
    "bundles/0_8b/",
    "bundles/2b/",
    "bundles/4b/",
    "bundles/9b/",
    "bundles/27b/",
    "bundles/27b-256k/",
    "elizaos/eliza-1-training",
    "native context",
    "half context",
    "image generation",
    "structured response",
    "MTP",
    "DFlash",
    "llama.cpp",
    "omnivoice.cpp",
    "stable-diffusion.cpp",
    "fine-tuning",
)
QUANTIZATION_SIDECARS = {
    "quantization/turboquant.json": "turboquant",
    "quantization/fused_turboquant.json": "fused-turboquant",
    "quantization/qjl_config.json": "qjl",
    "quantization/polarquant_config.json": "polarquant",
}
QUANTIZATION_KERNEL_TARGETS = {
    "turboquant": ["turbo3", "turbo4", "turbo3_tcq"],
    "fused-turboquant": ["turbo3", "turbo4", "turbo3_tcq"],
    "qjl": ["qjl1_256"],
    "polarquant": ["polar_q4"],
}
NATIVE_UPSTREAM_REVIEW_PATH = "evidence/upstream/native-upstream-review-2026-05-19.md"
IMAGEGEN_RUNTIME_EVIDENCE_PATH = "evidence/imagegen/sd-cpp-runtime.json"
FINETUNE_COMPARISON_EVIDENCE_PATH = "evidence/training/fine-tune-comparison.json"
TEXT_CONTEXT_VARIANT_EVIDENCE_PATH = "evidence/text/context-variants-2026-05-19.json"
FINETUNE_REQUIRED_METRICS = frozenset(
    {
        "eliza_bench",
        "native_tool_call",
        "structured_response",
    }
)
IMAGEGEN_REQUIRED_MODELS = frozenset(
    {
        "imagegen-sd-1_5-q5_0",
        "imagegen-z-image-turbo-q4_k_m",
    }
)
IMAGEGEN_REQUIRED_MODEL_SMOKES = {
    "imagegen-sd-1_5-q5_0": "0_8b/sd-1.5-Q5_0.gguf",
    "imagegen-z-image-turbo-q4_k_m": "9b/z-image-turbo-Q4_K_M.gguf",
}
IMAGEGEN_REQUIRED_ACCELERATORS = frozenset({"cpu", "cuda", "vulkan", "metal"})
IMAGEGEN_REQUIRED_MEMORY_FEATURES = frozenset({"mmap", "maxVramAuto", "segmentedOffload"})
NATIVE_UPSTREAM_REVIEW_REQUIRED_FRAGMENTS = (
    "llama.cpp",
    "omnivoice.cpp",
    "stable-diffusion.cpp",
    "Upstream HEAD checked",
    "Performance/platform commits to review",
    "Release impact",
    "Next action",
    "MTP",
    "streaming",
    "memory",
    "Vulkan",
    "CUDA",
)
MODEL_API = "https://huggingface.co/api/models/{repo}"
DATASET_API = "https://huggingface.co/api/datasets/{repo}"
DATASET_SPLITS_API = "https://datasets-server.huggingface.co/splits?dataset={repo}"
_CONTEXT_LABEL_RE = re.compile(r"^(\d+)([km])$", re.IGNORECASE)

JsonFetcher = Callable[[str], Mapping[str, Any]]
TextFetcher = Callable[[str], str]


@dataclass
class AuditReport:
    model_repo: str
    dataset_repo: str
    checks: list[dict[str, Any]] = field(default_factory=list)

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append({"name": name, "ok": ok, "detail": detail})

    @property
    def ok(self) -> bool:
        return all(bool(check["ok"]) for check in self.checks)

    def render(self) -> str:
        lines = [f"hf_eliza1_release_audit model={self.model_repo} dataset={self.dataset_repo}"]
        for check in self.checks:
            mark = "PASS" if check["ok"] else "FAIL"
            suffix = f" - {check['detail']}" if check["detail"] else ""
            lines.append(f"  [{mark}] {check['name']}{suffix}")
        lines.append(f"  -> {'OK' if self.ok else 'BROKEN'}")
        return "\n".join(lines)

    def summary(self) -> dict[str, Any]:
        failed = [check for check in self.checks if not check["ok"]]
        by_category: dict[str, list[dict[str, str]]] = {
            "missingReleaseFiles": [],
            "checksumIntegrity": [],
            "backendVerification": [],
            "manifestEvalGates": [],
            "dataset": [],
            "legacyTier": [],
            "other": [],
        }
        for check in failed:
            name = str(check["name"])
            item = {"name": name, "detail": str(check.get("detail") or "")}
            if name.endswith("required release files present"):
                by_category["missingReleaseFiles"].append(item)
            elif "checksum" in name or "LFS hashes match Hub metadata" in name:
                by_category["checksumIntegrity"].append(item)
            elif name.endswith("release evidence is publishable"):
                by_category.setdefault("releaseEvidence", []).append(item)
            elif name.endswith("MTP drafter release evidence passed"):
                by_category.setdefault("mtpDrafter", []).append(item)
            elif name.endswith("required backend verification passed"):
                by_category["backendVerification"].append(item)
            elif name.endswith("required platform evidence passed"):
                by_category.setdefault("platformEvidence", []).append(item)
            elif name.endswith("quantization sidecars passed"):
                by_category.setdefault("quantizationEvidence", []).append(item)
            elif name.endswith("manifest eval gates passed"):
                by_category["manifestEvalGates"].append(item)
            elif name.startswith("model README"):
                by_category.setdefault("modelCard", []).append(item)
            elif name.startswith("native upstream review"):
                by_category.setdefault("upstreamReview", []).append(item)
            elif name.startswith("imagegen runtime evidence"):
                by_category.setdefault("imagegenEvidence", []).append(item)
            elif name.startswith("fine-tune comparison"):
                by_category.setdefault("fineTuneComparison", []).append(item)
            elif name.startswith("dataset "):
                by_category["dataset"].append(item)
            elif "27B-1m" in name:
                by_category["legacyTier"].append(item)
            else:
                by_category["other"].append(item)
        return {
            "modelRepo": self.model_repo,
            "datasetRepo": self.dataset_repo,
            "ok": self.ok,
            "failedCheckCount": len(failed),
            "failuresByCategory": {
                key: value for key, value in by_category.items() if value
            },
        }


def _token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def hub_fetch_json(url: str) -> Mapping[str, Any]:
    model_api_prefix = "https://huggingface.co/api/models/"
    if url.startswith(model_api_prefix) and "?" not in url:
        repo = urllib.parse.unquote(url[len(model_api_prefix):])
        try:
            from huggingface_hub import HfApi

            info = HfApi(token=_token()).model_info(repo, files_metadata=True)
            siblings: list[dict[str, Any]] = []
            for sibling in info.siblings:
                item: dict[str, Any] = {"rfilename": sibling.rfilename}
                size = getattr(sibling, "size", None)
                if isinstance(size, int):
                    item["size"] = size
                lfs = getattr(sibling, "lfs", None)
                sha256 = getattr(lfs, "sha256", None) if lfs is not None else None
                if isinstance(sha256, str):
                    item["lfs"] = {"sha256": sha256}
                siblings.append(item)
            return {"siblings": siblings}
        except Exception:
            # Fall back to the public REST shape below; the audit will still
            # check file presence even if the installed HF client is missing.
            pass

    headers = {"Accept": "application/json"}
    token = _token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:240]
        raise RuntimeError(f"HTTP {exc.code} from {url}: {body}") from exc


def hub_fetch_text(url: str) -> str:
    headers = {"Accept": "text/plain"}
    token = _token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read(2_000_000).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:240]
        raise RuntimeError(f"HTTP {exc.code} from {url}: {body}") from exc


def _repo_api_url(template: str, repo: str) -> str:
    safe = "/" if "{repo}" in template.split("?", 1)[0] else ""
    return template.format(repo=urllib.parse.quote(repo, safe=safe))


def _sibling_paths(payload: Mapping[str, Any]) -> set[str]:
    siblings = payload.get("siblings")
    if not isinstance(siblings, list):
        return set()
    paths: set[str] = set()
    for sibling in siblings:
        if isinstance(sibling, Mapping) and isinstance(sibling.get("rfilename"), str):
            paths.add(sibling["rfilename"])
    return paths


def _sibling_lfs_sha256s(payload: Mapping[str, Any]) -> dict[str, str]:
    siblings = payload.get("siblings")
    if not isinstance(siblings, list):
        return {}
    out: dict[str, str] = {}
    for sibling in siblings:
        if not isinstance(sibling, Mapping) or not isinstance(sibling.get("rfilename"), str):
            continue
        lfs = sibling.get("lfs")
        if isinstance(lfs, Mapping) and isinstance(lfs.get("sha256"), str):
            out[sibling["rfilename"]] = lfs["sha256"]
    return out


def _split_names(payload: Mapping[str, Any]) -> set[str]:
    splits = payload.get("splits")
    if not isinstance(splits, list):
        return set()
    names: set[str] = set()
    for split in splits:
        if isinstance(split, Mapping) and isinstance(split.get("split"), str):
            names.add(split["split"])
    return names


def _raw_dataset_url(repo: str, path: str) -> str:
    return (
        "https://huggingface.co/datasets/"
        + urllib.parse.quote(repo, safe="/")
        + "/raw/main/"
        + urllib.parse.quote(path, safe="/")
    )


def _raw_model_url(repo: str, path: str) -> str:
    return (
        "https://huggingface.co/"
        + urllib.parse.quote(repo, safe="/")
        + "/raw/main/"
        + urllib.parse.quote(path, safe="/")
    )


def _manifest_backend_blockers(manifest: Mapping[str, Any], supported: tuple[str, ...]) -> list[str]:
    kernels = manifest.get("kernels")
    if not isinstance(kernels, Mapping):
        return ["missing kernels block"]
    verified = kernels.get("verifiedBackends")
    if not isinstance(verified, Mapping):
        return ["missing kernels.verifiedBackends block"]

    blockers: list[str] = []
    for backend in supported:
        entry = verified.get(backend)
        if not isinstance(entry, Mapping):
            blockers.append(f"{backend}: missing")
            continue
        status = entry.get("status")
        if status != "pass":
            blockers.append(f"{backend}: {status or 'missing-status'}")
    return blockers


def _platform_evidence_blockers(
    *,
    tier: str,
    prefix: str,
    model_repo: str,
    model_paths: set[str],
    targets: tuple[PlatformTarget, ...],
    fetch_text: TextFetcher,
) -> list[str]:
    blockers: list[str] = []
    for target in targets:
        repo_path = f"{prefix}{target.evidence_path}"
        if repo_path not in model_paths:
            blockers.append(f"{target.id}: missing {target.evidence_path}")
            continue
        try:
            evidence = json.loads(fetch_text(_raw_model_url(model_repo, repo_path)))
        except (RuntimeError, json.JSONDecodeError) as exc:
            blockers.append(f"{target.id}: {exc}")
            continue
        if not isinstance(evidence, Mapping):
            blockers.append(f"{target.id}: not an object")
            continue
        if evidence.get("target") != target.id:
            blockers.append(f"{target.id}: target={evidence.get('target')!r}")
        if evidence.get("backend") != target.backend:
            blockers.append(f"{target.id}: backend={evidence.get('backend')!r}")
        if evidence.get("tier") not in (None, tier):
            blockers.append(f"{target.id}: tier={evidence.get('tier')!r}")
        if evidence.get("status") != "pass":
            blockers.append(f"{target.id}: status={evidence.get('status')!r}")
        report = evidence.get("report")
        if not isinstance(report, str) or not report or report == "not-run":
            blockers.append(f"{target.id}: report={report!r}")
    return blockers


def _quantization_sidecar_blockers(
    *,
    tier: str,
    prefix: str,
    model_repo: str,
    model_paths: set[str],
    expected_text_quant: str,
    expected_contexts: tuple[str, ...],
    fetch_text: TextFetcher,
) -> list[str]:
    blockers: list[str] = []
    expected_context_set = set(expected_contexts)
    for rel, method in QUANTIZATION_SIDECARS.items():
        repo_path = f"{prefix}{rel}"
        if repo_path not in model_paths:
            blockers.append(f"{rel}: missing")
            continue
        try:
            sidecar = json.loads(fetch_text(_raw_model_url(model_repo, repo_path)))
        except (RuntimeError, json.JSONDecodeError) as exc:
            blockers.append(f"{rel}: {exc}")
            continue
        if not isinstance(sidecar, Mapping):
            blockers.append(f"{rel}: not an object")
            continue
        if sidecar.get("method") != method:
            blockers.append(f"{rel}.method: {sidecar.get('method')!r}")
        if sidecar.get("status") != "release-sidecar":
            blockers.append(f"{rel}.status: {sidecar.get('status')!r}")
        if sidecar.get("tier") not in (None, tier):
            blockers.append(f"{rel}.tier: {sidecar.get('tier')!r}")
        if method in {"turboquant", "fused-turboquant"} and sidecar.get("text_quant") != expected_text_quant:
            blockers.append(f"{rel}.text_quant: {sidecar.get('text_quant')!r}")
        contexts = sidecar.get("contexts")
        if not isinstance(contexts, list) or not contexts or not all(isinstance(ctx, str) for ctx in contexts):
            blockers.append(f"{rel}.contexts: missing")
        else:
            unsupported = sorted(set(contexts) - expected_context_set)
            missing = sorted(expected_context_set - set(contexts))
            blockers.extend(f"{rel}.contexts.{ctx}: unsupported" for ctx in unsupported)
            blockers.extend(f"{rel}.contexts.{ctx}: missing" for ctx in missing)
        kernel_manifest = sidecar.get("kernel_manifest")
        expected_targets = QUANTIZATION_KERNEL_TARGETS[method]
        if not isinstance(kernel_manifest, Mapping):
            blockers.append(f"{rel}.kernel_manifest: missing")
            continue
        targets = kernel_manifest.get("kernel_target")
        if targets != expected_targets:
            blockers.append(f"{rel}.kernel_target: {targets!r}")
        for field in ("block_layout_version", "codebook_hash", "per_block_tolerance"):
            values = kernel_manifest.get(field)
            if not isinstance(values, Mapping):
                blockers.append(f"{rel}.{field}: missing")
                continue
            missing_targets = [target for target in expected_targets if target not in values]
            blockers.extend(f"{rel}.{field}.{target}: missing" for target in missing_targets)
    return blockers


def _eval_gate_blockers(evals: Any, *, prefix: str = "evals") -> list[str]:
    blockers: list[str] = []
    if not isinstance(evals, Mapping):
        return [f"{prefix}: missing"]
    for key, value in evals.items():
        path = f"{prefix}.{key}"
        if key == "passed" and value is not True:
            blockers.append(f"{path}: {value!r}")
        elif key.endswith("Ok") and value is not True:
            blockers.append(f"{path}: {value!r}")
        elif isinstance(value, Mapping):
            blockers.extend(_eval_gate_blockers(value, prefix=path))
    return blockers


def _aggregate_gate_blockers(aggregate: Mapping[str, Any]) -> list[str]:
    """Return publish-blocking eval failures from an aggregate eval blob.

    ``manifest.evals`` records every measured/provisional sub-metric for the
    runtime resolver, including non-required/provisional rows that can be
    false while the publish gate still passes. The eval suite's
    ``aggregate.gateReport`` is the authoritative gate-engine verdict, so the
    HF audit should prefer it whenever the aggregate is available.
    """

    gate_report = aggregate.get("gateReport")
    if not isinstance(gate_report, Mapping):
        passed = aggregate.get("passed")
        if passed is True:
            return []
        if passed is False:
            return ["aggregate.passed: False"]
        return ["aggregate.gateReport: missing"]
    if gate_report.get("passed") is True:
        return []
    failures = gate_report.get("failures")
    if isinstance(failures, list) and failures:
        return [str(failure) for failure in failures]
    return [f"gateReport.passed: {gate_report.get('passed')!r}"]


def _ctx_label_to_tokens(label: str) -> int | None:
    match = _CONTEXT_LABEL_RE.match(label.strip())
    if not match:
        return None
    scale = 1024 if match.group(2).lower() == "k" else 1024 * 1024
    return int(match.group(1)) * scale


def _manifest_text_context_blockers(manifest: Mapping[str, Any], tier: str) -> list[str]:
    files = manifest.get("files")
    if not isinstance(files, Mapping):
        return ["missing manifest files block"]
    text_entries = files.get("text")
    if not isinstance(text_entries, list):
        return ["missing files.text block"]
    by_path: dict[str, Mapping[str, Any]] = {}
    for entry in text_entries:
        if isinstance(entry, Mapping) and isinstance(entry.get("path"), str):
            by_path[entry["path"]] = entry
    blockers: list[str] = []
    for ctx_label in CONTEXTS_BY_TIER[tier]:
        path = text_artifact_name(tier, ctx_label)
        expected_ctx = _ctx_label_to_tokens(ctx_label)
        entry = by_path.get(path)
        if entry is None:
            blockers.append(f"{path}: missing from manifest files.text")
            continue
        actual_ctx = entry.get("ctx")
        if actual_ctx != expected_ctx:
            blockers.append(f"{path}: ctx={actual_ctx!r} expected {expected_ctx}")
    return blockers


def _manifest_required_file_blockers(
    manifest: Mapping[str, Any],
    *,
    required_files: tuple[str, ...],
) -> list[str]:
    files = manifest.get("files")
    if not isinstance(files, Mapping):
        return ["missing manifest files block"]
    manifest_paths: set[str] = set()
    for entries in files.values():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if isinstance(entry, Mapping) and isinstance(entry.get("path"), str):
                manifest_paths.add(entry["path"])
    runtime_roots = {"text", "tts", "asr", "vad", "imagegen", "vision", "dflash", "cache"}
    return sorted(
        rel for rel in required_files
        if rel.split("/", 1)[0] in runtime_roots and rel not in manifest_paths
    )


def _manifest_runtime_lineage_blockers(manifest: Mapping[str, Any]) -> list[str]:
    files = manifest.get("files")
    lineage = manifest.get("lineage")
    if not isinstance(files, Mapping):
        return ["missing manifest files block"]
    if not isinstance(lineage, Mapping):
        return ["missing lineage block"]
    blockers: list[str] = []
    lineage_slot_by_file_slot = {
        "asr": "asr",
        "vad": "vad",
        "imagegen": "imagegen",
        "vision": "vision",
        "dflash": "drafter",
    }
    for file_slot, lineage_slot in lineage_slot_by_file_slot.items():
        entries = files.get(file_slot)
        if not isinstance(entries, list) or not entries:
            continue
        entry = lineage.get(lineage_slot)
        if not isinstance(entry, Mapping):
            blockers.append(f"lineage.{lineage_slot}: missing")
            continue
        if not entry.get("base"):
            blockers.append(f"lineage.{lineage_slot}.base: missing")
        if not entry.get("license"):
            blockers.append(f"lineage.{lineage_slot}.license: missing")
    return blockers


def _release_structured_response_blockers(evidence: Mapping[str, Any]) -> list[str]:
    structured = evidence.get("structuredResponse")
    if not isinstance(structured, Mapping):
        return ["missing structuredResponse block"]
    blockers: list[str] = []
    if structured.get("status") != "pass":
        blockers.append(f"status: {structured.get('status')!r}")
    if structured.get("handler") != "HANDLE_RESPONSE":
        blockers.append(f"handler: {structured.get('handler')!r}")
    rules = structured.get("rules")
    if not isinstance(rules, list):
        blockers.append("rules: missing")
    else:
        missing_rules = sorted(
            rule for rule in STRUCTURED_RESPONSE_REQUIRED_RULES if rule not in rules
        )
        blockers.extend(f"rules.{rule}: missing" for rule in missing_rules)
    reports = structured.get("testReports")
    if not isinstance(reports, Mapping):
        blockers.append("testReports: missing")
    else:
        for key in (
            "plannerGrammar",
            "structuredOutput",
            "dflashStructured",
            "deterministicRepair",
        ):
            value = reports.get(key)
            if not isinstance(value, str) or not value:
                blockers.append(f"testReports.{key}: missing")
    return blockers


def _release_evidence_publishable_blockers(
    evidence: Mapping[str, Any],
    *,
    tier: str,
    required_files: tuple[str, ...],
) -> list[str]:
    blockers: list[str] = []
    release_state = evidence.get("releaseState")
    if release_state not in ELIZA_1_PUBLISHABLE_RELEASE_STATES:
        blockers.append(f"releaseState: {release_state!r}")
    if evidence.get("publishEligible") is not True:
        blockers.append(f"publishEligible: {evidence.get('publishEligible')!r}")
    if evidence.get("checksumManifest") != "checksums/SHA256SUMS":
        blockers.append(f"checksumManifest: {evidence.get('checksumManifest')!r}")

    final = evidence.get("final")
    required_flags = (
        RELEASE_FINAL_FLAGS_BASE_V1
        if release_state == "base-v1"
        else RELEASE_FINAL_FLAGS_ALL
    )
    if not isinstance(final, Mapping):
        blockers.append("final: missing")
    else:
        for flag in required_flags:
            if final.get(flag) is not True:
                blockers.append(f"final.{flag}: {final.get(flag)!r}")

    weights = evidence.get("weights")
    if not isinstance(weights, list) or not all(isinstance(path, str) for path in weights):
        blockers.append("weights: missing")
    else:
        expected_weights = {
            rel for rel in required_files if rel.split("/", 1)[0] in WEIGHT_PAYLOAD_DIRS
        }
        missing_weights = sorted(expected_weights - set(weights))
        blockers.extend(f"weights.{rel}: missing" for rel in missing_weights[:8])
        if len(missing_weights) > 8:
            blockers.append(f"weights: +{len(missing_weights) - 8} more missing")

    blocking_reasons = evidence.get("publishBlockingReasons")
    if isinstance(blocking_reasons, list) and blocking_reasons:
        blockers.append(f"publishBlockingReasons: {len(blocking_reasons)}")

    hf = evidence.get("hf")
    if not isinstance(hf, Mapping):
        blockers.append("hf: missing")
    else:
        if hf.get("repoId") != ELIZA_1_HF_REPO:
            blockers.append(f"hf.repoId: {hf.get('repoId')!r}")
        path_prefix = hf.get("pathPrefix")
        if isinstance(path_prefix, str) and path_prefix != f"bundles/{tier}":
            blockers.append(f"hf.pathPrefix: {path_prefix!r}")
        if hf.get("status") != "uploaded":
            blockers.append(f"hf.status: {hf.get('status')!r}")
        upload = hf.get("uploadEvidence")
        if not isinstance(upload, Mapping):
            blockers.append("hf.uploadEvidence: missing")
        else:
            if upload.get("repoId") != ELIZA_1_HF_REPO:
                blockers.append(f"hf.uploadEvidence.repoId: {upload.get('repoId')!r}")
            for key in ("commit", "url"):
                if not isinstance(upload.get(key), str) or not upload.get(key):
                    blockers.append(f"hf.uploadEvidence.{key}: missing")
            uploaded_paths = upload.get("uploadedPaths")
            if not isinstance(uploaded_paths, list) or not all(
                isinstance(path, str) for path in uploaded_paths
            ):
                blockers.append("hf.uploadEvidence.uploadedPaths: missing")
    return blockers


def _dflash_target_meta_blockers(meta: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if meta.get("publishEligible") is not True:
        blockers.append(f"publishEligible: {meta.get('publishEligible')!r}")

    target = meta.get("targetText")
    if not isinstance(target, Mapping):
        blockers.append("targetText: missing")
    elif target.get("finalElizaWeights") is not True:
        blockers.append(f"targetText.finalElizaWeights: {target.get('finalElizaWeights')!r}")

    drafter = meta.get("drafter")
    if not isinstance(drafter, Mapping):
        blockers.append("drafter: missing")
    else:
        provenance = str(drafter.get("provenance") or "")
        if drafter.get("finalElizaWeights") is not True:
            blockers.append(f"drafter.finalElizaWeights: {drafter.get('finalElizaWeights')!r}")
        if not drafter.get("sha256"):
            blockers.append("drafter.sha256: missing")
        if "stamp-only" in provenance:
            blockers.append("drafter.provenance: stamp-only")
        if "local-standin" in provenance or "local-source-candidate" in provenance:
            blockers.append(f"drafter.provenance: {provenance}")

    rate = meta.get("acceptanceRate")
    rollout = meta.get("acceptanceRollout")
    gate = None
    if isinstance(rollout, Mapping):
        gate = rollout.get("gate")
        if rollout.get("status") not in {"pass", "passed"}:
            blockers.append(f"acceptanceRollout.status: {rollout.get('status')!r}")
    if not isinstance(rate, (int, float)):
        blockers.append("acceptanceRate: missing")
    elif isinstance(gate, (int, float)) and rate < gate:
        blockers.append(f"acceptanceRate: {rate} < gate {gate}")

    window = meta.get("acceptanceWindow")
    if not isinstance(window, Mapping):
        blockers.append("acceptanceWindow: missing")
    else:
        drafted = window.get("draftedTokens")
        accepted = window.get("acceptedTokens")
        if not isinstance(drafted, int) or drafted <= 0:
            blockers.append(f"acceptanceWindow.draftedTokens: {drafted!r}")
        if not isinstance(accepted, int) or accepted <= 0:
            blockers.append(f"acceptanceWindow.acceptedTokens: {accepted!r}")
    return blockers


def _model_card_blockers(text: str) -> list[str]:
    lower_text = text.lower()
    blockers: list[str] = []
    for fragment in MODEL_CARD_REQUIRED_FRAGMENTS:
        if fragment.lower() not in lower_text:
            blockers.append(f"{fragment}: missing")
    legacy_markers = sorted(set(LEGACY_TIER_RE.findall(text)))
    if legacy_markers:
        blockers.append("removed 27B-1m tier referenced: " + ", ".join(legacy_markers))
    return blockers


def _native_upstream_review_blockers(text: str) -> list[str]:
    lower_text = text.lower()
    blockers: list[str] = []
    for fragment in NATIVE_UPSTREAM_REVIEW_REQUIRED_FRAGMENTS:
        if fragment.lower() not in lower_text:
            blockers.append(f"{fragment}: missing")
    unresolved = sorted(set(re.findall(r"\{[a-zA-Z0-9_.-]+\}", text)))
    if unresolved:
        blockers.append("unresolved template placeholders: " + ", ".join(unresolved[:8]))
    return blockers


def _text_context_variant_evidence_blockers(evidence: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if evidence.get("schema") != "eliza.eliza1_text_context_variant_audit.v1":
        blockers.append(f"schema: {evidence.get('schema')!r}")
    if evidence.get("repo") != ELIZA_1_HF_REPO:
        blockers.append(f"repo: {evidence.get('repo')!r}")
    if evidence.get("passed") is not True:
        blockers.append(f"passed: {evidence.get('passed')!r}")
    if evidence.get("blockers") not in ([], None):
        blockers.append("blockers: non-empty")
    if evidence.get("legacy27b1mPaths") not in ([], None):
        blockers.append("legacy27b1mPaths: non-empty")
    contexts = evidence.get("expectedContexts")
    if contexts != ["128k", "256k"]:
        blockers.append(f"expectedContexts: {contexts!r}")
    results = evidence.get("results")
    if not isinstance(results, list):
        blockers.append("results: missing")
        return blockers
    by_tier = {
        result.get("tier"): result
        for result in results
        if isinstance(result, Mapping) and isinstance(result.get("tier"), str)
    }
    for tier, expected_contexts in CONTEXTS_BY_TIER.items():
        result = by_tier.get(tier)
        if not isinstance(result, Mapping):
            blockers.append(f"{tier}: missing")
            continue
        if result.get("passed") is not True:
            blockers.append(f"{tier}.passed: {result.get('passed')!r}")
        required = result.get("requiredContexts")
        if not isinstance(required, list):
            blockers.append(f"{tier}.requiredContexts: missing")
            continue
        by_context = {
            item.get("context"): item
            for item in required
            if isinstance(item, Mapping) and isinstance(item.get("context"), str)
        }
        for ctx in expected_contexts:
            item = by_context.get(ctx)
            if not isinstance(item, Mapping):
                blockers.append(f"{tier}.{ctx}: missing")
                continue
            if item.get("existsOnHub") is not True:
                blockers.append(f"{tier}.{ctx}.existsOnHub: {item.get('existsOnHub')!r}")
            if item.get("blockers") not in ([], None):
                blockers.append(f"{tier}.{ctx}.blockers: non-empty")
    return blockers


def _imagegen_runtime_blockers(evidence: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if evidence.get("status") != "pass":
        blockers.append(f"status: {evidence.get('status')!r}")
    runtime = evidence.get("runtime")
    if not isinstance(runtime, Mapping):
        blockers.append("runtime: missing")
    else:
        if runtime.get("engine") != "stable-diffusion.cpp":
            blockers.append(f"runtime.engine: {runtime.get('engine')!r}")
        if runtime.get("upstreamRepo") != "leejet/stable-diffusion.cpp":
            blockers.append(f"runtime.upstreamRepo: {runtime.get('upstreamRepo')!r}")
        if not isinstance(runtime.get("upstreamCommit"), str) or not runtime.get("upstreamCommit"):
            blockers.append("runtime.upstreamCommit: missing")
        if not isinstance(runtime.get("binaryVersion"), str) or not runtime.get("binaryVersion"):
            blockers.append("runtime.binaryVersion: missing")

    probe = evidence.get("probe")
    if not isinstance(probe, Mapping):
        blockers.append("probe: missing")
    else:
        if probe.get("available") is not True:
            blockers.append(f"probe.available: {probe.get('available')!r}")
        models = probe.get("supportedModels")
        if not isinstance(models, list):
            blockers.append("probe.supportedModels: missing")
        else:
            missing_models = sorted(IMAGEGEN_REQUIRED_MODELS - set(models))
            blockers.extend(f"probe.supportedModels.{model}: missing" for model in missing_models)
        accelerators = probe.get("accelerators")
        if not isinstance(accelerators, list):
            blockers.append("probe.accelerators: missing")
        else:
            missing_accelerators = sorted(IMAGEGEN_REQUIRED_ACCELERATORS - set(accelerators))
            blockers.extend(
                f"probe.accelerators.{accelerator}: missing"
                for accelerator in missing_accelerators
            )

    memory = evidence.get("memory")
    if not isinstance(memory, Mapping):
        blockers.append("memory: missing")
    else:
        for feature in sorted(IMAGEGEN_REQUIRED_MEMORY_FEATURES):
            if memory.get(feature) is not True:
                blockers.append(f"memory.{feature}: {memory.get(feature)!r}")

    smoke = evidence.get("smoke")
    if not isinstance(smoke, Mapping):
        blockers.append("smoke: missing")
    else:
        if smoke.get("status") != "pass":
            blockers.append(f"smoke.status: {smoke.get('status')!r}")
        platforms = smoke.get("platforms")
        if not isinstance(platforms, Mapping):
            blockers.append("smoke.platforms: missing")
        else:
            for accelerator in sorted(IMAGEGEN_REQUIRED_ACCELERATORS):
                entry = platforms.get(accelerator)
                if not isinstance(entry, Mapping):
                    blockers.append(f"smoke.platforms.{accelerator}: missing")
                elif entry.get("status") != "pass":
                    blockers.append(
                        f"smoke.platforms.{accelerator}.status: {entry.get('status')!r}"
                    )
        model_smokes = smoke.get("models")
        if not isinstance(model_smokes, Mapping):
            blockers.append("smoke.models: missing")
        else:
            for model_id, smoke_key in sorted(IMAGEGEN_REQUIRED_MODEL_SMOKES.items()):
                entry = model_smokes.get(smoke_key)
                if not isinstance(entry, Mapping):
                    blockers.append(f"smoke.models.{model_id}: missing {smoke_key}")
                elif entry.get("status") != "pass":
                    detail = entry.get("error") or entry.get("architecture") or entry.get("report")
                    suffix = f" ({detail})" if detail else ""
                    blockers.append(
                        f"smoke.models.{model_id}.status: {entry.get('status')!r}{suffix}"
                    )
    return blockers


def _finetune_comparison_blockers(evidence: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if evidence.get("status") != "pass":
        blockers.append(f"status: {evidence.get('status')!r}")
    if evidence.get("modelRepo") != "elizaos/eliza-1":
        blockers.append(f"modelRepo: {evidence.get('modelRepo')!r}")
    if evidence.get("datasetRepo") != "elizaos/eliza-1-training":
        blockers.append(f"datasetRepo: {evidence.get('datasetRepo')!r}")
    if evidence.get("baselineReleaseState") != "base-v1":
        blockers.append(f"baselineReleaseState: {evidence.get('baselineReleaseState')!r}")
    if evidence.get("fineTunedReleaseState") != "finetuned-v2":
        blockers.append(f"fineTunedReleaseState: {evidence.get('fineTunedReleaseState')!r}")

    active_tiers = evidence.get("activeTiers")
    expected_tiers = list(ELIZA_1_TIERS)
    if active_tiers != expected_tiers:
        blockers.append(f"activeTiers: expected {expected_tiers!r}, got {active_tiers!r}")

    legacy_tiers = evidence.get("legacyTiers")
    if isinstance(legacy_tiers, list) and "0_6b" in legacy_tiers:
        blockers.append("legacy 0_6b comparison evidence is not current release evidence")

    comparisons = evidence.get("comparisons")
    if not isinstance(comparisons, Mapping):
        blockers.append("comparisons: missing")
        return blockers

    smallest_tier = ELIZA_1_TIERS[0]
    comparison = comparisons.get(smallest_tier)
    if not isinstance(comparison, Mapping):
        blockers.append(f"comparisons.{smallest_tier}: missing")
        if set(comparisons) == {"0_6b"}:
            blockers.append("comparisons only cover legacy 0_6b tier")
        return blockers

    if comparison.get("passed") is not True:
        blockers.append(f"comparisons.{smallest_tier}.passed: {comparison.get('passed')!r}")
    if comparison.get("beatsBaseline") is not True:
        blockers.append(
            f"comparisons.{smallest_tier}.beatsBaseline: {comparison.get('beatsBaseline')!r}"
        )
    for key in ("baselineModel", "fineTunedModel"):
        if not isinstance(comparison.get(key), str) or not comparison.get(key):
            blockers.append(f"comparisons.{smallest_tier}.{key}: missing")

    reports = comparison.get("reports")
    if not isinstance(reports, Mapping):
        blockers.append(f"comparisons.{smallest_tier}.reports: missing")
    else:
        missing_reports = sorted(FINETUNE_REQUIRED_METRICS - set(reports))
        blockers.extend(
            f"comparisons.{smallest_tier}.reports.{metric}: missing"
            for metric in missing_reports
        )
        for metric in sorted(FINETUNE_REQUIRED_METRICS & set(reports)):
            if not isinstance(reports.get(metric), str) or not reports.get(metric):
                blockers.append(f"comparisons.{smallest_tier}.reports.{metric}: empty")
    return blockers


def _manifest_lfs_hash_blockers(
    manifest: Mapping[str, Any],
    *,
    prefix: str,
    hub_lfs_sha256s: Mapping[str, str],
) -> list[str]:
    files = manifest.get("files")
    if not isinstance(files, Mapping):
        return ["missing manifest files block"]
    blockers: list[str] = []
    for entries in files.values():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, Mapping):
                continue
            rel = entry.get("path")
            expected = entry.get("sha256")
            if not isinstance(rel, str) or not isinstance(expected, str):
                continue
            actual = hub_lfs_sha256s.get(prefix + rel)
            if actual and actual != expected:
                blockers.append(f"{rel}: manifest={expected} hub={actual}")
    return blockers


def _parse_sha256sums(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or "  " not in line:
            continue
        digest, rel = line.split("  ", 1)
        if len(digest) == 64 and all(c in "0123456789abcdef" for c in digest):
            out[rel] = digest
    return out


def _checksum_lfs_hash_blockers(
    sums: Mapping[str, str],
    *,
    prefix: str,
    hub_lfs_sha256s: Mapping[str, str],
) -> list[str]:
    blockers: list[str] = []
    for path, actual in sorted(hub_lfs_sha256s.items()):
        if not path.startswith(prefix):
            continue
        rel = path[len(prefix):]
        expected = sums.get(rel)
        if expected is None:
            blockers.append(f"{rel}: missing")
        elif expected != actual:
            blockers.append(f"{rel}: checksum={expected} hub={actual}")
    return blockers


def _dataset_validation_blockers(
    manifest: Mapping[str, Any],
    validation: Mapping[str, Any],
) -> list[str]:
    blockers: list[str] = []
    if validation.get("schema") != DATASET_VALIDATION_SCHEMA:
        blockers.append(f"schema: {validation.get('schema')!r}")
    total = validation.get("totalRecords")
    valid = validation.get("validRecords")
    invalid = validation.get("invalidRecords")
    manifest_validation = manifest.get("validation")
    if isinstance(manifest_validation, Mapping):
        if manifest_validation.get("totalRecords") != total:
            blockers.append(
                f"totalRecords: {total!r} != manifest {manifest_validation.get('totalRecords')!r}"
            )
        if manifest_validation.get("validRecords") != valid:
            blockers.append(
                f"validRecords: {valid!r} != manifest {manifest_validation.get('validRecords')!r}"
            )
        if manifest_validation.get("invalidRecords") != invalid:
            blockers.append(
                f"invalidRecords: {invalid!r} != manifest {manifest_validation.get('invalidRecords')!r}"
            )
    if not isinstance(total, int) or total <= 0:
        blockers.append(f"totalRecords: {total!r}")
    if valid != total:
        blockers.append(f"validRecords: {valid!r} != totalRecords {total!r}")
    if invalid != 0:
        blockers.append(f"invalidRecords: {invalid!r}")
    errors = validation.get("errorsByCode")
    if not isinstance(errors, Mapping):
        blockers.append("errorsByCode: missing")
    elif errors:
        blockers.append(f"errorsByCode: {len(errors)}")
    record_schema = manifest.get("recordSchema")
    if record_schema and validation.get("recordSchema") != record_schema:
        blockers.append(
            f"recordSchema: {validation.get('recordSchema')!r} != manifest {record_schema!r}"
        )
    return blockers


def _dataset_live_audit_blockers(
    manifest: Mapping[str, Any],
    audit: Mapping[str, Any],
    *,
    dataset_repo: str,
    current_revision: str | None = None,
) -> list[str]:
    blockers: list[str] = []
    if audit.get("schema") != DATASET_LIVE_AUDIT_SCHEMA:
        blockers.append(f"schema: {audit.get('schema')!r}")
    if audit.get("datasetRepo") != dataset_repo:
        blockers.append(f"datasetRepo: {audit.get('datasetRepo')!r}")
    if not isinstance(audit.get("datasetRevision"), str) or not audit.get("datasetRevision"):
        blockers.append("datasetRevision: missing")
    if audit.get("passed") is not True:
        blockers.append(f"passed: {audit.get('passed')!r}")

    validation = audit.get("validation")
    if not isinstance(validation, Mapping):
        blockers.append("validation: missing")
    else:
        blockers.extend(
            f"validation.{blocker}"
            for blocker in _dataset_validation_blockers(manifest, validation)
        )

    if audit.get("hashMismatches") not in ([], None):
        blockers.append("hashMismatches: non-empty")

    legacy = audit.get("legacy27b1m")
    if not isinstance(legacy, Mapping):
        blockers.append("legacy27b1m: missing")
    elif legacy.get("passed") is not True:
        blockers.append(f"legacy27b1m.passed: {legacy.get('passed')!r}")

    secret_scan = audit.get("secretScan")
    if not isinstance(secret_scan, Mapping):
        blockers.append("secretScan: missing")
    elif secret_scan.get("passed") is not True:
        blockers.append(f"secretScan.passed: {secret_scan.get('passed')!r}")

    manifest_validation = manifest.get("validation")
    expected_total = (
        manifest_validation.get("totalRecords")
        if isinstance(manifest_validation, Mapping)
        else None
    )
    row_counts = audit.get("rowCounts")
    if isinstance(row_counts, Mapping) and isinstance(expected_total, int):
        observed_total = sum(
            value for value in row_counts.values() if isinstance(value, int)
        )
        if observed_total != expected_total:
            blockers.append(f"rowCounts total: {observed_total!r} != manifest {expected_total!r}")
    else:
        blockers.append("rowCounts: missing")
    return blockers


def _active_text_sft_blockers(
    manifest: Mapping[str, Any],
    validation: Mapping[str, Any],
) -> list[str]:
    blockers: list[str] = []
    if manifest.get("schema") != ACTIVE_TEXT_SFT_MANIFEST_SCHEMA:
        blockers.append(f"manifest.schema: {manifest.get('schema')!r}")
    if validation.get("schema") != ACTIVE_TEXT_SFT_VALIDATION_SCHEMA:
        blockers.append(f"validation.schema: {validation.get('schema')!r}")
    if validation.get("passed") is not True:
        blockers.append(f"validation.passed: {validation.get('passed')!r}")
    if validation.get("blockers") not in ([], None):
        blockers.append("validation.blockers: non-empty")
    if manifest.get("published_name") != f"eliza-1-{ACTIVE_TEXT_SFT_TIER}":
        blockers.append(f"manifest.published_name: {manifest.get('published_name')!r}")
    if manifest.get("base_model") != "Qwen/Qwen3.5-0.8B":
        blockers.append(f"manifest.base_model: {manifest.get('base_model')!r}")

    counts = manifest.get("counts")
    splits = validation.get("splits")
    if not isinstance(counts, Mapping):
        blockers.append("manifest.counts: missing")
    if not isinstance(splits, Mapping):
        blockers.append("validation.splits: missing")
    if isinstance(counts, Mapping) and isinstance(splits, Mapping):
        total = 0
        for split in ("train", "val", "test"):
            expected = counts.get(split)
            item = splits.get(split)
            actual = item.get("rows") if isinstance(item, Mapping) else None
            if not isinstance(expected, int) or expected <= 0:
                blockers.append(f"manifest.counts.{split}: {expected!r}")
            if actual != expected:
                blockers.append(f"validation.splits.{split}.rows: {actual!r} != {expected!r}")
            if isinstance(actual, int):
                total += actual
        if counts.get("total") != total:
            blockers.append(f"manifest.counts.total: {counts.get('total')!r} != {total!r}")

    privacy = manifest.get("privacy_filter")
    if not isinstance(privacy, Mapping):
        blockers.append("manifest.privacy_filter: missing")
    elif privacy.get("real_user_trajectories_consumed") != 0:
        blockers.append(
            "manifest.privacy_filter.real_user_trajectories_consumed: "
            f"{privacy.get('real_user_trajectories_consumed')!r}"
        )
    return blockers


def _dataset_privacy_blockers(manifest: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    privacy = manifest.get("privacy")
    if not isinstance(privacy, Mapping):
        return ["privacy: missing"]
    if privacy.get("reviewed") is not True:
        blockers.append(f"reviewed: {privacy.get('reviewed')!r}")
    if privacy.get("realUserExport") is not False:
        blockers.append(f"realUserExport: {privacy.get('realUserExport')!r}")
    attestation_source = privacy.get("attestationSource")
    if attestation_source not in DATASET_PRIVACY_ATTESTATION_SOURCES:
        blockers.append(f"attestationSource: {attestation_source!r}")
    residual_findings = privacy.get("residualFindingsCount")
    if residual_findings not in (None, 0):
        blockers.append(f"residualFindingsCount: {residual_findings!r}")
    return blockers


def _dataset_contract_blockers(manifest: Mapping[str, Any]) -> list[str]:
    contract = manifest.get("contract")
    if not isinstance(contract, Mapping):
        return ["contract: missing"]
    blockers: list[str] = []
    for key, expected in DATASET_REQUIRED_CONTRACT_FLAGS.items():
        actual = contract.get(key)
        if actual != expected:
            blockers.append(f"{key}: {actual!r} != {expected!r}")
    return blockers


def audit_hf_release(
    *,
    model_repo: str = ELIZA_1_HF_REPO,
    dataset_repo: str = DEFAULT_DATASET_REPO,
    fetch_json: JsonFetcher = hub_fetch_json,
    fetch_text: TextFetcher = hub_fetch_text,
) -> AuditReport:
    report = AuditReport(model_repo=model_repo, dataset_repo=dataset_repo)
    plan = build_plan()

    model_payload = fetch_json(_repo_api_url(MODEL_API, model_repo))
    model_paths = _sibling_paths(model_payload)
    model_lfs_sha256s = _sibling_lfs_sha256s(model_payload)
    report.check("model repo file list available", bool(model_paths), f"{len(model_paths)} files")
    report.check("model README present", "README.md" in model_paths, "README.md")
    try:
        model_readme = fetch_text(_raw_model_url(model_repo, "README.md"))
    except RuntimeError as exc:
        report.check("model README content passed", False, str(exc))
    else:
        model_card_blockers = _model_card_blockers(model_readme)
        report.check(
            "model README content passed",
            bool(model_readme) and not model_card_blockers,
            ", ".join(model_card_blockers[:8])
            + (f" (+{len(model_card_blockers) - 8} more)" if len(model_card_blockers) > 8 else ""),
        )
    report.check(
        "native upstream review evidence present",
        NATIVE_UPSTREAM_REVIEW_PATH in model_paths,
        NATIVE_UPSTREAM_REVIEW_PATH,
    )
    try:
        upstream_review = fetch_text(_raw_model_url(model_repo, NATIVE_UPSTREAM_REVIEW_PATH))
    except RuntimeError as exc:
        report.check("native upstream review content passed", False, str(exc))
    else:
        upstream_review_blockers = _native_upstream_review_blockers(upstream_review)
        report.check(
            "native upstream review content passed",
            bool(upstream_review) and not upstream_review_blockers,
            ", ".join(upstream_review_blockers[:8])
            + (f" (+{len(upstream_review_blockers) - 8} more)" if len(upstream_review_blockers) > 8 else ""),
        )
    report.check(
        "text context variant audit evidence present",
        TEXT_CONTEXT_VARIANT_EVIDENCE_PATH in model_paths,
        TEXT_CONTEXT_VARIANT_EVIDENCE_PATH,
    )
    try:
        text_context_evidence = json.loads(
            fetch_text(_raw_model_url(model_repo, TEXT_CONTEXT_VARIANT_EVIDENCE_PATH))
        )
    except (RuntimeError, json.JSONDecodeError) as exc:
        report.check("text context variant audit evidence passed", False, str(exc))
    else:
        text_context_blockers = (
            _text_context_variant_evidence_blockers(text_context_evidence)
            if isinstance(text_context_evidence, Mapping)
            else ["not an object"]
        )
        report.check(
            "text context variant audit evidence passed",
            not text_context_blockers,
            ", ".join(text_context_blockers[:8])
            + (f" (+{len(text_context_blockers) - 8} more)" if len(text_context_blockers) > 8 else ""),
        )
    report.check(
        "imagegen runtime evidence present",
        IMAGEGEN_RUNTIME_EVIDENCE_PATH in model_paths,
        IMAGEGEN_RUNTIME_EVIDENCE_PATH,
    )
    try:
        imagegen_runtime = json.loads(
            fetch_text(_raw_model_url(model_repo, IMAGEGEN_RUNTIME_EVIDENCE_PATH))
        )
    except (RuntimeError, json.JSONDecodeError) as exc:
        report.check("imagegen runtime evidence passed", False, str(exc))
    else:
        imagegen_blockers = (
            _imagegen_runtime_blockers(imagegen_runtime)
            if isinstance(imagegen_runtime, Mapping)
            else ["not an object"]
        )
        report.check(
            "imagegen runtime evidence passed",
            not imagegen_blockers,
            ", ".join(imagegen_blockers[:8])
            + (f" (+{len(imagegen_blockers) - 8} more)" if len(imagegen_blockers) > 8 else ""),
        )
    report.check(
        "fine-tune comparison evidence present",
        FINETUNE_COMPARISON_EVIDENCE_PATH in model_paths,
        FINETUNE_COMPARISON_EVIDENCE_PATH,
    )
    try:
        finetune_comparison = json.loads(
            fetch_text(_raw_model_url(model_repo, FINETUNE_COMPARISON_EVIDENCE_PATH))
        )
    except (RuntimeError, json.JSONDecodeError) as exc:
        report.check("fine-tune comparison evidence passed", False, str(exc))
    else:
        finetune_blockers = (
            _finetune_comparison_blockers(finetune_comparison)
            if isinstance(finetune_comparison, Mapping)
            else ["not an object"]
        )
        report.check(
            "fine-tune comparison evidence passed",
            not finetune_blockers,
            ", ".join(finetune_blockers[:8])
            + (f" (+{len(finetune_blockers) - 8} more)" if len(finetune_blockers) > 8 else ""),
        )

    for tier in ELIZA_1_TIERS:
        prefix = f"bundles/{tier}/"
        tier_paths = {path[len(prefix):] for path in model_paths if path.startswith(prefix)}
        report.check(f"{tier} bundle directory present", bool(tier_paths), f"{len(tier_paths)} files")
        report.check(
            f"{tier} manifest present",
            f"{prefix}eliza-1.manifest.json" in model_paths,
            f"{prefix}eliza-1.manifest.json",
        )
        missing = sorted(rel for rel in plan[tier].required_files if rel not in tier_paths)
        report.check(
            f"{tier} required release files present",
            not missing,
            ", ".join(missing[:8]) + (f" (+{len(missing) - 8} more)" if len(missing) > 8 else ""),
        )
        try:
            manifest_text = fetch_text(_raw_model_url(model_repo, f"{prefix}eliza-1.manifest.json"))
            manifest = json.loads(manifest_text)
        except (RuntimeError, json.JSONDecodeError) as exc:
            report.check(f"{tier} manifest JSON content available", False, str(exc))
            continue
        report.check(f"{tier} manifest JSON content available", True, f"{prefix}eliza-1.manifest.json")

        try:
            dflash_meta_text = fetch_text(_raw_model_url(model_repo, f"{prefix}dflash/target-meta.json"))
            dflash_meta = json.loads(dflash_meta_text)
        except (RuntimeError, json.JSONDecodeError) as exc:
            report.check(f"{tier} MTP drafter release evidence passed", False, str(exc))
        else:
            dflash_meta_blockers = _dflash_target_meta_blockers(dflash_meta)
            report.check(
                f"{tier} MTP drafter release evidence passed",
                not dflash_meta_blockers,
                ", ".join(dflash_meta_blockers[:8])
                + (f" (+{len(dflash_meta_blockers) - 8} more)" if len(dflash_meta_blockers) > 8 else ""),
            )

        try:
            release_evidence_text = fetch_text(_raw_model_url(model_repo, f"{prefix}evidence/release.json"))
            release_evidence = json.loads(release_evidence_text)
        except (RuntimeError, json.JSONDecodeError) as exc:
            report.check(f"{tier} structured response release evidence passed", False, str(exc))
        else:
            release_evidence_blockers = _release_evidence_publishable_blockers(
                release_evidence,
                tier=tier,
                required_files=plan[tier].required_files,
            )
            report.check(
                f"{tier} release evidence is publishable",
                not release_evidence_blockers,
                ", ".join(release_evidence_blockers[:8])
                + (f" (+{len(release_evidence_blockers) - 8} more)" if len(release_evidence_blockers) > 8 else ""),
            )
            structured_response_blockers = _release_structured_response_blockers(release_evidence)
            report.check(
                f"{tier} structured response release evidence passed",
                not structured_response_blockers,
                ", ".join(structured_response_blockers[:8])
                + (f" (+{len(structured_response_blockers) - 8} more)" if len(structured_response_blockers) > 8 else ""),
            )

        text_context_blockers = _manifest_text_context_blockers(manifest, tier)
        report.check(
            f"{tier} manifest records native and half context text variants",
            not text_context_blockers,
            ", ".join(text_context_blockers[:8]) + (f" (+{len(text_context_blockers) - 8} more)" if len(text_context_blockers) > 8 else ""),
        )
        manifest_required_file_blockers = _manifest_required_file_blockers(
            manifest,
            required_files=plan[tier].required_files,
        )
        report.check(
            f"{tier} manifest files cover required runtime artifacts",
            not manifest_required_file_blockers,
            ", ".join(manifest_required_file_blockers[:8]) + (f" (+{len(manifest_required_file_blockers) - 8} more)" if len(manifest_required_file_blockers) > 8 else ""),
        )
        runtime_lineage_blockers = _manifest_runtime_lineage_blockers(manifest)
        report.check(
            f"{tier} manifest records shipped runtime component lineage",
            not runtime_lineage_blockers,
            ", ".join(runtime_lineage_blockers[:8]) + (f" (+{len(runtime_lineage_blockers) - 8} more)" if len(runtime_lineage_blockers) > 8 else ""),
        )

        manifest_hash_blockers = _manifest_lfs_hash_blockers(
            manifest,
            prefix=prefix,
            hub_lfs_sha256s=model_lfs_sha256s,
        )
        report.check(
            f"{tier} manifest LFS hashes match Hub metadata",
            not manifest_hash_blockers,
            ", ".join(manifest_hash_blockers[:8]) + (f" (+{len(manifest_hash_blockers) - 8} more)" if len(manifest_hash_blockers) > 8 else ""),
        )

        try:
            checksum_text = fetch_text(_raw_model_url(model_repo, f"{prefix}checksums/SHA256SUMS"))
            checksum_sums = _parse_sha256sums(checksum_text)
        except RuntimeError as exc:
            report.check(f"{tier} checksum manifest available", False, str(exc))
        else:
            report.check(f"{tier} checksum manifest available", bool(checksum_sums), f"{prefix}checksums/SHA256SUMS")
            missing_checksum_rels = sorted(
                rel for rel in plan[tier].required_files
                if rel != "checksums/SHA256SUMS" and rel not in checksum_sums
            )
            report.check(
                f"{tier} checksums cover required release files",
                not missing_checksum_rels,
                ", ".join(missing_checksum_rels[:8]) + (f" (+{len(missing_checksum_rels) - 8} more)" if len(missing_checksum_rels) > 8 else ""),
            )
            checksum_hash_blockers = _checksum_lfs_hash_blockers(
                checksum_sums,
                prefix=prefix,
                hub_lfs_sha256s=model_lfs_sha256s,
            )
            report.check(
                f"{tier} checksum LFS hashes match Hub metadata",
                not checksum_hash_blockers,
                ", ".join(checksum_hash_blockers[:8]) + (f" (+{len(checksum_hash_blockers) - 8} more)" if len(checksum_hash_blockers) > 8 else ""),
            )

        backend_blockers = _manifest_backend_blockers(manifest, SUPPORTED_BACKENDS_BY_TIER[tier])
        report.check(
            f"{tier} required backend verification passed",
            not backend_blockers,
            ", ".join(backend_blockers[:8]) + (f" (+{len(backend_blockers) - 8} more)" if len(backend_blockers) > 8 else ""),
        )
        platform_blockers = _platform_evidence_blockers(
            tier=tier,
            prefix=prefix,
            model_repo=model_repo,
            model_paths=model_paths,
            targets=plan[tier].required_platform_evidence,
            fetch_text=fetch_text,
        )
        report.check(
            f"{tier} required platform evidence passed",
            not platform_blockers,
            ", ".join(platform_blockers[:8])
            + (f" (+{len(platform_blockers) - 8} more)" if len(platform_blockers) > 8 else ""),
        )
        quantization_blockers = _quantization_sidecar_blockers(
            tier=tier,
            prefix=prefix,
            model_repo=model_repo,
            model_paths=model_paths,
            expected_text_quant=plan[tier].text_quant,
            expected_contexts=plan[tier].contexts,
            fetch_text=fetch_text,
        )
        report.check(
            f"{tier} quantization sidecars passed",
            not quantization_blockers,
            ", ".join(quantization_blockers[:8])
            + (f" (+{len(quantization_blockers) - 8} more)" if len(quantization_blockers) > 8 else ""),
        )

        try:
            aggregate_text = fetch_text(_raw_model_url(model_repo, f"{prefix}evals/aggregate.json"))
            aggregate = json.loads(aggregate_text)
        except (RuntimeError, json.JSONDecodeError):
            eval_blockers = _eval_gate_blockers(manifest.get("evals"))
        else:
            eval_blockers = _aggregate_gate_blockers(aggregate)
        report.check(
            f"{tier} manifest eval gates passed",
            not eval_blockers,
            ", ".join(eval_blockers[:8]) + (f" (+{len(eval_blockers) - 8} more)" if len(eval_blockers) > 8 else ""),
        )

    legacy_model_paths = sorted(
        path for path in model_paths if any(marker in path for marker in LEGACY_TIER_MARKERS)
    )
    report.check(
        "model repo has no removed 27B-1m tier artifacts",
        not legacy_model_paths,
        ", ".join(legacy_model_paths[:8]),
    )

    dataset_payload = fetch_json(_repo_api_url(DATASET_API, dataset_repo))
    dataset_paths = _sibling_paths(dataset_payload)
    dataset_revision = dataset_payload.get("sha") if isinstance(dataset_payload.get("sha"), str) else None
    report.check("dataset repo file list available", bool(dataset_paths), f"{len(dataset_paths)} files")
    report.check("dataset README present", "README.md" in dataset_paths, "README.md")
    report.check(
        "dataset manifest or candidates present",
        "manifest.json" in dataset_paths or any(path.startswith("candidates/") for path in dataset_paths),
        "manifest.json or candidates/",
    )
    missing_pipeline_docs = [
        path for path in DATASET_REQUIRED_PIPELINE_DOCS if path not in dataset_paths
    ]
    report.check(
        "dataset pipeline includes smallest-tier fine-tuning runbook",
        not missing_pipeline_docs,
        ", ".join(missing_pipeline_docs),
    )
    missing_parquet_files = [
        path for path in DATASET_VIEWER_PARQUET_SPLIT_FILES if path not in dataset_paths
    ]
    missing_jsonl_files = [
        path for path in DATASET_VIEWER_JSONL_SPLIT_FILES if path not in dataset_paths
    ]
    report.check(
        "dataset has Dataset Viewer-compatible root split files",
        not missing_parquet_files or not missing_jsonl_files,
        "missing parquet: "
        + ", ".join(missing_parquet_files)
        + "; missing jsonl: "
        + ", ".join(missing_jsonl_files),
    )
    report.check(
        "dataset has canonical native root JSONL split files",
        not missing_jsonl_files,
        ", ".join(missing_jsonl_files),
    )
    report.check(
        "dataset has HF datasets parquet mirror split files",
        not missing_parquet_files,
        ", ".join(missing_parquet_files),
    )
    legacy_dataset_paths = sorted(
        path for path in dataset_paths if any(marker in path for marker in LEGACY_TIER_MARKERS)
    )
    report.check(
        "dataset repo has no removed 27B-1m tier artifacts",
        not legacy_dataset_paths,
        ", ".join(legacy_dataset_paths[:8]),
    )
    report.check(
        "dataset live validation audit present",
        DATASET_LIVE_AUDIT_PATH in dataset_paths,
        DATASET_LIVE_AUDIT_PATH,
    )
    missing_active_sft_files = [
        path for path in ACTIVE_TEXT_SFT_REQUIRED_FILES if path not in dataset_paths
    ]
    report.check(
        "dataset active 0_8b SFT package present",
        not missing_active_sft_files,
        ", ".join(missing_active_sft_files),
    )

    try:
        dataset_readme = fetch_text(_raw_dataset_url(dataset_repo, "README.md"))
    except RuntimeError as exc:
        report.check("dataset README content available", False, str(exc))
    else:
        legacy_readme_markers = sorted(set(LEGACY_TIER_RE.findall(dataset_readme)))
        report.check("dataset README content available", bool(dataset_readme), "README.md")
        report.check(
            "dataset README has no removed 27B-1m tier references",
            not legacy_readme_markers,
            ", ".join(legacy_readme_markers),
        )

    try:
        dataset_manifest_text = fetch_text(_raw_dataset_url(dataset_repo, "manifest.json"))
        dataset_manifest = json.loads(dataset_manifest_text)
    except (RuntimeError, json.JSONDecodeError) as exc:
        report.check("dataset manifest JSON available", False, str(exc))
    else:
        schema = str(dataset_manifest.get("schema", ""))
        purpose = str(dataset_manifest.get("purpose", ""))
        report.check("dataset manifest JSON available", True, schema or "manifest.json")
        report.check(
            "dataset manifest is not a smoke-corpus manifest",
            "smoke" not in schema.lower() and "smoke" not in purpose.lower(),
            f"schema={schema!r} purpose={purpose[:120]!r}",
        )
        contract_blockers = _dataset_contract_blockers(dataset_manifest)
        report.check(
            "dataset training contract passed",
            not contract_blockers,
            ", ".join(contract_blockers),
        )
        privacy_blockers = _dataset_privacy_blockers(dataset_manifest)
        report.check(
            "dataset privacy attestation passed",
            not privacy_blockers,
            ", ".join(privacy_blockers),
        )
        validation_info = dataset_manifest.get("validation")
        validation_path = (
            validation_info.get("reportPath")
            if isinstance(validation_info, Mapping)
            else None
        )
        if not isinstance(validation_path, str) or not validation_path:
            report.check("dataset native-record validation report passed", False, "manifest.validation.reportPath missing")
        elif validation_path not in dataset_paths:
            report.check("dataset native-record validation report passed", False, validation_path)
        else:
            try:
                validation_text = fetch_text(_raw_dataset_url(dataset_repo, validation_path))
                validation = json.loads(validation_text)
            except (RuntimeError, json.JSONDecodeError) as exc:
                report.check("dataset native-record validation report passed", False, str(exc))
            else:
                validation_blockers = _dataset_validation_blockers(dataset_manifest, validation)
                report.check(
                    "dataset native-record validation report passed",
                    not validation_blockers,
                    ", ".join(validation_blockers[:8])
                    + (f" (+{len(validation_blockers) - 8} more)" if len(validation_blockers) > 8 else ""),
                )
        if DATASET_LIVE_AUDIT_PATH in dataset_paths:
            try:
                live_audit_text = fetch_text(_raw_dataset_url(dataset_repo, DATASET_LIVE_AUDIT_PATH))
                live_audit = json.loads(live_audit_text)
            except (RuntimeError, json.JSONDecodeError) as exc:
                report.check("dataset live validation audit passed", False, str(exc))
            else:
                live_audit_blockers = _dataset_live_audit_blockers(
                    dataset_manifest,
                    live_audit,
                    dataset_repo=dataset_repo,
                    current_revision=dataset_revision,
                )
                report.check(
                    "dataset live validation audit passed",
                    not live_audit_blockers,
                    ", ".join(live_audit_blockers[:8])
                    + (f" (+{len(live_audit_blockers) - 8} more)" if len(live_audit_blockers) > 8 else ""),
                )
        else:
            report.check(
                "dataset live validation audit passed",
                False,
                DATASET_LIVE_AUDIT_PATH,
            )
        if missing_active_sft_files:
            report.check(
                "dataset active 0_8b SFT validation passed",
                False,
                ", ".join(missing_active_sft_files),
            )
        else:
            try:
                active_sft_manifest = json.loads(
                    fetch_text(_raw_dataset_url(dataset_repo, f"{ACTIVE_TEXT_SFT_ROOT}/manifest.json"))
                )
                active_sft_validation = json.loads(
                    fetch_text(_raw_dataset_url(dataset_repo, f"{ACTIVE_TEXT_SFT_ROOT}/validation.json"))
                )
            except (RuntimeError, json.JSONDecodeError) as exc:
                report.check("dataset active 0_8b SFT validation passed", False, str(exc))
            else:
                active_sft_blockers = (
                    _active_text_sft_blockers(active_sft_manifest, active_sft_validation)
                    if isinstance(active_sft_manifest, Mapping)
                    and isinstance(active_sft_validation, Mapping)
                    else ["manifest or validation not an object"]
                )
                report.check(
                    "dataset active 0_8b SFT validation passed",
                    not active_sft_blockers,
                    ", ".join(active_sft_blockers[:8])
                    + (f" (+{len(active_sft_blockers) - 8} more)" if len(active_sft_blockers) > 8 else ""),
                )

    try:
        splits_payload = fetch_json(_repo_api_url(DATASET_SPLITS_API, dataset_repo))
    except RuntimeError as exc:
        report.check("dataset viewer splits available", False, str(exc))
    else:
        splits = _split_names(splits_payload)
        report.check("dataset viewer splits available", bool(splits), ", ".join(sorted(splits)))
        report.check(
            "dataset exposes train/validation/test splits",
            {"train", "validation", "test"}.issubset(splits),
            ", ".join(sorted(splits)),
        )

    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--model-repo", default=ELIZA_1_HF_REPO)
    ap.add_argument("--dataset-repo", default=DEFAULT_DATASET_REPO)
    ap.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    ap.add_argument("--summary", action="store_true", help="Emit grouped failure summary JSON.")
    args = ap.parse_args(argv)

    report = audit_hf_release(model_repo=args.model_repo, dataset_repo=args.dataset_repo)
    if args.summary:
        print(json.dumps(report.summary(), indent=2, sort_keys=True))
    elif args.json:
        print(
            json.dumps(
                {
                    "modelRepo": report.model_repo,
                    "datasetRepo": report.dataset_repo,
                    "ok": report.ok,
                    "checks": report.checks,
                },
                indent=2,
                sort_keys=True,
            )
        )
    else:
        print(report.render())
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
