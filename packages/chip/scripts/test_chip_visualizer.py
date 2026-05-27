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
    assert payload["silicon_image"]["available"] is False
    assert payload["tiles"]


def test_choose_def_prefers_full_soc_before_newer_block_def() -> None:
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

    assert source.path == detailed
    assert source.role == "detailed_routing_full_soc"


def test_choose_gds_finds_matching_design_in_run() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        def_path = root / "pd" / "openlane" / "runs" / "RUN_sample" / "final" / "def" / "e1_chip_top.def"
        gds_path = root / "pd" / "openlane" / "runs" / "RUN_sample" / "final" / "gds" / "e1_chip_top.klayout.gds"
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
        )

    assert payload["silicon_image"]["available"] is True
    assert payload["silicon_image"]["gds"].endswith("sample.gds")
    assert payload["silicon_image"]["rendered"] is False


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


def main() -> int:
    test_build_payload_parses_full_viewer_contract()
    test_choose_def_prefers_full_soc_before_newer_block_def()
    test_choose_gds_finds_matching_design_in_run()
    test_build_payload_records_unrendered_gds_source()
    test_make_tile_pyramid_splits_rendered_image()
    print("chip visualizer tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
