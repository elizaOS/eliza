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

.PHONY: all reference-test vulkan vulkan-spirv vulkan-qjl-polar metal metal-bench metal-bench-batched metal-bench-multiblock cpu-bench bench cuda cuda-verify verify-fork clean

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
vulkan_verify: vulkan_verify.cpp $(REF_OBJ) $(QJL_POLAR_OBJ)
ifdef VULKAN_SDK
	$(CXX) $(CXXFLAGS) -I$(VULKAN_SDK)/include -I../reference -I. \
		vulkan_verify.cpp $(REF_OBJ) $(QJL_POLAR_OBJ) \
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
	$(CXX) $(CXXFLAGS) -I$(ELIZA_DFLASH_VULKAN_HEADERS_DIR) -I../reference -I. \
		vulkan_verify.cpp $(REF_OBJ) $(QJL_POLAR_OBJ) \
		$(SYSTEM_LIBVULKAN) -lm -o vulkan_verify
endif
endif

# Run vulkan_verify against the QJL + Polar fixtures (needs a Vulkan-capable
# host — fails cleanly with "no Vulkan devices" on machines without an ICD).
# Requires the SPIR-V artifacts under ../vulkan/*.spv: build them with
# `make vulkan-spirv` first. Pre-supposes that gen_fixture has produced
# fixtures/qjl.json + fixtures/polar.json (run `make reference-test` first).
vulkan-qjl-polar: vulkan_verify vulkan-spirv
	@echo "[kernels/verify] running vulkan_verify on QJL fixture..."
	./vulkan_verify ../vulkan/qjl.spv fixtures/qjl.json
	@echo "[kernels/verify] running vulkan_verify on Polar fixture..."
	./vulkan_verify ../vulkan/polar.spv fixtures/polar.json

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

# Convenience target: build metal_bench then run --mode batched. The batched
# sweep dispatches N ∈ {1,4,16,64,128,256} into a single MTLCommandBuffer
# per kernel and reports per-dispatch GPU cost vs N. See
# bench_M4Max_batched_2026-05-10.md for the Wave-6 finding.
metal-bench-batched: metal_bench
	@mkdir -p bench_results
	./metal_bench --mode batched --out bench_results/m4max_batched_2026-05-10.json

# Multi-block-per-dispatch sweep (SHADER_REVIEW M3). Each threadgroup processes
# N consecutive KV blocks serially via 32-thread loop; cuts launch grid by N×.
# Sweeps the 4 small kernels (turbo3, turbo4, turbo3_tcq, qjl) over
# N ∈ {1,2,4,8,16,32} and writes per-kernel optimal-N + speedup.
metal-bench-multiblock: metal_bench
	@mkdir -p bench_results
	./metal_bench --mode multiblock --out bench_results/m4max_multiblock_2026-05-10.json

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
	    ./metal_bench --mode fp16ref --out bench_results/m4max_fp16ref_2026-05-10.json && \
	    echo "[bench] running metal_bench --mode multiblock ..." && \
	    ./metal_bench --mode multiblock --out bench_results/m4max_multiblock_2026-05-10.json ; \
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

# CUDA harness. Sibling of metal/vulkan_verify. Verifies the in-fork
# v0.4.0-milady CUDA kernels (turboquant.cuh, turbo-tcq.cu(h), qjl.cu(h),
# polarquant.cu(h)) against the canonical fixtures.
#
# Resolution order:
#   1. nvcc on PATH               — required to compile (.cu -> ELF).
#   2. CUDA_HOME/include          — defaults to /usr/local/cuda; overridable.
#   3. ELIZA_DFLASH_LLAMA_DIR     — root of the milady-llama-cpp checkout
#                                   (defaults to ~/.cache/eliza-dflash/milady-llama-cpp)
#                                   so we can include ggml-cuda/*.cuh.
#   4. ELIZA_DFLASH_LIBGGML_CUDA  — path to libggml-cuda.so. The harness LINKS
#                                   against the SHIPPED CUDA library so qjl,
#                                   polar, and turbo3_tcq exercise the actual
#                                   production kernel symbols. turbo3 / turbo4
#                                   are verified through a per-block dot
#                                   wrapper in cuda_verify.cu that calls the
#                                   shipped device-side `tbq_decode_block_cuda`
#                                   helpers (the fork ships no exported
#                                   turbo3_score / turbo4_score symbol).
NVCC ?= $(shell command -v nvcc 2>/dev/null)
CUDA_HOME ?= /usr/local/cuda
ELIZA_DFLASH_LLAMA_DIR ?= $(HOME)/.cache/eliza-dflash/milady-llama-cpp
ELIZA_DFLASH_LIBGGML_CUDA ?= $(ELIZA_DFLASH_LLAMA_DIR)/build-cuda/ggml/src/ggml-cuda/libggml-cuda.so

CUDA_INCLUDES = \
    -I$(CUDA_HOME)/include \
    -I$(ELIZA_DFLASH_LLAMA_DIR)/ggml/include \
    -I$(ELIZA_DFLASH_LLAMA_DIR)/ggml/src \
    -I.

CUDA_DEFINES = \
    -DGGML_CUDA_TBQ3_TCQ=1 \
    -DGGML_CUDA_QJL=1 \
    -DGGML_CUDA_POLARQUANT=1

cuda: cuda_verify
cuda_verify: cuda_verify.cu $(QJL_POLAR_OBJ)
ifeq ($(NVCC),)
	@echo "CUDA toolchain not found — install via 'apt install nvidia-cuda-toolkit' (Linux) or download the CUDA Toolkit (macOS not supported)."
	@false
else
ifeq ($(wildcard $(ELIZA_DFLASH_LLAMA_DIR)/ggml/src/ggml-cuda/turboquant.cuh),)
	@echo "CUDA harness needs the milady-llama-cpp checkout at"
	@echo "  $(ELIZA_DFLASH_LLAMA_DIR)"
	@echo "Run 'node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-cuda --no-build'"
	@echo "to fetch it (or override ELIZA_DFLASH_LLAMA_DIR)."
	@false
else
ifeq ($(wildcard $(ELIZA_DFLASH_LIBGGML_CUDA)),)
	@echo "CUDA harness needs libggml-cuda.so at"
	@echo "  $(ELIZA_DFLASH_LIBGGML_CUDA)"
	@echo "Build via 'node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-cuda',"
	@echo "or override ELIZA_DFLASH_LIBGGML_CUDA."
	@false
else
	$(NVCC) -O2 -std=c++17 \
		$(CUDA_INCLUDES) $(CUDA_DEFINES) \
		cuda_verify.cu $(QJL_POLAR_OBJ) \
		$(ELIZA_DFLASH_LIBGGML_CUDA) \
		-lcudart -lm -o cuda_verify
endif
endif
endif

# Source-level correctness check (M4 Max can run this; nvcc is NOT required).
# Two phases:
#   1. API surface check — grep-assert that every CUDA symbol cuda_verify.cu
#      references is actually declared in the in-fork ggml-cuda headers.
#      This catches name/signature drift between the harness and the
#      v0.4.0-milady fork without needing CUDA Toolkit headers.
#   2. Host-side parser check — compile the non-CUDA portion of cuda_verify.cu
#      (fixture loader + diff loop) under -fsyntax-only with the CUDA
#      sections gated out. This catches C++ typos in the harness.
#
# Full nvcc compile and runtime 8/8 PASS are gated on a CUDA host — see
# CUDA_VERIFICATION.md.
cuda-preprocess-check:
ifeq ($(wildcard $(ELIZA_DFLASH_LLAMA_DIR)/ggml/src/ggml-cuda/turboquant.cuh),)
	@echo "[cuda-preprocess-check] skipped — missing $(ELIZA_DFLASH_LLAMA_DIR)/ggml/src/ggml-cuda"
else
	@echo "[cuda-preprocess-check] (1) API surface assertions"
	@grep -q 'tbq_decode_block_cuda' $(ELIZA_DFLASH_LLAMA_DIR)/ggml/src/ggml-cuda/turboquant.cuh \
		|| { echo "  MISS: tbq_decode_block_cuda in turboquant.cuh"; exit 1; }
	@echo "  OK: tbq_decode_block_cuda  (turbo3/turbo4 wrapper)"
	@grep -q 'dequantize_row_tbq3_tcq_cuda' $(ELIZA_DFLASH_LLAMA_DIR)/ggml/src/ggml-cuda/turbo-tcq.cuh \
		|| { echo "  MISS: dequantize_row_tbq3_tcq_cuda in turbo-tcq.cuh"; exit 1; }
	@echo "  OK: dequantize_row_tbq3_tcq_cuda  (turbo3_tcq)"
	@grep -q 'attn_score_qjl_cuda'         $(ELIZA_DFLASH_LLAMA_DIR)/ggml/src/ggml-cuda/qjl.cuh \
		|| { echo "  MISS: attn_score_qjl_cuda in qjl.cuh"; exit 1; }
	@echo "  OK: attn_score_qjl_cuda  (qjl)"
	@grep -q 'dequantize_row_q4_polar_cuda' $(ELIZA_DFLASH_LLAMA_DIR)/ggml/src/ggml-cuda/polarquant.cuh \
		|| { echo "  MISS: dequantize_row_q4_polar_cuda in polarquant.cuh"; exit 1; }
	@echo "  OK: dequantize_row_q4_polar_cuda  (polar)"
	@grep -q 'block_tbq3_0\b'  $(ELIZA_DFLASH_LLAMA_DIR)/ggml/src/ggml-common.h \
		|| { echo "  MISS: block_tbq3_0 in ggml-common.h"; exit 1; }
	@grep -q 'block_tbq4_0\b'  $(ELIZA_DFLASH_LLAMA_DIR)/ggml/src/ggml-common.h \
		|| { echo "  MISS: block_tbq4_0 in ggml-common.h"; exit 1; }
	@grep -q 'block_qjl1_256'  $(ELIZA_DFLASH_LLAMA_DIR)/ggml/src/ggml-common.h \
		|| { echo "  MISS: block_qjl1_256 in ggml-common.h"; exit 1; }
	@grep -q 'block_q4_polar'  $(ELIZA_DFLASH_LLAMA_DIR)/ggml/src/ggml-common.h \
		|| { echo "  MISS: block_q4_polar in ggml-common.h"; exit 1; }
	@grep -q 'block_tbq3_tcq'  $(ELIZA_DFLASH_LLAMA_DIR)/ggml/src/ggml-common.h \
		|| { echo "  MISS: block_tbq3_tcq in ggml-common.h"; exit 1; }
	@echo "  OK: all five block_* layouts in ggml-common.h"
	@echo "[cuda-preprocess-check] (2) harness symbol references"
	@grep -q 'tbq_decode_block_cuda'         cuda_verify.cu || { echo "  MISS in cuda_verify.cu"; exit 1; }
	@grep -q 'dequantize_row_tbq3_tcq_cuda'  cuda_verify.cu || { echo "  MISS in cuda_verify.cu"; exit 1; }
	@grep -q 'attn_score_qjl_cuda'           cuda_verify.cu || { echo "  MISS in cuda_verify.cu"; exit 1; }
	@grep -q 'dequantize_row_q4_polar_cuda'  cuda_verify.cu || { echo "  MISS in cuda_verify.cu"; exit 1; }
	@echo "  OK: cuda_verify.cu calls all four exported CUDA APIs + the device helper"
	@echo "[cuda-preprocess-check] OK"
endif

# `cuda-verify` runs the harness against all five fixtures, same shape as
# `bench` does for the perf harness. Gated on nvcc presence so it stays
# safe on hosts without a CUDA toolchain.
cuda-verify:
ifeq ($(NVCC),)
	@echo "CUDA toolchain not found — install via 'apt install nvidia-cuda-toolkit' (Linux) or download the CUDA Toolkit (macOS not supported)."
	@false
else
	$(MAKE) cuda
	@echo "[cuda-verify] turbo3 ..."     ; ./cuda_verify fixtures/turbo3.json
	@echo "[cuda-verify] turbo4 ..."     ; ./cuda_verify fixtures/turbo4.json
	@echo "[cuda-verify] turbo3_tcq ..." ; ./cuda_verify fixtures/turbo3_tcq.json
	@echo "[cuda-verify] qjl ..."        ; ./cuda_verify fixtures/qjl.json
	@echo "[cuda-verify] polar ..."      ; ./cuda_verify fixtures/polar.json
endif

clean:
	rm -f $(REF_OBJ) $(QJL_POLAR_OBJ) gen_fixture vulkan_verify metal_verify metal_bench cpu_bench cuda_verify
	rm -f ../vulkan/*.spv
