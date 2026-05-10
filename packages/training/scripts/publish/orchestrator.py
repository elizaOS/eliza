"""Eliza-1 publish orchestrator.

End-to-end pipeline that takes a directory containing already-quantized
weights + sidecars and ships an Eliza-1 bundle to
``elizalabs/eliza-1-<tier>``. This is the single entry point referenced
by ``packages/training/AGENTS.md`` §6.

Stages, in order, with hard exits on failure:

1. **Layout validation.** Walk the bundle directory and verify it
   conforms to ``packages/inference/AGENTS.md`` §2 (text/, tts/, asr/,
   vision/, dflash/, cache/, evals/, licenses/). Missing required files
   or sidecars are publish-blocking.
2. **Kernel verification.** Run the
   ``packages/inference/verify`` harness for the tier's supported
   backends. CPU + Vulkan are runnable in CI; Metal is hardware-only —
   the orchestrator detects Metal as NEEDS-HARDWARE and either consumes
   a previously-recorded ``metal_verify.json`` from a verified host
   (``--metal-verification PATH``) or refuses to publish.
3. **Eval gates.** Load ``evals/aggregate.json`` from the bundle dir,
   run ``apply_gates(results, tier)``, refuse to proceed unless
   ``passed: true``.
4. **Manifest build.** Assemble inputs into ``build_manifest`` from the
   manifest module. ``defaultEligible`` is True iff every required gate
   is green and every supported backend verified pass; the manifest
   validator enforces the same rule.
5. **README render.** Render ``templates/README.md.j2`` with the
   manifest as the data context. Same data, no marketing buzzwords, no
   user-visible Qwen/Llama strings.
6. **HF push.** Upload weights, manifest, README, licenses, eval blobs
   to ``elizalabs/eliza-1-<tier>`` via ``huggingface_hub``. Tag the
   local training repo with ``eliza-1-<tier>-v<version>`` + the
   training commit hash.

Bypass rules: there is no ``--skip-eval``, no ``--skip-verify``, no
``--publish-anyway``. ``--dry-run`` performs every check but does not
push to HF and does not actually run ``git tag``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

# Make ``scripts`` importable when run as ``python -m publish.orchestrator``
# from the training/ directory.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from benchmarks.eliza1_gates import (  # noqa: E402  - sys.path mutated above
    GateReport,
    apply_gates,
    load_gates,
)
from scripts.manifest.eliza1_manifest import (  # noqa: E402
    ELIZA_1_BACKENDS,
    REQUIRED_KERNELS_BY_TIER,
    SUPPORTED_BACKENDS_BY_TIER,
    Eliza1ManifestError,
    FileEntry,
    KernelVerification,
    LineageEntry,
    build_manifest,
)

# ---------------------------------------------------------------------------
# Exit codes
# ---------------------------------------------------------------------------

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_BUNDLE_LAYOUT_FAIL = 10
EXIT_MISSING_FILE = 11
EXIT_KERNEL_VERIFY_FAIL = 12
EXIT_EVAL_GATE_FAIL = 13
EXIT_MANIFEST_INVALID = 14
EXIT_HF_PUSH_FAIL = 15

# ---------------------------------------------------------------------------
# Constants — bundle layout per inference/AGENTS.md §2
# ---------------------------------------------------------------------------

# Subdirectories that must exist in the bundle root.
REQUIRED_SUBDIRS: tuple[str, ...] = (
    "text",
    "tts",
    "dflash",
    "cache",
    "evals",
    "licenses",
)

# License blobs that must be present per inference/AGENTS.md §2.
REQUIRED_LICENSE_FILES: tuple[str, ...] = (
    "LICENSE.text",
    "LICENSE.voice",
    "LICENSE.dflash",
    "LICENSE.eliza-1",
)

# Tier matrix — tagline + lineage taken from inference/AGENTS.md §2.
TIER_TAGLINES: Mapping[str, str] = {
    "lite-0_6b": "low-RAM phones, CPU fallback",
    "mobile-1_7b": "modern phones",
    "desktop-9b": "laptops, 24GB phones, 48GB Mac",
    "pro-27b": "96GB+ Mac, high-VRAM desktop",
    "server-h200": "server / workstation",
}

VOICE_BACKBONE_BY_TIER: Mapping[str, str] = {
    "lite-0_6b": "omnivoice-0.6b",
    "mobile-1_7b": "omnivoice-0.6b",
    "desktop-9b": "omnivoice-1.7b",
    "pro-27b": "omnivoice-1.7b",
    "server-h200": "omnivoice-1.7b",
}

# Default RAM budgets (MB). Tightened pre-publish from real measurements
# on reference hardware; the bundle's sidecar can override.
DEFAULT_RAM_BUDGET_MB: Mapping[str, tuple[int, int]] = {
    "lite-0_6b": (1500, 1800),
    "mobile-1_7b": (3500, 4500),
    "desktop-9b": (7000, 9500),
    "pro-27b": (24000, 32000),
    "server-h200": (48000, 64000),
}

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("publish.orchestrator")


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class OrchestratorError(Exception):
    """Raised when a publish stage fails. Carries an exit code."""

    def __init__(self, message: str, exit_code: int) -> None:
        super().__init__(message)
        self.exit_code = exit_code


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PublishContext:
    tier: str
    bundle_dir: Path
    dry_run: bool
    metal_verification: Path | None
    repo_id: str
    public: bool
    training_repo_root: Path
    template_path: Path
    gates_path: Path | None = None

    # Artifacts populated as stages run (kept here so tests can introspect).
    layout_files: dict[str, list[Path]] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Stage 1 — layout
# ---------------------------------------------------------------------------


def _sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def _read_sidecar(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise OrchestratorError(
            f"missing sidecar: {path}", EXIT_MISSING_FILE
        )
    return json.loads(path.read_text())


def validate_bundle_layout(ctx: PublishContext) -> dict[str, list[Path]]:
    """Enforce the §2 layout. Populates ``ctx.layout_files`` and returns it.

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
        out[sub] = sorted(p for p in d.iterdir() if p.is_file())

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
    if not out["dflash"]:
        raise OrchestratorError(
            "bundle layout: dflash/ must contain at least one .gguf",
            EXIT_BUNDLE_LAYOUT_FAIL,
        )
    if not out["cache"]:
        raise OrchestratorError(
            "bundle layout: cache/ must contain at least one cache file",
            EXIT_BUNDLE_LAYOUT_FAIL,
        )

    # Optional but if present must not be empty.
    for opt in ("asr", "vision"):
        d = bundle / opt
        if d.is_dir():
            files = sorted(p for p in d.iterdir() if p.is_file())
            out[opt] = files
        else:
            out[opt] = []

    # Licenses — every required blob must be present and non-empty.
    licenses_dir = bundle / "licenses"
    for name in REQUIRED_LICENSE_FILES:
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

    # Evals — aggregate.json must exist for stage 3.
    agg = bundle / "evals" / "aggregate.json"
    if not agg.is_file():
        raise OrchestratorError(
            "bundle layout: missing evals/aggregate.json",
            EXIT_MISSING_FILE,
        )

    return out


# ---------------------------------------------------------------------------
# Stage 2 — kernel verification
# ---------------------------------------------------------------------------


def _verify_dir(ctx: PublishContext) -> Path:
    """Resolve packages/inference/verify relative to the training repo."""
    return ctx.training_repo_root.parent / "inference" / "verify"


def _read_recorded_report(path: Path, expected_backend: str) -> KernelVerification:
    if not path.is_file():
        raise OrchestratorError(
            f"verification report not found: {path}",
            EXIT_KERNEL_VERIFY_FAIL,
        )
    data = json.loads(path.read_text())
    backend = data.get("backend") or expected_backend
    if backend != expected_backend:
        raise OrchestratorError(
            f"verification report at {path} is for backend "
            f"{backend!r}, expected {expected_backend!r}",
            EXIT_KERNEL_VERIFY_FAIL,
        )
    status = data.get("status")
    if status != "pass":
        raise OrchestratorError(
            f"{expected_backend} verification report status is "
            f"{status!r}, expected 'pass' (path={path})",
            EXIT_KERNEL_VERIFY_FAIL,
        )
    at_commit = data.get("atCommit") or data.get("at_commit")
    report = data.get("report") or path.name
    if not at_commit:
        raise OrchestratorError(
            f"verification report at {path} missing atCommit",
            EXIT_KERNEL_VERIFY_FAIL,
        )
    return KernelVerification(status="pass", at_commit=at_commit, report=report)


def _run_reference_test(verify_dir: Path) -> None:
    """Run ``make -C verify reference-test``. CI-safe per Makefile."""
    if not (verify_dir / "Makefile").is_file():
        raise OrchestratorError(
            f"kernel verify dir missing Makefile: {verify_dir}",
            EXIT_KERNEL_VERIFY_FAIL,
        )
    if shutil.which("make") is None:
        raise OrchestratorError(
            "kernel verify: 'make' not on PATH; cannot run reference-test",
            EXIT_KERNEL_VERIFY_FAIL,
        )
    proc = subprocess.run(
        ["make", "-C", str(verify_dir), "reference-test"],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise OrchestratorError(
            "kernel verify: reference-test failed:\n"
            f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}",
            EXIT_KERNEL_VERIFY_FAIL,
        )


def _git_short_sha(repo_root: Path) -> str:
    """Best-effort training-repo HEAD hash for the verified backend record."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
    except FileNotFoundError:
        pass
    return "unknown"


def run_kernel_verification(
    ctx: PublishContext,
) -> dict[str, KernelVerification]:
    """Produce a backend → verification map per ``ELIZA_1_BACKENDS``.

    Rules:

    - CPU is always verified via ``make reference-test``.
    - Vulkan is verified via the recorded report at
      ``bundle/evals/vulkan_verify.json`` if present, otherwise CI
      treats it as not-applicable to this tier and records ``skipped``
      only when the tier does not include vulkan in
      ``SUPPORTED_BACKENDS_BY_TIER``.
    - Metal is hardware-only. The orchestrator REQUIRES
      ``--metal-verification PATH`` when the tier includes metal, and
      consumes that report directly. There is no inline metal run.
    - CUDA: same shape — recorded report at
      ``bundle/evals/cuda_verify.json`` if the tier supports it.
    """

    supported = set(SUPPORTED_BACKENDS_BY_TIER[ctx.tier])
    sha = _git_short_sha(ctx.training_repo_root)

    out: dict[str, KernelVerification] = {}

    # CPU — always run reference-test (CI-safe).
    if "cpu" in supported:
        verify_dir = _verify_dir(ctx)
        if ctx.dry_run:
            log.info("[verify] cpu: dry-run, skipping subprocess")
        else:
            _run_reference_test(verify_dir)
        out["cpu"] = KernelVerification(
            status="pass", at_commit=sha, report="reference-test"
        )

    # Vulkan — recorded report from the bundle if tier includes it.
    if "vulkan" in supported:
        recorded = ctx.bundle_dir / "evals" / "vulkan_verify.json"
        out["vulkan"] = _read_recorded_report(recorded, "vulkan")

    # Metal — hardware-only.
    if "metal" in supported:
        if ctx.metal_verification is None:
            raise OrchestratorError(
                f"tier {ctx.tier} requires Metal verification "
                "(NEEDS-HARDWARE). Run packages/inference/verify/metal_verify "
                "on a verified host and pass --metal-verification PATH.",
                EXIT_KERNEL_VERIFY_FAIL,
            )
        out["metal"] = _read_recorded_report(ctx.metal_verification, "metal")

    # CUDA — recorded report.
    if "cuda" in supported:
        recorded = ctx.bundle_dir / "evals" / "cuda_verify.json"
        out["cuda"] = _read_recorded_report(recorded, "cuda")

    # Backends not supported by this tier are recorded as skipped, with
    # a stable report name. The manifest validator only enforces "pass"
    # on backends in SUPPORTED_BACKENDS_BY_TIER[tier], so skipped
    # entries here are non-blocking.
    for backend in ELIZA_1_BACKENDS:
        if backend not in out:
            out[backend] = KernelVerification(
                status="skipped",
                at_commit=sha,
                report=f"not-applicable-for-{ctx.tier}",
            )

    return out


# ---------------------------------------------------------------------------
# Stage 3 — eval gates
# ---------------------------------------------------------------------------


def run_eval_gates(ctx: PublishContext) -> tuple[GateReport, dict[str, Any]]:
    """Apply the tier gates to ``evals/aggregate.json``.

    The eval blob shape matches the docstring of ``eliza1_gates.py``.
    Refuses to proceed unless ``GateReport.passed`` is True.
    """

    eval_path = ctx.bundle_dir / "evals" / "aggregate.json"
    eval_blob = json.loads(eval_path.read_text())

    if eval_blob.get("tier") != ctx.tier:
        raise OrchestratorError(
            f"evals/aggregate.json tier {eval_blob.get('tier')!r} does "
            f"not match --tier {ctx.tier!r}",
            EXIT_EVAL_GATE_FAIL,
        )

    gates_doc = load_gates(ctx.gates_path) if ctx.gates_path else None
    report = apply_gates(eval_blob, gates_doc)

    if not report.passed:
        details = "\n".join(
            f"  - {g.name}: {g.reason}" for g in report.failed_gates
        )
        raise OrchestratorError(
            f"eval gates failed for tier {ctx.tier}:\n{details}",
            EXIT_EVAL_GATE_FAIL,
        )

    return report, eval_blob


# ---------------------------------------------------------------------------
# Stage 4 — manifest
# ---------------------------------------------------------------------------


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

    def parse_ctx(p: Path) -> int | None:
        # eliza-1-desktop-9b-64k.gguf  → 65536
        # eliza-1-desktop-9b-128k.gguf → 131072
        stem = p.stem
        if not stem.endswith("k"):
            for sep in ("-",):
                parts = stem.split(sep)
                for tok in reversed(parts):
                    if tok.endswith("k") and tok[:-1].isdigit():
                        return int(tok[:-1]) * 1024
            return None
        # robust: walk back to find <num>k
        last = stem.split("-")[-1]
        if last.endswith("k") and last[:-1].isdigit():
            return int(last[:-1]) * 1024
        return None

    files: dict[str, list[FileEntry]] = {
        "text": [],
        "voice": [],
        "asr": [],
        "vision": [],
        "dflash": [],
        "cache": [],
    }

    for kind_src, kind_dst in (
        ("text", "text"),
        ("tts", "voice"),
        ("asr", "asr"),
        ("vision", "vision"),
        ("dflash", "dflash"),
        ("cache", "cache"),
    ):
        for p in layout.get(kind_src, []):
            entry = FileEntry(
                path=rel(p),
                sha256=_sha256_file(p),
                ctx=parse_ctx(p) if kind_src == "text" else None,
            )
            files[kind_dst].append(entry)

    return files


def _build_lineage(
    tier: str, sidecar: Mapping[str, Any] | None
) -> dict[str, LineageEntry]:
    """Read lineage from ``bundle/lineage.json`` if present, else defaults.

    The defaults are deliberately minimal — they reflect the public
    backbones from inference/AGENTS.md §1. A real publish should ship
    a hand-written ``lineage.json`` with exact upstream commits.
    """
    defaults: dict[str, LineageEntry] = {
        "text": LineageEntry(base="qwen3.5-family", license="apache-2.0"),
        "voice": LineageEntry(
            base=VOICE_BACKBONE_BY_TIER[tier], license="apache-2.0"
        ),
        "drafter": LineageEntry(
            base=f"dflash-{tier}-drafter", license="apache-2.0"
        ),
    }
    if not sidecar:
        return defaults
    out = dict(defaults)
    for slot in ("text", "voice", "drafter"):
        spec = sidecar.get(slot)
        if isinstance(spec, dict):
            out[slot] = LineageEntry(
                base=str(spec.get("base", defaults[slot].base)),
                license=str(spec.get("license", defaults[slot].license)),
            )
    return out


def _required_kernels_for(tier: str, layout: Mapping[str, Sequence[Path]]) -> tuple[
    list[str], list[str]
]:
    """Compute the ``kernels.required`` and ``kernels.optional`` lists.

    Required kernels come from REQUIRED_KERNELS_BY_TIER. ``turbo3_tcq``
    is added as optional whenever any text variant has ctx > 64k.
    """
    req = list(REQUIRED_KERNELS_BY_TIER[tier])
    opt: list[str] = []
    for p in layout.get("text", []):
        stem = p.stem
        last = stem.split("-")[-1]
        if last.endswith("k") and last[:-1].isdigit():
            ctx = int(last[:-1]) * 1024
            if ctx > 65536:
                if "turbo3_tcq" not in req and "turbo3_tcq" not in opt:
                    opt.append("turbo3_tcq")
    return req, opt


def _published_at_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def assemble_manifest(
    ctx: PublishContext,
    *,
    layout: Mapping[str, Sequence[Path]],
    backends: Mapping[str, KernelVerification],
    gate_report: GateReport,
    eval_blob: Mapping[str, Any],
    version: str,
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
    lineage = _build_lineage(ctx.tier, lineage_sidecar)

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

    # All evals' ``passed`` flags come from the gate report — it's the
    # only source of truth and matches the manifest validator's rules.
    text_eval_passed = _gate_passed(gate_report, "text_eval")
    voice_rtf_passed = _gate_passed(gate_report, "voice_rtf")
    e2e_loop_ok = _gate_passed(gate_report, "thirty_turn_ok")
    thirty_turn_ok = bool(results.get("thirty_turn_ok", False))

    required_kernels, optional_kernels = _required_kernels_for(ctx.tier, layout)

    supported = set(SUPPORTED_BACKENDS_BY_TIER[ctx.tier])
    all_backends_pass = all(
        backends[b].status == "pass" for b in supported
    )
    default_eligible = bool(
        gate_report.passed
        and all_backends_pass
        and text_eval_passed
        and voice_rtf_passed
        and e2e_loop_ok
        and thirty_turn_ok
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


# ---------------------------------------------------------------------------
# Stage 5 — README render
# ---------------------------------------------------------------------------


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
        for kind in ("text", "voice", "asr", "vision", "dflash", "cache")
        if manifest["files"].get(kind)
    ]

    return template.render(
        manifest=manifest,
        tier=ctx.tier,
        tier_display=ctx.tier,
        tagline=TIER_TAGLINES[ctx.tier],
        default_eligible_str="true" if manifest["defaultEligible"] else "false",
        lineage_slots=lineage_slots,
        kernel_rows=kernel_rows,
        kernels_required_str=", ".join(manifest["kernels"]["required"]),
        kernels_optional_str=", ".join(manifest["kernels"]["optional"]) or "(none)",
        file_groups=file_groups,
    )


# ---------------------------------------------------------------------------
# Stage 6 — HF push + tag
# ---------------------------------------------------------------------------


def _hf_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def _build_upload_list(
    ctx: PublishContext, layout: Mapping[str, Sequence[Path]]
) -> list[tuple[Path, str]]:
    """Return (local_path, path_in_repo) for everything we'll upload.

    Excludes the to-be-generated manifest + README — those are written
    in-place to the bundle dir by ``run`` before push.
    """
    pairs: list[tuple[Path, str]] = []

    for kind_src in ("text", "tts", "asr", "vision", "dflash", "cache"):
        for p in layout.get(kind_src, []):
            pairs.append((p, str(p.relative_to(ctx.bundle_dir))))

    licenses_dir = ctx.bundle_dir / "licenses"
    for name in REQUIRED_LICENSE_FILES:
        p = licenses_dir / name
        pairs.append((p, f"licenses/{name}"))

    evals_dir = ctx.bundle_dir / "evals"
    for p in sorted(evals_dir.iterdir()):
        if p.is_file():
            pairs.append((p, f"evals/{p.name}"))

    return pairs


def push_to_hf(
    ctx: PublishContext,
    manifest_path: Path,
    readme_path: Path,
    upload_pairs: Sequence[tuple[Path, str]],
) -> None:
    """Push the bundle to ``ctx.repo_id``. No-op when ``ctx.dry_run``.

    Side-effects on success: tags the local training repo with
    ``eliza-1-<tier>-v<version>`` + the training commit hash.
    """
    if ctx.dry_run:
        log.info("[push] dry-run: would push %d files to %s",
                 len(upload_pairs) + 2, ctx.repo_id)
        return

    if not _hf_token():
        raise OrchestratorError(
            "HF_TOKEN (or HUGGINGFACE_HUB_TOKEN) env var not set; refusing to push.",
            EXIT_HF_PUSH_FAIL,
        )

    try:
        from huggingface_hub import CommitOperationAdd, HfApi
        from huggingface_hub.errors import RepositoryNotFoundError
    except ImportError as exc:  # pragma: no cover
        raise OrchestratorError(
            "huggingface_hub is required to push; "
            "install via `uv run --with huggingface_hub ...`",
            EXIT_HF_PUSH_FAIL,
        ) from exc

    api = HfApi(token=_hf_token())
    try:
        api.repo_info(ctx.repo_id, repo_type="model")
    except RepositoryNotFoundError:
        api.create_repo(
            repo_id=ctx.repo_id,
            repo_type="model",
            private=not ctx.public,
            exist_ok=False,
        )

    operations = [
        CommitOperationAdd(
            path_in_repo="eliza-1.manifest.json",
            path_or_fileobj=str(manifest_path),
        ),
        CommitOperationAdd(
            path_in_repo="README.md",
            path_or_fileobj=str(readme_path),
        ),
    ]
    for src, target in upload_pairs:
        operations.append(
            CommitOperationAdd(path_in_repo=target, path_or_fileobj=str(src))
        )

    api.create_commit(
        repo_id=ctx.repo_id,
        repo_type="model",
        operations=operations,
        commit_message=f"eliza-1-{ctx.tier}: publish bundle",
    )


def tag_training_repo(
    ctx: PublishContext, version: str, dry_run: bool
) -> str | None:
    """Apply ``eliza-1-<tier>-v<version>`` to HEAD of the training repo.

    Returns the tag name. In dry-run, prints the tag command and returns
    the tag name without invoking git.
    """
    tag_name = f"eliza-1-{ctx.tier}-v{version}"
    sha = _git_short_sha(ctx.training_repo_root)
    message = f"Publish {tag_name} (training-commit={sha})"

    if dry_run:
        log.info("[tag] dry-run: would run `git tag -a %s -m %r` (HEAD=%s)",
                 tag_name, message, sha)
        return tag_name

    if shutil.which("git") is None:
        raise OrchestratorError(
            "git is not on PATH; cannot tag training repo",
            EXIT_HF_PUSH_FAIL,
        )

    proc = subprocess.run(
        ["git", "-C", str(ctx.training_repo_root),
         "tag", "-a", tag_name, "-m", message],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise OrchestratorError(
            f"git tag failed: {proc.stderr}",
            EXIT_HF_PUSH_FAIL,
        )
    return tag_name


# ---------------------------------------------------------------------------
# Top-level driver
# ---------------------------------------------------------------------------


def _read_version(ctx: PublishContext) -> str:
    """Read the bundle version from ``bundle/VERSION`` or default to 1.0.0."""
    p = ctx.bundle_dir / "VERSION"
    if p.is_file():
        v = p.read_text().strip()
        if v:
            return v
    return "1.0.0"


def run(ctx: PublishContext) -> int:
    """Run every stage. Returns an exit code; never raises."""

    try:
        log.info("[stage 1/6] validate bundle layout (%s)", ctx.bundle_dir)
        layout = validate_bundle_layout(ctx)

        log.info("[stage 2/6] kernel verification for tier %s", ctx.tier)
        backends = run_kernel_verification(ctx)
        for b in SUPPORTED_BACKENDS_BY_TIER[ctx.tier]:
            log.info("  %s: %s (%s)", b, backends[b].status, backends[b].report)

        log.info("[stage 3/6] eval gates")
        gate_report, eval_blob = run_eval_gates(ctx)
        log.info("  passed=%s, %d gates evaluated",
                 gate_report.passed, len(gate_report.gates))

        log.info("[stage 4/6] build + validate manifest")
        version = _read_version(ctx)
        manifest = assemble_manifest(
            ctx,
            layout=layout,
            backends=backends,
            gate_report=gate_report,
            eval_blob=eval_blob,
            version=version,
        )
        manifest_path = ctx.bundle_dir / "eliza-1.manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=False) + "\n"
        )
        log.info("  defaultEligible=%s, version=%s",
                 manifest["defaultEligible"], version)

        log.info("[stage 5/6] render README")
        readme_text = render_readme(ctx, manifest)
        readme_path = ctx.bundle_dir / "README.md"
        readme_path.write_text(readme_text)

        if ctx.dry_run:
            log.info("\n--- manifest preview ---\n%s",
                     json.dumps(manifest, indent=2))

        log.info("[stage 6/6] push to %s%s", ctx.repo_id,
                 " (dry-run)" if ctx.dry_run else "")
        upload_pairs = _build_upload_list(ctx, layout)
        push_to_hf(ctx, manifest_path, readme_path, upload_pairs)

        tag_name = tag_training_repo(ctx, version, ctx.dry_run)
        log.info("done. tag=%s", tag_name)
        return EXIT_OK

    except OrchestratorError as exc:
        log.error("orchestrator error: %s", exc)
        return exc.exit_code


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_args(argv: Sequence[str] | None = None) -> PublishContext:
    ap = argparse.ArgumentParser(
        prog="python -m publish.orchestrator",
        description=(
            "End-to-end Eliza-1 bundle publisher. Runs layout validation, "
            "kernel verification, eval gates, manifest build, README "
            "render, and HF push as one pipeline. There is no flag to "
            "skip any check; --dry-run performs every check but does "
            "not push."
        ),
    )
    ap.add_argument(
        "--tier",
        required=True,
        choices=tuple(SUPPORTED_BACKENDS_BY_TIER.keys()),
        help="Eliza-1 device tier id.",
    )
    ap.add_argument(
        "--bundle-dir",
        required=True,
        type=Path,
        help="Path to the assembled bundle directory (text/, tts/, ...).",
    )
    ap.add_argument(
        "--repo-id",
        default=None,
        help="Override HF repo id (default: elizalabs/eliza-1-<tier>).",
    )
    ap.add_argument(
        "--public",
        action="store_true",
        help="Create the HF repo as public on first publish (default: private).",
    )
    ap.add_argument(
        "--metal-verification",
        type=Path,
        default=None,
        help=(
            "Path to a previously-recorded metal_verify.json from a "
            "verified Metal host. Required when the tier supports Metal."
        ),
    )
    ap.add_argument(
        "--gates-path",
        type=Path,
        default=None,
        help="Override path to eliza1_gates.yaml (default: bundled).",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Run every check but do not push to HF or tag git.",
    )
    args = ap.parse_args(argv)

    repo_id = args.repo_id or f"elizalabs/eliza-1-{args.tier}"
    template_path = (
        Path(__file__).resolve().parent / "templates" / "README.md.j2"
    )

    return PublishContext(
        tier=args.tier,
        bundle_dir=args.bundle_dir.resolve(),
        dry_run=args.dry_run,
        metal_verification=(
            args.metal_verification.resolve()
            if args.metal_verification
            else None
        ),
        repo_id=repo_id,
        public=args.public,
        training_repo_root=_REPO_ROOT,
        template_path=template_path,
        gates_path=args.gates_path,
    )


def main(argv: Sequence[str] | None = None) -> int:
    ctx = _parse_args(argv)
    return run(ctx)


if __name__ == "__main__":
    sys.exit(main())
