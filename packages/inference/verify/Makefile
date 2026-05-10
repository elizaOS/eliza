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
QJL_POLAR_SRC = qjl_polar_ref.c
QJL_POLAR_OBJ = qjl_polar_ref.o

.PHONY: all reference-test vulkan vulkan-spirv metal metal-bench cpu-bench bench clean

all: reference-test
	@echo "[kernels/verify] Built reference test."
	@echo "[kernels/verify] To build the Vulkan harness: VULKAN_SDK=/path/to/sdk make vulkan"
	@echo "[kernels/verify] To build the Metal harness (macOS): make metal"

$(REF_OBJ): $(REF_SRC) ../reference/turbo_kernels.h
	$(CC) $(CFLAGS) -c $< -o $@

$(QJL_POLAR_OBJ): $(QJL_POLAR_SRC) qjl_polar_ref.h
	$(CC) $(CFLAGS) -c $< -o $@

reference-test: gen_fixture
	@echo "[kernels/verify] reference vs reference (fixture sanity)..."
	./gen_fixture --self-test

gen_fixture: gen_fixture.c $(REF_OBJ) $(QJL_POLAR_OBJ)
	$(CC) $(CFLAGS) -I../reference $< $(REF_OBJ) $(QJL_POLAR_OBJ) -lm -o $@

# Vulkan harness. Resolution order:
#   1. VULKAN_SDK env var (LunarG SDK install) — preferred, gives glslangValidator
#   2. Fetched Khronos Vulkan-Headers checkout from the dflash build script
#      (~/.cache/eliza-dflash/vulkan-headers/include) + system libvulkan.so.1
#   3. Fail with a clear instruction.
#
# Path 2 lets the harness build on stock Linux machines that already have
# `bun run packages/app-core/scripts/build-llama-cpp-dflash.mjs --target
# linux-x64-vulkan` set up but no Vulkan SDK installed.
ELIZA_DFLASH_VULKAN_HEADERS_DIR ?= $(HOME)/.cache/eliza-dflash/vulkan-headers/include
SYSTEM_LIBVULKAN := $(firstword \
    $(wildcard /usr/lib/x86_64-linux-gnu/libvulkan.so.1) \
    $(wildcard /usr/lib64/libvulkan.so.1) \
    $(wildcard /usr/lib/libvulkan.so.1))

vulkan: vulkan_verify
vulkan_verify: vulkan_verify.cpp $(REF_OBJ)
ifdef VULKAN_SDK
	$(CXX) $(CXXFLAGS) -I$(VULKAN_SDK)/include -I../reference \
		vulkan_verify.cpp $(REF_OBJ) \
		-L$(VULKAN_SDK)/lib -lvulkan -lm -o vulkan_verify
else
ifeq ($(wildcard $(ELIZA_DFLASH_VULKAN_HEADERS_DIR)/vulkan/vulkan.hpp),)
	@echo "Vulkan harness needs either:"
	@echo "  - VULKAN_SDK pointing at LunarG, or"
	@echo "  - Fetched Khronos headers at $(ELIZA_DFLASH_VULKAN_HEADERS_DIR)"
	@echo "    (run 'node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-vulkan' to fetch them)"
	@false
else ifeq ($(SYSTEM_LIBVULKAN),)
	@echo "Vulkan harness needs libvulkan.so.1 (apt install libvulkan1)"
	@false
else
	$(CXX) $(CXXFLAGS) -I$(ELIZA_DFLASH_VULKAN_HEADERS_DIR) -I../reference \
		vulkan_verify.cpp $(REF_OBJ) \
		$(SYSTEM_LIBVULKAN) -lm -o vulkan_verify
endif
endif

# Metal harness (macOS only). Requires xcrun on PATH.
metal: metal_verify
metal_verify: metal_verify.mm $(REF_OBJ) $(QJL_POLAR_OBJ)
	@which xcrun >/dev/null 2>&1 || { echo "xcrun not found — Metal harness needs macOS Xcode tools."; exit 1; }
	clang++ $(CXXFLAGS) -ObjC++ -fobjc-arc -I../reference \
		metal_verify.mm $(REF_OBJ) $(QJL_POLAR_OBJ) \
		-framework Foundation -framework Metal -framework MetalKit -framework CoreGraphics \
		-lm -o metal_verify

# Metal performance harness (macOS only). Sibling of metal_verify; measures
# end-to-end GPU latency, CPU wait, and bandwidth utilisation per kernel at
# production-relevant sizes. Does NOT replace metal_verify — both build
# independently against the same shader files.
metal-bench: metal_bench
metal_bench: metal_bench.mm
	@which xcrun >/dev/null 2>&1 || { echo "xcrun not found — Metal bench needs macOS Xcode tools."; exit 1; }
	clang++ $(CXXFLAGS) -ObjC++ -fobjc-arc \
		metal_bench.mm \
		-framework Foundation -framework Metal -framework MetalKit -framework CoreGraphics \
		-lm -o metal_bench

# CPU reference baseline. Single-threaded scalar C, no GPU. Same workload
# constants as metal_bench so the BENCHMARK doc can join the two tables.
cpu-bench: cpu_bench
cpu_bench: cpu_bench.c $(REF_OBJ) $(QJL_POLAR_OBJ)
	$(CC) $(CFLAGS) -I../reference cpu_bench.c $(REF_OBJ) $(QJL_POLAR_OBJ) -lm -o cpu_bench

# Umbrella: build (and run, into bench_results/) every available bench.
# CPU bench always runs. Metal bench runs only on macOS with xcrun.
bench: cpu-bench
	@mkdir -p bench_results
	@echo "[bench] running cpu_bench ..."
	./cpu_bench --runs 3 --warmup 1 --out bench_results/cpu_m4max_2026-05-10.json
	@if which xcrun >/dev/null 2>&1; then \
	    echo "[bench] running metal_bench ..." ; \
	    $(MAKE) metal-bench >/dev/null && \
	    ./metal_bench --out bench_results/m4max_2026-05-10.json && \
	    echo "[bench] running metal_bench --mode tgsweep ..." && \
	    ./metal_bench --mode tgsweep --out bench_results/m4max_tgsweep_2026-05-10.json && \
	    echo "[bench] running metal_bench --mode fp16ref ..." && \
	    ./metal_bench --mode fp16ref --out bench_results/m4max_fp16ref_2026-05-10.json ; \
	else \
	    echo "[bench] skipping metal_bench (xcrun not found — macOS only)" ; \
	fi

# Compile the GLSL compute shaders to SPIR-V. The vulkan_verify harness loads
# .spv files. glslc resolution: prefer system glslc, fall back to the Android
# NDK's bundled glslc (same path the dflash build script uses).
GLSLC ?= $(shell command -v glslc 2>/dev/null)
ifeq ($(GLSLC),)
NDK_GLSLC := $(firstword \
    $(wildcard $(HOME)/Android/Sdk/ndk/*/shader-tools/linux-x86_64/glslc) \
    $(wildcard $(HOME)/Android/Sdk/ndk/*/shader-tools/darwin-x86_64/glslc))
GLSLC := $(NDK_GLSLC)
endif

VULKAN_SHADERS = \
    ../vulkan/turbo3.spv \
    ../vulkan/turbo4.spv \
    ../vulkan/turbo3_tcq.spv \
    ../vulkan/qjl.spv \
    ../vulkan/qjl_get_rows.spv \
    ../vulkan/qjl_mul_mv.spv \
    ../vulkan/polar.spv \
    ../vulkan/polar_get_rows.spv

vulkan-spirv: $(VULKAN_SHADERS)

../vulkan/%.spv: ../vulkan/%.comp
ifeq ($(GLSLC),)
	@echo "glslc not found — install LunarG SDK or Android NDK to build SPIR-V."
	@false
else
	# subgroupAdd needs SPIR-V 1.3 + Vulkan 1.1 (the kernels target Vulkan 1.1
	# subgroups via GL_KHR_shader_subgroup_arithmetic).
	$(GLSLC) --target-env=vulkan1.1 --target-spv=spv1.3 \
		-fshader-stage=compute $< -o $@
endif

clean:
	rm -f $(REF_OBJ) $(QJL_POLAR_OBJ) gen_fixture vulkan_verify metal_verify metal_bench cpu_bench
	rm -f ../vulkan/*.spv
