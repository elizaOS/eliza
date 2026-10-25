"""Release publishing: manifest."""

from __future__ import annotations
from eliza_training.lib.file_integrity import sha256_file as _sha256_file
import json
from pathlib import Path
from typing import Any, Mapping, Sequence
from eliza_training.release.gates import (  # noqa: E402  - sys.path mutated above
    GateReport,
)
from eliza_training.manifest.eliza1_manifest import (  # noqa: E402
    ELIZA_1_VOICE_MANIFEST_VERSION,
    REQUIRED_KERNELS_BY_TIER,
    SUPPORTED_BACKENDS_BY_TIER,
    VOICE_PRESET_CACHE_PATH,
    VOICE_QUANT_BY_TIER,
    Eliza1ManifestError,
    FileEntry,
    KernelVerification,
    LineageEntry,
    build_manifest,
    text_architecture_for_manifest,
    text_context_for_manifest,
)
from .context import (
    CHECKSUMS_PATH,
    DEFAULT_RAM_BUDGET_MB,
    DEFAULT_VOICE_CAPABILITIES,
    EXIT_EVAL_GATE_FAIL,
    EXIT_MANIFEST_INVALID,
    EXPRESSIVE_GATE_NAMES,
    OrchestratorError,
    PublishContext,
    TIER_TAGLINES,
    _bundle_repo_path,
    _bundle_repo_prefix,
    _optional_float,
)
from .evidence import _provenance_from_release_evidence
from .layout import _mtp_report_eval, _read_sidecar


def _collect_files_for_manifest(
    layout: Mapping[str, Sequence[Path]],
    bundle_root: Path,
) -> dict[str, list[FileEntry]]:
    """Hash every shipped file and return the manifest ``files`` map.

    ``ctx`` only applies to the text variants — read from the filename
    suffix `<tier>-<ctx>.gguf` if present, otherwise omitted.
    """

    def rel(p: Path) -> str:
        return str(p.relative_to(bundle_root))

    files: dict[str, list[FileEntry]] = {
        "text": [],
        "voice": [],
        "asr": [],
        "vision": [],
        "mtp": [],
        "cache": [],
        "embedding": [],
        "vad": [],
        "wakeword": [],
    }

    for kind_src, kind_dst in (
        ("text", "text"),
        ("tts", "voice"),
        ("asr", "asr"),
        ("vision", "vision"),
        ("mtp", "mtp"),
        ("cache", "cache"),
        ("embedding", "embedding"),
        ("vad", "vad"),
        ("wakeword", "wakeword"),
    ):
        for p in layout.get(kind_src, []):
            entry = FileEntry(
                path=rel(p),
                sha256=_sha256_file(p),
                ctx=text_context_for_manifest(p) if kind_src == "text" else None,
                architecture=(
                    text_architecture_for_manifest(p) if kind_src == "text" else None
                ),
            )
            files[kind_dst].append(entry)

    return files


def _build_lineage(
    tier: str,
    sidecar: Mapping[str, Any] | None,
    files: Mapping[str, Sequence[FileEntry]],
) -> dict[str, LineageEntry]:
    """Read lineage from ``bundle/lineage.json`` if present, else defaults.

    The defaults are deliberately minimal. A real publish should ship a
    hand-written ``lineage.json`` with exact upstream commits.
    """
    defaults: dict[str, LineageEntry] = {
        "text": LineageEntry(base="eliza-1-family", license="apache-2.0"),
        "voice": LineageEntry(
            base=f"omnivoice-gguf-{VOICE_QUANT_BY_TIER[tier]}",
            license="apache-2.0",
        ),
        "drafter": LineageEntry(base=f"mtp-{tier}-drafter", license="apache-2.0"),
    }
    out = dict(defaults)

    optional_defaults: dict[str, LineageEntry] = {
        "asr": LineageEntry(base="eliza-1-asr-family", license="apache-2.0"),
        "vision": LineageEntry(base="eliza-1-vision-family", license="apache-2.0"),
        "embedding": LineageEntry(
            base="eliza-1-embedding-family", license="apache-2.0"
        ),
        "vad": LineageEntry(base="eliza-1-vad-family", license="apache-2.0"),
        "wakeword": LineageEntry(base="eliza-1-wakeword-family", license="apache-2.0"),
    }
    for slot, default in optional_defaults.items():
        if files.get(slot):
            out[slot] = default

    if not sidecar:
        return out

    for slot in (
        "text",
        "voice",
        "drafter",
        "asr",
        "vision",
        "embedding",
        "vad",
        "wakeword",
    ):
        spec = sidecar.get(slot)
        if isinstance(spec, dict):
            default = out.get(slot)
            out[slot] = LineageEntry(
                base=str(spec.get("base", default.base if default else "")),
                license=str(spec.get("license", default.license if default else "")),
            )
    return out


def _required_kernels_for(
    tier: str, layout: Mapping[str, Sequence[Path]]
) -> tuple[list[str], list[str]]:
    """Compute the ``kernels.required`` and ``kernels.optional`` lists.

    Required kernels come from REQUIRED_KERNELS_BY_TIER. ``turbo3_tcq``
    is promoted to required whenever any text variant has ctx > 64k.
    """
    req = list(REQUIRED_KERNELS_BY_TIER[tier])
    opt: list[str] = []
    for p in layout.get("text", []):
        ctx = text_context_for_manifest(p)
        if ctx is not None and ctx > 65536:
            if "turbo3_tcq" not in req:
                req.append("turbo3_tcq")
    return req, opt


def _published_at_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _kernel_manifest_fragments_from_layout(
    layout: Mapping[str, Sequence[Path]],
) -> list[dict[str, Any]]:
    """Pull the ``kernel_manifest`` fragments out of the quantization sidecars.

    The sidecars were already shape-validated by
    ``_validate_quantization_sidecars`` (which is what populates
    ``layout["quantization_sidecars"]``); here we just read each one's
    ``kernel_manifest`` object so ``build_manifest`` can fold the recipe
    layout pins into ``kernels.recipeManifest``.
    """
    fragments: list[dict[str, Any]] = []
    for sidecar in layout.get("quantization_sidecars", []):
        data = _read_sidecar(sidecar)
        kernel_manifest = data.get("kernel_manifest")
        if isinstance(kernel_manifest, dict):
            fragments.append(kernel_manifest)
    return fragments


def assemble_manifest(
    ctx: PublishContext,
    *,
    layout: Mapping[str, Sequence[Path]],
    backends: Mapping[str, KernelVerification],
    gate_report: GateReport,
    eval_blob: Mapping[str, Any],
    version: str,
    release_evidence: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the manifest dict via the manifest module's typed builder.

    ``defaultEligible`` is set True when every required gate passed AND
    every supported backend reported pass. The manifest module's
    validator independently enforces the same rule and will reject a
    misuse of this flag.
    """

    files_map = _collect_files_for_manifest(layout, ctx.bundle_dir)

    # Optional sidecars.
    lineage_path = ctx.bundle_dir / "lineage.json"
    lineage_sidecar: dict[str, Any] | None = None
    if lineage_path.is_file():
        lineage_sidecar = json.loads(lineage_path.read_text())
    lineage = _build_lineage(ctx.tier, lineage_sidecar, files_map)

    ram_path = ctx.bundle_dir / "ram_budget.json"
    if ram_path.is_file():
        ram_blob = json.loads(ram_path.read_text())
        ram_min = int(ram_blob["min"])
        ram_rec = int(ram_blob["recommended"])
    else:
        ram_min, ram_rec = DEFAULT_RAM_BUDGET_MB[ctx.tier]

    results = eval_blob["results"]
    text_eval_score = float(results["text_eval"])
    voice_rtf = float(results["voice_rtf"])
    has_asr = bool(files_map.get("asr"))
    asr_wer = float(results["asr_wer"]) if has_asr else None
    has_vad = bool(files_map.get("vad"))
    vad_latency_ms = float(results["vad_latency_ms"]) if has_vad else None
    expressive_tag_faithfulness = float(results["expressive_tag_faithfulness"])
    expressive_mos = float(results["expressive_mos"])
    expressive_tag_leakage = float(results["expressive_tag_leakage"])

    # All evals' ``passed`` flags come from the gate report — it's the
    # only source of truth and matches the manifest validator's rules.
    text_eval_passed = _gate_passed(gate_report, "text_eval")
    voice_rtf_passed = _gate_passed(gate_report, "voice_rtf")
    expressive_passed = all(
        _gate_passed(gate_report, gate_name) for gate_name in EXPRESSIVE_GATE_NAMES
    )
    # ``e2e_loop_ok`` and ``thirty_turn_ok`` are independent boolean
    # contract gates per AGENTS.md §6 (manifest fields ``evals.e2eLoopOk``
    # and ``evals.thirtyTurnOk``). Read each from the eval blob directly
    # so the manifest reflects what was actually measured. The previous
    # alias (e2e_loop_ok ← thirty_turn_ok gate result) hid the fact that
    # one of the two gates had no measurement.
    thirty_turn_ok = _read_independent_bool(results, "thirty_turn_ok")
    e2e_loop_ok = _read_independent_bool(results, "e2e_loop_ok")
    mtp_report = _mtp_report_eval(ctx)
    mtp_acceptance_rate = _optional_float(results.get("mtp_acceptance"))
    if mtp_acceptance_rate is None:
        mtp_acceptance_rate = _optional_float(mtp_report.get("acceptanceRate"))
    mtp_speedup = _optional_float(results.get("mtp_speedup"))
    if mtp_speedup is None:
        mtp_speedup = _optional_float(mtp_report.get("speedup"))
    mtp_passed = bool(
        mtp_acceptance_rate is not None
        and mtp_speedup is not None
        and _gate_passed(gate_report, "mtp_acceptance")
        and _gate_passed(gate_report, "mtp_speedup")
    )

    required_kernels, optional_kernels = _required_kernels_for(ctx.tier, layout)

    supported = set(SUPPORTED_BACKENDS_BY_TIER[ctx.tier])
    all_backends_pass = all(backends[b].status == "pass" for b in supported)
    default_eligible = bool(
        gate_report.passed
        and all_backends_pass
        and text_eval_passed
        and voice_rtf_passed
        and (_gate_passed(gate_report, "asr_wer") if has_asr else False)
        and (_gate_passed(gate_report, "vad_latency_ms") if has_vad else False)
        and expressive_passed
        and e2e_loop_ok
        and thirty_turn_ok
        and mtp_passed
    )

    try:
        return build_manifest(
            tier=ctx.tier,
            version=version,
            published_at=_published_at_now(),
            lineage=lineage,
            files=files_map,
            kernels_required=required_kernels,
            kernels_optional=optional_kernels,
            verified_backends=backends,
            text_eval_score=text_eval_score,
            text_eval_passed=text_eval_passed,
            voice_rtf=voice_rtf,
            voice_rtf_passed=voice_rtf_passed,
            e2e_loop_ok=e2e_loop_ok,
            thirty_turn_ok=thirty_turn_ok,
            ram_budget_min_mb=ram_min,
            ram_budget_recommended_mb=ram_rec,
            default_eligible=default_eligible,
            asr_wer=asr_wer,
            asr_wer_passed=_gate_passed(gate_report, "asr_wer") if has_asr else None,
            vad_latency_ms_median=vad_latency_ms,
            vad_latency_ms_passed=(
                _gate_passed(gate_report, "vad_latency_ms") if has_vad else None
            ),
            expressive_tag_faithfulness=expressive_tag_faithfulness,
            expressive_mos=expressive_mos,
            expressive_tag_leakage=expressive_tag_leakage,
            expressive_passed=expressive_passed,
            mtp_eval=bool(files_map.get("mtp")),
            mtp_acceptance_rate=mtp_acceptance_rate,
            mtp_speedup=mtp_speedup,
            mtp_passed=mtp_passed,
            voice_capabilities=DEFAULT_VOICE_CAPABILITIES,
            voice_version=ELIZA_1_VOICE_MANIFEST_VERSION,
            voice_frozen=True,
            voice_cache_speaker_preset=VOICE_PRESET_CACHE_PATH,
            voice_cache_phrase_seed=VOICE_PRESET_CACHE_PATH,
            kernel_manifest_fragments=_kernel_manifest_fragments_from_layout(layout),
            provenance=(
                _provenance_from_release_evidence(release_evidence)
                if release_evidence is not None
                else None
            ),
        )
    except Eliza1ManifestError as exc:
        raise OrchestratorError(
            f"manifest validator rejected the manifest:\n{exc}",
            EXIT_MANIFEST_INVALID,
        )


def _gate_passed(report: GateReport, name: str) -> bool:
    for g in report.gates:
        if g.name == name:
            return g.passed
    # Gate not configured for this tier → treat as pass.
    return True


def _read_independent_bool(
    results: Mapping[str, Any],
    key: str,
) -> bool:
    """Read an independent contract boolean from the eval results blob.

    Missing keys raise ``OrchestratorError`` so the publish surfaces
    the contract gap instead of emitting a manifest with one gate
    inferred from a different measurement.
    """
    if key in results:
        value = results[key]
        if not isinstance(value, bool):
            raise OrchestratorError(
                f"evals/aggregate.json results.{key!r} must be a bool, "
                f"got {type(value).__name__}",
                EXIT_EVAL_GATE_FAIL,
            )
        return value

    raise OrchestratorError(
        f"evals/aggregate.json missing required boolean results.{key!r}",
        EXIT_EVAL_GATE_FAIL,
    )


def render_readme(ctx: PublishContext, manifest: Mapping[str, Any]) -> str:
    """Render the bundle README from the manifest.

    The template lives at ``publish/templates/README.md.j2`` so all
    user-visible copy stays in one auditable place.
    """

    try:
        from jinja2 import Environment, FileSystemLoader, select_autoescape
    except ImportError as exc:  # pragma: no cover - import-time
        raise OrchestratorError(
            "jinja2 is required to render the README; "
            "install it via `uv run --with jinja2 ...`",
            EXIT_MANIFEST_INVALID,
        ) from exc

    template_dir = ctx.template_path.parent
    env = Environment(
        loader=FileSystemLoader(str(template_dir)),
        autoescape=select_autoescape(disabled_extensions=("j2",)),
        keep_trailing_newline=True,
    )
    template = env.get_template(ctx.template_path.name)

    lineage_slots = [
        {"name": slot, "base": entry["base"], "license": entry["license"]}
        for slot, entry in manifest["lineage"].items()
    ]

    provenance = manifest.get("provenance")
    release_channel = "recommended"
    provenance_rows: list[dict[str, str | None]] = []
    if isinstance(provenance, Mapping):
        release_state = provenance.get("releaseState")
        if isinstance(release_state, str) and release_state:
            release_channel = release_state
        source_models = provenance.get("sourceModels")
        if isinstance(source_models, Mapping):
            for slot, source in sorted(source_models.items()):
                if not isinstance(source, Mapping):
                    continue
                repo = source.get("repo")
                if not isinstance(repo, str) or not repo:
                    continue
                file_value = source.get("file")
                provenance_rows.append(
                    {
                        "slot": str(slot),
                        "repo": repo,
                        "file": file_value if isinstance(file_value, str) else None,
                    }
                )

    kernel_rows = [
        {
            "backend": b,
            "status": v["status"],
            "at_commit": v["atCommit"],
            "report": v["report"],
        }
        for b, v in manifest["kernels"]["verifiedBackends"].items()
    ]

    file_groups = [
        (kind, manifest["files"][kind])
        for kind in (
            "text",
            "voice",
            "asr",
            "vad",
            "vision",
            "embedding",
            "mtp",
            "cache",
            "wakeword",
        )
        if manifest["files"].get(kind)
    ]
    voice = manifest.get("voice") or {}
    voice_cache = voice.get("cache") if isinstance(voice.get("cache"), dict) else {}
    remote_prefix = _bundle_repo_prefix(ctx)
    manifest_remote_path = _bundle_repo_path(ctx, "eliza-1.manifest.json")
    checksum_remote_path = _bundle_repo_path(ctx, str(CHECKSUMS_PATH))
    hf_cli_download_command = (
        f"hf download {ctx.repo_id} --include '{remote_prefix}/**' "
        f"--local-dir eliza-1-{ctx.tier}.bundle"
    )

    return template.render(
        manifest=manifest,
        tier=ctx.tier,
        tier_display=ctx.tier,
        tagline=TIER_TAGLINES[ctx.tier],
        repo_id=ctx.repo_id,
        remote_prefix=remote_prefix,
        manifest_remote_path=manifest_remote_path,
        checksum_remote_path=checksum_remote_path,
        direct_manifest_url=(
            f"https://huggingface.co/{ctx.repo_id}/resolve/main/"
            f"{manifest_remote_path}?download=true"
        ),
        direct_checksum_url=(
            f"https://huggingface.co/{ctx.repo_id}/resolve/main/"
            f"{checksum_remote_path}?download=true"
        ),
        hf_cli_download_command=hf_cli_download_command,
        release_channel=release_channel,
        is_base_v1=release_channel == "base-v1",
        provenance_rows=provenance_rows,
        default_eligible_str="true" if manifest["defaultEligible"] else "false",
        lineage_slots=lineage_slots,
        kernel_rows=kernel_rows,
        kernels_required_str=", ".join(manifest["kernels"]["required"]),
        kernels_optional_str=", ".join(manifest["kernels"]["optional"]) or "(none)",
        file_groups=file_groups,
        voice_capabilities_str=", ".join(voice.get("capabilities", [])),
        voice_cache=voice_cache,
    )
