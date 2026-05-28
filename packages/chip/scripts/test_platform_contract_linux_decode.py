from pathlib import Path
from unittest import mock

import check_platform_contract as gate


CONTRACT = {
    "e1_chip_cpu_variant": {
        "dram": {"base": "0x80000000"},
        "plic": {"base": "0x0C000000"},
        "devices": {
            "dma": {"base": "0x10010000"},
            "npu": {"base": "0x10020000"},
            "display": {"base": "0x10030000"},
        },
    }
}


def write_linux_contract_fixture(root: Path, *, npu_base: str = "1002_0000") -> None:
    interconnect = root / "rtl/interconnect/e1_axi_lite_interconnect.sv"
    wrapper = root / "rtl/interconnect/e1_linux_soc_contract.sv"
    interconnect.parent.mkdir(parents=True)
    interconnect.write_text(
        "\n".join(
            [
                "localparam logic [31:0] DRAM_BASE = 32'h8000_0000;",
                "localparam logic [31:0] INTC_BASE = 32'h0C00_0000;",
                "localparam logic [31:0] DMA_BASE  = 32'h1001_0000;",
                f"localparam logic [31:0] NPU_BASE  = 32'h{npu_base};",
                "localparam logic [31:0] DISP_BASE = 32'h1003_0000;",
                "",
            ]
        ),
        encoding="utf-8",
    )
    wrapper.write_text(
        "\n".join(
            [
                "e1_npu u_npu ();",
                "e1_display u_display ();",
                ".npu_awvalid(npu_mmio_awvalid),",
                ".npu_arvalid(npu_mmio_arvalid),",
                ".display_awvalid(display_mmio_awvalid),",
                ".display_arvalid(display_mmio_arvalid),",
                "",
            ]
        ),
        encoding="utf-8",
    )


def test_linux_contract_decode_matches_cpu_variant(tmp_path):
    write_linux_contract_fixture(tmp_path)
    errors: list[str] = []

    with mock.patch.object(gate, "ROOT", tmp_path):
        gate.check_cpu_variant_linux_contract_decode(CONTRACT, errors)

    assert errors == []


def test_linux_contract_decode_rejects_stale_npu_base(tmp_path):
    write_linux_contract_fixture(tmp_path, npu_base="1004_0000")
    errors: list[str] = []

    with mock.patch.object(gate, "ROOT", tmp_path):
        gate.check_cpu_variant_linux_contract_decode(CONTRACT, errors)

    assert any("NPU_BASE" in error and "0x10020000" in error for error in errors)
