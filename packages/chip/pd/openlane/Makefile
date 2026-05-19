# pd/openlane/Makefile — OpenLane 2 flow targets for e1 chip
#
# Prerequisites:
#   pip3 install openlane volare
#   volare enable --pdk sky130 latest
#
# Usage:
#   make pd           — full e1_chip_top run (4–8 h)
#   make pd-smoke     — small e1_pd_smoke_top run (~2 min)
#   make pd-check     — check prerequisites only, do not run
#   make pd-synth-only — synthesis step only (fast sanity check)
#   make clean-pd     — delete all run directories

REPO_ROOT := $(shell cd ../.. && pwd)
PDK_ROOT  ?= $(HOME)/.volare

.PHONY: pd pd-smoke pd-check pd-synth-only clean-pd

pd:
	bash $(CURDIR)/run.sh

pd-smoke:
	bash $(CURDIR)/run.sh --smoke

pd-check:
	@echo "--- Checking PD prerequisites ---"
	@if command -v openlane >/dev/null 2>&1; then \
	    openlane --version 2>&1 | head -1 | sed 's/^/OpenLane:  /'; \
	else \
	    echo "OpenLane:  MISSING (pip3 install openlane)"; \
	fi
	@if [ -d "$(PDK_ROOT)/sky130A" ]; then \
	    echo "SKY130A:   OK  ($(PDK_ROOT)/sky130A)"; \
	else \
	    echo "SKY130A:   MISSING (volare enable --pdk sky130 latest)"; \
	fi
	@if command -v docker >/dev/null 2>&1; then \
	    docker version --format 'Docker:    {{.Server.Version}}' 2>/dev/null || \
	    echo "Docker:    installed but daemon not running"; \
	else \
	    echo "Docker:    not found (optional fallback)"; \
	fi

pd-synth-only:
	@echo "--- Synthesis only (yosys.JsonHDL) ---"
	@mkdir -p $(REPO_ROOT)/build/pd
	openlane \
	    --from-step yosys.JsonHDL \
	    --to-step   yosys.Synthesis \
	    config.sky130.json \
	    2>&1 | tee $(REPO_ROOT)/build/pd/synth_only.log

clean-pd:
	@echo "Removing run directories under pd/openlane/runs/ ..."
	rm -rf $(REPO_ROOT)/pd/openlane/runs/RUN_*
	@echo "Done."
