# Eliza E1 PMC firmware build.
#
# Targets:
#   make all  -> compile-only sanity check using host gcc + -ffreestanding flags
#                so we can lint the skeleton without RV32 toolchain in PATH.
#                Replace with riscv-none-elf-gcc once Ibex source is pinned.
#   make test -> host-gcc unit tests for the SPMI v2 master FSM (no
#                -ffreestanding; links the loopback peripheral in tests/).
#   make clean

PMC_DIR   := $(abspath .)
SRC_DIR   := $(PMC_DIR)/src
INC_DIR   := $(PMC_DIR)/include
TEST_DIR  := $(PMC_DIR)/tests
BUILD_DIR := $(PMC_DIR)/build

CC ?= gcc
CFLAGS := -Wall -Wextra -Wno-unused-parameter -Werror -std=c11 -ffreestanding \
          -fno-builtin -I$(INC_DIR)

# Host-test flags drop -ffreestanding so libc (assert/printf) is available and
# define SPMI_HOSTED_UNIT_TEST so spmi.c omits its MMIO production bind point.
TEST_CFLAGS := -Wall -Wextra -Wno-unused-parameter -Werror -std=c11 \
               -DSPMI_HOSTED_UNIT_TEST -I$(INC_DIR)

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

OBJS := $(patsubst $(SRC_DIR)/%.c,$(BUILD_DIR)/%.o,$(SRCS))

TEST_SPMI_BIN := $(BUILD_DIR)/test_spmi

.PHONY: all clean test

all: $(OBJS)
	@echo "fw/pmc: compile-only sanity build complete ($(words $(OBJS)) objects)"

$(BUILD_DIR)/%.o: $(SRC_DIR)/%.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD_DIR):
	@mkdir -p $(BUILD_DIR)

test: $(TEST_SPMI_BIN)
	@$(TEST_SPMI_BIN)

$(TEST_SPMI_BIN): $(TEST_DIR)/test_spmi.c $(SRC_DIR)/spmi.c | $(BUILD_DIR)
	$(CC) $(TEST_CFLAGS) $(TEST_DIR)/test_spmi.c $(SRC_DIR)/spmi.c -o $@

clean:
	@rm -rf $(BUILD_DIR)
