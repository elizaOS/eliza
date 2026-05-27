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
OUT     := $(HERE)/out
CONTAINER_BUILD_DIR := /work/elizaos-linux
AGENT_ARTIFACTS ?= $(HERE)/artifacts/$(ARCH)
REQUIRE_AGENT_ARTIFACTS ?= 0
AGENT_ARTIFACTS_MOUNT := $(if $(wildcard $(AGENT_ARTIFACTS)),-v "$(AGENT_ARTIFACTS):/opt/elizaos-artifacts:ro",)
BUILD_LOG ?= $(OUT)/elizaos-linux-$(ARCH)-$(PROFILE)-build.log
BUN_SOURCE ?=
BUN_RISCV64_ZIP ?= $(HERE)/../../../app-core/scripts/bun-riscv64/dist/bun-linux-riscv64-musl.zip
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

SUPPORTED_ARCHES := amd64 arm64 riscv64

.PHONY: help build builder stage-agent-artifacts riscv64-agent-runtime-smoke riscv64-gui-kiosk-iso-check arm64-gui-kiosk-iso-check arm64-qemu-virt-boot qemu-boot release-check-strict release-check check-riscv64-release-arch brand-assets clean lint mkosi-build mkosi-summary mkosi-lint mkosi-clean

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
	@echo "  ----- mkosi (additive build path; reuses live-build hooks) -----"
	@echo "  make mkosi-build  [ARCH=...] [PROFILE=...] [MKOSI_EMIT_ISO=0]"
	@echo "  make mkosi-summary [ARCH=...] [PROFILE=...]   # dry-run resolver"
	@echo "  make mkosi-lint                              # static config lint"
	@echo "  make mkosi-clean                             # remove out/mkosi"
	@echo "  make lint               # static smoke checks"
	@echo "  make clean              # remove out/ and live-build state"

builder:
	docker build -t elizaos-linux-builder .

# live-build writes chroot/, binary/, .build/ in place, so two concurrent
# builds in this tree would corrupt each other. Serialize on a tree-level
# lock; build.sh clears stale working state on entry (as root, inside the
# container). Build a different arch on a separate checkout for true
# parallelism.
build: builder check-arch
	mkdir -p "$(OUT)"
	bash -o pipefail -c 'flock "$(HERE)/.build.lock" \
	    docker run --rm --privileged \
	        --network host \
	        -e ELIZAOS_ARCH=$(ARCH) \
	        -e ELIZAOS_PROFILE=$(PROFILE) \
	        -e ELIZAOS_DEBIAN_MIRROR="$(DEBIAN_MIRROR)" \
	        -e ELIZAOS_REQUIRE_AGENT_ARTIFACTS=$(REQUIRE_AGENT_ARTIFACTS) \
	        -v "$(HERE):/src:ro" \
	        -v "$(OUT):/out" \
	        $(AGENT_ARTIFACTS_MOUNT) \
	        --entrypoint bash \
	        elizaos-linux-builder -lc "\
	            rm -rf \"$(CONTAINER_BUILD_DIR)\" && \
	            mkdir -p \"$(CONTAINER_BUILD_DIR)\" && \
	            rsync -a \
	                --exclude .build \
	                --exclude .build.lock \
	                --exclude .lock \
	                --exclude binary \
	                --exclude \"binary.*\" \
	                --exclude cache \
	                --exclude chroot \
	                --exclude \"chroot.*\" \
	                --exclude \"live-image-*\" \
	                --exclude out \
	                /src/ \"$(CONTAINER_BUILD_DIR)/\" && \
	            cd \"$(CONTAINER_BUILD_DIR)\" && \
	            ELIZAOS_OUT_DIR=/out bash ./build.sh" \
	    2>&1 | tee "$(BUILD_LOG)"'

stage-agent-artifacts: check-arch
	@if [ "$(ARCH)" = "riscv64" ]; then \
	    if [ "$(RISCV64_RUNTIME)" = "node" ]; then \
	        scripts/stage-agent-artifacts.sh \
	            --arch "$(ARCH)" \
	            --skip-build \
	            --out "$(AGENT_ARTIFACTS)"; \
	    elif [ "$(RISCV64_RUNTIME)" = "bun" ]; then \
	        scripts/stage-agent-artifacts.sh \
	            --arch "$(ARCH)" \
	            --skip-build \
	            --riscv64-bun-zip "$(BUN_RISCV64_ZIP)" \
	            --riscv64-musl-runtime "$(RISCV64_MUSL_RUNTIME)" \
	            $(if $(RISCV64_ICU_DATA),--riscv64-icu-data "$(RISCV64_ICU_DATA)",) \
	            --out "$(AGENT_ARTIFACTS)"; \
	    else \
	        echo "ERROR: RISCV64_RUNTIME must be bun or node, got $(RISCV64_RUNTIME)" >&2; \
	        exit 64; \
	    fi; \
	else \
	    if [ -z "$(BUN_SOURCE)" ]; then \
	        echo "ERROR: BUN_SOURCE=<target bun path> is required for ARCH=$(ARCH)" >&2; \
	        exit 66; \
	    fi; \
	    scripts/stage-agent-artifacts.sh \
	        --arch "$(ARCH)" \
	        --skip-build \
	        --bun "$(BUN_SOURCE)" \
	        --out "$(AGENT_ARTIFACTS)"; \
	fi

riscv64-agent-runtime-smoke:
	scripts/check-riscv64-agent-runtime-artifact.sh \
	    --artifacts "$(HERE)/artifacts/riscv64" \
	    --report "$(RISCV64_AGENT_RUNTIME_REPORT)" \
	    --transcript "$(RISCV64_AGENT_RUNTIME_TRANSCRIPT)"

riscv64-gui-kiosk-iso-check:
	scripts/check-riscv64-gui-kiosk-iso.py \
	    --arch riscv64 \
	    --out "$(RISCV64_GUI_KIOSK_REPORT)"

arm64-gui-kiosk-iso-check:
	scripts/check-riscv64-gui-kiosk-iso.py \
	    --arch arm64 \
	    $(if $(ISO),--iso "$(ISO)",) \
	    --out "$(ARM64_GUI_KIOSK_REPORT)"

arm64-qemu-virt-boot:
	docker run --rm --privileged \
	    -v "$(HERE):/work" \
	    --entrypoint bash \
	    elizaos-linux-builder -lc '\
	        cd /work && \
	        python3 scripts/qemu_virt_boot_arm64.py \
	            --evidence "$(patsubst $(HERE)%,/work%,$(ARM64_QEMU_EVIDENCE))" \
	            --transcript "$(patsubst $(HERE)%,/work%,$(ARM64_QEMU_TRANSCRIPT))" \
	            --memory "$(QEMU_MEMORY)" \
	            --cpus "$(QEMU_CPUS)" \
	            --timeout "$(QEMU_TIMEOUT)" \
	            $(if $(ISO),--iso "$(patsubst $(HERE)%,/work%,$(ISO))",)'

qemu-boot: check-arch
	scripts/boot-qemu.sh $(ARCH)

release-check-strict: check-riscv64-release-arch
	scripts/check_release_manifest.py --strict

release-check: check-riscv64-release-arch
	scripts/check_release_manifest.py

check-riscv64-release-arch: check-arch
	@if [ "$(ARCH)" != "riscv64" ]; then \
	    echo "ERROR: release-check currently validates the riscv64 qemu-virt release manifest only; got ARCH=$(ARCH)" >&2; \
	    exit 64; \
	fi

brand-assets:
	scripts/generate-elizaos-brand-assets.sh

lint:
	scripts/static-smoke.sh

clean:
	rm -rf $(OUT)
	rm -rf cache chroot binary*.iso config/binary config/bootstrap config/chroot config/source

check-arch:
	@case " $(SUPPORTED_ARCHES) " in \
	    *" $(ARCH) "*) ;; \
	    *) echo "ERROR: ARCH=$(ARCH) not in: $(SUPPORTED_ARCHES)" >&2; exit 64 ;; \
	esac

# -----------------------------------------------------------------------------
# mkosi build path (additive, alongside live-build).
#
# Reuses ../config/includes.chroot, ../config/hooks/normal/*.hook.chroot, and
# the same systemd units / kiosk wiring as the live-build path. See
# mkosi/README.md and mkosi/mkosi.conf.
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
	        -v "$(HERE):/src:ro" \
	        -v "$(MKOSI_OUT):/out" \
	        --entrypoint bash \
	        elizaos-linux-builder -lc "\
	            rm -rf /work/mkosi && mkdir -p /work/mkosi && \
	            rsync -a /src/ /work/mkosi/ \
	                --exclude .build --exclude .build.lock --exclude cache \
	                --exclude chroot --exclude binary --exclude out && \
	            cd /work/mkosi/mkosi && \
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
	    -v "$(MKOSI_DIR):/mkosi:ro" \
	    --entrypoint bash \
	    elizaos-linux-builder -lc "\
	        cd /mkosi && \
	        mkosi --architecture $(MKOSI_ARCH) $(MKOSI_PROFILE_FLAG) summary"

# Static lint: validates the mkosi tree shape (configs parse, postinst is
# executable, skeleton symlinks resolve) without running mkosi.
mkosi-lint:
	scripts/mkosi-lint.sh

mkosi-clean:
	rm -rf "$(MKOSI_OUT)"
