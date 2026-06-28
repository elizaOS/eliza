CC      ?= riscv64-unknown-linux-gnu-gcc
CFLAGS  ?= -O2 -static -Wall -Wextra
ARTIFACT_DIR ?= ../../../docs/evidence/memory

.PHONY: build run blocked-evidence clean

build: dma_buf_stale_test

dma_buf_stale_test: dma_buf_stale_test.c
	@if ! command -v $(CC) >/dev/null 2>&1; then \
	  echo "dma-buf-negative: $(CC) not found"; \
	  exit 2; \
	fi
	$(CC) $(CFLAGS) dma_buf_stale_test.c -o dma_buf_stale_test

run: build
	@mkdir -p $(ARTIFACT_DIR)
	./dma_buf_stale_test > $(ARTIFACT_DIR)/shared_buffer_negative_sync_report.json || true

blocked-evidence:
	@mkdir -p $(ARTIFACT_DIR)
	@printf '%s\n' \
	  '{' \
	  '  "schema": "eliza.memory.dma_buf_negative_blocked.v1",' \
	  '  "status": "blocked_no_toolchain_or_kernel_headers"' \
	  '}' > $(ARTIFACT_DIR)/dma_buf_negative_blocked.json

clean:
	rm -f dma_buf_stale_test
