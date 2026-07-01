import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer


def lui(rd, imm20):
    return ((imm20 & 0xFFFFF) << 12) | (rd << 7) | 0x37


def addi(rd, rs1, imm):
    return ((imm & 0xFFF) << 20) | (rs1 << 15) | (0 << 12) | (rd << 7) | 0x13


def add(rd, rs1, rs2):
    return (rs2 << 20) | (rs1 << 15) | (0 << 12) | (rd << 7) | 0x33


def sub(rd, rs1, rs2):
    return (0x20 << 25) | (rs2 << 20) | (rs1 << 15) | (0 << 12) | (rd << 7) | 0x33


def lw(rd, offset, rs1):
    imm = offset & 0xFFF
    return (imm << 20) | (rs1 << 15) | (2 << 12) | (rd << 7) | 0x03


def sw(rs2, offset, rs1):
    imm = offset & 0xFFF
    return ((imm >> 5) << 25) | (rs2 << 20) | (rs1 << 15) | (2 << 12) | ((imm & 0x1F) << 7) | 0x23


def jal(rd, offset):
    imm = offset & 0x1FFFFF
    return (
        ((imm >> 20) & 0x1) << 31
        | ((imm >> 1) & 0x3FF) << 21
        | ((imm >> 11) & 0x1) << 20
        | ((imm >> 12) & 0xFF) << 12
        | (rd << 7)
        | 0x6F
    )


def jalr(rd, rs1, offset):
    imm = offset & 0xFFF
    return (imm << 20) | (rs1 << 15) | (0 << 12) | (rd << 7) | 0x67


def auipc(rd, imm20):
    return ((imm20 & 0xFFFFF) << 12) | (rd << 7) | 0x17


def branch(rs1, rs2, offset, funct3):
    imm = offset & 0x1FFF
    return (
        (((imm >> 12) & 0x1) << 31)
        | (((imm >> 5) & 0x3F) << 25)
        | (rs2 << 20)
        | (rs1 << 15)
        | (funct3 << 12)
        | (((imm >> 1) & 0xF) << 8)
        | (((imm >> 11) & 0x1) << 7)
        | 0x63
    )


def beq(rs1, rs2, offset):
    return branch(rs1, rs2, offset, 0)


def bne(rs1, rs2, offset):
    return branch(rs1, rs2, offset, 1)


async def reset(dut):
    dut.rst_n.value = 0
    dut.cpu_enable.value = 0
    dut.stall_cpu_aw.value = 0
    dut.stall_cpu_w.value = 0
    dut.stall_cpu_ar.value = 0
    dut.loader_awvalid.value = 0
    dut.loader_awaddr.value = 0
    dut.loader_wvalid.value = 0
    dut.loader_wdata.value = 0
    dut.loader_wstrb.value = 0
    dut.loader_bready.value = 1
    dut.loader_arvalid.value = 0
    dut.loader_araddr.value = 0
    dut.loader_rready.value = 1
    dut.irq_sources.value = 0
    dut.timer_irq.value = 0
    dut.software_irq.value = 0
    await Timer(1, units="ns")
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def run_until_halted(dut, timeout_cycles):
    for _ in range(timeout_cycles):
        await RisingEdge(dut.clk)
        if int(dut.cpu_halted.value):
            return
    raise AssertionError("tiny CPU did not halt before timeout")


async def axil_write32(dut, addr, data, strobe=0xF):
    dut.loader_awaddr.value = addr
    dut.loader_wdata.value = data
    dut.loader_wstrb.value = strobe
    dut.loader_awvalid.value = 1
    dut.loader_wvalid.value = 1
    dut.loader_bready.value = 1

    while True:
        await Timer(1, units="ns")
        if int(dut.loader_awready.value) and int(dut.loader_wready.value):
            break
        await RisingEdge(dut.clk)

    await RisingEdge(dut.clk)
    dut.loader_awvalid.value = 0
    dut.loader_wvalid.value = 0

    while True:
        await Timer(1, units="ns")
        if int(dut.loader_bvalid.value):
            resp = int(dut.loader_bresp.value)
            break
        await RisingEdge(dut.clk)

    await RisingEdge(dut.clk)
    return resp


async def axil_read32(dut, addr):
    dut.loader_araddr.value = addr
    dut.loader_arvalid.value = 1
    dut.loader_rready.value = 1

    while True:
        await Timer(1, units="ns")
        if int(dut.loader_arready.value):
            break
        await RisingEdge(dut.clk)

    await RisingEdge(dut.clk)
    dut.loader_arvalid.value = 0

    while True:
        await Timer(1, units="ns")
        if int(dut.loader_rvalid.value):
            data = int(dut.loader_rdata.value)
            resp = int(dut.loader_rresp.value)
            break
        await RisingEdge(dut.clk)

    await RisingEdge(dut.clk)
    return data, resp


@cocotb.test()
async def tiny_cpu_fetches_executes_and_updates_soc_state(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    program = [
        lui(4, 0x80000),  # x4 = DRAM base
        addi(1, 0, 5),  # x1 = 5
        addi(2, 0, 7),  # x2 = 7
        add(3, 1, 2),  # x3 = 12
        sw(3, 0x100, 4),  # DRAM[0x80000100] = 12
        lui(5, 0x0C000),  # x5 = interrupt controller base
        addi(6, 0, 0b1010),  # enable sources 2 and 4
        sw(6, 0x008, 5),  # INTC.ENABLE = 0b1010
        0x00000073,  # ECALL: halt tiny core
    ]

    for index, instr in enumerate(program):
        assert await axil_write32(dut, 0x8000_0000 + index * 4, instr) == 0

    dut.cpu_enable.value = 1
    await run_until_halted(dut, 200)
    assert int(dut.cpu_halted.value) == 1

    dut.cpu_enable.value = 0
    await RisingEdge(dut.clk)

    data, resp = await axil_read32(dut, 0x8000_0100)
    assert resp == 0
    assert data == 12

    data, resp = await axil_read32(dut, 0x0C00_0008)
    assert resp == 0
    assert data & 0b1010 == 0b1010

    dut.irq_sources.value = 0b0010
    await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    assert int(dut.cpu_external_irq.value) == 1


@cocotb.test()
async def tiny_cpu_halts_on_unsupported_instruction_and_fetch_error(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    assert await axil_write32(dut, 0x8000_0000, 0xFFFF_FFFF) == 0

    dut.cpu_enable.value = 1
    await run_until_halted(dut, 32)
    assert int(dut.cpu_halted.value) == 1

    dut.cpu_enable.value = 0
    await RisingEdge(dut.clk)
    await reset(dut)

    program = [
        lui(1, 0x40000),  # x1 = unmapped fetch target
        0x00008067,  # JALR x0, 0(x1)
    ]
    for index, instr in enumerate(program):
        assert await axil_write32(dut, 0x8000_0000 + index * 4, instr) == 0

    dut.cpu_enable.value = 1
    await run_until_halted(dut, 64)
    assert int(dut.cpu_halted.value) == 1


@cocotb.test()
async def tiny_cpu_privileged_csr_and_trap_instructions_are_blocked_scaffold(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())

    for instr in (
        0x00100073,  # EBREAK: local halt only, not debug/trap entry
        0x30200073,  # MRET: privileged return is outside the tiny CPU subset
        0x300010F3,  # CSRRW x1, mstatus, x0 is outside the tiny CPU subset
    ):
        await reset(dut)
        assert await axil_write32(dut, 0x8000_0000, instr) == 0
        assert await axil_write32(dut, 0x8000_0004, 0xFFFF_FFFF) == 0

        dut.cpu_enable.value = 1
        await run_until_halted(dut, 32)
        assert int(dut.cpu_halted.value) == 1


@cocotb.test()
async def tiny_cpu_halts_on_unaligned_word_memory_before_bus_access(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    assert await axil_write32(dut, 0x8000_0100, 0) == 0
    program = [
        lui(1, 0x80000),  # x1 = DRAM base
        addi(2, 0, 99),  # x2 = value that must not be stored
        sw(2, 0x102, 1),  # unaligned SW must halt locally
        0x00000073,  # ECALL would only execute if SW advanced
    ]
    for index, instr in enumerate(program):
        assert await axil_write32(dut, 0x8000_0000 + index * 4, instr) == 0

    dut.cpu_enable.value = 1
    await run_until_halted(dut, 80)
    assert int(dut.cpu_halted.value) == 1

    dut.cpu_enable.value = 0
    await RisingEdge(dut.clk)
    data, resp = await axil_read32(dut, 0x8000_0100)
    assert resp == 0
    assert data == 0

    await reset(dut)
    program = [
        lui(1, 0x80000),  # x1 = DRAM base
        lw(2, 0x102, 1),  # unaligned LW must halt locally
        sw(2, 0x100, 1),  # must not execute
    ]
    for index, instr in enumerate(program):
        assert await axil_write32(dut, 0x8000_0000 + index * 4, instr) == 0

    dut.cpu_enable.value = 1
    await run_until_halted(dut, 80)
    assert int(dut.cpu_halted.value) == 1


@cocotb.test()
async def tiny_cpu_reset_identity_and_boot_boundary_are_explicit(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    assert int(dut.cpu_reset_pc.value) == 0x8000_0000
    assert int(dut.cpu_hart_id.value) == 0
    assert int(dut.cpu_halted.value) == 0

    program = [
        jal(0, 8),  # skip the illegal word at RESET_PC + 4
        0xFFFF_FFFF,  # must not execute if reset fetches at 0x80000000
        0x00000073,  # ECALL
    ]
    for index, instr in enumerate(program):
        assert await axil_write32(dut, 0x8000_0000 + index * 4, instr) == 0

    dut.cpu_enable.value = 1
    await run_until_halted(dut, 80)
    assert int(dut.cpu_halted.value) == 1


@cocotb.test()
async def tiny_cpu_halts_on_load_and_store_bus_errors(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    load_error_program = [
        lui(1, 0x40000),  # x1 = unmapped memory
        lw(2, 0, 1),  # mapped contract returns DECERR
        0x00000073,
    ]
    for index, instr in enumerate(load_error_program):
        assert await axil_write32(dut, 0x8000_0000 + index * 4, instr) == 0

    dut.cpu_enable.value = 1
    await run_until_halted(dut, 80)
    assert int(dut.cpu_halted.value) == 1

    dut.cpu_enable.value = 0
    await RisingEdge(dut.clk)
    await reset(dut)

    store_error_program = [
        lui(1, 0x40000),  # x1 = unmapped memory
        addi(2, 0, 1),
        sw(2, 0, 1),  # mapped contract returns DECERR
        0x00000073,
    ]
    for index, instr in enumerate(store_error_program):
        assert await axil_write32(dut, 0x8000_0000 + index * 4, instr) == 0

    dut.cpu_enable.value = 1
    await run_until_halted(dut, 100)
    assert int(dut.cpu_halted.value) == 1


@cocotb.test()
async def tiny_cpu_irq_inputs_are_pending_only_placeholders(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    assert int(dut.cpu_irq_pending.value) == 0
    dut.timer_irq.value = 1
    await RisingEdge(dut.clk)
    assert int(dut.cpu_irq_pending.value) == 1

    dut.timer_irq.value = 0
    dut.software_irq.value = 1
    await RisingEdge(dut.clk)
    assert int(dut.cpu_irq_pending.value) == 1
    assert int(dut.cpu_external_irq.value) == 0

    dut.software_irq.value = 0
    assert await axil_write32(dut, 0x0C00_0008, 0b0010) == 0
    data, resp = await axil_read32(dut, 0x0C00_0008)
    assert resp == 0
    assert data & 0b0010

    dut.irq_sources.value = 0b0010
    for _ in range(4):
        await RisingEdge(dut.clk)
        if int(dut.cpu_external_irq.value):
            break
    assert int(dut.cpu_external_irq.value) == 1
    assert int(dut.cpu_irq_pending.value) == 1


@cocotb.test()
async def tiny_cpu_extended_opcode_subset_has_observable_state(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    program = [
        lui(1, 0x80000),  # x1 = DRAM base
        addi(0, 0, 123),  # x0 must remain hardwired to zero
        addi(2, 0, 9),
        add(3, 2, 0),  # x3 = 9 if x0 stayed zero
        sub(4, 3, 2),  # x4 = 0
        sw(3, 0x120, 1),
        sw(4, 0x124, 1),
        lw(5, 0x120, 1),
        sw(5, 0x128, 1),
        beq(4, 0, 8),  # taken: skip illegal word
        0xFFFF_FFFF,
        bne(5, 4, 8),  # taken: skip illegal word
        0xFFFF_FFFF,
        jal(6, 8),  # taken: skip illegal word
        0xFFFF_FFFF,
        auipc(7, 0),  # x7 = PC of this instruction
        addi(7, 7, 16),  # target is four instructions ahead
        jalr(8, 7, 0),
        0xFFFF_FFFF,
        sw(3, 0x12C, 1),
        0x00000073,
    ]
    for index, instr in enumerate(program):
        assert await axil_write32(dut, 0x8000_0000 + index * 4, instr) == 0

    dut.cpu_enable.value = 1
    await run_until_halted(dut, 240)
    assert int(dut.cpu_halted.value) == 1

    dut.cpu_enable.value = 0
    await RisingEdge(dut.clk)
    for offset, expected in ((0x120, 9), (0x124, 0), (0x128, 9), (0x12C, 9)):
        data, resp = await axil_read32(dut, 0x8000_0000 + offset)
        assert resp == 0
        assert data == expected


@cocotb.test()
async def tiny_cpu_waits_for_fetch_and_store_request_stalls(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    program = [
        lui(1, 0x80000),
        addi(2, 0, 55),
        sw(2, 0x140, 1),
        0x00000073,
    ]
    for index, instr in enumerate(program):
        assert await axil_write32(dut, 0x8000_0000 + index * 4, instr) == 0

    dut.stall_cpu_ar.value = 1
    dut.stall_cpu_aw.value = 1
    dut.stall_cpu_w.value = 1
    dut.cpu_enable.value = 1
    for _ in range(12):
        await RisingEdge(dut.clk)
    assert int(dut.cpu_halted.value) == 0

    dut.stall_cpu_ar.value = 0
    for _ in range(40):
        await RisingEdge(dut.clk)
    assert int(dut.cpu_halted.value) == 0

    dut.stall_cpu_aw.value = 0
    dut.stall_cpu_w.value = 0
    await run_until_halted(dut, 120)

    dut.cpu_enable.value = 0
    await RisingEdge(dut.clk)
    data, resp = await axil_read32(dut, 0x8000_0140)
    assert resp == 0
    assert data == 55
