# pd/asap7/Makefile — ASAP7 predictive 7nm FinFET shape flow
#
# This flow targets OpenROAD ORFS (the OpenROAD project flow), not OpenLane 2.
# All outputs are PROJECTION ONLY, never signoff. See pd/asap7/README.md.
#
# Prerequisites:
#   - OpenROAD ORFS container or local install
#   - ASAP7 PDK checkout under external/pdks/asap7
#
# Usage:
#   make all              — run all blocks, emit projection_only shape reports
#   make big-core-shape   — run big-core wrapper
#   make npu-tile-shape   — run NPU tile
#   make slc-slice-shape  — run SLC slice
#   make check            — preflight; do not run

REPO_ROOT := $(shell cd ../.. && pwd)
ASAP7_ROOT ?= $(REPO_ROOT)/external/pdks/asap7
ORFS_IMAGE ?= openroad/orfs:latest
EVIDENCE_DIR := $(REPO_ROOT)/docs/evidence/process/asap7

.PHONY: all big-core-shape npu-tile-shape slc-slice-shape check

all: big-core-shape npu-tile-shape slc-slice-shape
	@echo "ASAP7 shape projection runs complete (predictive_only)."

big-core-shape:
	@mkdir -p $(EVIDENCE_DIR)
	@if [ ! -d "$(ASAP7_ROOT)" ]; then \
	    echo "BLOCKED: ASAP7 PDK not present at $(ASAP7_ROOT)"; \
	    echo "         clone https://github.com/The-OpenROAD-Project/asap7"; \
	    exit 1; \
	fi
	@echo "Running ASAP7 ORFS flow for big_core_shell -> shape report"
	@echo "(implementation invokes ORFS container; see README.md)"
	@exit 1   # fail-closed until ORFS is wired

npu-tile-shape:
	@mkdir -p $(EVIDENCE_DIR)
	@if [ ! -d "$(ASAP7_ROOT)" ]; then \
	    echo "BLOCKED: ASAP7 PDK not present at $(ASAP7_ROOT)"; \
	    exit 1; \
	fi
	@echo "Running ASAP7 ORFS flow for npu_tile -> shape report"
	@exit 1

slc-slice-shape:
	@mkdir -p $(EVIDENCE_DIR)
	@if [ ! -d "$(ASAP7_ROOT)" ]; then \
	    echo "BLOCKED: ASAP7 PDK not present at $(ASAP7_ROOT)"; \
	    exit 1; \
	fi
	@echo "Running ASAP7 ORFS flow for slc_slice -> shape report"
	@exit 1

check:
	@echo "--- ASAP7 flow preflight ---"
	@if [ -d "$(ASAP7_ROOT)" ]; then \
	    echo "ASAP7 PDK : OK  ($(ASAP7_ROOT))"; \
	else \
	    echo "ASAP7 PDK : MISSING (clone https://github.com/The-OpenROAD-Project/asap7 to $(ASAP7_ROOT))"; \
	fi
	@if command -v docker >/dev/null 2>&1; then \
	    echo "Docker    : $$(docker --version 2>&1 | head -1)"; \
	else \
	    echo "Docker    : not found"; \
	fi
	@echo "Container : $(ORFS_IMAGE)"
	@echo "Evidence  : $(EVIDENCE_DIR)"
	@echo "Status    : predictive PDK; outputs are PROJECTION ONLY."
