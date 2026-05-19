#!/usr/bin/env python3
"""Archive and summarize a selected OpenLane PD signoff run.

This script is intentionally fail-closed: it always writes a report for triage,
but exits non-zero unless every manifest-required artifact class is present and
all report regex checks are clean.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "pd/signoff/manifest.yaml"
DEFAULT_ARCHIVE_ROOT = ROOT / "build/pd-signoff-archives"
DEFAULT_REPORT_ROOT = ROOT / "pd/signoff/reports"


FALLBACK_PATTERNS: dict[str, list[str]] = {
    "gds": [
        "56-magic-streamout/*.gds",
        "57-klayout-streamout/*.gds",
    ],
    "def": [
        "52-odb-cellfrequencytables/*.def",
        "51-openroad-fillinsertion/*.def",
        "43-openroad-detailedrouting/*.def",
    ],
    "gate_netlist": [
        "51-openroad-fillinsertion/*.nl.v",
        "51-openroad-fillinsertion/*.pnl.v",
        "43-openroad-detailedrouting/*.nl.v",
        "06-yosys-synthesis/*.nl.v",
    ],
    "sdc": [
        "51-openroad-fillinsertion/*.sdc",
        "54-openroad-stapostpnr/*.sdc",
        "34-openroad-cts/*.sdc",
    ],
    "spef": [
        "53-openroad-rcx/**/*.spef",
    ],
    "sdf": [
        "54-openroad-stapostpnr/**/*.sdf",
    ],
    "drc_report": [
        "62-magic-drc/reports/*.rpt",
        "63-klayout-drc/reports/*.json",
        "43-openroad-detailedrouting/*.drc",
    ],
    "lvs_report": [
        "68-netgen-lvs/reports/*.rpt",
        "68-netgen-lvs/reports/*.json",
    ],
    "antenna_report": [
        "45-openroad-checkantennas-1/reports/*antenna*.rpt",
        "41-openroad-repairantennas/2-openroad-checkantennas/reports/*antenna*.rpt",
        "39-openroad-checkantennas/reports/*antenna*.rpt",
        "38-openroad-globalrouting/antenna.rpt",
    ],
    "sta_report": [
        "54-openroad-stapostpnr/summary.rpt",
        "54-openroad-stapostpnr/**/*.rpt",
    ],
    "utilization_report": [
        "06-yosys-synthesis/reports/stat.rpt",
        "52-odb-cellfrequencytables/*.rpt",
    ],
    "congestion_report": [
        "38-openroad-globalrouting/or_metrics_out.json",
        "43-openroad-detailedrouting/or_metrics_out.json",
    ],
    "density_fill_report": [
        "51-openroad-fillinsertion/or_metrics_out.json",
        "74-misc-reportmanufacturability/*",
    ],
    "tool_versions": [
        "tool_versions.txt",
        "resolved.json",
        "flow.log",
    ],
    "corner_manifest": [
        "54-openroad-stapostpnr/state_out.json",
        "54-openroad-stapostpnr/summary.rpt",
    ],
    "run_manifest": [
        "signoff-run.yaml",
        "reports/signoff/signoff-run.yaml",
    ],
}


@dataclass
class ArtifactClass:
    name: str
    min_bytes: int
    manifest_globs: list[str]
    fail_regex: str | None = None
    pass_regex: str | None = None


@dataclass
class ArtifactResult:
    name: str
    status: str
    files: list[Path]
    archive_files: list[Path]
    missing_reason: str | None
    dirty_reports: list[Path]
    missing_clean_markers: list[Path]
    too_small: list[Path]
    source: str


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_manifest(path: Path) -> dict[str, Any]:
    payload = yaml.safe_load(path.read_text())
    if not isinstance(payload, dict):
        raise SystemExit(f"{rel(path)} must be a YAML mapping")
    return payload


def artifact_classes(manifest: dict[str, Any]) -> list[ArtifactClass]:
    required = manifest.get("required_artifacts")
    if not isinstance(required, dict):
        raise SystemExit("manifest must contain required_artifacts")

    classes: list[ArtifactClass] = []
    for name, spec in required.items():
        if not isinstance(spec, dict):
            continue
        globs = spec.get("globs", [])
        if not isinstance(globs, list):
            globs = []
        classes.append(
            ArtifactClass(
                name=str(name),
                min_bytes=int(spec.get("min_bytes", 1)),
                manifest_globs=[str(item) for item in globs],
                fail_regex=spec.get("fail_regex")
                if isinstance(spec.get("fail_regex"), str)
                else None,
                pass_regex=spec.get("pass_regex")
                if isinstance(spec.get("pass_regex"), str)
                else None,
            )
        )
    return classes


def run_dirs(manifest: dict[str, Any]) -> list[Path]:
    roots = manifest.get("run_roots", [])
    if not isinstance(roots, list):
        return []
    dirs: list[Path] = []
    for root in roots:
        base = ROOT / str(root)
        if base.is_dir():
            dirs.extend(sorted(path for path in base.iterdir() if path.is_dir()))
    return dirs


def select_run(manifest: dict[str, Any], requested: str | None) -> Path:
    if requested:
        run = (ROOT / requested).resolve()
        if not run.is_dir():
            raise SystemExit(f"selected run directory is missing: {requested}")
        return run

    candidates = run_dirs(manifest)
    if not candidates:
        raise SystemExit("no OpenLane run directories found under manifest run_roots")
    return max(candidates, key=lambda path: path.stat().st_mtime)


def files_for_manifest_globs(run_dir: Path, manifest_globs: list[str]) -> list[Path]:
    files: list[Path] = []
    for pattern in manifest_globs:
        parts = Path(pattern).parts
        if "*" not in parts:
            continue
        star_index = parts.index("*")
        prefix = Path(*parts[:star_index])
        try:
            run_dir.relative_to(ROOT / prefix)
        except ValueError:
            continue
        suffix = Path(*parts[star_index + 1 :])
        files.extend(path for path in run_dir.glob(str(suffix)) if path.is_file())
    return sorted(set(files))


def files_for_fallbacks(run_dir: Path, name: str) -> list[Path]:
    files: list[Path] = []
    for pattern in FALLBACK_PATTERNS.get(name, []):
        files.extend(path for path in run_dir.glob(pattern) if path.is_file())
    return sorted(set(files))


def report_regex_results(
    files: list[Path], fail_regex: str | None, pass_regex: str | None
) -> tuple[list[Path], list[Path]]:
    dirty: list[Path] = []
    missing_clean: list[Path] = []
    fail_pattern = re.compile(fail_regex) if fail_regex else None
    pass_pattern = re.compile(pass_regex) if pass_regex else None
    for path in files:
        text = path.read_text(errors="ignore")
        if fail_pattern and fail_pattern.search(text):
            dirty.append(path)
        if pass_pattern and not pass_pattern.search(text):
            missing_clean.append(path)
    return dirty, missing_clean


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_artifacts(run_dir: Path, archive_dir: Path, name: str, files: list[Path]) -> list[Path]:
    copied: list[Path] = []
    seen_destinations: set[Path] = set()
    for src in files:
        dest = archive_dir / "artifacts" / name / src.relative_to(run_dir)
        if dest in seen_destinations:
            continue
        seen_destinations.add(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        copied.append(dest)
    return copied


def summarize_run_metadata(run_dir: Path) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "run_dir": rel(run_dir),
        "run_id": run_dir.name,
        "flow_log": rel(run_dir / "flow.log") if (run_dir / "flow.log").is_file() else None,
        "resolved_json": rel(run_dir / "resolved.json")
        if (run_dir / "resolved.json").is_file()
        else None,
        "last_completed_step": None,
        "missing_state_out_steps": [],
    }
    step_dirs = sorted(
        (path for path in run_dir.iterdir() if path.is_dir() and re.match(r"^[0-9]+-", path.name)),
        key=lambda path: path.name,
    )
    completed = [path for path in step_dirs if (path / "state_out.json").is_file()]
    if completed:
        metadata["last_completed_step"] = completed[-1].name
    metadata["missing_state_out_steps"] = [
        path.name for path in step_dirs if not (path / "state_out.json").is_file()
    ]
    return metadata


def write_yaml(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")


def write_markdown(
    path: Path,
    run_dir: Path,
    archive_dir: Path,
    generated_at: str,
    results: list[ArtifactResult],
    metadata: dict[str, Any],
    release_ready: bool,
) -> None:
    lines = [
        "# PD Signoff Archive Report",
        "",
        "This report is generated evidence for a selected OpenLane run. It is not",
        "a release approval unless `release_ready` is `true` and the normal PD",
        "signoff checks also pass.",
        "",
        f"- Generated at: `{generated_at}`",
        f"- Run directory: `{rel(run_dir)}`",
        f"- Archive directory: `{rel(archive_dir)}`",
        f"- Last completed OpenLane step: `{metadata.get('last_completed_step')}`",
        f"- Release ready: `{'true' if release_ready else 'false'}`",
        "",
        "## Artifact Classes",
        "",
        "| Class | Status | Source | Files copied | Missing / dirty evidence |",
        "|---|---:|---|---:|---|",
    ]
    for result in results:
        problems: list[str] = []
        if result.missing_reason:
            problems.append(result.missing_reason)
        if result.too_small:
            problems.append("too small: " + ", ".join(rel(path) for path in result.too_small[:3]))
        if result.dirty_reports:
            problems.append(
                "failure regex: " + ", ".join(rel(path) for path in result.dirty_reports[:3])
            )
        if result.missing_clean_markers:
            problems.append(
                "missing clean marker: "
                + ", ".join(rel(path) for path in result.missing_clean_markers[:3])
            )
        problem_text = "<br>".join(problems) if problems else "-"
        lines.append(
            f"| `{result.name}` | `{result.status}` | `{result.source}` | "
            f"{len(result.archive_files)} | {problem_text} |"
        )

    missing_steps = metadata.get("missing_state_out_steps") or []
    lines.extend(["", "## Flow State", ""])
    if missing_steps:
        lines.append("Steps missing `state_out.json`:")
        lines.extend(f"- `{step}`" for step in missing_steps)
    else:
        lines.append("Every discovered numbered OpenLane step has `state_out.json`.")

    lines.extend(["", "## Copied Files", ""])
    for result in results:
        if not result.archive_files:
            continue
        lines.append(f"### {result.name}")
        for src, dest in zip(result.files, result.archive_files, strict=True):
            lines.append(f"- `{rel(src)}` -> `{rel(dest)}`")
        lines.append("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def write_checksums(archive_dir: Path) -> None:
    checksum_path = archive_dir / "SHA256SUMS"
    entries: list[str] = []
    for path in sorted(item for item in archive_dir.rglob("*") if item.is_file()):
        if path == checksum_path:
            continue
        entries.append(f"{sha256(path)}  {path.relative_to(archive_dir)}")
    checksum_path.write_text("\n".join(entries) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--run", help="selected OpenLane run directory; defaults to newest")
    parser.add_argument("--archive-root", default=str(DEFAULT_ARCHIVE_ROOT))
    parser.add_argument("--report-root", default=str(DEFAULT_REPORT_ROOT))
    parser.add_argument(
        "--allow-incomplete",
        action="store_true",
        help="return 0 after writing reports even when release artifacts are incomplete",
    )
    args = parser.parse_args()

    manifest_path = (ROOT / args.manifest).resolve()
    manifest = load_manifest(manifest_path)
    run_dir = select_run(manifest, args.run)
    generated_at = dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    archive_dir = (ROOT / args.archive_root / run_dir.name).resolve()
    if archive_dir.exists():
        shutil.rmtree(archive_dir)
    archive_dir.mkdir(parents=True)

    results: list[ArtifactResult] = []
    for spec in artifact_classes(manifest):
        files = files_for_manifest_globs(run_dir, spec.manifest_globs)
        source = "manifest"
        if not files:
            files = files_for_fallbacks(run_dir, spec.name)
            source = "fallback" if files else "missing"

        too_small = [path for path in files if path.stat().st_size < spec.min_bytes]
        dirty, missing_clean = report_regex_results(files, spec.fail_regex, spec.pass_regex)
        archive_files = copy_artifacts(run_dir, archive_dir, spec.name, files) if files else []
        status = "present"
        missing_reason = None
        if not files:
            status = "missing"
            missing_reason = "no matching manifest or fallback artifacts"
        elif too_small or dirty or missing_clean:
            status = "blocked"
        results.append(
            ArtifactResult(
                name=spec.name,
                status=status,
                files=files,
                archive_files=archive_files,
                missing_reason=missing_reason,
                dirty_reports=dirty,
                missing_clean_markers=missing_clean,
                too_small=too_small,
                source=source,
            )
        )

    metadata = summarize_run_metadata(run_dir)
    release_ready = all(result.status == "present" for result in results)
    summary = {
        "schema": "eliza.pd_signoff_archive_report.v1",
        "generated_at": generated_at,
        "release_ready": release_ready,
        "manifest": rel(manifest_path),
        "run": metadata,
        "archive_dir": rel(archive_dir),
        "artifacts": [
            {
                "name": result.name,
                "status": result.status,
                "source": result.source,
                "files": [rel(path) for path in result.files],
                "archive_files": [rel(path) for path in result.archive_files],
                "missing_reason": result.missing_reason,
                "too_small": [rel(path) for path in result.too_small],
                "dirty_reports": [rel(path) for path in result.dirty_reports],
                "missing_clean_markers": [rel(path) for path in result.missing_clean_markers],
            }
            for result in results
        ],
    }

    archive_summary = archive_dir / "pd-signoff-archive.yaml"
    write_yaml(archive_summary, summary)
    write_checksums(archive_dir)

    report_root = (ROOT / args.report_root).resolve()
    report_yaml = report_root / f"{run_dir.name}-archive-report.yaml"
    report_md = report_root / f"{run_dir.name}-archive-report.md"
    write_yaml(report_yaml, summary)
    write_markdown(report_md, run_dir, archive_dir, generated_at, results, metadata, release_ready)

    print(f"PD signoff archive: {rel(archive_dir)}")
    print(f"PD signoff report: {rel(report_md)}")
    print(f"PD signoff report data: {rel(report_yaml)}")
    if release_ready:
        print("PD signoff archive is release-complete by manifest artifact classes.")
        return 0

    print("PD signoff archive is incomplete:")
    for result in results:
        if result.status != "present":
            print(f"  - {result.name}: {result.status}")
    return 0 if args.allow_incomplete else 1


if __name__ == "__main__":
    sys.exit(main())
