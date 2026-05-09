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
    int head_dim;
    int n_kv;
    int block_bytes;
    int blocks_per_kv;
    std::vector<float> q;
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
    find_key(s, "kernel", pos);          fx.kernel = parse_string(s, pos);
    find_key(s, "head_dim", pos);        fx.head_dim = parse_int(s, pos);
    find_key(s, "n_kv", pos);            fx.n_kv = parse_int(s, pos);
    find_key(s, "block_bytes", pos);     fx.block_bytes = parse_int(s, pos);
    find_key(s, "blocks_per_kv", pos);   fx.blocks_per_kv = parse_int(s, pos);
    find_key(s, "q", pos);               fx.q = parse_float_array(s, pos);
    find_key(s, "k_blocks", pos);        fx.k_blocks = parse_byte_array(s, pos);
    find_key(s, "expected_scores", pos); fx.expected_scores = parse_float_array(s, pos);
    return fx;
}

struct PushArgs {
    uint32_t head_dim;
    uint32_t n_kv;
    uint32_t kv_stride_blocks;
    uint32_t q_head;
    uint32_t head_offset_bytes;
};

} // namespace

int main(int argc, const char * argv[]) {
    if (argc < 4) {
        std::fprintf(stderr, "usage: %s <shader.metal> <kernel_name> <fixture.json> [tol=1e-3]\n", argv[0]);
        return 2;
    }
    const char * metal_path  = argv[1];
    const char * kernel_name = argv[2];
    const char * fx_path     = argv[3];
    float tol = argc >= 5 ? std::strtof(argv[4], nullptr) : 1e-3f;

    Fixture fx = load_fixture(fx_path);
    bool needs_codebook = (fx.kernel == "turbo3_tcq");
    std::printf("[metal_verify] kernel=%s n_kv=%d head_dim=%d\n",
                fx.kernel.c_str(), fx.n_kv, fx.head_dim);

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

        id<MTLBuffer> q_buf = [device newBufferWithBytes:fx.q.data()
                                                  length:fx.q.size() * sizeof(float)
                                                 options:MTLResourceStorageModeShared];
        id<MTLBuffer> k_buf = [device newBufferWithBytes:fx.k_blocks.data()
                                                  length:fx.k_blocks.size()
                                                 options:MTLResourceStorageModeShared];
        id<MTLBuffer> scores_buf = [device newBufferWithLength:fx.n_kv * sizeof(float)
                                                       options:MTLResourceStorageModeShared];
        std::memset([scores_buf contents], 0, [scores_buf length]);

        id<MTLBuffer> cb_buf = nil;
        if (needs_codebook) {
            cb_buf = [device newBufferWithBytes:ELIZA_TURBO3_TCQ_CODEBOOK
                                         length:512 * sizeof(float)
                                        options:MTLResourceStorageModeShared];
        }

        PushArgs args{};
        args.head_dim = (uint32_t)fx.head_dim;
        args.n_kv = (uint32_t)fx.n_kv;
        args.kv_stride_blocks = (uint32_t)fx.blocks_per_kv;
        args.q_head = 0;
        args.head_offset_bytes = 0;

        id<MTLCommandQueue> queue = [device newCommandQueue];
        id<MTLCommandBuffer> cmd = [queue commandBuffer];
        id<MTLComputeCommandEncoder> enc = [cmd computeCommandEncoder];
        [enc setComputePipelineState:pso];
        [enc setBuffer:q_buf offset:0 atIndex:0];
        [enc setBuffer:k_buf offset:0 atIndex:1];
        [enc setBuffer:scores_buf offset:0 atIndex:2];
        if (needs_codebook) {
            [enc setBuffer:cb_buf offset:0 atIndex:3];
            [enc setBytes:&args length:sizeof(args) atIndex:4];
        } else {
            [enc setBytes:&args length:sizeof(args) atIndex:3];
        }
        MTLSize tg = MTLSizeMake(32, 1, 1);
        MTLSize grid = MTLSizeMake((NSUInteger)fx.n_kv, 1, 1);
        [enc dispatchThreadgroups:grid threadsPerThreadgroup:tg];
        [enc endEncoding];
        [cmd commit];
        [cmd waitUntilCompleted];

        const float * out = (const float *)[scores_buf contents];
        int failures = 0;
        for (int i = 0; i < fx.n_kv; i++) {
            float diff = std::fabs(out[i] - fx.expected_scores[i]);
            const char * tag = (diff < tol) ? "PASS" : "FAIL";
            std::printf("  kv=%d expected=%+.6f got=%+.6f diff=%.3e %s\n",
                        i, (double)fx.expected_scores[i], (double)out[i], (double)diff, tag);
            if (diff >= tol) failures++;
        }

        std::printf("[metal_verify] %s — %d/%d passed (tol=%.0e)\n",
                    failures == 0 ? "PASS" : "FAIL",
                    fx.n_kv - failures, fx.n_kv, (double)tol);
        return failures == 0 ? 0 : 1;
    }
}
