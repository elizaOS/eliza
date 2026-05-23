"""RVV 1.0 element-wise ALU subset verification.

Drives rtl/cpu/rvv/rvv_alu_subset.sv with random vtype (vsew), vl, vstart,
and operands, and checks every result element against a Python reference
model of the RVV 1.0 element-wise semantics this block implements:

  - active body (vstart <= e < vl): real per-element arithmetic/logic,
  - prefix (e < vstart):            undisturbed (old vd / vs3 preserved),
  - tail (e >= vl):                 vta=1 -> all-ones, vta=0 -> undisturbed,
  - vill:                           no compute, unsupported_o asserted.

This is the real-arithmetic gate: a zero-returning behavioral model would
fail every active-body element, so the test exercises genuine per-element
computation. It does NOT cover masking, widening/narrowing, reductions,
fixed-point saturation,
gather/scatter, slides, or vector memory — those are out of the subset and
the ALU asserts unsupported_o (or routes elsewhere) for them.
"""

from __future__ import annotations

import random

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

VLEN_BITS = 256
XLEN = 64

# funct3.
OPIVV = 0b000
OPIVI = 0b011
OPIVX = 0b100
OPMVV = 0b010
OPMVX = 0b110

# funct6.
F6 = {
    "add": 0b000000,
    "sub": 0b000010,
    "and": 0b001001,
    "or": 0b001010,
    "xor": 0b001011,
    "sll": 0b100101,
    "srl": 0b101000,
    "sra": 0b101001,
    "minu": 0b000100,
    "min": 0b000101,
    "maxu": 0b000110,
    "max": 0b000111,
    "mv": 0b010111,
    "mul": 0b100101,  # OPMVV / OPMVX
}

# vsew -> element bits.
SEW = {0: 8, 1: 16, 2: 32, 3: 64}


def mask(bits: int) -> int:
    return (1 << bits) - 1


def to_signed(v: int, bits: int) -> int:
    v &= mask(bits)
    return v - (1 << bits) if v & (1 << (bits - 1)) else v


def ref_elem(op: str, f3: int, a: int, b: int, sb: int) -> int:
    m = mask(sb)
    a &= m
    b &= m
    if op == "mul":
        return (a * b) & m
    if op == "add":
        return (a + b) & m
    if op == "sub":
        return (a - b) & m
    if op == "and":
        return a & b
    if op == "or":
        return a | b
    if op == "xor":
        return a ^ b
    sh = b & (sb - 1)
    if op == "sll":
        return (a << sh) & m
    if op == "srl":
        return (a >> sh) & m
    if op == "sra":
        return (to_signed(a, sb) >> sh) & m
    if op == "minu":
        return a if a < b else b
    if op == "maxu":
        return a if a > b else b
    if op == "min":
        return a if to_signed(a, sb) < to_signed(b, sb) else b
    if op == "max":
        return a if to_signed(a, sb) > to_signed(b, sb) else b
    if op == "mv":
        return b
    raise AssertionError(op)


def pack_vtype(vsew: int, vlmul: int = 0, vta: int = 0, vma: int = 0, vill: int = 0) -> int:
    # vtype_t packed struct (rvv_csr.sv), MSB..LSB:
    #   vill[71], reserved_hi[70:8], vma[7], vta[6], vsew[5:3], vlmul[2:0]
    # = 1 + 63 + 1 + 1 + 3 + 3 = 72 bits. cocotb drives it as an integer.
    val = vlmul & 0b111
    val |= (vsew & 0b111) << 3
    val |= (vta & 1) << 6
    val |= (vma & 1) << 7
    val |= (vill & 1) << 71
    return val


def pack_vec(elems: list[int], sb: int) -> int:
    v = 0
    for i, e in enumerate(elems):
        v |= (e & mask(sb)) << (i * sb)
    return v


def unpack_vec(v: int, sb: int, n: int) -> list[int]:
    return [(v >> (i * sb)) & mask(sb) for i in range(n)]


async def reset(dut) -> None:
    dut.rst_ni.value = 0
    dut.valid_i.value = 0
    dut.ready_i.value = 1
    dut.funct3_i.value = 0
    dut.funct6_i.value = 0
    dut.vl_i.value = 0
    dut.vstart_i.value = 0
    dut.vtype_i.value = pack_vtype(0)
    dut.tail_ones_i.value = 0
    dut.vs1_i.value = 0
    dut.vs2_i.value = 0
    dut.vs3_i.value = 0
    dut.rs1_i.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk_i)
    dut.rst_ni.value = 1
    await RisingEdge(dut.clk_i)


async def fire(dut, *, f3, f6, vsew, vl, vstart, vta, vs1, vs2, vs3, rs1) -> int:
    dut.funct3_i.value = f3
    dut.funct6_i.value = f6
    dut.vtype_i.value = pack_vtype(vsew, vta=vta)
    dut.vl_i.value = vl
    dut.vstart_i.value = vstart
    dut.tail_ones_i.value = vta
    dut.vs1_i.value = vs1
    dut.vs2_i.value = vs2
    dut.vs3_i.value = vs3
    dut.rs1_i.value = rs1
    dut.valid_i.value = 1
    await RisingEdge(dut.clk_i)
    dut.valid_i.value = 0
    # result registered same edge as busy goes high; valid_o asserts next.
    while dut.valid_o.value != 1:
        await RisingEdge(dut.clk_i)
    await Timer(1, units="ns")
    return int(dut.vd_o.value)


def model(op, f3, vsew, vl, vstart, vta, vs1_e, vs2_e, vs3_e, rs1) -> list[int]:
    sb = SEW[vsew]
    n = VLEN_BITS // sb
    out = list(vs3_e)  # default undisturbed
    for e in range(n):
        if e < vstart:
            out[e] = vs3_e[e]
        elif e < vl:
            b = vs1_e[e] if f3 in (OPIVV, OPMVV) else (rs1 & mask(sb))
            out[e] = ref_elem(op, f3, vs2_e[e], b, sb)
        else:
            out[e] = mask(sb) if vta else vs3_e[e]
    return out


@cocotb.test()
async def random_elementwise(dut):
    """Random vsew/vl/vstart/op over the full subset, all elements checked."""
    cocotb.start_soon(Clock(dut.clk_i, 10, units="ns").start())
    await reset(dut)
    rng = random.Random(0x5EED)

    vv_ops = [
        "add",
        "sub",
        "and",
        "or",
        "xor",
        "sll",
        "srl",
        "sra",
        "minu",
        "min",
        "maxu",
        "max",
        "mv",
    ]
    checks = 0
    for _ in range(400):
        vsew = rng.randint(0, 3)
        sb = SEW[vsew]
        n = VLEN_BITS // sb
        vl = rng.randint(0, n)
        vstart = rng.randint(0, min(vl, n)) if rng.random() < 0.4 else 0
        vta = rng.randint(0, 1)
        use_vx = rng.random() < 0.4
        use_mul = rng.random() < 0.2

        if use_mul:
            op = "mul"
            f3 = OPMVX if use_vx else OPMVV
        else:
            op = rng.choice(vv_ops)
            f3 = OPIVX if (use_vx and op != "mv") else OPIVV
            if op == "mv" and use_vx:
                f3 = OPIVX  # vmv.v.x

        vs1_e = [rng.getrandbits(sb) for _ in range(n)]
        vs2_e = [rng.getrandbits(sb) for _ in range(n)]
        vs3_e = [rng.getrandbits(sb) for _ in range(n)]
        rs1 = rng.getrandbits(XLEN)

        vd = await fire(
            dut,
            f3=f3,
            f6=F6[op],
            vsew=vsew,
            vl=vl,
            vstart=vstart,
            vta=vta,
            vs1=pack_vec(vs1_e, sb),
            vs2=pack_vec(vs2_e, sb),
            vs3=pack_vec(vs3_e, sb),
            rs1=rs1,
        )
        got = unpack_vec(vd, sb, n)
        exp = model(op, f3, vsew, vl, vstart, vta, vs1_e, vs2_e, vs3_e, rs1)
        assert got == exp, (
            f"op={op} f3={f3:#05b} vsew={vsew} vl={vl} vstart={vstart} "
            f"vta={vta}\n got={got}\n exp={exp}"
        )
        assert int(dut.unsupported_o.value) == 0, f"op={op} flagged unsupported"
        checks += 1

    assert checks > 0
    dut._log.info(f"checked {checks} random element-wise dispatches")


@cocotb.test()
async def vstart_prefix_undisturbed(dut):
    """Elements below vstart keep their old vd (vs3) value."""
    cocotb.start_soon(Clock(dut.clk_i, 10, units="ns").start())
    await reset(dut)
    vsew, sb = 2, 32
    n = VLEN_BITS // sb
    vs2_e = [0xFFFF_FFFF] * n
    vs1_e = [1] * n
    vs3_e = [0xDEAD_0000 + i for i in range(n)]
    vd = await fire(
        dut,
        f3=OPIVV,
        f6=F6["add"],
        vsew=vsew,
        vl=n,
        vstart=3,
        vta=0,
        vs1=pack_vec(vs1_e, sb),
        vs2=pack_vec(vs2_e, sb),
        vs3=pack_vec(vs3_e, sb),
        rs1=0,
    )
    got = unpack_vec(vd, sb, n)
    for e in range(3):
        assert got[e] == vs3_e[e], f"prefix elem {e} disturbed: {got[e]:#x}"
    for e in range(3, n):
        assert got[e] == ((0xFFFF_FFFF + 1) & mask(sb)), f"body elem {e}"


@cocotb.test()
async def tail_agnostic_ones(dut):
    """vta=1 sets tail elements (e >= vl) to all-ones."""
    cocotb.start_soon(Clock(dut.clk_i, 10, units="ns").start())
    await reset(dut)
    vsew, sb = 1, 16
    n = VLEN_BITS // sb
    vl = n // 2
    vs2_e = [5] * n
    vs1_e = [7] * n
    vs3_e = [0] * n
    vd = await fire(
        dut,
        f3=OPIVV,
        f6=F6["add"],
        vsew=vsew,
        vl=vl,
        vstart=0,
        vta=1,
        vs1=pack_vec(vs1_e, sb),
        vs2=pack_vec(vs2_e, sb),
        vs3=pack_vec(vs3_e, sb),
        rs1=0,
    )
    got = unpack_vec(vd, sb, n)
    for e in range(vl):
        assert got[e] == 12, f"body elem {e} = {got[e]}"
    for e in range(vl, n):
        assert got[e] == mask(sb), f"tail elem {e} not all-ones: {got[e]:#x}"


@cocotb.test()
async def vill_unsupported(dut):
    """vill=1 vtype asserts unsupported_o and computes nothing."""
    cocotb.start_soon(Clock(dut.clk_i, 10, units="ns").start())
    await reset(dut)
    dut.funct3_i.value = OPIVV
    dut.funct6_i.value = F6["add"]
    dut.vtype_i.value = pack_vtype(2, vill=1)
    dut.vl_i.value = 4
    dut.vstart_i.value = 0
    dut.tail_ones_i.value = 0
    dut.vs1_i.value = 0
    dut.vs2_i.value = 0
    dut.vs3_i.value = 0xCAFE
    dut.rs1_i.value = 0
    dut.valid_i.value = 1
    await RisingEdge(dut.clk_i)
    dut.valid_i.value = 0
    while dut.valid_o.value != 1:
        await RisingEdge(dut.clk_i)
    await Timer(1, units="ns")
    assert int(dut.unsupported_o.value) == 1, "vill did not flag unsupported"
