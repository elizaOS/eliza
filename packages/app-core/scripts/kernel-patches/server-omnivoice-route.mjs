// llama-server `/v1/audio/speech` route mount for omnivoice-fused builds.
//
// This is the runtime-owned half of the omnivoice fusion that
// `packages/app-core/scripts/omnivoice-fuse/cmake-graft.mjs` filed against
// us ("the route-mount is owned by the runtime team"). It makes the fused
// `llama-server` — the same process that already serves `/completion`,
// `/v1/chat/completions`, and the DFlash speculative loop — additionally
// serve `POST /v1/audio/speech` (the OpenAI-compatible TTS endpoint) by
// calling into `omnivoice-core` (`ov_init` / `ov_synthesize`) in-process.
//
// One process, one llama.cpp build, one GGML pin: no second
// `llama-omnivoice-server` process, no IPC tax. This is `packages/inference/
// AGENTS.md` §4 ("We do not run text and voice in two processes
// communicating over IPC") plus the remaining-work ledger's P0 #3
// merged-route item.
//
// Scope guard: every edit this module makes is wrapped in
// `#ifdef MILADY_FUSE_OMNIVOICE`, the CMake define the fused targets set
// (`fusedExtraCmakeFlags()`). A non-fused build's `server.cpp` is byte-for-
// byte unchanged after preprocessing. The cmake-graft separately links
// `omnivoice-core` into the `llama-server` target for fused builds so the
// symbols resolve.
//
// Idempotent via the `// MILADY-OMNIVOICE-AUDIO-SPEECH-ROUTE-V1` sentinel.
// If the server.cpp layout drifts so an anchor is missing, this throws and
// `build-llama-cpp-dflash.mjs` exits non-zero — no silent fallback.

import fs from "node:fs";
import path from "node:path";

const SENTINEL = "// MILADY-OMNIVOICE-AUDIO-SPEECH-ROUTE-V1";

function findServerSource(cacheDir) {
  for (const rel of [
    path.join("tools", "server", "server.cpp"),
    path.join("examples", "server", "server.cpp"),
  ]) {
    const full = path.join(cacheDir, rel);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * C++ block inserted near the top of `server.cpp`, after its includes.
 * Defines a tiny `milady_omnivoice` namespace with a lazily-initialised
 * OmniVoice context (model + codec GGUF paths come from `--omnivoice-model`
 * / `--omnivoice-codec`, or the `ELIZA_OMNIVOICE_MODEL` /
 * `ELIZA_OMNIVOICE_CODEC` env vars the dflash-server spawn layer sets when
 * launching the fused binary against an Eliza-1 bundle) and a `handler_t`
 * for `POST /v1/audio/speech`.
 *
 * The handler accepts the OpenAI Audio Speech request shape
 * (`{ "input": "...", "voice": "...", "model": "...", "response_format":
 * "wav"|"pcm" }`) and returns a 24 kHz mono WAV (default) or raw little-
 * endian f32 PCM (`response_format: "pcm"`). Errors return a JSON
 * `{ "error": { "message": ... } }` body with a 4xx/5xx status — never a
 * silent empty body.
 */
function audioSpeechBlock() {
  return `
${SENTINEL}
#ifdef MILADY_FUSE_OMNIVOICE
#include "omnivoice.h"
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

namespace milady_omnivoice {

// Resolve a config value: prefer the CLI override captured in main(), then
// the env var, then empty.
static std::string g_model_path;
static std::string g_codec_path;

static std::string env_or(const char * name, const std::string & fallback) {
    const char * v = std::getenv(name);
    if (v && v[0] != '\\0') return std::string(v);
    return fallback;
}

static std::string resolved_model_path() {
    return env_or("ELIZA_OMNIVOICE_MODEL", g_model_path);
}
static std::string resolved_codec_path() {
    return env_or("ELIZA_OMNIVOICE_CODEC", g_codec_path);
}

static std::mutex      g_mu;
static ov_context *    g_ctx = nullptr;   // lazily initialised under g_mu
static std::string     g_init_error;       // sticky: a failed init stays failed until paths change
static std::string     g_init_signature;   // model|codec the live ctx was built from

// Returns the OmniVoice context, initialising it on first use. Returns
// nullptr and sets *err on failure. Caller must hold g_mu.
static ov_context * acquire_locked(std::string & err) {
    const std::string model = resolved_model_path();
    const std::string codec = resolved_codec_path();
    const std::string sig = model + "|" + codec;
    if (g_ctx && g_init_signature == sig) return g_ctx;
    if (g_ctx && g_init_signature != sig) {
        ov_free(g_ctx);
        g_ctx = nullptr;
        g_init_error.clear();
    }
    if (model.empty() || codec.empty()) {
        err = "omnivoice TTS not configured: pass --omnivoice-model and "
              "--omnivoice-codec (or set ELIZA_OMNIVOICE_MODEL / "
              "ELIZA_OMNIVOICE_CODEC) when launching the fused server";
        return nullptr;
    }
    if (!g_init_error.empty() && g_init_signature == sig) {
        err = g_init_error;
        return nullptr;
    }
    ov_init_params ip;
    ov_init_default_params(&ip);
    ip.model_path = model.c_str();
    ip.codec_path = codec.c_str();
    ov_context * ctx = ov_init(&ip);
    if (!ctx) {
        const char * le = ov_last_error();
        g_init_error = std::string("omnivoice ov_init failed: ") + (le ? le : "(no detail)");
        g_init_signature = sig;
        err = g_init_error;
        return nullptr;
    }
    g_ctx = ctx;
    g_init_signature = sig;
    g_init_error.clear();
    return g_ctx;
}

// Build a 16-bit PCM WAV container around f32 mono samples at sample_rate.
static std::string wav16_from_f32(const float * pcm, int n, int sample_rate) {
    auto put_u32 = [](std::string & s, uint32_t v) {
        s.push_back((char)(v & 0xff));
        s.push_back((char)((v >> 8) & 0xff));
        s.push_back((char)((v >> 16) & 0xff));
        s.push_back((char)((v >> 24) & 0xff));
    };
    auto put_u16 = [](std::string & s, uint16_t v) {
        s.push_back((char)(v & 0xff));
        s.push_back((char)((v >> 8) & 0xff));
    };
    const uint16_t channels = 1;
    const uint16_t bits = 16;
    const uint32_t byte_rate = (uint32_t)sample_rate * channels * (bits / 8);
    const uint16_t block_align = channels * (bits / 8);
    const uint32_t data_bytes = (uint32_t)n * (bits / 8);
    std::string out;
    out.reserve(44 + data_bytes);
    out += "RIFF";
    put_u32(out, 36 + data_bytes);
    out += "WAVE";
    out += "fmt ";
    put_u32(out, 16);          // PCM fmt chunk size
    put_u16(out, 1);           // PCM
    put_u16(out, channels);
    put_u32(out, (uint32_t)sample_rate);
    put_u32(out, byte_rate);
    put_u16(out, block_align);
    put_u16(out, bits);
    out += "data";
    put_u32(out, data_bytes);
    for (int i = 0; i < n; ++i) {
        float v = pcm[i];
        if (v > 1.0f) v = 1.0f;
        if (v < -1.0f) v = -1.0f;
        int32_t s = (int32_t)(v * 32767.0f);
        put_u16(out, (uint16_t)(int16_t)s);
    }
    return out;
}

// Raw little-endian f32 PCM (the runtime's preferred wire form — the JS
// ring buffer is f32 @ 24 kHz, no decode step).
static std::string pcm_f32_le(const float * pcm, int n) {
    std::string out;
    out.resize((size_t)n * sizeof(float));
    std::memcpy(out.data(), pcm, out.size());
    return out;
}

static server_http_res_ptr error_res(int status, const std::string & message) {
    auto res = std::make_unique<server_http_res>();
    res->status = status;
    res->content_type = "application/json; charset=utf-8";
    json body = { { "error", { { "message", message }, { "type", "omnivoice_error" } } } };
    res->data = body.dump();
    return res;
}

// handler_t for POST /v1/audio/speech.
static server_http_context::handler_t audio_speech_handler() {
    return [](const server_http_req & req) -> server_http_res_ptr {
        json in;
        try {
            in = req.body.empty() ? json::object() : json::parse(req.body);
        } catch (const std::exception & e) {
            return error_res(400, std::string("invalid JSON body: ") + e.what());
        }
        std::string text;
        if (in.contains("input") && in["input"].is_string()) {
            text = in["input"].get<std::string>();
        } else if (in.contains("text") && in["text"].is_string()) {
            text = in["text"].get<std::string>();
        }
        if (text.empty()) {
            return error_res(400, "missing or empty 'input' field");
        }
        std::string fmt = "wav";
        if (in.contains("response_format") && in["response_format"].is_string()) {
            fmt = in["response_format"].get<std::string>();
        }
        // 'voice' is accepted for OpenAI shape compatibility; the Eliza-1
        // bundle ships one default voice preset, so it is informational only
        // until per-voice presets are wired into omnivoice-core.

        std::string err;
        ov_context * ctx = nullptr;
        {
            std::lock_guard<std::mutex> lk(g_mu);
            ctx = acquire_locked(err);
        }
        if (!ctx) return error_res(503, err);

        ov_tts_params tp;
        ov_tts_default_params(&tp);
        tp.text = text.c_str();
        ov_audio audio = { nullptr, 0 };
        ov_status st;
        {
            // ov_synthesize is not reentrant on one context; serialise.
            std::lock_guard<std::mutex> lk(g_mu);
            st = ov_synthesize(ctx, &tp, &audio);
        }
        if (st != OV_STATUS_OK) {
            const char * le = ov_last_error();
            ov_audio_free(&audio);
            return error_res(500, std::string("ov_synthesize failed (status ") +
                std::to_string((int)st) + "): " + (le ? le : "(no detail)"));
        }
        const int sample_rate = 24000; // omnivoice codec output rate
        auto res = std::make_unique<server_http_res>();
        res->status = 200;
        if (fmt == "pcm" || fmt == "f32" || fmt == "raw") {
            res->content_type = "application/octet-stream";
            res->headers["X-Sample-Rate"] = std::to_string(sample_rate);
            res->headers["X-Sample-Format"] = "f32le";
            res->data = pcm_f32_le(audio.samples, audio.n_samples);
        } else {
            res->content_type = "audio/wav";
            res->data = wav16_from_f32(audio.samples, audio.n_samples, sample_rate);
        }
        ov_audio_free(&audio);
        return res;
    };
}

} // namespace milady_omnivoice
#endif // MILADY_FUSE_OMNIVOICE
// end ${SENTINEL}
`;
}

/**
 * Insert the C++ block after `server.cpp`'s last `#include` line and add
 * the route registration + the two CLI args. Returns the modified source
 * (or the original if the sentinel is already present).
 */
function patchServerSource(source, serverPath) {
  if (source.includes(SENTINEL)) return source;

  // 1) Insert the namespace block after the include section. server.cpp's
  //    own includes end before `#if defined(_WIN32)` / `#include <windows.h>`
  //    or before the first `static`/`int main`. Anchor on the well-known
  //    `#include "log.h"` line that the fork carries.
  const includeAnchor = '#include "log.h"';
  const includeIdx = source.indexOf(includeAnchor);
  if (includeIdx === -1) {
    throw new Error(
      `[dflash-build] server-omnivoice-route: '${includeAnchor}' not found in ` +
        `${serverPath} — server.cpp layout changed; cannot anchor the audio/speech mount.`,
    );
  }
  const afterInclude = source.indexOf("\n", includeIdx) + 1;
  let patched =
    source.slice(0, afterInclude) + audioSpeechBlock() + source.slice(afterInclude);

  // 2) Register the route. Anchor on the existing `/v1/embeddings` POST
  //    registration line (stable across recent forks) and add ours right
  //    after it.
  const routeAnchor =
    'ctx_http.post("/v1/embeddings",       ex_wrapper(routes.post_embeddings_oai));';
  const routeIdx = patched.indexOf(routeAnchor);
  if (routeIdx === -1) {
    throw new Error(
      `[dflash-build] server-omnivoice-route: route anchor not found in ` +
        `${serverPath} — cannot register /v1/audio/speech.`,
    );
  }
  const routeLineEnd = patched.indexOf("\n", routeIdx) + 1;
  const routeInsert =
    `#ifdef MILADY_FUSE_OMNIVOICE\n` +
    `    // Fused omnivoice TTS — same process as the text/DFlash routes above.\n` +
    `    ctx_http.post("/v1/audio/speech",     ex_wrapper(milady_omnivoice::audio_speech_handler()));\n` +
    `    ctx_http.post("/audio/speech",        ex_wrapper(milady_omnivoice::audio_speech_handler()));\n` +
    `#endif\n`;
  patched =
    patched.slice(0, routeLineEnd) + routeInsert + patched.slice(routeLineEnd);

  // 3) Capture --omnivoice-model / --omnivoice-codec from argv before
  //    common_params_parse() (which would reject unknown flags). Anchor on
  //    the `common_params params;` declaration in main().
  const paramsAnchor = "common_params params;";
  const paramsIdx = patched.indexOf(paramsAnchor);
  if (paramsIdx === -1) {
    throw new Error(
      `[dflash-build] server-omnivoice-route: '${paramsAnchor}' not found in ` +
        `${serverPath} — cannot wire the omnivoice CLI args.`,
    );
  }
  const paramsLineEnd = patched.indexOf("\n", paramsIdx) + 1;
  const argScan =
    `\n#ifdef MILADY_FUSE_OMNIVOICE\n` +
    `    // Strip omnivoice-fused-only flags before common_params_parse so the\n` +
    `    // upstream parser doesn't reject them. Values feed the lazily-created\n` +
    `    // OmniVoice context (see the milady_omnivoice namespace above).\n` +
    `    {\n` +
    `        std::vector<char *> filtered;\n` +
    `        filtered.reserve((size_t)argc);\n` +
    `        for (int i = 0; i < argc; ++i) {\n` +
    `            const std::string a = argv[i];\n` +
    `            if ((a == "--omnivoice-model" || a == "--omnivoice-codec") && i + 1 < argc) {\n` +
    `                if (a == "--omnivoice-model") milady_omnivoice::g_model_path = argv[++i];\n` +
    `                else                          milady_omnivoice::g_codec_path = argv[++i];\n` +
    `                continue;\n` +
    `            }\n` +
    `            filtered.push_back(argv[i]);\n` +
    `        }\n` +
    `        static std::vector<char *> s_filtered = filtered;\n` +
    `        argc = (int) s_filtered.size();\n` +
    `        argv = s_filtered.data();\n` +
    `    }\n` +
    `#endif\n`;
  patched =
    patched.slice(0, paramsLineEnd) + argScan + patched.slice(paramsLineEnd);

  return patched;
}

/**
 * Apply the omnivoice `/v1/audio/speech` mount to the fork's server.cpp.
 * Idempotent. Throws (build fails closed) if any anchor is missing.
 */
export function patchServerOmnivoiceRoute(cacheDir, { dryRun = false } = {}) {
  const serverPath = findServerSource(cacheDir);
  if (!serverPath) {
    throw new Error(
      `[dflash-build] server-omnivoice-route: no server.cpp under ${cacheDir} ` +
        `(looked at tools/server/ and examples/server/).`,
    );
  }
  const original = fs.readFileSync(serverPath, "utf8");
  if (original.includes(SENTINEL)) {
    console.log(
      `[dflash-build] ${path.relative(cacheDir, serverPath)} already carries the ` +
        `omnivoice /v1/audio/speech route (sentinel present)`,
    );
    return;
  }
  const patched = patchServerSource(original, serverPath);
  if (dryRun) {
    console.log(
      `[dflash-build] (dry-run) would mount /v1/audio/speech onto ` +
        `${path.relative(cacheDir, serverPath)} for MILADY_FUSE_OMNIVOICE builds`,
    );
    return;
  }
  fs.writeFileSync(serverPath, patched, "utf8");
  console.log(
    `[dflash-build] mounted /v1/audio/speech onto ${path.relative(cacheDir, serverPath)} ` +
      `(active only when built with -DMILADY_FUSE_OMNIVOICE=ON)`,
  );
}

export { SENTINEL as SERVER_OMNIVOICE_ROUTE_SENTINEL };
