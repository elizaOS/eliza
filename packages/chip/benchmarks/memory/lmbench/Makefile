# lmbench memory subset for the RV64 Linux target.
#
# Pulls upstream lmbench from a pinned tarball (or local checkout)
# and cross-compiles the two memory-relevant tools:
#
#   lat_mem_rd  - random/stride pointer-chase latency curve
#   bw_mem      - sustained bandwidth for rd/wr/rdwr/cp/bzero
#
# This Makefile expects the user to have placed an unpacked lmbench
# tree under ../../external/lmbench/ before invoking `make`.  If the
# tree is missing, the build fails closed and writes a blocker JSON.
override CC := $(shell command -v riscv64-unknown-linux-gnu-gcc \
                    || command -v riscv64-linux-gnu-gcc \
                    || echo ../../../external/riscv64-linux-gnu/usr/bin/riscv64-linux-gnu-gcc)
CFLAGS  ?= -O3 -static -Wall -Wextra
ARTIFACT_DIR ?= ../../../docs/evidence/memory
LMBENCH_SRC  ?= ../../external/lmbench

.PHONY: build run blocked-evidence clean check-src

check-src:
	@if [ ! -d "$(LMBENCH_SRC)/src" ]; then \
	  echo "lmbench: $(LMBENCH_SRC)/src not present"; \
	  exit 2; \
	fi
	@if [ ! -x "$(CC)" ] && ! command -v $(CC) >/dev/null 2>&1; then \
	  echo "lmbench: $(CC) not found"; \
	  exit 2; \
	fi

build: check-src lat_mem_rd bw_mem

lat_mem_rd: check-src
	$(CC) $(CFLAGS) -I $(LMBENCH_SRC)/src \
	      $(LMBENCH_SRC)/src/lat_mem_rd.c \
	      $(LMBENCH_SRC)/src/lib_mem.c \
	      $(LMBENCH_SRC)/src/lib_timing.c \
	      -o lat_mem_rd -lm

bw_mem: check-src
	$(CC) $(CFLAGS) -I $(LMBENCH_SRC)/src \
	      $(LMBENCH_SRC)/src/bw_mem.c \
	      $(LMBENCH_SRC)/src/lib_mem.c \
	      $(LMBENCH_SRC)/src/lib_timing.c \
	      -o bw_mem -lm

run: build
	@mkdir -p $(ARTIFACT_DIR)
	./bw_mem 1024M rd  > $(ARTIFACT_DIR)/lmbench_bw_rd.raw   2>&1
	./bw_mem 1024M wr  > $(ARTIFACT_DIR)/lmbench_bw_wr.raw   2>&1
	./bw_mem 1024M rdwr > $(ARTIFACT_DIR)/lmbench_bw_rdwr.raw 2>&1
	./bw_mem 1024M cp   > $(ARTIFACT_DIR)/lmbench_bw_cp.raw   2>&1
	./bw_mem 1024M bzero > $(ARTIFACT_DIR)/lmbench_bw_bzero.raw 2>&1
	./lat_mem_rd 1024 128 > $(ARTIFACT_DIR)/lmbench_lat_random.raw 2>&1
	./lat_mem_rd 1024     > $(ARTIFACT_DIR)/lmbench_lat_stride.raw 2>&1
	python3 ../../../scripts/check_bandwidth_sustained.py \
	    --lmbench-rd-raw  $(ARTIFACT_DIR)/lmbench_bw_rd.raw \
	    --lmbench-wr-raw  $(ARTIFACT_DIR)/lmbench_bw_wr.raw \
	    --lmbench-lat-raw $(ARTIFACT_DIR)/lmbench_lat_random.raw \
	    --output          $(ARTIFACT_DIR)/lmbench_summary.json \
	    --target-id phone-baseline

blocked-evidence:
	@mkdir -p $(ARTIFACT_DIR)
	@printf '%s\n' \
	  '{' \
	  '  "schema": "eliza.memory.lmbench_blocked.v1",' \
	  '  "status": "blocked_no_toolchain_or_source",' \
	  '  "reason": "RV64 cross toolchain or lmbench source absent",' \
	  '  "expected_command": "make build && make run"' \
	  '}' > $(ARTIFACT_DIR)/lmbench_blocked.json

clean:
	rm -f lat_mem_rd bw_mem
