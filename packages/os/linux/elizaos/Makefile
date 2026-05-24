# elizaOS Linux — unified multi-arch ISO build entrypoint.
#
# Usage:
#   make build ARCH=amd64
#   make build ARCH=arm64
#   make build ARCH=riscv64
#   make build ARCH=amd64 PROFILE=secure
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

.PHONY: help build builder stage-agent-artifacts riscv64-agent-runtime-smoke riscv64-gui-kiosk-iso-check arm64-gui-kiosk-iso-check arm64-qemu-virt-boot qemu-boot release-check-strict release-check check-riscv64-release-arch brand-assets clean lint

help:
	@echo "elizaOS Linux build targets:"
	@echo "  make build [ARCH=amd64|arm64|riscv64] [PROFILE=default|secure]"
	@echo "  make stage-agent-artifacts ARCH=<arch> [BUN_SOURCE=<path>|BUN_RISCV64_ZIP=<path>|RISCV64_RUNTIME=node]"
	@echo "  make riscv64-agent-runtime-smoke"
	@echo "  make riscv64-gui-kiosk-iso-check"
	@echo "  make arm64-gui-kiosk-iso-check"
	@echo "  make arm64-qemu-virt-boot"
	@echo "  make qemu-boot ARCH=<arch>"
	@echo "  make release-check ARCH=riscv64"
	@echo "  make release-check-strict ARCH=riscv64"
	@echo "  make brand-assets       # regenerate PNG branding from SVG sources"
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
