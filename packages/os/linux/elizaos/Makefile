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
#   make release-check-strict ARCH=amd64
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

SUPPORTED_ARCHES := amd64 arm64 riscv64

.PHONY: help build builder qemu-boot release-check-strict release-check brand-assets clean lint

help:
	@echo "elizaOS Linux build targets:"
	@echo "  make build [ARCH=amd64|arm64|riscv64] [PROFILE=default|secure]"
	@echo "  make qemu-boot ARCH=<arch>"
	@echo "  make release-check-strict ARCH=<arch>"
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
	flock "$(HERE)/.build.lock" \
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
	        elizaos-linux-builder -lc '\
	            rm -rf "$(CONTAINER_BUILD_DIR)" && \
	            mkdir -p "$(CONTAINER_BUILD_DIR)" && \
	            rsync -a \
	                --exclude .build \
	                --exclude .build.lock \
	                --exclude .lock \
	                --exclude binary \
	                --exclude "binary.*" \
	                --exclude cache \
	                --exclude chroot \
	                --exclude "chroot.*" \
	                --exclude "live-image-*" \
	                --exclude out \
	                /src/ "$(CONTAINER_BUILD_DIR)/" && \
	            cd "$(CONTAINER_BUILD_DIR)" && \
	            ELIZAOS_OUT_DIR=/out bash ./build.sh'

qemu-boot: check-arch
	scripts/boot-qemu.sh $(ARCH)

release-check-strict: check-arch
	scripts/release-check.sh --strict --arch $(ARCH)

release-check: check-arch
	scripts/release-check.sh --arch $(ARCH)

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
