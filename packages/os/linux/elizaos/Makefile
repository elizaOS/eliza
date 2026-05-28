SUPPORTED_ARCHES := amd64 arm64 riscv64
SUPPORTED_PROFILES := default gui secure secure-gui

.PHONY: help build lint

help:
	@echo "elizaOS Linux live-build"
	@echo "  make build ARCH=riscv64 PROFILE=default"
	@echo "  make build ARCH=riscv64 PROFILE=gui"
	@echo "  make lint"
	@echo
	@echo "ARCH: $(SUPPORTED_ARCHES)"
	@echo "PROFILE: $(SUPPORTED_PROFILES)"
	@echo "default=headless, gui=graphical kiosk, secure=headless hardening, secure-gui=hardening+kiosk"

build:
	ELIZAOS_ARCH="$(or $(ARCH),amd64)" ELIZAOS_PROFILE="$(or $(PROFILE),default)" ./build.sh

lint:
	python3 -m py_compile scripts/check-multiarch-boot-contract.py
	python3 scripts/test_check_multiarch_boot_contract.py
