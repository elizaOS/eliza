override CC := riscv64-unknown-linux-gnu-gcc
CFLAGS  ?= -O3 -static -Wall -Wextra -pthread
ARTIFACT_DIR ?= ../../../docs/evidence/memory

.PHONY: build run blocked-evidence clean

build: mlc_substitute

mlc_substitute: mlc_substitute.c
	@if ! command -v $(CC) >/dev/null 2>&1; then \
	  echo "mlc: $(CC) not found; marking BLOCKED"; \
	  exit 2; \
	fi
	$(CC) $(CFLAGS) mlc_substitute.c -o mlc_substitute -lm

run: build
	@mkdir -p $(ARTIFACT_DIR)
	@FILE_INFO=$$(file ./mlc_substitute); \
	  case "$$FILE_INFO" in *RISC-V*) ;; \
	    *) echo "mlc: refusing to run non-RISC-V binary ($$FILE_INFO)"; exit 2;; \
	  esac
	./mlc_substitute > $(ARTIFACT_DIR)/mlc_substitute_report.json

blocked-evidence:
	@mkdir -p $(ARTIFACT_DIR)
	@printf '%s\n' \
	  '{' \
	  '  "schema": "eliza.memory.mlc_substitute_blocked.v1",' \
	  '  "status": "blocked_no_toolchain",' \
	  '  "reason": "RV64 cross toolchain ($(CC)) not available"' \
	  '}' > $(ARTIFACT_DIR)/mlc_substitute_blocked.json

clean:
	rm -f mlc_substitute
