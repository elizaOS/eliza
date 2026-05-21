# elizaOS Linux — unified multi-arch ISO build entrypoint.
#
# Usage:
#   make build ARCH=amd64
#   make build ARCH=arm64
#   make build ARCH=riscv64
#   make build ARCH=amd64 PROFILE=secure
#
#   make qemu-boot ARCH=riscv64
#   make release-check-strict ARCH=amd64
#   make brand-assets

ARCH    ?= amd64
PROFILE ?= default
HERE    := $(shell pwd)
OUT     := $(HERE)/out

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
	        -e ELIZAOS_ARCH=$(ARCH) \
	        -e ELIZAOS_PROFILE=$(PROFILE) \
	        -v "$(HERE):/build" \
	        -v "$(OUT):/out" \
	        elizaos-linux-builder

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
