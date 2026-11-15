# AOSP/Cuttlefish build and device tooling. Run `make help` for targets.
# Application sources resolve through scripts/eliza-source.ts. Builds need
# the pinned AOSP checkout and native toolchains; see README.md.

ARCH    ?= x86_64
AOSP_ROOT ?= $(HOME)/aosp
ARGS    ?=
SUPPORTED_ARCHES := x86_64 arm64

HERE      := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
REPO_ROOT := $(abspath $(HERE)/..)
DISTRO    := $(REPO_ROOT)/scripts/android
VENDOR    := $(HERE)vendor/eliza
ELIZAOS_ELIZA_ROOT ?= $(shell node "$(REPO_ROOT)/scripts/eliza-source.ts")
ANDROID_AGENT_ASSETS := $(ELIZAOS_ELIZA_ROOT)/packages/app/platforms/android/app/src/main/assets/agent
REPO_LAUNCHER := $(HERE)cache/repo

# ARCH -> brand config (x86_64 uses the unsuffixed default).
BRAND_x86_64  := brand.eliza.json
BRAND_arm64   := brand.eliza-arm64.json
BRAND_CONFIG  := $(DISTRO)/$(BRAND_$(ARCH))

# ARCH -> Cuttlefish out/target/product/<deviceDir>. Must match
# PRODUCT_DEVICE in vendor/eliza/products/eliza_cf_<arch>_phone.mk: x86_64
# builds the single-ABI vsoc_x86_64_only device; arm64 builds the plain
# vsoc_arm64 device (the *_only variant doesn't exist upstream for it).
DEVICE_DIR_x86_64  := vsoc_x86_64_only
DEVICE_DIR_arm64   := vsoc_arm64
DEVICE_DIR := $(DEVICE_DIR_$(ARCH))

INFERENCE_TARGETS_x86_64 := android-arm64-cpu-fused android-x86_64-cpu-fused
INFERENCE_TARGETS_arm64 := android-arm64-cpu-fused
INFERENCE_TARGETS := $(INFERENCE_TARGETS_$(ARCH))

.PHONY: stage-pixel10a-eliza stage-pixel10a stage-browser-apps help bootstrap build native-inference sim splash bootanimation check-arch

stage-pixel10a-eliza:
	node "$(DISTRO)/stage-pixel10a-product.ts" --product "$(HERE)products/pixel10a-eliza.json" $(ARGS)

stage-pixel10a:
	node "$(DISTRO)/stage-pixel10a-product.ts" $(ARGS)

stage-browser-apps: check-arch
	node "$(DISTRO)/stage-browser-apps.ts" --arch "$(ARCH)" $(ARGS)

help:
	@echo "elizaOS Mobile (AOSP) targets:"
	@echo "  make stage-pixel10a ARGS=...            # explicit shared least-privilege Pixel 10a product staging"
	@echo "  make stage-browser-apps ARCH=x86_64 ARGS=... # verify pinned Chromium + Bitwarden APKs"
	@echo "  make prepare-chromium-browser ARGS=\"--source ... --extension ... --out ... --certificate ...\""
	@echo "  make bootstrap                           # sync the pinned full AOSP checkout"
	@echo "  make build ARCH=x86_64|arm64           # build + launch + boot-validate"
	@echo "  make sim   ARCH=<arch>                  # validate an already-built image"
	@echo "  make splash                             # render the boot splash (ELIZA_WHITELABEL_DIR brands it)"
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

build: check-arch native-inference
	ELIZAOS_ELIZA_ROOT="$(ELIZAOS_ELIZA_ROOT)" node "$(DISTRO)/build-aosp.ts" --brand-config "$(BRAND_CONFIG)" --aosp-root "$(AOSP_ROOT)" --rebuild-launcher-apk --launch --boot-validate $(ARGS)

native-inference: check-arch
	cd "$(ELIZAOS_ELIZA_ROOT)" && node packages/app/scripts/aosp/compile-libllama.ts --assets-dir "$(ANDROID_AGENT_ASSETS)" $(foreach target,$(INFERENCE_TARGETS),--target $(target))
	cd "$(ELIZAOS_ELIZA_ROOT)" && node packages/app/scripts/stage-elizavoice-lib.ts --abi arm64-v8a --variant cpu

sim: check-arch
	node "$(DISTRO)/sim.ts" --brand-config "$(BRAND_CONFIG)" --device-dir "$(DEVICE_DIR)" --aosp-root "$(AOSP_ROOT)" $(ARGS)

splash:
	node "$(HERE)../scripts/android/generate-eliza-bootanimation.ts"

bootanimation: splash
	node "$(HERE)../scripts/android/build-bootanimation.ts" --frames "$(VENDOR)/bootanimation" --out "$(VENDOR)/bootanimation/bootanimation.zip"

check-arch:
	$(if $(and $(filter 1,$(words $(ARCH))),$(filter $(SUPPORTED_ARCHES),$(ARCH))),@:, $(error Unsupported ARCH; use x86_64 or arm64))

.PHONY: prepare-chromium-browser
prepare-chromium-browser:
	node "$(DISTRO)/prepare-chromium-browser.ts" $(ARGS)
