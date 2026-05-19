#!/usr/bin/env python3
import subprocess
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def manifest_for(run_root: str) -> dict:
    return {
        "run_roots": [run_root],
        "required_artifacts": {
            "gds": {"min_bytes": 4, "globs": [f"{run_root}/*/final/gds/*.gds"]},
            "drc_report": {
                "min_bytes": 4,
                "globs": [f"{run_root}/*/reports/signoff/*drc*.rpt"],
                "fail_regex": "(?i)fail|violations?\\s*[:=]\\s*[1-9]",
                "pass_regex": "(?i)violations?\\s*[:=]\\s*0|clean|pass",
            },
        },
    }


def run_archive(
    manifest: Path, run_dir: Path, archive_root: Path, report_root: Path
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "python3",
            "scripts/archive_pd_signoff_run.py",
            "--manifest",
            str(manifest.relative_to(ROOT)),
            "--run",
            str(run_dir.relative_to(ROOT)),
            "--archive-root",
            str(archive_root.relative_to(ROOT)),
            "--report-root",
            str(report_root.relative_to(ROOT)),
        ],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def test_archive_fails_closed_when_required_report_missing() -> None:
    with tempfile.TemporaryDirectory(dir=ROOT / "build") as tmp:
        root = Path(tmp)
        run_root = root / "runs"
        run_dir = run_root / "RUN_missing"
        manifest = root / "manifest.yaml"
        write(manifest, yaml.safe_dump(manifest_for(str(run_root.relative_to(ROOT)))))
        write(run_dir / "final/gds/e1.gds", "gds data\n")

        result = run_archive(manifest, run_dir, root / "archive", root / "reports")

        assert result.returncode == 1, result.stdout
        assert "drc_report: missing" in result.stdout, result.stdout
        report = root / "reports/RUN_missing-archive-report.yaml"
        assert report.is_file(), result.stdout
        payload = yaml.safe_load(report.read_text())
        assert payload["release_ready"] is False, payload


def test_archive_passes_when_required_artifacts_are_present_and_clean() -> None:
    with tempfile.TemporaryDirectory(dir=ROOT / "build") as tmp:
        root = Path(tmp)
        run_root = root / "runs"
        run_dir = run_root / "RUN_clean"
        manifest = root / "manifest.yaml"
        write(manifest, yaml.safe_dump(manifest_for(str(run_root.relative_to(ROOT)))))
        write(run_dir / "final/gds/e1.gds", "gds data\n")
        write(run_dir / "reports/signoff/drc.rpt", "violations: 0\nclean\n")

        result = run_archive(manifest, run_dir, root / "archive", root / "reports")

        assert result.returncode == 0, result.stdout
        assert "release-complete" in result.stdout, result.stdout
        archive_summary = root / "archive/RUN_clean/pd-signoff-archive.yaml"
        checksum_file = root / "archive/RUN_clean/SHA256SUMS"
        assert archive_summary.is_file(), result.stdout
        assert checksum_file.is_file(), result.stdout
        payload = yaml.safe_load(archive_summary.read_text())
        assert payload["release_ready"] is True, payload


def main() -> int:
    test_archive_fails_closed_when_required_report_missing()
    test_archive_passes_when_required_artifacts_are_present_and_clean()
    print("PD signoff archive tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
