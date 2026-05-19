#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "Ve1_soc_top.h"
#include "verilated.h"

static vluint64_t sim_time = 0;

static void tick(Ve1_soc_top& top) {
    top.clk = 0;
    top.eval();
    sim_time++;
    top.clk = 1;
    top.eval();
    sim_time++;
}

static void reset(Ve1_soc_top& top) {
    top.rst_n = 0;
    top.mmio_valid = 0;
    top.mmio_write = 0;
    top.mmio_addr = 0;
    top.mmio_wdata = 0;
    for (int i = 0; i < 4; i++) tick(top);
    top.rst_n = 1;
    tick(top);
}

static void write32(Ve1_soc_top& top, uint32_t addr, uint32_t data) {
    top.mmio_addr = addr;
    top.mmio_wdata = data;
    top.mmio_write = 1;
    top.mmio_valid = 1;
    tick(top);
    top.mmio_valid = 0;
    top.mmio_write = 0;
    tick(top);
}

static uint32_t read32(Ve1_soc_top& top, uint32_t addr) {
    top.mmio_addr = addr;
    top.mmio_write = 0;
    top.mmio_valid = 1;
    top.eval();
    uint32_t value = top.mmio_rdata;
    tick(top);
    top.mmio_valid = 0;
    tick(top);
    return value;
}

static uint32_t poll_done(Ve1_soc_top& top, uint32_t addr) {
    for (int i = 0; i < 256; i++) {
        uint32_t status = read32(top, addr);
        if (status & 0x2) return status;
    }
    std::fprintf(stderr, "timeout waiting for done\n");
    std::exit(1);
}

static int32_t read_s32(Ve1_soc_top& top, uint32_t addr) {
    return static_cast<int32_t>(read32(top, addr));
}

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    Ve1_soc_top top;
    reset(top);

    const int8_t a[2][3] = {{1, -2, 3}, {4, 5, -6}};
    const int8_t b[3][2] = {{7, -8}, {9, 10}, {-11, 12}};
    const int32_t golden[2][2] = {{-44, 8}, {139, -54}};
    std::vector<uint8_t> scratch(64, 0);

    uint32_t a_base = 0;
    uint32_t b_base = 6;
    uint32_t c_base = 12;
    for (int i = 0; i < 2; i++) {
        for (int k = 0; k < 3; k++) scratch[a_base + i * 3 + k] = static_cast<uint8_t>(a[i][k]);
    }
    for (int k = 0; k < 3; k++) {
        for (int j = 0; j < 2; j++) scratch[b_base + k * 2 + j] = static_cast<uint8_t>(b[k][j]);
    }
    for (int word = 0; word < 16; word++) {
        uint32_t value = 0;
        for (int byte = 0; byte < 4; byte++) value |= static_cast<uint32_t>(scratch[word * 4 + byte]) << (8 * byte);
        write32(top, 0x10020080u + word * 4, value);
    }

    write32(top, 0x1002005cu, 1);
    write32(top, 0x10020020u, 2 | (2 << 8) | (3 << 16));
    write32(top, 0x10020024u, a_base | (b_base << 8) | (c_base << 16));
    write32(top, 0x10020028u, 3 | (2 << 8) | (8 << 16));
    write32(top, 0x10020010u, 8);
    write32(top, 0x1002000cu, 1);

    uint32_t status = poll_done(top, 0x1002000cu);
    uint32_t unsupported_ops = read32(top, 0x1002002cu);
    uint32_t cycles = read32(top, 0x10020050u);
    uint32_t macs = read32(top, 0x10020054u);
    uint32_t ops = read32(top, 0x10020058u);
    uint32_t errors = read32(top, 0x1002005cu);
    if (status != 0x2 || unsupported_ops != 0 || cycles != 12 || macs != 12 || ops != 1 || errors != 0) {
        std::fprintf(
            stderr,
            "bad status/counters: status=0x%x unsupported=%u cycles=%u macs=%u ops=%u errors=%u\n",
            status,
            unsupported_ops,
            cycles,
            macs,
            ops,
            errors
        );
        return 1;
    }

    for (int i = 0; i < 2; i++) {
        for (int j = 0; j < 2; j++) {
            int32_t observed = read_s32(top, 0x10020080u + c_base + (i * 2 + j) * 4);
            if (observed != golden[i][j]) {
                std::fprintf(stderr, "C[%d][%d]=%d expected %d\n", i, j, observed, golden[i][j]);
                return 1;
            }
        }
    }

    std::printf("GEMM_S8 2x2x3 passed: cycles=%u macs=%u\n", cycles, macs);
    return 0;
}
