# Eliza E1 PMC firmware build.
#
# Targets:
#   make all          -> host-gcc compile-only sanity build (lints the C TUs).
#   make test         -> host-gcc unit tests (SPMI v2 master FSM).
#   make elf          -> RV32IMC linked ELF for AON SRAM (link.ld @ 0x10050000).
#   make sim-elf      -> RV32IMC linked ELF for the ibex_simple_system Verilator
#                        harness (link.sim.ld @ 0x00100000); smoke-load only.
#   make sizes        -> Report .text/.rodata/.data/.bss sizes for pmc.elf.
#   make clean

PMC_DIR   := $(abspath .)
SRC_DIR   := $(PMC_DIR)/src
INC_DIR   := $(PMC_DIR)/include
TEST_DIR  := $(PMC_DIR)/tests
BUILD_DIR := $(PMC_DIR)/build
RV_BUILD_DIR := $(BUILD_DIR)/rv32imc
SIM_BUILD_DIR := $(BUILD_DIR)/rv32imc-sim

# Host (lint) toolchain
HOST_CC ?= gcc
HOST_CFLAGS := -Wall -Wextra -Wno-unused-parameter -Werror -std=c11 -ffreestanding \
               -fno-builtin -I$(INC_DIR)
TEST_CFLAGS := -Wall -Wextra -Wno-unused-parameter -Werror -std=c11 \
               -DSPMI_HOSTED_UNIT_TEST -I$(INC_DIR)

# RV32IMC cross toolchain — xpack-riscv-none-elf-gcc on the repo's PATH via
# tools/env.sh. The chip CLAUDE.md mandates native binaries over Docker on
# Linux x64.
RV_CC      ?= riscv-none-elf-gcc
RV_OBJCOPY ?= riscv-none-elf-objcopy
RV_OBJDUMP ?= riscv-none-elf-objdump
RV_SIZE    ?= riscv-none-elf-size
RV_READELF ?= riscv-none-elf-readelf

RV_ARCH ?= rv32imc
RV_ABI  ?= ilp32

RV_CFLAGS := -march=$(RV_ARCH) -mabi=$(RV_ABI) -mcmodel=medany \
             -std=c11 -ffreestanding -fno-builtin -fdata-sections \
             -ffunction-sections -fvisibility=hidden \
             -Wall -Wextra -Wno-unused-parameter -Werror -Os -g \
             -I$(INC_DIR)
RV_ASFLAGS := -march=$(RV_ARCH) -mabi=$(RV_ABI) -x assembler-with-cpp \
              -I$(INC_DIR)
RV_LDFLAGS := -march=$(RV_ARCH) -mabi=$(RV_ABI) -mcmodel=medany \
              -nostartfiles -nostdlib -static \
              -Wl,--gc-sections -Wl,--no-warn-rwx-segments
RV_LIBS    := -lgcc

SRCS := \
	$(SRC_DIR)/main.c \
	$(SRC_DIR)/rpmi_server.c \
	$(SRC_DIR)/dvfs_arbiter.c \
	$(SRC_DIR)/pmic_sequencer.c \
	$(SRC_DIR)/spmi.c \
	$(SRC_DIR)/i2c.c \
	$(SRC_DIR)/thermal_policy.c \
	$(SRC_DIR)/droop_telemetry.c \
	$(SRC_DIR)/secure_boot.c

CRT0 := $(SRC_DIR)/crt0.S

HOST_OBJS := $(patsubst $(SRC_DIR)/%.c,$(BUILD_DIR)/%.o,$(SRCS))
RV_OBJS   := $(patsubst $(SRC_DIR)/%.c,$(RV_BUILD_DIR)/%.o,$(SRCS)) \
             $(RV_BUILD_DIR)/crt0.o
SIM_OBJS  := $(patsubst $(SRC_DIR)/%.c,$(SIM_BUILD_DIR)/%.o,$(SRCS)) \
             $(SIM_BUILD_DIR)/crt0.o

ELF     := $(BUILD_DIR)/pmc.elf
SIM_ELF := $(BUILD_DIR)/pmc.sim.elf
AON_HEX := $(BUILD_DIR)/pmc.aon.hex

TEST_SPMI_BIN := $(BUILD_DIR)/test_spmi

.PHONY: all clean test elf sim-elf aon-hex sizes

all: $(HOST_OBJS)
	@echo "fw/pmc: host-gcc compile-only sanity build complete ($(words $(HOST_OBJS)) objects)"

elf: $(ELF)
	@$(RV_SIZE) $(ELF)

sim-elf: $(SIM_ELF)
	@$(RV_SIZE) $(SIM_ELF)

# aon-hex: produce a $readmemh-compatible 32b/word hex of pmc.elf with the
# AON_SRAM origin (0x10050000) projected to word index 0. Used by the cocotb
# integration harness to preload `aon_sram_q` inside rtl/power/pmc_top.sv
# under +define+PMC_INSTANTIATE_IBEX. See docs/evidence/power/pmc-soc-
# integration-evidence.yaml.
aon-hex: $(AON_HEX)

sizes: $(ELF)
	@$(RV_SIZE) -A $(ELF)
	@$(RV_READELF) -S $(ELF)

$(BUILD_DIR)/%.o: $(SRC_DIR)/%.c | $(BUILD_DIR)
	$(HOST_CC) $(HOST_CFLAGS) -c $< -o $@

$(RV_BUILD_DIR)/%.o: $(SRC_DIR)/%.c | $(RV_BUILD_DIR)
	$(RV_CC) $(RV_CFLAGS) -c $< -o $@

$(RV_BUILD_DIR)/crt0.o: $(CRT0) | $(RV_BUILD_DIR)
	$(RV_CC) $(RV_ASFLAGS) -c $< -o $@

$(SIM_BUILD_DIR)/%.o: $(SRC_DIR)/%.c | $(SIM_BUILD_DIR)
	$(RV_CC) $(RV_CFLAGS) -c $< -o $@

$(SIM_BUILD_DIR)/crt0.o: $(CRT0) | $(SIM_BUILD_DIR)
	$(RV_CC) $(RV_ASFLAGS) -c $< -o $@

$(ELF): $(RV_OBJS) $(PMC_DIR)/link.ld | $(BUILD_DIR)
	$(RV_CC) $(RV_LDFLAGS) -Wl,-Map,$(@:.elf=.map) -T $(PMC_DIR)/link.ld $(RV_OBJS) -o $@ $(RV_LIBS)

# Verilog $readmemh image. AON_SRAM origin (0x10050000) maps to word 0 of
# the aon_sram_q array in pmc_top.sv. The conversion uses objcopy to emit a
# raw binary covering the AON aperture, then a small python projector emits
# one 32b hex word per line.
$(AON_HEX): $(ELF) $(PMC_DIR)/aon_elf_to_hex.py | $(BUILD_DIR)
	python3 $(PMC_DIR)/aon_elf_to_hex.py --elf $(ELF) --aon-origin 0x10050000 --aon-bytes 16384 --out $@

$(SIM_ELF): $(SIM_OBJS) $(PMC_DIR)/link.sim.ld | $(BUILD_DIR)
	$(RV_CC) $(RV_LDFLAGS) -Wl,-Map,$(@:.elf=.map) -T $(PMC_DIR)/link.sim.ld $(SIM_OBJS) -o $@ $(RV_LIBS)

$(BUILD_DIR) $(RV_BUILD_DIR) $(SIM_BUILD_DIR):
	@mkdir -p $@

test: $(TEST_SPMI_BIN)
	@$(TEST_SPMI_BIN)

$(TEST_SPMI_BIN): $(TEST_DIR)/test_spmi.c $(SRC_DIR)/spmi.c | $(BUILD_DIR)
	$(HOST_CC) $(TEST_CFLAGS) $(TEST_DIR)/test_spmi.c $(SRC_DIR)/spmi.c -o $@

clean:
	@rm -rf $(BUILD_DIR)
