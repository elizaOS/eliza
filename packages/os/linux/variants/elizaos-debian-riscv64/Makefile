# elizaOS Debian RISC-V 64 — variant-local Makefile.
#
# Thin wrapper around the four real entry points of this variant:
#
#   1. Docker builder image          → build-image
#   2. live-build ISO build          → build
#   3. qemu-virt smoke boot          → qemu-boot / qemu-virt-boot
#   4. fail-closed release-manifest  → release-check / release-check-strict
#
# This Makefile does NOT reach outside its own directory. It does not edit
# the umbrella release manifest, it does not promote any artifact, and it
# does not fabricate evidence. Every target either runs a local script or
# delegates to Docker / Python with explicit args. Run `make help` for the
# full target list.

SHELL := /bin/sh
PYTHON ?= python3
DOCKER ?= docker
HERE := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
SCRIPTS := $(HERE)scripts
EVIDENCE_DIR := $(HERE)evidence
OUT_DIR := $(HERE)out
ISO ?=
EVIDENCE ?= $(EVIDENCE_DIR)/qemu_virt_boot.json
TRANSCRIPT ?= $(EVIDENCE_DIR)/qemu_virt_boot.transcript.log
MEMORY ?= 4096
CPUS ?= 4
TIMEOUT ?= 600
IMAGE_TAG ?= elizaos-debian-riscv64-builder

CHECK_SCRIPT := $(SCRIPTS)/check_release_manifest.py

.PHONY: help build-image build \
        qemu-boot qemu-virt-boot qemu-virt-boot-evidence qemu-virt-boot-test \
        release-check release-check-strict release-check-test

help:
	@echo "elizaOS Debian RISC-V 64 — make targets"
	@echo
	@echo "  build-image            Build the Docker builder image ($(IMAGE_TAG))."
	@echo "  build                  Run the builder to produce out/elizaos-debian-riscv64-<ts>.iso."
	@echo "  qemu-boot              Boot the newest ISO under qemu-system-riscv64 -M virt."
	@echo "  qemu-virt-boot         Same as qemu-boot but with explicit ISO=<path>."
	@echo "  qemu-virt-boot-evidence Validate an existing qemu-virt evidence JSON."
	@echo "  qemu-virt-boot-test    Run the qemu_virt_smoke unit tests."
	@echo "  release-check          Fail-closed release-manifest gate (BLOCKED is informational)."
	@echo "  release-check-strict   Same as release-check but BLOCKED counts as FAIL."
	@echo "  release-check-test     Run the release-manifest gate's unit + Hypothesis tests."
	@echo
	@echo "Variables (override with make VAR=value):"
	@echo "  DOCKER=$(DOCKER)"
	@echo "  PYTHON=$(PYTHON)"
	@echo "  IMAGE_TAG=$(IMAGE_TAG)"
	@echo "  OUT_DIR=$(OUT_DIR)"
	@echo "  EVIDENCE_DIR=$(EVIDENCE_DIR)"

build-image:
	$(DOCKER) build -t $(IMAGE_TAG) $(HERE)

build: build-image
	@mkdir -p $(OUT_DIR)
	$(DOCKER) run --rm --privileged \
	    -v "$(OUT_DIR):/work/out" \
	    $(IMAGE_TAG)

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

qemu-boot:
	@iso="$(ISO)"; \
	if [ -z "$$iso" ]; then \
	    iso=$$(ls -t $(OUT_DIR)/elizaos-debian-riscv64-*.iso 2>/dev/null | head -n 1); \
	fi; \
	if [ -z "$$iso" ]; then \
	    echo "qemu-boot: no ISO found; set ISO=<path> or run 'make build' first" >&2; \
	    exit 2; \
	fi; \
	$(MAKE) qemu-virt-boot ISO="$$iso"

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

release-check:
	$(PYTHON) $(CHECK_SCRIPT) --variant-dir $(HERE)

release-check-strict:
	$(PYTHON) $(CHECK_SCRIPT) --variant-dir $(HERE) --strict

release-check-test:
	@cd $(SCRIPTS) && $(PYTHON) -m unittest test_check_release_manifest -v
