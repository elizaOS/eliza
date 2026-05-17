// SPDX-License-Identifier: MIT
//
// istft-verify.cpp — Verification harness for GGML_OP_ISTFT.
//
// Generates 10 random (n_fft, hop_length, win_length, T) test cases,
// computes the CPU reference output using the eliza_kokoro::istft_hann
// reference implementation, and compares it against GGML dispatch results.
//
// Run:
//   ./istft-verify [--backend cpu|vulkan|cuda] [--tol 1e-3] [--seed N]
//
// Exits 0 on PASS, 1 on any FAIL.

#define _POSIX_C_SOURCE 199309L

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <ctime>
#include <string>
#include <vector>
#include <random>
#include <algorithm>

// ---------------------------------------------------------------------------
// Inline CPU reference iSTFT (matches kokoro-istft.cpp exactly, no shared
// header dependency so this binary can build stand-alone).
// ---------------------------------------------------------------------------
static std::vector<float> hann_window_ref(int n) {
    std::vector<float> w((size_t) n);
    const double sc = 2.0 * 3.14159265358979323846 / (double) n;
    for (int i = 0; i < n; ++i)
        w[(size_t) i] = (float)(0.5 - 0.5 * std::cos(sc * (double) i));
    return w;
}

static void irdft_frame_ref(const float * re, const float * im, int n_fft, float * out) {
    const int F = n_fft / 2 + 1;
    const double inv_n = 1.0 / (double) n_fft;
    const double pi2   = 2.0 * 3.14159265358979323846;
    for (int t = 0; t < n_fft; ++t) {
        double acc = re[0];
        if ((n_fft & 1) == 0) {
            const double sign = (t & 1) ? -1.0 : 1.0;
            acc += sign * re[F - 1];
        }
        const int ie = F - ((n_fft & 1) == 0 ? 1 : 0);
        for (int f = 1; f < ie; ++f) {
            const double angle = pi2 * (double) f * (double) t * inv_n;
            acc += 2.0 * (re[f] * std::cos(angle) - im[f] * std::sin(angle));
        }
        out[t] = (float)(acc * inv_n);
    }
}

static std::vector<float> istft_ref(
        const std::vector<float> & mag,
        const std::vector<float> & phase,
        int n_fft, int hop_length, int win_length, int n_frames) {
    const int F     = n_fft / 2 + 1;
    const int n_out = (n_frames - 1) * hop_length + win_length;
    std::vector<float> out((size_t) n_out, 0.0f);
    std::vector<float> norm((size_t) n_out, 0.0f);
    auto window = hann_window_ref(win_length);
    std::vector<float> re((size_t) F), im((size_t) F), frame((size_t) n_fft);
    for (int t = 0; t < n_frames; ++t) {
        for (int f = 0; f < F; ++f) {
            const float m = mag  [(size_t)(f * n_frames + t)];
            const float p = phase[(size_t)(f * n_frames + t)];
            re[(size_t) f] = m * std::cos(p);
            im[(size_t) f] = m * std::sin(p);
        }
        irdft_frame_ref(re.data(), im.data(), n_fft, frame.data());
        const int off = t * hop_length;
        for (int k = 0; k < win_length; ++k) {
            const int idx = off + k;
            if (idx >= n_out) break;
            const float w = window[(size_t) k];
            out [(size_t) idx] += frame[(size_t)(k % n_fft)] * w;
            norm[(size_t) idx] += w * w;
        }
    }
    for (int i = 0; i < n_out; ++i)
        if (norm[(size_t) i] > 1e-8f)
            out[(size_t) i] /= norm[(size_t) i];
    return out;
}

// ---------------------------------------------------------------------------
// GGML path
// ---------------------------------------------------------------------------
#include "ggml.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#ifdef GGML_USE_VULKAN
#  include "ggml-vulkan.h"
#endif
#ifdef GGML_USE_CUDA
#  include "ggml-cuda.h"
#endif

static std::vector<float> istft_ggml(
        ggml_backend_t backend,
        const std::vector<float> & mag,
        const std::vector<float> & phase,
        int n_fft, int hop_length, int win_length, int n_frames,
        bool & supported_out) {

    const int F     = n_fft / 2 + 1;
    const int n_out = (n_frames - 1) * hop_length + win_length;
    supported_out = false;

    ggml_init_params ip = {
        /*.mem_size   =*/ 16 * 1024 * 1024,
        /*.mem_buffer =*/ nullptr,
        /*.no_alloc   =*/ true,
    };
    ggml_context * gctx = ggml_init(ip);
    if (!gctx) return {};

    const int64_t ne_mp[4] = { (int64_t) n_frames, (int64_t) F, 2, 1 };
    ggml_tensor * mp = ggml_new_tensor(gctx, GGML_TYPE_F32, 4, ne_mp);
    ggml_tensor * pcm = ggml_istft(gctx, mp, nullptr, n_fft, hop_length, win_length);

    ggml_cgraph * gf = ggml_new_graph_custom(gctx, 64, false);
    ggml_build_forward_expand(gf, pcm);

    ggml_gallocr_t alloc = ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend));
    if (!alloc) { ggml_free(gctx); return {}; }
    if (!ggml_gallocr_alloc_graph(alloc, gf)) {
        ggml_gallocr_free(alloc);
        ggml_free(gctx);
        return {};
    }

    // Pack mag/phase into [T, F, 2] flat.
    const size_t ch_stride = (size_t) F * (size_t) n_frames;
    std::vector<float> mp_data(2 * ch_stride);
    for (int f = 0; f < F; ++f)
        for (int t = 0; t < n_frames; ++t) {
            mp_data[             f * n_frames + t] = mag  [(size_t)(f * n_frames + t)];
            mp_data[ch_stride + f * n_frames + t] = phase[(size_t)(f * n_frames + t)];
        }
    ggml_backend_tensor_set(mp, mp_data.data(), 0, mp_data.size() * sizeof(float));

    if (!ggml_backend_supports_op(backend, pcm)) {
        ggml_gallocr_free(alloc);
        ggml_free(gctx);
        return {};
    }
    supported_out = true;

    ggml_backend_graph_compute(backend, gf);

    std::vector<float> result((size_t) n_out);
    ggml_backend_tensor_get(pcm, result.data(), 0, (size_t) n_out * sizeof(float));

    ggml_gallocr_free(alloc);
    ggml_free(gctx);
    return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
int main(int argc, char ** argv) {
    float tol   = 1e-3f;
    unsigned seed = (unsigned) std::time(nullptr);
    std::string backend_name = "cpu";

    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--backend") == 0 && i + 1 < argc) {
            backend_name = argv[++i];
        } else if (strcmp(argv[i], "--tol") == 0 && i + 1 < argc) {
            tol = (float) std::atof(argv[++i]);
        } else if (strcmp(argv[i], "--seed") == 0 && i + 1 < argc) {
            seed = (unsigned) std::atoi(argv[++i]);
        }
    }

    printf("istft-verify: backend=%s tol=%.2e seed=%u\n",
           backend_name.c_str(), (double) tol, seed);

    // Select backend.
    ggml_backend_t backend = nullptr;
#ifdef GGML_USE_CUDA
    if (backend_name == "cuda") {
        backend = ggml_backend_cuda_init(0);
        if (!backend) { fprintf(stderr, "CUDA backend unavailable\n"); return 1; }
    }
#endif
#ifdef GGML_USE_VULKAN
    if (backend_name == "vulkan") {
        backend = ggml_backend_vk_init(0);
        if (!backend) { fprintf(stderr, "Vulkan backend unavailable\n"); return 1; }
    }
#endif
    if (!backend) {
        if (backend_name != "cpu") {
            fprintf(stderr, "Warning: %s backend not compiled in, falling back to CPU\n",
                    backend_name.c_str());
        }
        backend = ggml_backend_cpu_init();
    }

    // Test cases: 10 random (n_fft, hop, win, T) configurations.
    // n_fft in {8, 16, 20, 32, 64}; hop = n_fft/4; win = n_fft; T in [10, 50].
    std::mt19937 rng(seed);
    std::uniform_int_distribution<int> fft_dist(0, 4);
    std::uniform_int_distribution<int> T_dist(10, 50);
    std::uniform_real_distribution<float> val_dist(0.0f, 1.0f);
    std::uniform_real_distribution<float> phase_dist(-3.14159f, 3.14159f);

    const int nfft_choices[] = { 8, 16, 20, 32, 64 };

    int n_pass = 0, n_fail = 0, n_skip = 0;

    for (int tc = 0; tc < 10; ++tc) {
        const int n_fft      = nfft_choices[fft_dist(rng)];
        const int hop_length = n_fft / 4;
        const int win_length = n_fft;
        const int n_frames   = T_dist(rng);
        const int F          = n_fft / 2 + 1;
        const int n_out      = (n_frames - 1) * hop_length + win_length;

        // Random magnitude + phase.
        std::vector<float> mag  ((size_t) F * n_frames);
        std::vector<float> phase((size_t) F * n_frames);
        for (auto & v : mag)   v = val_dist(rng);
        for (auto & v : phase) v = phase_dist(rng);

        // CPU reference.
        auto ref = istft_ref(mag, phase, n_fft, hop_length, win_length, n_frames);

        // GGML dispatch.
        bool supported = false;
        auto got = istft_ggml(backend, mag, phase, n_fft, hop_length, win_length,
                              n_frames, supported);

        if (!supported) {
            printf("  case %2d: n_fft=%d hop=%d win=%d T=%d n_out=%d → SKIP (op not supported)\n",
                   tc, n_fft, hop_length, win_length, n_frames, n_out);
            ++n_skip;
            continue;
        }

        if (got.size() != ref.size()) {
            printf("  case %2d: n_fft=%d hop=%d win=%d T=%d → FAIL (size mismatch %zu vs %zu)\n",
                   tc, n_fft, hop_length, win_length, n_frames, got.size(), ref.size());
            ++n_fail;
            continue;
        }

        float max_err = 0.0f;
        for (size_t i = 0; i < ref.size(); ++i)
            max_err = std::max(max_err, std::fabs(got[i] - ref[i]));

        if (max_err <= tol) {
            printf("  case %2d: n_fft=%d hop=%d win=%d T=%d n_out=%d → PASS (max_err=%.2e)\n",
                   tc, n_fft, hop_length, win_length, n_frames, n_out, (double) max_err);
            ++n_pass;
        } else {
            printf("  case %2d: n_fft=%d hop=%d win=%d T=%d n_out=%d → FAIL (max_err=%.2e > tol=%.2e)\n",
                   tc, n_fft, hop_length, win_length, n_frames, n_out, (double) max_err, (double) tol);
            ++n_fail;
        }
    }

    ggml_backend_free(backend);

    printf("\nSummary: %d PASS, %d FAIL, %d SKIP\n", n_pass, n_fail, n_skip);
    return (n_fail > 0) ? 1 : 0;
}
