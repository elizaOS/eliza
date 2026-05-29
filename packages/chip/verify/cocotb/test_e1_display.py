import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from common import read_reg as _read_reg  # noqa: E402
from common import write_reg as _write_reg  # noqa: E402
from coverage_helpers import CoverPointSet  # noqa: E402

DISPLAY_MMIO_REGIONS = (
    "framebuffer_addr",
    "mode",
    "format",
    "enable",
    "vsync_irq",
    "underflow_count",
    "fetch_count",
    "stride",
    "frame_bytes_lo",
    "frame_bytes_hi",
)
_DISPLAY_COVER = CoverPointSet("display")
_DISPLAY_COVER.declare("mmio_region", "register", DISPLAY_MMIO_REGIONS)
_FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "production_framebuffer_claim_allowed": False,
    "linux_display_driver_claim_allowed": False,
    "drm_kms_claim_allowed": False,
    "panel_bringup_claim_allowed": False,
    "dsi_phy_claim_allowed": False,
    "display_phy_claim_allowed": False,
    "compositor_claim_allowed": False,
}


def _classify_display_reg(addr: int) -> str:
    return {
        0: "framebuffer_addr",
        1: "mode",
        2: "format",
        3: "enable",
        4: "vsync_irq",
        5: "underflow_count",
        6: "fetch_count",
        7: "stride",
        8: "frame_bytes_lo",
        9: "frame_bytes_hi",
    }.get(addr, "framebuffer_addr")


async def reset(dut):
    # Framebuffer-read sideband must idle low through the reset window before
    # delegating to the shared simple-register reset.
    dut.fb_read_data.value = 0
    dut.fb_read_ready.value = 0
    await common.reset(dut)


async def write_reg(dut, addr, data):
    _DISPLAY_COVER.sample("mmio_region", "register", _classify_display_reg(addr))
    await _write_reg(dut, addr, data)


async def read_reg(dut, addr):
    _DISPLAY_COVER.sample("mmio_region", "register", _classify_display_reg(addr))
    return await _read_reg(dut, addr)


async def advance(dut, cycles):
    for _ in range(cycles):
        await RisingEdge(dut.clk)
    await Timer(1, units="ns")


def write_coverage_artifact(extra):
    coverage = {
        "schema": "e1-chip.display_cocotb_coverage.v1",
        "generated_utc": datetime.now(UTC).isoformat(),
        "claim_boundary": "directed_display_cocotb_coverage_only_not_system_or_release_evidence",
        "source": "verify/cocotb/test_e1_display.py",
        "covered_contracts": sorted(extra),
        "pixel_format": "XR24 only",
        "boundary": "Directed e1_display MMIO, XR24 scanout, underflow, and timing checks only; no DRM/KMS, production framebuffer, Linux display driver, HDMI/MIPI, panel bring-up, DSI PHY, compositor, or display PHY coverage.",
        **_FALSE_CLAIM_FLAGS,
    }
    out = REPO_ROOT / "build/reports/display_cocotb_coverage.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(coverage, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    _DISPLAY_COVER.write_json(extra={"covered_contracts": sorted(extra)})


@cocotb.test()
async def display_register_defaults_and_disable_gate_scanout(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    assert await read_reg(dut, 0) == 0
    assert await read_reg(dut, 1) == (480 << 16) | 640
    assert await read_reg(dut, 2) == 0x3432_5258
    assert await read_reg(dut, 3) == 0
    assert await read_reg(dut, 4) == 0

    await advance(dut, 32)
    assert int(dut.scan_active.value) == 0
    assert int(dut.scan_hsync.value) == 0
    assert int(dut.scan_vsync.value) == 0
    assert int(dut.irq_vsync.value) == 0
    assert int(dut.scan_x.value) == 0
    assert int(dut.scan_y.value) == 0
    assert int(dut.scan_fb_addr.value) == 0
    assert int(dut.fb_read_valid.value) == 0
    assert int(dut.fb_read_addr.value) == 0


@cocotb.test()
async def display_clamps_mode_and_rejects_unsupported_format(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await write_reg(dut, 1, 0)
    assert await read_reg(dut, 1) == (1 << 16) | 1

    await write_reg(dut, 2, 0x3432_4247)  # XB24/GB24-like value is rejected.
    assert await read_reg(dut, 2) == 0x3432_5258

    await write_reg(dut, 2, 0x3432_5258)
    assert await read_reg(dut, 2) == 0x3432_5258


@cocotb.test()
async def display_generates_active_pixels_and_hsync(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await write_reg(dut, 0, 0x8000_0000)
    await write_reg(dut, 1, (3 << 16) | 4)
    await write_reg(dut, 3, 1)

    dut.fb_read_ready.value = 1
    dut.fb_read_data.value = 0x00112233
    await Timer(1, units="ns")
    assert int(dut.scan_active.value) == 1
    assert int(dut.scan_x.value) == 0
    assert int(dut.scan_y.value) == 0
    assert int(dut.scan_fb_addr.value) == 0x8000_0000
    assert int(dut.fb_read_valid.value) == 1
    assert int(dut.fb_read_addr.value) == 0x8000_0000
    assert int(dut.scan_rgb.value) == 0x112233

    dut.fb_read_data.value = 0x00A0B0C0
    await advance(dut, 1)
    assert int(dut.scan_active.value) == 1
    assert int(dut.scan_x.value) == 1
    assert int(dut.scan_fb_addr.value) == 0x8000_0004
    assert int(dut.fb_read_addr.value) == 0x8000_0004
    assert int(dut.scan_rgb.value) == 0xA0B0C0

    await advance(dut, 3)
    assert int(dut.scan_active.value) == 0
    assert int(dut.scan_x.value) == 4
    assert int(dut.scan_fb_addr.value) == 0
    assert int(dut.fb_read_valid.value) == 0
    assert int(dut.fb_read_addr.value) == 0

    await advance(dut, 16)
    assert int(dut.scan_x.value) == 20
    assert int(dut.scan_hsync.value) == 1
    assert int(dut.scan_vsync.value) == 0

    await advance(dut, 96)
    assert int(dut.scan_x.value) == 116
    assert int(dut.scan_hsync.value) == 0


@cocotb.test()
async def display_generates_vsync_pulse_and_wraps_frame(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await write_reg(dut, 1, (3 << 16) | 4)
    await write_reg(dut, 3, 1)

    total_h = 4 + 16 + 96 + 48
    total_v = 3 + 10 + 2 + 33

    await advance(dut, total_h * (3 + 10))
    assert int(dut.scan_x.value) == 0
    assert int(dut.scan_y.value) == 13
    assert int(dut.scan_active.value) == 0
    assert int(dut.scan_vsync.value) == 1
    assert int(dut.irq_vsync.value) == 1
    assert await read_reg(dut, 4) == 1

    await advance(dut, 1)
    assert int(dut.irq_vsync.value) == 0

    await advance(dut, total_h * total_v - (total_h * (3 + 10)) - 2)
    assert int(dut.scan_x.value) == 0
    assert int(dut.scan_y.value) == 0
    assert int(dut.scan_active.value) == 1


@cocotb.test()
async def display_counts_fetched_pixels_and_underflows(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await write_reg(dut, 0, 0x8000_0100)
    await write_reg(dut, 1, (2 << 16) | 3)
    await write_reg(dut, 3, 1)

    dut.fb_read_ready.value = 1
    dut.fb_read_data.value = 0x00010203
    await advance(dut, 1)

    dut.fb_read_ready.value = 0
    await Timer(1, units="ns")
    await advance(dut, 1)
    assert int(dut.scan_rgb.value) == 0
    assert await read_reg(dut, 5) == 1
    assert await read_reg(dut, 6) == 1

    await write_reg(dut, 5, 1)
    await write_reg(dut, 6, 1)
    assert await read_reg(dut, 5) == 0
    assert await read_reg(dut, 6) == 0


@cocotb.test()
async def display_delayed_framebuffer_response_underflows_then_recovers(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await write_reg(dut, 0, 0x8000_0200)
    await write_reg(dut, 1, (1 << 16) | 8)
    await write_reg(dut, 3, 1)

    dut.fb_read_ready.value = 0
    dut.fb_read_data.value = 0x00FF_0000
    await Timer(1, units="ns")
    assert int(dut.scan_active.value) == 1
    assert int(dut.scan_rgb.value) == 0
    assert int(dut.fb_read_addr.value) == 0x8000_0200
    await advance(dut, 2)

    dut.fb_read_ready.value = 1
    dut.fb_read_data.value = 0x0000_8040
    await Timer(1, units="ns")
    assert int(dut.scan_active.value) == 1
    assert int(dut.scan_rgb.value) == 0x008040
    assert int(dut.fb_read_addr.value) == 0x8000_0208
    await advance(dut, 6)
    assert int(dut.scan_active.value) == 0
    assert await read_reg(dut, 5) == 2
    assert await read_reg(dut, 6) == 6


@cocotb.test()
async def display_reports_stride_and_frame_byte_count(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    assert await read_reg(dut, 7) == 640 * 4
    assert await read_reg(dut, 8) == 640 * 480 * 4
    assert await read_reg(dut, 9) == 0

    await write_reg(dut, 1, (3 << 16) | 4)
    assert await read_reg(dut, 7) == 16
    assert await read_reg(dut, 8) == 48
    assert await read_reg(dut, 9) == 0

    await write_reg(dut, 1, (0xFFFF << 16) | 0xFFFF)
    expected = 0xFFFF * 0xFFFF * 4
    assert await read_reg(dut, 7) == 0x3FFFC
    assert await read_reg(dut, 8) == (expected & 0xFFFF_FFFF)
    assert await read_reg(dut, 9) == (expected >> 32)


@cocotb.test()
async def display_disable_resets_scan_position_and_blocks_fetches(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await write_reg(dut, 0, 0x8000_0400)
    await write_reg(dut, 1, (2 << 16) | 4)
    await write_reg(dut, 3, 1)
    dut.fb_read_ready.value = 1
    dut.fb_read_data.value = 0x00AA_5500
    await advance(dut, 3)
    assert int(dut.scan_x.value) == 3
    assert int(dut.fb_read_valid.value) == 1

    await write_reg(dut, 3, 0)
    await Timer(1, units="ns")
    assert int(dut.scan_active.value) == 0
    assert int(dut.fb_read_valid.value) == 0
    assert int(dut.fb_read_addr.value) == 0
    assert int(dut.scan_fb_addr.value) == 0
    await advance(dut, 2)
    assert int(dut.scan_x.value) == 0
    assert int(dut.scan_y.value) == 0
    assert int(dut.irq_vsync.value) == 0

    write_coverage_artifact({"disable_fetch_gate", "scan_position_reset", "xr24_scanout"})
