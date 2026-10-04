"""Release publishing: layout."""

from __future__ import annotations
from eliza_training.lib.file_integrity import sha256_file as _sha256_file
import json
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from eliza_training.manifest.eliza1_manifest import (  # noqa: E402
    ELIZA_1_MTP_TIERS,
    ELIZA_1_VISION_TIERS,
    REQUIRED_KERNELS_BY_TIER,
    VOICE_PRESET_CACHE_PATH,
    required_voice_artifacts_for_tier,
)
from eliza_training.manifest.eliza1_platform_plan import (  # noqa: E402
    required_files_for_tier,
)
from eliza_training.manifest.eliza1_licenses import (  # noqa: E402
    verify_bundle_licenses,
)
from .context import (
    COMPONENT_LICENSE_FILES,
    EXIT_BUNDLE_LAYOUT_FAIL,
    EXIT_MISSING_FILE,
    EXIT_RELEASE_EVIDENCE_FAIL,
    OrchestratorError,
    PublishContext,
    REQUIRED_GRAPH_CACHE_FAMILIES_BY_KERNEL,
    REQUIRED_KERNEL_MANIFEST_KEYS,
    REQUIRED_KERNEL_TARGETS_BY_SIDECAR,
    REQUIRED_LICENSE_FILES,
    REQUIRED_METHOD_BY_SIDECAR,
    REQUIRED_QUANTIZATION_SIDECARS,
    REQUIRED_QUANTIZATION_SIDECARS_BY_KERNEL,
    REQUIRED_SUBDIRS,
    _bundle_repo_path,
    _optional_float,
)


def _read_sidecar(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise OrchestratorError(f"missing sidecar: {path}", EXIT_MISSING_FILE)
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise OrchestratorError(
            f"invalid JSON sidecar {path}: {exc}",
            EXIT_BUNDLE_LAYOUT_FAIL,
        ) from exc
    if not isinstance(data, dict):
        raise OrchestratorError(
            f"sidecar {path} must contain a JSON object",
            EXIT_BUNDLE_LAYOUT_FAIL,
        )
    return data


def _find_sidecar(bundle: Path, names: Sequence[str]) -> Path | None:
    for name in names:
        for base in (
            bundle,
            bundle / "text",
            bundle / "mtp",
            bundle / "evals",
            bundle / "quantization",
        ):
            candidate = base / name
            if candidate.is_file():
                return candidate
    return None


def _find_sidecar_by_name(bundle: Path, name: str) -> Path | None:
    return _find_sidecar(bundle, (name,))


def _kernel_targets(kernel_manifest: Mapping[str, Any]) -> set[str]:
    targets = kernel_manifest.get("kernel_target")
    if isinstance(targets, str):
        return {targets}
    if isinstance(targets, list):
        return {str(target) for target in targets}
    return set()


def _unique_preserving_order(values: Iterable[str]) -> tuple[str, ...]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value in seen:
            continue
        out.append(value)
        seen.add(value)
    return tuple(out)


def _required_quantization_sidecar_names_for_tier(tier: str) -> tuple[str, ...]:
    names: list[str] = []
    for kernel in REQUIRED_KERNELS_BY_TIER[tier]:
        names.extend(REQUIRED_QUANTIZATION_SIDECARS_BY_KERNEL.get(kernel, ()))
    return _unique_preserving_order(names)


def _known_quantization_sidecar_names() -> tuple[str, ...]:
    return _unique_preserving_order(
        name for names in REQUIRED_QUANTIZATION_SIDECARS.values() for name in names
    )


def _required_graph_cache_families_for_tier(tier: str) -> tuple[str, ...]:
    families: list[str] = []
    for kernel in REQUIRED_KERNELS_BY_TIER[tier]:
        families.extend(REQUIRED_GRAPH_CACHE_FAMILIES_BY_KERNEL.get(kernel, ()))
    return _unique_preserving_order(families)


def _validate_quantization_sidecars(bundle: Path, *, tier: str) -> list[Path]:
    found: list[Path] = []
    required_names = set(_required_quantization_sidecar_names_for_tier(tier))
    for name in _known_quantization_sidecar_names():
        sidecar = _find_sidecar_by_name(bundle, name)
        if sidecar is None:
            if name in required_names:
                method = REQUIRED_METHOD_BY_SIDECAR[name]
                raise OrchestratorError(
                    "bundle layout: missing quantization sidecar for "
                    f"{method}; expected {name} in bundle root, text/, "
                    "mtp/, evals/, or quantization/",
                    EXIT_MISSING_FILE,
                )
            continue

        data = _read_sidecar(sidecar)
        kernel_manifest = data.get("kernel_manifest")
        if not isinstance(kernel_manifest, dict):
            raise OrchestratorError(
                f"quantization sidecar {sidecar} missing kernel_manifest object",
                EXIT_BUNDLE_LAYOUT_FAIL,
            )
        expected_method = REQUIRED_METHOD_BY_SIDECAR[name]
        if data.get("method") != expected_method:
            raise OrchestratorError(
                f"quantization sidecar {sidecar} method must be "
                f"{expected_method!r}; got {data.get('method')!r}",
                EXIT_BUNDLE_LAYOUT_FAIL,
            )
        missing_keys = [
            key for key in REQUIRED_KERNEL_MANIFEST_KEYS if key not in kernel_manifest
        ]
        if missing_keys:
            raise OrchestratorError(
                f"quantization sidecar {sidecar} has partial "
                f"kernel_manifest; missing {missing_keys}",
                EXIT_BUNDLE_LAYOUT_FAIL,
            )
        targets = _kernel_targets(kernel_manifest)
        if not targets:
            raise OrchestratorError(
                f"quantization sidecar {sidecar} kernel_manifest.kernel_target "
                "must be a non-empty array",
                EXIT_BUNDLE_LAYOUT_FAIL,
            )
        expected_targets = set(REQUIRED_KERNEL_TARGETS_BY_SIDECAR[name])
        missing_targets = sorted(expected_targets - targets)
        if missing_targets:
            raise OrchestratorError(
                f"quantization sidecar {sidecar} targets {sorted(targets)} "
                f"but must cover {sorted(expected_targets)}; missing "
                f"{missing_targets}",
                EXIT_BUNDLE_LAYOUT_FAIL,
            )
        for manifest_field in (
            "block_layout_version",
            "codebook_hash",
            "per_block_tolerance",
        ):
            section = kernel_manifest.get(manifest_field)
            if not isinstance(section, dict):
                raise OrchestratorError(
                    f"quantization sidecar {sidecar} kernel_manifest.{manifest_field} "
                    "must be an object",
                    EXIT_BUNDLE_LAYOUT_FAIL,
                )
            missing_field_targets = sorted(expected_targets - set(section))
            if missing_field_targets:
                raise OrchestratorError(
                    f"quantization sidecar {sidecar} kernel_manifest.{manifest_field} "
                    f"missing target metadata for {missing_field_targets}",
                    EXIT_BUNDLE_LAYOUT_FAIL,
                )
            for target in expected_targets:
                value = section.get(target)
                if manifest_field == "per_block_tolerance":
                    if (
                        not isinstance(value, (int, float))
                        or isinstance(value, bool)
                        or value <= 0
                    ):
                        raise OrchestratorError(
                            f"quantization sidecar {sidecar} "
                            f"kernel_manifest.{manifest_field}.{target} must be a "
                            "positive number",
                            EXIT_BUNDLE_LAYOUT_FAIL,
                        )
                elif not isinstance(value, str) or not value:
                    raise OrchestratorError(
                        f"quantization sidecar {sidecar} "
                        f"kernel_manifest.{manifest_field}.{target} must be a "
                        "non-empty string",
                        EXIT_BUNDLE_LAYOUT_FAIL,
                    )
        found.append(sidecar)
    return found


def _license_files_for_layout(layout: Mapping[str, Sequence[Path]]) -> tuple[str, ...]:
    names = list(REQUIRED_LICENSE_FILES)
    for kind, name in COMPONENT_LICENSE_FILES.items():
        if layout.get(kind):
            names.append(name)
    return tuple(names)


def _license_components_for_layout(
    layout: Mapping[str, Sequence[Path]],
    bundle_dir: Path,
) -> list[str]:
    components = ["text", "voice", "asr", "vad", "mtp"]
    tts_rels = {
        path.relative_to(bundle_dir).as_posix()
        for path in layout.get("tts", [])
        if path.is_file()
    }
    if any(rel.startswith("tts/kokoro/") for rel in tts_rels):
        components.append("kokoro")
    if any(Path(rel).name.startswith("omnivoice-") for rel in tts_rels):
        components.append("omnivoice")
    for opt in ("vision", "embedding", "wakeword"):
        if layout.get(opt):
            components.append(opt)
    return components


def _validate_mtp_release_metadata(
    ctx: PublishContext,
    layout: Mapping[str, Sequence[Path]],
) -> None:
    """Validate mtp/target-meta.json before any release can be assembled.

    The runtime can fail late with `unknown model architecture: 'mtp-draft'`
    or silently draft zero tokens when tokenizer metadata differs. Release
    bundles therefore need a static sidecar proving the drafter belongs to the
    shipped target bytes, shares tokenizer metadata, and is loadable by the
    declared runtime shape.
    """

    meta_path = ctx.bundle_dir / "mtp" / "target-meta.json"
    if not meta_path.is_file():
        raise OrchestratorError(
            "MTP release metadata: missing mtp/target-meta.json",
            EXIT_MISSING_FILE,
        )
    meta = _read_sidecar(meta_path)
    errors: list[str] = []

    if meta.get("schemaVersion") != 2:
        errors.append("schemaVersion must be 2")
    if meta.get("tier") != ctx.tier:
        errors.append(f"tier must be {ctx.tier!r}")
    if meta.get("publishEligible") is not True:
        errors.append("publishEligible must be true")

    text_paths = {
        str(path.relative_to(ctx.bundle_dir)): path
        for path in layout.get("text", [])
        if path.is_file()
    }
    mtp_paths = {
        str(path.relative_to(ctx.bundle_dir)): path
        for path in layout.get("mtp", [])
        if path.is_file()
    }

    target_text = meta.get("targetText")
    target_sha: str | None = None
    if not isinstance(target_text, dict):
        errors.append("targetText must be an object")
    else:
        target_path = target_text.get("path")
        if not isinstance(target_path, str) or target_path not in text_paths:
            errors.append("targetText.path must point at a shipped text/*.gguf")
        else:
            actual = _sha256_file(text_paths[target_path])
            recorded = target_text.get("sha256")
            if recorded != actual:
                errors.append(
                    f"targetText.sha256 mismatch for {target_path}: "
                    f"recorded {recorded!r}, actual {actual}"
                )
            else:
                target_sha = actual

    drafter = meta.get("drafter")
    drafter_sha: str | None = None
    if not isinstance(drafter, dict):
        errors.append("drafter must be an object")
    else:
        drafter_path = drafter.get("path")
        if not isinstance(drafter_path, str) or drafter_path not in mtp_paths:
            errors.append("drafter.path must point at a shipped mtp/*.gguf")
        else:
            actual = _sha256_file(mtp_paths[drafter_path])
            recorded = drafter.get("sha256")
            if recorded != actual:
                errors.append(
                    f"drafter.sha256 mismatch for {drafter_path}: "
                    f"recorded {recorded!r}, actual {actual}"
                )
            else:
                drafter_sha = actual

        if target_sha is not None:
            if drafter.get("targetCheckpointSha256") != target_sha:
                errors.append(
                    "drafter.targetCheckpointSha256 must equal targetText.sha256"
                )
            if drafter.get("matchesTargetCheckpoint") is not True:
                errors.append("drafter.matchesTargetCheckpoint must be true")
        if (
            drafter_sha is not None
            and target_sha is not None
            and drafter_sha == target_sha
        ):
            errors.append(
                "drafter sha256 equals target text sha256; a same-weight drafter "
                "is not a release-valid MTP artifact"
            )

        architecture = drafter.get("architecture")
        if not isinstance(architecture, str) or not architecture:
            errors.append("drafter.architecture must be recorded")
        elif architecture == "mtp-draft":
            runtime = meta.get("runtime")
            if (
                not isinstance(runtime, dict)
                or runtime.get("supportsMtpDraftArchitecture") is not True
            ):
                errors.append(
                    "drafter.architecture is 'mtp-draft' but "
                    "runtime.supportsMtpDraftArchitecture is not true"
                )

    tokenizer = meta.get("tokenizerCompatibility")
    if not isinstance(tokenizer, dict):
        errors.append("tokenizerCompatibility must be an object")
    else:
        mismatches = tokenizer.get("mismatches")
        if tokenizer.get("compatible") is not True:
            errors.append(
                "tokenizerCompatibility.compatible must be true"
                + (f"; mismatches={mismatches!r}" if mismatches else "")
            )
        if mismatches not in (None, []):
            errors.append(
                f"tokenizerCompatibility.mismatches must be empty: {mismatches!r}"
            )

    acceptance_rate = meta.get("acceptanceRate")
    if not isinstance(acceptance_rate, (int, float)) or isinstance(
        acceptance_rate, bool
    ):
        errors.append("acceptanceRate must be numeric")
    acceptance_window = meta.get("acceptanceWindow")
    if (
        not isinstance(acceptance_window, list)
        or len(acceptance_window) != 2
        or not all(isinstance(value, int) for value in acceptance_window)
    ):
        errors.append("acceptanceWindow must be [draftMin, draftMax]")

    validation_path = ctx.bundle_dir / "mtp" / "validation-real.json"
    if not validation_path.is_file():
        errors.append("mtp/validation-real.json is required")
    else:
        validation = _read_sidecar(validation_path)
        if validation.get("pass") is not True:
            errors.append("mtp/validation-real.json pass must be true")
        checks = validation.get("checks")
        rollout = checks.get("acceptanceRollout") if isinstance(checks, dict) else None
        if not isinstance(rollout, dict):
            errors.append(
                "mtp/validation-real.json checks.acceptanceRollout is required"
            )
        else:
            if rollout.get("pass") is not True:
                errors.append(
                    "mtp/validation-real.json acceptanceRollout.pass must be true"
                )
            report_rate = _optional_float(rollout.get("acceptanceRate"))
            report_gate = _optional_float(rollout.get("gate"))
            if (
                report_rate is not None
                and isinstance(acceptance_rate, (int, float))
                and not isinstance(acceptance_rate, bool)
                and report_rate < float(acceptance_rate)
            ):
                errors.append(
                    "mtp/validation-real.json acceptanceRate must be at least "
                    "target-meta acceptanceRate"
                )
            if (
                report_gate is not None
                and report_rate is not None
                and report_rate < report_gate
            ):
                errors.append(
                    "mtp/validation-real.json acceptanceRate is below its gate"
                )

    runtime_path = ctx.bundle_dir / "mtp" / "runtime-smoke-native.json"
    if not runtime_path.is_file():
        errors.append("mtp/runtime-smoke-native.json is required")
    else:
        runtime = _read_sidecar(runtime_path)
        if runtime.get("metadataStatus") != "metadata_loadable":
            errors.append(
                "mtp/runtime-smoke-native.json metadataStatus must be metadata_loadable"
            )
        if runtime.get("metadataFailures") not in (None, []):
            errors.append(
                "mtp/runtime-smoke-native.json metadataFailures must be empty"
            )
        runs = runtime.get("runtime")
        accepted_run = False
        if isinstance(runs, list):
            for run in runs:
                if not isinstance(run, dict) or run.get("status") != 0:
                    continue
                mtp = run.get("mtp")
                if not isinstance(mtp, dict):
                    continue
                accepted_run = (
                    mtp.get("requiresTrueDrafting") is True
                    and mtp.get("draftingActive") is True
                    and isinstance(mtp.get("drafted"), int)
                    and mtp.get("drafted") > 0
                    and isinstance(mtp.get("accepted"), int)
                    and mtp.get("accepted") > 0
                    and not mtp.get("mtpFailure")
                )
                if accepted_run:
                    break
        if not accepted_run:
            errors.append(
                "mtp/runtime-smoke-native.json must include an accepted native MTP run"
            )
        bench = runtime.get("bench")
        if not isinstance(bench, dict):
            errors.append("mtp/runtime-smoke-native.json bench is required")
        else:
            if bench.get("available") is not True:
                errors.append(
                    "mtp/runtime-smoke-native.json bench.available must be true"
                )
            if bench.get("status") != "pass":
                errors.append("mtp/runtime-smoke-native.json bench.status must be pass")
            if not isinstance(bench.get("drafted"), int) or bench.get("drafted") <= 0:
                errors.append(
                    "mtp/runtime-smoke-native.json bench.drafted must be positive"
                )
            if not isinstance(bench.get("accepted"), int) or bench.get("accepted") <= 0:
                errors.append(
                    "mtp/runtime-smoke-native.json bench.accepted must be positive"
                )
            bench_rate = _optional_float(bench.get("acceptanceRate"))
            bench_gate = _optional_float(bench.get("gate"))
            if bench_gate is None:
                rollout = meta.get("acceptanceRollout")
                bench_gate = (
                    _optional_float(rollout.get("gate"))
                    if isinstance(rollout, dict)
                    else None
                )
            if (
                bench_gate is not None
                and bench_rate is not None
                and bench_rate < bench_gate
            ):
                errors.append(
                    "mtp/runtime-smoke-native.json bench.acceptanceRate is below gate"
                )
            if (
                bench_rate is not None
                and isinstance(acceptance_rate, (int, float))
                and not isinstance(acceptance_rate, bool)
                and bench_rate < float(acceptance_rate)
            ):
                errors.append(
                    "mtp/runtime-smoke-native.json bench.acceptanceRate must be at least target-meta acceptanceRate"
                )
            speedup = _optional_float(bench.get("speedup"))
            if speedup is None or speedup <= 1.0:
                errors.append(
                    "mtp/runtime-smoke-native.json bench.speedup must be greater than 1"
                )
            summary = bench.get("summary")
            if isinstance(summary, dict):
                if summary.get("status") != "pass":
                    errors.append(
                        "mtp/runtime-smoke-native.json bench.summary.status must be pass"
                    )
                if summary.get("mtpDraftingActive") is not True:
                    errors.append(
                        "mtp/runtime-smoke-native.json bench.summary.mtpDraftingActive must be true"
                    )

    if errors:
        raise OrchestratorError(
            "MTP release metadata invalid:\n  - " + "\n  - ".join(errors),
            EXIT_RELEASE_EVIDENCE_FAIL,
        )


def _validate_mtp_disabled_metadata(
    ctx: PublishContext,
    layout: Mapping[str, Sequence[Path]],
) -> None:
    """Validate the explicit no-MTP release policy for non-MTP tiers."""

    meta_path = ctx.bundle_dir / "mtp" / "target-meta.json"
    if not meta_path.is_file():
        raise OrchestratorError(
            "MTP disabled metadata: missing mtp/target-meta.json",
            EXIT_MISSING_FILE,
        )
    meta = _read_sidecar(meta_path)
    errors: list[str] = []

    if meta.get("schemaVersion") != 2:
        errors.append("schemaVersion must be 2")
    if meta.get("tier") != ctx.tier:
        errors.append(f"tier must be {ctx.tier!r}")
    if meta.get("status") != "disabled":
        errors.append("status must be 'disabled'")
    if meta.get("mtpEnabled") is not False:
        errors.append("mtpEnabled must be false")
    if meta.get("publishEligible") is True:
        errors.append("publishEligible must not be true when MTP is disabled")
    if meta.get("drafter") is not None:
        errors.append("drafter must be null when MTP is disabled")
    if meta.get("acceptanceRate") is not None:
        errors.append("acceptanceRate must be null when MTP is disabled")
    if meta.get("acceptanceWindow") is not None:
        errors.append("acceptanceWindow must be null when MTP is disabled")

    mtp_ggufs = sorted(
        str(path.relative_to(ctx.bundle_dir))
        for path in layout.get("mtp", [])
        if path.suffix == ".gguf"
    )
    if mtp_ggufs:
        errors.append(
            "MTP is disabled for this tier; remove shipped drafter GGUF(s): "
            f"{mtp_ggufs}"
        )

    text_paths = {
        str(path.relative_to(ctx.bundle_dir)): path
        for path in layout.get("text", [])
        if path.is_file()
    }
    target_text = meta.get("targetText")
    if not isinstance(target_text, dict):
        errors.append("targetText must be an object")
    else:
        target_path = target_text.get("path")
        if not isinstance(target_path, str) or target_path not in text_paths:
            errors.append("targetText.path must point at a shipped text/*.gguf")
        else:
            actual = _sha256_file(text_paths[target_path])
            if target_text.get("sha256") != actual:
                errors.append(
                    f"targetText.sha256 mismatch for {target_path}: "
                    f"recorded {target_text.get('sha256')!r}, actual {actual}"
                )

    disabled_policy = meta.get("disabledPolicy")
    if not isinstance(disabled_policy, dict):
        errors.append("disabledPolicy must be an object")
    else:
        policy_path = disabled_policy.get("path")
        if not isinstance(policy_path, str):
            errors.append("disabledPolicy.path must be recorded")
        else:
            policy_file = ctx.bundle_dir / policy_path
            if not policy_file.is_file():
                errors.append(f"disabledPolicy.path does not exist: {policy_path}")
            else:
                recorded = disabled_policy.get("sha256")
                actual = _sha256_file(policy_file)
                if recorded != actual:
                    errors.append(
                        f"disabledPolicy.sha256 mismatch for {policy_path}: "
                        f"recorded {recorded!r}, actual {actual}"
                    )
                policy = _read_sidecar(policy_file)
                if policy.get("kind") != "mtp-release-policy":
                    errors.append(
                        "disabledPolicy file kind must be 'mtp-release-policy'"
                    )
                if policy.get("tier") != ctx.tier:
                    errors.append(f"disabledPolicy file tier must be {ctx.tier!r}")
                if policy.get("status") != "disabled":
                    errors.append("disabledPolicy file status must be 'disabled'")
                if policy.get("requiresDrafter") is not False:
                    errors.append("disabledPolicy file requiresDrafter must be false")
                if policy.get("releaseEligibleWithoutDrafter") is not True:
                    errors.append(
                        "disabledPolicy file releaseEligibleWithoutDrafter must be true"
                    )
        if disabled_policy.get("requiresDrafter") is not False:
            errors.append("disabledPolicy.requiresDrafter must be false")
        if disabled_policy.get("releaseMode") != "fail-open-no-drafter":
            errors.append("disabledPolicy.releaseMode must be 'fail-open-no-drafter'")

    if errors:
        raise OrchestratorError(
            "MTP disabled metadata invalid:\n  - " + "\n  - ".join(errors),
            EXIT_RELEASE_EVIDENCE_FAIL,
        )


def validate_bundle_layout(ctx: PublishContext) -> dict[str, list[Path]]:
    """Enforce the §2 layout and return the files selected for publishing.

    A missing required subdir/file is publish-blocking. ``vision/`` and
    ``asr/`` are tier-conditional but, when present, must contain at
    least one ``.gguf`` (asr is allowed to ship a tokenizer/native
    package — we only require the directory in that case).
    """

    bundle = ctx.bundle_dir
    if not bundle.is_dir():
        raise OrchestratorError(
            f"bundle dir does not exist: {bundle}", EXIT_BUNDLE_LAYOUT_FAIL
        )

    out: dict[str, list[Path]] = {}
    for sub in REQUIRED_SUBDIRS:
        d = bundle / sub
        if not d.is_dir():
            raise OrchestratorError(
                f"bundle layout: missing required subdir {sub}/",
                EXIT_BUNDLE_LAYOUT_FAIL,
            )
        out[sub] = sorted(p for p in d.rglob("*") if p.is_file())

    if not out["text"]:
        raise OrchestratorError(
            "bundle layout: text/ must contain at least one .gguf",
            EXIT_BUNDLE_LAYOUT_FAIL,
        )
    if not out["tts"]:
        raise OrchestratorError(
            "bundle layout: tts/ must contain at least one .gguf",
            EXIT_BUNDLE_LAYOUT_FAIL,
        )
    required_tts = set(required_voice_artifacts_for_tier(ctx.tier))
    tts_paths = {str(p.relative_to(bundle / "tts")) for p in out["tts"]}
    missing_tts = sorted(required_tts - tts_paths)
    if missing_tts:
        raise OrchestratorError(
            f"bundle layout: missing frozen voice artifact(s) in tts/: {missing_tts}",
            EXIT_MISSING_FILE,
        )
    mtp_ggufs = [path for path in out["mtp"] if path.suffix == ".gguf"]
    if ctx.tier in ELIZA_1_MTP_TIERS:
        if not mtp_ggufs:
            raise OrchestratorError(
                "bundle layout: mtp/ must contain at least one .gguf",
                EXIT_BUNDLE_LAYOUT_FAIL,
            )
        _validate_mtp_release_metadata(ctx, out)
    else:
        _validate_mtp_disabled_metadata(ctx, out)
    if not out["asr"]:
        raise OrchestratorError(
            "bundle layout: asr/ must contain at least one model file",
            EXIT_BUNDLE_LAYOUT_FAIL,
        )
    if not out["vad"]:
        raise OrchestratorError(
            "bundle layout: vad/ must contain at least one VAD model file",
            EXIT_BUNDLE_LAYOUT_FAIL,
        )
    voice_cache = bundle / VOICE_PRESET_CACHE_PATH
    if not voice_cache.is_file():
        raise OrchestratorError(
            f"bundle layout: missing frozen voice cache {VOICE_PRESET_CACHE_PATH}",
            EXIT_MISSING_FILE,
        )
    if voice_cache.stat().st_size == 0:
        raise OrchestratorError(
            f"bundle layout: empty frozen voice cache {VOICE_PRESET_CACHE_PATH}",
            EXIT_MISSING_FILE,
        )
    if not out["cache"]:
        raise OrchestratorError(
            "bundle layout: cache/ must contain at least one cache file",
            EXIT_BUNDLE_LAYOUT_FAIL,
        )

    # Optional runtime payloads. Ignore stale unsupported optional files on disk
    # so a non-vision tier is judged by the manifest-supported payload.
    for opt in ("vision", "embedding", "wakeword"):
        d = bundle / opt
        if opt == "vision" and ctx.tier not in ELIZA_1_VISION_TIERS:
            out[opt] = []
        elif d.is_dir():
            files = sorted(p for p in d.iterdir() if p.is_file())
            out[opt] = files
        else:
            out[opt] = []

    # Licenses — every required blob must be present and non-empty.
    licenses_dir = bundle / "licenses"
    for name in _license_files_for_layout(out):
        p = licenses_dir / name
        if not p.is_file():
            raise OrchestratorError(
                f"bundle layout: missing license blob {name}",
                EXIT_MISSING_FILE,
            )
        if p.stat().st_size == 0:
            raise OrchestratorError(
                f"bundle layout: empty license blob {name}",
                EXIT_MISSING_FILE,
            )
    # Real upstream license text + the license-manifest.json sidecar are
    # mandatory. The orchestrator refuses to publish a bundle whose
    # licenses/ set is partial or whose embedded text is not the
    # verbatim canonical SPDX text. See eliza1_licenses.py.
    license_components = _license_components_for_layout(out, bundle)
    license_problems = verify_bundle_licenses(licenses_dir, license_components)
    if license_problems:
        raise OrchestratorError(
            "bundle layout: license attestation partial:\n  - "
            + "\n  - ".join(license_problems),
            EXIT_MISSING_FILE,
        )

    # Evals — aggregate.json must exist for stage 3.
    agg = bundle / "evals" / "aggregate.json"
    if not agg.is_file():
        raise OrchestratorError(
            "bundle layout: missing evals/aggregate.json",
            EXIT_MISSING_FILE,
        )

    out["quantization_sidecars"] = _validate_quantization_sidecars(
        bundle,
        tier=ctx.tier,
    )

    missing_platform_files = sorted(
        rel for rel in required_files_for_tier(ctx.tier) if not (bundle / rel).is_file()
    )
    if missing_platform_files:
        raise OrchestratorError(
            "bundle layout: missing platform-plan required file(s): "
            f"{missing_platform_files}",
            EXIT_MISSING_FILE,
        )

    return out


def _mtp_report_eval(ctx: PublishContext) -> Mapping[str, Any]:
    report_path = ctx.bundle_dir / "evals" / "mtp-accept.json"
    if not report_path.is_file():
        return {}
    data = json.loads(report_path.read_text())
    return data if isinstance(data, dict) else {}


def _build_upload_list(
    ctx: PublishContext, layout: Mapping[str, Sequence[Path]]
) -> list[tuple[Path, str]]:
    """Return (local_path, path_in_repo) for everything we'll upload.

    Excludes the to-be-generated manifest + README — those are written
    in-place to the bundle dir by ``run`` before push.
    """
    pairs: list[tuple[Path, str]] = []

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
        for p in layout.get(kind_src, []):
            pairs.append(
                (p, _bundle_repo_path(ctx, str(p.relative_to(ctx.bundle_dir))))
            )

    licenses_dir = ctx.bundle_dir / "licenses"
    for name in _license_files_for_layout(layout):
        p = licenses_dir / name
        pairs.append((p, _bundle_repo_path(ctx, f"licenses/{name}")))

    evals_dir = ctx.bundle_dir / "evals"
    for p in sorted(evals_dir.iterdir()):
        if p.is_file():
            pairs.append((p, _bundle_repo_path(ctx, f"evals/{p.name}")))

    existing_targets = {target for _, target in pairs}
    for p in layout.get("quantization_sidecars", []):
        target = _bundle_repo_path(ctx, str(p.relative_to(ctx.bundle_dir)))
        if target not in existing_targets:
            pairs.append((p, target))
            existing_targets.add(target)

    evidence_dir = ctx.bundle_dir / "evidence"
    for p in sorted(evidence_dir.rglob("*")):
        if p.is_file():
            target = _bundle_repo_path(ctx, str(p.relative_to(ctx.bundle_dir)))
            if target not in existing_targets:
                pairs.append((p, target))
                existing_targets.add(target)

    checksums_dir = ctx.bundle_dir / "checksums"
    for p in sorted(checksums_dir.rglob("*")):
        if p.is_file():
            target = _bundle_repo_path(ctx, str(p.relative_to(ctx.bundle_dir)))
            if target not in existing_targets:
                pairs.append((p, target))
                existing_targets.add(target)

    return pairs
