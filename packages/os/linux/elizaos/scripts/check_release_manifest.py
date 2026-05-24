#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Fail-closed release-manifest gate for the elizaOS Debian RISC-V 64 variant.

This validator is the last gate between a freshly-built live ISO and a
release-manifest promotion. It refuses to pass until the qemu-virt boot
transcript exists, hashes match, the GRUB EFI RISC-V boot path is visible
in the transcript, and every required evidence row has been collected.

Classification policy (matches ``packages/chip/scripts/aggregate_tapeout_readiness.py``):

* ``PASS``     — every required evidence row is present and the qemu-virt /
                 GRUB EFI evidence files pass the structural + content checks.
* ``BLOCKED``  — informational: at least one required evidence row is
                 ``missing`` or ``planned`` and the manifest is still on
                 the ``planned`` status, OR an evidence file referenced
                 by the manifest is not yet on disk. ``BLOCKED`` exits 0
                 in the default mode and exit 1 under ``--strict``.
* ``FAIL``     — release blocker: schema mismatch, ``iso_sha256``
                 mismatch, ``boot_completed=false``, or a missing required
                 boot / agent marker in the transcript. Always exit 1
                 regardless of ``--strict``.

The validator deliberately uses the same vocabulary as the chip readiness
aggregator so the release pipeline can compose multiple gates without
inventing per-variant exit-code policies.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

try:
    import jsonschema
    from jsonschema.exceptions import SchemaError as _SchemaError
except ModuleNotFoundError:
    jsonschema = None
    _SchemaError = ()

# Error categories that mean "input present but structurally broken" and must
# fail closed with a clean STATUS line rather than escape as a traceback.
_MALFORMED_INPUT_ERRORS: tuple[type[BaseException], ...] = (
    json.JSONDecodeError,
    KeyError,
    ValueError,
) + ((_SchemaError,) if _SchemaError else ())

VARIANT_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = VARIANT_DIR.parents[3]
RELEASE_SCHEMA = (
    REPO_ROOT / "packages/os/release/schema/elizaos-os-release-manifest.schema.json"
)

# Required-evidence ids match the manifest template's emulator-release scope;
# do not edit one without editing the other. Promotion past ``planned`` requires
# every row collected.
REQUIRED_EVIDENCE_IDS: tuple[str, ...] = (
    "qemu-virt-boot",
    "grub-efi-riscv64-boot",
    "elizaos-agent-live",
    "riscv64-agent-runtime",
)

# Promoted artifact statuses require every evidence row to be ``collected``;
# the umbrella schema also permits ``planned`` and ``withdrawn`` where
# ``missing`` rows stay informational BLOCKED.
PROMOTED_STATUSES: frozenset[str] = frozenset({"candidate", "published"})

# Markers required before qemu-virt boot evidence can be promoted. The agent
# marker is emitted only after a target-side health check has succeeded.
REQUIRED_TRANSCRIPT_MARKERS: tuple[str, ...] = (
    "elizaos-firstboot-ready",
    "elizaos-curl-health-ready",
    "elizaos-agent-ready",
    "elizaos-tui-ready",
)
REQUIRED_TRANSCRIPT_MARKER = REQUIRED_TRANSCRIPT_MARKERS[0]
GRUB_TRANSCRIPT_MARKERS: tuple[str, ...] = (
    "GNU GRUB",
    "EFI stub: Booting Linux Kernel",
)

# Template substitution values used when the bare ``manifest.json.template``
# is read (it contains both bare and quoted ``@@...@@`` placeholders that are
# not valid JSON until ``build.sh`` replaces them). The substitutions are only
# applied when ``_select_manifest`` falls back to the template; a filled
# ``manifest.json`` is loaded verbatim.
# Bare (unquoted) JSON-value placeholders. ``null`` keeps the resulting
# payload schema-valid because the umbrella schema accepts ``["integer",
# "null"]`` on ``sizeBytes``.
TEMPLATE_BARE_PLACEHOLDERS: dict[str, str] = {
    "@@SIZE_BYTES@@": "null",
}
# Quoted-string placeholders. The substitution values match the schema's
# regex / minLength constraints so the schema check still focuses on the
# evidence rows that actually need to be filled in.
TEMPLATE_STRING_PLACEHOLDERS: dict[str, str] = {
    "@@FILENAME@@": "elizaos-linux-riscv64-template.iso",
    "@@SHA256@@": "0" * 64,
    "@@BUILD_TIMESTAMP@@": "template",
    "@@ARCH@@": "riscv64",
    "@@PROFILE@@": "template",
}
# Sentinel string values used by ``_is_template_payload`` to recognise an
# un-promoted manifest (filled or templated). Cross-check these against
# ``TEMPLATE_STRING_PLACEHOLDERS`` above.
TEMPLATE_SENTINEL_SHA256 = "0" * 64
TEMPLATE_SENTINEL_FILENAME = "elizaos-linux-riscv64-template.iso"
RISCV64_AGENT_RUNTIME_SCHEMA = "eliza.os.linux.riscv64_agent_runtime_smoke.v1"
RISCV64_BUN_PROVENANCE_SCHEMA = "eliza.os.linux.riscv64_bun_stage_provenance.v1"
RISCV64_BUN_VERSION_INPUT = "packages/app-core/scripts/bun-riscv64/bun-version.json"
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")

Status = Literal["PASS", "BLOCKED", "FAIL"]


@dataclass(frozen=True)
class GateResult:
    """One line in the gate report."""

    status: Status
    message: str


def _load_json(path: Path) -> dict:
    """Read a JSON file or raise FileNotFoundError / json.JSONDecodeError."""
    text = path.read_text()
    return json.loads(text)


def _sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            hasher.update(block)
    return hasher.hexdigest()


def _load_template(path: Path) -> dict:
    """Read ``manifest.json.template`` and replace ``@@...@@`` placeholders.

    The template lives in the repo as a non-JSON document because it carries
    bare placeholders like ``"sizeBytes": @@SIZE_BYTES@@``. We substitute
    each known placeholder with a safe sentinel so the resulting payload
    parses as JSON and the schema check still flags the unfilled fields via
    the evidence rows (which stay ``status: missing``).
    """
    text = path.read_text()
    for placeholder, replacement in TEMPLATE_BARE_PLACEHOLDERS.items():
        text = text.replace(placeholder, replacement)
    for placeholder, replacement in TEMPLATE_STRING_PLACEHOLDERS.items():
        text = text.replace(placeholder, replacement)
    return json.loads(text)


def _load_schema() -> dict:
    if not RELEASE_SCHEMA.is_file():
        raise FileNotFoundError(
            f"release manifest schema missing: {RELEASE_SCHEMA}. "
            "Did the os/release/schema directory move?"
        )
    return _load_json(RELEASE_SCHEMA)


def _artifact_schema(schema: dict) -> dict:
    """Return the schema fragment that an individual ``artifacts[]`` row obeys."""
    try:
        return schema["properties"]["artifacts"]["items"]
    except KeyError as exc:
        raise KeyError(
            "release manifest schema is missing properties.artifacts.items"
        ) from exc


def _is_template_payload(payload: dict) -> bool:
    """A template payload still carries unfilled sentinels.

    A filled ``manifest.json`` carries the real ISO filename and a real
    sha256 hex digest, so the sentinels we substitute during template
    loading are absent. The check is intentionally tolerant — a manifest
    that filled some fields and left others as sentinels is treated as
    a template (and therefore still un-promoted).
    """
    return (
        payload.get("filename") == TEMPLATE_SENTINEL_FILENAME
        or payload.get("sha256") == TEMPLATE_SENTINEL_SHA256
    )


def _select_manifest(variant_dir: Path) -> tuple[Path, dict, bool]:
    """Pick the filled ``manifest.json`` if present, else fall back to the template.

    Returns ``(path, payload, is_template)``. ``is_template`` short-circuits
    the strict evidence checks because a template by definition has not been
    filled with real values yet.
    """
    filled = variant_dir / "manifest.json"
    template = variant_dir / "manifest.json.template"
    if filled.is_file():
        payload = _load_json(filled)
        return filled, payload, _is_template_payload(payload)
    if template.is_file():
        return template, _load_template(template), True
    raise FileNotFoundError(
        f"no manifest.json or manifest.json.template found in {variant_dir}"
    )


def check_schema(manifest: dict, schema: dict) -> list[GateResult]:
    """Validate the variant manifest as a single ``artifacts[]`` entry."""
    if jsonschema is None:
        return [
            GateResult(
                "BLOCKED",
                "python dependency missing: jsonschema; run "
                "`python3 -m pip install jsonschema`",
            )
        ]
    artifact_schema = _artifact_schema(schema)
    validator = jsonschema.Draft202012Validator(artifact_schema)
    errors = sorted(validator.iter_errors(manifest), key=lambda err: list(err.path))
    if not errors:
        return [GateResult("PASS", "manifest matches artifacts[] schema fragment")]
    out: list[GateResult] = []
    for err in errors:
        path = "/".join(str(part) for part in err.path) or "<root>"
        out.append(GateResult("FAIL", f"schema violation at {path}: {err.message}"))
    return out


def check_required_evidence_rows(manifest: dict) -> list[GateResult]:
    """Every required-evidence id must appear in the manifest's evidence array."""
    validation = manifest.get("validation")
    if not isinstance(validation, dict):
        return [GateResult("FAIL", "manifest.validation is missing or not an object")]
    required = validation.get("requiredEvidence")
    if not isinstance(required, list):
        return [
            GateResult("FAIL", "manifest.validation.requiredEvidence must be an array")
        ]
    missing = sorted(set(REQUIRED_EVIDENCE_IDS) - set(required))
    if missing:
        return [
            GateResult(
                "FAIL",
                "manifest.validation.requiredEvidence is missing rows: "
                + ", ".join(missing),
            )
        ]
    return [GateResult("PASS", "manifest declares every required evidence id")]


def _evidence_index(manifest: dict) -> dict[str, dict]:
    validation = manifest.get("validation", {})
    raw = validation.get("evidence", []) if isinstance(validation, dict) else []
    out: dict[str, dict] = {}
    if isinstance(raw, list):
        for entry in raw:
            if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                out[entry["id"]] = entry
    return out


def check_evidence_rows_collected(
    manifest: dict, is_template: bool
) -> list[GateResult]:
    """Evidence rows must be ``collected`` when the artifact is promoted."""
    status = manifest.get("status")
    rows = _evidence_index(manifest)
    out: list[GateResult] = []
    is_promoted = status in PROMOTED_STATUSES
    for evidence_id in REQUIRED_EVIDENCE_IDS:
        row = rows.get(evidence_id)
        if row is None:
            out.append(
                GateResult(
                    "FAIL", f"manifest.validation.evidence missing row id={evidence_id}"
                )
            )
            continue
        row_status = row.get("status")
        if row_status == "collected":
            out.append(GateResult("PASS", f"evidence row {evidence_id} collected"))
            continue
        if is_promoted:
            out.append(
                GateResult(
                    "FAIL",
                    f"evidence row {evidence_id} is {row_status!r} but artifact status={status!r}",
                )
            )
            continue
        if is_template:
            out.append(
                GateResult(
                    "BLOCKED",
                    f"evidence row {evidence_id} is {row_status!r} "
                    "(template manifest; promotion past skeleton blocked)",
                )
            )
            continue
        out.append(
            GateResult(
                "BLOCKED",
                f"evidence row {evidence_id} is {row_status!r} "
                f"(artifact status={status!r}; collected before promotion)",
            )
        )
    return out


def _resolve_evidence_path(variant_dir: Path, path_value: str) -> Path:
    """Resolve an evidence path relative to the variant directory."""
    candidate = Path(path_value)
    if not candidate.is_absolute():
        candidate = (variant_dir / candidate).resolve()
    return candidate


def _resolve_transcript_path(variant_dir: Path, path_value: str) -> Path:
    """Resolve a transcript path, tolerating Docker-internal mount paths.

    The qemu smoke target may run inside the builder container, where the
    transcript is written to ``/transcript/<name>`` and then appears on the
    host under the variant's ``evidence/`` directory. Keep the evidence JSON
    truthful to the process that produced it while still allowing the release
    gate to verify the host-side artifact.
    """
    candidate = _resolve_evidence_path(variant_dir, path_value)
    if candidate.is_file():
        return candidate
    fallback = variant_dir / "evidence" / candidate.name
    if fallback.is_file():
        return fallback.resolve()
    return candidate


def check_qemu_virt_evidence(
    manifest: dict, is_template: bool, variant_dir: Path
) -> list[GateResult]:
    """Cross-check the qemu-virt evidence JSON against the manifest."""
    rows = _evidence_index(manifest)
    row = rows.get("qemu-virt-boot")
    if row is None:
        return [
            GateResult(
                "FAIL", "manifest.validation.evidence missing qemu-virt-boot row"
            )
        ]

    path_value = row.get("path")
    if not isinstance(path_value, str) or not path_value:
        if is_template:
            return [
                GateResult(
                    "BLOCKED",
                    "qemu-virt-boot.path not filled (template manifest)",
                )
            ]
        return [GateResult("BLOCKED", "qemu-virt-boot.path not filled")]

    evidence_path = _resolve_evidence_path(variant_dir, path_value)
    if not evidence_path.is_file():
        return [GateResult("BLOCKED", f"evidence file not present: {evidence_path}")]

    try:
        payload = _load_json(evidence_path)
    except json.JSONDecodeError as exc:
        return [GateResult("FAIL", f"evidence JSON invalid at {evidence_path}: {exc}")]
    if not isinstance(payload, dict):
        return [GateResult("FAIL", f"evidence JSON must be an object: {evidence_path}")]

    out: list[GateResult] = []
    if payload.get("boot_completed") is not True:
        out.append(
            GateResult(
                "FAIL",
                "qemu-virt boot did not complete: "
                f"boot_completed={payload.get('boot_completed')!r}",
            )
        )

    iso_sha256_manifest = manifest.get("sha256")
    iso_sha256_evidence = payload.get("iso_sha256")
    if not isinstance(iso_sha256_evidence, str) or not iso_sha256_evidence:
        out.append(GateResult("FAIL", "evidence missing iso_sha256"))
    elif iso_sha256_manifest in (None, TEMPLATE_SENTINEL_SHA256):
        out.append(
            GateResult(
                "BLOCKED",
                "manifest.sha256 not filled; cannot cross-check iso_sha256",
            )
        )
    elif iso_sha256_evidence != iso_sha256_manifest:
        out.append(
            GateResult(
                "FAIL",
                "iso_sha256 mismatch between manifest and evidence: "
                f"manifest={iso_sha256_manifest!r} evidence={iso_sha256_evidence!r}",
            )
        )

    transcript_value = payload.get("transcript")
    transcript_path_value = payload.get("transcript_path")
    transcript_text: str | None = None
    if isinstance(transcript_value, str):
        transcript_text = transcript_value
    elif isinstance(transcript_path_value, str) and transcript_path_value:
        transcript_path = _resolve_transcript_path(variant_dir, transcript_path_value)
        if not transcript_path.is_file():
            out.append(
                GateResult("FAIL", f"transcript file missing: {transcript_path}")
            )
        else:
            transcript_text = transcript_path.read_text(errors="replace")
    else:
        out.append(
            GateResult(
                "FAIL",
                "evidence carries neither transcript nor transcript_path",
            )
        )

    if transcript_text is not None:
        for marker in REQUIRED_TRANSCRIPT_MARKERS:
            if marker not in transcript_text:
                out.append(
                    GateResult(
                        "FAIL",
                        f"transcript missing required marker: {marker}",
                    )
                )

    if not out:
        out.append(GateResult("PASS", "qemu-virt evidence verified"))
    return out


def check_grub_efi_evidence(
    manifest: dict, is_template: bool, variant_dir: Path
) -> list[GateResult]:
    """Cross-check the GRUB EFI RISC-V evidence JSON against the transcript."""
    rows = _evidence_index(manifest)
    row = rows.get("grub-efi-riscv64-boot")
    if row is None:
        return [
            GateResult(
                "FAIL", "manifest.validation.evidence missing grub-efi-riscv64-boot row"
            )
        ]

    path_value = row.get("path")
    if not isinstance(path_value, str) or not path_value:
        if is_template:
            return [
                GateResult(
                    "BLOCKED",
                    "grub-efi-riscv64-boot.path not filled (template manifest)",
                )
            ]
        return [GateResult("BLOCKED", "grub-efi-riscv64-boot.path not filled")]

    evidence_path = _resolve_evidence_path(variant_dir, path_value)
    if not evidence_path.is_file():
        return [GateResult("BLOCKED", f"evidence file not present: {evidence_path}")]

    try:
        payload = _load_json(evidence_path)
    except json.JSONDecodeError as exc:
        return [GateResult("FAIL", f"evidence JSON invalid at {evidence_path}: {exc}")]
    if not isinstance(payload, dict):
        return [GateResult("FAIL", f"evidence JSON must be an object: {evidence_path}")]

    out: list[GateResult] = []
    if payload.get("boot_completed") is not True:
        out.append(
            GateResult(
                "FAIL",
                "GRUB EFI boot did not complete: "
                f"boot_completed={payload.get('boot_completed')!r}",
            )
        )

    iso_sha256_manifest = manifest.get("sha256")
    iso_sha256_evidence = payload.get("iso_sha256")
    if not isinstance(iso_sha256_evidence, str) or not iso_sha256_evidence:
        out.append(GateResult("FAIL", "GRUB evidence missing iso_sha256"))
    elif iso_sha256_manifest in (None, TEMPLATE_SENTINEL_SHA256):
        out.append(
            GateResult(
                "BLOCKED",
                "manifest.sha256 not filled; cannot cross-check GRUB iso_sha256",
            )
        )
    elif iso_sha256_evidence != iso_sha256_manifest:
        out.append(
            GateResult(
                "FAIL",
                "iso_sha256 mismatch between manifest and GRUB evidence: "
                f"manifest={iso_sha256_manifest!r} evidence={iso_sha256_evidence!r}",
            )
        )

    transcript_path_value = payload.get("transcript_path")
    if not isinstance(transcript_path_value, str) or not transcript_path_value:
        out.append(GateResult("FAIL", "GRUB evidence missing transcript_path"))
    else:
        transcript_path = _resolve_transcript_path(variant_dir, transcript_path_value)
        if not transcript_path.is_file():
            out.append(
                GateResult("FAIL", f"GRUB transcript file missing: {transcript_path}")
            )
        else:
            transcript_text = transcript_path.read_text(errors="replace")
            for marker in GRUB_TRANSCRIPT_MARKERS:
                if marker not in transcript_text:
                    out.append(
                        GateResult(
                            "FAIL",
                            f"GRUB transcript missing required marker: {marker}",
                        )
                    )

    if not out:
        out.append(GateResult("PASS", "GRUB EFI RISC-V evidence verified"))
    return out


def _resolve_runtime_artifacts_dir(variant_dir: Path, payload: dict) -> Path:
    artifacts_value = payload.get("artifacts")
    if isinstance(artifacts_value, str) and artifacts_value:
        artifacts = Path(artifacts_value)
        if artifacts.is_absolute():
            return artifacts
        return (variant_dir / artifacts).resolve()
    return variant_dir / "artifacts" / "riscv64"


def check_riscv64_agent_runtime_evidence(
    manifest: dict, is_template: bool, variant_dir: Path
) -> list[GateResult]:
    """Cross-check staged riscv64 Bun/agent runtime smoke and provenance."""
    rows = _evidence_index(manifest)
    row = rows.get("riscv64-agent-runtime")
    if row is None:
        return [
            GateResult(
                "FAIL",
                "manifest.validation.evidence missing row id=riscv64-agent-runtime",
            )
        ]

    path_value = row.get("path")
    if not isinstance(path_value, str) or not path_value:
        if is_template:
            return [
                GateResult(
                    "BLOCKED",
                    "riscv64-agent-runtime.path not filled (template manifest)",
                )
            ]
        return [GateResult("BLOCKED", "riscv64-agent-runtime.path not filled")]

    evidence_path = _resolve_evidence_path(variant_dir, path_value)
    if not evidence_path.is_file():
        return [
            GateResult(
                "BLOCKED", f"riscv64 agent runtime evidence file not present: {evidence_path}"
            )
        ]

    try:
        payload = _load_json(evidence_path)
    except json.JSONDecodeError as exc:
        return [GateResult("FAIL", f"runtime evidence JSON invalid at {evidence_path}: {exc}")]
    if not isinstance(payload, dict):
        return [GateResult("FAIL", f"runtime evidence JSON must be an object: {evidence_path}")]

    out: list[GateResult] = []
    if payload.get("schema") != RISCV64_AGENT_RUNTIME_SCHEMA:
        out.append(
            GateResult(
                "FAIL",
                "riscv64 agent runtime evidence schema mismatch: "
                f"{payload.get('schema')!r}",
            )
        )
    if payload.get("status") != "pass":
        out.append(
            GateResult(
                "FAIL",
                "riscv64 agent runtime smoke did not pass: "
                f"status={payload.get('status')!r}",
            )
        )
    failures = payload.get("failures")
    if failures not in ([], None):
        out.append(
            GateResult(
                "FAIL",
                "riscv64 agent runtime smoke recorded failures: "
                + ", ".join(str(item) for item in failures[:6])
                if isinstance(failures, list)
                else f"riscv64 agent runtime smoke failures must be an array: {failures!r}",
            )
        )

    transcript_value = payload.get("transcript")
    transcript_sha = payload.get("transcript_sha256")
    if not isinstance(transcript_sha, str) or not SHA256_RE.fullmatch(transcript_sha):
        out.append(GateResult("FAIL", "riscv64 agent runtime evidence missing transcript_sha256"))
    if isinstance(transcript_value, str) and transcript_value:
        transcript_path = _resolve_transcript_path(variant_dir, transcript_value)
        if not transcript_path.is_file():
            out.append(
                GateResult(
                    "BLOCKED",
                    f"riscv64 agent runtime transcript not present: {transcript_path}",
                )
            )
        elif isinstance(transcript_sha, str) and SHA256_RE.fullmatch(transcript_sha):
            actual = _sha256_file(transcript_path)
            if actual != transcript_sha:
                out.append(
                    GateResult(
                        "FAIL",
                        "riscv64 agent runtime transcript sha256 mismatch: "
                        f"evidence={transcript_sha!r} actual={actual!r}",
                    )
                )
    else:
        out.append(GateResult("FAIL", "riscv64 agent runtime evidence missing transcript"))

    artifacts_dir = _resolve_runtime_artifacts_dir(variant_dir, payload)
    runtime_mode = payload.get("runtime_mode", "bun")
    if runtime_mode not in ("bun", "node"):
        out.append(
            GateResult(
                "FAIL",
                f"riscv64 agent runtime evidence has invalid runtime_mode: {runtime_mode!r}",
            )
        )
    agent_bundle = artifacts_dir / "elizaos-app" / "agent-bundle.js"
    if runtime_mode == "node":
        if not agent_bundle.is_file():
            out.append(GateResult("BLOCKED", f"staged node agent bundle not present: {agent_bundle}"))
        else:
            first_line = agent_bundle.read_text(encoding="utf-8", errors="ignore").splitlines()[:1]
            if first_line not in (["#!/usr/bin/env node"], ["#!/usr/bin/node"]):
                out.append(
                    GateResult(
                        "FAIL",
                        f"staged node agent bundle missing node shebang: {agent_bundle}",
                    )
                )
        if (artifacts_dir / "bun").exists() or (artifacts_dir / "riscv64-bun-provenance.json").exists():
            out.append(
                GateResult(
                    "FAIL",
                    "node-mode riscv64 runtime evidence must not stage Bun artifacts",
                )
            )
    else:
        bun_path = artifacts_dir / "elizaos-app" / "musl-runtime" / "bun"
        provenance_path = artifacts_dir / "riscv64-bun-provenance.json"
        if not bun_path.is_file():
            out.append(GateResult("BLOCKED", f"staged riscv64 Bun not present: {bun_path}"))
        if not provenance_path.is_file():
            out.append(
                GateResult(
                    "FAIL",
                    f"staged riscv64 Bun provenance missing: {provenance_path}",
                )
            )
        else:
            try:
                provenance = _load_json(provenance_path)
            except json.JSONDecodeError as exc:
                out.append(
                    GateResult(
                        "FAIL",
                        f"riscv64 Bun provenance JSON invalid at {provenance_path}: {exc}",
                    )
                )
            else:
                if provenance.get("schema") != RISCV64_BUN_PROVENANCE_SCHEMA:
                    out.append(
                        GateResult(
                            "FAIL",
                            "riscv64 Bun provenance schema mismatch: "
                            f"{provenance.get('schema')!r}",
                        )
                    )
                inputs = provenance.get("inputs")
                if not isinstance(inputs, dict) or RISCV64_BUN_VERSION_INPUT not in inputs:
                    out.append(
                        GateResult(
                            "FAIL",
                            "riscv64 Bun provenance does not record current Bun version input",
                        )
                    )
                artifact = provenance.get("artifact")
                staged_sha = artifact.get("staged_bun_sha256") if isinstance(artifact, dict) else None
                if not isinstance(staged_sha, str) or not SHA256_RE.fullmatch(staged_sha):
                    out.append(
                        GateResult(
                            "FAIL",
                            "riscv64 Bun provenance missing staged_bun_sha256",
                        )
                    )
                elif bun_path.is_file():
                    actual = _sha256_file(bun_path)
                    if actual != staged_sha:
                        out.append(
                            GateResult(
                                "FAIL",
                                "riscv64 Bun provenance staged_bun_sha256 mismatch: "
                                f"provenance={staged_sha!r} actual={actual!r}",
                            )
                        )

    if not out:
        out.append(GateResult("PASS", "riscv64 agent runtime evidence verified"))
    return out


def check_iso_sha256_against_file(
    manifest: dict, is_template: bool, variant_dir: Path
) -> list[GateResult]:
    """If the ISO file is reachable, its sha256 must match the manifest."""
    if is_template:
        return [GateResult("BLOCKED", "iso sha256 not checked: template manifest")]
    sha256 = manifest.get("sha256")
    filename = manifest.get("filename")
    if not isinstance(sha256, str) or sha256 == TEMPLATE_SENTINEL_SHA256:
        return [GateResult("BLOCKED", "manifest.sha256 not filled")]
    if not isinstance(filename, str) or filename == TEMPLATE_SENTINEL_FILENAME:
        return [GateResult("BLOCKED", "manifest.filename not filled")]
    iso_path = variant_dir / "out" / filename
    if not iso_path.is_file():
        return [GateResult("BLOCKED", f"ISO file not present locally: {iso_path}")]
    actual = _sha256_file(iso_path)
    if actual != sha256:
        return [
            GateResult(
                "FAIL",
                f"iso sha256 mismatch: manifest={sha256!r} actual={actual!r} ({iso_path})",
            )
        ]
    return [GateResult("PASS", f"iso sha256 verified against {iso_path.name}")]


def aggregate(results: list[GateResult]) -> Status:
    """``FAIL`` dominates ``BLOCKED`` dominates ``PASS``."""
    if any(r.status == "FAIL" for r in results):
        return "FAIL"
    if any(r.status == "BLOCKED" for r in results):
        return "BLOCKED"
    return "PASS"


def run_checks(variant_dir: Path) -> tuple[Status, list[GateResult], Path, bool]:
    """Run every check and return the aggregate plus the per-check trail."""
    manifest_path, manifest, is_template = _select_manifest(variant_dir)
    schema = _load_schema()
    results: list[GateResult] = []
    results.extend(check_schema(manifest, schema))
    results.extend(check_required_evidence_rows(manifest))
    results.extend(check_evidence_rows_collected(manifest, is_template))
    results.extend(check_qemu_virt_evidence(manifest, is_template, variant_dir))
    results.extend(check_grub_efi_evidence(manifest, is_template, variant_dir))
    results.extend(check_riscv64_agent_runtime_evidence(manifest, is_template, variant_dir))
    results.extend(check_iso_sha256_against_file(manifest, is_template, variant_dir))
    return aggregate(results), results, manifest_path, is_template


def _emit(
    results: list[GateResult], aggregate_status: Status, manifest_path: Path
) -> None:
    print(f"release-manifest gate: {manifest_path}")
    for result in results:
        print(f"  [{result.status:<7}] {result.message}")
    print(f"STATUS: {aggregate_status}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Fail-closed release-manifest gate for the elizaOS Debian RISC-V 64 variant."
        )
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Treat BLOCKED as a release blocker (exit non-zero).",
    )
    parser.add_argument(
        "--variant-dir",
        type=Path,
        default=VARIANT_DIR,
        help="Override the variant directory (default: this script's parent dir).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        status, results, manifest_path, _is_template = run_checks(args.variant_dir)
    except FileNotFoundError as exc:
        # A missing manifest or schema is an unbuilt-release state, not a
        # regression: the artifact has not been produced yet.
        print("release-manifest gate: BLOCKED")
        print(f"  [BLOCKED] {exc}")
        print("STATUS: BLOCKED")
        return 1 if args.strict else 0
    except _MALFORMED_INPUT_ERRORS as exc:
        # A present-but-malformed manifest or schema is a release blocker: the
        # gate must fail closed with a clear evidence line, never crash with an
        # uncaught traceback (which the readiness aggregator would record as a
        # bare FAIL with no actionable evidence). ``jsonschema.SchemaError`` is
        # included because an invalid schema fragment is raised, not collected,
        # by ``Draft202012Validator``.
        print("release-manifest gate: FAIL")
        print(f"  [FAIL   ] manifest or schema is malformed: {exc}")
        print("STATUS: FAIL")
        return 1
    _emit(results, status, manifest_path)
    if status == "FAIL":
        return 1
    if status == "BLOCKED" and args.strict:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
