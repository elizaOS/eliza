# elizaOS Mobile (AOSP) — emulator + build entry point.
#
# The discoverable front door for the AOSP/Cuttlefish fork, parallel to
# linux/Justfile for the canonical Debian fork. It drives the
# brand-aware orchestrator in scripts/distro-android with the
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
#   make splash                          # render the elizaOS blue boot splash (uses sharp)
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
AOSP_GRIZZLY_ROOT ?= $(HOME)/aosp-grizzly
ARGS    ?=
SUPPORTED_ARCHES := x86_64 arm64 riscv64

HERE      := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
REPO_ROOT := $(abspath $(HERE)/..)
DISTRO    := $(REPO_ROOT)/scripts/distro-android
VENDOR    := $(HERE)vendor/eliza
ELIZAOS_ELIZA_ROOT ?= $(REPO_ROOT)/.eliza-source
ANDROID_AGENT_ASSETS := $(ELIZAOS_ELIZA_ROOT)/packages/app-core/platforms/android/app/src/main/assets/agent
REPO_LAUNCHER := $(HERE)cache/repo

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

INFERENCE_TARGETS_x86_64 := android-arm64-cpu-fused android-x86_64-cpu-fused
INFERENCE_TARGETS_arm64 := android-arm64-cpu-fused
INFERENCE_TARGETS_riscv64 := android-arm64-cpu-fused android-riscv64-cpu-fused
INFERENCE_TARGETS := $(INFERENCE_TARGETS_$(ARCH))

.PHONY: help bootstrap bootstrap-grizzly prepare-grizzly preflight-grizzly evidence-grizzly attest-grizzly verify-grizzly provision-e1 build build-e1 build-grizzly bundle-grizzly native-inference native-inference-grizzly sim splash bootanimation check-arch

help:
	@echo "elizaOS Mobile (AOSP) targets:"
	@echo "  make bootstrap                           # sync the pinned full AOSP checkout"
	@echo "  make bootstrap-grizzly                  # sync the pinned Pixel 11 Pro AOSP checkout"
	@echo "  make prepare-grizzly                    # generate grizzly vendor/device support from stock"
	@echo "  make preflight-grizzly                  # enforce the dedicated Pixel builder floor"
	@echo "  make build-grizzly                      # build the Pixel 11 Pro image (does not flash)"
	@echo "  make bundle-grizzly                     # build the complete Pixel 11 Pro flash handoff"
	@echo "  make evidence-grizzly                   # capture bootloader/adb/pstore boot evidence"
	@echo "  make attest-grizzly                     # (build host) verify staged images match the prepare stamp, write sha256 manifest"
	@echo "  make verify-grizzly MANIFEST=… DIR=…    # (flash host) verify local images against the attestation manifest"
	@echo "  make build ARCH=x86_64|arm64|riscv64   # build + launch + boot-validate"
	@echo "  make build-e1                           # build + validate the pinned E1 Cuttlefish simulator"
	@echo "  make sim   ARCH=<arch>                  # validate an already-built image"
	@echo "  make splash                             # render elizaOS blue boot splash (uses sharp)"
	@echo "  make bootanimation                      # pack splash frames into bootanimation.zip"
	@echo ""
	@echo "Run 'make bootanimation' before 'make build'"
	@echo "to bake the elizaOS splash into the image; otherwise the build falls"
	@echo "through to the stock AOSP boot animation (eliza_common.mk guards the copy)."

provision-repo: $(REPO_LAUNCHER)

$(REPO_LAUNCHER):
	bash $(DISTRO)/provision-repo.sh "$@"

bootstrap: provision-repo
	node $(DISTRO)/bootstrap-aosp.mjs --repo-bin "$(REPO_LAUNCHER)" --aosp-root $(AOSP_ROOT) --jobs $(or $(JOBS),$(shell getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1))

bootstrap-grizzly: provision-repo
	node $(DISTRO)/bootstrap-aosp.mjs --lock "$(HERE)pixel11pro.lock.json" --repo-bin "$(REPO_LAUNCHER)" --aosp-root "$(AOSP_GRIZZLY_ROOT)" --jobs $(or $(JOBS),$(shell getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1))

prepare-grizzly:
	node $(DISTRO)/prepare-grizzly.mjs --lock "$(HERE)pixel11pro.lock.json" --aosp-root "$(AOSP_GRIZZLY_ROOT)"

preflight-grizzly:
	node $(REPO_ROOT)/scripts/aosp/build-grizzly-bundle.mjs --aosp-root "$(AOSP_GRIZZLY_ROOT)" --preflight-only

provision-e1:
	node $(DISTRO)/provision-cuttlefish-e1.mjs --lock "$(HERE)cuttlefish-e1.lock.json" --aosp-root "$(AOSP_ROOT)"

build: check-arch native-inference
	ELIZAOS_ELIZA_ROOT="$(ELIZAOS_ELIZA_ROOT)" $(if $(filter riscv64,$(ARCH)),,ELIZA_BUN_RISCV64_OPTIONAL=1) node $(DISTRO)/build-aosp.mjs --brand-config $(BRAND_CONFIG) --aosp-root $(AOSP_ROOT) --rebuild-privileged-apk --launch --boot-validate $(ARGS)

build-e1: check-arch native-inference provision-e1
	@test "$(ARCH)" = "riscv64" || (echo "ERROR: E1 simulator is currently supported only on ARCH=riscv64" >&2; exit 64)
	ELIZAOS_ELIZA_ROOT="$(ELIZAOS_ELIZA_ROOT)" ELIZA_BUN_RISCV64_OPTIONAL=1 node $(DISTRO)/build-aosp.mjs --brand-config $(DISTRO)/brand.eliza-riscv64-e1.json --aosp-root $(AOSP_ROOT) --rebuild-privileged-apk --launch --boot-validate $(ARGS)

native-inference: check-arch
	cd "$(ELIZAOS_ELIZA_ROOT)" && node packages/app-core/scripts/aosp/compile-libllama.mjs --assets-dir "$(ANDROID_AGENT_ASSETS)" $(foreach target,$(INFERENCE_TARGETS),--target $(target))
	cd "$(ELIZAOS_ELIZA_ROOT)" && node packages/app-core/scripts/stage-elizavoice-lib.mjs --abi arm64-v8a --variant cpu

native-inference-grizzly:
	cd "$(ELIZAOS_ELIZA_ROOT)" && node packages/app-core/scripts/aosp/compile-libllama.mjs --assets-dir "$(ANDROID_AGENT_ASSETS)" --target android-arm64-cpu-fused
	cd "$(ELIZAOS_ELIZA_ROOT)" && node packages/app-core/scripts/stage-elizavoice-lib.mjs --abi arm64-v8a --variant cpu

build-grizzly: prepare-grizzly native-inference-grizzly bootanimation
	ELIZAOS_ELIZA_ROOT="$(ELIZAOS_ELIZA_ROOT)" ELIZA_BUN_RISCV64_OPTIONAL=1 node $(DISTRO)/build-aosp.mjs --brand-config $(DISTRO)/brand.eliza-grizzly.json --aosp-root "$(AOSP_GRIZZLY_ROOT)" --rebuild-privileged-apk $(ARGS)

bundle-grizzly: preflight-grizzly prepare-grizzly native-inference-grizzly bootanimation
	@test -n "$(BUNDLE_DIR)" || (echo "ERROR: BUNDLE_DIR is required" >&2; exit 64)
	@test -n "$$SOURCE_DATE_EPOCH" || (echo "ERROR: SOURCE_DATE_EPOCH is required" >&2; exit 64)
	ELIZAOS_ELIZA_ROOT="$(ELIZAOS_ELIZA_ROOT)" ELIZA_BUN_RISCV64_OPTIONAL=1 node $(DISTRO)/build-aosp.mjs --brand-config $(DISTRO)/brand.eliza-grizzly.json --aosp-root "$(AOSP_GRIZZLY_ROOT)" --rebuild-privileged-apk --skip-build $(ARGS)
	node $(REPO_ROOT)/scripts/aosp/build-grizzly-bundle.mjs --aosp-root "$(AOSP_GRIZZLY_ROOT)" --output-dir "$(BUNDLE_DIR)" --jobs $(or $(JOBS),$(shell getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1))

evidence-grizzly:
	node $(DISTRO)/grizzly-evidence.mjs $(ARGS)

attest-grizzly:
	node $(DISTRO)/verify-grizzly-artifacts.mjs attest --aosp-root "$(AOSP_GRIZZLY_ROOT)" $(ARGS)

verify-grizzly:
	node $(DISTRO)/verify-grizzly-artifacts.mjs check --manifest "$(MANIFEST)" --artifact-dir "$(DIR)"

sim: check-arch
	node $(DISTRO)/sim.mjs --brand-config $(BRAND_CONFIG) --device-dir $(DEVICE_DIR) --aosp-root $(AOSP_ROOT) $(ARGS)

splash:
	node $(HERE)../scripts/android/generate-eliza-bootanimation.mjs

bootanimation: splash
	node $(HERE)../scripts/android/build-eliza-bootanimation.mjs --frames $(VENDOR)/bootanimation --out $(VENDOR)/bootanimation/bootanimation.zip

check-arch:
	@case " $(SUPPORTED_ARCHES) " in \
	    *" $(ARCH) "*) ;; \
	    *) echo "ERROR: ARCH=$(ARCH) not in: $(SUPPORTED_ARCHES)" >&2; exit 64 ;; \
	esac
