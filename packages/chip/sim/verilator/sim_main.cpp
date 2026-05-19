#include "Ve1_chip_top.h"
#include "verilated.h"

#include <cstdint>
#include <cstdlib>
#include <iostream>

static vluint64_t main_time = 0;

double sc_time_stamp() { return main_time; }

static void tick(Ve1_chip_top* top) {
    top->CLK_IN = 0;
    top->eval();
    main_time++;
    top->CLK_IN = 1;
    top->eval();
    main_time++;
}

static void dbg_pulse(Ve1_chip_top* top, uint8_t dbg_addr, uint8_t dbg_wdata, bool dbg_write, bool dbg_launch = false) {
    top->DBG_ADDR = dbg_addr & 0xf;
    top->DBG_WDATA = dbg_wdata & 0xf;
    top->DBG_WRITE = dbg_write ? 1 : 0;
    top->DBG_LAUNCH = dbg_launch ? 1 : 0;
    top->DBG_VALID = 1;
    tick(top);
    top->DBG_VALID = 0;
    top->DBG_WRITE = 0;
    top->DBG_LAUNCH = 0;
}

static void load_addr(Ve1_chip_top* top, uint32_t addr) {
    for (int i = 0; i < 8; ++i) {
        dbg_pulse(top, i, (addr >> (4 * i)) & 0xf, true);
    }
}

static void load_wdata(Ve1_chip_top* top, uint32_t data) {
    for (int i = 0; i < 8; ++i) {
        dbg_pulse(top, 8 + i, (data >> (4 * i)) & 0xf, true);
    }
}

static uint8_t read_nibble(Ve1_chip_top* top, int index) {
    dbg_pulse(top, index, 0, false);
    top->eval();
    return top->DBG_RDATA & 0xf;
}

static void write32(Ve1_chip_top* top, uint32_t addr, uint32_t data) {
    load_addr(top, addr);
    load_wdata(top, data);
    dbg_pulse(top, 0, 0, true, true);
    tick(top);
}

static uint32_t read32(Ve1_chip_top* top, uint32_t addr) {
    load_addr(top, addr);
    dbg_pulse(top, 0, 0, false, true);
    tick(top);

    uint32_t value = 0;
    for (int i = 0; i < 8; ++i) {
        value |= static_cast<uint32_t>(read_nibble(top, i)) << (4 * i);
    }
    return value;
}

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    Ve1_chip_top* top = new Ve1_chip_top;

    top->RST_N = 0;
    top->DBG_VALID = 0;
    top->DBG_LAUNCH = 0;
    top->DBG_WRITE = 0;
    top->DBG_ADDR = 0;
    top->DBG_WDATA = 0;
    top->TEST_MODE = 0;
    top->JTAG_TCK = 0;
    top->JTAG_TMS = 0;
    top->JTAG_TDI = 0;
    for (int i = 0; i < 4; ++i) tick(top);
    top->RST_N = 1;
    for (int i = 0; i < 4; ++i) tick(top);

    if (read32(top, 0x00000000) != 0x4F50534F) return EXIT_FAILURE;
    write32(top, 0x10000008, 0x5a);
    if (read32(top, 0x10000008) != 0x5a) return EXIT_FAILURE;
    if (top->GPIO != 0x5a) return EXIT_FAILURE;

    write32(top, 0x10020000, 20);
    write32(top, 0x10020004, 22);
    write32(top, 0x1002000c, 1);
    for (int i = 0; i < 4; ++i) tick(top);
    if (read32(top, 0x10020008) != 42) return EXIT_FAILURE;

    std::cout << "e1_chip Verilator smoke passed\n";
    top->final();
    delete top;
    return EXIT_SUCCESS;
}
