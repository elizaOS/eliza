# elizaOS Mobile (AOSP) — emulator + build entry point.
#
# The discoverable front door for the AOSP/Cuttlefish fork, parallel to
# packages/os/linux/elizaos/Makefile for the Debian fork. It drives the
# brand-aware orchestrator in packages/scripts/distro-android with the
# elizaOS vendor overlay shipped in this package (vendor/eliza: the Eliza
# launcher, init.eliza.rc, sepolicy, privileged permissions, and the boot
# splash), so every emulated image boots straight into the elizaOS
# launcher with the elizaOS boot splash — on all three supported arches.
#
# Usage:
#   make build ARCH=x86_64               # build + launch + boot-validate a Cuttlefish image
#   make build ARCH=arm64
#   make build ARCH=riscv64
#   make sim   ARCH=riscv64              # bring up + validate an already-built image
#   make splash                          # render the elizaOS blue boot splash (needs ImageMagick)
#   make bootanimation                   # pack the splash frames into bootanimation.zip
#
# ARCH selects the brand config + Cuttlefish device dir; the eliza vendor
# overlay (launcher, splash, permissions) is arch-agnostic and shared by
# all three. Extra orchestrator flags pass through via ARGS="...".
#
# Real builds need a Linux x86_64 host with KVM and a synced AOSP checkout
# at AOSP_ROOT (default $HOME/aosp); see README.md. riscv64 Cuttlefish runs
# under QEMU TCG (no KVM) and boots slower — sim.mjs sizes its timeout for
# that automatically.

ARCH    ?= x86_64
AOSP_ROOT ?= $(HOME)/aosp
ARGS    ?=
SUPPORTED_ARCHES := x86_64 arm64 riscv64

HERE      := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
REPO_ROOT := $(abspath $(HERE)/../../..)
DISTRO    := $(REPO_ROOT)/packages/scripts/distro-android
VENDOR    := $(HERE)vendor/eliza

# ARCH -> brand config (x86_64 uses the unsuffixed default).
BRAND_x86_64  := brand.eliza.json
BRAND_arm64   := brand.eliza-arm64.json
BRAND_riscv64 := brand.eliza-riscv64.json
BRAND_CONFIG  := $(DISTRO)/$(BRAND_$(ARCH))

# ARCH -> Cuttlefish out/target/product/<deviceDir>. Must match
# PRODUCT_DEVICE in vendor/eliza/products/eliza_cf_<arch>_phone.mk: x86_64
# builds the single-ABI vsoc_x86_64_only device; arm64/riscv64 build the
# plain vsoc_<arch> devices (the *_only variants don't exist upstream for
# those arches).
DEVICE_DIR_x86_64  := vsoc_x86_64_only
DEVICE_DIR_arm64   := vsoc_arm64
DEVICE_DIR_riscv64 := vsoc_riscv64
DEVICE_DIR := $(DEVICE_DIR_$(ARCH))

.PHONY: help build sim splash bootanimation check-arch

help:
	@echo "elizaOS Mobile (AOSP) targets:"
	@echo "  make build ARCH=x86_64|arm64|riscv64   # build + launch + boot-validate"
	@echo "  make sim   ARCH=<arch>                  # validate an already-built image"
	@echo "  make splash                             # render elizaOS blue boot splash (needs ImageMagick)"
	@echo "  make bootanimation                      # pack splash frames into bootanimation.zip"
	@echo ""
	@echo "Run 'make bootanimation' on a host with ImageMagick before 'make build'"
	@echo "to bake the elizaOS splash into the image; otherwise the build falls"
	@echo "through to the stock AOSP boot animation (eliza_common.mk guards the copy)."

build: check-arch
	node $(DISTRO)/build-aosp.mjs --brand-config $(BRAND_CONFIG) --aosp-root $(AOSP_ROOT) --launch --boot-validate $(ARGS)

sim: check-arch
	node $(DISTRO)/sim.mjs --brand-config $(BRAND_CONFIG) --device-dir $(DEVICE_DIR) --aosp-root $(AOSP_ROOT) $(ARGS)

splash:
	node $(HERE)scripts/generate-eliza-bootanimation.mjs

bootanimation: splash
	node $(DISTRO)/build-bootanimation.mjs --frames $(VENDOR)/bootanimation --out $(VENDOR)/bootanimation/bootanimation.zip

check-arch:
	@case " $(SUPPORTED_ARCHES) " in \
	    *" $(ARCH) "*) ;; \
	    *) echo "ERROR: ARCH=$(ARCH) not in: $(SUPPORTED_ARCHES)" >&2; exit 64 ;; \
	esac
