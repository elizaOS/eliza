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

.PHONY: all reference-test kernel-contract vulkan vulkan-spirv vulkan-verify vulkan-qjl-polar vulkan-dispatch-smoke vulkan-native-smoke android-vulkan-smoke metal metal-verify metal-verify-multiblock metal-bench metal-bench-batched metal-bench-multiblock cpu-bench bench cuda cuda-verify cuda-hardware rocm-hardware gh200-hardware windows-hardware verify-fork dispatch-smoke clean

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

kernel-contract:
	node check_kernel_contract.mjs

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

# Homebrew Vulkan SDK on macOS (vulkan-headers + vulkan-loader + molten-vk).
# Detected by the loader dylib + headers under /opt/homebrew.
HOMEBREW_VULKAN_HEADERS := $(wildcard /opt/homebrew/include/vulkan/vulkan.h)
HOMEBREW_VULKAN_LIB     := $(wildcard /opt/homebrew/opt/vulkan-loader/lib/libvulkan.dylib)

vulkan: vulkan_verify
vulkan_verify: vulkan_verify.cpp $(REF_OBJ) $(QJL_POLAR_OBJ)
ifdef VULKAN_SDK
	$(CXX) $(CXXFLAGS) -I$(VULKAN_SDK)/include -I../reference -I. \
		vulkan_verify.cpp $(REF_OBJ) $(QJL_POLAR_OBJ) \
		-L$(VULKAN_SDK)/lib -lvulkan -lm -o vulkan_verify
else ifneq ($(strip $(HOMEBREW_VULKAN_HEADERS)$(HOMEBREW_VULKAN_LIB)),)
	$(CXX) $(CXXFLAGS) -I/opt/homebrew/include -I../reference -I. \
		vulkan_verify.cpp $(REF_OBJ) $(QJL_POLAR_OBJ) \
		-L/opt/homebrew/opt/vulkan-loader/lib -lvulkan -lm -o vulkan_verify
	@echo "[vulkan_verify] Built against Homebrew vulkan-loader (macOS / MoltenVK)."
	@echo "[vulkan_verify] Run with:"
	@echo "  export VK_ICD_FILENAMES=/opt/homebrew/etc/vulkan/icd.d/MoltenVK_icd.json"
	@echo "  export DYLD_LIBRARY_PATH=/opt/homebrew/opt/vulkan-loader/lib:/opt/homebrew/opt/molten-vk/lib"
else
ifeq ($(wildcard $(ELIZA_DFLASH_VULKAN_HEADERS_DIR)/vulkan/vulkan.hpp),)
	@echo "Vulkan harness needs one of:"
	@echo "  - VULKAN_SDK pointing at LunarG, or"
	@echo "  - macOS: brew install molten-vk vulkan-headers vulkan-loader, or"
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
	@echo "[kernels/verify] running vulkan_verify on Polar+QJL-residual fixture..."
	./vulkan_verify ../vulkan/polar.spv fixtures/polar_qjl.json

# Full Vulkan correctness gate for the default-on kernel set. Runs all five
# score kernels plus the Polar residual fixture so the optional residual branch
# is not left to source review only.
vulkan-verify: vulkan_verify vulkan-spirv reference-test
	@echo "[kernels/verify] vulkan turbo3..."
	./vulkan_verify ../vulkan/turbo3.spv fixtures/turbo3.json
	@echo "[kernels/verify] vulkan turbo4..."
	./vulkan_verify ../vulkan/turbo4.spv fixtures/turbo4.json
	@echo "[kernels/verify] vulkan turbo3_tcq..."
	./vulkan_verify ../vulkan/turbo3_tcq.spv fixtures/turbo3_tcq.json
	@echo "[kernels/verify] vulkan qjl..."
	./vulkan_verify ../vulkan/qjl.spv fixtures/qjl.json
	@echo "[kernels/verify] vulkan polar..."
	./vulkan_verify ../vulkan/polar.spv fixtures/polar.json
	@echo "[kernels/verify] vulkan polar + QJL residual..."
	./vulkan_verify ../vulkan/polar.spv fixtures/polar_qjl.json

# Native Linux end-to-end smoke for the Vulkan backend. This first runs the
# standalone fixture verifier, then builds the patched fork target and runs the
# graph-dispatch smoke below. It intentionally rejects software ICDs unless
# ELIZA_ALLOW_SOFTWARE_VULKAN=1 is set, because lavapipe/MoltenVK are not a
# native Linux desktop driver signoff.
vulkan-native-smoke:
	./linux_vulkan_smoke.sh

# Android on-device standalone Vulkan smoke. Cross-compiles vulkan_verify with
# the NDK, pushes the verifier + SPIR-V + fixtures via adb, and runs all six
# fixture checks on the physical device. This is not a graph-dispatch pass; it
# proves the same SPIR-V works on Adreno/Mali-class drivers.
android-vulkan-smoke:
	./android_vulkan_smoke.sh

# Metal harness (macOS only). Requires xcrun on PATH.
metal: metal_verify
metal_verify: metal_verify.mm $(REF_OBJ) $(QJL_POLAR_OBJ)
	@which xcrun >/dev/null 2>&1 || { echo "xcrun not found — Metal harness needs macOS Xcode tools."; exit 1; }
	clang++ $(CXXFLAGS) -ObjC++ -fobjc-arc -I../reference \
		metal_verify.mm $(REF_OBJ) $(QJL_POLAR_OBJ) \
		-framework Foundation -framework Metal -framework MetalKit -framework CoreGraphics \
		-lm -o metal_verify

# Full Metal correctness gate for the default-on kernel set. The single-block
# kernels are the compatibility entrypoints; Polar is checked both with and
# without its QJL residual branch.
metal-verify: metal_verify reference-test
	@echo "[kernels/verify] metal turbo3..."
	./metal_verify ../metal/turbo3.metal     kernel_turbo3_dot          fixtures/turbo3.json
	@echo "[kernels/verify] metal turbo4..."
	./metal_verify ../metal/turbo4.metal     kernel_turbo4_dot          fixtures/turbo4.json
	@echo "[kernels/verify] metal turbo3_tcq..."
	./metal_verify ../metal/turbo3_tcq.metal kernel_turbo3_tcq_dot      fixtures/turbo3_tcq.json
	@echo "[kernels/verify] metal qjl..."
	./metal_verify ../metal/qjl.metal        kernel_attn_score_qjl1_256 fixtures/qjl.json
	@echo "[kernels/verify] metal polar..."
	./metal_verify ../metal/polar.metal      kernel_mul_mv_q4_polar_f32 fixtures/polar.json
	@echo "[kernels/verify] metal polar + QJL residual..."
	./metal_verify ../metal/polar.metal      kernel_mul_mv_q4_polar_f32 fixtures/polar_qjl.json

# Additive check for the long-context multi-block Metal entrypoints. These
# are separate symbols from the compatibility entrypoints and need direct
# harness coverage whenever their dispatch shape changes.
metal-verify-multiblock: metal_verify reference-test
	@for n in 2 3 4 8; do \
	  echo "[kernels/verify] metal turbo3 multi $$n..." && \
	  ./metal_verify ../metal/turbo3.metal kernel_turbo3_dot_multi fixtures/turbo3.json --multi $$n && \
	  echo "[kernels/verify] metal turbo4 multi $$n..." && \
	  ./metal_verify ../metal/turbo4.metal kernel_turbo4_dot_multi fixtures/turbo4.json --multi $$n && \
	  echo "[kernels/verify] metal turbo3_tcq multi $$n..." && \
	  ./metal_verify ../metal/turbo3_tcq.metal kernel_turbo3_tcq_dot_multi fixtures/turbo3_tcq.json --multi $$n && \
	  echo "[kernels/verify] metal qjl multi $$n..." && \
	  ./metal_verify ../metal/qjl.metal kernel_attn_score_qjl1_256_multi fixtures/qjl.json --multi $$n || exit 1; \
	done

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
	@echo "[cuda-verify] polar + QJL residual ..." ; ./cuda_verify fixtures/polar_qjl.json
endif

# Hardware runners. These intentionally fail without matching physical
# hardware and a model-backed graph smoke (ELIZA_DFLASH_SMOKE_MODEL).
cuda-hardware:
	./cuda_runner.sh

rocm-hardware:
	./rocm_runner.sh

gh200-hardware:
	./gh200_runner.sh

windows-hardware:
	@echo "Run on a native Windows host:"
	@echo "  pwsh -File packages/inference/verify/windows_runner.ps1 -Backend cuda -Model C:\\\\models\\\\eliza-1-smoke.gguf"

# Drift check between the standalone shaders in packages/inference/{metal,vulkan}/
# and the fork's in-tree shaders. Both ship the same kernel symbols and decode
# math (the standalones add perf-only divergence; see PATCH_AUDIT_2026-05-10.md
# §"Standalone-vs-fork shader drift"). The reference runs of metal_verify /
# vulkan_verify validated the standalones; this target re-runs the same harness
# against the fork's in-tree variants so we can confirm 8/8 PASS still holds
# before signing off a bundle.
#
# The fork is the milady-ai/llama.cpp checkout the build script clones into
# ~/.cache/eliza-dflash/milady-llama-cpp. If the cache dir is absent, this
# target prints a clear "fork not present, please run build first" message
# rather than failing cryptically.
ELIZA_DFLASH_FORK_METAL_DIR := $(ELIZA_DFLASH_LLAMA_DIR)/ggml/src/ggml-metal/milady-shipped
ELIZA_DFLASH_FORK_VULKAN_DIR := $(ELIZA_DFLASH_LLAMA_DIR)/ggml/src/ggml-vulkan/vulkan-shaders

verify-fork:
ifeq ($(wildcard $(ELIZA_DFLASH_LLAMA_DIR)/.git),)
	@echo "[verify-fork] fork not present at $(ELIZA_DFLASH_LLAMA_DIR)"
	@echo "[verify-fork] run 'node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target darwin-arm64-metal'"
	@echo "[verify-fork] (or any other target) first to clone it, then re-run this target."
	@false
else
	@if which xcrun >/dev/null 2>&1; then \
	  if [ ! -d "$(ELIZA_DFLASH_FORK_METAL_DIR)" ]; then \
	    echo "[verify-fork] fork present but $(ELIZA_DFLASH_FORK_METAL_DIR) missing — fork layout drift."; \
	    echo "[verify-fork] run 'node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target darwin-arm64-metal --dry-run' to stage/describe the shipped kernel patch."; \
	    exit 1; \
	  fi; \
	  $(MAKE) metal_verify >/dev/null && \
	  echo "[verify-fork] metal/turbo3   (patched shipped: turbo3.metal)"     && ./metal_verify $(ELIZA_DFLASH_FORK_METAL_DIR)/turbo3.metal     kernel_turbo3_dot          fixtures/turbo3.json     && \
	  echo "[verify-fork] metal/turbo4   (patched shipped: turbo4.metal)"     && ./metal_verify $(ELIZA_DFLASH_FORK_METAL_DIR)/turbo4.metal     kernel_turbo4_dot          fixtures/turbo4.json     && \
	  echo "[verify-fork] metal/turbo3_tcq (patched shipped: turbo3_tcq.metal)" && ./metal_verify $(ELIZA_DFLASH_FORK_METAL_DIR)/turbo3_tcq.metal kernel_turbo3_tcq_dot      fixtures/turbo3_tcq.json && \
	  echo "[verify-fork] metal/qjl     (patched shipped: qjl.metal)"         && ./metal_verify $(ELIZA_DFLASH_FORK_METAL_DIR)/qjl.metal        kernel_attn_score_qjl1_256 fixtures/qjl.json        && \
	  echo "[verify-fork] metal/polar   (patched shipped: polar.metal)"       && ./metal_verify $(ELIZA_DFLASH_FORK_METAL_DIR)/polar.metal      kernel_mul_mv_q4_polar_f32 fixtures/polar.json      && \
	  echo "[verify-fork] metal: 5/5 patched shipped shaders verified against the same fixtures as the standalones"; \
	else \
	  echo "[verify-fork] xcrun not found — skipping Metal fork verification (macOS only)"; \
	fi
	@if [ -d "$(ELIZA_DFLASH_FORK_VULKAN_DIR)" ] && ls $(ELIZA_DFLASH_FORK_VULKAN_DIR)/turbo3.comp >/dev/null 2>&1; then \
	  if [ -z "$(GLSLC)" ]; then \
	    echo "[verify-fork] vulkan: glslc not found — cannot compile fork .comp -> .spv; skipping"; \
	  elif $(MAKE) vulkan_verify >/dev/null 2>&1 && [ -x ./vulkan_verify ]; then \
	    mkdir -p bench_results/fork-spv; \
	    echo "[verify-fork] vulkan: compiling fork .comp -> .spv with $(GLSLC)"; \
	    for f in turbo3 turbo4 turbo3_tcq qjl polar; do \
	      $(GLSLC) --target-env=vulkan1.1 --target-spv=spv1.3 -fshader-stage=compute \
	        $(ELIZA_DFLASH_FORK_VULKAN_DIR)/$$f.comp -o bench_results/fork-spv/$$f.spv || exit 1; \
	      echo "[verify-fork] vulkan/$$f (fork: vulkan-shaders/$$f.comp)"; \
	      ./vulkan_verify bench_results/fork-spv/$$f.spv fixtures/$$f.json || exit 1; \
	    done; \
	    echo "[verify-fork] vulkan/polar + QJL residual (fork: vulkan-shaders/polar.comp)"; \
	    ./vulkan_verify bench_results/fork-spv/polar.spv fixtures/polar_qjl.json || exit 1; \
	    echo "[verify-fork] vulkan: 5/5 fork shaders + polar residual verified against standalone fixtures"; \
	  else \
	    echo "[verify-fork] vulkan_verify not buildable on this host — skipping Vulkan fork verification"; \
	  fi; \
	else \
	  echo "[verify-fork] $(ELIZA_DFLASH_FORK_VULKAN_DIR) not staged with milady shaders (run a *-vulkan build target first); skipping Vulkan fork verification"; \
	fi
	@echo "[verify-fork] done. Compare the per-kernel pass/fail above against the standalone reference runs to detect drift."
endif

# GGML_OP_ATTN_SCORE_QJL Metal dispatch smoke test. Links against the BUILT
# libggml-metal.dylib / libggml-base.dylib in the fork's
# build/darwin-arm64-metal/bin tree, so it exercises the actual fork dispatch
# pipeline (not the JIT). Prerequisite:
# `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target
# darwin-arm64-metal` has succeeded and produced libggml-*.dylib + the
# milady kernels in default.metallib.
ELIZA_DFLASH_METAL_BUILD_DIR ?= $(ELIZA_DFLASH_LLAMA_DIR)/build/darwin-arm64-metal
ELIZA_DFLASH_METAL_BIN_DIR   ?= $(ELIZA_DFLASH_METAL_BUILD_DIR)/bin
ELIZA_DFLASH_VULKAN_BUILD_DIR ?= $(ELIZA_DFLASH_LLAMA_DIR)/build/linux-x64-vulkan
ELIZA_DFLASH_VULKAN_BIN_DIR   ?= $(ELIZA_DFLASH_VULKAN_BUILD_DIR)/bin

dispatch-smoke: dispatch_smoke
	@echo "[dispatch-smoke] running against $(ELIZA_DFLASH_METAL_BIN_DIR)"
	GGML_METAL_PATH_RESOURCES=$(ELIZA_DFLASH_METAL_BIN_DIR) \
	  DYLD_LIBRARY_PATH=$(ELIZA_DFLASH_METAL_BIN_DIR):$$DYLD_LIBRARY_PATH \
	  ./dispatch_smoke

dispatch_smoke: dispatch_smoke.mm
	@which xcrun >/dev/null 2>&1 || { echo "xcrun not found — Metal dispatch-smoke needs macOS Xcode tools."; exit 1; }
	@if [ ! -f "$(ELIZA_DFLASH_METAL_BIN_DIR)/libggml-metal.dylib" ]; then \
	    echo "[dispatch-smoke] missing $(ELIZA_DFLASH_METAL_BIN_DIR)/libggml-metal.dylib"; \
	    echo "[dispatch-smoke] run 'node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target darwin-arm64-metal' first."; \
	    exit 1; \
	fi
	clang++ $(CXXFLAGS) -ObjC++ -fobjc-arc \
	    -I$(ELIZA_DFLASH_LLAMA_DIR)/ggml/include \
	    -I$(ELIZA_DFLASH_LLAMA_DIR)/ggml/src \
	    dispatch_smoke.mm \
	    -L$(ELIZA_DFLASH_METAL_BIN_DIR) -lggml-base -lggml-metal -lggml-cpu -lggml \
	    -framework Foundation -framework Metal -framework MetalKit -framework CoreGraphics \
	    -Wl,-rpath,$(ELIZA_DFLASH_METAL_BIN_DIR) \
	    -lm -o dispatch_smoke

vulkan-dispatch-smoke: vulkan_dispatch_smoke
	@echo "[vulkan-dispatch-smoke] running against $(ELIZA_DFLASH_VULKAN_BIN_DIR)"
	LD_LIBRARY_PATH=$(ELIZA_DFLASH_VULKAN_BIN_DIR):$$LD_LIBRARY_PATH \
	DYLD_LIBRARY_PATH=$(ELIZA_DFLASH_VULKAN_BIN_DIR):$$DYLD_LIBRARY_PATH \
	  ./vulkan_dispatch_smoke

vulkan_dispatch_smoke: vulkan_dispatch_smoke.cpp
	@if [ ! -f "$(ELIZA_DFLASH_VULKAN_BIN_DIR)/libggml-vulkan.so" ] && [ ! -f "$(ELIZA_DFLASH_VULKAN_BIN_DIR)/libggml-vulkan.dylib" ]; then \
	    echo "[vulkan-dispatch-smoke] missing libggml-vulkan under $(ELIZA_DFLASH_VULKAN_BIN_DIR)"; \
	    echo "[vulkan-dispatch-smoke] run 'node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-vulkan' on a Linux Vulkan host first."; \
	    exit 1; \
	fi
	$(CXX) $(CXXFLAGS) \
	    -I$(ELIZA_DFLASH_LLAMA_DIR)/ggml/include \
	    -I$(ELIZA_DFLASH_LLAMA_DIR)/ggml/src \
	    vulkan_dispatch_smoke.cpp \
	    -L$(ELIZA_DFLASH_VULKAN_BIN_DIR) -lggml-base -lggml-vulkan -lggml-cpu -lggml \
	    -Wl,-rpath,$(ELIZA_DFLASH_VULKAN_BIN_DIR) \
	    -lm -o vulkan_dispatch_smoke

clean:
	rm -f $(REF_OBJ) $(QJL_POLAR_OBJ) gen_fixture vulkan_verify metal_verify metal_bench cpu_bench cuda_verify dispatch_smoke vulkan_dispatch_smoke
	rm -f ../vulkan/*.spv
