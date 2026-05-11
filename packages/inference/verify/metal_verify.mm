// DRAFT: NOT VALIDATED ON HARDWARE — see kernels/README.md
//
// Host-side Metal verification harness for the turbo3 / turbo4 / turbo3_tcq
// shaders. Loads the JSON fixture written by gen_fixture, JIT-compiles the
// .metal source via MTLDevice.newLibraryWithSource, dispatches the relevant
// kernel function, and compares scalar scores against the reference
// (tolerance: 1e-3 absolute).
//
// Build (macOS only):
//     make metal
//
// Run:
//     ./metal_verify ../metal/turbo4.metal kernel_turbo4_dot fixtures/turbo4.json

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

    std::vector<float> q;        // turbo: query; polar: q activation chunk
    std::vector<float> q_sketch; // qjl
    std::vector<uint8_t> k_blocks;
    std::vector<float> expected_scores;
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

// Look up a key from the start of the document; returns false if absent so
// optional fields don't blow up the parser.
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
    if (find_key_opt(s, "q_sketch", pos))       fx.q_sketch = parse_float_array(s, pos);
    if (find_key_opt(s, "k_blocks", pos))       fx.k_blocks = parse_byte_array(s, pos);
    if (find_key_opt(s, "expected_scores", pos)) fx.expected_scores = parse_float_array(s, pos);
    return fx;
}

// Argument structs — must be ABI-compatible with the Metal-side definitions
// in metal/{turbo3,turbo4,turbo3_tcq,qjl,polar}.metal.

struct TurboArgs {
    uint32_t head_dim;
    uint32_t n_kv;
    uint32_t kv_stride_blocks;
    uint32_t q_head;
    uint32_t head_offset_bytes;
};

struct TurboArgsMulti {
    uint32_t head_dim;
    uint32_t n_kv;
    uint32_t kv_stride_blocks;
    uint32_t q_head;
    uint32_t head_offset_bytes;
    uint32_t blocks_per_threadgroup;
};

struct QjlScoreArgs {
    uint32_t n_heads;
    uint32_t n_kv_heads;
    uint32_t n_tokens;
    uint32_t proj_dim;
};

struct QjlScoreArgsMulti {
    uint32_t n_heads;
    uint32_t n_kv_heads;
    uint32_t n_tokens;
    uint32_t proj_dim;
    uint32_t tokens_per_threadgroup;
};

struct PolarMvArgs {
    uint32_t n_rows;
    uint32_t head_dim;
    uint32_t use_qjl;
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
    int multi_n = 0;        // 0 = single-block dispatch (legacy), >0 = multi-block
    for (int i = 4; i < argc; i++) {
        if (std::strcmp(argv[i], "--multi") == 0 && i + 1 < argc) {
            multi_n = std::atoi(argv[++i]);
        } else if (argv[i][0] != '-') {
            tol = std::strtof(argv[i], nullptr);
        }
    }

    Fixture fx = load_fixture(fx_path);
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
        std::fprintf(stderr,
                     "[metal_verify] fixture expected_scores length mismatch: got %zu, need %d\n",
                     fx.expected_scores.size(), n_outputs);
        return 2;
    }
    std::printf("[metal_verify] kernel=%s outputs=%d\n", fx.kernel.c_str(), n_outputs);

    @autoreleasepool {
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (!device) { std::fprintf(stderr, "no Metal device\n"); return 1; }

        NSString * src = [NSString stringWithContentsOfFile:[NSString stringWithUTF8String:metal_path]
                                                  encoding:NSUTF8StringEncoding error:nil];
        if (!src) { std::fprintf(stderr, "cannot read %s\n", metal_path); return 1; }

        NSError * err = nil;
        id<MTLLibrary> lib = [device newLibraryWithSource:src options:nil error:&err];
        if (!lib) {
            std::fprintf(stderr, "metal compile: %s\n", [[err localizedDescription] UTF8String]);
            return 1;
        }
        id<MTLFunction> fn = [lib newFunctionWithName:[NSString stringWithUTF8String:kernel_name]];
        if (!fn) { std::fprintf(stderr, "kernel %s not in shader\n", kernel_name); return 1; }
        id<MTLComputePipelineState> pso = [device newComputePipelineStateWithFunction:fn error:&err];
        if (!pso) {
            std::fprintf(stderr, "pipeline: %s\n", [[err localizedDescription] UTF8String]);
            return 1;
        }

        // Common buffers
        id<MTLBuffer> k_buf = [device newBufferWithBytes:fx.k_blocks.data()
                                                  length:fx.k_blocks.size()
                                                 options:MTLResourceStorageModeShared];
        id<MTLBuffer> scores_buf = [device newBufferWithLength:n_outputs * sizeof(float)
                                                       options:MTLResourceStorageModeShared];
        std::memset([scores_buf contents], 0, [scores_buf length]);

        id<MTLCommandQueue> queue = [device newCommandQueue];
        id<MTLCommandBuffer> cmd = [queue commandBuffer];
        id<MTLComputeCommandEncoder> enc = [cmd computeCommandEncoder];
        [enc setComputePipelineState:pso];

        MTLSize tg, grid;

        if (is_turbo3 || is_turbo4 || is_turbo3_tcq) {
            id<MTLBuffer> q_buf = [device newBufferWithBytes:fx.q.data()
                                                      length:fx.q.size() * sizeof(float)
                                                     options:MTLResourceStorageModeShared];

            [enc setBuffer:q_buf offset:0 atIndex:0];
            [enc setBuffer:k_buf offset:0 atIndex:1];
            [enc setBuffer:scores_buf offset:0 atIndex:2];

            if (multi_n > 0) {
                TurboArgsMulti args{};
                args.head_dim               = (uint32_t)fx.head_dim;
                args.n_kv                   = (uint32_t)fx.n_kv;
                args.kv_stride_blocks       = (uint32_t)fx.blocks_per_kv;
                args.q_head                 = 0;
                args.head_offset_bytes      = 0;
                args.blocks_per_threadgroup = (uint32_t)multi_n;
                if (is_turbo3_tcq) {
                    id<MTLBuffer> cb_buf =
                        [device newBufferWithBytes:ELIZA_TURBO3_TCQ_CODEBOOK
                                            length:512 * sizeof(float)
                                           options:MTLResourceStorageModeShared];
                    [enc setBuffer:cb_buf offset:0 atIndex:3];
                    [enc setBytes:&args length:sizeof(args) atIndex:4];
                } else {
                    [enc setBytes:&args length:sizeof(args) atIndex:3];
                }
                tg   = MTLSizeMake(32, 1, 1);
                NSUInteger n_groups = ((NSUInteger)fx.n_kv + (NSUInteger)multi_n - 1) / (NSUInteger)multi_n;
                grid = MTLSizeMake(n_groups, 1, 1);
            } else {
                TurboArgs args{};
                args.head_dim          = (uint32_t)fx.head_dim;
                args.n_kv              = (uint32_t)fx.n_kv;
                args.kv_stride_blocks  = (uint32_t)fx.blocks_per_kv;
                args.q_head            = 0;
                args.head_offset_bytes = 0;
                if (is_turbo3_tcq) {
                    id<MTLBuffer> cb_buf =
                        [device newBufferWithBytes:ELIZA_TURBO3_TCQ_CODEBOOK
                                            length:512 * sizeof(float)
                                           options:MTLResourceStorageModeShared];
                    [enc setBuffer:cb_buf offset:0 atIndex:3];
                    [enc setBytes:&args length:sizeof(args) atIndex:4];
                } else {
                    [enc setBytes:&args length:sizeof(args) atIndex:3];
                }
                tg   = MTLSizeMake(32, 1, 1);
                grid = MTLSizeMake((NSUInteger)fx.n_kv, 1, 1);
            }
        } else if (is_qjl) {
            id<MTLBuffer> qs_buf = [device newBufferWithBytes:fx.q_sketch.data()
                                                       length:fx.q_sketch.size() * sizeof(float)
                                                      options:MTLResourceStorageModeShared];
            [enc setBuffer:qs_buf offset:0 atIndex:0];
            [enc setBuffer:k_buf offset:0 atIndex:1];
            [enc setBuffer:scores_buf offset:0 atIndex:2];
            if (multi_n > 0) {
                QjlScoreArgsMulti args{};
                args.n_heads                = (uint32_t)fx.n_heads;
                args.n_kv_heads             = (uint32_t)fx.n_kv_heads;
                args.n_tokens               = (uint32_t)fx.n_tokens;
                args.proj_dim               = (uint32_t)fx.proj_dim;
                args.tokens_per_threadgroup = (uint32_t)multi_n;
                [enc setBytes:&args length:sizeof(args) atIndex:3];
                tg = MTLSizeMake(32, 1, 1);
                NSUInteger n_groups = ((NSUInteger)fx.n_tokens + (NSUInteger)multi_n - 1) / (NSUInteger)multi_n;
                grid = MTLSizeMake((NSUInteger)fx.n_heads, n_groups, 1);
            } else {
                QjlScoreArgs args{};
                args.n_heads    = (uint32_t)fx.n_heads;
                args.n_kv_heads = (uint32_t)fx.n_kv_heads;
                args.n_tokens   = (uint32_t)fx.n_tokens;
                args.proj_dim   = (uint32_t)fx.proj_dim;
                [enc setBytes:&args length:sizeof(args) atIndex:3];
                tg   = MTLSizeMake(32, 1, 1);
                grid = MTLSizeMake((NSUInteger)fx.n_heads, (NSUInteger)fx.n_tokens, 1);
            }
        } else if (is_polar) {
            std::vector<float> q_buf_data = fx.q;
            if (kernel_uses_preht) {
                if (q_buf_data.size() != 128) {
                    std::fprintf(stderr, "[metal_verify] preht polar path requires q length 128\n");
                    return 2;
                }
                hadamard128_inplace(q_buf_data);
            }
            id<MTLBuffer> q_buf = [device newBufferWithBytes:q_buf_data.data()
                                                      length:q_buf_data.size() * sizeof(float)
                                                     options:MTLResourceStorageModeShared];
            PolarMvArgs args{};
            args.n_rows   = (uint32_t)fx.n_rows;
            args.head_dim = (uint32_t)fx.head_dim;
            args.use_qjl  = (uint32_t)fx.use_qjl;
            [enc setBuffer:k_buf offset:0 atIndex:0];
            [enc setBuffer:q_buf offset:0 atIndex:1];
            [enc setBuffer:scores_buf offset:0 atIndex:2];
            [enc setBytes:&args length:sizeof(args) atIndex:3];
            tg   = MTLSizeMake(32, 1, 1);
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
            std::printf("  i=%d expected=%+.6f got=%+.6f diff=%.3e %s\n",
                        i, (double)exp_v, (double)out[i], (double)diff, tag);
            if (diff >= tol) failures++;
        }

        std::printf("[metal_verify] %s — %d/%d passed (tol=%.0e)\n",
                    failures == 0 ? "PASS" : "FAIL",
                    n_outputs - failures, n_outputs, (double)tol);
        return failures == 0 ? 0 : 1;
    }
}
