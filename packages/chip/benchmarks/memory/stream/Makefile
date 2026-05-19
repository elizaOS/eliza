# STREAM cross-compile rules for the RV64 Linux target.
#
# `CC` is hard-coded to the RISC-V cross toolchain. Make's built-in CC
# default (`cc`) would silently compile a host x86 binary and dishonestly
# satisfy the gate; that is the failure mode this Makefile fails closed
# against. The build fails if the cross toolchain is missing, and the
# parent stream-bench target falls back to `make blocked-evidence`.
override CC := riscv64-unknown-linux-gnu-gcc
CFLAGS  ?= -O3 -static -Wall -Wextra -fopenmp
NTIMES  ?= 10
ARRAY   ?= 80000000

ARTIFACT_DIR ?= ../../../docs/evidence/memory

.PHONY: build run blocked-evidence clean

build: stream

stream: stream.c
	@if ! command -v $(CC) >/dev/null 2>&1; then \
	  echo "stream: $(CC) not found; marking BLOCKED"; \
	  exit 2; \
	fi
	$(CC) $(CFLAGS) -DSTREAM_ARRAY_SIZE=$(ARRAY) -DNTIMES=$(NTIMES) \
	      stream.c -o stream

run: build
	@if [ ! -x ./stream ]; then echo "stream binary missing"; exit 1; fi
	@FILE_INFO=$$(file ./stream); \
	  case "$$FILE_INFO" in *RISC-V*) ;; \
	    *) echo "stream: refusing to run non-RISC-V binary ($$FILE_INFO)"; exit 2;; \
	  esac
	./stream > $(ARTIFACT_DIR)/stream_benchmark_report.json

blocked-evidence:
	@mkdir -p $(ARTIFACT_DIR)
	@printf '%s\n' \
	  '{' \
	  '  "schema": "eliza.memory.stream_blocked.v1",' \
	  '  "status": "blocked_no_toolchain",' \
	  '  "reason": "RV64 cross toolchain ($(CC)) not available",' \
	  '  "expected_command": "make stream && ./stream"' \
	  '}' > $(ARTIFACT_DIR)/stream_blocked_no_toolchain.json

clean:
	rm -f stream
