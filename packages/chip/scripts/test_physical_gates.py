#!/usr/bin/env python3
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import openlane_pd_blocker_summary  # noqa: E402


def run_check(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


class PhysicalGateTests(unittest.TestCase):
    def test_openlane_pd_blocker_summary_resolves_container_work_root(self) -> None:
        self.assertEqual(
            openlane_pd_blocker_summary.repo_root_for(Path("/work")),
            Path("/work"),
        )

    def test_scaffold_gates_pass(self) -> None:
        commands = [
            ("scripts/check_package_cross_probe.py",),
            ("scripts/check_kicad_artifacts.py",),
            ("scripts/check_fpga_release.py",),
            ("scripts/check_manufacturing_artifacts.py",),
            ("scripts/check_pd_signoff.py", "--manifest-only"),
        ]
        for command in commands:
            with self.subTest(command=" ".join(command)):
                result = run_check(*command)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_openlane_preflight_scaffold_reports_blocked_without_run_evidence(self) -> None:
        result = run_check("scripts/check_openlane_run_preflight.py")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("STATUS: BLOCKED openlane_run_preflight", result.stdout)
        self.assertIn(
            "OpenLane configs are present; run/image evidence is still blocked.", result.stdout
        )

    def test_openlane_preflight_writes_mode_specific_reports(self) -> None:
        normal_report = ROOT / "build/reports/openlane_run_preflight.json"
        release_report = ROOT / "build/reports/openlane_run_release_preflight.json"
        normal_report.unlink(missing_ok=True)
        release_report.unlink(missing_ok=True)

        normal = run_check("scripts/check_openlane_run_preflight.py")
        release = run_check("scripts/check_openlane_run_preflight.py", "--release")

        self.assertEqual(normal.returncode, 0, normal.stdout + normal.stderr)
        self.assertNotEqual(release.returncode, 0, release.stdout + release.stderr)
        self.assertTrue(normal_report.is_file())
        self.assertTrue(release_report.is_file())
        normal_payload = json.loads(normal_report.read_text(encoding="utf-8"))
        release_payload = json.loads(release_report.read_text(encoding="utf-8"))
        self.assertFalse(normal_payload["summary"]["release_mode"])
        self.assertTrue(release_payload["summary"]["release_mode"])
        self.assertIn("blocker_category_counts", release_payload["summary"])
        self.assertIn("blocked_release_gates", release_payload["diagnostics"])
        self.assertFalse(
            any(
                gate.get("release_credit")
                for gate in release_payload["diagnostics"]["blocked_release_gates"]
            )
        )

    def test_openlane_preflight_custom_report_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            custom_report = Path(tmpdir) / "custom-openlane.json"
            result = run_check(
                "scripts/check_openlane_run_preflight.py",
                "--report",
                str(custom_report),
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(custom_report.is_file())
            payload = json.loads(custom_report.read_text(encoding="utf-8"))
            self.assertFalse(payload["summary"]["release_mode"])

    def test_openlane_pd_blocker_summary_extracts_dominant_blockers(self) -> None:
        report = openlane_pd_blocker_summary.build_report()

        self.assertEqual(report["schema"], "eliza.openlane_pd_blocker_summary.v1")
        self.assertFalse(report["summary"]["release_ready"])
        self.assertFalse(report["summary"]["release_credit"])
        finding_codes = {finding["code"] for finding in report["findings"]}
        if report["summary"].get("complete_run_found"):
            self.assertGreater(report["summary"]["magic__drc_error__count"], 0)
            self.assertIn("magic_drc_blocked", finding_codes)
        else:
            self.assertIn("openlane_no_complete_pd_run", finding_codes)

    def test_openlane_pd_blocker_summary_reports_signoff_artifact_handoff_gap(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_root = root / "runs"
            selected_run = run_root / "RUN_2099-01-01_00-00-00_current"
            selected_gds = selected_run / "final/gds/e1_chip_top.gds"
            selected_gds.parent.mkdir(parents=True)
            selected_gds.write_text("gds current\n", encoding="utf-8")
            (selected_run / "signoff-run.yaml").write_text(
                "design: e1_pd_smoke_top\nstatus: complete\n",
                encoding="utf-8",
            )

            closest_run = run_root / "RUN_2099-01-01_00-00-01_closest"
            closest_gds = closest_run / "final/gds/e1_chip_top.gds"
            closest_drc = closest_run / "reports/signoff/drc.rpt"
            closest_gds.parent.mkdir(parents=True)
            closest_drc.parent.mkdir(parents=True)
            closest_gds.write_text("gds closest\n", encoding="utf-8")
            closest_drc.write_text("DRC clean\n", encoding="utf-8")
            (closest_run / "signoff-run.yaml").write_text(
                "design: e1_chip_top\nstatus: complete\n",
                encoding="utf-8",
            )

            manifest = root / "manifest.yaml"
            manifest.write_text(
                yaml.safe_dump(
                    {
                        "run_roots": [run_root.as_posix()],
                        "blocked_gates": {
                            "pd_release": {
                                "blocked": True,
                                "reason": "not clean yet",
                            }
                        },
                        "required_artifacts": {
                            "run_manifest": {
                                "min_bytes": 4,
                                "globs": [f"{run_root.as_posix()}/*/signoff-run.yaml"],
                            },
                            "gds": {
                                "min_bytes": 4,
                                "globs": [f"{run_root.as_posix()}/*/final/gds/*.gds"],
                            },
                            "drc_report": {
                                "min_bytes": 4,
                                "globs": [f"{run_root.as_posix()}/*/reports/signoff/*drc*.rpt"],
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )

            summary = openlane_pd_blocker_summary.signoff_artifact_handoff_summary(
                selected_run,
                manifest,
            )

            self.assertFalse(summary["release_credit"])
            self.assertEqual(summary["selected_run"]["present"], ["gds"])
            self.assertCountEqual(
                summary["selected_run"]["missing"], ["run_manifest", "drc_report"]
            )
            self.assertEqual(summary["closest_artifact_run"]["missing_count"], 0)
            self.assertFalse(summary["closest_artifact_runs"][0]["release_credit"])
            self.assertIn(
                "drc_report",
                {row["artifact"] for row in summary["selected_run"]["missing_artifact_classes"]},
            )
            self.assertEqual(summary["blocked_release_gates"][0]["gate"], "pd_release")
            self.assertIn("single e1_chip_top release run", summary["primary_action"])

    def test_openlane_pd_blocker_summary_groups_magic_nwell4_targets(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            run_dir = Path(tmpdir) / "RUN_2099-01-01_00-00-00_complete"
            state = run_dir / "70-misc-reportmanufacturability/state_out.json"
            state.parent.mkdir(parents=True)
            state.write_text(
                json.dumps({"metrics": {"magic__drc_error__count": 4}}) + "\n",
                encoding="utf-8",
            )
            (state.parent / "manufacturability.rpt").write_text("blocked\n", encoding="utf-8")
            drc = run_dir / "58-magic-drc/reports/drc_violations.magic.rpt"
            drc.parent.mkdir(parents=True)
            drc.write_text(
                "\n".join(
                    [
                        "e1_npu_weight_buffer_array",
                        "----------------------------------------",
                        "All nwells must contain metal-connected N+ taps (nwell.4)",
                        "----------------------------------------",
                        "100.000um 10.000um 200.000um 12.000um",
                        "100.000um 20.000um 200.000um 22.000um",
                        "300.000um 10.000um 400.000um 12.000um",
                        "e1_other_macro",
                        "----------------------------------------",
                        "All nwells must contain metal-connected N+ taps (nwell.4)",
                        "----------------------------------------",
                        "500.000um 10.000um 550.000um 12.000um",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            report = openlane_pd_blocker_summary.build_report(
                run_dir=run_dir,
                process_table="",
            )

            magic = next(
                finding for finding in report["findings"] if finding["code"] == "magic_drc_blocked"
            )
            summary = magic["evidence"]["rule_summary"]
            self.assertEqual(summary["parsed_box_count"], 4)
            self.assertEqual(summary["top_rules"][0]["count"], 4)
            self.assertEqual(
                summary["top_modules"][0],
                {"module": "e1_npu_weight_buffer_array", "count": 3},
            )
            self.assertEqual(summary["nwell4_focus"]["box_count"], 4)
            self.assertEqual(
                summary["nwell4_focus"]["top_x_spans"][0],
                {"x_span": "100.000um..200.000um", "count": 2},
            )
            self.assertFalse(summary["nwell4_focus"]["release_credit"])
            self.assertIn("macro-level tap/rail", magic["next_step"])

    def test_openlane_pd_blocker_summary_groups_timing_electrical_targets(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            run_dir = Path(tmpdir) / "RUN_2099-01-01_00-00-00_complete"
            state = run_dir / "70-misc-reportmanufacturability/state_out.json"
            state.parent.mkdir(parents=True)
            state.write_text(
                json.dumps(
                    {
                        "metrics": {
                            "timing__setup__wns": -3.5,
                            "timing__setup_vio__count": 12,
                            "timing__hold__wns": -0.25,
                            "timing__hold_vio__count": 2,
                            "design__max_slew_violation__count": 40,
                            "design__max_cap_violation__count": 9,
                            "design__max_fanout_violation__count": 3,
                            "timing__setup__wns__corner:max_ss_100C_1v60": -3.5,
                            "timing__setup__tns__corner:max_ss_100C_1v60": -19.0,
                            "timing__setup_vio__count__corner:max_ss_100C_1v60": 12,
                            "timing__hold__wns__corner:max_ss_100C_1v60": -0.25,
                            "timing__hold__tns__corner:max_ss_100C_1v60": -0.5,
                            "timing__hold_vio__count__corner:max_ss_100C_1v60": 2,
                            "design__max_slew_violation__count__corner:max_ss_100C_1v60": 40,
                            "design__max_cap_violation__count__corner:max_ss_100C_1v60": 9,
                            "design__max_fanout_violation__count__corner:max_ss_100C_1v60": 3,
                            "timing__unannotated_net__count__corner:max_ss_100C_1v60": 7,
                            "timing__unannotated_net_filtered__count__corner:max_ss_100C_1v60": 0,
                        }
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            (state.parent / "manufacturability.rpt").write_text("blocked\n", encoding="utf-8")
            corner = run_dir / "55-openroad-stapostpnr/max_ss_100C_1v60"
            corner.mkdir(parents=True)
            (corner / "violator_list.rpt").write_text(
                "\n".join(
                    [
                        "[setup reg-out] u_bank6.u_sram/dout0[9] -> dout[9] : -3.863331",
                        "[setup reg-out] u_bank6.u_sram/dout0[5] -> dout[5] : -3.810433",
                        "[hold in-reg] rst_n -> _400_/RESET_B : -0.437096",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            wirelength = run_dir / "50-odb-reportwirelength/wire_lengths.csv"
            wirelength.parent.mkdir(parents=True)
            wirelength.write_text(
                "\n".join(
                    [
                        "net,length_um",
                        "clknet_1_0_0_clk,4.36651mm",
                        "net963,2949.69um",
                        "short_net,12.5um",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            report = openlane_pd_blocker_summary.build_report(
                run_dir=run_dir,
                process_table="",
            )

            self.assertFalse(report["blocker_matrix"]["release_credit"])
            self.assertTrue(report["blocker_matrix"]["classes"]["timing"]["blocked"])
            self.assertTrue(report["blocker_matrix"]["classes"]["drv"]["blocked"])
            timing = next(
                finding
                for finding in report["findings"]
                if finding["code"] == "timing_electrical_blocked"
            )
            evidence = timing["evidence"]
            self.assertFalse(evidence["release_credit"])
            self.assertEqual(evidence["dominant_corner"], "max_ss_100C_1v60")
            self.assertEqual(evidence["worst_setup_corner"]["setup_violations"], 12)
            self.assertEqual(
                evidence["top_violator_path_groups"][0],
                {
                    "group": "setup reg-out",
                    "count": 2,
                    "worst_slack": -3.863331,
                    "sample_start": "u_bank6.u_sram/dout0[9]",
                    "sample_end": "dout[9]",
                },
            )
            self.assertEqual(
                evidence["top_violator_endpoint_families"][0]["end_family"],
                "top_level_port",
            )
            wirelength_pressure = evidence["wirelength_pressure"]
            self.assertFalse(wirelength_pressure["release_credit"])
            self.assertEqual(wirelength_pressure["net_count"], 3)
            self.assertEqual(
                wirelength_pressure["top_long_nets"][0],
                {"net": "clknet_1_0_0_clk", "length_um": 4366.51},
            )
            self.assertEqual(
                wirelength_pressure["top_synthesized_numbered_nets"][0]["net"], "net963"
            )
            self.assertIn("SRAM macro output-to-top-port", timing["next_step"])

    def test_openlane_pd_blocker_summary_keeps_latest_incomplete_diagnostic(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            run_root = Path(tmpdir)
            complete_run = run_root / "RUN_2099-01-01_00-00-00_complete"
            state = complete_run / "50-misc-reportmanufacturability/state_out.json"
            state.parent.mkdir(parents=True)
            state.write_text(
                json.dumps(
                    {
                        "metrics": {
                            "magic__drc_error__count": 1,
                            "route__antenna_violation__count": 7,
                        }
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            (state.parent / "manufacturability.rpt").write_text("blocked\n", encoding="utf-8")

            latest_run = run_root / "RUN_2099-01-01_00-00-01_noheuristic"
            stage_dir = latest_run / "02-openroad-repairantennas/1-diodeinsertion"
            stage_dir.mkdir(parents=True)
            (latest_run / "01-odb-diodesonports").mkdir()
            (latest_run / "01-odb-diodesonports/state_out.json").write_text(
                "{}\n",
                encoding="utf-8",
            )
            (latest_run / "02-openroad-repairantennas/config.json").write_text(
                json.dumps(
                    {
                        "DIODE_ON_PORTS": "in",
                        "GRT_ANTENNA_ITERS": 40,
                        "GRT_ANTENNA_MARGIN": 80,
                        "RUN_HEURISTIC_DIODE_INSERTION": False,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            stage_dir.joinpath("diodeinsertion.log").write_text(
                "\n".join(
                    [
                        "Skipping step 'Heuristic Diode Insertion'",
                        "Design name: e1_chip_top",
                        "[INFO GRT-0006] Repairing antennas, iteration 21.",
                        "[INFO GRT-0012] Found 101 antenna violations.",
                        "[INFO GRT-0015] Inserted 498 diodes.",
                        "[INFO GRT-0009] rerouting 157 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 22.",
                        "[INFO GRT-0012] Found 104 antenna violations.",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            report = openlane_pd_blocker_summary.build_report(
                run_root=run_root,
                process_table="",
            )

            self.assertEqual(report["status"], "blocked")
            self.assertFalse(report["summary"]["latest_run_is_complete"])
            self.assertEqual(
                report["summary"]["latest_complete_run"],
                openlane_pd_blocker_summary.rel(complete_run),
            )
            diagnostic = report["latest_incomplete_pd_run_diagnostic"]
            self.assertEqual(diagnostic["status"], "blocked_incomplete_pd_run")
            antenna = diagnostic["findings"][0]["terminal_stage_diagnostic"][
                "antenna_repair_diagnostic"
            ]
            self.assertTrue(antenna["heuristic_diode_step_skipped"])
            self.assertEqual(antenna["best_remaining_antenna_violations"], 101)
            self.assertFalse(diagnostic["summary"]["release_credit"])

    def test_openlane_pd_blocker_summary_blocks_explicit_incomplete_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            run_dir = Path(tmpdir) / "RUN_2026-05-23_05-19-48"
            (run_dir / "58-odb-checkdesignantennaproperties").mkdir(parents=True)

            report = openlane_pd_blocker_summary.build_report(run_dir=run_dir)

            self.assertEqual(report["status"], "blocked_incomplete_pd_run")
            self.assertFalse(report["summary"]["release_ready"])
            self.assertFalse(report["summary"]["complete_run_found"])
            self.assertEqual(
                report["summary"]["latest_stage"],
                "58-odb-checkdesignantennaproperties",
            )
            self.assertIn(
                "openlane_incomplete_pd_run",
                {finding["code"] for finding in report["findings"]},
            )

    def test_openlane_pd_blocker_summary_surfaces_active_manual_magic_drc(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            run_dir = Path(tmpdir) / "RUN_2026-05-23_05-23-01"
            report_path = run_dir / "manual-magic-drc-gds/reports/drc_violations.magic.rpt"
            report_path.parent.mkdir(parents=True)
            report_path.write_text("", encoding="utf-8")
            process_table = (
                " 123 1 00:17:04 Rs magicdnull /tmp/manual_drc.tcl "
                f"/work/{openlane_pd_blocker_summary.rel(run_dir)} "
                "manual-magic-drc-gds\n"
            )

            report = openlane_pd_blocker_summary.build_report(
                run_dir=run_dir,
                process_table=process_table,
            )

            self.assertEqual(report["status"], "blocked_incomplete_pd_run")
            self.assertEqual(report["summary"]["manual_magic_drc_status"], "active")
            finding = report["findings"][0]
            manual = finding["manual_magic_drc"]
            self.assertFalse(manual["release_credit"])
            self.assertFalse(manual["signoff_credit"])
            self.assertFalse(manual["diagnostic_complete"])
            self.assertEqual(manual["reports"][0]["bytes"], 0)
            self.assertIsNone(manual["reports"][0]["parsed_drc_box_count"])
            self.assertEqual(manual["active_processes"][0]["pid"], "123")

    def test_openlane_pd_blocker_summary_parses_finished_manual_magic_drc(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            run_dir = Path(tmpdir) / "RUN_2026-05-23_05-23-01"
            report_path = run_dir / "manual-magic-drc-gds/reports/drc_violations.magic.rpt"
            report_path.parent.mkdir(parents=True)
            report_path.write_text(
                "\n".join(
                    [
                        "e1_npu_weight_buffer_array",
                        "All nwells must contain metal-connected N+ taps (nwell.4)",
                        "1.000um 2.000um 3.000um 4.000um",
                        "5.000um 6.000um 7.000um 8.000um",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            report = openlane_pd_blocker_summary.build_report(
                run_dir=run_dir,
                process_table="",
            )

            manual = report["findings"][0]["manual_magic_drc"]
            self.assertEqual(manual["status"], "finished_with_report")
            self.assertTrue(manual["diagnostic_complete"])
            self.assertEqual(manual["reports"][0]["parsed_drc_box_count"], 2)
            self.assertFalse(manual["signoff_credit"])

    def test_openlane_pd_blocker_summary_flags_finished_empty_manual_magic_drc(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            run_dir = Path(tmpdir) / "RUN_2026-05-23_05-23-01"
            report_path = run_dir / "manual-magic-drc-gds/reports/drc_violations.magic.rpt"
            report_path.parent.mkdir(parents=True)
            report_path.write_text("", encoding="utf-8")

            report = openlane_pd_blocker_summary.build_report(
                run_dir=run_dir,
                process_table="",
            )

            manual = report["findings"][0]["manual_magic_drc"]
            self.assertEqual(manual["status"], "finished_empty_report")
            self.assertFalse(manual["diagnostic_complete"])
            self.assertFalse(manual["release_credit"])
            self.assertFalse(manual["signoff_credit"])
            self.assertIn("empty report", manual["next_pd_action"])

    def test_openlane_pd_blocker_summary_accepts_repo_relative_run_paths(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT) as tmpdir:
            run_dir = Path(tmpdir) / "RUN_2026-05-23_05-23-01"
            stage_dir = run_dir / "58-magic-writelef"
            stage_dir.mkdir(parents=True)
            (stage_dir / "config.json").write_text(
                json.dumps(
                    {
                        "MAGICRC": (
                            "/work/external/pdks/volare/sky130/versions/"
                            "0fe599b2afb6708d281543108caf8310912f54af/"
                            "sky130A/libs.tech/magic/sky130A.magicrc"
                        ),
                        "MACROS": {
                            "sky130_sram_2kbyte_1rw1r_32x512_8": {
                                "gds": [
                                    "/work/external/pdks/volare/sky130/versions/"
                                    "c6d73a35f524070e85faff4a6a9eef49553ebc2b/"
                                    "sky130A/libs.ref/sky130_sram_macros/gds/"
                                    "sky130_sram_2kbyte_1rw1r_32x512_8.gds"
                                ],
                                "lef": [
                                    "/work/external/pdks/volare/sky130/versions/"
                                    "0fe599b2afb6708d281543108caf8310912f54af/"
                                    "sky130A/libs.ref/sky130_sram_macros/lef/"
                                    "sky130_sram_2kbyte_1rw1r_32x512_8.lef"
                                ],
                            }
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            (stage_dir / "magic-writelef.log").write_text(
                'Error while reading cell "sram_cell": Unknown layer/datatype in boundary, layer=33 type=42\n',
                encoding="utf-8",
            )
            (stage_dir / "e1_npu_weight_buffer_array.lef").write_text(
                "VERSION 5.8 ;\n",
                encoding="utf-8",
            )
            (run_dir / "57-klayout-streamout").mkdir()
            (run_dir / "57-klayout-streamout/state_out.json").write_text(
                "{}\n",
                encoding="utf-8",
            )
            report_path = run_dir / "manual-magic-drc-gds/reports/drc_violations.magic.rpt"
            report_path.parent.mkdir(parents=True)
            report_path.write_text("", encoding="utf-8")

            package_relative = run_dir.relative_to(ROOT.parents[1])
            report = openlane_pd_blocker_summary.build_report(
                run_dir=package_relative,
                process_table="",
            )

            self.assertEqual(report["status"], "blocked_incomplete_pd_run")
            self.assertEqual(report["summary"]["latest_stage"], "58-magic-writelef")
            self.assertEqual(report["summary"]["last_completed_stage"], "57-klayout-streamout")
            self.assertEqual(report["summary"]["manual_magic_drc_status"], "finished_empty_report")
            diagnostic = report["findings"][0]["terminal_stage_diagnostic"]
            self.assertFalse(diagnostic["state_out_present"])
            self.assertEqual(diagnostic["unknown_layer_datatypes"]["count"], 1)
            self.assertEqual(
                diagnostic["unknown_layer_datatypes"]["layer_datatypes"][0]["layer_datatype"],
                "33/42",
            )
            self.assertEqual(
                diagnostic["pdk_snapshot_diagnostic"]["status"],
                "mixed_macro_gds_pdk_snapshot",
            )
            self.assertIn("snapshot", diagnostic["root_cause_hypothesis"])
            self.assertEqual(diagnostic["produced_outputs"][0]["bytes"], 14)

    def test_openlane_pd_blocker_summary_parses_antenna_repair_plateau(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            run_dir = Path(tmpdir) / "RUN_2099-01-01_00-00-00"
            stage_dir = run_dir / "43-openroad-repairantennas/1-diodeinsertion"
            stage_dir.mkdir(parents=True)
            (run_dir / "43-openroad-repairantennas/config.json").write_text(
                json.dumps(
                    {
                        "DIODE_ON_PORTS": "none",
                        "GRT_ANTENNA_ITERS": 40,
                        "GRT_ANTENNA_MARGIN": 80,
                        "RUN_HEURISTIC_DIODE_INSERTION": True,
                        "RUN_ANTENNA_REPAIR": True,
                        "RT_MAX_LAYER": "met5",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            (run_dir / "42-odb-heuristicdiodeinsertion").mkdir()
            (run_dir / "42-odb-heuristicdiodeinsertion/state_out.json").write_text(
                "{}\n",
                encoding="utf-8",
            )
            stage_dir.joinpath("diodeinsertion.log").write_text(
                "\n".join(
                    [
                        "[INFO] 'DIODE_ON_PORTS' is set to 'none': skipping...",
                        "[INFO GRT-0006] Repairing antennas, iteration 24.",
                        "[INFO GRT-0012] Found 111 antenna violations.",
                        "[INFO GRT-0015] Inserted 747 diodes.",
                        "[INFO GRT-0009] rerouting 274 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 25.",
                        "[INFO GRT-0012] Found 107 antenna violations.",
                        "[INFO GRT-0015] Inserted 697 diodes.",
                        "[INFO GRT-0009] rerouting 252 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 26.",
                        "[INFO GRT-0012] Found 108 antenna violations.",
                        "[INFO GRT-0015] Inserted 786 diodes.",
                        "[INFO GRT-0009] rerouting 264 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 27.",
                        "[INFO GRT-0012] Found 107 antenna violations.",
                        "[INFO GRT-0015] Inserted 738 diodes.",
                        "[INFO GRT-0009] rerouting 238 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 28.",
                        "[INFO GRT-0012] Found 106 antenna violations.",
                        "[INFO GRT-0015] Inserted 772 diodes.",
                        "[INFO GRT-0009] rerouting 287 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 29.",
                        "[INFO GRT-0012] Found 107 antenna violations.",
                        "[INFO GRT-0015] Inserted 879 diodes.",
                        "[INFO GRT-0009] rerouting 322 nets.",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            report = openlane_pd_blocker_summary.build_report(
                run_dir=run_dir,
                process_table="",
            )

            diagnostic = report["findings"][0]["terminal_stage_diagnostic"]
            antenna = diagnostic["antenna_repair_diagnostic"]
            self.assertEqual(antenna["status"], "antenna_repair_plateau")
            self.assertEqual(antenna["best_remaining_antenna_violations"], 106)
            self.assertEqual(antenna["last_remaining_antenna_violations"], 107)
            self.assertEqual(antenna["iteration_count"], 6)
            self.assertEqual(antenna["config_values"]["DIODE_ON_PORTS"], "none")
            self.assertTrue(antenna["port_diode_step_skipped"])
            self.assertIn("DIODE_ON_PORTS: in", antenna["next_pd_action"])
            self.assertFalse(report["summary"]["release_ready"])
            self.assertIn("antenna", diagnostic["root_cause_hypothesis"])

    def test_openlane_pd_blocker_summary_records_port_diode_rerun(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            run_dir = Path(tmpdir) / "RUN_2099-01-01_00-00-01_diodein_segment"
            (run_dir / "02-odb-heuristicdiodeinsertion").mkdir(parents=True)
            (run_dir / "02-odb-heuristicdiodeinsertion/state_out.json").write_text(
                "{}\n",
                encoding="utf-8",
            )
            diode_config = run_dir / "01-odb-diodesonports/config.json"
            diode_config.parent.mkdir(parents=True)
            diode_config.write_text(
                json.dumps(
                    {
                        "DIODE_ON_PORTS": "in",
                        "GRT_ANTENNA_ITERS": 40,
                        "GRT_ANTENNA_MARGIN": 80,
                        "RT_MAX_LAYER": "met5",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            stage_dir = run_dir / "03-openroad-repairantennas/1-diodeinsertion"
            stage_dir.mkdir(parents=True)
            (run_dir / "03-openroad-repairantennas/state_in.json").write_text(
                json.dumps(
                    {
                        "metrics": {
                            "antenna__violating__nets": 80,
                            "antenna__violating__pins": 86,
                            "route__antenna_violation__count": 3223,
                            "design__instance__count__class:antenna_cell": 119063,
                        }
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            (run_dir / "03-openroad-repairantennas/config.json").write_text(
                json.dumps(
                    {
                        "GRT_ANTENNA_ITERS": 40,
                        "GRT_ANTENNA_MARGIN": 80,
                        "RT_MAX_LAYER": "met5",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            stage_dir.joinpath("diodeinsertion.log").write_text(
                "\n".join(
                    [
                        "[08:19:00] VERBOSE Running 'Odb.PortDiodePlacement'",
                        "Design name: unit_margin30_top",
                        "Inserted 13 diodes.",
                        "[INFO GRT-0006] Repairing antennas, iteration 20.",
                        "[INFO GRT-0012] Found 113 antenna violations.",
                        "[INFO GRT-0015] Inserted 624 diodes.",
                        "[INFO GRT-0009] rerouting 205 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 21.",
                        "[INFO GRT-0012] Found 113 antenna violations.",
                        "[INFO GRT-0015] Inserted 620 diodes.",
                        "[INFO GRT-0009] rerouting 228 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 22.",
                        "[INFO GRT-0012] Found 114 antenna violations.",
                        "[INFO GRT-0015] Inserted 670 diodes.",
                        "[INFO GRT-0009] rerouting 233 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 23.",
                        "[INFO GRT-0012] Found 112 antenna violations.",
                        "[INFO GRT-0015] Inserted 672 diodes.",
                        "[INFO GRT-0009] rerouting 227 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 24.",
                        "[INFO GRT-0012] Found 113 antenna violations.",
                        "[INFO GRT-0015] Inserted 688 diodes.",
                        "[INFO GRT-0009] rerouting 231 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 25.",
                        "[INFO GRT-0012] Found 112 antenna violations.",
                        "[INFO GRT-0015] Inserted 700 diodes.",
                        "[INFO GRT-0009] rerouting 229 nets.",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            report = openlane_pd_blocker_summary.build_report(
                run_dir=run_dir,
                process_table="",
            )

            antenna = report["findings"][0]["terminal_stage_diagnostic"][
                "antenna_repair_diagnostic"
            ]
            self.assertEqual(antenna["status"], "antenna_repair_plateau")
            self.assertEqual(antenna["config_values"]["DIODE_ON_PORTS"], "in")
            self.assertFalse(antenna["port_diode_step_skipped"])
            self.assertEqual(antenna["port_diodes_inserted"], 13)
            self.assertFalse(antenna["heuristic_diode_step_skipped"])
            self.assertEqual(antenna["heuristic_diodes_inserted"], None)
            self.assertEqual(antenna["pre_repair_state_metrics"]["antenna__violating__nets"], 80)
            self.assertEqual(
                antenna["pre_repair_state_metrics"]["design__instance__count__class:antenna_cell"],
                119063,
            )
            self.assertIn(
                "Input-port diode protection has now been exercised", antenna["next_pd_action"]
            )

    def test_openlane_pd_blocker_summary_parses_heuristic_diode_bloat(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            log = Path(tmpdir) / "openlane-release-test.log"
            log.write_text(
                "\n".join(
                    [
                        "[08:19:00] VERBOSE Running 'Odb.PortDiodePlacement'",
                        "Design name: e1_chip_top",
                        "Inserted 13 diodes.",
                        "Using threshold 90µm…",
                        "Inserted 81454 diodes.",
                        "[INFO GRT-0006] Repairing antennas, iteration 1.",
                        "[INFO GRT-0012] Found 1662 antenna violations.",
                        "[INFO GRT-0015] Inserted 4361 diodes.",
                        "[INFO GRT-0009] rerouting 27419 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 2.",
                        "[INFO GRT-0012] Found 640 antenna violations.",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            summary = openlane_pd_blocker_summary.antenna_repair_log_summary(log)

            self.assertEqual(summary["port_diodes_inserted"], 13)
            self.assertEqual(summary["design_name"], "e1_chip_top")
            self.assertFalse(summary["heuristic_diode_step_skipped"])
            self.assertEqual(summary["heuristic_diodes_inserted"], 81454)
            self.assertEqual(summary["best_remaining_antenna_violations"], 640)
            self.assertEqual(summary["last_remaining_antenna_violations"], 640)
            self.assertEqual(summary["total_inserted_diodes_logged"], 4361)

    def test_openlane_pd_blocker_summary_records_skipped_heuristic_diode_step(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            run_dir = Path(tmpdir) / "RUN_2099-01-01_00-00-01_diodein_noheuristic_segment"
            diode_config = run_dir / "01-odb-diodesonports/config.json"
            diode_config.parent.mkdir(parents=True)
            diode_config.write_text(
                json.dumps(
                    {
                        "DIODE_ON_PORTS": "in",
                        "GRT_ANTENNA_ITERS": 40,
                        "GRT_ANTENNA_MARGIN": 80,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            stage_dir = run_dir / "02-openroad-repairantennas/1-diodeinsertion"
            stage_dir.mkdir(parents=True)
            (run_dir / "02-openroad-repairantennas/config.json").write_text(
                json.dumps(
                    {
                        "GRT_ANTENNA_ITERS": 40,
                        "GRT_ANTENNA_MARGIN": 80,
                        "RT_MAX_LAYER": "met5",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            stage_dir.joinpath("diodeinsertion.log").write_text(
                "\n".join(
                    [
                        "Gating variable for step 'Odb.HeuristicDiodeInsertion' set to 'False'- the step will be skipped.",
                        "Skipping step 'Heuristic Diode Insertion'",
                        "[09:17:26] VERBOSE Running 'Odb.PortDiodePlacement'",
                        "Design name: unit_margin30_top",
                        "Inserted 13 diodes.",
                        "[INFO GRT-0006] Repairing antennas, iteration 21.",
                        "[INFO GRT-0012] Found 101 antenna violations.",
                        "[INFO GRT-0015] Inserted 498 diodes.",
                        "[INFO GRT-0009] rerouting 157 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 22.",
                        "[INFO GRT-0012] Found 102 antenna violations.",
                        "[INFO GRT-0015] Inserted 557 diodes.",
                        "[INFO GRT-0009] rerouting 169 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 23.",
                        "[INFO GRT-0012] Found 103 antenna violations.",
                        "[INFO GRT-0015] Inserted 547 diodes.",
                        "[INFO GRT-0009] rerouting 184 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 24.",
                        "[INFO GRT-0012] Found 103 antenna violations.",
                        "[INFO GRT-0015] Inserted 524 diodes.",
                        "[INFO GRT-0009] rerouting 162 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 25.",
                        "[INFO GRT-0012] Found 101 antenna violations.",
                        "[INFO GRT-0015] Inserted 593 diodes.",
                        "[INFO GRT-0009] rerouting 172 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 26.",
                        "[INFO GRT-0012] Found 104 antenna violations.",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            report = openlane_pd_blocker_summary.build_report(
                run_dir=run_dir,
                process_table="",
            )

            antenna = report["findings"][0]["terminal_stage_diagnostic"][
                "antenna_repair_diagnostic"
            ]
            self.assertTrue(antenna["heuristic_diode_step_skipped"])
            self.assertIsNone(antenna["heuristic_diodes_inserted"])
            self.assertEqual(antenna["config_values"]["RUN_HEURISTIC_DIODE_INSERTION"], False)
            self.assertIn(
                "Input-port diode protection has now been exercised", antenna["next_pd_action"]
            )

    def test_openlane_pd_blocker_summary_records_completed_margin40_segment(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            run_dir = Path(tmpdir) / "RUN_2099-01-01_00-00-02_diodein_noheuristic_margin40_segment"
            diode_config = run_dir / "01-odb-diodesonports/config.json"
            diode_config.parent.mkdir(parents=True)
            diode_config.write_text(
                json.dumps(
                    {
                        "DIODE_ON_PORTS": "in",
                        "GRT_ANTENNA_ITERS": 40,
                        "GRT_ANTENNA_MARGIN": 40,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            repair_dir = run_dir / "02-openroad-repairantennas"
            stage_dir = repair_dir / "1-diodeinsertion"
            stage_dir.mkdir(parents=True)
            repair_dir.joinpath("config.json").write_text(
                json.dumps(
                    {
                        "GRT_ANTENNA_ITERS": 40,
                        "GRT_ANTENNA_MARGIN": 40,
                        "RT_MAX_LAYER": "met5",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            repair_dir.joinpath("state_out.json").write_text("{}\n", encoding="utf-8")
            stage_dir.joinpath("diodeinsertion.log").write_text(
                "\n".join(
                    [
                        "Gating variable for step 'Odb.HeuristicDiodeInsertion' set to 'False'- the step will be skipped.",
                        "Skipping step 'Heuristic Diode Insertion'",
                        "[10:05:00] VERBOSE Running 'Odb.PortDiodePlacement'",
                        "Design name: unit_margin40_top",
                        "Inserted 13 diodes.",
                        "[INFO GRT-0006] Repairing antennas, iteration 35.",
                        "[INFO GRT-0012] Found 29 antenna violations.",
                        "[INFO GRT-0015] Inserted 47 diodes.",
                        "[INFO GRT-0009] rerouting 31 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 36.",
                        "[INFO GRT-0012] Found 29 antenna violations.",
                        "[INFO GRT-0015] Inserted 47 diodes.",
                        "[INFO GRT-0009] rerouting 29 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 37.",
                        "[INFO GRT-0012] Found 29 antenna violations.",
                        "[INFO GRT-0015] Inserted 47 diodes.",
                        "[INFO GRT-0009] rerouting 32 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 38.",
                        "[INFO GRT-0012] Found 29 antenna violations.",
                        "[INFO GRT-0015] Inserted 47 diodes.",
                        "[INFO GRT-0009] rerouting 29 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 39.",
                        "[INFO GRT-0012] Found 29 antenna violations.",
                        "[INFO GRT-0015] Inserted 47 diodes.",
                        "[INFO GRT-0009] rerouting 32 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 40.",
                        "[INFO GRT-0012] Found 29 antenna violations.",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            report = openlane_pd_blocker_summary.build_report(
                run_dir=run_dir,
                process_table="",
            )

            antenna = report["findings"][0]["terminal_stage_diagnostic"][
                "antenna_repair_diagnostic"
            ]
            self.assertTrue(antenna["bounded_segment_completed"])
            self.assertFalse(antenna["timed_out"])
            self.assertEqual(antenna["config_values"]["GRT_ANTENNA_MARGIN"], 40)
            self.assertIn("margin-40 bounded segment completed", antenna["next_pd_action"])
            self.assertEqual(
                antenna["next_bounded_experiment"]["temporary_config_overrides"][
                    "GRT_ANTENNA_MARGIN"
                ],
                30,
            )
            self.assertNotIn("timed out", antenna["next_pd_action"])

    def test_openlane_pd_blocker_summary_records_margin30_residual_antennas(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            old_run_root = openlane_pd_blocker_summary.RUN_ROOT
            openlane_pd_blocker_summary.RUN_ROOT = Path(tmpdir)
            self.addCleanup(
                setattr,
                openlane_pd_blocker_summary,
                "RUN_ROOT",
                old_run_root,
            )
            run_dir = Path(tmpdir) / "RUN_2099-01-01_00-00-03_diodein_noheuristic_margin30_segment"
            prior_run = (
                Path(tmpdir) / "RUN_2099-01-01_00-00-02_diodein_noheuristic_margin40_segment"
            )
            prior_repair_dir = prior_run / "02-openroad-repairantennas"
            prior_stage_dir = prior_repair_dir / "1-diodeinsertion"
            prior_check_dir = prior_repair_dir / "2-openroad-checkantennas"
            prior_stage_dir.mkdir(parents=True)
            prior_check_dir.joinpath("reports").mkdir(parents=True)
            prior_repair_dir.joinpath("config.json").write_text(
                json.dumps(
                    {
                        "GRT_ANTENNA_ITERS": 40,
                        "GRT_ANTENNA_MARGIN": 40,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            prior_repair_dir.joinpath("state_out.json").write_text("{}\n", encoding="utf-8")
            prior_stage_dir.joinpath("diodeinsertion.log").write_text(
                "\n".join(
                    [
                        "Skipping step 'Heuristic Diode Insertion'",
                        "Design name: unit_margin30_top",
                        "[INFO GRT-0006] Repairing antennas, iteration 38.",
                        "[INFO GRT-0012] Found 29 antenna violations.",
                        "[INFO GRT-0015] Inserted 47 diodes.",
                        "[INFO GRT-0006] Repairing antennas, iteration 39.",
                        "[INFO GRT-0012] Found 29 antenna violations.",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            prior_check_dir.joinpath("openroad-checkantennas.log").write_text(
                "\n".join(
                    [
                        "[INFO ANT-0002] Found 768 net violations.",
                        "[INFO ANT-0001] Found 1037 pin violations.",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            prior_check_dir.joinpath("reports/antenna_summary.rpt").write_text(
                "\n".join(
                    [
                        "│ 11.23 │ 4493.52 │ 400.00   │ net5641 │ _120477_/A │ met4  │",
                        "│ 11.00 │ 4398.73 │ 400.00   │ net1599 │ _127237_/A │ met3  │",
                        "│ 8.35  │ 3338.48 │ 400.00   │ _018952_ │ _082593_/C │ met3  │",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            diode_config = run_dir / "01-odb-diodesonports/config.json"
            diode_config.parent.mkdir(parents=True)
            diode_config.write_text(
                json.dumps(
                    {
                        "DIODE_ON_PORTS": "in",
                        "GRT_ANTENNA_ITERS": 40,
                        "GRT_ANTENNA_MARGIN": 30,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            repair_dir = run_dir / "02-openroad-repairantennas"
            stage_dir = repair_dir / "1-diodeinsertion"
            check_dir = repair_dir / "2-openroad-checkantennas"
            stage_dir.mkdir(parents=True)
            check_dir.joinpath("reports").mkdir(parents=True)
            repair_dir.joinpath("config.json").write_text(
                json.dumps(
                    {
                        "GRT_ANTENNA_ITERS": 40,
                        "GRT_ANTENNA_MARGIN": 30,
                        "RT_MAX_LAYER": "met5",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            repair_dir.joinpath("state_out.json").write_text("{}\n", encoding="utf-8")
            stage_dir.joinpath("diodeinsertion.log").write_text(
                "\n".join(
                    [
                        "Skipping step 'Heuristic Diode Insertion'",
                        "[10:05:00] VERBOSE Running 'Odb.PortDiodePlacement'",
                        "Design name: unit_margin30_top",
                        "Inserted 13 diodes.",
                        "[INFO GRT-0006] Repairing antennas, iteration 35.",
                        "[INFO GRT-0012] Found 18 antenna violations.",
                        "[INFO GRT-0015] Inserted 30 diodes.",
                        "[INFO GRT-0009] rerouting 19 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 36.",
                        "[INFO GRT-0012] Found 18 antenna violations.",
                        "[INFO GRT-0015] Inserted 30 diodes.",
                        "[INFO GRT-0009] rerouting 18 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 37.",
                        "[INFO GRT-0012] Found 18 antenna violations.",
                        "[INFO GRT-0015] Inserted 30 diodes.",
                        "[INFO GRT-0009] rerouting 20 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 38.",
                        "[INFO GRT-0012] Found 18 antenna violations.",
                        "[INFO GRT-0015] Inserted 30 diodes.",
                        "[INFO GRT-0009] rerouting 20 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 39.",
                        "[INFO GRT-0012] Found 18 antenna violations.",
                        "[INFO GRT-0015] Inserted 30 diodes.",
                        "[INFO GRT-0009] rerouting 20 nets.",
                        "[INFO GRT-0006] Repairing antennas, iteration 40.",
                        "[INFO GRT-0012] Found 18 antenna violations.",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            check_dir.joinpath("openroad-checkantennas.log").write_text(
                "\n".join(
                    [
                        "[INFO ANT-0002] Found 770 net violations.",
                        "[INFO ANT-0001] Found 1032 pin violations.",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            check_dir.joinpath("reports/antenna_summary.rpt").write_text(
                "\n".join(
                    [
                        "│ 10.97 │ 4389.90 │ 400.00   │ net305 │ _076354_/A2_N │ met3  │",
                        "│ 5.93  │ 2373.14 │ 400.00   │ net3957 │ _118301_/A2 │ met3  │",
                        "│ 4.94  │ 1976.85 │ 400.00   │ dram_mem[56][21] │ _121697_/A0 │ met1  │",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            report = openlane_pd_blocker_summary.build_report(
                run_dir=run_dir,
                process_table="",
            )

            antenna = report["findings"][0]["terminal_stage_diagnostic"][
                "antenna_repair_diagnostic"
            ]
            self.assertEqual(antenna["best_remaining_antenna_violations"], 18)
            self.assertEqual(antenna["last_remaining_antenna_violations"], 18)
            self.assertIn("margin-30 bounded segment completed", antenna["next_pd_action"])
            self.assertNotIn(
                "GRT_ANTENNA_MARGIN",
                antenna["next_bounded_experiment"]["temporary_config_overrides"],
            )
            self.assertIn(
                "Do not lower `GRT_ANTENNA_MARGIN` again",
                antenna["next_bounded_experiment"]["diagnostic_constraint"],
            )
            self.assertEqual(antenna["post_repair_checkantennas"]["net_violations"], 770)
            self.assertEqual(antenna["post_repair_checkantennas"]["pin_violations"], 1032)
            self.assertEqual(
                antenna["post_repair_checkantennas"]["top_layers"][0],
                {"layer": "met3", "rows": 2},
            )
            self.assertEqual(
                antenna["post_repair_checkantennas"]["top_nets"][0],
                {"net": "dram_mem[56][21]", "rows": 1},
            )
            residual = antenna["post_repair_checkantennas"]["residual_met1_met3_strategy"]
            self.assertTrue(residual["present"])
            self.assertEqual(residual["total_met1_met3_rows"], 3)
            self.assertEqual(residual["primary_strategy"], "mixed_route_and_diode_review")
            self.assertEqual(
                residual["layer_net_family_rows"][0],
                {"layer": "met3", "family": "synthesized_numbered_net", "rows": 2},
            )
            met3_targets = residual["met3_synthesized_routing_targets"]
            self.assertTrue(met3_targets["present"])
            self.assertEqual(met3_targets["total_rows"], 2)
            self.assertEqual(met3_targets["unique_nets"], 2)
            self.assertEqual(
                met3_targets["ranked_targets"][0]["net"],
                "net305",
            )
            self.assertEqual(met3_targets["ranked_targets"][0]["max_ratio"], 10.97)
            self.assertIn(
                "Do not lower `GRT_ANTENNA_MARGIN`",
                met3_targets["next_experiment_constraint"],
            )
            self.assertEqual(
                residual["ratio_bands"],
                {
                    "ratio_ge_5": 2,
                    "ratio_ge_3_lt_5": 1,
                    "ratio_ge_1_5_lt_3": 0,
                    "ratio_lt_1_5": 0,
                    "ratio_unparsed": 0,
                },
            )
            self.assertEqual(
                antenna["next_bounded_experiment"]["diagnostic_targets"]["primary_strategy"],
                "mixed_route_and_diode_review",
            )
            self.assertEqual(
                antenna["next_bounded_experiment"]["diagnostic_targets"][
                    "met3_synthesized_routing_targets"
                ]["ranked_targets"][0]["net"],
                "net305",
            )
            ranking = antenna["segmented_antenna_experiment_ranking"]
            self.assertTrue(ranking["repair_loop_improvement_is_potentially_false"])
            self.assertEqual(
                ranking["comparison_baseline"]["post_checkantennas_net_violation_delta"],
                2,
            )
            self.assertIn("false repair-loop improvement", antenna["next_pd_action"])

    def test_macro_array_configs_declare_all_sram_instances_as_macros(self) -> None:
        cases = {
            "config.macro-array.sky130.json": "macro_array_baseline.cfg",
            "config.macro-array.compact.sky130.json": "macro_array_cand_compact.cfg",
            "config.macro-array.stack2x4.sky130.json": "macro_array_cand_stack2x4.cfg",
        }
        for config_name, placement_name in cases.items():
            with self.subTest(config=config_name):
                config = json.loads((ROOT / "pd/openlane" / config_name).read_text())
                macro = config.get("MACROS", {}).get("sky130_sram_2kbyte_1rw1r_32x512_8")
                self.assertIsInstance(macro, dict)
                self.assertTrue(macro.get("gds"))
                self.assertTrue(macro.get("lef"))
                self.assertTrue(macro.get("nl"))
                self.assertIn("*", macro.get("lib", {}))
                self.assertTrue(
                    all(
                        path.startswith("pdk_dir::libs.ref/sky130_sram_macros/")
                        for path in macro["gds"] + macro["lef"] + macro["lib"]["*"]
                    )
                )
                self.assertNotIn("volare/sky130/versions/", json.dumps(macro))

                instances = macro.get("instances", {})
                placement_instances = {}
                for line in (ROOT / "pd/openlane" / placement_name).read_text().splitlines():
                    name, x, y, orientation = line.split()
                    placement_instances[name] = {
                        "location": [int(x), int(y)],
                        "orientation": orientation,
                    }
                self.assertEqual(instances, placement_instances)

    def test_sky130_sram_macro_paths_resolve_through_active_pdk(self) -> None:
        for config_name in (
            "config.sky130.json",
            "config.macro-array.sky130.json",
            "config.macro-array.compact.sky130.json",
            "config.macro-array.stack2x4.sky130.json",
        ):
            with self.subTest(config=config_name):
                text = (ROOT / "pd/openlane" / config_name).read_text(encoding="utf-8")
                config = json.loads(text)
                macro = config["MACROS"]["sky130_sram_2kbyte_1rw1r_32x512_8"]
                self.assertNotIn("volare/sky130/versions/", text)
                self.assertTrue(
                    all(
                        path.startswith("pdk_dir::libs.ref/sky130_sram_macros/")
                        for path in macro["gds"] + macro["lef"] + macro["lib"]["*"]
                    )
                )

    def test_sky130_release_config_enables_input_port_diodes(self) -> None:
        config = json.loads((ROOT / "pd/openlane/config.sky130.json").read_text())

        self.assertEqual(config["DIODE_ON_PORTS"], "in")
        self.assertNotIn("GRT_ANT_ITERS", config)
        self.assertEqual(config["GRT_ANTENNA_ITERS"], 40)
        self.assertTrue(config["RUN_HEURISTIC_DIODE_INSERTION"])

    def test_release_gates_fail_closed_without_external_artifacts(self) -> None:
        commands = [
            ("scripts/check_kicad_artifacts.py", "--release"),
            ("scripts/check_fpga_release.py", "--release"),
            ("scripts/check_openlane_run_preflight.py", "--release"),
            ("scripts/check_manufacturing_artifacts.py", "--release"),
            ("scripts/check_pd_signoff.py",),
        ]
        for command in commands:
            with self.subTest(command=" ".join(command)):
                result = run_check(*command)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_manufacturing_manifest_references_leaf_manifests(self) -> None:
        manifest = yaml.safe_load((ROOT / "docs/manufacturing/artifact-manifest.yaml").read_text())
        self.assertIsInstance(manifest, dict)
        references = set(manifest.get("artifact_manifests", []))
        self.assertIn("package/artifact-manifest.yaml", references)
        self.assertIn("board/kicad/e1-demo/artifact-manifest.yaml", references)
        self.assertIn("board/kicad/e1-phone/artifact-manifest.yaml", references)
        self.assertIn("board/fpga/artifact-manifest.yaml", references)
        self.assertIn("pd/signoff/manifest.yaml", references)

    def test_fpga_manifest_lists_cli_evidence(self) -> None:
        manifest = yaml.safe_load((ROOT / "board/fpga/artifact-manifest.yaml").read_text())
        bitstream = manifest["artifact_groups"]["bitstream_release"]
        self.assertTrue({"synth", "place_route", "pack"}.issubset(set(bitstream["cli_commands"])))
        artifact_names = {artifact["name"] for artifact in bitstream["artifacts"]}
        self.assertTrue(
            {
                "bitstream",
                "nextpnr_timing_report",
                "nextpnr_route_report",
                "ecppack_transcript",
                "fpga_tool_versions",
            }.issubset(artifact_names)
        )


if __name__ == "__main__":
    unittest.main()
