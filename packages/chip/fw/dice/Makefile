# E1 DICE CDI ladder — host KAT test + freestanding riscv64 target object.
#
#   make            # build + run the host test (KATs + determinism + divergence)
#   make host       # build build/dice/test_cdi_chain
#   make run        # build then run it (exit non-zero on any failure)
#   make target     # build the freestanding riscv64-unknown-elf object set
#   make clean
#
# The host test binary is written to ../../build/dice/test_cdi_chain, replacing
# the orphan prebuilt with a real, source-backed binary. Run `source
# ../../tools/env.sh` first so riscv64-unknown-elf-gcc is on PATH.

DICE_DIR   := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
CHIP_ROOT  := $(abspath $(DICE_DIR)/../..)
BUILD_DIR  := $(CHIP_ROOT)/build/dice
SECURE_DIR := $(CHIP_ROOT)/fw/boot-rom/secure

HOST_CC    ?= gcc
RISCV_CC   ?= riscv64-unknown-elf-gcc

WARN       := -Wall -Wextra -Werror -Wshadow -Wconversion
HOST_CFLAGS   ?= -std=c11 -O2 $(WARN) -fstack-protector-strong
TARGET_CFLAGS ?= -std=c11 -O2 $(WARN) -ffreestanding -fno-builtin \
                 -march=rv64imac_zicsr -mabi=lp64 -mcmodel=medany

# Library sources (no main): the CDI ladder, Ed25519 signer, shared SHA-256, and
# the CoVE attestation-quote producer.
LIB_SRCS := $(DICE_DIR)/cdi.c $(DICE_DIR)/ed25519_sign.c $(SECURE_DIR)/sha256.c \
            $(DICE_DIR)/cove_quote.c
TEST_SRC := $(DICE_DIR)/tests/test_cdi_chain.c
COVE_TEST_SRC := $(DICE_DIR)/tests/test_cove_quote.c
HEADERS := $(DICE_DIR)/cdi.h $(DICE_DIR)/ed25519_sign.h $(DICE_DIR)/cove_quote.h

HOST_BIN := $(BUILD_DIR)/test_cdi_chain
COVE_BIN := $(BUILD_DIR)/test_cove_quote
TARGET_OBJS := $(BUILD_DIR)/cdi.rv64.o $(BUILD_DIR)/ed25519_sign.rv64.o \
               $(BUILD_DIR)/sha256.rv64.o $(BUILD_DIR)/cove_quote.rv64.o

.PHONY: all host run cove cove-run target clean
all: run cove-run

host: $(HOST_BIN) $(COVE_BIN)

cove: $(COVE_BIN)

$(HOST_BIN): $(LIB_SRCS) $(TEST_SRC) $(HEADERS)
	@mkdir -p $(BUILD_DIR)
	$(HOST_CC) $(HOST_CFLAGS) -I$(DICE_DIR) -I$(SECURE_DIR) \
	    $(LIB_SRCS) $(TEST_SRC) -o $@

$(COVE_BIN): $(LIB_SRCS) $(COVE_TEST_SRC) $(HEADERS)
	@mkdir -p $(BUILD_DIR)
	$(HOST_CC) $(HOST_CFLAGS) -I$(DICE_DIR) -I$(SECURE_DIR) \
	    $(LIB_SRCS) $(COVE_TEST_SRC) -o $@

run: $(HOST_BIN)
	$(HOST_BIN)

# The CoVE KAT prints JSON on stdout, so route the test summary via stderr.
cove-run: $(COVE_BIN)
	$(COVE_BIN) >/dev/null

# Prove the ladder compiles for the RoT target. The boot ROM links its own
# crt/startup; here we only assert the translation units build freestanding.
target: $(TARGET_OBJS)

$(BUILD_DIR)/%.rv64.o: $(DICE_DIR)/%.c $(DICE_DIR)/cdi.h $(DICE_DIR)/ed25519_sign.h
	@mkdir -p $(BUILD_DIR)
	$(RISCV_CC) $(TARGET_CFLAGS) -I$(DICE_DIR) -I$(SECURE_DIR) -c $< -o $@

$(BUILD_DIR)/sha256.rv64.o: $(SECURE_DIR)/sha256.c $(SECURE_DIR)/sha256.h
	@mkdir -p $(BUILD_DIR)
	$(RISCV_CC) $(TARGET_CFLAGS) -I$(DICE_DIR) -I$(SECURE_DIR) -c $< -o $@

clean:
	rm -f $(HOST_BIN) $(COVE_BIN) $(TARGET_OBJS)
