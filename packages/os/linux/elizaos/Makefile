# elizaOS Linux — unified multi-arch ISO build entrypoint.
#
# Usage:
#   make build ARCH=amd64
#   make build ARCH=arm64
#   make build ARCH=riscv64
#   make build ARCH=amd64 PROFILE=secure
#   make build ARCH=riscv64 PROFILE=gui
#   make build ARCH=riscv64 DEBIAN_MIRROR=https://ftp.debian.org/debian
#
#   make qemu-boot ARCH=riscv64
#   make release-check-strict ARCH=riscv64
#   make brand-assets

ARCH    ?= amd64
PROFILE ?= default
DEBIAN_MIRROR ?= https://mirrors.kernel.org/debian
HERE    := $(shell pwd)
LINUX_ROOT := $(abspath $(HERE)/..)
OUT     := $(HERE)/out
CONTAINER_BUILD_DIR := /work/elizaos-linux
AGENT_ARTIFACTS ?= $(HERE)/artifacts/$(ARCH)
REQUIRE_AGENT_ARTIFACTS ?= 0
AGENT_ARTIFACTS_MOUNT := $(if $(wildcard $(AGENT_ARTIFACTS)),-v "$(AGENT_ARTIFACTS):/opt/elizaos-artifacts:ro",)
BUILD_LOG ?= $(OUT)/elizaos-linux-$(ARCH)-$(PROFILE)-build.log
BUN_SOURCE ?=
BUN_RISCV64_ZIP ?= $(HERE)/../../toolchains/bun-riscv64/dist/bun-linux-riscv64-musl.zip
RISCV64_MUSL_RUNTIME ?= $(HERE)/artifacts/riscv64/elizaos-app/musl-runtime
RISCV64_ICU_DATA ?=
RISCV64_RUNTIME ?= bun
ISO ?=
EVIDENCE ?= $(HERE)/evidence/qemu_virt_boot.report.json
QEMU_EVIDENCE ?= $(HERE)/evidence/qemu_virt_boot.json
QEMU_TRANSCRIPT ?= $(HERE)/evidence/qemu_virt_boot.transcript.log
QEMU_MEMORY ?= 4096
QEMU_CPUS ?= 4
QEMU_TIMEOUT ?= 600
RISCV64_AGENT_RUNTIME_REPORT ?= $(HERE)/evidence/riscv64_agent_runtime_smoke.json
RISCV64_AGENT_RUNTIME_TRANSCRIPT ?= $(HERE)/evidence/riscv64_agent_runtime_smoke.log
RISCV64_GUI_KIOSK_REPORT ?= $(HERE)/evidence/riscv64_gui_kiosk_iso_check.json
ARM64_GUI_KIOSK_REPORT ?= $(HERE)/evidence/arm64_gui_kiosk_iso_check.json
ARM64_QEMU_EVIDENCE ?= $(HERE)/evidence/arm64_qemu_virt_boot.json
ARM64_QEMU_TRANSCRIPT ?= $(HERE)/evidence/arm64_qemu_virt_boot.transcript.log
REMOVE_PATH_RECURSIVE ?= node ../../scripts/rm-path-recursive.mjs
DEBIAN_SNAPSHOT_LOCK := $(HERE)/debian-snapshot.lock.json
DEBIAN_SNAPSHOT_SERIAL := $(shell python3 -c 'import json; print(json.load(open("$(DEBIAN_SNAPSHOT_LOCK)"))["serial"])')
DEBIAN_BASE_IMAGE := $(shell python3 -c 'import json; print(json.load(open("$(DEBIAN_SNAPSHOT_LOCK)"))["baseImage"])')

SUPPORTED_ARCHES := amd64 arm64 riscv64
SUPPORTED_PROFILES := default gui secure secure-gui

.PHONY: help build builder stage-agent-artifacts riscv64-agent-runtime-smoke riscv64-gui-kiosk-iso-check arm64-gui-kiosk-iso-check arm64-qemu-virt-boot qemu-boot release-check-strict release-check check-arch brand-assets clean lint mkosi-build mkosi-summary mkosi-lint mkosi-clean

help:
	@echo "elizaOS Linux build targets:"
	@echo "  make build [ARCH=amd64|arm64|riscv64] [PROFILE=default|gui|secure|secure-gui]"
	@echo "  make stage-agent-artifacts ARCH=<arch> [BUN_SOURCE=<path>|BUN_RISCV64_ZIP=<path>|RISCV64_RUNTIME=node]"
	@echo "  make riscv64-agent-runtime-smoke"
	@echo "  make riscv64-gui-kiosk-iso-check"
	@echo "  make arm64-gui-kiosk-iso-check"
	@echo "  make arm64-qemu-virt-boot"
	@echo "  make qemu-boot ARCH=<arch>"
	@echo "  make release-check ARCH=riscv64"
	@echo "  make release-check-strict ARCH=riscv64"
	@echo "  make brand-assets       # regenerate PNG branding from SVG sources"
	@echo "  ----- mkosi (canonical persistent GNOME disk image) -----"
	@echo "  make mkosi-build  [ARCH=...] [PROFILE=...] [MKOSI_EMIT_ISO=0]"
	@echo "  make mkosi-summary [ARCH=...] [PROFILE=...]   # dry-run resolver"
	@echo "  make mkosi-lint                              # static config lint"
	@echo "  make mkosi-clean                             # remove out/mkosi"
	@echo "  make lint               # static smoke checks"
	@echo "  make clean              # remove out/ and live-build state"
	@echo
	@echo "ARCH: $(SUPPORTED_ARCHES)"
	@echo "PROFILE: $(SUPPORTED_PROFILES)"
	@echo "default=headless, gui=graphical kiosk, secure=headless hardening, secure-gui=hardening+kiosk"

build:
	ELIZAOS_ARCH="$(or $(ARCH),amd64)" ELIZAOS_PROFILE="$(or $(PROFILE),default)" ./build.sh

stage-agent-artifacts: check-arch
ifeq ($(ARCH),riscv64)
ifeq ($(RISCV64_RUNTIME),node)
	scripts/stage-agent-artifacts.sh --arch "$(ARCH)" --out "$(AGENT_ARTIFACTS)" --skip-build
else
	scripts/stage-agent-artifacts.sh --arch "$(ARCH)" --out "$(AGENT_ARTIFACTS)" --riscv64-bun-zip "$(BUN_RISCV64_ZIP)" --riscv64-musl-runtime "$(RISCV64_MUSL_RUNTIME)" $(if $(RISCV64_ICU_DATA),--riscv64-icu-data "$(RISCV64_ICU_DATA)",)
endif
else
	scripts/stage-agent-artifacts.sh --arch "$(ARCH)" --out "$(AGENT_ARTIFACTS)" $(if $(BUN_SOURCE),--bun-source "$(BUN_SOURCE)",)
endif

riscv64-agent-runtime-smoke:
	RISCV64_AGENT_RUNTIME_REPORT="$(RISCV64_AGENT_RUNTIME_REPORT)" RISCV64_AGENT_RUNTIME_TRANSCRIPT="$(RISCV64_AGENT_RUNTIME_TRANSCRIPT)" scripts/check-riscv64-agent-runtime-artifact.sh "$(HERE)/artifacts/riscv64"

release-check:
	python3 scripts/check_release_manifest.py

release-check-strict:
	python3 scripts/check_release_manifest.py --strict

lint:
	scripts/static-smoke.sh
	python3 -m py_compile scripts/check-multiarch-boot-contract.py
	python3 scripts/test_check_multiarch_boot_contract.py

clean:
	$(REMOVE_PATH_RECURSIVE) "$(OUT)" cache chroot binary*.iso config/binary config/bootstrap config/chroot config/source

check-arch:
	@case " $(SUPPORTED_ARCHES) " in \
	    *" $(ARCH) "*) ;; \
	    *) echo "ERROR: ARCH=$(ARCH) not in: $(SUPPORTED_ARCHES)" >&2; exit 64 ;; \
	esac

builder:
	docker build --pull \
		--build-arg "DEBIAN_SNAPSHOT_SERIAL=$(DEBIAN_SNAPSHOT_SERIAL)" \
		--build-arg "DEBIAN_BASE_IMAGE=$(DEBIAN_BASE_IMAGE)" \
		--file "$(HERE)/Dockerfile" \
		--tag elizaos-linux-builder \
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
MKOSI_EMIT_ISO ?= 1
MKOSI_ARCH = $(if $(filter amd64,$(ARCH)),x86-64,$(ARCH))

mkosi-build: builder check-arch
	mkdir -p "$(MKOSI_OUT)"
	bash -o pipefail -c 'flock "$(HERE)/.build.lock" \
	    docker run --rm --privileged \
	        --network host \
	        -e MKOSI_EMIT_ISO=$(MKOSI_EMIT_ISO) \
	        -v "$(LINUX_ROOT):/src:ro" \
	        -v "$(MKOSI_OUT):/out" \
	        --entrypoint bash \
	        elizaos-linux-builder -lc "\
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
	                --exclude chroot --exclude binary --exclude out && \
	            ELIZAOS_ARCH=$(ARCH) /work/src/elizaos/scripts/ensure-foreign-binfmt.sh && \
	            cd /work/src/elizaos/mkosi && \
	            mkosi --force \
	                --architecture $(MKOSI_ARCH) \
	                $(MKOSI_PROFILE_FLAG) \
	                --output-dir /out \
	                build" \
	    2>&1 | tee "$(MKOSI_OUT)/build-$(ARCH)-$(PROFILE).log"'

# Dry-run resolver: prints the assembled mkosi config (arch + profile overlays
# composed) without building. Fast feedback for config edits.
mkosi-summary: builder check-arch
	docker run --rm \
	    -v "$(LINUX_ROOT):/work/src:ro" \
	    --entrypoint bash \
	    elizaos-linux-builder -lc "\
	        cd /work/src/elizaos/mkosi && \
	        mkosi --architecture $(MKOSI_ARCH) $(MKOSI_PROFILE_FLAG) summary"

# Static lint: validates the mkosi tree shape (configs parse, postinst is
# executable, skeleton symlinks resolve) without running mkosi.
mkosi-lint:
	scripts/mkosi-lint.sh

mkosi-clean:
	$(REMOVE_PATH_RECURSIVE) "$(MKOSI_OUT)"
