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
    from scripts.manifest.eliza1_manifest import ELIZA_1_HF_REPO, ELIZA_1_TIERS, SUPPORTED_BACKENDS_BY_TIER
    from scripts.manifest.eliza1_platform_plan import build_plan
except ImportError:  # pragma: no cover - script execution path
    from eliza1_manifest import ELIZA_1_HF_REPO, ELIZA_1_TIERS, SUPPORTED_BACKENDS_BY_TIER
    from eliza1_platform_plan import build_plan

DEFAULT_DATASET_REPO = "elizaos/eliza-1-training"
LEGACY_TIER_MARKERS = ("27b-1m", "27B-1m", "27b_1m", "27B_1M")
LEGACY_TIER_RE = re.compile(r"27b[-_ ]?1m", re.IGNORECASE)
DATASET_VIEWER_PARQUET_SPLIT_FILES = (
    "data/train-00000-of-00001.parquet",
    "data/validation-00000-of-00001.parquet",
    "data/test-00000-of-00001.parquet",
)
DATASET_VIEWER_JSONL_SPLIT_FILES = ("train.jsonl", "val.jsonl", "test.jsonl")
MODEL_API = "https://huggingface.co/api/models/{repo}"
DATASET_API = "https://huggingface.co/api/datasets/{repo}"
DATASET_SPLITS_API = "https://datasets-server.huggingface.co/splits?dataset={repo}"

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
            elif name.endswith("required backend verification passed"):
                by_category["backendVerification"].append(item)
            elif name.endswith("manifest eval gates passed"):
                by_category["manifestEvalGates"].append(item)
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
    report.check("dataset repo file list available", bool(dataset_paths), f"{len(dataset_paths)} files")
    report.check("dataset README present", "README.md" in dataset_paths, "README.md")
    report.check(
        "dataset manifest or candidates present",
        "manifest.json" in dataset_paths or any(path.startswith("candidates/") for path in dataset_paths),
        "manifest.json or candidates/",
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
    legacy_dataset_paths = sorted(
        path for path in dataset_paths if any(marker in path for marker in LEGACY_TIER_MARKERS)
    )
    report.check(
        "dataset repo has no removed 27B-1m tier artifacts",
        not legacy_dataset_paths,
        ", ".join(legacy_dataset_paths[:8]),
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
