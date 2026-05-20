"""RPMI v1.0 envelope roundtrip via PMC mailbox.

The PMC mailbox surface (PMC_REG_MBOX_TX_HEAD / TX_DATA / RX_HEAD / RX_DATA)
is the entry point for SBI MPxy frames from S-mode OpenSBI. RPMI v1.0 frames
carry an 8-byte header followed by data:

  +----------+----------+----------+----------+
  | svc_grp  | svc_id   |     token (16b)     |
  +----------+----------+---------------------+
  |   flags (16b)       |   data_length (16b) |
  +---------------------+---------------------+
  |                  data[...]                |
  +-------------------------------------------+

The first 32b word (header_word_0) packs:
  bits  [7:0]  = service_group_id
  bits [15:8]  = service_id
  bits [31:16] = token

The second 32b word (header_word_1) packs:
  bits [15:0]  = flags
  bits [31:16] = data_length

This test posts (header_word_0, header_word_1) into the TX register and
reads them back from the RX register. Until the AON Ibex firmware is bound,
pmc_top.sv loopbacks TX_DATA -> RX_DATA on the same clk_aon, which is the
contract this test verifies. When the Ibex is plugged in, the same
addresses are consumed by `fw/pmc/src/rpmi_server.c::rpmi_parse`.
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge
from power_pkg_constants import (
    DVFS_RAIL_COUNT,
    PMC_REG_MBOX_RX_DATA,
    PMC_REG_MBOX_RX_HEAD,
    PMC_REG_MBOX_TX_DATA,
    PMC_REG_MBOX_TX_HEAD,
)

CLK_AON_PERIOD_NS = 30
CLK_SAMPLE_PERIOD_NS = 5

# RPMI service IDs (mirror fw/pmc/include/rpmi.h)
RPMI_SVC_VOLTAGE = 0x03
RPMI_SVC_CLOCK = 0x04
RPMI_SVC_THERMAL = 0x06


async def _reset(dut):
    dut.rst_n.value = 0
    dut.mbox_valid_i.value = 0
    dut.mbox_write_i.value = 0
    dut.mbox_addr_i.value = 0
    dut.mbox_wdata_i.value = 0
    dut.droop_alarm_i.value = 0
    for i in range(DVFS_RAIL_COUNT):
        dut.droop_event_count_i[i].value = 0
        dut.avfs_target_code_i[i].value = 0
        dut.avfs_raise_count_i[i].value = 0
        dut.avfs_lower_count_i[i].value = 0
    dut.avfs_fault_i.value = 0
    for _ in range(8):
        await RisingEdge(dut.clk_aon)
    dut.rst_n.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk_aon)


async def _mbox_write(dut, addr, data):
    dut.mbox_addr_i.value = addr
    dut.mbox_wdata_i.value = data
    dut.mbox_write_i.value = 1
    dut.mbox_valid_i.value = 1
    await RisingEdge(dut.clk_aon)
    dut.mbox_valid_i.value = 0
    dut.mbox_write_i.value = 0
    await RisingEdge(dut.clk_aon)


async def _mbox_read(dut, addr):
    dut.mbox_addr_i.value = addr
    dut.mbox_write_i.value = 0
    dut.mbox_valid_i.value = 1
    await RisingEdge(dut.clk_aon)
    dut.mbox_valid_i.value = 0
    await RisingEdge(dut.clk_aon)
    return int(dut.mbox_rdata_o.value)


def _pack_header_word_0(service_group_id: int, service_id: int, token: int) -> int:
    return (service_group_id & 0xFF) | ((service_id & 0xFF) << 8) | ((token & 0xFFFF) << 16)


def _pack_header_word_1(flags: int, data_length: int) -> int:
    return (flags & 0xFFFF) | ((data_length & 0xFFFF) << 16)


@cocotb.test()
async def rpmi_voltage_get_envelope_roundtrips(dut):
    """Voltage svc get-current-mv frame roundtrips through TX/RX."""
    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)

    token = 0x4321
    hdr_w0 = _pack_header_word_0(RPMI_SVC_VOLTAGE, 0x02, token)
    hdr_w1 = _pack_header_word_1(flags=0x0, data_length=4)
    payload = 0xDEADBEEF  # rail_id placeholder

    # Post TX_HEAD then TX_DATA (header word 0, then header word 1, then payload).
    await _mbox_write(dut, PMC_REG_MBOX_TX_HEAD, hdr_w0)
    await _mbox_write(dut, PMC_REG_MBOX_TX_DATA, hdr_w1)

    # Read back RX_HEAD / RX_DATA — TX_DATA write loops back to RX_DATA
    # and the previous TX_HEAD lands as RX_HEAD on the same write.
    rx_head = await _mbox_read(dut, PMC_REG_MBOX_RX_HEAD)
    rx_data = await _mbox_read(dut, PMC_REG_MBOX_RX_DATA)
    assert rx_head == hdr_w0, f"RX_HEAD mismatch: got {rx_head:#x} expected {hdr_w0:#x}"
    assert rx_data == hdr_w1, f"RX_DATA mismatch: got {rx_data:#x} expected {hdr_w1:#x}"

    # Verify the unpacking: token / svc_id / svc_grp recoverable.
    recovered_svc_grp = rx_head & 0xFF
    recovered_svc_id = (rx_head >> 8) & 0xFF
    recovered_token = (rx_head >> 16) & 0xFFFF
    assert recovered_svc_grp == RPMI_SVC_VOLTAGE
    assert recovered_svc_id == 0x02
    assert recovered_token == token

    # Payload word can also flow through the TX/RX register pair.
    await _mbox_write(dut, PMC_REG_MBOX_TX_DATA, payload)
    rx_payload = await _mbox_read(dut, PMC_REG_MBOX_RX_DATA)
    assert rx_payload == payload, f"payload roundtrip: got {rx_payload:#x} expected {payload:#x}"


@cocotb.test()
async def rpmi_clock_set_rate_envelope_roundtrips(dut):
    """Clock svc set-rate frame; tests that TX_HEAD updates with each write."""
    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)

    for i, (svc_id, token) in enumerate([(0x01, 0x1000), (0x02, 0x1001), (0x03, 0x1002)]):
        hdr_w0 = _pack_header_word_0(RPMI_SVC_CLOCK, svc_id, token)
        hdr_w1 = _pack_header_word_1(flags=0, data_length=8)
        await _mbox_write(dut, PMC_REG_MBOX_TX_HEAD, hdr_w0)
        await _mbox_write(dut, PMC_REG_MBOX_TX_DATA, hdr_w1)
        rx_head = await _mbox_read(dut, PMC_REG_MBOX_RX_HEAD)
        rx_data = await _mbox_read(dut, PMC_REG_MBOX_RX_DATA)
        assert rx_head == hdr_w0, f"iter {i}: RX_HEAD mismatch"
        assert rx_data == hdr_w1, f"iter {i}: RX_DATA mismatch"


@cocotb.test()
async def rpmi_thermal_envelope_does_not_leak_into_dvfs(dut):
    """Sanity: writing into the mailbox TX surface must not perturb the
    DVFS request register file. The two address regions must stay isolated."""
    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)

    # First raise CPU_BIG DVFS request.
    dvfs_word = (1 << 31) | 0x55
    await _mbox_write(dut, 0x040, dvfs_word)  # PMC_REG_DVFS_BASE + 0
    for _ in range(2):
        await RisingEdge(dut.clk_aon)
    assert int(dut.dvfs_request_valid_o[0].value) == 1
    assert int(dut.dvfs_request_code_o[0].value) == 0x55

    # Now spam TX/RX writes — must not touch dvfs_request_code_o[0].
    for token in range(0x10):
        hdr = _pack_header_word_0(RPMI_SVC_THERMAL, 0x01, token)
        await _mbox_write(dut, PMC_REG_MBOX_TX_HEAD, hdr)
        await _mbox_write(dut, PMC_REG_MBOX_TX_DATA, 0xCAFE0000 | token)

    for _ in range(4):
        await RisingEdge(dut.clk_aon)
    assert int(dut.dvfs_request_valid_o[0].value) == 1, (
        "DVFS valid bit dropped under mailbox-TX traffic"
    )
    assert int(dut.dvfs_request_code_o[0].value) == 0x55, (
        "DVFS code corrupted under mailbox-TX traffic"
    )
