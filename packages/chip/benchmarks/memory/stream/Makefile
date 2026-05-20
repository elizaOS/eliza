# STREAM cross-compile rules for the RV64 Linux target.
#
# `CC` is hard-coded to the first available RISC-V cross toolchain. Make's
# built-in CC default (`cc`) would silently compile a host x86 binary and
# dishonestly satisfy the gate; that is the failure mode this Makefile
# fails closed against. The build fails if the cross toolchain is missing,
# and the parent stream-bench target falls back to `make blocked-evidence`.
#
# Search order:
#   1. riscv64-unknown-linux-gnu-gcc  (kernel.org / xPack / SiFive)
#   2. riscv64-linux-gnu-gcc          (Debian / Ubuntu cross packages)
#   3. external/riscv64-linux-gnu/usr/bin/riscv64-linux-gnu-gcc
#      (repo-local Debian toolchain unpacked under external/)
override CC := $(shell command -v riscv64-unknown-linux-gnu-gcc \
                    || command -v riscv64-linux-gnu-gcc \
                    || echo ../../../external/riscv64-linux-gnu/usr/bin/riscv64-linux-gnu-gcc)
CFLAGS  ?= -O3 -static -Wall -Wextra -fopenmp
NTIMES  ?= 10
ARRAY   ?= 80000000

ARTIFACT_DIR ?= ../../../docs/evidence/memory

.PHONY: build run blocked-evidence clean

build: stream

stream: stream.c
	@if [ ! -x "$(CC)" ] && ! command -v $(CC) >/dev/null 2>&1; then \
	  echo "stream: $(CC) not found; marking BLOCKED"; \
	  exit 2; \
	fi
	# The repo-local Debian RV64 cross toolchain ships its private
	# libopcodes / libbfd under usr/lib/x86_64-linux-gnu; expose it
	# via LD_LIBRARY_PATH so binutils can resolve them when invoked
	# through the wrapper gcc binary.
	LD_LIBRARY_PATH="../../../external/riscv64-linux-gnu/usr/lib/x86_64-linux-gnu$${LD_LIBRARY_PATH:+:$$LD_LIBRARY_PATH}" \
	$(CC) $(CFLAGS) -DSTREAM_ARRAY_SIZE=$(ARRAY) -DNTIMES=$(NTIMES) \
	      stream.c -o stream

run: build
	@if [ ! -x ./stream ]; then echo "stream binary missing"; exit 1; fi
	@FILE_INFO=$$(file ./stream); \
	  case "$$FILE_INFO" in *RISC-V*) ;; \
	    *) echo "stream: refusing to run non-RISC-V binary ($$FILE_INFO)"; exit 2;; \
	  esac
	# Refuse to claim a bandwidth number on the x86 host: even if
	# qemu-user binfmt is registered, the resulting reading reflects
	# the host CPU + emulator throughput, not the LPDDR-attached RV64
	# target.  Real bandwidth claims must come from native silicon or
	# from a calibrated cycle-accurate DRAM simulator (DRAMSim3 /
	# Ramulator2 via compiler/runtime/dramsim_wrap/), not from
	# qemu-user emulation.
	@HOST_ARCH=$$(uname -m); \
	  if [ "$$HOST_ARCH" != "riscv64" ]; then \
	    echo "stream: refusing to run RV64 binary on $$HOST_ARCH host;" \
	         "qemu-user-emulated readings would dishonestly satisfy" \
	         "the bandwidth gate. Run on a real RV64 target."; \
	    exit 2; \
	  fi
	./stream > $(ARTIFACT_DIR)/stream_benchmark_report.json

blocked-evidence:
	@mkdir -p $(ARTIFACT_DIR)
	@HOST_ARCH=$$(uname -m); \
	 if [ -x ./stream ]; then \
	   BIN_SHA=$$(sha256sum ./stream | awk '{print $$1}'); \
	   BIN_SIZE=$$(stat --printf='%s' ./stream 2>/dev/null || stat -f %z ./stream); \
	   BIN_FILE=$$(file ./stream | sed -e 's/^[^:]*: //' -e 's/"/\\"/g'); \
	   printf '%s\n' \
	     '{' \
	     '  "schema": "eliza.memory.stream_blocked.v1",' \
	     '  "status": "built_blocked_no_runtime",' \
	     '  "reason": "RV64 STREAM binary cross-compiled; refused to run on '"$$HOST_ARCH"' host because qemu-user emulation cannot honestly satisfy the bandwidth gate.",' \
	     '  "expected_command": "make stream && # run on real RV64 target",' \
	     '  "cross_compiler": "$(CC)",' \
	     '  "binary_path": "benchmarks/memory/stream/stream",' \
	     '  "binary_sha256": "'"$$BIN_SHA"'",' \
	     '  "binary_size_bytes": '"$$BIN_SIZE"',' \
	     '  "binary_file_type": "'"$$BIN_FILE"'"' \
	     '}' > $(ARTIFACT_DIR)/stream_blocked_no_toolchain.json; \
	 else \
	   printf '%s\n' \
	     '{' \
	     '  "schema": "eliza.memory.stream_blocked.v1",' \
	     '  "status": "blocked_no_toolchain",' \
	     '  "reason": "RV64 cross toolchain ($(CC)) not available",' \
	     '  "expected_command": "make stream && ./stream"' \
	     '}' > $(ARTIFACT_DIR)/stream_blocked_no_toolchain.json; \
	 fi

clean:
	rm -f stream
