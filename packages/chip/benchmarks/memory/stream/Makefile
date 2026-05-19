# STREAM cross-compile rules for the RV64 Linux target.
#
# The default CC is the RISC-V cross toolchain.  If it is not on PATH the
# build fails closed; the resulting evidence is recorded as BLOCKED in
# docs/evidence/memory/stream_blocked_no_toolchain.json.
CC      ?= riscv64-unknown-linux-gnu-gcc
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
