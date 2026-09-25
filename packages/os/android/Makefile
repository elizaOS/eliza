# AOSP/Cuttlefish build and device tooling. Run `make help` for targets.
# Application sources resolve through scripts/eliza-source.ts. Builds need
# the pinned AOSP checkout and native toolchains; see README.md.

ARCH    ?= x86_64
AOSP_ROOT ?= $(HOME)/aosp
AOSP_GRIZZLY_ROOT ?= $(HOME)/aosp-grizzly
ARGS    ?=
SUPPORTED_ARCHES := x86_64 arm64 riscv64

ifneq ($(filter build-e1,$(MAKECMDGOALS)),)
ifneq ($(ARCH),riscv64)
$(error E1 simulator requires ARCH=riscv64)
endif
endif

# Reject incomplete bundle requests before make starts any prerequisites,
# including parallel vendor preparation and native builds.
ifneq ($(filter bundle-grizzly,$(MAKECMDGOALS)),)
ifeq ($(strip $(BUNDLE_DIR)),)
$(error BUNDLE_DIR is required)
endif
ifeq ($(strip $(SOURCE_DATE_EPOCH)),)
$(error SOURCE_DATE_EPOCH is required)
endif
endif

HERE      := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
REPO_ROOT := $(abspath $(HERE)/..)
DISTRO    := $(REPO_ROOT)/scripts/distro-android
VENDOR    := $(HERE)vendor/eliza
ELIZAOS_ELIZA_ROOT ?= $(shell node "$(REPO_ROOT)/scripts/eliza-source.ts")
ANDROID_AGENT_ASSETS := $(ELIZAOS_ELIZA_ROOT)/packages/app/platforms/android/app/src/main/assets/agent
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

.PHONY: stage-browser-apps help bootstrap bootstrap-grizzly prepare-grizzly preflight-grizzly evidence-grizzly attest-grizzly verify-grizzly provision-e1 build build-e1 build-grizzly bundle-grizzly native-inference native-inference-grizzly sim splash bootanimation check-arch

stage-browser-apps: check-arch
	node "$(DISTRO)/stage-browser-apps.ts" --arch "$(ARCH)" $(ARGS)

help:
	@echo "elizaOS Mobile (AOSP) targets:"
	@echo "  make stage-browser-apps ARCH=x86_64 ARGS=... # verify pinned Chromium + Bitwarden APKs"
	@echo "  make prepare-chromium-browser ARGS=\"--source ... --extension ... --out ... --certificate ...\""
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
	node "$(DISTRO)/bootstrap-aosp.ts" --repo-bin "$(REPO_LAUNCHER)" --aosp-root "$(AOSP_ROOT)" --jobs $(or $(JOBS),$(shell getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1))

bootstrap-grizzly: provision-repo
	node "$(DISTRO)/bootstrap-aosp.ts" --lock "$(HERE)pixel11pro.lock.json" --repo-bin "$(REPO_LAUNCHER)" --aosp-root "$(AOSP_GRIZZLY_ROOT)" --jobs $(or $(JOBS),$(shell getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1))

prepare-grizzly:
	node "$(DISTRO)/prepare-grizzly.ts" --lock "$(HERE)pixel11pro.lock.json" --aosp-root "$(AOSP_GRIZZLY_ROOT)"

preflight-grizzly:
	node "$(REPO_ROOT)/scripts/aosp/build-grizzly-bundle.ts" --aosp-root "$(AOSP_GRIZZLY_ROOT)" --preflight-only

provision-e1:
	node "$(DISTRO)/provision-cuttlefish-e1.ts" --lock "$(HERE)cuttlefish-e1.lock.json" --aosp-root "$(AOSP_ROOT)"

build: check-arch native-inference
	ELIZAOS_ELIZA_ROOT="$(ELIZAOS_ELIZA_ROOT)" $(if $(filter riscv64,$(ARCH)),,ELIZA_BUN_RISCV64_OPTIONAL=1) node "$(DISTRO)/build-aosp.ts" --brand-config "$(BRAND_CONFIG)" --aosp-root "$(AOSP_ROOT)" --rebuild-privileged-apk --launch --boot-validate $(ARGS)

build-e1: check-arch native-inference provision-e1
	ELIZAOS_ELIZA_ROOT="$(ELIZAOS_ELIZA_ROOT)" node "$(DISTRO)/build-aosp.ts" --brand-config "$(DISTRO)/brand.eliza-riscv64-e1.json" --aosp-root "$(AOSP_ROOT)" --rebuild-privileged-apk --launch --boot-validate $(ARGS)

native-inference: check-arch
	cd "$(ELIZAOS_ELIZA_ROOT)" && node packages/app/scripts/aosp/compile-libllama.ts --assets-dir "$(ANDROID_AGENT_ASSETS)" $(foreach target,$(INFERENCE_TARGETS),--target $(target))
	cd "$(ELIZAOS_ELIZA_ROOT)" && node packages/app/scripts/stage-elizavoice-lib.ts --abi arm64-v8a --variant cpu

native-inference-grizzly:
	cd "$(ELIZAOS_ELIZA_ROOT)" && node packages/app/scripts/aosp/compile-libllama.ts --assets-dir "$(ANDROID_AGENT_ASSETS)" --target android-arm64-cpu-fused
	cd "$(ELIZAOS_ELIZA_ROOT)" && node packages/app/scripts/stage-elizavoice-lib.ts --abi arm64-v8a --variant cpu

build-grizzly: prepare-grizzly native-inference-grizzly bootanimation
	ELIZAOS_ELIZA_ROOT="$(ELIZAOS_ELIZA_ROOT)" ELIZA_BUN_RISCV64_OPTIONAL=1 node "$(DISTRO)/build-aosp.ts" --brand-config "$(DISTRO)/brand.eliza-grizzly.json" --aosp-root "$(AOSP_GRIZZLY_ROOT)" --rebuild-privileged-apk $(ARGS)

ifneq ($(filter bundle-grizzly,$(MAKECMDGOALS)),)
prepare-grizzly native-inference-grizzly splash: | preflight-grizzly
endif

bundle-grizzly: preflight-grizzly prepare-grizzly native-inference-grizzly bootanimation
	ELIZAOS_ELIZA_ROOT="$(ELIZAOS_ELIZA_ROOT)" ELIZA_BUN_RISCV64_OPTIONAL=1 node "$(DISTRO)/build-aosp.ts" --brand-config "$(DISTRO)/brand.eliza-grizzly.json" --aosp-root "$(AOSP_GRIZZLY_ROOT)" --rebuild-privileged-apk --skip-build $(ARGS)
	ELIZAOS_ELIZA_ROOT="$(ELIZAOS_ELIZA_ROOT)" node "$(REPO_ROOT)/scripts/aosp/build-grizzly-bundle.ts" --aosp-root "$(AOSP_GRIZZLY_ROOT)" --output-dir "$(BUNDLE_DIR)" --jobs $(or $(JOBS),$(shell getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1))

evidence-grizzly:
	node "$(DISTRO)/grizzly-evidence.ts" $(ARGS)

attest-grizzly:
	node "$(DISTRO)/verify-grizzly-artifacts.ts" attest --aosp-root "$(AOSP_GRIZZLY_ROOT)" $(ARGS)

verify-grizzly:
	node "$(DISTRO)/verify-grizzly-artifacts.ts" check --manifest "$(MANIFEST)" --artifact-dir "$(DIR)"

sim: check-arch
	node "$(DISTRO)/sim.ts" --brand-config "$(BRAND_CONFIG)" --device-dir "$(DEVICE_DIR)" --aosp-root "$(AOSP_ROOT)" $(ARGS)

splash:
	node "$(HERE)../scripts/android/generate-eliza-bootanimation.ts"

bootanimation: splash
	node "$(HERE)../scripts/android/build-eliza-bootanimation.ts" --frames "$(VENDOR)/bootanimation" --out "$(VENDOR)/bootanimation/bootanimation.zip"

check-arch:
	$(if $(and $(filter 1,$(words $(ARCH))),$(filter $(SUPPORTED_ARCHES),$(ARCH))),@:, $(error Unsupported ARCH; use x86_64, arm64, or riscv64))

.PHONY: prepare-chromium-browser
prepare-chromium-browser:
	node "$(DISTRO)/prepare-chromium-browser.ts" $(ARGS)
