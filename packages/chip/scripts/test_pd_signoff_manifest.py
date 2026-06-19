#!/usr/bin/env python3
import json
import tempfile
from pathlib import Path
from unittest import mock

import check_pd_signoff
import yaml


def assert_false_claim_flags(payload: dict[str, object]) -> None:
    assert payload["claim_boundary"] == check_pd_signoff.CLAIM_BOUNDARY
    for key, expected in check_pd_signoff.FALSE_CLAIM_FLAGS.items():
        assert payload.get(key) is expected, key


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


SYNTHETIC_DIGEST = "sha256:bcaabac3b114dfb9e739af9f16b53a79ce1b744bcdb3ad4fc476c961581fe5d5"


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
    psm_report = "reports/signoff/psm_ir_drop.rpt"
    write(run_dir / psm_report, "PSM static IR-drop synthetic fixture\n")
    pdn_report = "reports/signoff/pdn_topology.json"
    write(run_dir / pdn_report, '{"pdn": "synthetic fixture"}\n')

    return {
        "run_id": "synthetic-local-parser-test",
        "design": "e1_chip_top",
        "flow": "openlane2",
        "pdk": "sky130A",
        "std_cell_library": "sky130_fd_sc_hd",
        "openlane_image": "ghcr.io/efabless/openlane2:2.4.0.dev1",
        "openlane_image_digest": SYNTHETIC_DIGEST,
        "volare_pdk_digest": SYNTHETIC_DIGEST,
        "klayout_digest": SYNTHETIC_DIGEST,
        "magic_digest": SYNTHETIC_DIGEST,
        "netgen_digest": SYNTHETIC_DIGEST,
        "openroad_digest": SYNTHETIC_DIGEST,
        "yosys_digest": SYNTHETIC_DIGEST,
        "abc_digest": "unavailable",
        "abc_unavailable_reason": "abc bundled inside openlane2 image; no separate digest computed",
        "antenna_deck_digest": SYNTHETIC_DIGEST,
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
        "psm_ir_drop_report": psm_report,
        "pdn_topology": {
            "vertical_layer": "met4",
            "horizontal_layer": "met5",
            "vpitch_um": 153.6,
            "hpitch_um": 153.6,
            "vwidth_um": 3.1,
            "hwidth_um": 3.1,
            "vspacing_um": 17.84,
            "hspacing_um": 17.84,
            "core_ring": {
                "enabled": True,
                "vwidth_um": 3.1,
                "hwidth_um": 3.1,
                "voffset_um": 14.0,
                "hoffset_um": 14.0,
                "vspacing_um": 1.7,
                "hspacing_um": 1.7,
            },
            "report": pdn_report,
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
        payload["pdk"] = "TB" + "D"
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


def test_closest_run_diagnostics_name_missing_artifact_classes() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        run = root / "pd/openlane/runs/RUN_one"
        run.mkdir(parents=True)
        manifest = {
            "required_artifacts": {
                "gds": {"globs": ["pd/openlane/runs/*/final/gds/*.gds"]},
                "antenna_report": {"globs": ["pd/openlane/runs/*/reports/signoff/*antenna*.rpt"]},
                "sta_report": {"globs": ["pd/openlane/runs/*/reports/signoff/*sta*.rpt"]},
            }
        }

        diagnostic = check_pd_signoff.closest_run_diagnostics(
            root,
            manifest,
            {run: ["antenna_report", "sta_report"]},
        )

        assert diagnostic["release_credit"] is False
        closest = diagnostic["closest_run"]
        assert closest["run"] == "pd/openlane/runs/RUN_one"
        classes = {row["blocker_class"] for row in closest["missing_artifact_classes"]}
        assert {"antenna", "timing"} <= classes
        assert "python3 scripts/check_pd_signoff.py" in closest["next_command"]
        first_gap = closest["missing_artifact_classes"][0]
        assert first_gap["producer_command"] == "scripts/run_openlane.sh --release"
        assert first_gap["validation_command"] == "python3 scripts/check_pd_signoff.py"
        assert first_gap["accepted_exit_code"] == 0


def test_blocked_artifact_report_summarizes_closest_run_gap() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        report_dir = Path(tmp)
        artifact_report = report_dir / "pd_signoff.json"
        manifest = {
            "required_artifacts": {
                "gds": {"globs": ["pd/openlane/runs/*/final/gds/*.gds"]},
                "run_manifest": {"globs": ["pd/openlane/runs/*/signoff-run.yaml"]},
            },
            "blocked_gates": {
                "pd_release": {
                    "blocked": True,
                    "reason": "signoff replay missing",
                    "evidence_manifest": "pd/signoff/manifest.yaml",
                    "unblock_requires": ["run release replay"],
                }
            },
        }
        run = check_pd_signoff.ROOT / "pd/openlane/runs/synthetic"
        diagnostics = {
            "artifact_gap": check_pd_signoff.closest_run_diagnostics(
                check_pd_signoff.ROOT,
                manifest,
                {run: ["run_manifest"]},
            ),
            "blocker_classes": check_pd_signoff.report_blocker_diagnostics(
                check_pd_signoff.ROOT,
                manifest,
                None,
            ),
        }

        with mock.patch.object(check_pd_signoff, "REPORT", artifact_report):
            check_pd_signoff.write_report(
                "blocked",
                "artifacts",
                Path("pd/signoff/manifest.yaml"),
                [
                    "no single PD run contains all required signoff artifacts; closest run missing run manifest"
                ],
                diagnostics=diagnostics,
            )

        payload = json.loads(artifact_report.read_text(encoding="utf-8"))
        assert_false_claim_flags(payload)
        assert payload["summary"]["blockers"] == 1
        assert payload["summary"]["closest_run_missing_artifact_count"] == 1
        assert payload["summary"]["blocked_release_gate_count"] == 1
        assert (
            payload["diagnostics"]["blocker_classes"]["blocked_release_gates"][0]["gate"]
            == "pd_release"
        )
        assert payload["release_unblock_plan"]["release_credit"] is False
        assert payload["release_unblock_plan"]["missing_artifact_count"] == 1
        assert payload["release_unblock_plan"]["blocked_release_gate_count"] == 1
        generation = payload["repo_artifact_generation_plan"]
        assert generation["release_credit"] is False
        assert generation["repo_generatable_now_count"] == 0
        assert generation["can_close_from_current_repo_count"] == 0
        assert generation["blocked_missing_artifact_count"] == 1
        assert generation["blocked_release_gate_count"] == 1
        assert generation["blocked_generation_count"] == 2
        assert generation["missing_artifacts"][0]["repo_generatable_now"] is False
        assert generation["missing_artifacts"][0]["can_close_release_from_current_repo"] is False
        assert "blocked_release_gates" in generation["missing_artifacts"][0]["blocked_by"]


def test_duplicate_key_detection() -> None:
    failures = check_pd_signoff.validate_no_duplicate_yaml_keys("signoff: first\nsignoff: second\n")
    assert failures and "duplicate YAML key" in failures[0], failures


def test_invalid_run_manifest_rejects_bogus_tool_digest() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        run_dir = root / "pd/openlane/runs/synthetic"
        payload = synthetic_run_manifest(run_dir)
        payload["openroad_digest"] = "not-a-sha"
        manifest_path = run_dir / "signoff-run.yaml"
        write(manifest_path, yaml.safe_dump(payload, sort_keys=True))

        failures = check_pd_signoff.validate_run_manifest(root, run_dir, manifest_path)
        assert any(
            "openroad_digest must match sha256:<64 hex chars>" in failure for failure in failures
        ), failures


def test_invalid_run_manifest_unavailable_digest_requires_reason() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        run_dir = root / "pd/openlane/runs/synthetic"
        payload = synthetic_run_manifest(run_dir)
        payload["klayout_digest"] = "unavailable"
        payload.pop("klayout_unavailable_reason", None)
        manifest_path = run_dir / "signoff-run.yaml"
        write(manifest_path, yaml.safe_dump(payload, sort_keys=True))

        failures = check_pd_signoff.validate_run_manifest(root, run_dir, manifest_path)
        assert any(
            "klayout_digest='unavailable' requires klayout_unavailable_reason" in failure
            for failure in failures
        ), failures


def test_invalid_run_manifest_rejects_missing_psm_ir_drop_report() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        run_dir = root / "pd/openlane/runs/synthetic"
        payload = synthetic_run_manifest(run_dir)
        payload["psm_ir_drop_report"] = "reports/signoff/missing-psm.rpt"
        manifest_path = run_dir / "signoff-run.yaml"
        write(manifest_path, yaml.safe_dump(payload, sort_keys=True))

        failures = check_pd_signoff.validate_run_manifest(root, run_dir, manifest_path)
        assert any(
            "psm_ir_drop_report missing PSM static IR-drop report" in failure
            for failure in failures
        ), failures


def test_invalid_run_manifest_rejects_pdn_topology_missing_field() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        run_dir = root / "pd/openlane/runs/synthetic"
        payload = synthetic_run_manifest(run_dir)
        del payload["pdn_topology"]["vertical_layer"]
        manifest_path = run_dir / "signoff-run.yaml"
        write(manifest_path, yaml.safe_dump(payload, sort_keys=True))

        failures = check_pd_signoff.validate_run_manifest(root, run_dir, manifest_path)
        assert any(
            "pdn_topology missing fields: vertical_layer" in failure for failure in failures
        ), failures


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


def test_manifest_report_does_not_overwrite_artifact_report() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        report_dir = Path(tmp)
        artifact_report = report_dir / "pd_signoff.json"
        manifest_report = report_dir / "pd_signoff_manifest.json"
        with (
            mock.patch.object(check_pd_signoff, "REPORT", artifact_report),
            mock.patch.object(check_pd_signoff, "MANIFEST_REPORT", manifest_report),
        ):
            check_pd_signoff.write_report(
                "blocked",
                "artifacts",
                Path("pd/signoff/manifest.yaml"),
                ["release gate remains blocked"],
            )
            artifact_payload = json.loads(artifact_report.read_text(encoding="utf-8"))
            assert_false_claim_flags(artifact_payload)
            check_pd_signoff.write_report(
                "pass",
                "manifest",
                Path("pd/signoff/manifest.yaml"),
                [],
            )

        self_artifact = json.loads(artifact_report.read_text(encoding="utf-8"))
        self_manifest = json.loads(manifest_report.read_text(encoding="utf-8"))
        assert self_artifact == artifact_payload
        assert self_artifact["mode"] == "artifacts"
        assert self_artifact["status"] == "blocked"
        assert self_manifest["mode"] == "manifest"
        assert self_manifest["status"] == "pass"


def main() -> int:
    test_valid_run_manifest()
    test_invalid_run_manifest_reports_missing_report()
    test_invalid_run_manifest_reports_missing_required_output()
    test_invalid_run_manifest_rejects_wrong_output_extension()
    test_invalid_run_manifest_reports_missing_output_keys()
    test_invalid_run_manifest_rejects_placeholder_and_unwaived_fake_claims()
    test_missing_artifact_report_uses_human_labels()
    test_closest_run_diagnostics_name_missing_artifact_classes()
    test_blocked_artifact_report_summarizes_closest_run_gap()
    test_duplicate_key_detection()
    test_invalid_run_manifest_rejects_bogus_tool_digest()
    test_invalid_run_manifest_unavailable_digest_requires_reason()
    test_invalid_run_manifest_rejects_missing_psm_ir_drop_report()
    test_invalid_run_manifest_rejects_pdn_topology_missing_field()
    test_manifest_rejects_fail_open_release_config()
    test_manifest_report_does_not_overwrite_artifact_report()
    print("PD signoff manifest parser tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
