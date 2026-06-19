#!/usr/bin/env python3
import json
import os
import tempfile
from pathlib import Path

import check_pd_preflight


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def test_resolve_dir_path() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        config = root / "pd/openlane/config.json"
        source = root / "rtl/top.sv"
        write(config, "{}")
        write(source, "module top; endmodule\n")

        resolved = check_pd_preflight.resolve_dir_path(config, "dir::../../rtl/top.sv")
        assert resolved == source.resolve(), resolved


def test_check_config_rejects_missing_referenced_path() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        config = Path(tmp) / "pd/openlane/config.json"
        write(
            config,
            json.dumps(
                {
                    "DESIGN_NAME": "e1_chip_top",
                    "VERILOG_FILES": ["dir::../../rtl/missing.sv"],
                    "CLOCK_PORT": "CLK_IN",
                    "CLOCK_PERIOD": 20,
                    "SIGNOFF_SDC_FILE": "dir::../constraints/missing.sdc",
                }
            ),
        )
        failures: list[str] = []
        check_pd_preflight.check_config(config, failures)

        assert any("missing RTL source" in failure for failure in failures), failures
        assert any("missing SIGNOFF_SDC_FILE" in failure for failure in failures), failures


def test_check_pdk_environment_reports_missing_pdk_root_as_blocker() -> None:
    old_pdk_root = os.environ.pop("PDK_ROOT", None)
    try:
        failures: list[str] = []
        blockers: list[str] = []
        check_pd_preflight.check_pdk_environment(
            Path("pd/openlane/config.sky130.json"),
            {"PDK": "sky130A", "STD_CELL_LIBRARY": "sky130_fd_sc_hd"},
            failures,
            blockers,
        )

        assert failures == [], failures
        assert any("PDK_ROOT is not set" in blocker for blocker in blockers), blockers
    finally:
        if old_pdk_root is not None:
            os.environ["PDK_ROOT"] = old_pdk_root


def test_check_pdk_environment_accepts_volare_pdk_layout() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        sky130 = root / "volare/sky130/versions/test-sha/sky130A"
        sky130.mkdir(parents=True)
        old_pdk_root = os.environ.get("PDK_ROOT")
        os.environ["PDK_ROOT"] = str(root)
        try:
            failures: list[str] = []
            blockers: list[str] = []
            check_pd_preflight.check_pdk_environment(
                Path("pd/openlane/config.sky130.json"),
                {"PDK": "sky130A", "STD_CELL_LIBRARY": "sky130_fd_sc_hd"},
                failures,
                blockers,
            )

            assert failures == [], failures
            assert blockers == [], blockers
        finally:
            if old_pdk_root is None:
                os.environ.pop("PDK_ROOT", None)
            else:
                os.environ["PDK_ROOT"] = old_pdk_root


def test_openlane_command_constructs_docker_fallback() -> None:
    command_type, command = check_pd_preflight.openlane_command(
        check_pd_preflight.ROOT / "pd/openlane/config.sky130.json"
    )

    if command_type == "docker":
        assert command[:4] == ["docker", "run", "--rm", "-v"], command
        assert command[-2:] == ["openlane", "pd/openlane/config.sky130.json"], command
    else:
        assert command_type in {"openlane", "flow.tcl"}, command_type


def main() -> int:
    test_resolve_dir_path()
    test_check_config_rejects_missing_referenced_path()
    test_check_pdk_environment_reports_missing_pdk_root_as_blocker()
    test_check_pdk_environment_accepts_volare_pdk_layout()
    test_openlane_command_constructs_docker_fallback()
    print("PD preflight tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
