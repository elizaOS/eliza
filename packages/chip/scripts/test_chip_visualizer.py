#!/usr/bin/env python3
"""Regression tests for the DEF-backed chip visualizer builder."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("build_chip_visualizer.py")
SPEC = importlib.util.spec_from_file_location("build_chip_visualizer", SCRIPT)
assert SPEC and SPEC.loader
build_chip_visualizer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = build_chip_visualizer
SPEC.loader.exec_module(build_chip_visualizer)


SAMPLE_DEF = """VERSION 5.8 ;
DIVIDERCHAR "/" ;
BUSBITCHARS "[]" ;
DESIGN e1_chip_top ;
UNITS DISTANCE MICRONS 1000 ;
DIEAREA ( 0 0 ) ( 10000 8000 ) ;
ROW ROW_0 unithd 0 0 N DO 10 BY 1 STEP 460 0 ;
ROW ROW_1 unithd 0 2720 FS DO 10 BY 1 STEP 460 0 ;
COMPONENTS 3 ;
- u0 sky130_fd_sc_hd__and2_1 + PLACED ( 460 0 ) N ;
- clk0 sky130_fd_sc_hd__clkbuf_4 + PLACED ( 920 2720 ) FS ;
- fill0 sky130_fd_sc_hd__fill_2 + PLACED ( 1380 2720 ) N ;
END COMPONENTS
PINS 1 ;
- reset + NET reset + DIRECTION INPUT + USE SIGNAL
  + LAYER met2 ( -70 -70 ) ( 70 70 )
  + PLACED ( 100 200 ) N ;
END PINS
SPECIALNETS 1 ;
- VPWR
  + ROUTED met4 ( 0 4000 ) ( 10000 4000 )
  NEW met5 ( 5000 * ) ( 5000 8000 ) ;
END SPECIALNETS
NETS 1 ;
- reset ( PIN reset ) ( u0 A )
  + ROUTED met2 ( 100 200 ) ( 1000 200 )
  NEW met3 ( * * ) ( 1000 2000 )
  NEW met3 ( 1000 2000 ) RECT ( -50 -50 50 50 ) ;
END NETS
END DESIGN
"""


def test_build_payload_parses_full_viewer_contract() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        def_path = Path(tmp) / "sample.def"
        def_path.write_text(SAMPLE_DEF)

        payload = build_chip_visualizer.build_payload(
            def_path,
            "explicit",
            gds_path=None,
            out_dir=Path(tmp),
            render_gds=False,
            gds_size=256,
            tile_gds=False,
            tile_size=128,
            tile_overlays=False,
            overlay_tile_count=8,
        )

    assert payload["schema"] == "eliza.chip_visualizer.v1"
    assert payload["design"] == "e1_chip_top"
    assert payload["units_per_micron"] == 1000
    assert payload["diearea"] == [0, 0, 10000, 8000]
    assert payload["summary"]["row_count"] == 2
    assert payload["summary"]["component_count"] == 3
    assert payload["summary"]["pin_count"] == 1
    assert payload["summary"]["route_segment_count"] == 6
    assert payload["summary"]["component_class_counts"]["clock"] == 1
    assert payload["summary"]["component_class_counts"]["filler"] == 1
    assert payload["summary"]["layer_counts"]["met2"] == 1
    assert payload["summary"]["layer_counts"]["met3"] == 2
    assert payload["summary"]["layer_counts"]["met4"] == 1
    assert payload["summary"]["layer_counts"]["met5"] == 1
    assert payload["summary"]["layer_counts"]["rect"] == 1
    assert {route["net"] for route in payload["routes"]} == {"VPWR", "reset"}
    assert payload["analysis"]["schema"] == "eliza.chip_visualizer.analysis.v1"
    assert "release_or_tapeout" in payload["analysis"]["claim_boundary"]
    assert payload["silicon_image"]["available"] is False
    assert payload["tiles"]


def test_choose_def_prefers_final_full_soc_before_newer_block_def() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        runs = root / "pd" / "openlane" / "runs"
        full = runs / "RUN_old" / "final" / "def" / "e1_chip_top.def"
        detailed = runs / "RUN_older" / "46-openroad-detailedrouting" / "e1_chip_top.def"
        block = runs / "RUN_new" / "final" / "def" / "e1_pd_smoke_top.def"
        full.parent.mkdir(parents=True)
        detailed.parent.mkdir(parents=True)
        block.parent.mkdir(parents=True)
        full.write_text("DESIGN e1_chip_top ;\n")
        detailed.write_text("DESIGN e1_chip_top ;\n")
        block.write_text("DESIGN e1_pd_smoke_top ;\n")
        full.touch()
        detailed.touch()
        block.touch()

        original_root = build_chip_visualizer.ROOT
        build_chip_visualizer.ROOT = root
        try:
            source = build_chip_visualizer.choose_def()
        finally:
            build_chip_visualizer.ROOT = original_root

    assert source.path == full
    assert source.role == "final_full_soc"


def test_choose_def_finds_post_fill_openlane2_full_soc() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        runs = root / "pd" / "openlane" / "runs"
        post_fill = runs / "RUN_new" / "52-odb-cellfrequencytables" / "e1_chip_top.def"
        detailed = runs / "RUN_old" / "43-openroad-detailedrouting" / "e1_chip_top.def"
        post_fill.parent.mkdir(parents=True)
        detailed.parent.mkdir(parents=True)
        detailed.write_text("DESIGN e1_chip_top ;\n")
        post_fill.write_text("DESIGN e1_chip_top ;\n")

        original_root = build_chip_visualizer.ROOT
        build_chip_visualizer.ROOT = root
        try:
            source = build_chip_visualizer.choose_def()
        finally:
            build_chip_visualizer.ROOT = original_root

    assert source.path == post_fill
    assert source.role == "post_fill_full_soc"


def test_choose_gds_finds_matching_design_in_run() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        def_path = (
            root / "pd" / "openlane" / "runs" / "RUN_sample" / "final" / "def" / "e1_chip_top.def"
        )
        gds_path = (
            root
            / "pd"
            / "openlane"
            / "runs"
            / "RUN_sample"
            / "final"
            / "gds"
            / "e1_chip_top.klayout.gds"
        )
        other_gds = root / "pd" / "openlane" / "runs" / "RUN_sample" / "final" / "gds" / "other.gds"
        def_path.parent.mkdir(parents=True)
        gds_path.parent.mkdir(parents=True)
        def_path.write_text("DESIGN e1_chip_top ;\n")
        gds_path.write_text("gds")
        other_gds.write_text("other")

        selected = build_chip_visualizer.choose_gds(def_path)

    assert selected == gds_path


def test_build_payload_records_unrendered_gds_source() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        def_path = root / "sample.def"
        gds_path = root / "sample.gds"
        def_path.write_text(SAMPLE_DEF)
        gds_path.write_text("gds")

        payload = build_chip_visualizer.build_payload(
            def_path,
            "explicit",
            gds_path=gds_path,
            out_dir=root / "out",
            render_gds=False,
            gds_size=256,
            tile_gds=False,
            tile_size=128,
            tile_overlays=False,
            overlay_tile_count=8,
        )

    assert payload["silicon_image"]["available"] is True
    assert payload["silicon_image"]["gds"].endswith("sample.gds")
    assert payload["silicon_image"]["rendered"] is False


def test_tiled_overlays_move_def_geometry_out_of_main_payload() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        def_path = root / "sample.def"
        def_path.write_text(SAMPLE_DEF)

        payload = build_chip_visualizer.build_payload(
            def_path,
            "explicit",
            gds_path=None,
            out_dir=root / "out",
            render_gds=False,
            gds_size=256,
            tile_gds=False,
            tile_size=128,
            tile_overlays=True,
            overlay_tile_count=4,
        )

        tile_meta = payload["overlay_tiles"]
        search_meta = payload["search_index"]
        assert payload["components"] == []
        assert payload["routes"] == []
        assert tile_meta["tile_count"] == 4
        assert tile_meta["component_count"] == 3
        assert tile_meta["route_segment_count"] == 6
        assert search_meta["component_count"] == 3
        assert search_meta["pin_count"] == 1
        assert search_meta["net_count"] == 2
        assert (root / "out" / "overlay-tiles").is_dir()
        assert (root / "out" / "search-index.json").is_file()


def test_make_tile_pyramid_splits_rendered_image() -> None:
    from PIL import Image

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        image = root / "silicon-gds.png"
        Image.new("RGB", (600, 300), (40, 80, 120)).save(image)

        tiles = build_chip_visualizer.make_tile_pyramid(image, root, tile_size=256)

        assert tiles["width"] == 600
        assert tiles["height"] == 300
        assert tiles["tile_size"] == 256
        assert tiles["levels"][0]["cols"] == 3
        assert tiles["levels"][0]["rows"] == 2
        assert (root / "silicon-gds-tiles" / "0" / "0_0.png").exists()
        assert len(tiles["levels"]) == 3


def test_summarize_metrics_records_qor_and_violations() -> None:
    metrics = {
        "design__instance__utilization": 0.72,
        "route__wirelength": 12345,
        "route__antenna_violation__count": 2,
        "timing__hold__wns": -0.01,
        "klayout__drc_error__count": 0,
    }

    summary = build_chip_visualizer.summarize_metrics(metrics, ["run/final/metrics.json"])

    assert summary["available"] is True
    assert {item["key"] for item in summary["summary"]} >= {
        "design__instance__utilization",
        "route__wirelength",
    }
    assert {item["key"] for item in summary["violations"]} == {
        "route__antenna_violation__count",
        "timing__hold__wns",
    }


def test_run_metrics_aggregate_uses_selected_run_step_metrics() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        run = Path(tmp) / "RUN_sample"
        early = run / "38-openroad-globalrouting"
        late = run / "46-openroad-detailedrouting"
        early.mkdir(parents=True)
        late.mkdir(parents=True)
        (early / "or_metrics_out.json").write_text(
            '{"route__antenna_violation__count": 5, "route__wirelength": 10}'
        )
        (late / "or_metrics_out.json").write_text(
            '{"route__wirelength": 20, "route__drc_errors": 0}'
        )

        metrics, sources = build_chip_visualizer.load_run_metrics(run)

    assert metrics["route__antenna_violation__count"] == 5
    assert metrics["route__wirelength"] == 20
    assert metrics["route__drc_errors"] == 0
    assert sources[-1].endswith("46-openroad-detailedrouting/or_metrics_out.json")


def test_collect_measurements_adds_ir_drop_bins_and_wirelengths() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        run = root / "pd" / "openlane" / "runs" / "RUN_sample"
        step = run / "55-openroad-irdropreport"
        wires = run / "49-odb-reportwirelength"
        step.mkdir(parents=True)
        wires.mkdir(parents=True)
        (step / "net-VPWR.csv").write_text(
            "Instance,Terminal,Layer,X location,Y location,Voltage\n"
            "u0,VPWR,li1,1.0,2.0,1.799\n"
            "u1,VPWR,li1,9.0,8.0,1.790\n",
            encoding="utf-8",
        )
        (wires / "wire_lengths.csv").write_text("net,length_um\nn0,1.5mm\n", encoding="utf-8")
        def_path = run / "52-odb-cellfrequencytables" / "e1_chip_top.def"
        def_path.parent.mkdir(parents=True)
        def_path.write_text(SAMPLE_DEF, encoding="utf-8")

        measurements = build_chip_visualizer.collect_measurements(
            def_path,
            [0, 0, 10000, 10000],
            1000,
            {"route__drc_errors__iter:1": 12, "route__wirelength__iter:1": 34},
        )

    assert measurements["route_iterations"] == [
        {"iteration": 1, "drc_errors": 12, "wirelength": 34}
    ]
    assert measurements["wirelengths"]["top_nets"][0]["length_um"] == 1500.0
    assert measurements["ir_drop"]["nets"]["VPWR"]["tiles"]


def main() -> int:
    test_build_payload_parses_full_viewer_contract()
    test_choose_def_prefers_final_full_soc_before_newer_block_def()
    test_choose_def_finds_post_fill_openlane2_full_soc()
    test_choose_gds_finds_matching_design_in_run()
    test_build_payload_records_unrendered_gds_source()
    test_tiled_overlays_move_def_geometry_out_of_main_payload()
    test_make_tile_pyramid_splits_rendered_image()
    test_summarize_metrics_records_qor_and_violations()
    test_run_metrics_aggregate_uses_selected_run_step_metrics()
    test_collect_measurements_adds_ir_drop_bins_and_wirelengths()
    print("chip visualizer tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
