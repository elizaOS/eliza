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
    "0_6b",
    "1_7b",
    "9b",
    "27b",
    "27b-256k",
    "27b-1m",
)

ELIZA_1_KERNELS: Final[tuple[str, ...]] = (
    "turboquant_q3",
    "turboquant_q4",
    "qjl",
    "polarquant",
    "dflash",
    "turbo3_tcq",
)

ELIZA_1_BACKENDS: Final[tuple[str, ...]] = (
    "metal",
    "vulkan",
    "cuda",
    "rocm",
    "cpu",
)
ELIZA_1_VOICE_CAPABILITIES: Final[tuple[str, ...]] = (
    "tts",
    "emotion-tags",
    "singing",
)
ELIZA_1_VOICE_MANIFEST_VERSION: Final[str] = "1"
VOICE_PRESET_CACHE_PATH: Final[str] = "cache/voice-preset-default.bin"

REQUIRED_KERNELS_BY_TIER: Final[Mapping[str, tuple[str, ...]]] = {
    "0_6b": ("turboquant_q3", "qjl", "polarquant", "dflash"),
    "1_7b": ("turboquant_q4", "qjl", "polarquant", "dflash"),
    "9b": (
        "turboquant_q4",
        "qjl",
        "polarquant",
        "dflash",
        "turbo3_tcq",
    ),
    "27b": (
        "turboquant_q4",
        "qjl",
        "polarquant",
        "dflash",
        "turbo3_tcq",
    ),
    "27b-256k": (
        "turboquant_q4",
        "qjl",
        "polarquant",
        "dflash",
        "turbo3_tcq",
    ),
    "27b-1m": (
        "turboquant_q4",
        "qjl",
        "polarquant",
        "dflash",
        "turbo3_tcq",
    ),
}

SUPPORTED_BACKENDS_BY_TIER: Final[Mapping[str, tuple[str, ...]]] = {
    "0_6b": ("metal", "vulkan", "cpu"),
    "1_7b": ("metal", "vulkan", "cpu"),
    "9b": ("metal", "vulkan", "cuda", "rocm", "cpu"),
    "27b": ("metal", "vulkan", "cuda", "rocm", "cpu"),
    "27b-256k": ("metal", "vulkan", "cuda", "rocm", "cpu"),
    # 1M context is only practical on very large unified/HBM memory
    # (GH200-class). CUDA is the only backend whose v0.4.0-milady binary
    # covers the full runtime path at that window today; the others stay
    # off the supported list for this variant until verified.
    "27b-1m": ("cuda",),
}

VOICE_QUANT_BY_TIER: Final[Mapping[str, str]] = {
    "0_6b": "Q4_K_M",
    "1_7b": "Q4_K_M",
    "9b": "Q8_0",
    "27b": "Q8_0",
    "27b-256k": "Q8_0",
    "27b-1m": "Q8_0",
}


def required_voice_artifacts_for_tier(tier: str) -> tuple[str, str]:
    """Return the frozen OmniVoice GGUF pair required for ``tier``."""

    quant = VOICE_QUANT_BY_TIER[tier]
    return (
        f"omnivoice-base-{quant}.gguf",
        f"omnivoice-tokenizer-{quant}.gguf",
    )

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


# Filename ctx-suffix parser, e.g. ``64k`` → 65536, ``256k`` → 262144,
# ``1m`` → 1048576. Lives here (not in the publish module) because both the
# publish gate and the manifest builder must agree byte-for-byte on what
# counts as a long-context text file. Format: <integer> followed by ``k``
# (× 1024) or ``m`` (× 1024²).
_CTX_SUFFIX_RE = re.compile(r"^(\d+)([km])$")
_CTX_SUFFIX_SCALE: Final[Mapping[str, int]] = {"k": 1024, "m": 1024 * 1024}


def parse_ctx_string(s: str) -> int:
    """Return the integer context length encoded by a ``<num>k``/``<num>m`` suffix.

    Examples
    --------
    >>> parse_ctx_string("64k")
    65536
    >>> parse_ctx_string("256k")
    262144
    >>> parse_ctx_string("1m")
    1048576

    Raises ``ValueError`` if the string is not exactly ``<digits>k`` or
    ``<digits>m`` — bare integers, missing suffix, or any other shape are
    invalid. The publish orchestrator and the manifest file builder both
    call this so the long-context detection used at publish-blocking time
    matches the bytes the manifest records.
    """
    m = _CTX_SUFFIX_RE.match(s)
    if not m:
        raise ValueError(
            f"context suffix must match `<digits>k` or `<digits>m`, got {s!r}"
        )
    return int(m.group(1)) * _CTX_SUFFIX_SCALE[m.group(2)]


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


def validate_manifest(
    manifest: Mapping[str, Any],
    *,
    require_publish_ready: bool = True,
) -> tuple[str, ...]:
    """Return a tuple of error messages. Empty tuple = valid.

    Performs every check the TS validator does: schema shape, types,
    sha256 / semver / datetime regexes, plus the cross-field §3 / §6
    contract rules. The publish script can call this directly before
    writing the file.

    ``require_publish_ready=False`` is only for local staging manifests
    that intentionally record failed / missing release gates with
    ``defaultEligible: false``. It still validates the schema, required
    kernel declarations, lineage-vs-files consistency, and required eval
    objects for shipped components; it only stops treating red backend and
    eval gate statuses as validator errors unless ``defaultEligible`` is
    true. Normal publish paths must keep the default.
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
        # Required lineage entries.
        for slot in ("text", "voice", "drafter"):
            entry = lineage.get(slot)
            if not _is_object(entry):
                errors.append(f"lineage.{slot}: must be an object")
                continue
            if not entry.get("base"):
                errors.append(f"lineage.{slot}.base: required")
            if not entry.get("license"):
                errors.append(f"lineage.{slot}.license: required")
        # Wave-6 optional lineage entries — must validate when present.
        for slot in ("asr", "embedding", "vision", "vad", "wakeword"):
            entry = lineage.get(slot)
            if entry is None:
                continue
            if not _is_object(entry):
                errors.append(f"lineage.{slot}: must be an object when present")
                continue
            if not entry.get("base"):
                errors.append(f"lineage.{slot}.base: required when lineage.{slot} present")
            if not entry.get("license"):
                errors.append(f"lineage.{slot}.license: required when lineage.{slot} present")

    # ── files ────────────────────────────────────────────────────────────
    files = manifest["files"]
    if not _is_object(files):
        errors.append("files: must be an object")
    else:
        kinds_min1 = ("text", "voice", "dflash", "cache")
        kinds_optional = ("asr", "vision")
        # Wave-6 fully-optional file slots: missing key = "this bundle
        # does not ship this component". The validator does not require
        # an empty array for absence (TS schema makes the array itself
        # optional), but if present it must be a real array.
        kinds_fully_optional = ("embedding", "vad", "wakeword")
        for kind in (*kinds_min1, *kinds_optional, *kinds_fully_optional):
            # The kinds_fully_optional slots are absent-OK; iterate over
            # whatever the value actually is (the array-shape check above
            # already rejected non-arrays for present slots).
            value = files.get(kind)
            if value is None and kind in kinds_fully_optional:
                continue
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

        asr_wer = evals.get("asrWer")
        if asr_wer is not None:
            if not _is_object(asr_wer):
                errors.append("evals.asrWer: must be an object when present")
            else:
                wer = asr_wer.get("wer")
                if not isinstance(wer, (int, float)) or wer < 0:
                    errors.append("evals.asrWer.wer: must be a non-negative number")
                if not isinstance(asr_wer.get("passed"), bool):
                    errors.append("evals.asrWer.passed: must be a boolean")

        embed_mteb = evals.get("embedMteb")
        if embed_mteb is not None:
            if not _is_object(embed_mteb):
                errors.append("evals.embedMteb: must be an object when present")
            else:
                score = embed_mteb.get("score")
                if not isinstance(score, (int, float)) or not 0 <= score <= 1:
                    errors.append("evals.embedMteb.score: must be a number in [0, 1]")
                if not isinstance(embed_mteb.get("passed"), bool):
                    errors.append("evals.embedMteb.passed: must be a boolean")

        vad_latency = evals.get("vadLatencyMs")
        if vad_latency is not None:
            if not _is_object(vad_latency):
                errors.append("evals.vadLatencyMs: must be an object when present")
            else:
                median = vad_latency.get("median")
                if not isinstance(median, (int, float)) or median < 0:
                    errors.append(
                        "evals.vadLatencyMs.median: must be a non-negative number"
                    )
                if not isinstance(vad_latency.get("passed"), bool):
                    errors.append("evals.vadLatencyMs.passed: must be a boolean")

        expressive = evals.get("expressive")
        if expressive is not None:
            if not _is_object(expressive):
                errors.append("evals.expressive: must be an object when present")
            else:
                for field in ("tagFaithfulness", "mosExpressive", "tagLeakage"):
                    value = expressive.get(field)
                    if not isinstance(value, (int, float)) or value < 0:
                        errors.append(
                            f"evals.expressive.{field}: must be a non-negative number"
                        )
                tag_faithfulness = expressive.get("tagFaithfulness")
                if isinstance(tag_faithfulness, (int, float)) and tag_faithfulness > 1:
                    errors.append(
                        "evals.expressive.tagFaithfulness: must be a number in [0, 1]"
                    )
                if not isinstance(expressive.get("passed"), bool):
                    errors.append("evals.expressive.passed: must be a boolean")

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

    voice = manifest.get("voice")
    if voice is not None:
        if not _is_object(voice):
            errors.append("voice: must be an object when present")
        else:
            version = voice.get("version")
            if not isinstance(version, str) or not version:
                errors.append("voice.version: must be a non-empty string")
            if voice.get("frozen") is not True:
                errors.append("voice.frozen: must be true")
            cache = voice.get("cache")
            if not _is_object(cache):
                errors.append("voice.cache: must be an object")
            else:
                for field in ("speakerPreset", "phraseCacheSeed"):
                    value = cache.get(field)
                    if not isinstance(value, str) or not value:
                        errors.append(f"voice.cache.{field}: must be a non-empty string")
            capabilities = voice.get("capabilities")
            if not isinstance(capabilities, list):
                errors.append("voice.capabilities: must be an array")
            else:
                for capability in capabilities:
                    if capability not in ELIZA_1_VOICE_CAPABILITIES:
                        errors.append(
                            f"voice.capabilities: unknown capability {capability!r}"
                        )

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
    if has_long_ctx and "turbo3_tcq" not in declared_set:
        errors.append(
            "kernels.required: text variant with ctx > 64k requires turbo3_tcq"
        )

    # ── §4 contract: frozen voice cache artifacts ───────────────────────
    cache_paths = {
        f.get("path")
        for f in files["cache"]
        if _is_object(f) and isinstance(f.get("path"), str)
    }
    if VOICE_PRESET_CACHE_PATH not in cache_paths:
        errors.append(
            f"files.cache: missing required frozen voice cache {VOICE_PRESET_CACHE_PATH}"
        )
    if _is_object(manifest.get("voice")) and _is_object(
        manifest["voice"].get("cache")
    ):
        voice_cache = manifest["voice"]["cache"]
        for field in ("speakerPreset", "phraseCacheSeed"):
            path = voice_cache.get(field)
            if isinstance(path, str) and path not in cache_paths:
                errors.append(
                    f"voice.cache.{field}: {path!r} is not present in files.cache"
                )

    readiness_errors: list[str] = []

    # ── §3/§6 contract: every supported backend is pass ─────────────────
    for b in SUPPORTED_BACKENDS_BY_TIER[tier]:
        status = backends.get(b, {}).get("status")
        if status != "pass":
            readiness_errors.append(
                f'kernels.verifiedBackends.{b}: status is "{status}", expected "pass" for tier {tier}'
            )

    # ── §3/§6 contract: evals all pass ──────────────────────────────────
    if not evals["textEval"]["passed"]:
        readiness_errors.append("evals.textEval.passed: false")
    if not evals["voiceRtf"]["passed"]:
        readiness_errors.append("evals.voiceRtf.passed: false")
    if not evals["e2eLoopOk"]:
        readiness_errors.append("evals.e2eLoopOk: false")
    if not evals["thirtyTurnOk"]:
        readiness_errors.append("evals.thirtyTurnOk: false")

    # ── §3/§6 contract: voice bundle components + gates ─────────────────
    if manifest["defaultEligible"]:
        if not files.get("asr"):
            errors.append("files.asr: required for defaultEligible local voice bundles")
        if not files.get("vad"):
            errors.append("files.vad: required for defaultEligible local voice bundles")

    # ── §3/§6 contract: optional component consistency + gates ──────────
    optional_component_slots = ("asr", "embedding", "vision", "vad", "wakeword")
    for slot in optional_component_slots:
        component_files = files.get(slot) or []
        component_lineage = lineage.get(slot)
        if component_files and not component_lineage:
            errors.append(f"lineage.{slot}: required when files.{slot} is non-empty")
        if component_lineage and not component_files:
            errors.append(f"files.{slot}: required when lineage.{slot} is present")

    if files.get("asr"):
        gate = evals.get("asrWer")
        if not _is_object(gate):
            errors.append("evals.asrWer: required when files.asr is non-empty")
        elif not gate["passed"]:
            readiness_errors.append("evals.asrWer.passed: false")
    if files.get("embedding"):
        gate = evals.get("embedMteb")
        if not _is_object(gate):
            errors.append("evals.embedMteb: required when files.embedding is non-empty")
        elif not gate["passed"]:
            readiness_errors.append("evals.embedMteb.passed: false")
    if files.get("vad"):
        gate = evals.get("vadLatencyMs")
        if not _is_object(gate):
            errors.append("evals.vadLatencyMs: required when files.vad is non-empty")
        elif not gate["passed"]:
            readiness_errors.append("evals.vadLatencyMs.passed: false")

    capabilities = []
    if _is_object(manifest.get("voice")):
        maybe_capabilities = manifest["voice"].get("capabilities")
        if isinstance(maybe_capabilities, list):
            capabilities = maybe_capabilities
    if "emotion-tags" in capabilities or "singing" in capabilities:
        gate = evals.get("expressive")
        if not _is_object(gate):
            errors.append(
                "evals.expressive: required when voice capabilities include emotion-tags or singing"
            )
        elif not gate["passed"]:
            readiness_errors.append("evals.expressive.passed: false")

    if require_publish_ready or manifest["defaultEligible"]:
        errors.extend(readiness_errors)

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
    asr_wer: float | None = None,
    asr_wer_passed: bool | None = None,
    embed_mteb_score: float | None = None,
    embed_mteb_passed: bool | None = None,
    vad_latency_ms_median: float | None = None,
    vad_latency_ms_passed: bool | None = None,
    expressive_tag_faithfulness: float | None = None,
    expressive_mos: float | None = None,
    expressive_tag_leakage: float | None = None,
    expressive_passed: bool | None = None,
    voice_capabilities: Sequence[str] | None = None,
    voice_version: str = ELIZA_1_VOICE_MANIFEST_VERSION,
    voice_frozen: bool = True,
    voice_cache_speaker_preset: str = VOICE_PRESET_CACHE_PATH,
    voice_cache_phrase_seed: str = VOICE_PRESET_CACHE_PATH,
    bundle_id: str | None = None,
    require_publish_ready: bool = True,
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
    for kind in ("embedding", "vad", "wakeword"):
        if kind in files:
            file_map[kind] = [_file_dict(f) for f in files.get(kind, ())]

    evals: dict[str, Any] = {
        "textEval": {"score": text_eval_score, "passed": text_eval_passed},
        "voiceRtf": {"rtf": voice_rtf, "passed": voice_rtf_passed},
        "e2eLoopOk": e2e_loop_ok,
        "thirtyTurnOk": thirty_turn_ok,
    }
    if asr_wer is not None or asr_wer_passed is not None:
        evals["asrWer"] = {
            "wer": asr_wer if asr_wer is not None else -1,
            "passed": bool(asr_wer_passed),
        }
    if embed_mteb_score is not None or embed_mteb_passed is not None:
        evals["embedMteb"] = {
            "score": embed_mteb_score if embed_mteb_score is not None else -1,
            "passed": bool(embed_mteb_passed),
        }
    if vad_latency_ms_median is not None or vad_latency_ms_passed is not None:
        evals["vadLatencyMs"] = {
            "median": vad_latency_ms_median if vad_latency_ms_median is not None else -1,
            "passed": bool(vad_latency_ms_passed),
        }
    expressive_values = (
        expressive_tag_faithfulness,
        expressive_mos,
        expressive_tag_leakage,
        expressive_passed,
    )
    if any(value is not None for value in expressive_values):
        evals["expressive"] = {
            "tagFaithfulness": (
                expressive_tag_faithfulness
                if expressive_tag_faithfulness is not None
                else -1
            ),
            "mosExpressive": expressive_mos if expressive_mos is not None else -1,
            "tagLeakage": (
                expressive_tag_leakage if expressive_tag_leakage is not None else -1
            ),
            "passed": bool(expressive_passed),
        }

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
        "evals": evals,
        "ramBudgetMb": {
            "min": ram_budget_min_mb,
            "recommended": ram_budget_recommended_mb,
        },
        "defaultEligible": default_eligible,
    }
    if voice_capabilities is not None:
        manifest["voice"] = {
            "version": voice_version,
            "frozen": voice_frozen,
            "cache": {
                "speakerPreset": voice_cache_speaker_preset,
                "phraseCacheSeed": voice_cache_phrase_seed,
            },
            "capabilities": list(voice_capabilities),
        }

    errors = validate_manifest(
        manifest,
        require_publish_ready=require_publish_ready,
    )
    if errors:
        raise Eliza1ManifestError(errors)
    return manifest


def write_manifest(
    manifest: Mapping[str, Any],
    destination: Path,
    *,
    require_publish_ready: bool = True,
) -> Path:
    """Validate then write a manifest as pretty-printed JSON.

    Raises ``Eliza1ManifestError`` if validation fails — never writes a
    bad manifest. Returns the resolved destination path.
    """

    errors = validate_manifest(
        manifest,
        require_publish_ready=require_publish_ready,
    )
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
