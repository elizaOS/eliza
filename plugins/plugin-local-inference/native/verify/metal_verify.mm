// Host-side Metal verification harness for the turbo3 / turbo4 / turbo3_tcq /
// qjl / polar shaders plus the fused-attention (`fused_attn_qjl_tbq` /
// `fused_attn_qjl_polar`) and Polar pre-Hadamard-query score (`polar_preht`)
// kernels. Loads the JSON fixture written by gen_fixture, JIT-compiles the
// .metal source via MTLDevice.newLibraryWithSource, dispatches the relevant
// kernel function, and compares output against the reference (tolerance: 1e-3
// absolute by default).
//
// Build (macOS only):
//     make metal
//
// Run:
//     ./metal_verify ../metal/turbo4.metal kernel_turbo4_dot fixtures/turbo4.json
//     ./metal_verify ../metal/fused_attn_qjl_tbq.metal kernel_fused_attn_qjl_tbq3_f32 fixtures/fused_attn_qjl_tbq.json
//     ./metal_verify ../metal/polar_preht.metal kernel_attn_score_q4_polar_preht_f32 fixtures/polar_preht.json

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include "turbo_kernels.h"
#include "qjl_polar_ref.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace {

struct Fixture {
    std::string kernel;
    int head_dim     = 0;
    int n_kv         = 0;       // turbo: n_kv blocks; polar: n_rows; qjl: n_tokens
    int block_bytes  = 0;
    int blocks_per_kv = 0;       // turbo only

    // QJL extras
    int proj_dim     = 0;
    int n_heads      = 0;
    int n_kv_heads   = 0;
    int n_tokens     = 0;

    // Polar extras
    int n_rows       = 0;
    int use_qjl      = 0;

    std::vector<float> q;        // turbo: query; polar: q activation chunk; preht: raw q
    std::vector<float> hq;       // preht: H*q (already-transformed query)
    std::vector<float> q_sketch; // qjl
    std::vector<uint8_t> k_blocks;
    std::vector<uint8_t> k_blocks_qjl; // preht only
    std::vector<float> expected_scores;
    std::vector<float> expected_scores_qjl; // preht only
};

static std::string slurp(const char * path) {
    std::ifstream f(path);
    if (!f) { std::fprintf(stderr, "cannot open %s\n", path); std::exit(1); }
    std::stringstream ss; ss << f.rdbuf(); return ss.str();
}

// Identical mini-parser to vulkan_verify.cpp.
static const char * find_key(const std::string & s, const char * key, size_t & pos) {
    std::string needle = std::string("\"") + key + "\"";
    size_t k = s.find(needle, pos);
    if (k == std::string::npos) return nullptr;
    size_t colon = s.find(':', k);
    pos = colon + 1;
    while (pos < s.size() && std::isspace((unsigned char)s[pos])) pos++;
    return s.c_str() + pos;
}
static bool find_key_opt(const std::string & s, const char * key, size_t & pos) {
    size_t scan = 0;
    if (find_key(s, key, scan) == nullptr) return false;
    pos = scan;
    return true;
}
static int parse_int(const std::string & s, size_t & pos) {
    while (pos < s.size() && std::isspace((unsigned char)s[pos])) pos++;
    char * end = nullptr;
    long v = std::strtol(s.c_str() + pos, &end, 10);
    pos = (size_t)(end - s.c_str());
    return (int)v;
}
static float parse_float(const std::string & s, size_t & pos) {
    while (pos < s.size() && std::isspace((unsigned char)s[pos])) pos++;
    char * end = nullptr;
    float v = std::strtof(s.c_str() + pos, &end);
    pos = (size_t)(end - s.c_str());
    return v;
}
static std::vector<float> parse_float_array(const std::string & s, size_t & pos) {
    while (s[pos] != '[') pos++; pos++;
    std::vector<float> out;
    while (s[pos] != ']') {
        char * end = nullptr;
        out.push_back(std::strtof(s.c_str() + pos, &end));
        pos = (size_t)(end - s.c_str());
        while (s[pos] == ',' || std::isspace((unsigned char)s[pos])) pos++;
    }
    pos++;
    return out;
}
static std::vector<uint8_t> parse_byte_array(const std::string & s, size_t & pos) {
    while (s[pos] != '[') pos++; pos++;
    std::vector<uint8_t> out;
    while (s[pos] != ']') {
        char * end = nullptr;
        out.push_back((uint8_t)std::strtol(s.c_str() + pos, &end, 10));
        pos = (size_t)(end - s.c_str());
        while (s[pos] == ',' || std::isspace((unsigned char)s[pos])) pos++;
    }
    pos++;
    return out;
}
static std::string parse_string(const std::string & s, size_t & pos) {
    while (s[pos] != '"') pos++; pos++;
    size_t start = pos;
    while (s[pos] != '"') pos++;
    std::string out = s.substr(start, pos - start);
    pos++;
    return out;
}

// --- balanced-bracket helpers for the fused-attention `cases`-array schema
//     (mirrors vulkan_verify.cpp). ---
static bool find_balanced(const std::string & s, size_t from, char open, char close,
                          size_t & out_open, size_t & out_close) {
    size_t i = s.find(open, from);
    if (i == std::string::npos) return false;
    int depth = 0;
    for (size_t j = i; j < s.size(); ++j) {
        if (s[j] == open) ++depth;
        else if (s[j] == close) { --depth; if (depth == 0) { out_open = i; out_close = j; return true; } }
    }
    return false;
}
static std::vector<std::string> split_object_array(const std::string & body) {
    std::vector<std::string> out;
    size_t pos = 0;
    while (true) {
        size_t o, c;
        if (!find_balanced(body, pos, '{', '}', o, c)) break;
        out.push_back(body.substr(o, c - o + 1));
        pos = c + 1;
    }
    return out;
}
static int obj_int(const std::string & obj, const char * key, int def = 0) {
    size_t p = 0; if (!find_key(obj, key, p)) return def;
    return parse_int(obj, p);
}
static std::vector<float> obj_floats(const std::string & obj, const char * key) {
    size_t p = 0; if (!find_key(obj, key, p)) return {};
    return parse_float_array(obj, p);
}
static std::vector<uint8_t> obj_bytes(const std::string & obj, const char * key) {
    size_t p = 0; if (!find_key(obj, key, p)) return {};
    return parse_byte_array(obj, p);
}

static Fixture load_fixture(const char * path) {
    std::string s = slurp(path);
    Fixture fx;
    size_t pos = 0;
    if (find_key_opt(s, "kernel", pos))         fx.kernel = parse_string(s, pos);
    if (find_key_opt(s, "head_dim", pos))       fx.head_dim = parse_int(s, pos);
    if (find_key_opt(s, "n_kv", pos))           fx.n_kv = parse_int(s, pos);
    if (find_key_opt(s, "block_bytes", pos))    fx.block_bytes = parse_int(s, pos);
    if (find_key_opt(s, "blocks_per_kv", pos))  fx.blocks_per_kv = parse_int(s, pos);
    if (find_key_opt(s, "proj_dim", pos))       fx.proj_dim = parse_int(s, pos);
    if (find_key_opt(s, "n_heads", pos))        fx.n_heads = parse_int(s, pos);
    if (find_key_opt(s, "n_kv_heads", pos))     fx.n_kv_heads = parse_int(s, pos);
    if (find_key_opt(s, "n_tokens", pos))       fx.n_tokens = parse_int(s, pos);
    if (find_key_opt(s, "n_rows", pos))         fx.n_rows = parse_int(s, pos);
    if (find_key_opt(s, "use_qjl", pos))        fx.use_qjl = parse_int(s, pos);
    if (find_key_opt(s, "q", pos))              fx.q = parse_float_array(s, pos);
    if (find_key_opt(s, "hq", pos))             fx.hq = parse_float_array(s, pos);
    if (find_key_opt(s, "q_sketch", pos))       fx.q_sketch = parse_float_array(s, pos);
    if (find_key_opt(s, "k_blocks", pos))       fx.k_blocks = parse_byte_array(s, pos);
    if (find_key_opt(s, "k_blocks_qjl", pos))   fx.k_blocks_qjl = parse_byte_array(s, pos);
    if (find_key_opt(s, "expected_scores", pos)) fx.expected_scores = parse_float_array(s, pos);
    if (find_key_opt(s, "expected_scores_qjl", pos)) fx.expected_scores_qjl = parse_float_array(s, pos);
    return fx;
}

// Argument structs — must be ABI-compatible with the Metal-side definitions.

struct TurboArgs {
    uint32_t head_dim, n_kv, kv_stride_blocks, q_head, head_offset_bytes;
};
struct TurboArgsMulti {
    uint32_t head_dim, n_kv, kv_stride_blocks, q_head, head_offset_bytes, blocks_per_threadgroup;
};
struct QjlScoreArgs {
    uint32_t n_heads, n_kv_heads, n_tokens, proj_dim;
};
struct QjlScoreArgsMulti {
    uint32_t n_heads, n_kv_heads, n_tokens, proj_dim, tokens_per_threadgroup;
};
struct PolarMvArgs {
    uint32_t n_rows, head_dim, use_qjl;
};
// Matches polar_preht.metal's polar_score_args.
struct PolarScoreArgs {
    uint32_t head_dim, n_kv, kv_stride_blocks, q_head, head_offset_bytes, use_qjl;
};
// Matches fused_attn_qjl_{tbq,polar}.metal's fused_attn_args.
struct FusedAttnArgs {
    uint32_t head_dim, proj_dim, n_heads, n_kv_heads, n_q_pos, n_kv, kv_tile, v_use_qjl;
    float    scale;
    uint32_t causal, q_pos_base;
};

static void hadamard128_inplace(std::vector<float> & x) {
    for (int h = 1; h < 128; h <<= 1) {
        for (int i = 0; i < 128; i += (h << 1)) {
            for (int j = i; j < i + h; ++j) {
                float a = x[(size_t)j];
                float b = x[(size_t)j + (size_t)h];
                x[(size_t)j] = a + b;
                x[(size_t)j + (size_t)h] = a - b;
            }
        }
    }
}

// ============================ fused-attention runner ============================

struct FusedCase {
    int n_heads = 0, n_kv_heads = 0, n_kv = 0;
    int causal = 0;
    int q_pos_base = 0;
    std::vector<float>   q_sketch;       // n_heads * 256
    std::vector<uint8_t> k_blocks;       // n_kv_heads * n_kv * 34
    std::vector<uint8_t> v_blocks;       // tbq: *4*14 ; polar: *82
    std::vector<float>   expected_out;   // n_heads * 128
};

static int run_fused_attn(id<MTLDevice> device, NSString * src,
                          const char * kernel_name, const char * fx_path, float tol) {
    const std::string s = slurp(fx_path);
    std::string kernel;
    { size_t p = 0; if (!find_key(s, "kernel", p)) { std::fprintf(stderr, "fixture missing kernel\n"); return 2; }
      kernel = parse_string(s, p); }
    const bool is_polar = (kernel == "fused_attn_qjl_polar");
    if (!is_polar && kernel != "fused_attn_qjl_tbq") {
        std::fprintf(stderr, "run_fused_attn: unexpected kernel '%s'\n", kernel.c_str()); return 2;
    }
    float sm_scale_v = 0.0f;
    { size_t p = 0; if (find_key(s, "sm_scale", p)) sm_scale_v = parse_float(s, p); }
    const uint32_t use_qjl = is_polar ? (uint32_t)[&]{ size_t p=0; return find_key(s,"use_qjl",p)?parse_int(s,p):0; }() : 0u;
    const int v_block_bytes      = [&]{ size_t p=0; return find_key(s,"v_block_bytes",p)?parse_int(s,p):(is_polar?82:14); }();
    const int v_blocks_per_token = [&]{ size_t p=0; return find_key(s,"v_blocks_per_token",p)?parse_int(s,p):(is_polar?1:4); }();
    const uint32_t v_token_bytes = (uint32_t)(v_block_bytes * v_blocks_per_token);

    // Parse the `cases` array.
    size_t kpos = 0;
    if (!find_key(s, "cases", kpos)) { std::fprintf(stderr, "fused fixture missing cases\n"); return 2; }
    size_t arr_open, arr_close;
    if (!find_balanced(s, kpos, '[', ']', arr_open, arr_close)) { std::fprintf(stderr, "fused fixture malformed cases\n"); return 2; }
    const std::string body = s.substr(arr_open + 1, arr_close - arr_open - 1);
    std::vector<FusedCase> cases;
    for (const std::string & obj : split_object_array(body)) {
        FusedCase c;
        c.n_heads      = obj_int(obj, "n_heads");
        c.n_kv_heads   = obj_int(obj, "n_kv_heads");
        c.n_kv         = obj_int(obj, "n_kv");
        c.causal       = obj_int(obj, "causal", 0);
        c.q_pos_base   = obj_int(obj, "q_pos_base", 0);
        c.q_sketch     = obj_floats(obj, "q_sketch");
        c.k_blocks     = obj_bytes(obj, "k_blocks");
        c.v_blocks     = obj_bytes(obj, "v_blocks");
        c.expected_out = obj_floats(obj, "expected_out");
        cases.push_back(std::move(c));
    }
    if (cases.empty()) { std::fprintf(stderr, "fused fixture: empty cases\n"); return 2; }

    std::printf("[metal_verify] kernel=%s (fused-attention, %zu case(s))\n", kernel.c_str(), cases.size());

    NSError * err = nil;
    id<MTLLibrary> lib = [device newLibraryWithSource:src options:nil error:&err];
    if (!lib) { std::fprintf(stderr, "metal compile: %s\n", [[err localizedDescription] UTF8String]); return 1; }
    id<MTLFunction> fn = [lib newFunctionWithName:[NSString stringWithUTF8String:kernel_name]];
    if (!fn) { std::fprintf(stderr, "kernel %s not in shader\n", kernel_name); return 1; }
    id<MTLComputePipelineState> pso = [device newComputePipelineStateWithFunction:fn error:&err];
    if (!pso) { std::fprintf(stderr, "pipeline: %s\n", [[err localizedDescription] UTF8String]); return 1; }
    id<MTLCommandQueue> queue = [device newCommandQueue];

    int total_fail = 0, total_n = 0; float global_max = 0.0f;
    for (size_t ci = 0; ci < cases.size(); ++ci) {
        const FusedCase & c = cases[ci];
        if ((int)c.q_sketch.size() != c.n_heads * 256) { std::fprintf(stderr, "case %zu q_sketch mismatch\n", ci); return 2; }
        if ((int)c.k_blocks.size() != c.n_kv_heads * c.n_kv * 34) { std::fprintf(stderr, "case %zu k_blocks mismatch\n", ci); return 2; }
        if ((uint32_t)c.v_blocks.size() != (uint32_t)c.n_kv_heads * (uint32_t)c.n_kv * v_token_bytes) { std::fprintf(stderr, "case %zu v_blocks mismatch\n", ci); return 2; }
        if ((int)c.expected_out.size() != c.n_heads * 128) { std::fprintf(stderr, "case %zu expected_out mismatch\n", ci); return 2; }

        // Pad K/V buffers so the shader's float4 / out-of-range tail reads stay in-bounds.
        std::vector<uint8_t> kpad(c.k_blocks.size() + 16, 0); std::memcpy(kpad.data(), c.k_blocks.data(), c.k_blocks.size());
        std::vector<uint8_t> vpad(c.v_blocks.size() + 16, 0); std::memcpy(vpad.data(), c.v_blocks.data(), c.v_blocks.size());

        id<MTLBuffer> q_buf = [device newBufferWithBytes:c.q_sketch.data() length:c.q_sketch.size()*sizeof(float) options:MTLResourceStorageModeShared];
        id<MTLBuffer> k_buf = [device newBufferWithBytes:kpad.data() length:kpad.size() options:MTLResourceStorageModeShared];
        id<MTLBuffer> v_buf = [device newBufferWithBytes:vpad.data() length:vpad.size() options:MTLResourceStorageModeShared];
        id<MTLBuffer> o_buf = [device newBufferWithLength:c.expected_out.size()*sizeof(float) options:MTLResourceStorageModeShared];
        std::memset([o_buf contents], 0, [o_buf length]);

        FusedAttnArgs args{};
        args.head_dim    = 128;
        args.proj_dim    = 256;
        args.n_heads     = (uint32_t)c.n_heads;
        args.n_kv_heads  = (uint32_t)c.n_kv_heads;
        args.n_q_pos     = 1;
        args.n_kv        = (uint32_t)c.n_kv;
        args.kv_tile     = 0;
        args.v_use_qjl   = use_qjl;
        args.scale       = sm_scale_v;
        args.causal      = (uint32_t)c.causal;
        args.q_pos_base  = (uint32_t)c.q_pos_base;

        id<MTLCommandBuffer> cmd = [queue commandBuffer];
        id<MTLComputeCommandEncoder> enc = [cmd computeCommandEncoder];
        [enc setComputePipelineState:pso];
        [enc setBuffer:q_buf offset:0 atIndex:0];
        [enc setBuffer:k_buf offset:0 atIndex:1];
        [enc setBuffer:v_buf offset:0 atIndex:2];
        [enc setBuffer:o_buf offset:0 atIndex:3];
        [enc setBytes:&args length:sizeof(args) atIndex:4];
        [enc dispatchThreadgroups:MTLSizeMake((NSUInteger)c.n_heads, 1, 1) threadsPerThreadgroup:MTLSizeMake(32, 1, 1)];
        [enc endEncoding];
        [cmd commit];
        [cmd waitUntilCompleted];

        const float * out = (const float *)[o_buf contents];
        int fail = 0; float max_diff = 0.0f;
        const int n = (int)c.expected_out.size();
        for (int i = 0; i < n; i++) {
            float diff = std::fabs(out[i] - c.expected_out[i]);
            if (diff > max_diff) max_diff = diff;
            if (diff >= tol) { fail++; if (fail <= 8) std::printf("    case %zu i=%d expected=%+.6f got=%+.6f diff=%.3e FAIL\n", ci, i, (double)c.expected_out[i], (double)out[i], (double)diff); }
        }
        std::printf("  case %zu (n_heads=%d n_kv_heads=%d n_kv=%d causal=%d q_pos_base=%d): %s — %d/%d passed (max_diff=%.3e)\n",
                    ci, c.n_heads, c.n_kv_heads, c.n_kv, c.causal, c.q_pos_base,
                    fail == 0 ? "PASS" : "FAIL", n - fail, n, (double)max_diff);
        if (max_diff > global_max) global_max = max_diff;
        total_fail += fail; total_n += n;
    }
    std::printf("[metal_verify] %s — %d/%d outputs passed across %zu case(s) (tol=%.0e, max_diff=%.3e)\n",
                total_fail == 0 ? "PASS" : "FAIL", total_n - total_fail, total_n, cases.size(), (double)tol, (double)global_max);
    return total_fail == 0 ? 0 : 1;
}

// =================== Polar pre-Hadamard-query score-ABI runner ===================
// Verifies kernel_attn_score_q4_polar_preht_f32(_multi) against polar_preht.json:
// dispatch n_kv (one block per token, one query head), bind H*q (the fixture's
// `hq`, or hadamard128(q) if absent), compare both use_qjl=0 (k_blocks /
// expected_scores) and use_qjl=1 (k_blocks_qjl / expected_scores_qjl).

static int run_polar_preht(id<MTLDevice> device, NSString * src,
                           const char * kernel_name, const Fixture & fx, float tol, int multi_n) {
    if (fx.head_dim != 128) { std::fprintf(stderr, "polar_preht: head_dim must be 128\n"); return 2; }
    std::vector<float> hq = fx.hq;
    if (hq.size() != 128) {
        if (fx.q.size() != 128) { std::fprintf(stderr, "polar_preht: need hq[128] or q[128]\n"); return 2; }
        hq = fx.q; hadamard128_inplace(hq);
    }
    const int n_rows = fx.n_rows;
    if ((int)fx.k_blocks.size() != n_rows * 82) { std::fprintf(stderr, "polar_preht: k_blocks size mismatch\n"); return 2; }
    if ((int)fx.expected_scores.size() != n_rows) { std::fprintf(stderr, "polar_preht: expected_scores size mismatch\n"); return 2; }
    const bool has_qjl = ((int)fx.k_blocks_qjl.size() == n_rows * 82 && (int)fx.expected_scores_qjl.size() == n_rows);

    NSError * err = nil;
    id<MTLLibrary> lib = [device newLibraryWithSource:src options:nil error:&err];
    if (!lib) { std::fprintf(stderr, "metal compile: %s\n", [[err localizedDescription] UTF8String]); return 1; }
    id<MTLFunction> fn = [lib newFunctionWithName:[NSString stringWithUTF8String:kernel_name]];
    if (!fn) { std::fprintf(stderr, "kernel %s not in shader\n", kernel_name); return 1; }
    id<MTLComputePipelineState> pso = [device newComputePipelineStateWithFunction:fn error:&err];
    if (!pso) { std::fprintf(stderr, "pipeline: %s\n", [[err localizedDescription] UTF8String]); return 1; }
    id<MTLCommandQueue> queue = [device newCommandQueue];
    const bool is_multi = std::strstr(kernel_name, "_multi") != nullptr;
    if (is_multi && multi_n <= 0) multi_n = 1;

    id<MTLBuffer> q_buf = [device newBufferWithBytes:hq.data() length:hq.size()*sizeof(float) options:MTLResourceStorageModeShared];

    auto run_one = [&](const std::vector<uint8_t> & kblocks, const std::vector<float> & expected, uint32_t use_qjl, const char * tag) -> int {
        std::vector<uint8_t> kpad(kblocks.size() + 16, 0); std::memcpy(kpad.data(), kblocks.data(), kblocks.size());
        id<MTLBuffer> k_buf = [device newBufferWithBytes:kpad.data() length:kpad.size() options:MTLResourceStorageModeShared];
        id<MTLBuffer> y_buf = [device newBufferWithLength:n_rows*sizeof(float) options:MTLResourceStorageModeShared];
        std::memset([y_buf contents], 0, [y_buf length]);
        id<MTLCommandBuffer> cmd = [queue commandBuffer];
        id<MTLComputeCommandEncoder> enc = [cmd computeCommandEncoder];
        [enc setComputePipelineState:pso];
        [enc setBuffer:q_buf offset:0 atIndex:0];
        [enc setBuffer:k_buf offset:0 atIndex:1];
        [enc setBuffer:y_buf offset:0 atIndex:2];
        MTLSize grid;
        if (is_multi) {
            struct { uint32_t head_dim, n_kv, kv_stride_blocks, q_head, head_offset_bytes, use_qjl, blocks_per_threadgroup; } a{};
            a.head_dim = 128; a.n_kv = (uint32_t)n_rows; a.kv_stride_blocks = 1; a.q_head = 0;
            a.head_offset_bytes = 0; a.use_qjl = use_qjl; a.blocks_per_threadgroup = (uint32_t)multi_n;
            [enc setBytes:&a length:sizeof(a) atIndex:3];
            NSUInteger g = ((NSUInteger)n_rows + (NSUInteger)multi_n - 1) / (NSUInteger)multi_n;
            grid = MTLSizeMake(g, 1, 1);
        } else {
            PolarScoreArgs a{}; a.head_dim = 128; a.n_kv = (uint32_t)n_rows; a.kv_stride_blocks = 1;
            a.q_head = 0; a.head_offset_bytes = 0; a.use_qjl = use_qjl;
            [enc setBytes:&a length:sizeof(a) atIndex:3];
            grid = MTLSizeMake((NSUInteger)n_rows, 1, 1);
        }
        [enc dispatchThreadgroups:grid threadsPerThreadgroup:MTLSizeMake(32, 1, 1)];
        [enc endEncoding];
        [cmd commit];
        [cmd waitUntilCompleted];
        const float * out = (const float *)[y_buf contents];
        int fail = 0; float max_diff = 0.0f;
        for (int i = 0; i < n_rows; i++) {
            float diff = std::fabs(out[i] - expected[i]);
            if (diff > max_diff) max_diff = diff;
            if (diff >= tol) { fail++; std::printf("  [%s] i=%d expected=%+.6f got=%+.6f diff=%.3e FAIL\n", tag, i, (double)expected[i], (double)out[i], (double)diff); }
        }
        std::printf("[metal_verify] polar_preht/%s — %d/%d passed (tol=%.0e, max_diff=%.3e)\n", tag, n_rows - fail, n_rows, (double)tol, (double)max_diff);
        return fail;
    };

    int fail = run_one(fx.k_blocks, fx.expected_scores, 0u, "use_qjl=0");
    if (has_qjl) fail += run_one(fx.k_blocks_qjl, fx.expected_scores_qjl, 1u, "use_qjl=1");
    return fail == 0 ? 0 : 1;
}

} // namespace

int main(int argc, const char * argv[]) {
    if (argc < 4) {
        std::fprintf(stderr, "usage: %s <shader.metal> <kernel_name> <fixture.json> [tol=1e-3] [--multi N]\n", argv[0]);
        return 2;
    }
    const char * metal_path  = argv[1];
    const char * kernel_name = argv[2];
    const char * fx_path     = argv[3];
    const bool kernel_uses_preht = std::strstr(kernel_name, "preht") != nullptr;
    float tol = 1e-3f;
    int multi_n = 0;
    for (int i = 4; i < argc; i++) {
        if (std::strcmp(argv[i], "--multi") == 0 && i + 1 < argc) multi_n = std::atoi(argv[++i]);
        else if (argv[i][0] != '-') tol = std::strtof(argv[i], nullptr);
    }

    Fixture fx = load_fixture(fx_path);

    @autoreleasepool {
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (!device) { std::fprintf(stderr, "no Metal device\n"); return 1; }
        NSString * src = [NSString stringWithContentsOfFile:[NSString stringWithUTF8String:metal_path]
                                                  encoding:NSUTF8StringEncoding error:nil];
        if (!src) { std::fprintf(stderr, "cannot read %s\n", metal_path); return 1; }

        // --- Route the new fixture shapes to dedicated runners. ---
        if (fx.kernel == "fused_attn_qjl_tbq" || fx.kernel == "fused_attn_qjl_polar") {
            return run_fused_attn(device, src, kernel_name, fx_path, tol);
        }
        if (fx.kernel == "polar_preht" && kernel_uses_preht) {
            return run_polar_preht(device, src, kernel_name, fx, tol, multi_n);
        }

        const bool is_turbo3_tcq = (fx.kernel == "turbo3_tcq");
        const bool is_qjl        = (fx.kernel == "qjl");
        const bool is_polar      = (fx.kernel == "polar");
        const bool is_turbo3     = (fx.kernel == "turbo3");
        const bool is_turbo4     = (fx.kernel == "turbo4");

        if (!is_turbo3 && !is_turbo4 && !is_turbo3_tcq && !is_qjl && !is_polar) {
            std::fprintf(stderr, "[metal_verify] unknown kernel '%s'\n", fx.kernel.c_str());
            return 2;
        }

        int n_outputs = is_qjl   ? (fx.n_heads * fx.n_tokens)
                      : is_polar ? fx.n_rows
                      :            fx.n_kv;
        if ((int)fx.expected_scores.size() != n_outputs) {
            std::fprintf(stderr, "[metal_verify] fixture expected_scores length mismatch: got %zu, need %d\n",
                         fx.expected_scores.size(), n_outputs);
            return 2;
        }
        std::printf("[metal_verify] kernel=%s outputs=%d\n", fx.kernel.c_str(), n_outputs);

        NSError * err = nil;
        id<MTLLibrary> lib = [device newLibraryWithSource:src options:nil error:&err];
        if (!lib) { std::fprintf(stderr, "metal compile: %s\n", [[err localizedDescription] UTF8String]); return 1; }
        id<MTLFunction> fn = [lib newFunctionWithName:[NSString stringWithUTF8String:kernel_name]];
        if (!fn) { std::fprintf(stderr, "kernel %s not in shader\n", kernel_name); return 1; }
        id<MTLComputePipelineState> pso = [device newComputePipelineStateWithFunction:fn error:&err];
        if (!pso) { std::fprintf(stderr, "pipeline: %s\n", [[err localizedDescription] UTF8String]); return 1; }

        id<MTLBuffer> k_buf = [device newBufferWithBytes:fx.k_blocks.data() length:fx.k_blocks.size() options:MTLResourceStorageModeShared];
        id<MTLBuffer> scores_buf = [device newBufferWithLength:n_outputs * sizeof(float) options:MTLResourceStorageModeShared];
        std::memset([scores_buf contents], 0, [scores_buf length]);

        id<MTLCommandQueue> queue = [device newCommandQueue];
        id<MTLCommandBuffer> cmd = [queue commandBuffer];
        id<MTLComputeCommandEncoder> enc = [cmd computeCommandEncoder];
        [enc setComputePipelineState:pso];

        MTLSize tg, grid;

        if (is_turbo3 || is_turbo4 || is_turbo3_tcq) {
            id<MTLBuffer> q_buf = [device newBufferWithBytes:fx.q.data() length:fx.q.size() * sizeof(float) options:MTLResourceStorageModeShared];
            [enc setBuffer:q_buf offset:0 atIndex:0];
            [enc setBuffer:k_buf offset:0 atIndex:1];
            [enc setBuffer:scores_buf offset:0 atIndex:2];
            if (multi_n > 0) {
                TurboArgsMulti args{};
                args.head_dim = (uint32_t)fx.head_dim; args.n_kv = (uint32_t)fx.n_kv;
                args.kv_stride_blocks = (uint32_t)fx.blocks_per_kv; args.q_head = 0; args.head_offset_bytes = 0;
                args.blocks_per_threadgroup = (uint32_t)multi_n;
                if (is_turbo3_tcq) {
                    id<MTLBuffer> cb_buf = [device newBufferWithBytes:ELIZA_TURBO3_TCQ_CODEBOOK length:512 * sizeof(float) options:MTLResourceStorageModeShared];
                    [enc setBuffer:cb_buf offset:0 atIndex:3];
                    [enc setBytes:&args length:sizeof(args) atIndex:4];
                } else {
                    [enc setBytes:&args length:sizeof(args) atIndex:3];
                }
                tg = MTLSizeMake(32, 1, 1);
                NSUInteger n_groups = ((NSUInteger)fx.n_kv + (NSUInteger)multi_n - 1) / (NSUInteger)multi_n;
                grid = MTLSizeMake(n_groups, 1, 1);
            } else {
                TurboArgs args{};
                args.head_dim = (uint32_t)fx.head_dim; args.n_kv = (uint32_t)fx.n_kv;
                args.kv_stride_blocks = (uint32_t)fx.blocks_per_kv; args.q_head = 0; args.head_offset_bytes = 0;
                if (is_turbo3_tcq) {
                    id<MTLBuffer> cb_buf = [device newBufferWithBytes:ELIZA_TURBO3_TCQ_CODEBOOK length:512 * sizeof(float) options:MTLResourceStorageModeShared];
                    [enc setBuffer:cb_buf offset:0 atIndex:3];
                    [enc setBytes:&args length:sizeof(args) atIndex:4];
                } else {
                    [enc setBytes:&args length:sizeof(args) atIndex:3];
                }
                tg = MTLSizeMake(32, 1, 1);
                grid = MTLSizeMake((NSUInteger)fx.n_kv, 1, 1);
            }
        } else if (is_qjl) {
            id<MTLBuffer> qs_buf = [device newBufferWithBytes:fx.q_sketch.data() length:fx.q_sketch.size() * sizeof(float) options:MTLResourceStorageModeShared];
            [enc setBuffer:qs_buf offset:0 atIndex:0];
            [enc setBuffer:k_buf offset:0 atIndex:1];
            [enc setBuffer:scores_buf offset:0 atIndex:2];
            if (multi_n > 0) {
                QjlScoreArgsMulti args{};
                args.n_heads = (uint32_t)fx.n_heads; args.n_kv_heads = (uint32_t)fx.n_kv_heads;
                args.n_tokens = (uint32_t)fx.n_tokens; args.proj_dim = (uint32_t)fx.proj_dim;
                args.tokens_per_threadgroup = (uint32_t)multi_n;
                [enc setBytes:&args length:sizeof(args) atIndex:3];
                tg = MTLSizeMake(32, 1, 1);
                NSUInteger n_groups = ((NSUInteger)fx.n_tokens + (NSUInteger)multi_n - 1) / (NSUInteger)multi_n;
                grid = MTLSizeMake((NSUInteger)fx.n_heads, n_groups, 1);
            } else {
                QjlScoreArgs args{};
                args.n_heads = (uint32_t)fx.n_heads; args.n_kv_heads = (uint32_t)fx.n_kv_heads;
                args.n_tokens = (uint32_t)fx.n_tokens; args.proj_dim = (uint32_t)fx.proj_dim;
                [enc setBytes:&args length:sizeof(args) atIndex:3];
                tg = MTLSizeMake(32, 1, 1);
                grid = MTLSizeMake((NSUInteger)fx.n_heads, (NSUInteger)fx.n_tokens, 1);
            }
        } else if (is_polar) {
            std::vector<float> q_buf_data = fx.q;
            if (kernel_uses_preht) {
                if (q_buf_data.size() != 128) { std::fprintf(stderr, "[metal_verify] preht polar path requires q length 128\n"); return 2; }
                hadamard128_inplace(q_buf_data);
            }
            id<MTLBuffer> q_buf = [device newBufferWithBytes:q_buf_data.data() length:q_buf_data.size() * sizeof(float) options:MTLResourceStorageModeShared];
            PolarMvArgs args{}; args.n_rows = (uint32_t)fx.n_rows; args.head_dim = (uint32_t)fx.head_dim; args.use_qjl = (uint32_t)fx.use_qjl;
            [enc setBuffer:k_buf offset:0 atIndex:0];
            [enc setBuffer:q_buf offset:0 atIndex:1];
            [enc setBuffer:scores_buf offset:0 atIndex:2];
            [enc setBytes:&args length:sizeof(args) atIndex:3];
            tg = MTLSizeMake(32, 1, 1);
            grid = MTLSizeMake((NSUInteger)fx.n_rows, 1, 1);
        }

        [enc dispatchThreadgroups:grid threadsPerThreadgroup:tg];
        [enc endEncoding];
        [cmd commit];
        [cmd waitUntilCompleted];

        const float * out = (const float *)[scores_buf contents];
        int failures = 0;
        for (int i = 0; i < n_outputs; i++) {
            float exp_v = fx.expected_scores[i];
            float diff = std::fabs(out[i] - exp_v);
            const char * tag = (diff < tol) ? "PASS" : "FAIL";
            std::printf("  i=%d expected=%+.6f got=%+.6f diff=%.3e %s\n", i, (double)exp_v, (double)out[i], (double)diff, tag);
            if (diff >= tol) failures++;
        }
        std::printf("[metal_verify] %s — %d/%d passed (tol=%.0e)\n",
                    failures == 0 ? "PASS" : "FAIL", n_outputs - failures, n_outputs, (double)tol);
        return failures == 0 ? 0 : 1;
    }
}
