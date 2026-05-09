# DRAFT verification Makefile for the turbo3 / turbo4 / turbo3_tcq kernels.
# Builds the platform-specific harnesses only when the relevant SDK is present.
# This file MUST stay no-op on plain Linux without a GPU SDK so that CI is
# safe to run.

CC      ?= cc
CXX     ?= c++
CFLAGS  ?= -O2 -Wall -Wextra -std=c11
CXXFLAGS?= -O2 -Wall -Wextra -std=c++17

REF_SRC = ../reference/turbo_kernels.c
REF_OBJ = turbo_kernels.o

.PHONY: all reference-test vulkan metal clean

all: reference-test
	@echo "[kernels/verify] Built reference test."
	@echo "[kernels/verify] To build the Vulkan harness: VULKAN_SDK=/path/to/sdk make vulkan"
	@echo "[kernels/verify] To build the Metal harness (macOS): make metal"

$(REF_OBJ): $(REF_SRC) ../reference/turbo_kernels.h
	$(CC) $(CFLAGS) -c $< -o $@

reference-test: gen_fixture
	@echo "[kernels/verify] reference vs reference (fixture sanity)..."
	./gen_fixture --self-test

gen_fixture: gen_fixture.c $(REF_OBJ)
	$(CC) $(CFLAGS) -I../reference $< $(REF_OBJ) -lm -o $@

# Vulkan harness (requires VULKAN_SDK env var pointing at an installed SDK).
vulkan: vulkan_verify
vulkan_verify: vulkan_verify.cpp $(REF_OBJ)
ifndef VULKAN_SDK
	@echo "VULKAN_SDK not set — skipping Vulkan harness."
	@false
else
	$(CXX) $(CXXFLAGS) -I$(VULKAN_SDK)/include -I../reference \
		vulkan_verify.cpp $(REF_OBJ) \
		-L$(VULKAN_SDK)/lib -lvulkan -lm -o vulkan_verify
endif

# Metal harness (macOS only). Requires xcrun on PATH.
metal: metal_verify
metal_verify: metal_verify.mm $(REF_OBJ)
	@which xcrun >/dev/null 2>&1 || { echo "xcrun not found — Metal harness needs macOS Xcode tools."; exit 1; }
	clang++ $(CXXFLAGS) -ObjC++ -fobjc-arc -I../reference \
		metal_verify.mm $(REF_OBJ) \
		-framework Foundation -framework Metal -framework MetalKit -framework CoreGraphics \
		-lm -o metal_verify

clean:
	rm -f $(REF_OBJ) gen_fixture vulkan_verify metal_verify
