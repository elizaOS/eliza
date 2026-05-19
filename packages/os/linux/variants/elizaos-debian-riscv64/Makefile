# elizaOS Debian RISC-V 64 — variant-local Makefile.
#
# The build orchestrator (build.sh) is invoked from the Dockerfile and the
# release pipeline directly. This Makefile owns the QEMU-virt boot harness
# that consumes the live ISO produced by build.sh and emits transcript-only
# evidence.

SHELL := /bin/sh
PYTHON ?= python3
HERE := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
SCRIPTS := $(HERE)scripts
EVIDENCE_DIR := $(HERE)evidence
ISO ?=
EVIDENCE ?= $(EVIDENCE_DIR)/qemu_virt_boot.json
TRANSCRIPT ?= $(EVIDENCE_DIR)/qemu_virt_boot.transcript.log
MEMORY ?= 4096
CPUS ?= 4
TIMEOUT ?= 600

.PHONY: qemu-virt-boot qemu-virt-boot-evidence qemu-virt-boot-test

qemu-virt-boot:
	@if [ -z "$(ISO)" ]; then \
	    echo "qemu-virt-boot: ISO=<path-to-live.iso> is required" >&2; \
	    exit 2; \
	fi
	@$(PYTHON) $(SCRIPTS)/qemu_virt_smoke.py \
	    --iso "$(ISO)" \
	    --memory $(MEMORY) \
	    --cpus $(CPUS) \
	    --timeout $(TIMEOUT) \
	    --evidence "$(EVIDENCE)" \
	    --transcript "$(TRANSCRIPT)"

qemu-virt-boot-evidence:
	@if [ ! -f "$(EVIDENCE)" ]; then \
	    echo "qemu-virt-boot-evidence: no evidence at $(EVIDENCE) — run qemu-virt-boot first" >&2; \
	    exit 1; \
	fi
	@$(PYTHON) -c "import sys; sys.path.insert(0, '$(SCRIPTS)'); \
	from qemu_virt_smoke import load_evidence, validate_evidence; \
	from pathlib import Path; \
	doc = load_evidence(Path('$(EVIDENCE)')); \
	validate_evidence(doc); \
	print('qemu-virt-boot-evidence: schema OK, boot_completed=' + str(doc['boot_completed']))"

qemu-virt-boot-test:
	@cd $(HERE) && $(PYTHON) -m unittest scripts.test_qemu_virt_smoke -v
