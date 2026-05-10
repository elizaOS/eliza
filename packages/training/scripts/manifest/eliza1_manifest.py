"""Eliza-1 manifest generator + validator (Python side).

Mirror of the TS module under
``eliza/packages/app-core/src/services/local-inference/manifest/``. The
publish flow (``publish_all_eliza1.sh`` and friends) calls
``build_manifest`` after assembling files, running quantization, hardware
verification, and evals. The function refuses to emit
``defaultEligible: True`` if any required gate fails — the same rule the
runtime validator enforces.

Source of truth:
- ``packages/inference/AGENTS.md`` §6 (manifest schema)
- ``packages/inference/AGENTS.md`` §3 (mandatory kernels)
- ``packages/inference/AGENTS.md`` §2 (tier matrix)
- ``packages/training/AGENTS.md`` §6 (publishing flow / publish-blocking
  conditions)
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Iterable, Mapping, Sequence

# ---------------------------------------------------------------------------
# Constants — keep in sync with schema.ts
# ---------------------------------------------------------------------------

ELIZA_1_MANIFEST_SCHEMA_VERSION: Final[str] = "1"
ELIZA_1_MANIFEST_SCHEMA_URL: Final[str] = (
    "https://elizalabs.ai/schemas/eliza-1.manifest.v1.json"
)

ELIZA_1_TIERS: Final[tuple[str, ...]] = (
    "lite-0_6b",
    "mobile-1_7b",
    "desktop-9b",
    "pro-27b",
    "server-h200",
)

ELIZA_1_KERNELS: Final[tuple[str, ...]] = (
    "turboquant_q3",
    "turboquant_q4",
    "qjl",
    "polarquant",
    "dflash",
    "turbo3_tcq",
)

ELIZA_1_BACKENDS: Final[tuple[str, ...]] = ("metal", "vulkan", "cuda", "cpu")

REQUIRED_KERNELS_BY_TIER: Final[Mapping[str, tuple[str, ...]]] = {
    "lite-0_6b": ("turboquant_q3", "qjl", "polarquant", "dflash"),
    "mobile-1_7b": ("turboquant_q4", "qjl", "polarquant", "dflash"),
    "desktop-9b": ("turboquant_q4", "qjl", "polarquant", "dflash"),
    "pro-27b": ("turboquant_q4", "qjl", "polarquant", "dflash"),
    "server-h200": ("turboquant_q4", "qjl", "polarquant", "dflash"),
}

SUPPORTED_BACKENDS_BY_TIER: Final[Mapping[str, tuple[str, ...]]] = {
    "lite-0_6b": ("metal", "vulkan", "cpu"),
    "mobile-1_7b": ("metal", "vulkan", "cpu"),
    "desktop-9b": ("metal", "vulkan", "cuda", "cpu"),
    "pro-27b": ("metal", "vulkan", "cuda", "cpu"),
    "server-h200": ("cuda", "vulkan", "cpu"),
}

_SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$")
# Matches Zod's ``z.string().datetime()`` default: UTC ``Z`` suffix only,
# fractional seconds optional. Timezone offsets (``+00:00``) are NOT
# accepted — the TS validator rejects them and the publish orchestrator
# always emits ``...Z``. Keeping the two validators in lockstep prevents
# manifests that pass Python validation from being rejected at runtime.
_DATETIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$"
)


# Filename ctx-suffix parser, e.g. ``64k`` → 65536, ``256k`` → 262144.
# Lives here (not in the publish module) because both the publish gate
# and the manifest builder must agree byte-for-byte on what counts as a
# long-context text file. Format: <integer><k>, where the ``k`` suffix is
# required.
_CTX_SUFFIX_RE = re.compile(r"^(\d+)k$")


def parse_ctx_string(s: str) -> int:
    """Return the integer context length encoded by a ``<num>k`` suffix.

    Examples
    --------
    >>> parse_ctx_string("64k")
    65536
    >>> parse_ctx_string("256k")
    262144

    Raises ``ValueError`` if the string is not exactly ``<digits>k`` —
    bare integers, missing suffix, or any other shape are invalid. The
    publish orchestrator and the manifest file builder both call this
    so the long-context detection used at publish-blocking time matches
    the bytes the manifest records.
    """
    m = _CTX_SUFFIX_RE.match(s)
    if not m:
        raise ValueError(
            f"context suffix must match `<digits>k`, got {s!r}"
        )
    return int(m.group(1)) * 1024


def parse_text_ctx_from_filename(p: Path) -> int | None:
    """Pull a `<num>k` token out of a text variant's filename stem.

    Walks the dash-separated tokens of the stem from right to left and
    returns the first one that parses as a context suffix. Returns
    ``None`` when no token matches — text files without a ctx suffix in
    the filename ship without a declared context length in the manifest.
    """
    for token in reversed(p.stem.split("-")):
        try:
            return parse_ctx_string(token)
        except ValueError:
            continue
    return None


class Eliza1ManifestError(ValueError):
    """Raised when manifest input violates schema or §3/§6 contract.

    Always carries a list of ``errors`` so callers can render every
    failure at once instead of one round-trip per fix.
    """

    def __init__(self, errors: Sequence[str]) -> None:
        joined = "\n  - ".join(errors)
        super().__init__(f"Invalid Eliza-1 manifest:\n  - {joined}")
        self.errors: tuple[str, ...] = tuple(errors)


# ---------------------------------------------------------------------------
# Inputs to build_manifest()
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class FileEntry:
    """One file in the bundle. ``ctx`` only applies to text variants."""

    path: str
    sha256: str
    ctx: int | None = None


@dataclass(frozen=True, slots=True)
class LineageEntry:
    base: str
    license: str


@dataclass(frozen=True, slots=True)
class KernelVerification:
    """Result from a single backend's verify run.

    ``status`` is "pass" / "fail" / "skipped" — same vocabulary as the TS
    side. ``at_commit`` and ``report`` are required so the manifest is
    auditable.
    """

    status: str
    at_commit: str
    report: str


# ---------------------------------------------------------------------------
# Validator
# ---------------------------------------------------------------------------


def _is_object(x: Any) -> bool:
    return isinstance(x, dict)


def validate_manifest(manifest: Mapping[str, Any]) -> tuple[str, ...]:
    """Return a tuple of error messages. Empty tuple = valid.

    Performs every check the TS validator does: schema shape, types,
    sha256 / semver / datetime regexes, plus the cross-field §3 / §6
    contract rules. The publish script can call this directly before
    writing the file.
    """

    errors: list[str] = []

    # ── shape ────────────────────────────────────────────────────────────
    required_top = (
        "id",
        "tier",
        "version",
        "publishedAt",
        "lineage",
        "files",
        "kernels",
        "evals",
        "ramBudgetMb",
        "defaultEligible",
    )
    for key in required_top:
        if key not in manifest:
            errors.append(f"<root>: missing required field {key}")
    if errors:
        return tuple(errors)

    tier = manifest["tier"]
    if tier not in ELIZA_1_TIERS:
        errors.append(f"tier: unknown tier {tier!r}")
        return tuple(errors)

    if not isinstance(manifest["id"], str) or not manifest["id"]:
        errors.append("id: must be a non-empty string")
    else:
        prefix = f"eliza-1-{tier}"
        if manifest["id"] != prefix and not manifest["id"].startswith(f"{prefix}-"):
            errors.append("id: must start with `eliza-1-<tier>`")

    if not isinstance(manifest["version"], str) or not _SEMVER_RE.match(
        manifest["version"]
    ):
        errors.append("version: must match semver (e.g. 1.0.0)")

    if not isinstance(manifest["publishedAt"], str) or not _DATETIME_RE.match(
        manifest["publishedAt"]
    ):
        errors.append("publishedAt: must be an ISO-8601 datetime")

    # ── lineage ──────────────────────────────────────────────────────────
    lineage = manifest["lineage"]
    if not _is_object(lineage):
        errors.append("lineage: must be an object")
    else:
        for slot in ("text", "voice", "drafter"):
            entry = lineage.get(slot)
            if not _is_object(entry):
                errors.append(f"lineage.{slot}: must be an object")
                continue
            if not entry.get("base"):
                errors.append(f"lineage.{slot}.base: required")
            if not entry.get("license"):
                errors.append(f"lineage.{slot}.license: required")

    # ── files ────────────────────────────────────────────────────────────
    files = manifest["files"]
    if not _is_object(files):
        errors.append("files: must be an object")
    else:
        kinds_min1 = ("text", "voice", "dflash", "cache")
        kinds_optional = ("asr", "vision")
        for kind in (*kinds_min1, *kinds_optional):
            value = files.get(kind)
            if not isinstance(value, list):
                errors.append(f"files.{kind}: must be an array")
                continue
            if kind in kinds_min1 and not value:
                errors.append(f"files.{kind}: at least one entry required")
            for i, entry in enumerate(value):
                if not _is_object(entry):
                    errors.append(f"files.{kind}[{i}]: must be an object")
                    continue
                if not entry.get("path"):
                    errors.append(f"files.{kind}[{i}].path: required")
                sha = entry.get("sha256")
                if not isinstance(sha, str) or not _SHA256_RE.match(sha):
                    errors.append(
                        f"files.{kind}[{i}].sha256: must be 64 lowercase hex chars"
                    )
                ctx = entry.get("ctx")
                if ctx is not None and (not isinstance(ctx, int) or ctx <= 0):
                    errors.append(
                        f"files.{kind}[{i}].ctx: must be a positive integer when set"
                    )

    # ── kernels ──────────────────────────────────────────────────────────
    kernels = manifest["kernels"]
    declared_required: tuple[str, ...] = ()
    declared_optional: tuple[str, ...] = ()
    backends: Mapping[str, Any] = {}
    if not _is_object(kernels):
        errors.append("kernels: must be an object")
    else:
        req = kernels.get("required")
        opt = kernels.get("optional")
        if not isinstance(req, list) or not req:
            errors.append("kernels.required: must be a non-empty array")
            req = []
        if not isinstance(opt, list):
            errors.append("kernels.optional: must be an array")
            opt = []
        for k in (*req, *opt):
            if k not in ELIZA_1_KERNELS:
                errors.append(f"kernels: unknown kernel {k!r}")
        declared_required = tuple(k for k in req if k in ELIZA_1_KERNELS)
        declared_optional = tuple(k for k in opt if k in ELIZA_1_KERNELS)

        vb = kernels.get("verifiedBackends")
        if not _is_object(vb):
            errors.append("kernels.verifiedBackends: must be an object")
        else:
            for b in ELIZA_1_BACKENDS:
                entry = vb.get(b)
                if not _is_object(entry):
                    errors.append(f"kernels.verifiedBackends.{b}: required")
                    continue
                if entry.get("status") not in {"pass", "fail", "skipped"}:
                    errors.append(
                        f"kernels.verifiedBackends.{b}.status: must be pass/fail/skipped"
                    )
                if not entry.get("atCommit"):
                    errors.append(f"kernels.verifiedBackends.{b}.atCommit: required")
                if not entry.get("report"):
                    errors.append(f"kernels.verifiedBackends.{b}.report: required")
            backends = vb

    # ── evals ────────────────────────────────────────────────────────────
    evals = manifest["evals"]
    if not _is_object(evals):
        errors.append("evals: must be an object")
    else:
        text_eval = evals.get("textEval")
        if not _is_object(text_eval):
            errors.append("evals.textEval: required object")
        else:
            score = text_eval.get("score")
            if not isinstance(score, (int, float)) or not 0 <= score <= 1:
                errors.append("evals.textEval.score: must be a number in [0, 1]")
            if not isinstance(text_eval.get("passed"), bool):
                errors.append("evals.textEval.passed: must be a boolean")

        voice = evals.get("voiceRtf")
        if not _is_object(voice):
            errors.append("evals.voiceRtf: required object")
        else:
            rtf = voice.get("rtf")
            if not isinstance(rtf, (int, float)) or rtf < 0:
                errors.append("evals.voiceRtf.rtf: must be a non-negative number")
            if not isinstance(voice.get("passed"), bool):
                errors.append("evals.voiceRtf.passed: must be a boolean")

        for flag in ("e2eLoopOk", "thirtyTurnOk"):
            if not isinstance(evals.get(flag), bool):
                errors.append(f"evals.{flag}: must be a boolean")

    # ── ram budget ───────────────────────────────────────────────────────
    ram = manifest["ramBudgetMb"]
    if not _is_object(ram):
        errors.append("ramBudgetMb: must be an object")
    else:
        rmin = ram.get("min")
        rrec = ram.get("recommended")
        if not isinstance(rmin, int) or rmin <= 0:
            errors.append("ramBudgetMb.min: must be a positive integer")
        if not isinstance(rrec, int) or rrec <= 0:
            errors.append("ramBudgetMb.recommended: must be a positive integer")
        if (
            isinstance(rmin, int)
            and isinstance(rrec, int)
            and rmin > 0
            and rrec > 0
            and rrec < rmin
        ):
            errors.append("ramBudgetMb.recommended must be >= ramBudgetMb.min")

    if not isinstance(manifest["defaultEligible"], bool):
        errors.append("defaultEligible: must be a boolean")

    # If shape is broken, don't try the cross-field rules.
    if errors:
        return tuple(errors)

    # ── §3/§6 contract: required-kernel coverage ────────────────────────
    declared_set = set(declared_required)
    for k in REQUIRED_KERNELS_BY_TIER[tier]:
        if k not in declared_set:
            errors.append(
                f"kernels.required: missing required kernel for tier {tier}: {k}"
            )

    has_long_ctx = any(
        isinstance(f.get("ctx"), int) and f["ctx"] > 65536 for f in files["text"]
    )
    if has_long_ctx and "turbo3_tcq" not in declared_set and "turbo3_tcq" not in set(
        declared_optional
    ):
        errors.append(
            "kernels: text variant with ctx > 64k requires turbo3_tcq in required or optional set"
        )

    # ── §3/§6 contract: every supported backend is pass ─────────────────
    for b in SUPPORTED_BACKENDS_BY_TIER[tier]:
        status = backends.get(b, {}).get("status")
        if status != "pass":
            errors.append(
                f'kernels.verifiedBackends.{b}: status is "{status}", expected "pass" for tier {tier}'
            )

    # ── §3/§6 contract: evals all pass ──────────────────────────────────
    if not evals["textEval"]["passed"]:
        errors.append("evals.textEval.passed: false")
    if not evals["voiceRtf"]["passed"]:
        errors.append("evals.voiceRtf.passed: false")
    if not evals["e2eLoopOk"]:
        errors.append("evals.e2eLoopOk: false")
    if not evals["thirtyTurnOk"]:
        errors.append("evals.thirtyTurnOk: false")

    # ── strongest claim: defaultEligible ────────────────────────────────
    if manifest["defaultEligible"] and errors:
        errors.insert(
            0,
            "defaultEligible: true requires all required kernels, supported backends, and evals to pass",
        )

    return tuple(errors)


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------


def _file_dict(entry: FileEntry) -> dict[str, Any]:
    out: dict[str, Any] = {"path": entry.path, "sha256": entry.sha256}
    if entry.ctx is not None:
        out["ctx"] = entry.ctx
    return out


def build_manifest(
    *,
    tier: str,
    version: str,
    published_at: str,
    lineage: Mapping[str, LineageEntry],
    files: Mapping[str, Sequence[FileEntry]],
    kernels_required: Sequence[str],
    kernels_optional: Sequence[str],
    verified_backends: Mapping[str, KernelVerification],
    text_eval_score: float,
    text_eval_passed: bool,
    voice_rtf: float,
    voice_rtf_passed: bool,
    e2e_loop_ok: bool,
    thirty_turn_ok: bool,
    ram_budget_min_mb: int,
    ram_budget_recommended_mb: int,
    default_eligible: bool,
    bundle_id: str | None = None,
) -> dict[str, Any]:
    """Assemble a manifest dict from typed inputs and validate it.

    Refuses to emit ``defaultEligible: True`` when validation finds any
    contract violation. Mirrors the TS rule and matches the
    publish-blocking conditions in ``packages/training/AGENTS.md`` §6.
    """

    if tier not in ELIZA_1_TIERS:
        raise Eliza1ManifestError([f"tier: unknown tier {tier!r}"])

    if bundle_id is None:
        bundle_id = f"eliza-1-{tier}"

    file_map: dict[str, list[dict[str, Any]]] = {}
    for kind in ("text", "voice", "asr", "vision", "dflash", "cache"):
        file_map[kind] = [_file_dict(f) for f in files.get(kind, ())]

    manifest: dict[str, Any] = {
        "$schema": ELIZA_1_MANIFEST_SCHEMA_URL,
        "id": bundle_id,
        "tier": tier,
        "version": version,
        "publishedAt": published_at,
        "lineage": {
            slot: {"base": entry.base, "license": entry.license}
            for slot, entry in lineage.items()
        },
        "files": file_map,
        "kernels": {
            "required": list(kernels_required),
            "optional": list(kernels_optional),
            "verifiedBackends": {
                b: {
                    "status": v.status,
                    "atCommit": v.at_commit,
                    "report": v.report,
                }
                for b, v in verified_backends.items()
            },
        },
        "evals": {
            "textEval": {"score": text_eval_score, "passed": text_eval_passed},
            "voiceRtf": {"rtf": voice_rtf, "passed": voice_rtf_passed},
            "e2eLoopOk": e2e_loop_ok,
            "thirtyTurnOk": thirty_turn_ok,
        },
        "ramBudgetMb": {
            "min": ram_budget_min_mb,
            "recommended": ram_budget_recommended_mb,
        },
        "defaultEligible": default_eligible,
    }

    errors = validate_manifest(manifest)
    if errors:
        raise Eliza1ManifestError(errors)
    return manifest


def write_manifest(manifest: Mapping[str, Any], destination: Path) -> Path:
    """Validate then write a manifest as pretty-printed JSON.

    Raises ``Eliza1ManifestError`` if validation fails — never writes a
    bad manifest. Returns the resolved destination path.
    """

    errors = validate_manifest(manifest)
    if errors:
        raise Eliza1ManifestError(errors)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(manifest, indent=2, sort_keys=False) + "\n")
    return destination


# ---------------------------------------------------------------------------
# Loader helpers (used by publish_*.py to assemble inputs from JSON files)
# ---------------------------------------------------------------------------


def load_kernel_verification_reports(
    paths: Mapping[str, Path],
) -> dict[str, KernelVerification]:
    """Load per-backend verification reports.

    Each file is JSON shaped like::

        {"status": "pass", "atCommit": "...", "report": "metal_verify.txt"}

    The keys of ``paths`` must be backend names from ``ELIZA_1_BACKENDS``.
    Missing keys raise — there is no "default to skipped" path.
    """

    missing = set(ELIZA_1_BACKENDS) - set(paths.keys())
    if missing:
        raise Eliza1ManifestError(
            [f"verification report missing for backend(s): {sorted(missing)}"]
        )

    out: dict[str, KernelVerification] = {}
    for backend, path in paths.items():
        if backend not in ELIZA_1_BACKENDS:
            raise Eliza1ManifestError([f"unknown backend in reports: {backend}"])
        data = json.loads(path.read_text())
        out[backend] = KernelVerification(
            status=data["status"],
            at_commit=data["atCommit"],
            report=data["report"],
        )
    return out


def file_entries_from_records(
    records: Iterable[Mapping[str, Any]],
) -> list[FileEntry]:
    """Helper to convert ``[{"path": ..., "sha256": ..., "ctx": ...}]``
    records (e.g. from a quantization sidecar) into ``FileEntry`` values."""

    entries: list[FileEntry] = []
    for r in records:
        entries.append(
            FileEntry(
                path=r["path"],
                sha256=r["sha256"],
                ctx=r.get("ctx"),
            )
        )
    return entries
