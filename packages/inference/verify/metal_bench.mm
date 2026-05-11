// metal_bench.mm — Metal performance harness for the five Eliza-1 KV-cache
// kernels (turbo3, turbo4, turbo3_tcq, qjl, polar).
//
// SCOPE: this is a perf harness, not a correctness harness. metal_verify.mm
// (sibling file) handles correctness against fixtures. metal_bench dispatches
// each kernel many times at production-relevant sizes and records:
//
//   - GPU-side end-to-end latency per dispatch (median, p50, p99) using
//     MTLCommandBuffer.GPUStartTime / GPUEndTime (no entitlements needed).
//   - Wall-clock CPU-side latency including command-buffer encode + commit +
//     waitUntilCompleted (so the gap between GPU and CPU time is visible).
//   - Estimated bytes-touched per dispatch (Q + K-blocks + score outputs).
//   - Bandwidth utilisation as % of M4 Max's 546 GB/s peak.
//   - Tokens/sec equivalent for a realistic 9B decode workload.
//
// Build:    make metal-bench   (see verify/Makefile)
// Run:      ./metal_bench [--out PATH] [--mode MODE] [--iters N] [--warmup N] [--runs N]
//
//   --mode default   : five-kernel timing run at TG=32 (the production
//                      dispatch shape). What this harness has always done.
//   --mode tgsweep   : threadgroup-size sensitivity sweep for QJL and Polar.
//                      Tries TG=32/64/128/256, reports which compiles + runs
//                      and at what speed. Both kernels reduce via simd_sum
//                      and assume one-SIMD-group threadgroups, so TG>32
//                      will fail dispatch — that result is itself a
//                      finding (kernels are SIMD-group-locked).
//   --mode fp16ref   : reference fp16 dot-product baseline. Same N=131072
//                      output blocks, but K is stored as fp16 (256 B/token)
//                      and dotted with simd_sum. This is the "unquantized"
//                      throughput we'd be giving up by NOT shipping the
//                      quantization kernels.
//
// --iters / --warmup / --runs override the per-mode defaults. The harness
// runs `runs` independent measurement blocks back-to-back and reports the
// median of those medians, plus run-to-run variance (so thermal throttling
// is visible in the output).
//
// Output:   JSON report at bench_results/m4max_<mode>_<timestamp>.json
//           (or --out path). Console prints a per-shader summary.
//
// Robustness to thermal throttling: shaders are interleaved (round-robin
// pass over all 5 kernels per outer iteration), not run back-to-back, so a
// hot shader doesn't bias one kernel's percentile distribution.

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fstream>
#include <random>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Production-sized dispatch parameters (9B-class decode step).
//
// 9B model approximation (Qwen3.5 9B / Eliza-1 9b): 80 layers, 32 KV
// heads (GQA factor 4 against 32 Q heads). head_dim=128. We pick a single
// decode step at seq_len=4096 as the target workload — that is what the
// kernel set actually runs in production at every layer of every decode step.
//
// For per-kernel sizes:
//   turbo3 / turbo4 / turbo3_tcq: n_kv blocks, where n_kv = (n_kv_heads * seq_len * blocks_per_kv).
//      For seq=4096, n_kv_heads=32, head_dim=128 (so blocks_per_kv depends on
//      whether head_dim == block_size_elements; for these kernels head_dim is
//      128 = one rotation group, so blocks_per_kv=1 for turbo3/4_tcq, 4 for
//      turbo3 (head_dim=128 split into 4 sub-blocks of 32 elements).
//   qjl:   n_heads=32, n_kv_heads=8, n_tokens=4096 (32 attn heads, GQA fanout 4).
//   polar: n_rows = n_kv_heads * seq_len = 32 * 4096 = 131072.
// ---------------------------------------------------------------------------

namespace {

// 9B decode workload (single attention step, single layer).
constexpr int kHeadDim     = 128;
constexpr int kSeq         = 4096;
constexpr int kKvHeads     = 32;
constexpr int kQHeads      = 32;       // GQA factor 1 here (Qwen3.5 9B has factor 4 with 8 KV heads,
                                       // but we use the kernel's own n_heads/n_kv_heads to reflect that for QJL).
constexpr int kQjlHeads    = 32;
constexpr int kQjlKvHeads  = 8;
constexpr int kQjlProjDim  = 256;
constexpr int kPolarRows   = kKvHeads * kSeq;     // 131072 rows
constexpr int kTurboNkv    = kKvHeads * kSeq;     // 131072 blocks of 128 elements

// Block byte sizes (must match the metal shaders' struct layouts).
constexpr int kTurbo3BlockBytes    = 14;   // norm(2) + 8 qs + 4 signs (for head_dim=128 -> 4 sub-blocks)
constexpr int kTurbo4BlockBytes    = 18;   // norm(2) + qs[16] (32 elements per block)
constexpr int kTurbo3TcqBlockBytes = 52;   // see ggml-common.h
constexpr int kQjlBlockBytes       = 34;   // qs[32] + bf16 norm
constexpr int kPolarBlockBytes     = 82;   // fp16 norm + 64 qs + 16 qjl signs

constexpr int kTurbo3BlocksPerKv    = 4;   // head_dim=128 / 32 elements per sub-block
constexpr int kTurbo4BlocksPerKv    = 4;   // head_dim=128 / 32 elements per sub-block
constexpr int kTurbo3TcqBlocksPerKv = 1;

constexpr int kIters       = 1000;        // target iteration count
constexpr int kItersHeavy  = 100;         // fall-back for slow kernels (>0.5s/run)
constexpr int kWarmup      = 50;
constexpr float kPeakBwGBs = 546.0f;       // M4 Max unified memory peak (546 GB/s)

constexpr int kLayers9B    = 80;          // Qwen3.5 9B layer count, used for tokens/sec extrapolation

struct TurboArgs {
    uint32_t head_dim;
    uint32_t n_kv;
    uint32_t kv_stride_blocks;
    uint32_t q_head;
    uint32_t head_offset_bytes;
};

struct QjlScoreArgs {
    uint32_t n_heads;
    uint32_t n_kv_heads;
    uint32_t n_tokens;
    uint32_t proj_dim;
};

struct PolarMvArgs {
    uint32_t n_rows;
    uint32_t head_dim;
    uint32_t use_qjl;
};

struct TurboArgsMulti {
    uint32_t head_dim;
    uint32_t n_kv;
    uint32_t kv_stride_blocks;
    uint32_t q_head;
    uint32_t head_offset_bytes;
    uint32_t blocks_per_threadgroup;
};

struct QjlScoreArgsMulti {
    uint32_t n_heads;
    uint32_t n_kv_heads;
    uint32_t n_tokens;
    uint32_t proj_dim;
    uint32_t tokens_per_threadgroup;
};

// turbo3_tcq codebook (512 entries) — copied from the verify path. We only
// need bytes that are byte-identical to whatever the shader expects; the
// values themselves don't change perf characteristics. Use a deterministic
// PRNG fill — the kernel reads them through a `device const float*` but this
// is bench, not verify, so any normal-magnitude floats are fine.
static std::vector<float> make_tcq_codebook() {
    std::vector<float> cb(512);
    std::mt19937 rng(0xCAFEFACE);
    std::normal_distribution<float> n01(0.0f, 0.18f);
    for (auto & v : cb) v = n01(rng);
    return cb;
}

static std::vector<float> randn_floats(size_t n, uint32_t seed) {
    std::vector<float> v(n);
    std::mt19937 rng(seed);
    std::normal_distribution<float> nd(0.0f, 1.0f);
    for (auto & f : v) f = nd(rng);
    return v;
}

static std::vector<uint8_t> rand_bytes(size_t n, uint32_t seed) {
    std::vector<uint8_t> v(n);
    std::mt19937 rng(seed);
    for (auto & b : v) b = (uint8_t)(rng() & 0xFF);
    return v;
}

static void hadamard128_inplace(std::vector<float> & x) {
    for (int h = 1; h < kHeadDim; h <<= 1) {
        for (int i = 0; i < kHeadDim; i += (h << 1)) {
            for (int j = i; j < i + h; ++j) {
                float a = x[(size_t)j];
                float b = x[(size_t)j + (size_t)h];
                x[(size_t)j] = a + b;
                x[(size_t)j + (size_t)h] = a - b;
            }
        }
    }
}

static double percentile(std::vector<double> & xs, double p) {
    if (xs.empty()) return 0.0;
    std::sort(xs.begin(), xs.end());
    double idx = p * (double)(xs.size() - 1);
    size_t lo = (size_t)std::floor(idx);
    size_t hi = (size_t)std::ceil(idx);
    if (lo == hi) return xs[lo];
    double t = idx - (double)lo;
    return xs[lo] * (1.0 - t) + xs[hi] * t;
}
static double median(std::vector<double> xs) { return percentile(xs, 0.5); }

// Per-kernel state kept around between iterations. Buffers are allocated
// once (warmup + measurement reuse them).
struct KernelBench {
    std::string name;
    std::string source_path;
    std::string kernel_func;

    id<MTLComputePipelineState> pso = nil;

    // Buffers
    id<MTLBuffer> q_buf       = nil;   // query / q_sketch / activation
    id<MTLBuffer> k_buf       = nil;   // packed K cache
    id<MTLBuffer> scores_buf  = nil;   // output
    id<MTLBuffer> cb_buf      = nil;   // tcq codebook (turbo3_tcq only)

    // Args (we re-encode per dispatch since [[buffer]] indexes differ)
    TurboArgs       turbo_args{};
    QjlScoreArgs    qjl_args{};
    PolarMvArgs     polar_args{};

    MTLSize threadgroup;
    MTLSize grid;

    // Estimated bytes-touched per dispatch (used for bandwidth %).
    uint64_t bytes_per_dispatch = 0;

    // Timing samples
    std::vector<double> gpu_us;     // GPUEndTime - GPUStartTime per dispatch
    std::vector<double> cpu_us;     // CPU wall around commit→waitUntilCompleted

    // Recorded outputs
    int n_outputs = 0;
};

// Compile a .metal source file to an MTLLibrary via runtime JIT, looking
// up `kernel_name` on it.
static id<MTLComputePipelineState> compile_kernel(id<MTLDevice> device,
                                                  const char * metal_path,
                                                  const char * kernel_name) {
    NSString * src = [NSString stringWithContentsOfFile:[NSString stringWithUTF8String:metal_path]
                                              encoding:NSUTF8StringEncoding error:nil];
    if (!src) {
        std::fprintf(stderr, "[metal_bench] cannot read %s\n", metal_path);
        return nil;
    }
    NSError * err = nil;
    id<MTLLibrary> lib = [device newLibraryWithSource:src options:nil error:&err];
    if (!lib) {
        std::fprintf(stderr, "[metal_bench] %s: compile failed: %s\n",
                     metal_path, [[err localizedDescription] UTF8String]);
        return nil;
    }
    id<MTLFunction> fn = [lib newFunctionWithName:[NSString stringWithUTF8String:kernel_name]];
    if (!fn) {
        std::fprintf(stderr, "[metal_bench] %s: kernel %s not found\n", metal_path, kernel_name);
        return nil;
    }
    id<MTLComputePipelineState> pso = [device newComputePipelineStateWithFunction:fn error:&err];
    if (!pso) {
        std::fprintf(stderr, "[metal_bench] %s: pipeline failed: %s\n",
                     metal_path, [[err localizedDescription] UTF8String]);
        return nil;
    }
    return pso;
}

// Encode + dispatch + commit for one iteration of `kb`. `is_*` flags pick
// the binding pattern that matches the kernel's metal-side signature.
static void encode_dispatch(id<MTLCommandQueue> queue,
                            KernelBench & kb,
                            bool is_turbo3, bool is_turbo4, bool is_turbo3_tcq,
                            bool is_qjl, bool is_polar,
                            double & gpu_us_out, double & cpu_us_out) {
    @autoreleasepool {
        id<MTLCommandBuffer> cmd = [queue commandBuffer];
        id<MTLComputeCommandEncoder> enc = [cmd computeCommandEncoder];
        [enc setComputePipelineState:kb.pso];

        if (is_turbo3 || is_turbo4 || is_turbo3_tcq) {
            [enc setBuffer:kb.q_buf      offset:0 atIndex:0];
            [enc setBuffer:kb.k_buf      offset:0 atIndex:1];
            [enc setBuffer:kb.scores_buf offset:0 atIndex:2];
            if (is_turbo3_tcq) {
                [enc setBuffer:kb.cb_buf offset:0 atIndex:3];
                [enc setBytes:&kb.turbo_args length:sizeof(kb.turbo_args) atIndex:4];
            } else {
                [enc setBytes:&kb.turbo_args length:sizeof(kb.turbo_args) atIndex:3];
            }
        } else if (is_qjl) {
            [enc setBuffer:kb.q_buf      offset:0 atIndex:0];
            [enc setBuffer:kb.k_buf      offset:0 atIndex:1];
            [enc setBuffer:kb.scores_buf offset:0 atIndex:2];
            [enc setBytes:&kb.qjl_args length:sizeof(kb.qjl_args) atIndex:3];
        } else if (is_polar) {
            [enc setBuffer:kb.k_buf      offset:0 atIndex:0];
            [enc setBuffer:kb.q_buf      offset:0 atIndex:1];
            [enc setBuffer:kb.scores_buf offset:0 atIndex:2];
            [enc setBytes:&kb.polar_args length:sizeof(kb.polar_args) atIndex:3];
        }

        [enc dispatchThreadgroups:kb.grid threadsPerThreadgroup:kb.threadgroup];
        [enc endEncoding];

        struct timespec t0{}, t1{};
        clock_gettime(CLOCK_MONOTONIC, &t0);
        [cmd commit];
        [cmd waitUntilCompleted];
        clock_gettime(CLOCK_MONOTONIC, &t1);

        double cpu_us = (double)(t1.tv_sec - t0.tv_sec) * 1.0e6
                      + (double)(t1.tv_nsec - t0.tv_nsec) * 1.0e-3;
        double gpu_us = ([cmd GPUEndTime] - [cmd GPUStartTime]) * 1.0e6;
        cpu_us_out = cpu_us;
        gpu_us_out = gpu_us;
    }
}

} // namespace

// ---------------------------------------------------------------------------
// MODE: tgsweep — threadgroup-size sensitivity for QJL and Polar.
// ---------------------------------------------------------------------------
namespace {

static int run_mode_tgsweep(id<MTLDevice> device, id<MTLCommandQueue> queue,
                            int iters, int warmup, const char * out_path) {
    // Compile QJL + Polar pipelines once. Note: both kernels reduce via
    // simd_sum and assume one Apple SIMD-group (32 lanes) per threadgroup;
    // TG > 32 is expected to either fail dispatch or under-reduce. We try
    // anyway and record what happens.
    KernelBench qjl{}, polar{};
    qjl.name = "qjl";   qjl.source_path = "../metal/qjl.metal";
    qjl.kernel_func = "kernel_attn_score_qjl1_256";
    polar.name = "polar"; polar.source_path = "../metal/polar.metal";
    polar.kernel_func = "kernel_mul_mv_q4_polar_f32";

    qjl.pso   = compile_kernel(device, qjl.source_path.c_str(),   qjl.kernel_func.c_str());
    polar.pso = compile_kernel(device, polar.source_path.c_str(), polar.kernel_func.c_str());
    if (!qjl.pso || !polar.pso) return 1;

    // Allocate buffers (same shapes as the default mode).
    std::vector<float>   q_qjl   = randn_floats((size_t)kQjlHeads * kQjlProjDim, 0xB1);
    std::vector<uint8_t> k_qjl   = rand_bytes((size_t)kQjlKvHeads * kSeq * kQjlBlockBytes, 0xB2);
    std::vector<float>   q_polar = randn_floats((size_t)kHeadDim, 0xC1);
    std::vector<uint8_t> k_polar = rand_bytes((size_t)kPolarRows * kPolarBlockBytes, 0xC2);

    auto make_buf = [&](const void * d, size_t b) {
        return [device newBufferWithBytes:d length:b options:MTLResourceStorageModeShared];
    };
    auto zero_buf = [&](size_t b) {
        id<MTLBuffer> x = [device newBufferWithLength:b options:MTLResourceStorageModeShared];
        std::memset([x contents], 0, [x length]); return x;
    };

    qjl.q_buf      = make_buf(q_qjl.data(), q_qjl.size() * sizeof(float));
    qjl.k_buf      = make_buf(k_qjl.data(), k_qjl.size());
    qjl.scores_buf = zero_buf((size_t)kQjlHeads * kSeq * sizeof(float));
    qjl.qjl_args   = QjlScoreArgs{ (uint32_t)kQjlHeads, (uint32_t)kQjlKvHeads,
                                   (uint32_t)kSeq,      (uint32_t)kQjlProjDim };
    qjl.grid       = MTLSizeMake((NSUInteger)kQjlHeads, (NSUInteger)kSeq, 1);

    polar.q_buf      = make_buf(q_polar.data(), q_polar.size() * sizeof(float));
    polar.k_buf      = make_buf(k_polar.data(), k_polar.size());
    polar.scores_buf = zero_buf((size_t)kPolarRows * sizeof(float));
    polar.polar_args = PolarMvArgs{ (uint32_t)kPolarRows, (uint32_t)kHeadDim, 0u };
    polar.grid       = MTLSizeMake((NSUInteger)kPolarRows, 1, 1);

    // Try TG sizes 32, 64, 128, 256.
    const int tg_sizes[] = { 32, 64, 128, 256 };
    const int N_TG = sizeof(tg_sizes) / sizeof(tg_sizes[0]);

    struct TgResult {
        int tg;
        std::string status; // "ok", "exceeds_pso_max", "dispatch_failed"
        double gpu_med_us = 0.0;
        double gpu_p99_us = 0.0;
    };

    auto sweep_one = [&](KernelBench & kb, bool is_qjl_kernel) {
        std::vector<TgResult> results;
        for (int i = 0; i < N_TG; i++) {
            TgResult r{}; r.tg = tg_sizes[i];
            // Skip TG sizes that exceed the pipeline's max-threads cap.
            if ((NSUInteger)tg_sizes[i] > [kb.pso maxTotalThreadsPerThreadgroup]) {
                r.status = "exceeds_pso_max";
                results.push_back(r);
                continue;
            }
            kb.threadgroup = MTLSizeMake((NSUInteger)tg_sizes[i], 1, 1);
            kb.gpu_us.clear(); kb.cpu_us.clear();

            // Warmup
            for (int w = 0; w < warmup; w++) {
                double g, c;
                encode_dispatch(queue, kb,
                                false, false, false,
                                is_qjl_kernel, !is_qjl_kernel, g, c);
            }
            // Measure
            for (int it = 0; it < iters; it++) {
                double g, c;
                encode_dispatch(queue, kb,
                                false, false, false,
                                is_qjl_kernel, !is_qjl_kernel, g, c);
                kb.gpu_us.push_back(g);
                kb.cpu_us.push_back(c);
            }
            r.status = "ok";
            r.gpu_med_us = median(kb.gpu_us);
            r.gpu_p99_us = percentile(kb.gpu_us, 0.99);
            results.push_back(r);
        }
        return results;
    };

    auto qjl_res   = sweep_one(qjl,   true);
    auto polar_res = sweep_one(polar, false);

    std::printf("\n[tgsweep] iters=%d warmup=%d\n", iters, warmup);
    std::printf("%-8s | %4s | %-18s | %12s | %12s\n",
                "kernel", "tg", "status", "gpu_med_us", "gpu_p99_us");
    std::printf("---------+------+--------------------+--------------+--------------\n");
    for (auto & r : qjl_res)
        std::printf("%-8s | %4d | %-18s | %12.2f | %12.2f\n",
                    "qjl", r.tg, r.status.c_str(), r.gpu_med_us, r.gpu_p99_us);
    for (auto & r : polar_res)
        std::printf("%-8s | %4d | %-18s | %12.2f | %12.2f\n",
                    "polar", r.tg, r.status.c_str(), r.gpu_med_us, r.gpu_p99_us);

    FILE * fp = std::fopen(out_path, "w");
    if (!fp) { std::fprintf(stderr, "[tgsweep] cannot open %s\n", out_path); return 1; }
    std::fprintf(fp, "{\n");
    std::fprintf(fp, "  \"device\": \"%s\",\n", [[device name] UTF8String]);
    std::fprintf(fp, "  \"date\": \"2026-05-10\",\n");
    std::fprintf(fp, "  \"mode\": \"tgsweep\",\n");
    std::fprintf(fp, "  \"iterations\": %d,\n", iters);
    std::fprintf(fp, "  \"warmup\": %d,\n", warmup);
    std::fprintf(fp, "  \"note\": \"QJL and Polar both reduce via simd_sum and assume one Apple SIMD-group (32 lanes) per threadgroup. Sizes that succeed at dispatch but exceed 32 lanes will silently under-reduce — this sweep records dispatch success/failure and timing only.\",\n");
    std::fprintf(fp, "  \"sweeps\": [\n");
    auto dump = [&](const char * name, const std::vector<TgResult> & rs) {
        std::fprintf(fp, "    { \"kernel\": \"%s\", \"results\": [\n", name);
        for (size_t i = 0; i < rs.size(); i++) {
            std::fprintf(fp, "      { \"tg\": %d, \"status\": \"%s\", \"gpu_med_us\": %.4f, \"gpu_p99_us\": %.4f }%s\n",
                         rs[i].tg, rs[i].status.c_str(), rs[i].gpu_med_us, rs[i].gpu_p99_us,
                         i + 1 == rs.size() ? "" : ",");
        }
        std::fprintf(fp, "    ] }");
    };
    dump("qjl", qjl_res);   std::fprintf(fp, ",\n");
    dump("polar", polar_res); std::fprintf(fp, "\n");
    std::fprintf(fp, "  ]\n");
    std::fprintf(fp, "}\n");
    std::fclose(fp);
    std::printf("\n[tgsweep] wrote %s\n", out_path);
    return 0;
}

// ---------------------------------------------------------------------------
// MODE: fp16ref — reference fp16 dot-product baseline. Same N output blocks
// as the production turbo* dispatch (kTurboNkv = 131072), but K is stored as
// fp16 (256 B/token) and dotted with simd_sum. This is the "what we'd be
// shipping if we did NOT quantize" baseline — used to compute the speedup
// the quantized kernels actually deliver.
// ---------------------------------------------------------------------------
static const char * kFp16RefSource = R"(
#include <metal_stdlib>
using namespace metal;

// One threadgroup per output block. Threadgroup size = 32 = one Apple
// SIMD-group. Each lane reads 4 fp16 K values + 4 fp32 Q values, partial-
// summed locally, then reduced across the SIMD-group via simd_sum.
//
// Bytes per dispatch:
//   q  : 128 * sizeof(float) = 512    (small; reused via L1)
//   k  : N    * 128 * sizeof(half) = N * 256
//   y  : N    * sizeof(float)
struct Fp16RefArgs {
    uint head_dim;   // 128
    uint n_blocks;   // kTurboNkv
};

kernel void fp16_dot_baseline(
    device const float * q       [[buffer(0)]],
    device const half  * k       [[buffer(1)]],
    device       float * scores  [[buffer(2)]],
    constant Fp16RefArgs & args  [[buffer(3)]],
    uint  tid                    [[thread_position_in_threadgroup]],
    uint  block_idx              [[threadgroup_position_in_grid]]) {
    if (block_idx >= args.n_blocks) return;
    const uint H = args.head_dim;
    const uint stride = H;
    device const half * kblock = k + (uint64_t)block_idx * stride;
    float acc = 0.0f;
    // 32 threads × 4 elements each = 128 head_dim coverage.
    for (uint i = tid; i < H; i += 32) {
        acc += (float)kblock[i] * q[i];
    }
    float sum = simd_sum(acc);
    if (tid == 0) scores[block_idx] = sum;
}
)";

static int run_mode_fp16ref(id<MTLDevice> device, id<MTLCommandQueue> queue,
                            int iters, int warmup, int runs, const char * out_path) {
    NSError * err = nil;
    NSString * src = [NSString stringWithUTF8String:kFp16RefSource];
    id<MTLLibrary> lib = [device newLibraryWithSource:src options:nil error:&err];
    if (!lib) {
        std::fprintf(stderr, "[fp16ref] compile failed: %s\n",
                     [[err localizedDescription] UTF8String]);
        return 1;
    }
    id<MTLFunction> fn = [lib newFunctionWithName:@"fp16_dot_baseline"];
    id<MTLComputePipelineState> pso = [device newComputePipelineStateWithFunction:fn error:&err];
    if (!pso) {
        std::fprintf(stderr, "[fp16ref] pipeline failed: %s\n",
                     [[err localizedDescription] UTF8String]);
        return 1;
    }

    // Allocate inputs at the same scale as turbo*.
    std::vector<float> q_fp32 = randn_floats(kHeadDim, 0xD1);
    // K is fp16 — generate as fp32 floats and convert via __fp16 cast.
    std::vector<float> k_fp32_src = randn_floats((size_t)kTurboNkv * kHeadDim, 0xD2);
    std::vector<uint16_t> k_fp16(k_fp32_src.size());
    for (size_t i = 0; i < k_fp32_src.size(); i++) {
        __fp16 h = (__fp16)k_fp32_src[i];
        std::memcpy(&k_fp16[i], &h, sizeof(uint16_t));
    }

    id<MTLBuffer> qbuf = [device newBufferWithBytes:q_fp32.data()
                                             length:q_fp32.size() * sizeof(float)
                                            options:MTLResourceStorageModeShared];
    id<MTLBuffer> kbuf = [device newBufferWithBytes:k_fp16.data()
                                             length:k_fp16.size() * sizeof(uint16_t)
                                            options:MTLResourceStorageModeShared];
    id<MTLBuffer> ybuf = [device newBufferWithLength:(size_t)kTurboNkv * sizeof(float)
                                             options:MTLResourceStorageModeShared];
    std::memset([ybuf contents], 0, [ybuf length]);

    struct Fp16RefArgs { uint32_t head_dim; uint32_t n_blocks; };
    Fp16RefArgs args{ (uint32_t)kHeadDim, (uint32_t)kTurboNkv };

    MTLSize tg   = MTLSizeMake(32, 1, 1);
    MTLSize grid = MTLSizeMake((NSUInteger)kTurboNkv, 1, 1);

    auto one_dispatch = [&](double & gpu_us, double & cpu_us) {
        @autoreleasepool {
            id<MTLCommandBuffer> cmd = [queue commandBuffer];
            id<MTLComputeCommandEncoder> enc = [cmd computeCommandEncoder];
            [enc setComputePipelineState:pso];
            [enc setBuffer:qbuf offset:0 atIndex:0];
            [enc setBuffer:kbuf offset:0 atIndex:1];
            [enc setBuffer:ybuf offset:0 atIndex:2];
            [enc setBytes:&args length:sizeof(args) atIndex:3];
            [enc dispatchThreadgroups:grid threadsPerThreadgroup:tg];
            [enc endEncoding];
            struct timespec t0{}, t1{};
            clock_gettime(CLOCK_MONOTONIC, &t0);
            [cmd commit];
            [cmd waitUntilCompleted];
            clock_gettime(CLOCK_MONOTONIC, &t1);
            cpu_us = (double)(t1.tv_sec - t0.tv_sec) * 1.0e6
                   + (double)(t1.tv_nsec - t0.tv_nsec) * 1.0e-3;
            gpu_us = ([cmd GPUEndTime] - [cmd GPUStartTime]) * 1.0e6;
        }
    };

    // Warmup
    for (int w = 0; w < warmup; w++) { double g, c; one_dispatch(g, c); }

    // `runs` blocks of `iters` measurements each; report median-of-medians
    // and run-to-run variance of the medians (so thermal drift shows up).
    std::vector<double> per_run_med_gpu, per_run_med_cpu;
    std::vector<double> all_gpu;
    for (int r = 0; r < runs; r++) {
        std::vector<double> g, c;
        for (int it = 0; it < iters; it++) {
            double gu, cu; one_dispatch(gu, cu);
            g.push_back(gu); c.push_back(cu);
            all_gpu.push_back(gu);
        }
        per_run_med_gpu.push_back(median(g));
        per_run_med_cpu.push_back(median(c));
    }
    double med_med = median(per_run_med_gpu);
    double mn_med = *std::min_element(per_run_med_gpu.begin(), per_run_med_gpu.end());
    double mx_med = *std::max_element(per_run_med_gpu.begin(), per_run_med_gpu.end());
    double variance_pct = (mn_med > 0.0) ? 100.0 * (mx_med - mn_med) / mn_med : 0.0;

    uint64_t bytes_per_dispatch = (uint64_t)kHeadDim * sizeof(float)
                                + (uint64_t)kTurboNkv * kHeadDim * sizeof(uint16_t)
                                + (uint64_t)kTurboNkv * sizeof(float);
    double bw_GBs = ((double)bytes_per_dispatch / (med_med * 1.0e-6)) / 1.0e9;
    double bw_pct = 100.0 * bw_GBs / (double)kPeakBwGBs;
    double cpu_med = median(per_run_med_cpu);
    double gpu_p99 = percentile(all_gpu, 0.99);

    std::printf("\n[fp16ref] iters=%d warmup=%d runs=%d\n", iters, warmup, runs);
    std::printf("  bytes_per_dispatch=%llu (K=fp16 256B/token × %d tokens)\n",
                (unsigned long long)bytes_per_dispatch, kTurboNkv);
    std::printf("  gpu_med_us=%.2f  gpu_p99_us=%.2f  cpu_med_us=%.2f\n",
                med_med, gpu_p99, cpu_med);
    std::printf("  bandwidth=%.2f GB/s (%.1f%% of %.0f GB/s peak)\n",
                bw_GBs, bw_pct, (double)kPeakBwGBs);
    std::printf("  per-run medians: min=%.2f max=%.2f variance=%.1f%%\n",
                mn_med, mx_med, variance_pct);

    FILE * fp = std::fopen(out_path, "w");
    if (!fp) { std::fprintf(stderr, "[fp16ref] cannot open %s\n", out_path); return 1; }
    std::fprintf(fp, "{\n");
    std::fprintf(fp, "  \"device\": \"%s\",\n", [[device name] UTF8String]);
    std::fprintf(fp, "  \"date\": \"2026-05-10\",\n");
    std::fprintf(fp, "  \"mode\": \"fp16ref\",\n");
    std::fprintf(fp, "  \"description\": \"fp16 K-cache dot-product baseline; same N=%d output blocks as turbo*; this is the unquantized throughput we would otherwise be shipping.\",\n",
                 kTurboNkv);
    std::fprintf(fp, "  \"iterations\": %d, \"warmup\": %d, \"runs\": %d,\n",
                 iters, warmup, runs);
    std::fprintf(fp, "  \"bytes_per_dispatch\": %llu,\n",
                 (unsigned long long)bytes_per_dispatch);
    std::fprintf(fp, "  \"gpu_us\": { \"median_of_medians\": %.4f, \"p99\": %.4f, \"per_run_min\": %.4f, \"per_run_max\": %.4f, \"per_run_variance_pct\": %.4f },\n",
                 med_med, gpu_p99, mn_med, mx_med, variance_pct);
    std::fprintf(fp, "  \"cpu_us\": { \"median\": %.4f },\n", cpu_med);
    std::fprintf(fp, "  \"bandwidth_GBs\": %.4f,\n", bw_GBs);
    std::fprintf(fp, "  \"bandwidth_pct_of_peak\": %.4f\n", bw_pct);
    std::fprintf(fp, "}\n");
    std::fclose(fp);
    std::printf("\n[fp16ref] wrote %s\n", out_path);
    return 0;
}

// ---------------------------------------------------------------------------
// MODE: batched — command-buffer batching sweep.
//
// Wave-5 finding: 4 of 5 Metal kernels cluster at ~240 µs median GPU time on
// M4 Max regardless of buffer-size differences. They are hitting the
// command-buffer-launch / threadgroup-schedule floor, not memory bandwidth.
// To break the floor we batch N command-encoder dispatches into a single
// MTLCommandBuffer, commit once, and waitUntilCompleted once. The GPU sees
// one continuous stream of work and the per-dispatch overhead amortises.
//
// What this mode measures, for each kernel × N ∈ {1, 4, 16, 64, 128, 256}:
//   - total_us       : wall time of one batched commit→wait round
//   - per_disp_us    : total_us / N (amortised per-dispatch cost)
//   - throughput     : N / total_us — dispatches/sec for the kernel
//   - bargein_us     : per-batch barge-in cancellation latency. The GPU can
//                      only cancel a command buffer at a buffer boundary, so
//                      a batch of N dispatches cannot be interrupted mid-
//                      buffer. Worst-case cancellation latency = total_us
//                      (we just submitted the buffer; we wait for it to
//                      finish). Expected average = total_us / 2.
//
// We keep N=1 in the grid so the batched-mode result is directly comparable
// to single-dispatch baseline numbers from default mode.
// ---------------------------------------------------------------------------

struct BatchedResult {
    int N;
    double total_us_med;     // median per batched commit
    double total_us_p99;
    double per_disp_us;      // total_us_med / N
    double throughput_disps_per_s;
    double bargein_worst_us; // == total_us_med
    double bargein_avg_us;   // == total_us_med / 2
};

// One batched commit: encode N dispatches into the same encoder, end-encoding,
// commit, waitUntilCompleted. Bindings are per-dispatch identical (same
// buffers, same args), but each dispatch IS a separate dispatchThreadgroups
// call so the GPU schedules N threadgroup grids back-to-back.
//
// Timing: we measure CPU-side wall (commit→wait) and GPU-side
// (GPUEndTime − GPUStartTime). For batched mode the relevant figure is
// GPU-side total: that's the time the GPU was actually busy executing the
// batched workload, with no command-buffer launch tax between dispatches.
static void encode_batched_commit(
    id<MTLCommandQueue> queue,
    KernelBench & kb,
    int N,
    bool is_turbo3, bool is_turbo4, bool is_turbo3_tcq,
    bool is_qjl, bool is_polar,
    double & gpu_us_total, double & cpu_us_total)
{
    @autoreleasepool {
        id<MTLCommandBuffer> cmd = [queue commandBuffer];
        id<MTLComputeCommandEncoder> enc = [cmd computeCommandEncoder];
        [enc setComputePipelineState:kb.pso];

        // Bind once — same buffers used for all N dispatches in this buffer.
        if (is_turbo3 || is_turbo4 || is_turbo3_tcq) {
            [enc setBuffer:kb.q_buf      offset:0 atIndex:0];
            [enc setBuffer:kb.k_buf      offset:0 atIndex:1];
            [enc setBuffer:kb.scores_buf offset:0 atIndex:2];
            if (is_turbo3_tcq) {
                [enc setBuffer:kb.cb_buf offset:0 atIndex:3];
                [enc setBytes:&kb.turbo_args length:sizeof(kb.turbo_args) atIndex:4];
            } else {
                [enc setBytes:&kb.turbo_args length:sizeof(kb.turbo_args) atIndex:3];
            }
        } else if (is_qjl) {
            [enc setBuffer:kb.q_buf      offset:0 atIndex:0];
            [enc setBuffer:kb.k_buf      offset:0 atIndex:1];
            [enc setBuffer:kb.scores_buf offset:0 atIndex:2];
            [enc setBytes:&kb.qjl_args length:sizeof(kb.qjl_args) atIndex:3];
        } else if (is_polar) {
            [enc setBuffer:kb.k_buf      offset:0 atIndex:0];
            [enc setBuffer:kb.q_buf      offset:0 atIndex:1];
            [enc setBuffer:kb.scores_buf offset:0 atIndex:2];
            [enc setBytes:&kb.polar_args length:sizeof(kb.polar_args) atIndex:3];
        }

        // N back-to-back dispatchThreadgroups into the same encoder. No
        // memoryBarrierWithScope between dispatches because the bench
        // workload writes to scores_buf only — read-after-write hazards
        // exist in production but not in this perf harness; each dispatch
        // here just remeasures the kernel cost. Adding barriers would inject
        // synthetic stalls and obscure the launch-floor measurement.
        for (int j = 0; j < N; j++) {
            [enc dispatchThreadgroups:kb.grid threadsPerThreadgroup:kb.threadgroup];
        }
        [enc endEncoding];

        struct timespec t0{}, t1{};
        clock_gettime(CLOCK_MONOTONIC, &t0);
        [cmd commit];
        [cmd waitUntilCompleted];
        clock_gettime(CLOCK_MONOTONIC, &t1);

        cpu_us_total = (double)(t1.tv_sec - t0.tv_sec) * 1.0e6
                     + (double)(t1.tv_nsec - t0.tv_nsec) * 1.0e-3;
        gpu_us_total = ([cmd GPUEndTime] - [cmd GPUStartTime]) * 1.0e6;
    }
}

static int run_mode_batched(id<MTLDevice> device, id<MTLCommandQueue> queue,
                            int iters_per_N, int warmup, const char * out_path) {
    // Build the same five-kernel set as default mode. Reuses the buffer
    // setup verbatim — we do NOT replace the single-dispatch baseline path,
    // we just add a batched commit on top of the same buffers.
    std::vector<KernelBench> kernels(5);
    kernels[0].name = "turbo3";
    kernels[0].source_path = "../metal/turbo3.metal";
    kernels[0].kernel_func = "kernel_turbo3_dot";
    kernels[1].name = "turbo4";
    kernels[1].source_path = "../metal/turbo4.metal";
    kernels[1].kernel_func = "kernel_turbo4_dot";
    kernels[2].name = "turbo3_tcq";
    kernels[2].source_path = "../metal/turbo3_tcq.metal";
    kernels[2].kernel_func = "kernel_turbo3_tcq_dot";
    kernels[3].name = "qjl";
    kernels[3].source_path = "../metal/qjl.metal";
    kernels[3].kernel_func = "kernel_attn_score_qjl1_256";
    kernels[4].name = "polar";
    kernels[4].source_path = "../metal/polar.metal";
    kernels[4].kernel_func = "kernel_mul_mv_q4_polar_f32";

    for (auto & kb : kernels) {
        kb.pso = compile_kernel(device, kb.source_path.c_str(), kb.kernel_func.c_str());
        if (!kb.pso) {
            std::fprintf(stderr, "[batched] aborting: %s pipeline failed\n", kb.name.c_str());
            return 1;
        }
    }

    // Buffers — duplicated from default mode setup so this mode is self-
    // contained and can be invoked without --mode default first.
    std::vector<float>   q_turbo   = randn_floats(kHeadDim, 0xA1);
    std::vector<uint8_t> k_turbo3  = rand_bytes((size_t)kTurboNkv * kTurbo3BlockBytes    * kTurbo3BlocksPerKv,    0xA2);
    std::vector<uint8_t> k_turbo4  = rand_bytes((size_t)kTurboNkv * kTurbo4BlockBytes    * kTurbo4BlocksPerKv,    0xA3);
    std::vector<uint8_t> k_turbo3t = rand_bytes((size_t)kTurboNkv * kTurbo3TcqBlockBytes * kTurbo3TcqBlocksPerKv, 0xA4);
    std::vector<float>   tcq_cb    = make_tcq_codebook();
    std::vector<float>   q_qjl     = randn_floats((size_t)kQjlHeads * kQjlProjDim, 0xB1);
    std::vector<uint8_t> k_qjl     = rand_bytes((size_t)kQjlKvHeads * kSeq * kQjlBlockBytes, 0xB2);
    std::vector<float>   q_polar   = randn_floats((size_t)kHeadDim, 0xC1);
    std::vector<uint8_t> k_polar   = rand_bytes((size_t)kPolarRows * kPolarBlockBytes, 0xC2);

    auto make_buf = [&](const void * data, size_t bytes) {
        return [device newBufferWithBytes:data length:bytes options:MTLResourceStorageModeShared];
    };
    auto zero_buf = [&](size_t bytes) {
        id<MTLBuffer> b = [device newBufferWithLength:bytes options:MTLResourceStorageModeShared];
        std::memset([b contents], 0, [b length]);
        return b;
    };

    {
        auto & kb = kernels[0];
        kb.q_buf = make_buf(q_turbo.data(), q_turbo.size() * sizeof(float));
        kb.k_buf = make_buf(k_turbo3.data(), k_turbo3.size());
        kb.scores_buf = zero_buf((size_t)kTurboNkv * sizeof(float));
        kb.turbo_args = TurboArgs{ kHeadDim, (uint32_t)kTurboNkv, kTurbo3BlocksPerKv, 0u, 0u };
        kb.threadgroup = MTLSizeMake(32, 1, 1);
        kb.grid = MTLSizeMake((NSUInteger)kTurboNkv, 1, 1);
        kb.n_outputs = kTurboNkv;
    }
    {
        auto & kb = kernels[1];
        kb.q_buf = make_buf(q_turbo.data(), q_turbo.size() * sizeof(float));
        kb.k_buf = make_buf(k_turbo4.data(), k_turbo4.size());
        kb.scores_buf = zero_buf((size_t)kTurboNkv * sizeof(float));
        kb.turbo_args = TurboArgs{ kHeadDim, (uint32_t)kTurboNkv, kTurbo4BlocksPerKv, 0u, 0u };
        kb.threadgroup = MTLSizeMake(32, 1, 1);
        kb.grid = MTLSizeMake((NSUInteger)kTurboNkv, 1, 1);
        kb.n_outputs = kTurboNkv;
    }
    {
        auto & kb = kernels[2];
        kb.q_buf = make_buf(q_turbo.data(), q_turbo.size() * sizeof(float));
        kb.k_buf = make_buf(k_turbo3t.data(), k_turbo3t.size());
        kb.scores_buf = zero_buf((size_t)kTurboNkv * sizeof(float));
        kb.cb_buf = make_buf(tcq_cb.data(), tcq_cb.size() * sizeof(float));
        kb.turbo_args = TurboArgs{ kHeadDim, (uint32_t)kTurboNkv, kTurbo3TcqBlocksPerKv, 0u, 0u };
        kb.threadgroup = MTLSizeMake(32, 1, 1);
        kb.grid = MTLSizeMake((NSUInteger)kTurboNkv, 1, 1);
        kb.n_outputs = kTurboNkv;
    }
    {
        auto & kb = kernels[3];
        kb.q_buf = make_buf(q_qjl.data(), q_qjl.size() * sizeof(float));
        kb.k_buf = make_buf(k_qjl.data(), k_qjl.size());
        kb.scores_buf = zero_buf((size_t)kQjlHeads * kSeq * sizeof(float));
        kb.qjl_args = QjlScoreArgs{ (uint32_t)kQjlHeads, (uint32_t)kQjlKvHeads,
                                    (uint32_t)kSeq, (uint32_t)kQjlProjDim };
        kb.threadgroup = MTLSizeMake(32, 1, 1);
        kb.grid = MTLSizeMake((NSUInteger)kQjlHeads, (NSUInteger)kSeq, 1);
        kb.n_outputs = kQjlHeads * kSeq;
    }
    {
        auto & kb = kernels[4];
        kb.q_buf = make_buf(q_polar.data(), q_polar.size() * sizeof(float));
        kb.k_buf = make_buf(k_polar.data(), k_polar.size());
        kb.scores_buf = zero_buf((size_t)kPolarRows * sizeof(float));
        kb.polar_args = PolarMvArgs{ (uint32_t)kPolarRows, kHeadDim, 0u };
        kb.threadgroup = MTLSizeMake(32, 1, 1);
        kb.grid = MTLSizeMake((NSUInteger)kPolarRows, 1, 1);
        kb.n_outputs = kPolarRows;
    }

    const int batch_grid[] = { 1, 4, 16, 64, 128, 256 };
    const int N_BATCH = sizeof(batch_grid) / sizeof(batch_grid[0]);

    // 5 kernels × 6 batch sizes × (warmup + iters_per_N) commits.
    // For the largest batch (N=256) at ~250µs per dispatch we expect ~64 ms
    // per commit; with iters_per_N=20 that's ~1.3 s × 5 kernels = ~6.5 s,
    // plus warmup (~3 s). Comfortably inside the 15-min budget.
    std::printf("[batched] iters_per_N=%d warmup=%d batch_grid={1,4,16,64,128,256}\n",
                iters_per_N, warmup);

    struct KernelBatchedResults {
        std::string name;
        std::vector<BatchedResult> per_N;
    };
    std::vector<KernelBatchedResults> kbr(kernels.size());

    struct timespec t_start{}; clock_gettime(CLOCK_MONOTONIC, &t_start);

    for (size_t i = 0; i < kernels.size(); i++) {
        kbr[i].name = kernels[i].name;
        bool is_t3  = (i == 0), is_t4 = (i == 1), is_tcq = (i == 2);
        bool is_qjl_k = (i == 3), is_pol = (i == 4);

        for (int b = 0; b < N_BATCH; b++) {
            int N = batch_grid[b];
            // Warmup: a few batched commits at this N to prime caches and
            // the command queue. Larger N → fewer warmup iterations needed.
            int wm = (N >= 64) ? std::max(2, warmup / 8) : warmup;
            for (int w = 0; w < wm; w++) {
                double g, c;
                encode_batched_commit(queue, kernels[i], N,
                                      is_t3, is_t4, is_tcq, is_qjl_k, is_pol,
                                      g, c);
            }
            // Measure
            int it_n = (N >= 128) ? std::max(8, iters_per_N / 4) : iters_per_N;
            std::vector<double> gpu_totals; gpu_totals.reserve(it_n);
            for (int it = 0; it < it_n; it++) {
                double g, c;
                encode_batched_commit(queue, kernels[i], N,
                                      is_t3, is_t4, is_tcq, is_qjl_k, is_pol,
                                      g, c);
                gpu_totals.push_back(g);
            }
            BatchedResult r{};
            r.N = N;
            r.total_us_med = median(gpu_totals);
            r.total_us_p99 = percentile(gpu_totals, 0.99);
            r.per_disp_us = (N > 0) ? r.total_us_med / (double)N : 0.0;
            r.throughput_disps_per_s = (r.total_us_med > 0.0)
                ? ((double)N / (r.total_us_med * 1.0e-6)) : 0.0;
            r.bargein_worst_us = r.total_us_med;
            r.bargein_avg_us = r.total_us_med * 0.5;
            kbr[i].per_N.push_back(r);
        }
    }

    struct timespec t_end{}; clock_gettime(CLOCK_MONOTONIC, &t_end);
    double total_s = (double)(t_end.tv_sec - t_start.tv_sec)
                   + (double)(t_end.tv_nsec - t_start.tv_nsec) * 1.0e-9;
    std::printf("[batched] total measurement wall: %.2fs\n", total_s);

    std::printf("\n%-12s | %4s | %12s | %12s | %14s | %14s | %14s\n",
                "kernel", "N", "total_us_med", "per_disp_us",
                "thru_disp/s", "bargein_avg", "bargein_worst");
    std::printf("-------------+------+--------------+--------------+----------------+----------------+----------------\n");
    for (auto & k : kbr) {
        for (auto & r : k.per_N) {
            std::printf("%-12s | %4d | %12.2f | %12.2f | %14.0f | %14.2f | %14.2f\n",
                        k.name.c_str(), r.N, r.total_us_med, r.per_disp_us,
                        r.throughput_disps_per_s, r.bargein_avg_us, r.bargein_worst_us);
        }
    }

    FILE * fp = std::fopen(out_path, "w");
    if (!fp) { std::fprintf(stderr, "[batched] cannot open %s\n", out_path); return 1; }
    std::fprintf(fp, "{\n");
    std::fprintf(fp, "  \"device\": \"%s\",\n", [[device name] UTF8String]);
    std::fprintf(fp, "  \"date\": \"2026-05-10\",\n");
    std::fprintf(fp, "  \"mode\": \"batched\",\n");
    std::fprintf(fp, "  \"description\": \"command-buffer batching sweep — N dispatches per MTLCommandBuffer to amortize launch overhead. N=1 is the single-dispatch baseline; larger N reduces per-dispatch GPU cost until launch floor disappears.\",\n");
    std::fprintf(fp, "  \"iters_per_N\": %d,\n", iters_per_N);
    std::fprintf(fp, "  \"warmup\": %d,\n", warmup);
    std::fprintf(fp, "  \"batch_grid\": [1, 4, 16, 64, 128, 256],\n");
    std::fprintf(fp, "  \"bargein_note\": \"At batch=N, command-buffer cancellation latency ≈ total_us_med (worst case: just submitted) or total_us_med/2 (average). The GPU cannot preempt mid-buffer — it can only stop accepting new buffers. Voice scaffold barge-in <=1 kernel-tick contract holds at N=1 (~250µs ≈ one tick); breaks at N≥4 (~1ms per buffer).\",\n");
    std::fprintf(fp, "  \"kernels\": [\n");
    for (size_t i = 0; i < kbr.size(); i++) {
        std::fprintf(fp, "    {\n");
        std::fprintf(fp, "      \"name\": \"%s\",\n", kbr[i].name.c_str());
        std::fprintf(fp, "      \"per_N\": [\n");
        for (size_t j = 0; j < kbr[i].per_N.size(); j++) {
            auto & r = kbr[i].per_N[j];
            std::fprintf(fp,
                "        { \"N\": %d, \"total_us_med\": %.4f, \"total_us_p99\": %.4f, "
                "\"per_disp_us\": %.4f, \"throughput_disps_per_s\": %.2f, "
                "\"bargein_worst_us\": %.4f, \"bargein_avg_us\": %.4f }%s\n",
                r.N, r.total_us_med, r.total_us_p99,
                r.per_disp_us, r.throughput_disps_per_s,
                r.bargein_worst_us, r.bargein_avg_us,
                j + 1 == kbr[i].per_N.size() ? "" : ",");
        }
        std::fprintf(fp, "      ]\n");
        std::fprintf(fp, "    }%s\n", i + 1 == kbr.size() ? "" : ",");
    }
    std::fprintf(fp, "  ]\n");
    std::fprintf(fp, "}\n");
    std::fclose(fp);
    std::printf("\n[batched] wrote %s\n", out_path);
    return 0;
}

// ---------------------------------------------------------------------------
// MODE: multiblock — multi-block-per-dispatch sweep (Wave-5 SHADER_REVIEW M3).
//
// The four small kernels (turbo3, turbo4, turbo3_tcq, qjl) all converge to
// ~290 µs median GPU time at the 9b workload because each launches
// 131072 tiny threadgroups — they're launch-tax bound. The multi-block
// kernel variants (kernel_*_dot_multi, kernel_attn_score_qjl1_256_multi) keep
// 32 threads per threadgroup but loop over N consecutive KV blocks per
// threadgroup before exiting. This cuts the launch grid by N× while
// preserving per-block math.
//
// For each of the 4 small kernels × N ∈ {1, 2, 4, 8, 16, 32} we record:
//   - GPU median µs / dispatch (entire kernel completion, all N×grid blocks)
//   - GPU p99 µs
//   - speedup vs N=1 baseline
//   - which N is the per-kernel sweet spot
//
// N=1 here uses the same multi-block kernel with blocks_per_threadgroup=1,
// so the comparison is apples-to-apples against the multi shape. We also
// report the actual single-block kernel's median (separately) for absolute
// reference.
// ---------------------------------------------------------------------------

struct MultiResult {
    int N;
    double gpu_med_us;
    double gpu_p99_us;
    double cpu_med_us;
};

struct MultiKernelBench {
    std::string name;
    std::string source_path;
    std::string kernel_single;   // existing single-block entry (baseline)
    std::string kernel_multi;    // new multi-block entry
    bool is_qjl;                 // false → turbo* (1D grid), true → QJL (2D grid)
    bool is_tcq;                 // turbo3_tcq has codebook at buffer(3); args at buffer(4)
};

static int run_mode_multiblock(id<MTLDevice> device, id<MTLCommandQueue> queue,
                               int iters, int warmup, const char * out_path) {
    std::vector<MultiKernelBench> mkbs = {
        { "turbo3",     "../metal/turbo3.metal",     "kernel_turbo3_dot",          "kernel_turbo3_dot_multi",          false, false },
        { "turbo4",     "../metal/turbo4.metal",     "kernel_turbo4_dot",          "kernel_turbo4_dot_multi",          false, false },
        { "turbo3_tcq", "../metal/turbo3_tcq.metal", "kernel_turbo3_tcq_dot",      "kernel_turbo3_tcq_dot_multi",      false, true  },
        { "qjl",        "../metal/qjl.metal",        "kernel_attn_score_qjl1_256", "kernel_attn_score_qjl1_256_multi", true,  false },
    };

    // Buffers (same shapes as default mode; reused across all N).
    std::vector<float>   q_turbo   = randn_floats(kHeadDim, 0xA1);
    std::vector<uint8_t> k_turbo3  = rand_bytes((size_t)kTurboNkv * kTurbo3BlockBytes    * kTurbo3BlocksPerKv,    0xA2);
    std::vector<uint8_t> k_turbo4  = rand_bytes((size_t)kTurboNkv * kTurbo4BlockBytes    * kTurbo4BlocksPerKv,    0xA3);
    std::vector<uint8_t> k_turbo3t = rand_bytes((size_t)kTurboNkv * kTurbo3TcqBlockBytes * kTurbo3TcqBlocksPerKv, 0xA4);
    std::vector<float>   tcq_cb    = make_tcq_codebook();
    std::vector<float>   q_qjl     = randn_floats((size_t)kQjlHeads * kQjlProjDim, 0xB1);
    std::vector<uint8_t> k_qjl     = rand_bytes((size_t)kQjlKvHeads * kSeq * kQjlBlockBytes, 0xB2);

    auto make_buf = [&](const void * data, size_t bytes) {
        return [device newBufferWithBytes:data length:bytes options:MTLResourceStorageModeShared];
    };
    auto zero_buf = [&](size_t bytes) {
        id<MTLBuffer> b = [device newBufferWithLength:bytes options:MTLResourceStorageModeShared];
        std::memset([b contents], 0, [b length]);
        return b;
    };

    id<MTLBuffer> qbuf_turbo   = make_buf(q_turbo.data(),  q_turbo.size()  * sizeof(float));
    id<MTLBuffer> kbuf_turbo3  = make_buf(k_turbo3.data(), k_turbo3.size());
    id<MTLBuffer> kbuf_turbo4  = make_buf(k_turbo4.data(), k_turbo4.size());
    id<MTLBuffer> kbuf_turbo3t = make_buf(k_turbo3t.data(), k_turbo3t.size());
    id<MTLBuffer> cbbuf_tcq    = make_buf(tcq_cb.data(),    tcq_cb.size()    * sizeof(float));
    id<MTLBuffer> qbuf_qjl     = make_buf(q_qjl.data(),    q_qjl.size()    * sizeof(float));
    id<MTLBuffer> kbuf_qjl     = make_buf(k_qjl.data(),    k_qjl.size());

    id<MTLBuffer> scores_turbo = zero_buf((size_t)kTurboNkv * sizeof(float));
    id<MTLBuffer> scores_qjl   = zero_buf((size_t)kQjlHeads * kSeq * sizeof(float));

    const int N_grid[] = { 1, 2, 4, 8, 16, 32 };
    const int N_GRID = sizeof(N_grid) / sizeof(N_grid[0]);

    std::printf("[multiblock] iters=%d warmup=%d N_grid={1,2,4,8,16,32}\n", iters, warmup);

    struct PerKernelOut {
        std::string name;
        double single_block_med_us = 0.0;   // existing kernel_*_dot @ N=1 grid
        double single_block_p99_us = 0.0;
        std::vector<MultiResult> per_N;
        int    optimal_N = 1;
        double best_us   = 0.0;
        double speedup_vs_single = 1.0;
    };
    std::vector<PerKernelOut> outs(mkbs.size());

    struct timespec t_start{}; clock_gettime(CLOCK_MONOTONIC, &t_start);

    for (size_t ki = 0; ki < mkbs.size(); ki++) {
        auto & mk = mkbs[ki];
        outs[ki].name = mk.name;

        // Compile single + multi pipelines.
        id<MTLComputePipelineState> pso_single =
            compile_kernel(device, mk.source_path.c_str(), mk.kernel_single.c_str());
        id<MTLComputePipelineState> pso_multi  =
            compile_kernel(device, mk.source_path.c_str(), mk.kernel_multi.c_str());
        if (!pso_single || !pso_multi) {
            std::fprintf(stderr, "[multiblock] %s: compile failed\n", mk.name.c_str());
            return 1;
        }

        // Pick buffers.
        id<MTLBuffer> qbuf = mk.is_qjl ? qbuf_qjl : qbuf_turbo;
        id<MTLBuffer> kbuf = mk.is_qjl ? kbuf_qjl
                          : (mk.name == "turbo3"     ? kbuf_turbo3
                          : (mk.name == "turbo4"     ? kbuf_turbo4
                          : /*turbo3_tcq*/             kbuf_turbo3t));
        id<MTLBuffer> sbuf = mk.is_qjl ? scores_qjl : scores_turbo;

        // Args setup.
        uint32_t kv_stride = (mk.name == "turbo3") ? kTurbo3BlocksPerKv
                          : (mk.name == "turbo4") ? kTurbo4BlocksPerKv
                          : kTurbo3TcqBlocksPerKv;

        auto encode_single = [&](double & gpu_us, double & cpu_us) {
            @autoreleasepool {
                id<MTLCommandBuffer> cmd = [queue commandBuffer];
                id<MTLComputeCommandEncoder> enc = [cmd computeCommandEncoder];
                [enc setComputePipelineState:pso_single];
                if (mk.is_qjl) {
                    QjlScoreArgs a{ (uint32_t)kQjlHeads, (uint32_t)kQjlKvHeads,
                                    (uint32_t)kSeq, (uint32_t)kQjlProjDim };
                    [enc setBuffer:qbuf offset:0 atIndex:0];
                    [enc setBuffer:kbuf offset:0 atIndex:1];
                    [enc setBuffer:sbuf offset:0 atIndex:2];
                    [enc setBytes:&a length:sizeof(a) atIndex:3];
                    MTLSize tg   = MTLSizeMake(32, 1, 1);
                    MTLSize grid = MTLSizeMake((NSUInteger)kQjlHeads, (NSUInteger)kSeq, 1);
                    [enc dispatchThreadgroups:grid threadsPerThreadgroup:tg];
                } else {
                    TurboArgs a{ kHeadDim, (uint32_t)kTurboNkv, kv_stride, 0u, 0u };
                    [enc setBuffer:qbuf offset:0 atIndex:0];
                    [enc setBuffer:kbuf offset:0 atIndex:1];
                    [enc setBuffer:sbuf offset:0 atIndex:2];
                    if (mk.is_tcq) {
                        [enc setBuffer:cbbuf_tcq offset:0 atIndex:3];
                        [enc setBytes:&a length:sizeof(a) atIndex:4];
                    } else {
                        [enc setBytes:&a length:sizeof(a) atIndex:3];
                    }
                    MTLSize tg   = MTLSizeMake(32, 1, 1);
                    MTLSize grid = MTLSizeMake((NSUInteger)kTurboNkv, 1, 1);
                    [enc dispatchThreadgroups:grid threadsPerThreadgroup:tg];
                }
                [enc endEncoding];
                struct timespec t0{}, t1{};
                clock_gettime(CLOCK_MONOTONIC, &t0);
                [cmd commit];
                [cmd waitUntilCompleted];
                clock_gettime(CLOCK_MONOTONIC, &t1);
                cpu_us = (double)(t1.tv_sec - t0.tv_sec) * 1.0e6
                       + (double)(t1.tv_nsec - t0.tv_nsec) * 1.0e-3;
                gpu_us = ([cmd GPUEndTime] - [cmd GPUStartTime]) * 1.0e6;
            }
        };

        auto encode_multi = [&](int N, double & gpu_us, double & cpu_us) {
            @autoreleasepool {
                id<MTLCommandBuffer> cmd = [queue commandBuffer];
                id<MTLComputeCommandEncoder> enc = [cmd computeCommandEncoder];
                [enc setComputePipelineState:pso_multi];
                if (mk.is_qjl) {
                    QjlScoreArgsMulti a{ (uint32_t)kQjlHeads, (uint32_t)kQjlKvHeads,
                                         (uint32_t)kSeq, (uint32_t)kQjlProjDim, (uint32_t)N };
                    [enc setBuffer:qbuf offset:0 atIndex:0];
                    [enc setBuffer:kbuf offset:0 atIndex:1];
                    [enc setBuffer:sbuf offset:0 atIndex:2];
                    [enc setBytes:&a length:sizeof(a) atIndex:3];
                    MTLSize tg   = MTLSizeMake(32, 1, 1);
                    NSUInteger gy = ((NSUInteger)kSeq + (NSUInteger)N - 1) / (NSUInteger)N;
                    MTLSize grid = MTLSizeMake((NSUInteger)kQjlHeads, gy, 1);
                    [enc dispatchThreadgroups:grid threadsPerThreadgroup:tg];
                } else {
                    TurboArgsMulti a{ kHeadDim, (uint32_t)kTurboNkv, kv_stride, 0u, 0u, (uint32_t)N };
                    [enc setBuffer:qbuf offset:0 atIndex:0];
                    [enc setBuffer:kbuf offset:0 atIndex:1];
                    [enc setBuffer:sbuf offset:0 atIndex:2];
                    if (mk.is_tcq) {
                        [enc setBuffer:cbbuf_tcq offset:0 atIndex:3];
                        [enc setBytes:&a length:sizeof(a) atIndex:4];
                    } else {
                        [enc setBytes:&a length:sizeof(a) atIndex:3];
                    }
                    MTLSize tg   = MTLSizeMake(32, 1, 1);
                    NSUInteger gx = ((NSUInteger)kTurboNkv + (NSUInteger)N - 1) / (NSUInteger)N;
                    MTLSize grid = MTLSizeMake(gx, 1, 1);
                    [enc dispatchThreadgroups:grid threadsPerThreadgroup:tg];
                }
                [enc endEncoding];
                struct timespec t0{}, t1{};
                clock_gettime(CLOCK_MONOTONIC, &t0);
                [cmd commit];
                [cmd waitUntilCompleted];
                clock_gettime(CLOCK_MONOTONIC, &t1);
                cpu_us = (double)(t1.tv_sec - t0.tv_sec) * 1.0e6
                       + (double)(t1.tv_nsec - t0.tv_nsec) * 1.0e-3;
                gpu_us = ([cmd GPUEndTime] - [cmd GPUStartTime]) * 1.0e6;
            }
        };

        // Single-block baseline.
        for (int w = 0; w < warmup; w++) { double g, c; encode_single(g, c); }
        std::vector<double> sg, sc;
        for (int it = 0; it < iters; it++) {
            double g, c; encode_single(g, c);
            sg.push_back(g); sc.push_back(c);
        }
        outs[ki].single_block_med_us = median(sg);
        outs[ki].single_block_p99_us = percentile(sg, 0.99);

        // Multi sweep.
        for (int ni = 0; ni < N_GRID; ni++) {
            int N = N_grid[ni];
            for (int w = 0; w < warmup; w++) { double g, c; encode_multi(N, g, c); }
            std::vector<double> mg, mc;
            for (int it = 0; it < iters; it++) {
                double g, c; encode_multi(N, g, c);
                mg.push_back(g); mc.push_back(c);
            }
            MultiResult r{};
            r.N = N;
            r.gpu_med_us = median(mg);
            r.gpu_p99_us = percentile(mg, 0.99);
            r.cpu_med_us = median(mc);
            outs[ki].per_N.push_back(r);
        }
        // Pick the optimal N (lowest GPU median).
        outs[ki].best_us   = outs[ki].per_N[0].gpu_med_us;
        outs[ki].optimal_N = outs[ki].per_N[0].N;
        for (auto & r : outs[ki].per_N) {
            if (r.gpu_med_us < outs[ki].best_us) {
                outs[ki].best_us = r.gpu_med_us;
                outs[ki].optimal_N = r.N;
            }
        }
        outs[ki].speedup_vs_single = (outs[ki].best_us > 0.0)
            ? (outs[ki].single_block_med_us / outs[ki].best_us) : 1.0;

        std::printf("  [%s] single=%-8.2f µs  best=%-8.2f µs @ N=%-2d  speedup=%.2fx\n",
                    mk.name.c_str(), outs[ki].single_block_med_us, outs[ki].best_us,
                    outs[ki].optimal_N, outs[ki].speedup_vs_single);
    }

    struct timespec t_end{}; clock_gettime(CLOCK_MONOTONIC, &t_end);
    double total_s = (double)(t_end.tv_sec - t_start.tv_sec)
                   + (double)(t_end.tv_nsec - t_start.tv_nsec) * 1.0e-9;
    std::printf("[multiblock] total measurement wall: %.2fs\n", total_s);

    std::printf("\n%-12s | %4s | %12s | %12s | %12s | %8s\n",
                "kernel", "N", "gpu_med_us", "gpu_p99_us", "cpu_med_us", "speedup");
    std::printf("-------------+------+--------------+--------------+--------------+---------\n");
    for (auto & o : outs) {
        std::printf("%-12s | %4s | %12.2f | %12.2f | %12s | %8s\n",
                    o.name.c_str(), "1*", o.single_block_med_us, o.single_block_p99_us, "—", "1.00x");
        for (auto & r : o.per_N) {
            double sp = (r.gpu_med_us > 0.0) ? o.single_block_med_us / r.gpu_med_us : 0.0;
            std::printf("%-12s | %4d | %12.2f | %12.2f | %12.2f | %7.2fx\n",
                        o.name.c_str(), r.N, r.gpu_med_us, r.gpu_p99_us, r.cpu_med_us, sp);
        }
    }
    std::printf("\nNote: the '1*' row is the existing single-block kernel (kernel_*_dot); "
                "the N=1 row is the new multi-block kernel with blocks_per_threadgroup=1 "
                "(should be ≈ single-block, used for shape-matched baseline).\n");

    FILE * fp = std::fopen(out_path, "w");
    if (!fp) { std::fprintf(stderr, "[multiblock] cannot open %s\n", out_path); return 1; }
    std::fprintf(fp, "{\n");
    std::fprintf(fp, "  \"device\": \"%s\",\n", [[device name] UTF8String]);
    std::fprintf(fp, "  \"date\": \"2026-05-10\",\n");
    std::fprintf(fp, "  \"mode\": \"multiblock\",\n");
    std::fprintf(fp, "  \"description\": \"Multi-block-per-dispatch sweep (SHADER_REVIEW M3). Each threadgroup processes N consecutive KV blocks serially via 32-thread loop, cutting launch grid by N×.\",\n");
    std::fprintf(fp, "  \"iterations\": %d,\n", iters);
    std::fprintf(fp, "  \"warmup\": %d,\n", warmup);
    std::fprintf(fp, "  \"N_grid\": [1, 2, 4, 8, 16, 32],\n");
    std::fprintf(fp, "  \"workload\": { \"head_dim\": %d, \"seq\": %d, \"kv_heads\": %d, \"turbo_n_kv\": %d, \"qjl_q_heads\": %d, \"qjl_kv_heads\": %d, \"qjl_proj_dim\": %d },\n",
                 kHeadDim, kSeq, kKvHeads, kTurboNkv, kQjlHeads, kQjlKvHeads, kQjlProjDim);
    std::fprintf(fp, "  \"kernels\": [\n");
    for (size_t i = 0; i < outs.size(); i++) {
        auto & o = outs[i];
        std::fprintf(fp, "    {\n");
        std::fprintf(fp, "      \"name\": \"%s\",\n", o.name.c_str());
        std::fprintf(fp, "      \"single_block\": { \"gpu_med_us\": %.4f, \"gpu_p99_us\": %.4f },\n",
                     o.single_block_med_us, o.single_block_p99_us);
        std::fprintf(fp, "      \"multi_block\": [\n");
        for (size_t j = 0; j < o.per_N.size(); j++) {
            auto & r = o.per_N[j];
            double sp = (r.gpu_med_us > 0.0) ? o.single_block_med_us / r.gpu_med_us : 0.0;
            std::fprintf(fp,
                "        { \"N\": %d, \"gpu_med_us\": %.4f, \"gpu_p99_us\": %.4f, \"cpu_med_us\": %.4f, \"speedup_vs_single\": %.4f }%s\n",
                r.N, r.gpu_med_us, r.gpu_p99_us, r.cpu_med_us, sp,
                j + 1 == o.per_N.size() ? "" : ",");
        }
        std::fprintf(fp, "      ],\n");
        std::fprintf(fp, "      \"optimal_N\": %d,\n", o.optimal_N);
        std::fprintf(fp, "      \"best_gpu_med_us\": %.4f,\n", o.best_us);
        std::fprintf(fp, "      \"speedup_vs_single\": %.4f\n", o.speedup_vs_single);
        std::fprintf(fp, "    }%s\n", i + 1 == outs.size() ? "" : ",");
    }
    std::fprintf(fp, "  ]\n");
    std::fprintf(fp, "}\n");
    std::fclose(fp);
    std::printf("\n[multiblock] wrote %s\n", out_path);
    return 0;
}

} // namespace

int main(int argc, const char * argv[]) {
    const char * out_path = nullptr;
    const char * mode = "default";
    int iters_override = -1, warmup_override = -1, runs_override = -1;
    for (int i = 1; i < argc; i++) {
        if      (std::strcmp(argv[i], "--out")    == 0 && i + 1 < argc) out_path = argv[++i];
        else if (std::strcmp(argv[i], "--mode")   == 0 && i + 1 < argc) mode     = argv[++i];
        else if (std::strcmp(argv[i], "--iters")  == 0 && i + 1 < argc) iters_override  = std::atoi(argv[++i]);
        else if (std::strcmp(argv[i], "--warmup") == 0 && i + 1 < argc) warmup_override = std::atoi(argv[++i]);
        else if (std::strcmp(argv[i], "--runs")   == 0 && i + 1 < argc) runs_override   = std::atoi(argv[++i]);
    }

    @autoreleasepool {
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (!device) {
            std::fprintf(stderr, "[metal_bench] no Metal device\n");
            return 1;
        }
        std::printf("[metal_bench] device=%s mode=%s\n", [[device name] UTF8String], mode);
        id<MTLCommandQueue> queue = [device newCommandQueue];

        if (std::strcmp(mode, "tgsweep") == 0) {
            int it = iters_override > 0 ? iters_override : 200;
            int wm = warmup_override >= 0 ? warmup_override : 50;
            const char * out = out_path ? out_path : "bench_results/m4max_tgsweep_2026-05-10.json";
            return run_mode_tgsweep(device, queue, it, wm, out);
        }
        if (std::strcmp(mode, "fp16ref") == 0) {
            int it = iters_override > 0 ? iters_override : 1000;
            int wm = warmup_override >= 0 ? warmup_override : 100;
            int rn = runs_override   > 0 ? runs_override   : 3;
            const char * out = out_path ? out_path : "bench_results/m4max_fp16ref_2026-05-10.json";
            return run_mode_fp16ref(device, queue, it, wm, rn, out);
        }
        if (std::strcmp(mode, "batched") == 0) {
            // iters_override means iters_per_N here; default 32 keeps the
            // largest-N sweep (256 dispatches × ~250 µs ≈ 64 ms each ×
            // 32 = ~2 s for that single cell, ~10–15 s per kernel total).
            int it = iters_override > 0 ? iters_override : 32;
            int wm = warmup_override >= 0 ? warmup_override : 16;
            const char * out = out_path ? out_path : "bench_results/m4max_batched_2026-05-10.json";
            return run_mode_batched(device, queue, it, wm, out);
        }
        if (std::strcmp(mode, "multiblock") == 0) {
            int it = iters_override > 0 ? iters_override : 200;
            int wm = warmup_override >= 0 ? warmup_override : 30;
            const char * out = out_path ? out_path : "bench_results/m4max_multiblock_2026-05-10.json";
            return run_mode_multiblock(device, queue, it, wm, out);
        }
        // Fall through: default mode.
        if (!out_path) out_path = "bench_results/m4max_2026-05-10.json";
        // Apply iters/warmup overrides if provided. (kIters/kWarmup defaults
        // are kept; we just shadow them locally for the run.)
        int default_iters_local  = (iters_override  > 0) ? iters_override  : kIters;
        int default_warmup_local = (warmup_override >= 0) ? warmup_override : kWarmup;
        // Default mode aggregates `iters` dispatches per kernel into one
        // sample set and reports the median over that set; --runs is honored
        // by re-running the entire interleaved bench loop and merging
        // samples (so kernels[i].gpu_us ends up with iters*runs samples).
        int default_runs_local   = (runs_override   > 0) ? runs_override   : 1;

        // -------- Build per-kernel state --------
        std::vector<KernelBench> kernels(6);
        kernels[0].name = "turbo3";
        kernels[0].source_path = "../metal/turbo3.metal";
        kernels[0].kernel_func = "kernel_turbo3_dot";
        kernels[1].name = "turbo4";
        kernels[1].source_path = "../metal/turbo4.metal";
        kernels[1].kernel_func = "kernel_turbo4_dot";
        kernels[2].name = "turbo3_tcq";
        kernels[2].source_path = "../metal/turbo3_tcq.metal";
        kernels[2].kernel_func = "kernel_turbo3_tcq_dot";
        kernels[3].name = "qjl";
        kernels[3].source_path = "../metal/qjl.metal";
        kernels[3].kernel_func = "kernel_attn_score_qjl1_256";
        kernels[4].name = "polar";
        kernels[4].source_path = "../metal/polar.metal";
        kernels[4].kernel_func = "kernel_mul_mv_q4_polar_f32";
        kernels[5].name = "polar_preht";
        kernels[5].source_path = "../metal/polar.metal";
        kernels[5].kernel_func = "kernel_mul_mv_q4_polar_preht_f32";

        // Compile pipelines.
        for (auto & kb : kernels) {
            kb.pso = compile_kernel(device, kb.source_path.c_str(), kb.kernel_func.c_str());
            if (!kb.pso) {
                std::fprintf(stderr, "[metal_bench] aborting: %s pipeline failed\n", kb.name.c_str());
                return 1;
            }
        }

        // -------- Allocate shared buffers, fill with realistic-magnitude noise --------
        // Turbo3 / turbo4 / turbo3_tcq: q is one head_dim-sized vector (per q_head=0).
        std::vector<float>   q_turbo   = randn_floats(kHeadDim, 0xA1);
        std::vector<uint8_t> k_turbo3  = rand_bytes((size_t)kTurboNkv * kTurbo3BlockBytes    * kTurbo3BlocksPerKv,    0xA2);
        std::vector<uint8_t> k_turbo4  = rand_bytes((size_t)kTurboNkv * kTurbo4BlockBytes    * kTurbo4BlocksPerKv,    0xA3);
        std::vector<uint8_t> k_turbo3t = rand_bytes((size_t)kTurboNkv * kTurbo3TcqBlockBytes * kTurbo3TcqBlocksPerKv, 0xA4);
        std::vector<float>   tcq_cb    = make_tcq_codebook();

        // QJL: q_sketch is (n_heads, proj_dim); packed_k is (n_kv_heads, n_tokens) blocks.
        std::vector<float>   q_qjl     = randn_floats((size_t)kQjlHeads * kQjlProjDim, 0xB1);
        std::vector<uint8_t> k_qjl     = rand_bytes((size_t)kQjlKvHeads * kSeq * kQjlBlockBytes, 0xB2);

        // Polar: q is (n_rows, head_dim) fp32 activations; k is (n_rows, block) packed.
        // The shader signature in metal_verify drives n_rows = number of blocks.
        std::vector<float>   q_polar   = randn_floats((size_t)kHeadDim, 0xC1);
        std::vector<float>   q_polar_preht = q_polar;
        hadamard128_inplace(q_polar_preht);
        std::vector<uint8_t> k_polar   = rand_bytes((size_t)kPolarRows * kPolarBlockBytes, 0xC2);

        auto make_buf = [&](const void * data, size_t bytes) {
            return [device newBufferWithBytes:data length:bytes options:MTLResourceStorageModeShared];
        };
        auto zero_buf = [&](size_t bytes) {
            id<MTLBuffer> b = [device newBufferWithLength:bytes options:MTLResourceStorageModeShared];
            std::memset([b contents], 0, [b length]);
            return b;
        };

        // turbo3
        {
            auto & kb = kernels[0];
            kb.q_buf      = make_buf(q_turbo.data(),  q_turbo.size()  * sizeof(float));
            kb.k_buf      = make_buf(k_turbo3.data(), k_turbo3.size());
            kb.scores_buf = zero_buf((size_t)kTurboNkv * sizeof(float));
            kb.turbo_args = TurboArgs{ kHeadDim, (uint32_t)kTurboNkv, kTurbo3BlocksPerKv, 0u, 0u };
            kb.threadgroup = MTLSizeMake(32, 1, 1);
            kb.grid        = MTLSizeMake((NSUInteger)kTurboNkv, 1, 1);
            kb.bytes_per_dispatch = (uint64_t)q_turbo.size() * sizeof(float)
                                  + (uint64_t)k_turbo3.size()
                                  + (uint64_t)kTurboNkv * sizeof(float);
            kb.n_outputs = kTurboNkv;
        }
        // turbo4
        {
            auto & kb = kernels[1];
            kb.q_buf      = make_buf(q_turbo.data(),  q_turbo.size()  * sizeof(float));
            kb.k_buf      = make_buf(k_turbo4.data(), k_turbo4.size());
            kb.scores_buf = zero_buf((size_t)kTurboNkv * sizeof(float));
            kb.turbo_args = TurboArgs{ kHeadDim, (uint32_t)kTurboNkv, kTurbo4BlocksPerKv, 0u, 0u };
            kb.threadgroup = MTLSizeMake(32, 1, 1);
            kb.grid        = MTLSizeMake((NSUInteger)kTurboNkv, 1, 1);
            kb.bytes_per_dispatch = (uint64_t)q_turbo.size() * sizeof(float)
                                  + (uint64_t)k_turbo4.size()
                                  + (uint64_t)kTurboNkv * sizeof(float);
            kb.n_outputs = kTurboNkv;
        }
        // turbo3_tcq
        {
            auto & kb = kernels[2];
            kb.q_buf      = make_buf(q_turbo.data(),   q_turbo.size()   * sizeof(float));
            kb.k_buf      = make_buf(k_turbo3t.data(), k_turbo3t.size());
            kb.scores_buf = zero_buf((size_t)kTurboNkv * sizeof(float));
            kb.cb_buf     = make_buf(tcq_cb.data(),    tcq_cb.size()    * sizeof(float));
            kb.turbo_args = TurboArgs{ kHeadDim, (uint32_t)kTurboNkv, kTurbo3TcqBlocksPerKv, 0u, 0u };
            kb.threadgroup = MTLSizeMake(32, 1, 1);
            kb.grid        = MTLSizeMake((NSUInteger)kTurboNkv, 1, 1);
            kb.bytes_per_dispatch = (uint64_t)q_turbo.size() * sizeof(float)
                                  + (uint64_t)k_turbo3t.size()
                                  + (uint64_t)tcq_cb.size() * sizeof(float)
                                  + (uint64_t)kTurboNkv * sizeof(float);
            kb.n_outputs = kTurboNkv;
        }
        // qjl
        {
            auto & kb = kernels[3];
            kb.q_buf      = make_buf(q_qjl.data(), q_qjl.size() * sizeof(float));
            kb.k_buf      = make_buf(k_qjl.data(), k_qjl.size());
            kb.scores_buf = zero_buf((size_t)kQjlHeads * kSeq * sizeof(float));
            kb.qjl_args   = QjlScoreArgs{ (uint32_t)kQjlHeads, (uint32_t)kQjlKvHeads,
                                          (uint32_t)kSeq,      (uint32_t)kQjlProjDim };
            kb.threadgroup = MTLSizeMake(32, 1, 1);
            kb.grid        = MTLSizeMake((NSUInteger)kQjlHeads, (NSUInteger)kSeq, 1);
            kb.bytes_per_dispatch = (uint64_t)q_qjl.size() * sizeof(float)
                                  + (uint64_t)k_qjl.size()
                                  + (uint64_t)kQjlHeads * kSeq * sizeof(float);
            kb.n_outputs = kQjlHeads * kSeq;
        }
        // polar
        {
            auto & kb = kernels[4];
            kb.q_buf      = make_buf(q_polar.data(), q_polar.size() * sizeof(float));
            kb.k_buf      = make_buf(k_polar.data(), k_polar.size());
            kb.scores_buf = zero_buf((size_t)kPolarRows * sizeof(float));
            kb.polar_args = PolarMvArgs{ (uint32_t)kPolarRows, kHeadDim, 0u };
            kb.threadgroup = MTLSizeMake(32, 1, 1);
            kb.grid        = MTLSizeMake((NSUInteger)kPolarRows, 1, 1);
            kb.bytes_per_dispatch = (uint64_t)q_polar.size() * sizeof(float)
                                  + (uint64_t)k_polar.size()
                                  + (uint64_t)kPolarRows * sizeof(float);
            kb.n_outputs = kPolarRows;
        }
        // polar with pre-Hadamard query
        {
            auto & kb = kernels[5];
            kb.q_buf      = make_buf(q_polar_preht.data(), q_polar_preht.size() * sizeof(float));
            kb.k_buf      = make_buf(k_polar.data(), k_polar.size());
            kb.scores_buf = zero_buf((size_t)kPolarRows * sizeof(float));
            kb.polar_args = PolarMvArgs{ (uint32_t)kPolarRows, kHeadDim, 0u };
            kb.threadgroup = MTLSizeMake(32, 1, 1);
            kb.grid        = MTLSizeMake((NSUInteger)kPolarRows, 1, 1);
            kb.bytes_per_dispatch = (uint64_t)q_polar_preht.size() * sizeof(float)
                                  + (uint64_t)k_polar.size()
                                  + (uint64_t)kPolarRows * sizeof(float);
            kb.n_outputs = kPolarRows;
        }

        // -------- Warmup (interleaved, default_warmup_local outer passes over all 5) --------
        std::printf("[metal_bench] warming up (%d outer × %zu kernels)...\n",
                    default_warmup_local, kernels.size());
        for (int w = 0; w < default_warmup_local; w++) {
            for (size_t i = 0; i < kernels.size(); i++) {
                double g, c;
                bool is_t3  = (i == 0), is_t4 = (i == 1), is_tcq = (i == 2);
                bool is_qjl = (i == 3), is_pol = (i == 4);
                encode_dispatch(queue, kernels[i], is_t3, is_t4, is_tcq, is_qjl, is_pol, g, c);
            }
        }

        // -------- Measurement (interleaved, default_iters_local outer passes over all 5) --------
        // Probe each kernel with one timing call to pick iteration count: if
        // the warmup last-pass took more than 5 ms per kernel, drop to
        // kItersHeavy to stay inside our 15-min wall budget.
        int iters = default_iters_local;
        {
            double max_warm_us = 0.0;
            for (size_t i = 0; i < kernels.size(); i++) {
                double g, c;
                bool is_t3  = (i == 0), is_t4 = (i == 1), is_tcq = (i == 2);
                bool is_qjl = (i == 3), is_pol = (i == 4);
                encode_dispatch(queue, kernels[i], is_t3, is_t4, is_tcq, is_qjl, is_pol, g, c);
                if (c > max_warm_us) max_warm_us = c;
            }
            if (max_warm_us > 5000.0) {
                iters = kItersHeavy;
                std::printf("[metal_bench] slowest kernel ~%.0f µs/run > 5ms threshold; dropping to N=%d\n",
                            max_warm_us, iters);
            } else {
                std::printf("[metal_bench] slowest kernel ~%.0f µs/run; using N=%d\n",
                            max_warm_us, iters);
            }
        }

        std::printf("[metal_bench] measuring %d iterations × %d runs × %zu kernels (interleaved)...\n",
                    iters, default_runs_local, kernels.size());
        struct timespec t_start{}; clock_gettime(CLOCK_MONOTONIC, &t_start);

        // Per-run medians, so we can report run-to-run variance separately
        // from sample-level percentiles (variance > 10% flags thermal drift).
        std::vector<std::vector<double>> per_run_med(kernels.size());

        for (int r = 0; r < default_runs_local; r++) {
            std::vector<std::vector<double>> run_samples(kernels.size());
            for (int it = 0; it < iters; it++) {
                for (size_t i = 0; i < kernels.size(); i++) {
                    double g, c;
                    bool is_t3  = (i == 0), is_t4 = (i == 1), is_tcq = (i == 2);
                    bool is_qjl = (i == 3), is_pol = (i == 4);
                    encode_dispatch(queue, kernels[i], is_t3, is_t4, is_tcq, is_qjl, is_pol, g, c);
                    kernels[i].gpu_us.push_back(g);
                    kernels[i].cpu_us.push_back(c);
                    run_samples[i].push_back(g);
                }
            }
            for (size_t i = 0; i < kernels.size(); i++) {
                per_run_med[i].push_back(median(run_samples[i]));
            }
        }

        struct timespec t_end{}; clock_gettime(CLOCK_MONOTONIC, &t_end);
        double total_s = (double)(t_end.tv_sec - t_start.tv_sec)
                       + (double)(t_end.tv_nsec - t_start.tv_nsec) * 1.0e-9;
        std::printf("[metal_bench] total measurement wall: %.2fs\n", total_s);

        // -------- Report --------
        std::printf("\n%-12s | %12s | %12s | %12s | %12s | %10s | %12s\n",
                    "kernel", "gpu_med_us", "gpu_p99_us", "cpu_med_us", "bw_GBs", "bw_pct", "gflops");
        std::printf("-------------+--------------+--------------+--------------+--------------+------------+--------------\n");

        FILE * fp = std::fopen(out_path, "w");
        if (!fp) {
            std::fprintf(stderr, "[metal_bench] cannot open %s for write\n", out_path);
            return 1;
        }
        std::fprintf(fp, "{\n");
        std::fprintf(fp, "  \"device\": \"%s\",\n", [[device name] UTF8String]);
        std::fprintf(fp, "  \"date\": \"2026-05-10\",\n");
        std::fprintf(fp, "  \"iterations\": %d,\n", iters);
        std::fprintf(fp, "  \"warmup\": %d,\n", default_warmup_local);
        std::fprintf(fp, "  \"runs\": %d,\n", default_runs_local);
        std::fprintf(fp, "  \"peak_bandwidth_GBs\": %.1f,\n", (double)kPeakBwGBs);
        std::fprintf(fp, "  \"workload\": {\n");
        std::fprintf(fp, "    \"description\": \"single attention step, 9B-class decode\",\n");
        std::fprintf(fp, "    \"head_dim\": %d, \"seq\": %d, \"kv_heads\": %d,\n",
                     kHeadDim, kSeq, kKvHeads);
        std::fprintf(fp, "    \"q_heads\": %d, \"qjl_q_heads\": %d, \"qjl_kv_heads\": %d,\n",
                     kQHeads, kQjlHeads, kQjlKvHeads);
        std::fprintf(fp, "    \"polar_rows\": %d, \"turbo_n_kv\": %d\n",
                     kPolarRows, kTurboNkv);
        std::fprintf(fp, "  },\n");
        std::fprintf(fp, "  \"kernels\": [\n");

        for (size_t i = 0; i < kernels.size(); i++) {
            auto & kb = kernels[i];
            double gpu_med = median(kb.gpu_us);
            double gpu_p50 = percentile(kb.gpu_us, 0.50);
            double gpu_p99 = percentile(kb.gpu_us, 0.99);
            double cpu_med = median(kb.cpu_us);
            double cpu_p99 = percentile(kb.cpu_us, 0.99);

            // Bandwidth: bytes_per_dispatch / gpu_med_seconds.
            double bw_GBs = 0.0, bw_pct = 0.0;
            if (gpu_med > 0.0) {
                double gpu_s = gpu_med * 1.0e-6;
                bw_GBs = ((double)kb.bytes_per_dispatch / gpu_s) / 1.0e9;
                bw_pct = 100.0 * bw_GBs / (double)kPeakBwGBs;
            }

            // Tokens/sec equivalent: this kernel runs once per layer per
            // decode step. A 9B model has kLayers9B layers. Time per layer
            // for this kernel = gpu_med µs. Time per decode step (this
            // kernel only) = kLayers9B * gpu_med. Tokens/sec (this kernel
            // alone) = 1e6 / (kLayers9B * gpu_med).
            double tokens_per_s = (gpu_med > 0.0) ? (1.0e6 / ((double)kLayers9B * gpu_med)) : 0.0;

            // GFLOPs estimate: 2 FMAs × head_dim per output (mul + add).
            // Polar adds the 7-stage Walsh-Hadamard butterfly (~7 * head_dim
            // ops); we report the dot-product GFLOP/s only and footnote the
            // butterfly cost separately in the BENCHMARK doc.
            double flops_per_dispatch = 2.0 * (double)kHeadDim * (double)kb.n_outputs;
            double gflops = (gpu_med > 0.0)
                ? (flops_per_dispatch / (gpu_med * 1.0e-6)) / 1.0e9
                : 0.0;

            // Per-run variance (max-min of per-run medians, normalised).
            double per_run_min = per_run_med[i].empty() ? 0.0 :
                *std::min_element(per_run_med[i].begin(), per_run_med[i].end());
            double per_run_max = per_run_med[i].empty() ? 0.0 :
                *std::max_element(per_run_med[i].begin(), per_run_med[i].end());
            double per_run_variance_pct = (per_run_min > 0.0)
                ? 100.0 * (per_run_max - per_run_min) / per_run_min : 0.0;
            double blocks_per_s = (gpu_med > 0.0)
                ? ((double)kb.n_outputs / (gpu_med * 1.0e-6)) : 0.0;

            std::printf("%-12s | %12.2f | %12.2f | %12.2f | %12.2f | %9.1f%% | %8.1f GF/s\n",
                        kb.name.c_str(), gpu_med, gpu_p99, cpu_med, bw_GBs, bw_pct, gflops);

            std::fprintf(fp, "    {\n");
            std::fprintf(fp, "      \"name\": \"%s\",\n", kb.name.c_str());
            std::fprintf(fp, "      \"kernel_function\": \"%s\",\n", kb.kernel_func.c_str());
            std::fprintf(fp, "      \"n_outputs\": %d,\n", kb.n_outputs);
            std::fprintf(fp, "      \"bytes_per_dispatch\": %llu,\n", (unsigned long long)kb.bytes_per_dispatch);
            std::fprintf(fp, "      \"gpu_us\": { \"median\": %.4f, \"p50\": %.4f, \"p99\": %.4f, \"min\": %.4f, \"max\": %.4f },\n",
                         gpu_med, gpu_p50, gpu_p99,
                         *std::min_element(kb.gpu_us.begin(), kb.gpu_us.end()),
                         *std::max_element(kb.gpu_us.begin(), kb.gpu_us.end()));
            std::fprintf(fp, "      \"cpu_us\": { \"median\": %.4f, \"p99\": %.4f },\n",
                         cpu_med, cpu_p99);
            std::fprintf(fp, "      \"bandwidth_GBs\": %.4f,\n", bw_GBs);
            std::fprintf(fp, "      \"bandwidth_pct_of_peak\": %.4f,\n", bw_pct);
            std::fprintf(fp, "      \"gflops_dot_only\": %.4f,\n", gflops);
            std::fprintf(fp, "      \"blocks_per_s\": %.2f,\n", blocks_per_s);
            std::fprintf(fp, "      \"per_run_median_us\": { \"min\": %.4f, \"max\": %.4f, \"variance_pct\": %.4f },\n",
                         per_run_min, per_run_max, per_run_variance_pct);
            std::fprintf(fp, "      \"tokens_per_s_single_kernel_decode\": %.2f\n", tokens_per_s);
            std::fprintf(fp, "    }%s\n", i + 1 == kernels.size() ? "" : ",");
        }
        std::fprintf(fp, "  ],\n");
        std::fprintf(fp, "  \"counter_sample_buffer\": {\n");
        std::fprintf(fp, "    \"available\": false,\n");
        std::fprintf(fp, "    \"note\": \"MTLCounterSampleBuffer with stage boundaries on Apple Silicon requires the kernel-level GPU counter set, which is gated behind the developer-mode entitlement and is not exposed to non-privileged processes. metal_bench falls back to MTLCommandBuffer.GPUStartTime/GPUEndTime, which is entitlement-free and gives end-to-end command-buffer GPU time at µs resolution.\"\n");
        std::fprintf(fp, "  }\n");
        std::fprintf(fp, "}\n");
        std::fclose(fp);
        std::printf("\n[metal_bench] wrote %s\n", out_path);
    }
    return 0;
}
