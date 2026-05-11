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

.PHONY: all reference-test kernel-contract vulkan vulkan-spirv vulkan-verify vulkan-verify-multiblock vulkan-verify-fallbacks vulkan-verify-fused vulkan-qjl-polar vulkan-dispatch-smoke vulkan-native-smoke android-vulkan-smoke metal metal-verify metal-verify-multiblock metal-verify-fused metal-bench metal-bench-batched metal-bench-multiblock cpu-bench bench cuda cuda-verify cuda-hardware rocm-hardware gh200-hardware windows-hardware verify-fork dispatch-smoke dispatch-smoke-implemented clean

all: reference-test
	@echo "[kernels/verify] Built reference test."
	@echo "[kernels/verify] To build the Vulkan harness: VULKAN_SDK=/path/to/sdk make vulkan"
	@echo "[kernels/verify] To build the Metal harness (macOS): make metal"

$(REF_OBJ): $(REF_SRC) ../reference/turbo_kernels.h
	$(CC) $(CFLAGS) -c $< -o $@

$(QJL_POLAR_OBJ): $(QJL_POLAR_SRC) qjl_polar_ref.h ../reference/turbo_kernels.h
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
	@echo "[kernels/verify] running vulkan_verify on Polar pre-Hadamard-query fixture..."
	./vulkan_verify ../vulkan/polar_preht.spv fixtures/polar.json
	@echo "[kernels/verify] running vulkan_verify on Polar pre-Hadamard-query + QJL-residual fixture..."
	./vulkan_verify ../vulkan/polar_preht.spv fixtures/polar_qjl.json

# Full Vulkan correctness gate for the default-on kernel set. Runs all five
# score kernels plus Polar residual and pre-Hadamard variants so the optional
# residual branch and H*q hot path are not left to source review only.
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
	@echo "[kernels/verify] vulkan polar pre-Hadamard query..."
	./vulkan_verify ../vulkan/polar_preht.spv fixtures/polar.json
	@echo "[kernels/verify] vulkan polar pre-Hadamard query + QJL residual..."
	./vulkan_verify ../vulkan/polar_preht.spv fixtures/polar_qjl.json

# Multi-block-per-workgroup Vulkan variants. One SPV family per kernel; the
# blocks/tokens-per-workgroup specialization constant (constant_id 0) is set
# at pipeline-create time. Sweeps N ∈ {1,2,4,8}; each must match the same
# fixture as its base kernel. Additive — not part of the publish gate
# (vulkan-verify) so a future per-device tuning regression is visible
# separately from the canonical kernel set.
vulkan-verify-multiblock: vulkan_verify vulkan-spirv reference-test
	@for n in 1 2 4 8; do \
	  echo "[kernels/verify] vulkan turbo3 multi $$n..." && \
	  ./vulkan_verify ../vulkan/turbo3_multi.spv     fixtures/turbo3.json     --multi $$n && \
	  echo "[kernels/verify] vulkan turbo4 multi $$n..." && \
	  ./vulkan_verify ../vulkan/turbo4_multi.spv     fixtures/turbo4.json     --multi $$n && \
	  echo "[kernels/verify] vulkan turbo3_tcq multi $$n..." && \
	  ./vulkan_verify ../vulkan/turbo3_tcq_multi.spv fixtures/turbo3_tcq.json --multi $$n && \
	  echo "[kernels/verify] vulkan qjl multi $$n..." && \
	  ./vulkan_verify ../vulkan/qjl_multi.spv        fixtures/qjl.json        --multi $$n || exit 1; \
	done

# Staged Vulkan fallback entrypoints (decode-to-fp32 / non-attention matvec).
# Expected outputs are computed in vulkan_verify.cpp from the bit-exact C
# reference (eliza_qjl_mul_mv / eliza_qjl_dequantize_row / eliza_polar_dequantize_row),
# so no new fixture file is required. Additive — kept out of the publish gate
# (vulkan-verify) because these are not on the runtime hot path; the runtime
# dispatches qjl.comp / polar.comp / polar_preht.comp.
#
#   * qjl_mul_mv: hard gate. It is the QJL-score parity check (n_heads ==
#     n_kv_heads == 1, n_rows == n_tokens), reduction-based, and passes
#     deterministically on every ICD tested (Intel ANV, lavapipe).
#   * qjl_get_rows / polar_get_rows: informational. These write one fp32
#     output per element from all 32 invocations (no reduction). They are
#     bit-exact and deterministic on lavapipe, but on Mesa ANV (Arrow Lake /
#     Xe-LPG, Mesa 25.2.8) a handful of output elements intermittently read
#     back 0 — an ANV codegen issue with the all-threads strided SSBO store,
#     not a logic bug (the reduction-based polar.comp/polar_preht.comp share
#     the same decode and are clean). Run shown for visibility; `-` so a
#     flaky ANV result does not fail this target.
vulkan-verify-fallbacks: vulkan_verify vulkan-spirv reference-test
	@echo "[kernels/verify] vulkan qjl_mul_mv (== qjl score parity, n_rows=8)..."
	./vulkan_verify ../vulkan/qjl_mul_mv.spv  fixtures/qjl.json
	@echo "[kernels/verify] vulkan qjl_get_rows (decode block 0 vs eliza_qjl_dequantize_row; informational on ANV)..."
	-./vulkan_verify ../vulkan/qjl_get_rows.spv fixtures/qjl.json
	@echo "[kernels/verify] vulkan polar_get_rows use_qjl=0 (decode block 0 vs eliza_polar_dequantize_row; informational on ANV)..."
	-./vulkan_verify ../vulkan/polar_get_rows.spv fixtures/polar.json
	@echo "[kernels/verify] vulkan polar_get_rows use_qjl=1 (informational on ANV)..."
	-./vulkan_verify ../vulkan/polar_get_rows.spv fixtures/polar_qjl.json

# Fused-attention (QJL-K + TBQ-V / Polar-V) Vulkan gate. vulkan/fused_attn_qjl_tbq.comp
# and vulkan/fused_attn_qjl_polar.comp port GGML_OP_FUSED_ATTN_QJL_TBQ + the Polar
# V-mix variant: one-pass FlashAttention-style online softmax per head, the score
# vector never materialized, a driver-portable 32-thread shared-memory reduction
# (no subgroup assumptions). vulkan_verify's run_fused_attn() parses the
# `cases`-array fixture schema (n_kv ∈ {64, 512, 256, 128} standing in for the
# 4k/32k/128k/256k regimes, GQA fanouts 1/2/4) and diffs against the C reference
# (eliza_fused_attn_qjl_tbq3 / eliza_fused_attn_qjl_polar). 1e-3 absolute tolerance.
# Backend-neutral contract: reports/porting/2026-05-11/fused-attn-op-contract.md
# Metal-specific design: reports/porting/2026-05-11/metal-fused-attn-and-polar-preht-design.md
vulkan-verify-fused: vulkan_verify vulkan-spirv reference-test
	@echo "[kernels/verify] vulkan fused-attn QJL-K + TBQ3-V..."
	./vulkan_verify ../vulkan/fused_attn_qjl_tbq.spv   fixtures/fused_attn_qjl_tbq.json
	@echo "[kernels/verify] vulkan fused-attn QJL-K + Q4_POLAR-V (use_qjl=1)..."
	./vulkan_verify ../vulkan/fused_attn_qjl_polar.spv fixtures/fused_attn_qjl_polar.json

# Native Linux end-to-end smoke for the Vulkan backend. This first runs the
# standalone fixture verifier, then builds the patched fork target and runs the
# graph-dispatch smoke below. It writes hardware-results evidence, rejects
# software ICDs unless ELIZA_ALLOW_SOFTWARE_VULKAN=1 is set, and refuses stale
# or symbol-only artifacts.
vulkan-native-smoke:
	./linux_vulkan_smoke.sh

# Android on-device standalone Vulkan smoke. Cross-compiles vulkan_verify with
# the NDK, pushes the verifier + SPIR-V + fixtures via adb, and runs all eight
# fixture checks on the physical device. Standalone fixture success is only
# evidence; the script exits non-zero until Android graph-dispatch evidence is
# supplied through ELIZA_ANDROID_VULKAN_GRAPH_EVIDENCE.
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
	@echo "[kernels/verify] metal polar pre-Hadamard query..."
	./metal_verify ../metal/polar.metal      kernel_mul_mv_q4_polar_preht_f32 fixtures/polar.json
	@echo "[kernels/verify] metal polar pre-Hadamard query + QJL residual..."
	./metal_verify ../metal/polar.metal      kernel_mul_mv_q4_polar_preht_f32 fixtures/polar_qjl.json

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

# Fused-attention (QJL-K + TBQ-V / Polar-V) + Polar pre-Hadamard-query Metal
# gate. metal/fused_attn_qjl_tbq.metal and metal/fused_attn_qjl_polar.metal port
# GGML_OP_FUSED_ATTN_QJL_TBQ + the Polar V-mix variant (one-pass online softmax,
# per-token QJL score via simd_sum, threadgroup-scratch TBQ Hadamard-32 / Polar
# Hadamard-128, score vector never materialized). metal/polar_preht.metal adds
# kernel_attn_score_q4_polar_preht_f32(_multi) — Polar dot vs a pre-Hadamarded
# query. metal_verify's run_fused_attn() / run_polar_preht() parse the cases-array
# and the polar_preht fixture; both diff bit-for-bit against the C references
# (eliza_fused_attn_qjl_tbq3 / eliza_fused_attn_qjl_polar / eliza_polar_mul_mv).
# 1e-3 absolute tolerance.
#
# AUTHORED — hardware-verify pending: the kernels are byte-faithful mirrors of
# the hardware-verified Vulkan ports (vulkan/fused_attn_*.comp, vulkan/polar_preht.comp,
# Intel ARL Mesa ANV). They require an Apple-Silicon Mac to run this target; until
# then the fused_attn Metal capability bit stays not-runtime-ready (fused_attn is
# an optimization on top of the five required kernels — AGENTS.md §3 — not a
# required kernel).
# Backend-neutral contract: reports/porting/2026-05-11/fused-attn-op-contract.md
# Metal-specific design: reports/porting/2026-05-11/metal-fused-attn-and-polar-preht-design.md
metal-verify-fused: metal_verify reference-test
	@echo "[kernels/verify] metal fused-attn QJL-K + TBQ3-V..."
	./metal_verify ../metal/fused_attn_qjl_tbq.metal   kernel_fused_attn_qjl_tbq3_f32 fixtures/fused_attn_qjl_tbq.json
	@echo "[kernels/verify] metal fused-attn QJL-K + Q4_POLAR-V (use_qjl=1)..."
	./metal_verify ../metal/fused_attn_qjl_polar.metal kernel_fused_attn_qjl_polar_f32 fixtures/fused_attn_qjl_polar.json
	@echo "[kernels/verify] metal Polar pre-Hadamard query score (use_qjl 0/1)..."
	./metal_verify ../metal/polar_preht.metal kernel_attn_score_q4_polar_preht_f32 fixtures/polar_preht.json
	@for n in 2 3 4 8; do \
	  echo "[kernels/verify] metal Polar pre-Hadamard query score multi $$n..." && \
	  ./metal_verify ../metal/polar_preht.metal kernel_attn_score_q4_polar_preht_f32_multi fixtures/polar_preht.json --multi $$n || exit 1; \
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
    $(wildcard $(HOME)/Library/Android/sdk/ndk/*/shader-tools/darwin-x86_64/glslc) \
    $(wildcard $(HOME)/Library/Android/sdk/ndk/*/shader-tools/linux-x86_64/glslc) \
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
    ../vulkan/polar_preht.spv \
    ../vulkan/polar_get_rows.spv \
    ../vulkan/turbo3_multi.spv \
    ../vulkan/turbo4_multi.spv \
    ../vulkan/turbo3_tcq_multi.spv \
    ../vulkan/qjl_multi.spv \
    ../vulkan/fused_attn_qjl_tbq.spv \
    ../vulkan/fused_attn_qjl_polar.spv

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

# CUDA harness. Sibling of metal/vulkan_verify. Self-contained: needs only
# nvcc + the CUDA runtime headers (the in-fork ggml-cuda headers are NOT a
# build dependency — the harness ports the same reference algorithm into CUDA
# __device__ kernels that consume the fixture byte images directly, exactly
# like metal_verify / vulkan_verify port it into the shader). It links the
# same qjl_polar_ref.o the Metal/Vulkan harnesses link, for an on-host
# cross-check of the fixture's expected_scores.
#
# Resolution order:
#   1. nvcc on PATH       — required to compile (.cu -> ELF).
#   2. CUDA_HOME/include  — defaults to /usr/local/cuda; overridable.
#   3. ELIZA_DFLASH_LLAMA_DIR / ELIZA_DFLASH_LIBGGML_CUDA — UNUSED by this
#      harness now; retained as env so cuda_runner.sh's passthrough is inert.
NVCC ?= $(shell command -v nvcc 2>/dev/null)
CUDA_HOME ?= /usr/local/cuda
ELIZA_DFLASH_LLAMA_DIR ?= $(HOME)/.cache/eliza-dflash/milady-llama-cpp
ELIZA_DFLASH_LIBGGML_CUDA ?= $(ELIZA_DFLASH_LLAMA_DIR)/build-cuda/ggml/src/ggml-cuda/libggml-cuda.so

# CMAKE_CUDA_ARCHITECTURES the fork build hook should pin (platform-targets
# agent owns build-llama-cpp-dflash.mjs):
#   linux-x64-cuda      : 80;86;89;90;100;120   (Ampere..Blackwell, mobile dGPU = 12.0)
#   linux-aarch64-cuda  : 90a;90;100            (GH200 sm_90a + Hopper/Blackwell)
# For a one-off local build on this machine's Blackwell mobile dGPU:
#   ELIZA_DFLASH_CMAKE_FLAGS='-DCMAKE_CUDA_ARCHITECTURES=120;90' \
#     node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-cuda
#
# Compile-time arch list for the harness itself (cheap; one TU). Overridable
# with CUDA_ARCH_FLAGS. Default covers Ampere..Blackwell.
CUDA_ARCH_FLAGS ?= -gencode arch=compute_80,code=sm_80 \
    -gencode arch=compute_86,code=sm_86 \
    -gencode arch=compute_89,code=sm_89 \
    -gencode arch=compute_90,code=sm_90 \
    -gencode arch=compute_120,code=sm_120 \
    -gencode arch=compute_120,code=compute_120

CUDA_INCLUDES = -I$(CUDA_HOME)/include -I.

cuda: cuda_verify
cuda_verify: cuda_verify.cu tbq3_tcq_codebook.inc $(QJL_POLAR_OBJ) $(REF_OBJ)
ifeq ($(NVCC),)
	@echo "CUDA toolchain not found — install via 'apt install nvidia-cuda-toolkit' (Linux) or download the CUDA Toolkit (macOS not supported)."
	@false
else
	$(NVCC) -O2 -std=c++17 $(CUDA_ARCH_FLAGS) \
		$(CUDA_INCLUDES) \
		cuda_verify.cu $(QJL_POLAR_OBJ) $(REF_OBJ) \
		-lcudart -lm -o cuda_verify
endif

# Source-level correctness check (a non-CUDA host can run this — nvcc NOT
# required). Two phases:
#   1. Harness self-consistency — assert cuda_verify.cu defines a CUDA kernel
#      for every fixture family and includes the generated TCQ codebook.
#   2. Codebook integrity — assert the generated .inc has exactly 512 floats
#      matching reference/turbo_kernels.c.
# Full nvcc compile + runtime 8/8 PASS are gated on a CUDA host — see
# CUDA_VERIFICATION.md.
cuda-preprocess-check:
	@echo "[cuda-preprocess-check] (1) harness kernel coverage"
	@grep -q 'turbo34_score_kernel'   cuda_verify.cu || { echo "  MISS: turbo34_score_kernel"; exit 1; }
	@grep -q 'turbo3_tcq_score_kernel' cuda_verify.cu || { echo "  MISS: turbo3_tcq_score_kernel"; exit 1; }
	@grep -q 'qjl_score_kernel'        cuda_verify.cu || { echo "  MISS: qjl_score_kernel"; exit 1; }
	@grep -q 'polar_score_kernel'      cuda_verify.cu || { echo "  MISS: polar_score_kernel"; exit 1; }
	@grep -q 'tbq3_tcq_codebook.inc'   cuda_verify.cu || { echo "  MISS: codebook include"; exit 1; }
	@echo "  OK: turbo3/turbo4/turbo3_tcq/qjl/polar kernels + codebook include present"
	@echo "[cuda-preprocess-check] (2) generated codebook integrity"
	@test -f tbq3_tcq_codebook.inc || { echo "  MISS: tbq3_tcq_codebook.inc — run 'make tbq3_tcq_codebook.inc'"; exit 1; }
	@n=$$(grep -oE '[-+]?[0-9][0-9.eE+-]*f?' tbq3_tcq_codebook.inc | wc -l); \
		test "$$n" = "512" || { echo "  FAIL: codebook has $$n entries, expected 512"; exit 1; }
	@echo "  OK: tbq3_tcq_codebook.inc has 512 entries"
	@echo "[cuda-preprocess-check] (3) fork CUDA kernel headers present (informational)"
	@for h in turboquant.cuh turbo-tcq.cuh qjl.cuh polarquant.cuh; do \
		if [ -f "$(ELIZA_DFLASH_LLAMA_DIR)/ggml/src/ggml-cuda/$$h" ]; then echo "  present: $$h"; \
		else echo "  ABSENT: $$h (fork CUDA KV-cache kernels not yet landed — see CUDA_VERIFICATION.md)"; fi; \
	done
	@echo "[cuda-preprocess-check] OK"

# Regenerate the device-side TCQ codebook include from the C reference (the
# single source of truth: reference/turbo_kernels.c::ELIZA_TURBO3_TCQ_CODEBOOK).
tbq3_tcq_codebook.inc: ../reference/turbo_kernels.c
	@python3 -c "import re,sys; \
src=open('../reference/turbo_kernels.c').read(); \
m=re.search(r'ELIZA_TURBO3_TCQ_CODEBOOK\[512\]\s*=\s*\{(.*?)\};', src, re.S); \
open('tbq3_tcq_codebook.inc','w').write(m.group(1).strip()+'\n'); \
n=len(re.findall(r'[-+]?[0-9][0-9.eE+-]*f?', m.group(1))); \
sys.exit(0 if n==512 else 'codebook extraction got %d entries'%n)"
	@echo "[tbq3_tcq_codebook.inc] regenerated from reference/turbo_kernels.c (512 entries)"

# `cuda-verify` runs the harness against all six fixtures, same shape as
# `bench` does for the perf harness. Gated on nvcc presence so it stays
# safe on hosts without a CUDA toolchain. (fused_attn_qjl_tbq.json is run too
# if the fused-attention-reference agent has landed it.)
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
	@if [ -f fixtures/fused_attn_qjl_tbq.json ]; then \
		echo "[cuda-verify] fused QJL-K + TBQ-V attention ..." ; ./cuda_verify fixtures/fused_attn_qjl_tbq.json ; \
	else echo "[cuda-verify] fused_attn_qjl_tbq.json not present — fused-attention-reference agent owns it; skipping" ; fi
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
	  echo "[verify-fork] metal/polar_preht (patched shipped: polar.metal)"   && ./metal_verify $(ELIZA_DFLASH_FORK_METAL_DIR)/polar.metal      kernel_mul_mv_q4_polar_preht_f32 fixtures/polar.json && \
	  echo "[verify-fork] metal/polar_preht + QJL residual (patched shipped: polar.metal)" && ./metal_verify $(ELIZA_DFLASH_FORK_METAL_DIR)/polar.metal kernel_mul_mv_q4_polar_preht_f32 fixtures/polar_qjl.json && \
	  echo "[verify-fork] metal: 5/5 patched shipped shader files plus Polar preht variants verified against the same fixtures as the standalones"; \
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
	    $(GLSLC) --target-env=vulkan1.1 --target-spv=spv1.3 -fshader-stage=compute \
	      $(ELIZA_DFLASH_FORK_VULKAN_DIR)/polar_preht.comp -o bench_results/fork-spv/polar_preht.spv || exit 1; \
	    echo "[verify-fork] vulkan/polar_preht (fork: vulkan-shaders/polar_preht.comp)"; \
	    ./vulkan_verify bench_results/fork-spv/polar_preht.spv fixtures/polar.json || exit 1; \
	    echo "[verify-fork] vulkan/polar_preht + QJL residual (fork: vulkan-shaders/polar_preht.comp)"; \
	    ./vulkan_verify bench_results/fork-spv/polar_preht.spv fixtures/polar_qjl.json || exit 1; \
	    echo "[verify-fork] vulkan: 6/6 fork score shaders + polar residual/preht variants verified against standalone fixtures"; \
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
ELIZA_STATE_DIR ?= $(HOME)/.eliza
ELIZA_DFLASH_TARGET ?= linux-x64-vulkan
ifneq ($(strip $(ELIZA_DFLASH_TARGET_OUT_DIR)),)
ELIZA_DFLASH_VULKAN_OUT_DIR ?= $(ELIZA_DFLASH_TARGET_OUT_DIR)
else
ELIZA_DFLASH_VULKAN_OUT_DIR ?= $(ELIZA_STATE_DIR)/local-inference/bin/dflash/$(ELIZA_DFLASH_TARGET)
endif
ELIZA_DFLASH_VULKAN_BUILD_DIR ?= $(ELIZA_DFLASH_LLAMA_DIR)/build/$(ELIZA_DFLASH_TARGET)
ELIZA_DFLASH_VULKAN_BUILD_BIN_DIR := $(ELIZA_DFLASH_VULKAN_BUILD_DIR)/bin
ifndef ELIZA_DFLASH_VULKAN_BIN_DIR
ifneq ($(strip $(wildcard $(ELIZA_DFLASH_VULKAN_OUT_DIR)/libggml-vulkan.so)$(wildcard $(ELIZA_DFLASH_VULKAN_OUT_DIR)/libggml-vulkan.dylib)),)
ELIZA_DFLASH_VULKAN_BIN_DIR := $(ELIZA_DFLASH_VULKAN_OUT_DIR)
else
ELIZA_DFLASH_VULKAN_BIN_DIR := $(ELIZA_DFLASH_VULKAN_BUILD_BIN_DIR)
endif
endif

dispatch-smoke: dispatch_smoke
	@echo "[dispatch-smoke] running against $(ELIZA_DFLASH_METAL_BIN_DIR)"
	GGML_METAL_PATH_RESOURCES=$(ELIZA_DFLASH_METAL_BIN_DIR) \
	  DYLD_LIBRARY_PATH=$(ELIZA_DFLASH_METAL_BIN_DIR):$$DYLD_LIBRARY_PATH \
	  ./dispatch_smoke

dispatch-smoke-implemented: dispatch_smoke
	@echo "[dispatch-smoke] running implemented routes against $(ELIZA_DFLASH_METAL_BIN_DIR)"
	GGML_METAL_PATH_RESOURCES=$(ELIZA_DFLASH_METAL_BIN_DIR) \
	  DYLD_LIBRARY_PATH=$(ELIZA_DFLASH_METAL_BIN_DIR):$$DYLD_LIBRARY_PATH \
	  ./dispatch_smoke

dispatch_smoke: dispatch_smoke.mm $(REF_OBJ) $(QJL_POLAR_OBJ)
	@which xcrun >/dev/null 2>&1 || { echo "xcrun not found — Metal dispatch-smoke needs macOS Xcode tools."; exit 1; }
	@if [ ! -f "$(ELIZA_DFLASH_METAL_BIN_DIR)/libggml-metal.dylib" ]; then \
	    echo "[dispatch-smoke] missing $(ELIZA_DFLASH_METAL_BIN_DIR)/libggml-metal.dylib"; \
	    echo "[dispatch-smoke] run 'node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target darwin-arm64-metal' first."; \
	    exit 1; \
	fi
	clang++ $(CXXFLAGS) -ObjC++ -fobjc-arc \
	    -I$(ELIZA_DFLASH_LLAMA_DIR)/ggml/include \
	    -I$(ELIZA_DFLASH_LLAMA_DIR)/ggml/src \
	    -I../reference -I. \
	    dispatch_smoke.mm \
	    $(REF_OBJ) $(QJL_POLAR_OBJ) \
	    -L$(ELIZA_DFLASH_METAL_BIN_DIR) -lggml-base -lggml-metal -lggml-cpu -lggml \
	    -framework Foundation -framework Metal -framework MetalKit -framework CoreGraphics \
	    -Wl,-rpath,$(ELIZA_DFLASH_METAL_BIN_DIR) \
	    -lm -o dispatch_smoke

vulkan-dispatch-smoke: vulkan_dispatch_smoke
	@if [ "$$(uname -s)" != "Linux" ] && [ "$${ELIZA_ALLOW_MOLTENVK_VULKAN_DISPATCH_SMOKE:-0}" != "1" ]; then \
	    echo "[vulkan-dispatch-smoke] native Linux required for recordable Vulkan graph dispatch evidence."; \
	    echo "[vulkan-dispatch-smoke] macOS/MoltenVK can validate standalone SPIR-V only; it cannot flip runtime-ready Vulkan capability bits."; \
	    echo "[vulkan-dispatch-smoke] run './linux_vulkan_smoke.sh' on physical Linux Vulkan hardware or use './android_vulkan_smoke.sh' with Android graph evidence."; \
	    exit 2; \
	fi
	@echo "[vulkan-dispatch-smoke] running against $(ELIZA_DFLASH_VULKAN_BIN_DIR)"
	@echo "[vulkan-dispatch-smoke] managed output candidate: $(ELIZA_DFLASH_VULKAN_OUT_DIR)"
	@echo "[vulkan-dispatch-smoke] build-tree candidate: $(ELIZA_DFLASH_VULKAN_BUILD_BIN_DIR)"
	@echo "[vulkan-dispatch-smoke] requires ggml-vulkan to advertise and execute QJL/TBQ/Polar attention-score graph routes; symbol-only staging cannot pass"
	@if [ ! -f "$(ELIZA_DFLASH_VULKAN_BIN_DIR)/libggml-vulkan.so" ] && [ ! -f "$(ELIZA_DFLASH_VULKAN_BIN_DIR)/libggml-vulkan.dylib" ]; then \
	    echo "[vulkan-dispatch-smoke] missing libggml-vulkan under $(ELIZA_DFLASH_VULKAN_BIN_DIR)"; \
	    echo "[vulkan-dispatch-smoke] run 'node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target $(ELIZA_DFLASH_TARGET)' on a Linux Vulkan host first."; \
	    exit 1; \
	fi
	LD_LIBRARY_PATH=$(ELIZA_DFLASH_VULKAN_BIN_DIR):$$LD_LIBRARY_PATH \
	DYLD_LIBRARY_PATH=$(ELIZA_DFLASH_VULKAN_BIN_DIR):$$DYLD_LIBRARY_PATH \
	  ./vulkan_dispatch_smoke

vulkan_dispatch_smoke: vulkan_dispatch_smoke.cpp $(REF_OBJ) $(QJL_POLAR_OBJ)
	@if [ "$$(uname -s)" != "Linux" ] && [ "$${ELIZA_ALLOW_MOLTENVK_VULKAN_DISPATCH_SMOKE:-0}" != "1" ]; then \
	    echo "[vulkan-dispatch-smoke] native Linux required for recordable Vulkan graph dispatch evidence."; \
	    echo "[vulkan-dispatch-smoke] macOS/MoltenVK can validate standalone SPIR-V only; it cannot flip runtime-ready Vulkan capability bits."; \
	    echo "[vulkan-dispatch-smoke] run './linux_vulkan_smoke.sh' on physical Linux Vulkan hardware or use './android_vulkan_smoke.sh' with Android graph evidence."; \
	    exit 2; \
	fi
	@if [ ! -f "$(ELIZA_DFLASH_LLAMA_DIR)/ggml/include/ggml.h" ] || [ ! -f "$(ELIZA_DFLASH_LLAMA_DIR)/ggml/include/ggml-backend.h" ]; then \
	    echo "[vulkan-dispatch-smoke] missing ggml headers under $(ELIZA_DFLASH_LLAMA_DIR)"; \
	    echo "[vulkan-dispatch-smoke] run 'node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target $(ELIZA_DFLASH_TARGET)' first, or override ELIZA_DFLASH_LLAMA_DIR."; \
	    exit 1; \
	fi
	@if [ ! -f "$(ELIZA_DFLASH_VULKAN_BIN_DIR)/libggml-vulkan.so" ] && [ ! -f "$(ELIZA_DFLASH_VULKAN_BIN_DIR)/libggml-vulkan.dylib" ]; then \
	    echo "[vulkan-dispatch-smoke] missing libggml-vulkan under $(ELIZA_DFLASH_VULKAN_BIN_DIR)"; \
	    echo "[vulkan-dispatch-smoke] managed output candidate: $(ELIZA_DFLASH_VULKAN_OUT_DIR)"; \
	    echo "[vulkan-dispatch-smoke] build-tree candidate: $(ELIZA_DFLASH_VULKAN_BUILD_BIN_DIR)"; \
	    echo "[vulkan-dispatch-smoke] run 'node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target $(ELIZA_DFLASH_TARGET)' on a Linux Vulkan host first."; \
	    echo "[vulkan-dispatch-smoke] if using explicit prebuilt artifacts, set ELIZA_DFLASH_VULKAN_BIN_DIR=/path/to/the/bin-dir-containing-libggml-vulkan.so."; \
	    exit 1; \
	fi
	$(CXX) $(CXXFLAGS) \
	    -I$(ELIZA_DFLASH_LLAMA_DIR)/ggml/include \
	    -I$(ELIZA_DFLASH_LLAMA_DIR)/ggml/src \
	    -I../reference -I. \
	    vulkan_dispatch_smoke.cpp \
	    $(REF_OBJ) $(QJL_POLAR_OBJ) \
	    -L$(ELIZA_DFLASH_VULKAN_BIN_DIR) -lggml-base -lggml-vulkan -lggml-cpu -lggml \
	    -Wl,-rpath,$(ELIZA_DFLASH_VULKAN_BIN_DIR) \
	    -lm -o vulkan_dispatch_smoke

clean:
	rm -f $(REF_OBJ) $(QJL_POLAR_OBJ) gen_fixture vulkan_verify metal_verify metal_bench cpu_bench cuda_verify dispatch_smoke vulkan_dispatch_smoke
	rm -f ../vulkan/*.spv
