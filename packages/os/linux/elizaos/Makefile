# Persistent GNOME disk images; legacy live-build is available as legacy-iso.

ARCH    ?= amd64
PROFILE ?= default
BUILDER_IMAGE ?= elizaos-linux-builder
HERE    := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
OS_ROOT := $(abspath $(HERE)/../..)
OUT     := $(HERE)/out
AGENT_ARTIFACTS ?= $(HERE)/artifacts/$(ARCH)
BUN_SOURCE ?=
BUN_RISCV64_ZIP ?= $(HERE)/../../toolchains/bun-riscv64/dist/bun-linux-riscv64-musl.zip
RISCV64_MUSL_RUNTIME ?= $(HERE)/artifacts/riscv64/elizaos-app/musl-runtime
RISCV64_ICU_DATA ?=
RISCV64_RUNTIME ?= bun
RISCV64_AGENT_RUNTIME_REPORT ?=
RISCV64_AGENT_RUNTIME_TRANSCRIPT ?=
REMOVE_PATH_RECURSIVE ?= node ../../scripts/rm-path-recursive.ts
DEBIAN_SNAPSHOT_LOCK := $(HERE)/debian-snapshot.lock.json
DEBIAN_SNAPSHOT_SERIAL := $(shell python3 -c 'import json; print(json.load(open("$(DEBIAN_SNAPSHOT_LOCK)"))["serial"])')
DEBIAN_BASE_IMAGE := $(shell python3 -c 'import json; print(json.load(open("$(DEBIAN_SNAPSHOT_LOCK)"))["baseImage"])')

SUPPORTED_ARCHES := amd64 arm64 riscv64
SUPPORTED_PROFILES := default gui secure secure-gui

.PHONY: help build legacy-iso builder stage-agent-artifacts riscv64-agent-runtime-smoke release-check-strict release-check check-arch check-profile clean lint legacy-lint mkosi-build mkosi-summary mkosi-lint mkosi-clean

help:
	@echo "elizaOS Linux build targets:"
	@echo "  make build [ARCH=amd64|arm64|riscv64] [PROFILE=default|gui|secure|secure-gui]"
	@echo "  make legacy-iso        # older live-build ISO pipeline"
	@echo "  make stage-agent-artifacts ARCH=<arch> [BUN_SOURCE=<path>|BUN_RISCV64_ZIP=<path>|RISCV64_RUNTIME=node]"
	@echo "  make riscv64-agent-runtime-smoke"
	@echo "  make release-check        # legacy ISO manifest"
	@echo "  make release-check-strict # legacy ISO manifest"
	@echo "  ----- mkosi (canonical persistent GNOME disk image) -----"
	@echo "  make mkosi-build  [ARCH=...] [PROFILE=...]"
	@echo "  make mkosi-summary [ARCH=...] [PROFILE=...]   # dry-run resolver"
	@echo "  make mkosi-lint                              # static config lint"
	@echo "  make mkosi-clean                             # remove out/mkosi"
	@echo "  make lint               # mkosi configuration checks"
	@echo "  make clean              # remove out/ and live-build state"
	@echo
	@echo "ARCH: $(SUPPORTED_ARCHES)"
	@echo "PROFILE: $(SUPPORTED_PROFILES)"
	@echo "default/gui=GNOME, secure/secure-gui=GNOME with hardening"

build: mkosi-build

legacy-iso: check-arch
	ELIZAOS_ARCH="$(ARCH)" ELIZAOS_PROFILE="$(PROFILE)" ./build-live-iso.sh

stage-agent-artifacts: check-arch
ifeq ($(ARCH),riscv64)
ifeq ($(RISCV64_RUNTIME),node)
	../../scripts/linux/stage-agent-artifacts.sh --arch "$(ARCH)" --out "$(AGENT_ARTIFACTS)" --skip-build
else
	../../scripts/linux/stage-agent-artifacts.sh --arch "$(ARCH)" --out "$(AGENT_ARTIFACTS)" --riscv64-bun-zip "$(BUN_RISCV64_ZIP)" --riscv64-musl-runtime "$(RISCV64_MUSL_RUNTIME)" $(if $(RISCV64_ICU_DATA),--riscv64-icu-data "$(RISCV64_ICU_DATA)",)
endif
else
	../../scripts/linux/stage-agent-artifacts.sh --arch "$(ARCH)" --out "$(AGENT_ARTIFACTS)" $(if $(BUN_SOURCE),--bun-source "$(BUN_SOURCE)",)
endif

riscv64-agent-runtime-smoke:
	RISCV64_AGENT_RUNTIME_REPORT="$(RISCV64_AGENT_RUNTIME_REPORT)" RISCV64_AGENT_RUNTIME_TRANSCRIPT="$(RISCV64_AGENT_RUNTIME_TRANSCRIPT)" ../../scripts/linux/check-riscv64-agent-runtime-artifact.sh "$(HERE)/artifacts/riscv64"

release-check:
	python3 ../../scripts/linux/check_release_manifest.py

release-check-strict:
	python3 ../../scripts/linux/check_release_manifest.py --strict

lint: mkosi-lint

legacy-lint:
	../../scripts/linux/static-smoke.sh
	python3 -m py_compile ../../scripts/linux/check-multiarch-boot-contract.py
	python3 ../../scripts/linux/test_check_multiarch_boot_contract.py
	python3 ../../scripts/linux/test_riscv64_agent_staging.py

clean:
	$(REMOVE_PATH_RECURSIVE) "$(OUT)" cache chroot binary*.iso config/binary config/bootstrap config/chroot config/source

check-arch:
	$(if $(and $(filter 1,$(words $(ARCH))),$(filter $(SUPPORTED_ARCHES),$(ARCH))),@:, $(error Unsupported ARCH; use amd64, arm64, or riscv64))

check-profile:
	$(if $(and $(filter 1,$(words $(PROFILE))),$(filter $(SUPPORTED_PROFILES),$(PROFILE))),@:, $(error Unsupported PROFILE; use default, gui, secure, or secure-gui))

builder: check-arch check-profile
	docker build --pull \
		--build-arg "DEBIAN_SNAPSHOT_SERIAL=$(DEBIAN_SNAPSHOT_SERIAL)" \
		--build-arg "DEBIAN_BASE_IMAGE=$(DEBIAN_BASE_IMAGE)" \
		--file "$(HERE)/Dockerfile" \
		--tag "$(BUILDER_IMAGE)" \
		"$(HERE)"

# -----------------------------------------------------------------------------
# Canonical mkosi build path. The Linux root is copied as one source tree so
# mkosi.postinst can consume the sibling control-plane packaging without
# duplicating it into the image definition.
#
# ARCH maps from live-build naming to mkosi's debian-arch naming:
#   amd64   -> x86-64
#   arm64   -> arm64
#   riscv64 -> riscv64
# -----------------------------------------------------------------------------
MKOSI_DIR := $(HERE)/mkosi
MKOSI_OUT := $(OUT)/mkosi
MKOSI_PROFILE_FLAG := $(if $(filter-out default,$(PROFILE)),--profile=$(PROFILE),)
MKOSI_ARCH = $(if $(filter amd64,$(ARCH)),x86-64,$(ARCH))

mkosi-build: check-arch builder
	mkdir -p "$(MKOSI_OUT)"
	bash -o pipefail -c 'flock "$(HERE)/.build.lock" \
	    docker run --rm --privileged \
	        --network host \
	        -v "$(OS_ROOT):/src:ro" \
	        -v "$(MKOSI_OUT):/out" \
	        --entrypoint bash \
	        $(BUILDER_IMAGE) -lc "\
	            if [ -L /work/src ]; then \
	                unlink /work/src; \
	            elif [ -d /work/src ]; then \
	                find /work/src -mindepth 1 -depth -delete && rmdir /work/src; \
	            elif [ -e /work/src ]; then \
	                unlink /work/src; \
	            fi && \
	            mkdir -p /work/src && \
	            rsync -a /src/ /work/src/ \
	                --exclude .build --exclude .build.lock --exclude cache \
	                --exclude chroot --exclude binary --exclude out \
	                --exclude node_modules --exclude __pycache__ && \
	            ELIZAOS_ARCH=$(ARCH) /work/src/scripts/linux/ensure-foreign-binfmt.sh && \
	            cd /work/src/linux/elizaos/mkosi && \
	            mkosi --force \
	                --architecture $(MKOSI_ARCH) \
	                $(MKOSI_PROFILE_FLAG) \
	                --output-dir /out \
	                build" \
	    2>&1 | tee "$(MKOSI_OUT)/build-$(ARCH)-$(PROFILE).log"'

# Dry-run resolver: prints the assembled mkosi config (arch + profile overlays
# composed) without building. Fast feedback for config edits.
mkosi-summary: check-arch builder
	docker run --rm \
	    -v "$(OS_ROOT):/work/src:ro" \
	    --entrypoint bash \
	    $(BUILDER_IMAGE) -lc "\
	        cd /work/src/linux/elizaos/mkosi && \
	        mkosi --architecture $(MKOSI_ARCH) $(MKOSI_PROFILE_FLAG) summary"

# Static lint: validates the mkosi tree shape (configs parse, postinst is
# executable, skeleton symlinks resolve) without running mkosi.
mkosi-lint:
	../../scripts/linux/mkosi-lint.sh

mkosi-clean:
	$(REMOVE_PATH_RECURSIVE) "$(MKOSI_OUT)"
