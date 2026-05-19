# pd/asap7/Makefile — ASAP7 predictive 7nm FinFET shape flow
#
# This flow targets OpenROAD ORFS (OpenROAD-flow-scripts), not OpenLane 2.
# All outputs are PROJECTION ONLY, never signoff. See pd/asap7/README.md.
#
# Prerequisites:
#   - OpenROAD ORFS container (openroad/orfs:latest) or local install
#   - ASAP7 PDK checkout under external/pdks/asap7
#   - ORFS_FLOW_HOME pointing at an OpenROAD-flow-scripts checkout
#
# Usage:
#   make all              — run all blocks, emit projection_only shape reports
#   make big-core-shape   — run big-core wrapper
#   make npu-tile-shape   — run NPU tile
#   make slc-slice-shape  — run SLC slice
#   make leaf-shape       — run sub-block leaf (NPU register file slice)
#   make check            — preflight; do not run
#   make clone-asap7      — fetch the ASAP7 PDK into external/pdks/asap7
#
# Fail-closed discipline:
#   Every run-target exits with status 1 unless both the ASAP7 PDK and an ORFS
#   checkout / container are reachable. The check target documents exactly what
#   is missing so an operator can unblock the lane.

REPO_ROOT := $(shell cd ../.. && pwd)
ASAP7_ROOT ?= $(REPO_ROOT)/external/pdks/asap7
ASAP7_GIT_URL ?= https://github.com/The-OpenROAD-Project/asap7
ORFS_FLOW_HOME ?= $(REPO_ROOT)/external/OpenROAD-flow-scripts
ORFS_GIT_URL ?= https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts
ORFS_IMAGE ?= openroad/orfs:latest
EVIDENCE_DIR := $(REPO_ROOT)/docs/evidence/process/asap7
RTL_DIR := $(REPO_ROOT)/rtl
CONFIG := $(REPO_ROOT)/pd/asap7/config.asap7.yaml

# Sub-blocks under shape projection. Each block is sourced from rtl/ and run
# through ORFS per pd/asap7/config.asap7.yaml.
BLOCKS := big_core_shell npu_tile slc_slice
LEAF_BLOCKS := npu_tile_rf_leaf tage_table

# Default leaf module for `make leaf-shape MODULE=<name>`. When MODULE is set,
# leaf-shape runs only that module via the yosys+ABC synth-only driver. The
# default falls back to the npu_tile_rf_leaf ORFS path so existing automation
# is unchanged.
MODULE ?=

.PHONY: all $(BLOCKS:%=%-shape) leaf-shape leaf-synth check clone-asap7 clone-orfs preflight-doc

all: $(BLOCKS:%=%-shape) leaf-shape
	@echo "[asap7] all shape projection runs complete (predictive_only)."

# ---------------------------------------------------------------------------
# Preflight + lookup
# ---------------------------------------------------------------------------

define ASAP7_PRESENT
@if [ ! -d "$(ASAP7_ROOT)" ]; then \
    echo "BLOCKED: ASAP7 PDK not present at $(ASAP7_ROOT)"; \
    echo "         clone with:"; \
    echo "         make -C pd/asap7 clone-asap7"; \
    echo "         (or set ASAP7_ROOT to an existing checkout)"; \
    exit 1; \
fi
endef

define ORFS_PRESENT
@if [ ! -d "$(ORFS_FLOW_HOME)" ] && ! command -v docker >/dev/null 2>&1; then \
    echo "BLOCKED: neither ORFS_FLOW_HOME=$(ORFS_FLOW_HOME) nor docker is available"; \
    echo "         clone with: make -C pd/asap7 clone-orfs"; \
    echo "         or install docker and pull $(ORFS_IMAGE)"; \
    exit 1; \
fi
endef

# ---------------------------------------------------------------------------
# Block runners
# ---------------------------------------------------------------------------
# Each block target follows the same shape:
#   1. Ensure evidence directory exists.
#   2. Verify ASAP7 PDK + ORFS reachable.
#   3. Invoke ORFS for the block (Make-based ORFS flow) with ASAP7 platform.
#   4. Copy the post-route shape JSON into docs/evidence/process/asap7/.
#   5. Tag the output with evidence_class=predictive_finfet_shape_only.

big_core_shell-shape:
	@mkdir -p $(EVIDENCE_DIR)
	$(ASAP7_PRESENT)
	$(ORFS_PRESENT)
	@echo "[asap7] big_core_shell -> ORFS asap7 platform"
	@$(REPO_ROOT)/scripts/run_asap7_block.sh big_core_shell $(CONFIG) $(EVIDENCE_DIR) \
	    || (echo "BLOCKED: $(REPO_ROOT)/scripts/run_asap7_block.sh did not complete"; exit 1)

npu_tile-shape:
	@mkdir -p $(EVIDENCE_DIR)
	$(ASAP7_PRESENT)
	$(ORFS_PRESENT)
	@echo "[asap7] npu_tile -> ORFS asap7 platform"
	@$(REPO_ROOT)/scripts/run_asap7_block.sh npu_tile $(CONFIG) $(EVIDENCE_DIR) \
	    || (echo "BLOCKED: $(REPO_ROOT)/scripts/run_asap7_block.sh did not complete"; exit 1)

slc_slice-shape:
	@mkdir -p $(EVIDENCE_DIR)
	$(ASAP7_PRESENT)
	$(ORFS_PRESENT)
	@echo "[asap7] slc_slice -> ORFS asap7 platform"
	@$(REPO_ROOT)/scripts/run_asap7_block.sh slc_slice $(CONFIG) $(EVIDENCE_DIR) \
	    || (echo "BLOCKED: $(REPO_ROOT)/scripts/run_asap7_block.sh did not complete"; exit 1)

# leaf-shape: when MODULE is set, dispatch to the yosys+ABC synth-only driver
# (works without ORFS). When MODULE is empty, fall back to the legacy ORFS
# per-leaf list which currently contains only npu_tile_rf_leaf (ORFS gated).
leaf-shape:
	@if [ -n "$(MODULE)" ]; then \
	    $(MAKE) --no-print-directory -C . leaf-synth MODULE="$(MODULE)"; \
	else \
	    $(MAKE) --no-print-directory -C . $(LEAF_BLOCKS:%=%-shape); \
	fi
	@echo "[asap7] leaf-block shape projection complete (predictive_only)."

# leaf-synth: synth-only ABC mapping against the ASAP7 7p5t 27 nm RVT TT
# stdcell library. Produces docs/evidence/process/asap7/<module>_shape.json
# tagged predictive_finfet_shape_only_not_signoff. Does not require ORFS.
leaf-synth:
	@if [ -z "$(MODULE)" ]; then \
	    echo "BLOCKED: leaf-synth requires MODULE=<rtl_top> (e.g. make leaf-shape MODULE=tage_table)"; \
	    exit 1; \
	fi
	@mkdir -p $(EVIDENCE_DIR)
	$(ASAP7_PRESENT)
	@echo "[asap7] $(MODULE) -> yosys+ABC against asap7sc7p5t_27 RVT TT (synth-only)"
	@$(REPO_ROOT)/scripts/run_asap7_block.sh $(MODULE) $(CONFIG) $(EVIDENCE_DIR) \
	    || (echo "BLOCKED: $(REPO_ROOT)/scripts/run_asap7_block.sh did not complete"; exit 1)

npu_tile_rf_leaf-shape:
	@mkdir -p $(EVIDENCE_DIR)
	$(ASAP7_PRESENT)
	$(ORFS_PRESENT)
	@echo "[asap7] npu_tile_rf_leaf -> ORFS asap7 platform (leaf sub-block)"
	@$(REPO_ROOT)/scripts/run_asap7_block.sh npu_tile_rf_leaf $(CONFIG) $(EVIDENCE_DIR) \
	    || (echo "BLOCKED: $(REPO_ROOT)/scripts/run_asap7_block.sh did not complete"; exit 1)

tage_table-shape:
	@mkdir -p $(EVIDENCE_DIR)
	$(ASAP7_PRESENT)
	@echo "[asap7] tage_table -> yosys+ABC against asap7sc7p5t_27 RVT TT (synth-only leaf)"
	@$(REPO_ROOT)/scripts/run_asap7_block.sh tage_table $(CONFIG) $(EVIDENCE_DIR) \
	    || (echo "BLOCKED: $(REPO_ROOT)/scripts/run_asap7_block.sh did not complete"; exit 1)

# ---------------------------------------------------------------------------
# PDK + ORFS bootstrap (manual; never run inside the gates)
# ---------------------------------------------------------------------------

clone-asap7:
	@mkdir -p $(dir $(ASAP7_ROOT))
	@if [ -d "$(ASAP7_ROOT)" ]; then \
	    echo "ASAP7 PDK already present at $(ASAP7_ROOT)"; \
	else \
	    echo "Cloning ASAP7 PDK -> $(ASAP7_ROOT)"; \
	    git clone --depth 1 $(ASAP7_GIT_URL) $(ASAP7_ROOT); \
	fi

clone-orfs:
	@mkdir -p $(dir $(ORFS_FLOW_HOME))
	@if [ -d "$(ORFS_FLOW_HOME)" ]; then \
	    echo "ORFS already present at $(ORFS_FLOW_HOME)"; \
	else \
	    echo "Cloning OpenROAD-flow-scripts -> $(ORFS_FLOW_HOME)"; \
	    git clone --recursive $(ORFS_GIT_URL) $(ORFS_FLOW_HOME); \
	    echo "Now run: cd $(ORFS_FLOW_HOME) && ./setup.sh && make"; \
	fi

# ---------------------------------------------------------------------------
# Preflight (read-only; never invokes ORFS)
# ---------------------------------------------------------------------------

check:
	@echo "--- ASAP7 flow preflight (read-only) ---"
	@if [ -d "$(ASAP7_ROOT)" ]; then \
	    echo "  ASAP7 PDK   : OK  ($(ASAP7_ROOT))"; \
	else \
	    echo "  ASAP7 PDK   : MISSING (run: make -C pd/asap7 clone-asap7)"; \
	fi
	@if [ -d "$(ORFS_FLOW_HOME)" ]; then \
	    echo "  ORFS local  : OK  ($(ORFS_FLOW_HOME))"; \
	else \
	    echo "  ORFS local  : MISSING (run: make -C pd/asap7 clone-orfs)"; \
	fi
	@if command -v docker >/dev/null 2>&1; then \
	    echo "  Docker      : $$(docker --version 2>&1 | head -1)"; \
	else \
	    echo "  Docker      : not found (only required if ORFS local is missing)"; \
	fi
	@echo "  Container   : $(ORFS_IMAGE)"
	@echo "  RTL src dir : $(RTL_DIR)"
	@echo "  Evidence dir: $(EVIDENCE_DIR)"
	@echo "  Block list  : $(BLOCKS) $(LEAF_BLOCKS)"
	@echo "  Status      : predictive PDK; outputs are PROJECTION ONLY (never signoff)."

preflight-doc:
	@echo "ASAP7 flow contract:"
	@echo "  Outputs marked evidence_class=predictive_finfet_shape_only_not_signoff."
	@echo "  Consumed by scripts/project_ppa_to_n2p.py with documented vendor scaling factors."
	@echo "  Never cite ASAP7 numbers as TSMC N2P / A14 / Intel 14A / Samsung SF2P signoff."
