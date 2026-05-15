#!/usr/bin/env python3
"""Append a new release entry to the voice-model version registry.

Inputs:

  --id              VoiceModelId — must be one of the values in
                    `packages/shared/src/local-inference/voice-models.ts`
                    (`speaker-encoder`, `diarizer`, `turn-detector`,
                    `voice-emotion`, `kokoro`, `omnivoice`, `vad`,
                    `wakeword`, `embedding`, `asr`).
  --version         Semver (e.g. `0.2.0`, `1.0.0-rc.3`).
  --parent-version  Predecessor version (omit for initial releases).
  --hf-repo         HuggingFace owner/repo holding the assets.
  --hf-revision     HF git revision (commit SHA or tag).
  --asset           Repeatable: `<filename>:<sha256>:<sizeBytes>:<quant>`
                    (one per published asset).
  --min-bundle      `eliza1Manifest.version` minimum compatibility.
  --net-improvement Optional flag string `true` / `false`; defaults to
                    `true` for initial releases (no parent) and is
                    required otherwise.
  --rtf-delta       Optional eval delta vs parent (negative = faster).
  --wer-delta       Optional eval delta (negative = lower WER).
  --eer-delta       Optional eval delta (speaker-encoder; negative = lower EER).
  --f1-delta        Optional eval delta (positive = better F1).
  --mos-delta       Optional eval delta (positive = better MOS).
  --false-bargein-delta  Optional eval delta (VAD; negative = better).
  --changelog-entry First line of the matching H3 block in
                    `models/voice/CHANGELOG.md` (also written to the
                    CHANGELOG when --append-changelog is set).
  --voice-models-ts Path to the registry module — defaults to
                    `packages/shared/src/local-inference/voice-models.ts`.
  --changelog-md    Path to the human-readable changelog — defaults to
                    `models/voice/CHANGELOG.md`.
  --append-changelog
                    Also append an H3 section to the CHANGELOG. The H3
                    is inserted directly under the H2 for the matching
                    id; reverse chronological per `models/voice/CHANGELOG.md`
                    convention.
  --dry-run         Print the planned changes; do not write to disk.

Idempotency: re-running with the same `--id` + `--version` returns
exit-code 0 without rewriting the file. Detection is exact-match on the
`{ id: "...", version: "..." }` literal; pre-release suffix differences
count as distinct versions.

The publish scripts (kokoro / omnivoice / etc.) should call this from
the final stage after `voice-preset.json` and `manifest-fragment.json`
are produced. The helper is intentionally separate from the publish
orchestrator so a reviewer can re-run it to backfill a missed entry
without re-running the entire publish.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("append_voice_model_version")

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_VOICE_MODELS_TS = (
    REPO_ROOT / "packages" / "shared" / "src" / "local-inference" / "voice-models.ts"
)
DEFAULT_CHANGELOG_MD = REPO_ROOT / "models" / "voice" / "CHANGELOG.md"

KNOWN_VOICE_MODEL_IDS = (
    "speaker-encoder",
    "diarizer",
    "turn-detector",
    "voice-emotion",
    "kokoro",
    "omnivoice",
    "vad",
    "wakeword",
    "embedding",
    "asr",
)

KNOWN_QUANTS = (
    "q4_0",
    "q4_k_m",
    "q5_k_m",
    "q6_k",
    "q8_0",
    "fp16",
    "onnx-fp16",
    "onnx-int8",
)

SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


@dataclass
class Asset:
    filename: str
    sha256: str
    size_bytes: int
    quant: str

    @classmethod
    def parse(cls, raw: str) -> "Asset":
        parts = raw.split(":")
        if len(parts) != 4:
            raise ValueError(
                f"--asset must be `<filename>:<sha256>:<sizeBytes>:<quant>`; got {raw!r}"
            )
        filename, sha, size, quant = parts
        if not SHA256_RE.match(sha):
            raise ValueError(f"asset sha256 must be 64 lowercase hex: {sha!r}")
        if not size.isdigit():
            raise ValueError(f"asset sizeBytes must be a positive integer: {size!r}")
        if quant not in KNOWN_QUANTS:
            raise ValueError(
                f"asset quant {quant!r} not in known set {KNOWN_QUANTS}"
            )
        if not filename:
            raise ValueError("asset filename must be non-empty")
        return cls(filename=filename, sha256=sha, size_bytes=int(size), quant=quant)


@dataclass
class VoiceVersion:
    id: str
    version: str
    parent_version: str | None
    published_at: str
    hf_repo: str
    hf_revision: str
    assets: list[Asset]
    eval_deltas: dict[str, object]
    changelog_entry: str
    min_bundle_version: str


def _format_asset_block(asset: Asset) -> str:
    return (
        "      {\n"
        f"        filename: {json.dumps(asset.filename)},\n"
        f"        sha256: {json.dumps(asset.sha256)},\n"
        f"        sizeBytes: {asset.size_bytes},\n"
        f"        quant: {json.dumps(asset.quant)},\n"
        "      },"
    )


def _format_eval_deltas(eval_deltas: dict[str, object]) -> str:
    # Preserve insertion order so the resulting file is stable on re-runs.
    keys = [
        "rtfDelta",
        "werDelta",
        "eerDelta",
        "f1Delta",
        "mosDelta",
        "falseBargeInDelta",
        "netImprovement",
    ]
    parts: list[str] = []
    for k in keys:
        if k in eval_deltas:
            v = eval_deltas[k]
            if isinstance(v, bool):
                parts.append(f"{k}: {'true' if v else 'false'}")
            elif isinstance(v, (int, float)):
                parts.append(f"{k}: {v}")
            else:
                parts.append(f"{k}: {json.dumps(v)}")
    return "{ " + ", ".join(parts) + " }"


def _format_version_block(v: VoiceVersion) -> str:
    assets_text = (
        "[]"
        if not v.assets
        else "[\n" + "\n".join(_format_asset_block(a) for a in v.assets) + "\n    ]"
    )
    parent_line = (
        f"    parentVersion: {json.dumps(v.parent_version)},\n"
        if v.parent_version is not None
        else ""
    )
    return (
        "  {\n"
        f"    id: {json.dumps(v.id)},\n"
        f"    version: {json.dumps(v.version)},\n"
        f"{parent_line}"
        f"    publishedToHfAt: {json.dumps(v.published_at)},\n"
        f"    hfRepo: {json.dumps(v.hf_repo)},\n"
        f"    hfRevision: {json.dumps(v.hf_revision)},\n"
        f"    ggufAssets: {assets_text},\n"
        f"    evalDeltas: {_format_eval_deltas(v.eval_deltas)},\n"
        f"    changelogEntry: {json.dumps(v.changelog_entry)},\n"
        f"    minBundleVersion: {json.dumps(v.min_bundle_version)},\n"
        "  },"
    )


def already_has_entry(ts_text: str, model_id: str, version: str) -> bool:
    """Return True when `{ id: "<model_id>", version: "<version>", ... }`
    already lives in `VOICE_MODEL_VERSIONS`. Match is structural and
    tolerant of intervening lines / nested blocks (ggufAssets is a list
    of inner `{}` objects, so we cannot rely on a flat `{...}` regex)."""
    needle_id = re.compile(rf'\bid:\s*"{re.escape(model_id)}"')
    needle_version = re.compile(rf'\bversion:\s*"{re.escape(version)}"')
    # Walk every `id: "<model_id>"` occurrence and look forward for the
    # matching `version: "<version>"` line within the same top-level
    # VoiceVersion record. A record always begins with `id: "..."` and ends
    # at the next sibling `},\n  {` (or at the closing `];` of the array).
    # Forward scan is bounded by the next top-level record terminator.
    record_terminator = re.compile(r"\},\s*\{", re.MULTILINE)
    end_of_array = re.compile(r"\}\s*,?\s*\];", re.MULTILINE)
    for m in needle_id.finditer(ts_text):
        scan_start = m.end()
        terminator = record_terminator.search(ts_text, scan_start)
        end = end_of_array.search(ts_text, scan_start)
        if end is None and terminator is None:
            continue
        if end is None:
            scan_end = terminator.start()
        elif terminator is None:
            scan_end = end.start()
        else:
            scan_end = min(terminator.start(), end.start())
        if needle_version.search(ts_text, scan_start, scan_end):
            return True
    return False


def insert_into_voice_models_ts(
    ts_text: str,
    new_block: str,
) -> str:
    """Insert the new block at the top of `VOICE_MODEL_VERSIONS`."""
    anchor = "export const VOICE_MODEL_VERSIONS: ReadonlyArray<VoiceModelVersion> = ["
    idx = ts_text.find(anchor)
    if idx == -1:
        raise RuntimeError(
            "VOICE_MODEL_VERSIONS anchor not found in voice-models.ts"
        )
    insert_at = idx + len(anchor)
    # Walk past trailing whitespace and one newline so we land immediately
    # before the first `{ id: …`.
    while insert_at < len(ts_text) and ts_text[insert_at] in (" ", "\t", "\n"):
        if ts_text[insert_at] == "\n":
            insert_at += 1
            break
        insert_at += 1
    return ts_text[:insert_at] + new_block + "\n" + ts_text[insert_at:]


def append_to_changelog(
    md_text: str,
    model_id: str,
    version: str,
    published_at: str,
    parent_version: str | None,
    hf_repo: str,
    hf_revision: str,
    changelog_entry: str,
    eval_deltas: dict[str, object],
) -> str:
    """Insert an H3 block under the matching H2 in `CHANGELOG.md`."""
    h2_re = re.compile(rf"(^##\s+{re.escape(model_id)}\s*$)", re.MULTILINE)
    m = h2_re.search(md_text)
    if m is None:
        raise RuntimeError(
            f"H2 for model id `{model_id}` not found in CHANGELOG.md; "
            "add the H2 manually before re-running with --append-changelog"
        )
    insert_at = m.end()
    # Match the per-id format from the existing CHANGELOG (see header).
    date = published_at[:10]
    parent_line = (
        f"- **Parent:** {parent_version}." if parent_version else "- **Parent:** none."
    )
    net = eval_deltas.get("netImprovement", True)
    deltas_lines: list[str] = []
    for k, label in (
        ("rtfDelta", "RTF"),
        ("werDelta", "WER"),
        ("eerDelta", "EER"),
        ("f1Delta", "F1"),
        ("mosDelta", "MOS"),
        ("falseBargeInDelta", "False barge-in"),
    ):
        if k in eval_deltas:
            deltas_lines.append(f"  - {label} Δ: {eval_deltas[k]}")
    deltas_block = (
        "- **Eval deltas:**\n" + "\n".join(deltas_lines)
        if deltas_lines
        else "- **Eval deltas:** (none recorded)"
    )
    block = (
        f"\n\n### {version} — {date}\n\n"
        f"- {changelog_entry}\n"
        f"{parent_line}\n"
        f"- **HF repo:** `{hf_repo}` @ rev `{hf_revision}`.\n"
        f"{deltas_block}\n"
        f"- **Net improvement:** {'yes' if net else 'no'}."
    )
    return md_text[:insert_at] + block + md_text[insert_at:]


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--id", required=True, choices=KNOWN_VOICE_MODEL_IDS)
    p.add_argument("--version", required=True)
    p.add_argument("--parent-version", default=None)
    p.add_argument("--hf-repo", required=True)
    p.add_argument("--hf-revision", required=True)
    p.add_argument("--asset", action="append", default=[])
    p.add_argument("--min-bundle", required=True)
    p.add_argument("--net-improvement", default=None)
    p.add_argument("--rtf-delta", type=float, default=None)
    p.add_argument("--wer-delta", type=float, default=None)
    p.add_argument("--eer-delta", type=float, default=None)
    p.add_argument("--f1-delta", type=float, default=None)
    p.add_argument("--mos-delta", type=float, default=None)
    p.add_argument("--false-bargein-delta", type=float, default=None)
    p.add_argument("--changelog-entry", required=True)
    p.add_argument("--voice-models-ts", type=Path, default=DEFAULT_VOICE_MODELS_TS)
    p.add_argument("--changelog-md", type=Path, default=DEFAULT_CHANGELOG_MD)
    p.add_argument("--append-changelog", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if not SEMVER_RE.match(args.version):
        log.error("--version must be valid semver (got %s)", args.version)
        return 2
    if args.parent_version is not None and not SEMVER_RE.match(args.parent_version):
        log.error(
            "--parent-version must be valid semver (got %s)", args.parent_version
        )
        return 2
    if not SEMVER_RE.match(args.min_bundle):
        log.error("--min-bundle must be valid semver (got %s)", args.min_bundle)
        return 2

    assets = [Asset.parse(raw) for raw in args.asset]
    if not assets:
        log.warning(
            "no --asset entries supplied; ggufAssets will be empty "
            "(placeholder for an unpublished release)"
        )

    # netImprovement gate.
    if args.net_improvement is not None:
        if args.net_improvement.lower() not in {"true", "false"}:
            log.error(
                "--net-improvement must be `true` or `false`; got %r",
                args.net_improvement,
            )
            return 2
        net_improvement = args.net_improvement.lower() == "true"
    else:
        if args.parent_version is None:
            net_improvement = True
        else:
            log.error(
                "--net-improvement is required when --parent-version is set "
                "(no implicit default for a successor release)"
            )
            return 2

    eval_deltas: dict[str, object] = {}
    if args.rtf_delta is not None:
        eval_deltas["rtfDelta"] = args.rtf_delta
    if args.wer_delta is not None:
        eval_deltas["werDelta"] = args.wer_delta
    if args.eer_delta is not None:
        eval_deltas["eerDelta"] = args.eer_delta
    if args.f1_delta is not None:
        eval_deltas["f1Delta"] = args.f1_delta
    if args.mos_delta is not None:
        eval_deltas["mosDelta"] = args.mos_delta
    if args.false_bargein_delta is not None:
        eval_deltas["falseBargeInDelta"] = args.false_bargein_delta
    eval_deltas["netImprovement"] = net_improvement

    new_version = VoiceVersion(
        id=args.id,
        version=args.version,
        parent_version=args.parent_version,
        published_at=datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        hf_repo=args.hf_repo,
        hf_revision=args.hf_revision,
        assets=assets,
        eval_deltas=eval_deltas,
        changelog_entry=args.changelog_entry,
        min_bundle_version=args.min_bundle,
    )

    ts_path = args.voice_models_ts.resolve()
    if not ts_path.exists():
        log.error("voice-models.ts not found at %s", ts_path)
        return 2
    ts_text = ts_path.read_text(encoding="utf-8")

    if already_has_entry(ts_text, args.id, args.version):
        log.info(
            "voice-models.ts already contains %s @ %s — no-op (idempotent)",
            args.id,
            args.version,
        )
        return 0

    new_block = _format_version_block(new_version)
    updated_ts = insert_into_voice_models_ts(ts_text, new_block)

    md_path = args.changelog_md.resolve()
    updated_md: str | None = None
    if args.append_changelog:
        if not md_path.exists():
            log.error(
                "--append-changelog requested but CHANGELOG.md not at %s", md_path
            )
            return 2
        md_text = md_path.read_text(encoding="utf-8")
        # Detect an existing H3 with the same `### <version> ` heading.
        if re.search(rf"^###\s+{re.escape(args.version)}\b", md_text, re.MULTILINE):
            log.info(
                "CHANGELOG.md already contains H3 for version %s — leaving file alone",
                args.version,
            )
        else:
            updated_md = append_to_changelog(
                md_text=md_text,
                model_id=args.id,
                version=args.version,
                published_at=new_version.published_at,
                parent_version=args.parent_version,
                hf_repo=args.hf_repo,
                hf_revision=args.hf_revision,
                changelog_entry=args.changelog_entry,
                eval_deltas=eval_deltas,
            )

    if args.dry_run:
        log.info("dry-run: would prepend new entry to %s", ts_path)
        sys.stdout.write(new_block + "\n")
        if updated_md is not None:
            log.info("dry-run: would update %s", md_path)
        return 0

    ts_path.write_text(updated_ts, encoding="utf-8")
    log.info("wrote %s — added %s @ %s", ts_path, args.id, args.version)
    if updated_md is not None:
        md_path.write_text(updated_md, encoding="utf-8")
        log.info("wrote %s — appended H3 for %s @ %s", md_path, args.id, args.version)
    return 0


if __name__ == "__main__":
    sys.exit(main())
