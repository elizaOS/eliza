"""Release publishing: evidence."""

from __future__ import annotations
from eliza_training.lib.file_integrity import sha256_file as _sha256_file
import json
from pathlib import Path
from typing import Any, Mapping, Sequence
from eliza_training.manifest.eliza1_manifest import (  # noqa: E402
    ELIZA_1_MTP_TIERS,
    ELIZA_1_HF_REPO,
    ELIZA_1_PROVENANCE_SLOTS,
    ELIZA_1_VISION_TIERS,
    SUPPORTED_BACKENDS_BY_TIER,
    canonical_source_repo_error,
)
from eliza_training.manifest.eliza1_platform_plan import (  # noqa: E402
    REQUIRED_PLATFORM_EVIDENCE_BY_TIER,
)
from .context import (
    BASE_V1_RELEASE_FINAL_FLAGS,
    CHECKSUMS_PATH,
    EXIT_MISSING_FILE,
    EXIT_RELEASE_EVIDENCE_FAIL,
    EXIT_USAGE,
    OrchestratorError,
    PublishContext,
    RELEASE_EVIDENCE_PATH,
    REQUIRED_RELEASE_FINAL_FLAGS,
    _bundle_repo_path,
)
from .layout import (
    _build_upload_list,
    _license_files_for_layout,
    _read_sidecar,
    _required_graph_cache_families_for_tier,
)


def validate_destination_repo(ctx: PublishContext) -> None:
    expected = ELIZA_1_HF_REPO
    if ctx.repo_id != expected:
        raise OrchestratorError(
            f"Eliza-1 bundle publishes must target {expected}; got {ctx.repo_id!r}. "
            "Use a non-release publisher for experiments or custom checkpoints.",
            EXIT_USAGE,
        )


def _relative_file_paths(paths: Sequence[Path], bundle_root: Path) -> list[str]:
    return [str(p.relative_to(bundle_root)) for p in paths]


def _release_blocking_reasons(evidence: Mapping[str, Any]) -> list[str]:
    reasons = evidence.get("publishBlockingReasons")
    if not isinstance(reasons, list):
        return []
    return [reason for reason in reasons if isinstance(reason, str) and reason.strip()]


def _expected_payload_paths(
    ctx: PublishContext, layout: Mapping[str, Sequence[Path]]
) -> list[str]:
    """Return the files whose bytes must be covered by SHA256SUMS.

    The generated manifest + README are intentionally absent here because
    they are produced later by the orchestrator. ``checksums/SHA256SUMS``
    is also absent to avoid a circular hash. Every input artifact that
    reaches the HF upload path is included, including release evidence.
    """

    expected: list[str] = []
    for kind_src in (
        "text",
        "tts",
        "asr",
        "vision",
        "mtp",
        "cache",
        "embedding",
        "vad",
        "wakeword",
    ):
        expected.extend(_relative_file_paths(layout.get(kind_src, []), ctx.bundle_dir))

    expected.extend(f"licenses/{name}" for name in _license_files_for_layout(layout))

    evals_dir = ctx.bundle_dir / "evals"
    expected.extend(
        f"evals/{p.name}" for p in sorted(evals_dir.iterdir()) if p.is_file()
    )

    expected.extend(
        _relative_file_paths(layout.get("quantization_sidecars", []), ctx.bundle_dir)
    )
    evidence_dir = ctx.bundle_dir / "evidence"
    expected.extend(
        str(p.relative_to(ctx.bundle_dir))
        for p in sorted(evidence_dir.rglob("*"))
        if p.is_file()
    )

    return sorted(set(expected))


def _parse_sha256s(path: Path) -> dict[str, str]:
    """Parse a standard ``sha256sum`` file.

    Format accepted per line: ``<64 lowercase hex><space><space><path>``.
    Empty lines and comments are ignored.
    """

    if not path.is_file():
        raise OrchestratorError(
            f"release evidence: missing {CHECKSUMS_PATH}",
            EXIT_MISSING_FILE,
        )

    out: dict[str, str] = {}
    for line_no, raw in enumerate(path.read_text().splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            raise OrchestratorError(
                f"{CHECKSUMS_PATH}:{line_no}: expected '<sha256>  <path>'",
                EXIT_RELEASE_EVIDENCE_FAIL,
            )
        sha, rel = parts[0], parts[1].strip()
        if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
            raise OrchestratorError(
                f"{CHECKSUMS_PATH}:{line_no}: invalid sha256 {sha!r}",
                EXIT_RELEASE_EVIDENCE_FAIL,
            )
        out[rel] = sha
    return out


def _assert_checksum_coverage(
    ctx: PublishContext, layout: Mapping[str, Sequence[Path]]
) -> None:
    expected = _expected_payload_paths(ctx, layout)
    recorded = _parse_sha256s(ctx.bundle_dir / CHECKSUMS_PATH)

    missing = [rel for rel in expected if rel not in recorded]
    if missing:
        raise OrchestratorError(
            f"release evidence: checksum manifest missing required path(s): {missing}",
            EXIT_RELEASE_EVIDENCE_FAIL,
        )

    missing_recorded_files = [
        rel for rel in sorted(recorded) if not (ctx.bundle_dir / rel).is_file()
    ]
    if missing_recorded_files:
        raise OrchestratorError(
            "release evidence: checksum manifest references missing file(s): "
            f"{missing_recorded_files}",
            EXIT_RELEASE_EVIDENCE_FAIL,
        )

    mismatched: list[str] = []
    for rel in sorted(recorded):
        actual = _sha256_file(ctx.bundle_dir / rel)
        if recorded[rel] != actual:
            mismatched.append(rel)
    if mismatched:
        raise OrchestratorError(
            f"release evidence: checksum mismatch for path(s): {mismatched}",
            EXIT_RELEASE_EVIDENCE_FAIL,
        )


def _write_checksum_manifest(
    ctx: PublishContext,
    layout: Mapping[str, Sequence[Path]],
) -> Path:
    """Write checksums for all payload inputs except the checksum file itself."""

    checksum_path = ctx.bundle_dir / CHECKSUMS_PATH
    checksum_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"{_sha256_file(ctx.bundle_dir / rel)}  {rel}"
        for rel in _expected_payload_paths(ctx, layout)
    ]
    checksum_path.write_text("\n".join(lines) + "\n")
    return checksum_path


def _text_model_sha256s(
    ctx: PublishContext,
    layout: Mapping[str, Sequence[Path]],
) -> set[str]:
    return {_sha256_file(path) for path in layout.get("text", []) if path.is_file()}


def _require_existing_json_report(
    ctx: PublishContext,
    *,
    label: str,
    backend: str | None = None,
    target: str | None = None,
    rel_path: str,
    require_runtime_ready: bool,
    model_sha256s: set[str] | None = None,
    required_cache_families: Sequence[str] = (),
) -> Mapping[str, Any]:
    if not rel_path.startswith(("evals/", "evidence/")):
        raise OrchestratorError(
            f"release evidence: {label} report path must live under evals/ "
            f"or evidence/: {rel_path}",
            EXIT_RELEASE_EVIDENCE_FAIL,
        )
    path = ctx.bundle_dir / rel_path
    if not path.is_file():
        raise OrchestratorError(
            f"release evidence: missing {label} report "
            f"{backend or target or ''}: {rel_path}",
            EXIT_MISSING_FILE,
        )
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise OrchestratorError(
            f"release evidence: invalid JSON in {rel_path}: {exc}",
            EXIT_RELEASE_EVIDENCE_FAIL,
        ) from exc
    if not isinstance(data, dict):
        raise OrchestratorError(
            f"release evidence: {rel_path} must contain a JSON object",
            EXIT_RELEASE_EVIDENCE_FAIL,
        )
    if backend is not None and data.get("backend") != backend:
        raise OrchestratorError(
            f"release evidence: {rel_path} backend {data.get('backend')!r} "
            f"does not match {backend!r}",
            EXIT_RELEASE_EVIDENCE_FAIL,
        )
    if target is not None and data.get("target") != target:
        raise OrchestratorError(
            f"release evidence: {rel_path} target {data.get('target')!r} "
            f"does not match {target!r}",
            EXIT_RELEASE_EVIDENCE_FAIL,
        )
    accepted_statuses = {"pass"} if require_runtime_ready else {"pass", "passed"}
    if data.get("status") not in accepted_statuses:
        raise OrchestratorError(
            f"release evidence: {rel_path} status {data.get('status')!r}, "
            f"expected one of {sorted(accepted_statuses)!r}",
            EXIT_RELEASE_EVIDENCE_FAIL,
        )
    if require_runtime_ready:
        _validate_runtime_dispatch_report(
            rel_path,
            data,
            model_sha256s=model_sha256s,
            required_cache_families=required_cache_families,
        )
    else:
        _validate_platform_report(rel_path, data, target=target)
    return data


def _required_provenance_slots(
    layout: Mapping[str, Sequence[Path]],
) -> tuple[str, ...]:
    slots = ["text", "voice", "drafter"]
    for slot in ("asr", "vad", "embedding", "vision"):
        if layout.get(slot):
            slots.append(slot)
    return tuple(slots)


def _provenance_from_release_evidence(
    evidence: Mapping[str, Any],
) -> dict[str, Any] | None:
    """Return the manifest provenance block implied by release evidence."""

    source_models = evidence.get("sourceModels")
    if not isinstance(source_models, dict):
        return None
    return {
        "releaseState": evidence.get("releaseState"),
        "finetuned": evidence.get("finetuned"),
        "sourceModels": {
            slot: dict(source)
            for slot, source in source_models.items()
            if isinstance(source, Mapping)
        },
    }


def _validate_base_v1_provenance(
    *,
    evidence: Mapping[str, Any],
    layout: Mapping[str, Sequence[Path]],
    tier: str,
    errors: list[str],
) -> None:
    if evidence.get("finetuned") is not False:
        errors.append("finetuned must be false for releaseState='base-v1'")

    source_models = evidence.get("sourceModels")
    if not isinstance(source_models, dict) or not source_models:
        errors.append(
            "sourceModels must be a non-empty object for releaseState='base-v1'"
        )
        return

    for slot, source in source_models.items():
        if slot not in ELIZA_1_PROVENANCE_SLOTS:
            errors.append(f"sourceModels contains unknown component slot {slot!r}")
            continue
        if not isinstance(source, dict):
            errors.append(f"sourceModels.{slot} must be an object")
            continue
        if not isinstance(source.get("repo"), str) or not source.get("repo"):
            errors.append(f"sourceModels.{slot}.repo must be a non-empty string")
        elif (
            repo_error := canonical_source_repo_error(slot, source["repo"], tier=tier)
        ) is not None:
            errors.append(f"sourceModels.{slot}.repo {repo_error}")

    for slot in _required_provenance_slots(layout):
        if slot not in source_models:
            errors.append(f"sourceModels.{slot} required for releaseState='base-v1'")


def _validate_runtime_dispatch_report(
    rel_path: str,
    data: Mapping[str, Any],
    *,
    model_sha256s: set[str] | None = None,
    required_cache_families: Sequence[str] = (),
) -> None:
    errors: list[str] = []
    if data.get("runtimeReady") is not True:
        errors.append("runtimeReady must be true")
    at_commit = data.get("atCommit") or data.get("at_commit")
    if not isinstance(at_commit, str) or not at_commit:
        errors.append("atCommit required")
    if not isinstance(data.get("report"), str) or not data.get("report"):
        errors.append("report required")
    model_sha = data.get("modelSha256")
    if (
        not isinstance(model_sha, str)
        or len(model_sha) != 64
        or any(c not in "0123456789abcdef" for c in model_sha)
    ):
        errors.append("modelSha256 must be 64 lowercase hex chars")
    elif model_sha256s and model_sha not in model_sha256s:
        errors.append("modelSha256 must match a shipped text GGUF sha256")
    kernel_set = data.get("kernelSet")
    if not isinstance(kernel_set, list) or not all(
        isinstance(k, str) for k in kernel_set
    ):
        errors.append("kernelSet must be an array of strings")
    else:
        missing = sorted(set(required_cache_families) - set(kernel_set))
        if missing:
            errors.append(f"kernelSet missing {missing}")
    graph = data.get("graphDispatch")
    if not isinstance(graph, dict):
        errors.append("graphDispatch must be an object")
    else:
        families = graph.get("cacheFamilies")
        if not isinstance(families, list) or not all(
            isinstance(f, str) for f in families
        ):
            errors.append("graphDispatch.cacheFamilies must be an array of strings")
        else:
            missing = sorted(set(required_cache_families) - set(families))
            if missing:
                errors.append(f"graphDispatch.cacheFamilies missing {missing}")
        command = graph.get("command")
        if not isinstance(command, str) or "--cache-type-k" not in command:
            errors.append("graphDispatch.command must include --cache-type-k")
        if not isinstance(graph.get("logs"), list) or not graph.get("logs"):
            errors.append("graphDispatch.logs must be a non-empty array")
    device = data.get("device")
    if not isinstance(device, (dict, str)) or device == "":
        errors.append("device required")
    if errors:
        raise OrchestratorError(
            f"release evidence: runtime dispatch report {rel_path} invalid:\n  - "
            + "\n  - ".join(errors),
            EXIT_RELEASE_EVIDENCE_FAIL,
        )


def _validate_platform_report(
    rel_path: str,
    data: Mapping[str, Any],
    *,
    target: str | None,
) -> None:
    errors: list[str] = []
    if not isinstance(data.get("device"), (dict, str)) or data.get("device") == "":
        errors.append("device required")
    if not isinstance(data.get("atCommit") or data.get("at_commit"), str):
        errors.append("atCommit required")
    if not isinstance(data.get("report"), str) or not data.get("report"):
        errors.append("report required")
    if data.get("skippedVoiceAbi") is True:
        errors.append("skippedVoiceAbi must not be true")
    if target == "ios-arm64-metal" and data.get("voiceAbi") not in (
        True,
        "pass",
        "passed",
    ):
        errors.append("ios-arm64-metal platform evidence must prove voiceAbi")
    if errors:
        raise OrchestratorError(
            f"release evidence: platform report {rel_path} invalid:\n  - "
            + "\n  - ".join(errors),
            EXIT_RELEASE_EVIDENCE_FAIL,
        )


def validate_release_evidence(
    ctx: PublishContext,
    layout: Mapping[str, Sequence[Path]],
    *,
    allow_uploaded_evidence: bool = False,
) -> dict[str, Any]:
    """Validate final release evidence before any upload path runs.

    This is deliberately stricter than the manifest schema. The manifest
    proves the runtime can load the bundle; this sidecar proves release
    operators used final artifacts and have backend/platform evidence for
    the exact bytes being uploaded.
    """

    evidence_path = ctx.bundle_dir / RELEASE_EVIDENCE_PATH
    evidence = _read_sidecar(evidence_path)

    errors: list[str] = []
    release_blockers = _release_blocking_reasons(evidence)
    use_release_blockers = evidence.get("publishEligible") is not True and bool(
        release_blockers
    )
    if evidence.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1")
    if evidence.get("tier") != ctx.tier:
        errors.append(f"tier must be {ctx.tier!r}")
    if evidence.get("repoId") != ctx.repo_id:
        errors.append(f"repoId must be {ctx.repo_id!r}")

    release_state = evidence.get("releaseState")
    if release_state not in {"base-v1", "upload-candidate", "final"}:
        if not use_release_blockers:
            errors.append(
                "releaseState must be 'base-v1', 'upload-candidate', or 'final'"
            )
    elif release_state == "base-v1":
        _validate_base_v1_provenance(
            evidence=evidence,
            layout=layout,
            tier=ctx.tier,
            errors=errors,
        )

    final = evidence.get("final")
    if not isinstance(final, dict):
        errors.append("final must be an object")
    else:
        required_final_flags = (
            BASE_V1_RELEASE_FINAL_FLAGS
            if release_state == "base-v1"
            else REQUIRED_RELEASE_FINAL_FLAGS
        )
        for flag in required_final_flags:
            if final.get(flag) is not True and not use_release_blockers:
                errors.append(f"final.{flag} must be true")

    if use_release_blockers:
        errors.extend(
            f"publishBlockingReasons: {reason}" for reason in release_blockers
        )
    elif evidence.get("publishEligible") is False:
        errors.append("publishEligible must be true")

    checksum_manifest = evidence.get("checksumManifest")
    if checksum_manifest != str(CHECKSUMS_PATH):
        errors.append(f"checksumManifest must be {str(CHECKSUMS_PATH)!r}")

    weights = evidence.get("weights")
    if not isinstance(weights, list) or not all(isinstance(p, str) for p in weights):
        errors.append("weights must be an array of bundle-relative paths")
    else:
        shipped_weight_files = [
            p
            for kind in ("text", "tts", "asr", "vad", "embedding", "wakeword")
            for p in layout.get(kind, [])
        ]
        if ctx.tier in ELIZA_1_VISION_TIERS:
            shipped_weight_files.extend(layout.get("vision", []))
        if ctx.tier in ELIZA_1_MTP_TIERS:
            shipped_weight_files.extend(
                p for p in layout.get("mtp", []) if p.suffix == ".gguf"
            )
        shipped_weight_paths = set(
            _relative_file_paths(shipped_weight_files, ctx.bundle_dir)
        )
        missing_weights = sorted(shipped_weight_paths - set(weights))
        if missing_weights:
            errors.append(f"weights missing shipped artifact(s): {missing_weights}")

    missing_artifacts: list[str] = []

    eval_reports = evidence.get("evalReports")
    if not isinstance(eval_reports, list) or "evals/aggregate.json" not in eval_reports:
        errors.append("evalReports must include 'evals/aggregate.json'")
    elif not all(isinstance(p, str) for p in eval_reports):
        errors.append("evalReports must be an array of strings")
    else:
        missing_eval_report_files = [
            p for p in eval_reports if not (ctx.bundle_dir / p).is_file()
        ]
        expected_eval_reports = sorted(
            f"evals/{p.name}"
            for p in (ctx.bundle_dir / "evals").iterdir()
            if p.is_file()
        )
        missing_from_evidence = sorted(set(expected_eval_reports) - set(eval_reports))
        if missing_eval_report_files:
            missing_artifacts.append(
                f"evalReports contains missing file(s): {missing_eval_report_files}"
            )
        if missing_from_evidence:
            errors.append(
                "evalReports missing shipped eval/report file(s): "
                f"{missing_from_evidence}"
            )

    license_files = evidence.get("licenseFiles")
    expected_licenses = [
        f"licenses/{name}" for name in _license_files_for_layout(layout)
    ]
    if license_files != expected_licenses:
        errors.append(f"licenseFiles must equal {expected_licenses!r}")

    hf = evidence.get("hf")
    if not isinstance(hf, dict):
        errors.append("hf must be an object")
    elif hf.get("repoId") != ctx.repo_id:
        errors.append(f"hf.repoId must be {ctx.repo_id!r}")

    if missing_artifacts:
        raise OrchestratorError(
            "release evidence missing artifact(s):\n  - "
            + "\n  - ".join(missing_artifacts),
            EXIT_MISSING_FILE,
        )

    if errors:
        raise OrchestratorError(
            "release evidence invalid:\n  - " + "\n  - ".join(errors),
            EXIT_RELEASE_EVIDENCE_FAIL,
        )

    supported = SUPPORTED_BACKENDS_BY_TIER[ctx.tier]
    kernel_reports = evidence.get("kernelDispatchReports")
    if not isinstance(kernel_reports, dict):
        raise OrchestratorError(
            "release evidence: kernelDispatchReports must be an object",
            EXIT_RELEASE_EVIDENCE_FAIL,
        )
    platform_evidence = evidence.get("platformEvidence")
    if not isinstance(platform_evidence, dict):
        raise OrchestratorError(
            "release evidence: platformEvidence must be an object",
            EXIT_RELEASE_EVIDENCE_FAIL,
        )

    text_model_sha256s = _text_model_sha256s(ctx, layout)
    for backend in supported:
        dispatch_path = kernel_reports.get(backend)
        if not isinstance(dispatch_path, str):
            raise OrchestratorError(
                f"release evidence: kernelDispatchReports.{backend} required",
                EXIT_RELEASE_EVIDENCE_FAIL,
            )
        _require_existing_json_report(
            ctx,
            label="kernel dispatch",
            backend=backend,
            rel_path=dispatch_path,
            require_runtime_ready=True,
            model_sha256s=text_model_sha256s,
            required_cache_families=_required_graph_cache_families_for_tier(
                ctx.tier,
            ),
        )

    for target in REQUIRED_PLATFORM_EVIDENCE_BY_TIER[ctx.tier]:
        platform_path = platform_evidence.get(target)
        if not isinstance(platform_path, str):
            raise OrchestratorError(
                f"release evidence: platformEvidence.{target} required",
                EXIT_RELEASE_EVIDENCE_FAIL,
            )
        _require_existing_json_report(
            ctx,
            label="platform",
            target=target,
            rel_path=platform_path,
            require_runtime_ready=False,
        )

    if release_state == "final" or (
        release_state == "base-v1"
        and isinstance(hf, dict)
        and hf.get("status") == "uploaded"
    ):
        if (
            release_state == "base-v1"
            and not ctx.dry_run
            and not allow_uploaded_evidence
        ):
            raise OrchestratorError(
                "release evidence: base-v1 evidence must carry "
                "hf.status='pending-upload' before a real publish",
                EXIT_RELEASE_EVIDENCE_FAIL,
            )
        upload_evidence = hf.get("uploadEvidence") if isinstance(hf, dict) else None
        if not isinstance(upload_evidence, dict):
            raise OrchestratorError(
                "release evidence: uploaded releaseState requires hf.uploadEvidence",
                EXIT_RELEASE_EVIDENCE_FAIL,
            )
        if upload_evidence.get("repoId") != ctx.repo_id:
            raise OrchestratorError(
                f"release evidence: hf.uploadEvidence.repoId must be {ctx.repo_id!r}",
                EXIT_RELEASE_EVIDENCE_FAIL,
            )
        if not upload_evidence.get("commit") or not upload_evidence.get("url"):
            raise OrchestratorError(
                "release evidence: hf.uploadEvidence requires commit and url",
                EXIT_RELEASE_EVIDENCE_FAIL,
            )
        if upload_evidence.get("status") != "uploaded":
            raise OrchestratorError(
                "release evidence: hf.uploadEvidence.status must be 'uploaded'",
                EXIT_RELEASE_EVIDENCE_FAIL,
            )
        uploaded_paths = upload_evidence.get("uploadedPaths")
        if not isinstance(uploaded_paths, list) or not all(
            isinstance(p, str) for p in uploaded_paths
        ):
            raise OrchestratorError(
                "release evidence: hf.uploadEvidence.uploadedPaths must be "
                "an array of paths",
                EXIT_RELEASE_EVIDENCE_FAIL,
            )
        expected_uploaded_paths = {
            _bundle_repo_path(ctx, "eliza-1.manifest.json"),
            _bundle_repo_path(ctx, "README.md"),
            *(target for _, target in _build_upload_list(ctx, layout)),
        }
        missing_uploaded_paths = sorted(expected_uploaded_paths - set(uploaded_paths))
        if missing_uploaded_paths:
            raise OrchestratorError(
                "release evidence: hf.uploadEvidence.uploadedPaths missing "
                f"payload path(s): {missing_uploaded_paths}",
                EXIT_RELEASE_EVIDENCE_FAIL,
            )
    elif not ctx.dry_run:
        hf_status = hf.get("status") if isinstance(hf, dict) else None
        if hf_status != "pending-upload" and not allow_uploaded_evidence:
            raise OrchestratorError(
                "release evidence: pre-upload evidence must carry "
                "hf.status='pending-upload' before a real publish",
                EXIT_RELEASE_EVIDENCE_FAIL,
            )

    _assert_checksum_coverage(ctx, layout)
    return evidence
