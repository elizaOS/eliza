#!/usr/bin/env python3
import json
import tempfile
from pathlib import Path

import check_pd_signoff
import yaml


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def synthetic_run_manifest(run_dir: Path) -> dict:
    report_paths = {
        "drc": "reports/signoff/drc.rpt",
        "lvs": "reports/signoff/lvs.rpt",
        "antenna": "reports/signoff/antenna.rpt",
        "sta": "reports/signoff/sta.rpt",
        "utilization": "reports/signoff/utilization.rpt",
        "congestion": "reports/signoff/congestion.rpt",
        "density_fill": "reports/signoff/density_fill.rpt",
    }
    for report in report_paths.values():
        write(run_dir / report, "clean\n")
    output_paths = {
        "gds": "final/gds/e1_chip_top.gds",
        "def": "final/def/e1_chip_top.def",
        "gate_netlist": "final/verilog/gl/e1_chip_top.v",
        "corner_manifest": "reports/signoff/signoff-corners.yaml",
        "sdc": "final/sdc/e1_chip_top.sdc",
        "spef": "final/spef/e1_chip_top.spef",
        "sdf": "final/sdf/e1_chip_top.sdf",
        "tool_versions": "reports/signoff/tool_versions.txt",
    }
    for output in output_paths.values():
        write(run_dir / output, "synthetic parser fixture\n")

    return {
        "run_id": "synthetic-local-parser-test",
        "design": "e1_chip_top",
        "flow": "openlane2",
        "pdk": "sky130A",
        "std_cell_library": "sky130_fd_sc_hd",
        "openlane_image": "ghcr.io/efabless/openlane2:2.4.0.dev1",
        "openlane_image_digest": "sha256:bcaabac3b114dfb9e739af9f16b53a79ce1b744bcdb3ad4fc476c961581fe5d5",
        "started_at": "2026-05-17T00:00:00Z",
        "completed_at": "2026-05-17T00:01:00Z",
        "status": "complete",
        "corners": [
            {
                "name": "tt",
                "liberty": "pdk/sky130_fd_sc_hd__tt.lib",
                "rc": "nominal",
            }
        ],
        "inputs": {
            "config": "config.json",
            "sdc": "constraints/e1_soc.sdc",
        },
        "outputs": {
            **output_paths,
        },
        "checks": {
            name: {"status": "clean", "report": report} for name, report in report_paths.items()
        },
    }


def test_valid_run_manifest() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        run_dir = root / "pd/openlane/runs/synthetic"
        manifest_path = run_dir / "signoff-run.yaml"
        write(manifest_path, yaml.safe_dump(synthetic_run_manifest(run_dir), sort_keys=True))

        failures = check_pd_signoff.validate_run_manifest(root, run_dir, manifest_path)
        assert failures == [], failures


def test_invalid_run_manifest_reports_missing_report() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        run_dir = root / "pd/openlane/runs/synthetic"
        payload = synthetic_run_manifest(run_dir)
        payload["checks"]["drc"]["report"] = "reports/signoff/missing-drc.rpt"
        manifest_path = run_dir / "signoff-run.yaml"
        write(manifest_path, yaml.safe_dump(payload, sort_keys=True))

        failures = check_pd_signoff.validate_run_manifest(root, run_dir, manifest_path)
        assert any("checks.drc.report missing" in failure for failure in failures), failures


def test_invalid_run_manifest_reports_missing_required_output() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        run_dir = root / "pd/openlane/runs/synthetic"
        payload = synthetic_run_manifest(run_dir)
        (run_dir / payload["outputs"]["gds"]).unlink()
        manifest_path = run_dir / "signoff-run.yaml"
        write(manifest_path, yaml.safe_dump(payload, sort_keys=True))

        failures = check_pd_signoff.validate_run_manifest(root, run_dir, manifest_path)
        assert any("outputs.gds missing GDS layout" in failure for failure in failures), failures


def test_invalid_run_manifest_rejects_wrong_output_extension() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        run_dir = root / "pd/openlane/runs/synthetic"
        payload = synthetic_run_manifest(run_dir)
        payload["outputs"]["gds"] = "final/gds/e1_chip_top.txt"
        write(run_dir / payload["outputs"]["gds"], "not a gds\n")
        manifest_path = run_dir / "signoff-run.yaml"
        write(manifest_path, yaml.safe_dump(payload, sort_keys=True))

        failures = check_pd_signoff.validate_run_manifest(root, run_dir, manifest_path)
        assert any("outputs.gds must point to .gds" in failure for failure in failures), failures


def test_invalid_run_manifest_reports_missing_output_keys() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        run_dir = root / "pd/openlane/runs/synthetic"
        payload = synthetic_run_manifest(run_dir)
        del payload["outputs"]["spef"]
        del payload["outputs"]["sdf"]
        manifest_path = run_dir / "signoff-run.yaml"
        write(manifest_path, yaml.safe_dump(payload, sort_keys=True))

        failures = check_pd_signoff.validate_run_manifest(root, run_dir, manifest_path)
        assert any("SPEF parasitics (spef)" in failure for failure in failures), failures
        assert any("SDF backannotation (sdf)" in failure for failure in failures), failures


def test_invalid_run_manifest_rejects_placeholder_and_unwaived_fake_claims() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        run_dir = root / "pd/openlane/runs/synthetic"
        payload = synthetic_run_manifest(run_dir)
        payload["pdk"] = "TBD"
        payload["checks"]["lvs"] = {"status": "waived", "report": "reports/signoff/lvs.rpt"}
        manifest_path = run_dir / "signoff-run.yaml"
        write(manifest_path, yaml.safe_dump(payload, sort_keys=True))

        failures = check_pd_signoff.validate_run_manifest(root, run_dir, manifest_path)
        assert any("pdk must not be empty or placeholder" in failure for failure in failures), (
            failures
        )
        assert any("checks.lvs.waiver is required" in failure for failure in failures), failures


def test_missing_artifact_report_uses_human_labels() -> None:
    names = [
        "gds",
        "def",
        "drc_report",
        "lvs_report",
        "sta_report",
        "spef",
        "sdf",
        "corner_manifest",
        "tool_versions",
    ]
    message = check_pd_signoff.artifact_list(names)
    for expected in (
        "GDS layout (gds)",
        "DEF layout (def)",
        "DRC report (drc_report)",
        "LVS report (lvs_report)",
        "STA report (sta_report)",
        "SPEF parasitics (spef)",
        "SDF backannotation (sdf)",
        "corner manifest (corner_manifest)",
        "tool-version report (tool_versions)",
    ):
        assert expected in message, message


def test_duplicate_key_detection() -> None:
    failures = check_pd_signoff.validate_no_duplicate_yaml_keys("signoff: first\nsignoff: second\n")
    assert failures and "duplicate YAML key" in failures[0], failures


def test_manifest_rejects_fail_open_release_config() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        release_config = root / "pd/openlane/config.sky130.json"
        write(root / "pd/signoff/run-manifest.schema.json", "{}\n")
        write(
            release_config,
            json.dumps(
                {
                    "QUIT_ON_TIMING_VIOLATIONS": False,
                    "QUIT_ON_MAGIC_DRC": True,
                    "QUIT_ON_LVS_ERROR": True,
                    "QUIT_ON_SLEW_VIOLATIONS": True,
                }
            ),
        )

        failures = check_pd_signoff.validate_openlane_configs(
            root,
            {
                "openlane_configs": {
                    "release": ["pd/openlane/config.sky130.json"],
                    "exploratory": [],
                }
            },
        )
        assert any("must set fail-closed keys true" in failure for failure in failures), failures


def main() -> int:
    test_valid_run_manifest()
    test_invalid_run_manifest_reports_missing_report()
    test_invalid_run_manifest_reports_missing_required_output()
    test_invalid_run_manifest_rejects_wrong_output_extension()
    test_invalid_run_manifest_reports_missing_output_keys()
    test_invalid_run_manifest_rejects_placeholder_and_unwaived_fake_claims()
    test_missing_artifact_report_uses_human_labels()
    test_duplicate_key_detection()
    test_manifest_rejects_fail_open_release_config()
    print("PD signoff manifest parser tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
