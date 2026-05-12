#include "ggml.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "ggml-metal.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace {

struct Config {
    int src_w = 48;
    int src_h = 48;
    int dst_w = 92;
    int dst_h = 92;
    int channels = 1152;
    int iters = 1;
    std::string mode = "bilinear-aa";
    std::string out;
    bool run_cpu = true;
    bool require_metal_support = false;
};

struct Graph {
    ggml_context * ctx = nullptr;
    ggml_tensor * src = nullptr;
    ggml_tensor * dst = nullptr;
    ggml_cgraph * gf = nullptr;
};

static const char * usage() {
    return
        "Usage: ./metal_upscale_probe [options]\n"
        "\n"
        "Builds a GGML graph containing one GGML_OP_UPSCALE and probes Metal support.\n"
        "The default shape mirrors Qwen3-VL CLIP warmup: src=[48 48 1152 1], dst=[92 92 1152 1].\n"
        "\n"
        "Options:\n"
        "  --mode nearest|bilinear|bilinear-aa|bicubic  Upscale mode; default bilinear-aa\n"
        "  --src-w N --src-h N --dst-w N --dst-h N       Override spatial shape\n"
        "  --channels N                                 Override channel count\n"
        "  --iters N                                    Benchmark iterations; default 1\n"
        "  --no-cpu                                     Skip CPU fallback timing\n"
        "  --require-metal-support                      Exit non-zero when Metal rejects the op\n"
        "  --out PATH                                   Write JSON report\n"
        "  --help                                      Show this help\n";
}

static bool parse_int_arg(const char * name, const char * value, int * out) {
    char * end = nullptr;
    long parsed = std::strtol(value, &end, 10);
    if (!end || *end != '\0' || parsed <= 0 || parsed > 1'000'000) {
        std::fprintf(stderr, "%s must be a positive integer, got '%s'\n", name, value);
        return false;
    }
    *out = (int) parsed;
    return true;
}

static bool parse_args(int argc, char ** argv, Config * cfg) {
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto next = [&](const char * name) -> const char * {
            if (++i >= argc) {
                std::fprintf(stderr, "missing value for %s\n", name);
                std::exit(2);
            }
            return argv[i];
        };

        if (arg == "--help" || arg == "-h") {
            std::puts(usage());
            std::exit(0);
        } else if (arg == "--mode") {
            cfg->mode = next("--mode");
        } else if (arg == "--src-w") {
            if (!parse_int_arg("--src-w", next("--src-w"), &cfg->src_w)) return false;
        } else if (arg == "--src-h") {
            if (!parse_int_arg("--src-h", next("--src-h"), &cfg->src_h)) return false;
        } else if (arg == "--dst-w") {
            if (!parse_int_arg("--dst-w", next("--dst-w"), &cfg->dst_w)) return false;
        } else if (arg == "--dst-h") {
            if (!parse_int_arg("--dst-h", next("--dst-h"), &cfg->dst_h)) return false;
        } else if (arg == "--channels") {
            if (!parse_int_arg("--channels", next("--channels"), &cfg->channels)) return false;
        } else if (arg == "--iters") {
            if (!parse_int_arg("--iters", next("--iters"), &cfg->iters)) return false;
        } else if (arg == "--out") {
            cfg->out = next("--out");
        } else if (arg == "--no-cpu") {
            cfg->run_cpu = false;
        } else if (arg == "--require-metal-support") {
            cfg->require_metal_support = true;
        } else {
            std::fprintf(stderr, "unknown argument: %s\n", arg.c_str());
            return false;
        }
    }

    return cfg->mode == "nearest" ||
           cfg->mode == "bilinear" ||
           cfg->mode == "bilinear-aa" ||
           cfg->mode == "bicubic";
}

static uint32_t mode_flags(const std::string & mode) {
    if (mode == "nearest") {
        return GGML_SCALE_MODE_NEAREST;
    }
    if (mode == "bilinear") {
        return GGML_SCALE_MODE_BILINEAR;
    }
    if (mode == "bilinear-aa") {
        return GGML_SCALE_MODE_BILINEAR | GGML_SCALE_FLAG_ANTIALIAS;
    }
    if (mode == "bicubic") {
        return GGML_SCALE_MODE_BICUBIC;
    }

    std::fprintf(stderr, "unsupported mode: %s\n", mode.c_str());
    std::exit(2);
}

static const char * mode_label(uint32_t flags) {
    const uint32_t mode = flags & 0xFFu;
    const bool aa = (flags & GGML_SCALE_FLAG_ANTIALIAS) != 0;
    if (mode == GGML_SCALE_MODE_NEAREST) return "nearest";
    if (mode == GGML_SCALE_MODE_BILINEAR && aa) return "bilinear-aa";
    if (mode == GGML_SCALE_MODE_BILINEAR) return "bilinear";
    if (mode == GGML_SCALE_MODE_BICUBIC) return "bicubic";
    return "unknown";
}

static std::vector<float> make_input(const Config & cfg) {
    const size_t n = (size_t) cfg.src_w * cfg.src_h * cfg.channels;
    std::vector<float> input(n);
    for (size_t i = 0; i < n; ++i) {
        input[i] = 0.25f * std::sin((float) i * 0.017f) +
                   0.75f * std::cos((float) i * 0.003f);
    }
    return input;
}

static Graph make_graph(const Config & cfg, uint32_t flags) {
    const size_t meta = 32ull * 1024ull * 1024ull;
    ggml_context * ctx = ggml_init({ meta, nullptr, true });
    if (!ctx) {
        std::fprintf(stderr, "ggml_init failed\n");
        std::exit(1);
    }

    ggml_tensor * src = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, cfg.src_w, cfg.src_h, cfg.channels, 1);
    ggml_tensor * dst = ggml_interpolate(ctx, src, cfg.dst_w, cfg.dst_h, cfg.channels, 1, flags);
    ggml_set_name(src, "upscale_src");
    ggml_set_name(dst, "upscale_dst");
    ggml_cgraph * gf = ggml_new_graph(ctx);
    ggml_build_forward_expand(gf, dst);

    return { ctx, src, dst, gf };
}

static double now_ms() {
    using clock = std::chrono::steady_clock;
    return std::chrono::duration<double, std::milli>(clock::now().time_since_epoch()).count();
}

struct RunResult {
    bool attempted = false;
    bool ok = false;
    int status = -1;
    double avg_ms = 0.0;
    std::vector<float> output;
};

static RunResult run_backend(
        ggml_backend_t backend,
        const Config & cfg,
        uint32_t flags,
        const std::vector<float> & input) {
    RunResult result;
    result.attempted = true;

    Graph g = make_graph(cfg, flags);
    ggml_backend_buffer_t buffer = ggml_backend_alloc_ctx_tensors(g.ctx, backend);
    if (!buffer) {
        std::fprintf(stderr, "ggml_backend_alloc_ctx_tensors failed\n");
        ggml_free(g.ctx);
        return result;
    }

    ggml_backend_tensor_set(g.src, input.data(), 0, input.size() * sizeof(float));

    double total_ms = 0.0;
    int status = (int) GGML_STATUS_SUCCESS;
    for (int i = 0; i < cfg.iters; ++i) {
        const double t0 = now_ms();
        status = (int) ggml_backend_graph_compute(backend, g.gf);
        ggml_backend_synchronize(backend);
        const double t1 = now_ms();
        total_ms += t1 - t0;
        if (status != (int) GGML_STATUS_SUCCESS) {
            break;
        }
    }

    result.status = status;
    result.ok = status == (int) GGML_STATUS_SUCCESS;
    result.avg_ms = total_ms / std::max(1, cfg.iters);
    if (result.ok) {
        result.output.resize((size_t) cfg.dst_w * cfg.dst_h * cfg.channels);
        ggml_backend_tensor_get(g.dst, result.output.data(), 0, result.output.size() * sizeof(float));
    }

    ggml_backend_buffer_free(buffer);
    ggml_free(g.ctx);
    return result;
}

static double max_abs_diff(const std::vector<float> & a, const std::vector<float> & b) {
    if (a.size() != b.size()) return INFINITY;
    double out = 0.0;
    for (size_t i = 0; i < a.size(); ++i) {
        out = std::max(out, (double) std::fabs(a[i] - b[i]));
    }
    return out;
}

static std::string json_report(
        const Config & cfg,
        uint32_t flags,
        bool metal_init_ok,
        bool metal_supports,
        const RunResult & cpu,
        const RunResult & metal,
        double max_diff) {
    char diff_buf[64];
    if (std::isfinite(max_diff)) {
        std::snprintf(diff_buf, sizeof(diff_buf), "%.9g", max_diff);
    } else {
        std::snprintf(diff_buf, sizeof(diff_buf), "null");
    }

    char buf[4096];
    std::snprintf(buf, sizeof(buf),
        "{\n"
        "  \"schemaVersion\": 1,\n"
        "  \"metric\": \"metal_upscale_probe\",\n"
        "  \"shape\": {\n"
        "    \"src\": [%d, %d, %d, 1],\n"
        "    \"dst\": [%d, %d, %d, 1]\n"
        "  },\n"
        "  \"mode\": \"%s\",\n"
        "  \"modeFlags\": %u,\n"
        "  \"metal\": {\n"
        "    \"backendInit\": %s,\n"
        "    \"supportsOp\": %s,\n"
        "    \"attempted\": %s,\n"
        "    \"ok\": %s,\n"
        "    \"status\": %d,\n"
        "    \"avgMs\": %.3f\n"
        "  },\n"
        "  \"cpu\": {\n"
        "    \"attempted\": %s,\n"
        "    \"ok\": %s,\n"
        "    \"status\": %d,\n"
        "    \"avgMs\": %.3f\n"
        "  },\n"
        "  \"comparison\": {\n"
        "    \"metalVsCpuMaxAbsDiff\": %s\n"
        "  },\n"
        "  \"finding\": \"%s\"\n"
        "}\n",
        cfg.src_w, cfg.src_h, cfg.channels,
        cfg.dst_w, cfg.dst_h, cfg.channels,
        mode_label(flags),
        flags,
        metal_init_ok ? "true" : "false",
        metal_supports ? "true" : "false",
        metal.attempted ? "true" : "false",
        metal.ok ? "true" : "false",
        metal.status,
        metal.avg_ms,
        cpu.attempted ? "true" : "false",
        cpu.ok ? "true" : "false",
        cpu.status,
        cpu.avg_ms,
        diff_buf,
        metal_supports
            ? "Metal accepts this UPSCALE op; compare output/timing against CPU."
            : "Metal rejects this UPSCALE op, so GGML scheduler must split it to CPU for CLIP graphs.");
    return std::string(buf);
}

} // namespace

int main(int argc, char ** argv) {
    Config cfg;
    if (!parse_args(argc, argv, &cfg)) {
        std::fputs(usage(), stderr);
        return 2;
    }

    const uint32_t flags = mode_flags(cfg.mode);
    const std::vector<float> input = make_input(cfg);

    ggml_backend_t metal_backend = ggml_backend_metal_init();
    const bool metal_init_ok = metal_backend != nullptr;
    bool metal_supports = false;
    if (metal_backend) {
        Graph support_graph = make_graph(cfg, flags);
        metal_supports = ggml_backend_supports_op(metal_backend, support_graph.dst);
        ggml_free(support_graph.ctx);
    }

    RunResult cpu;
    if (cfg.run_cpu) {
        ggml_backend_t cpu_backend = ggml_backend_cpu_init();
        if (!cpu_backend) {
            std::fprintf(stderr, "ggml_backend_cpu_init failed\n");
        } else {
            ggml_backend_cpu_set_n_threads(cpu_backend, 1);
            cpu = run_backend(cpu_backend, cfg, flags, input);
            ggml_backend_free(cpu_backend);
        }
    }

    RunResult metal;
    if (metal_backend && metal_supports) {
        metal = run_backend(metal_backend, cfg, flags, input);
    }

    double diff = INFINITY;
    if (cpu.ok && metal.ok) {
        diff = max_abs_diff(cpu.output, metal.output);
    }

    if (metal_backend) {
        ggml_backend_free(metal_backend);
    }

    const std::string report = json_report(cfg, flags, metal_init_ok, metal_supports, cpu, metal, diff);
    if (!cfg.out.empty()) {
        std::ofstream out(cfg.out);
        if (!out) {
            std::fprintf(stderr, "cannot write %s\n", cfg.out.c_str());
            return 1;
        }
        out << report;
    }
    std::fputs(report.c_str(), stdout);

    if (cfg.require_metal_support && !metal_supports) {
        return 3;
    }
    return 0;
}
