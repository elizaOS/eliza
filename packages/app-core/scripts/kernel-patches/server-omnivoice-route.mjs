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
// `#ifdef ELIZA_FUSE_OMNIVOICE`, the CMake define the fused targets set
// (`fusedExtraCmakeFlags()`). A non-fused build's `server.cpp` is byte-for-
// byte unchanged after preprocessing. The cmake-graft separately links
// `omnivoice-core` into the `llama-server` target for fused builds so the
// symbols resolve.
//
// Idempotent via the `// ELIZA-OMNIVOICE-AUDIO-SPEECH-ROUTE-V1` sentinel.
// If the server.cpp layout drifts so an anchor is missing, this throws and
// `build-llama-cpp-dflash.mjs` exits non-zero — no silent fallback.

import fs from "node:fs";
import path from "node:path";

const SENTINEL = "// ELIZA-OMNIVOICE-AUDIO-SPEECH-ROUTE-V1";

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
 * Defines a tiny `eliza_omnivoice` namespace with a lazily-initialised
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
#ifdef ELIZA_FUSE_OMNIVOICE
#include "omnivoice.h"
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

namespace eliza_omnivoice {

// Resolve a config value: prefer the CLI override captured in main(), then
// the env var, then empty.
static std::string g_model_path;
static std::string g_codec_path;

// LE byte readers shared with the FFI preset parser. Inline so we don't
// depend on the FFI bridge — this route runs in llama-server, not the
// libelizainference dylib.
static uint32_t ov_route_le_u32(const uint8_t * p) {
    return  (uint32_t) p[0]
          | ((uint32_t) p[1] << 8)
          | ((uint32_t) p[2] << 16)
          | ((uint32_t) p[3] << 24);
}
static int32_t ov_route_le_i32(const uint8_t * p) {
    return (int32_t) ov_route_le_u32(p);
}

// Holds a parsed v2 ELZ2 voice preset payload (just the bits the
// synth path consumes). Owns the int32 token storage.
struct route_voice_preset {
    std::string instruct;
    std::string ref_text;
    std::vector<int32_t> ref_audio_tokens;
    int K = 0;
    int ref_T = 0;
    bool empty_payload = true;
};

// voiceId path-safety: lowercase letters/digits/`._-`, no `..`.
static bool ov_route_safe_voice_id(const std::string & v) {
    if (v.empty()) return false;
    if (v.find("..") != std::string::npos) return false;
    for (char c : v) {
        if (!(std::isalnum((unsigned char) c) || c == '.' || c == '_' || c == '-'))
            return false;
    }
    return true;
}

// Resolve <bundle_dir> from the model path. Model lives at
// <bundle>/tts/omnivoice-base.gguf; we walk two levels up. Falls back
// to the parent dir if the path is non-canonical.
static std::string ov_route_bundle_dir() {
    const std::string model = resolved_model_path();
    if (model.empty()) return std::string();
    // strip filename
    auto pos = model.find_last_of('/');
    if (pos == std::string::npos) return std::string();
    std::string parent = model.substr(0, pos);
    // strip "tts" subdir if present
    auto pos2 = parent.find_last_of('/');
    if (pos2 == std::string::npos) return parent;
    std::string maybe_bundle = parent.substr(0, pos2);
    std::string leaf = parent.substr(pos2 + 1);
    if (leaf == "tts" || leaf == "voice" || leaf == "speech") {
        return maybe_bundle;
    }
    return parent;
}

// Read entire preset file into a buffer. Returns false on missing/IO error.
static bool ov_route_read_file(const std::string & path, std::vector<uint8_t> & out) {
    FILE * f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    std::fseek(f, 0, SEEK_END);
    long n = std::ftell(f);
    if (n < 0) { std::fclose(f); return false; }
    std::fseek(f, 0, SEEK_SET);
    out.resize((size_t) n);
    size_t got = std::fread(out.data(), 1, (size_t) n, f);
    std::fclose(f);
    return got == (size_t) n;
}

// Parse v2 ELZ2 voice preset bytes into `out`. v1 files are accepted
// (no payload extracted — empty_payload stays true). Returns false on
// hard format errors with `err` populated; missing/unsafe inputs are
// the caller's job to surface.
static bool ov_route_parse_preset(const std::vector<uint8_t> & bytes,
                                  route_voice_preset & out,
                                  std::string & err) {
    if (bytes.size() < 24) { err = "voice preset truncated header"; return false; }
    const uint8_t * p = bytes.data();
    const size_t len = bytes.size();
    if (ov_route_le_u32(p) != 0x315A4C45u /* 'ELZ1' */) {
        err = "voice preset bad magic"; return false;
    }
    const uint32_t version = ov_route_le_u32(p + 4);
    if (version != 1u && version != 2u) {
        err = "voice preset unsupported version"; return false;
    }
    if (version == 1u) {
        // v1 only carries Kokoro-style embedding + phrase seed. Nothing
        // for the synth path to apply. Keep empty_payload = true.
        return true;
    }
    if (len < 64) { err = "voice preset v2 truncated header"; return false; }
    auto sec_at = [&](size_t off, uint32_t & soff, uint32_t & ssz) {
        soff = ov_route_le_u32(p + off);
        ssz  = ov_route_le_u32(p + off + 4);
    };
    uint32_t ref_tok_off = 0, ref_tok_sz = 0;
    uint32_t ref_txt_off = 0, ref_txt_sz = 0;
    uint32_t instr_off = 0, instr_sz = 0;
    sec_at(24, ref_tok_off, ref_tok_sz);
    sec_at(32, ref_txt_off, ref_txt_sz);
    sec_at(40, instr_off, instr_sz);
    auto in_bounds = [&](uint32_t soff, uint32_t ssz) {
        if (ssz == 0) return true;
        if (soff < 64) return false;
        return (size_t) soff + (size_t) ssz <= len;
    };
    if (!in_bounds(ref_tok_off, ref_tok_sz) ||
        !in_bounds(ref_txt_off, ref_txt_sz) ||
        !in_bounds(instr_off, instr_sz)) {
        err = "voice preset section out of bounds"; return false;
    }
    if (ref_tok_sz > 0) {
        if (ref_tok_sz < 8) { err = "voice preset ref_audio_tokens truncated"; return false; }
        const uint8_t * rt = p + ref_tok_off;
        const uint32_t K = ov_route_le_u32(rt);
        const uint32_t refT = ov_route_le_u32(rt + 4);
        if ((size_t) ref_tok_sz - 8 != (size_t) K * (size_t) refT * 4u) {
            err = "voice preset ref_audio_tokens shape mismatch"; return false;
        }
        out.K = (int) K;
        out.ref_T = (int) refT;
        out.ref_audio_tokens.resize((size_t) K * (size_t) refT);
        for (size_t i = 0; i < out.ref_audio_tokens.size(); ++i) {
            out.ref_audio_tokens[i] = ov_route_le_i32(rt + 8 + i * 4u);
        }
    }
    if (ref_txt_sz > 0) {
        out.ref_text.assign(reinterpret_cast<const char *>(p + ref_txt_off),
                            (size_t) ref_txt_sz);
    }
    if (instr_sz > 0) {
        out.instruct.assign(reinterpret_cast<const char *>(p + instr_off),
                            (size_t) instr_sz);
    }
    out.empty_payload =
        out.instruct.empty() && out.ref_text.empty() && out.ref_audio_tokens.empty();
    return true;
}

// Resolve `voice` to a preset. Returns false (with err set) when the
// id is unsafe or the file is missing/malformed. Returns true with
// empty_payload=true when the voice resolves to "default" or "" —
// in those cases the caller stays on OmniVoice auto-voice.
static bool ov_route_load_voice(const std::string & voice,
                                route_voice_preset & out,
                                std::string & err) {
    if (voice.empty() || voice == "default") return true;
    if (!ov_route_safe_voice_id(voice)) {
        err = "voice id is not a safe single segment: " + voice;
        return false;
    }
    const std::string bundle = ov_route_bundle_dir();
    if (bundle.empty()) {
        err = "voice preset bundle dir not resolvable from --omnivoice-model";
        return false;
    }
    const std::string path = bundle + "/cache/voice-preset-" + voice + ".bin";
    std::vector<uint8_t> bytes;
    if (!ov_route_read_file(path, bytes)) {
        err = "voice preset file not found or unreadable: " + path;
        return false;
    }
    return ov_route_parse_preset(bytes, out, err);
}

static std::string cli_or_env(const std::string & cli, const char * name) {
    if (!cli.empty()) return cli;
    const char * v = std::getenv(name);
    if (v && v[0] != '\\0') return std::string(v);
    return std::string();
}

static std::string resolved_model_path() {
    return cli_or_env(g_model_path, "ELIZA_OMNIVOICE_MODEL");
}
static std::string resolved_codec_path() {
    return cli_or_env(g_codec_path, "ELIZA_OMNIVOICE_CODEC");
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

static int env_int_clamped(const char * name, int fallback, int lo, int hi) {
    const char * v = std::getenv(name);
    if (!v || v[0] == '\\0') return fallback;
    char * end = nullptr;
    long parsed = std::strtol(v, &end, 10);
    if (end == v) return fallback;
    return (int) std::max((long) lo, std::min((long) hi, parsed));
}

static int json_int_clamped(const json & in, const char * name, int fallback, int lo, int hi) {
    if (!in.contains(name)) return fallback;
    try {
        if (in[name].is_number_integer()) {
            const int v = in[name].get<int>();
            return std::max(lo, std::min(hi, v));
        }
        if (in[name].is_string()) {
            const std::string s = in[name].get<std::string>();
            char * end = nullptr;
            long parsed = std::strtol(s.c_str(), &end, 10);
            if (end != s.c_str()) return (int) std::max((long) lo, std::min((long) hi, parsed));
        }
    } catch (...) {
    }
    return fallback;
}

static float json_float_positive(const json & in, const char * name, float fallback) {
    if (!in.contains(name)) return fallback;
    try {
        if (in[name].is_number()) {
            const float v = in[name].get<float>();
            return v > 0.0f ? v : fallback;
        }
        if (in[name].is_string()) {
            const std::string s = in[name].get<std::string>();
            char * end = nullptr;
            float parsed = std::strtof(s.c_str(), &end);
            if (end != s.c_str() && parsed > 0.0f) return parsed;
        }
    } catch (...) {
    }
    return fallback;
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
        // OpenAI-compatible `voice` field. Resolves to
        // <bundle>/cache/voice-preset-<voice>.bin (ELZ2 v2). v1 / empty /
        // missing presets fall through to OmniVoice auto-voice mode.
        // R6 §3.3 / brief §3: load instruct + ref_audio_tokens + ref_text
        // before threading into ov_tts_params.
        std::string voice_id;
        if (in.contains("voice") && in["voice"].is_string()) {
            voice_id = in["voice"].get<std::string>();
        }
        route_voice_preset preset;
        std::string preset_err;
        const bool preset_ok = ov_route_load_voice(voice_id, preset, preset_err);
        if (!preset_ok) {
            // A bad/malformed preset id is a 400, not a silent fall-through.
            return error_res(400, std::string("invalid voice preset: ") + preset_err);
        }
        // `?interactive=0` (or JSON {"interactive": false}) is the
        // explicit non-interactive path. The default route keeps the
        // synchronous-mutex behaviour; interactive turns are expected
        // to use the FFI streaming path (`ttsSynthesizeStream`) where
        // mid-utterance cancellation is supported (R11 / brief §6
        // Path B).
        bool interactive = true;
        if (in.contains("interactive") && in["interactive"].is_boolean()) {
            interactive = in["interactive"].get<bool>();
        }

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
        // Default to OmniVoice's auto-voice path. Preset (if any) overrides
        // params.instruct / ref_audio_tokens / ref_text below.
        tp.instruct = "";
        if (!preset.empty_payload) {
            if (!preset.instruct.empty()) tp.instruct = preset.instruct.c_str();
            if (!preset.ref_audio_tokens.empty() && preset.K > 0 && preset.ref_T > 0) {
                tp.ref_audio_tokens = preset.ref_audio_tokens.data();
                tp.ref_T = preset.ref_T;
            }
            if (!preset.ref_text.empty()) tp.ref_text = preset.ref_text.c_str();
        }
        int mg_steps = env_int_clamped("ELIZA_OMNIVOICE_MG_NUM_STEP", tp.mg_num_step, 4, 64);
        mg_steps = json_int_clamped(in, "num_step", mg_steps, 4, 64);
        mg_steps = json_int_clamped(in, "num_steps", mg_steps, 4, 64);
        mg_steps = json_int_clamped(in, "steps", mg_steps, 4, 64);
        tp.mg_num_step = mg_steps;
        const float duration_sec = json_float_positive(in, "duration", 0.0f);
        if (duration_sec > 0.0f) {
            const int frames = ov_duration_sec_to_tokens(ctx, duration_sec);
            if (frames > 0) tp.T_override = frames;
        }
        if (interactive) {
            // Interactive turns should route through the FFI streaming
            // path. Return 409 with the diagnostic so the JS layer can
            // pick `OmniVoiceFfiBackend.ttsStream` instead of the HTTP
            // route. The HTTP route stays available for batch jobs that
            // explicitly opt out with `interactive: false`.
            return error_res(409, "interactive=true: use FFI streaming "
                                  "(eliza_inference_tts_synthesize_stream) for "
                                  "mid-utterance cancellation; pass "
                                  "{\\"interactive\\": false} to use this batch route");
        }
        ov_audio audio = {};
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

} // namespace eliza_omnivoice
#endif // ELIZA_FUSE_OMNIVOICE
// end ${SENTINEL}
`;
}

/**
 * Insert the C++ block after `server.cpp`'s last `#include` line and add
 * the route registration + the two CLI args. Returns the modified source
 * (or the original if the sentinel is already present).
 */
function patchServerSource(source, serverPath) {
  if (source.includes(SENTINEL)) {
    const start = source.indexOf(SENTINEL);
    const endMarker = `// end ${SENTINEL}`;
    const end = source.indexOf(endMarker, start);
    if (start !== -1 && end !== -1) {
      const afterEnd = source.indexOf("\n", end);
      return (
        source.slice(0, start) +
        audioSpeechBlock().trimStart() +
        source.slice(afterEnd === -1 ? source.length : afterEnd + 1)
      );
    }
    return source
      .replace(
        `static std::string env_or(const char * name, const std::string & fallback) {
    const char * v = std::getenv(name);
    if (v && v[0] != '\\0') return std::string(v);
    return fallback;
}

static std::string resolved_model_path() {
    return env_or("ELIZA_OMNIVOICE_MODEL", g_model_path);
}
static std::string resolved_codec_path() {
    return env_or("ELIZA_OMNIVOICE_CODEC", g_codec_path);
}`,
        `static std::string cli_or_env(const std::string & cli, const char * name) {
    if (!cli.empty()) return cli;
    const char * v = std::getenv(name);
    if (v && v[0] != '\\0') return std::string(v);
    return std::string();
}

static std::string resolved_model_path() {
    return cli_or_env(g_model_path, "ELIZA_OMNIVOICE_MODEL");
}
static std::string resolved_codec_path() {
    return cli_or_env(g_codec_path, "ELIZA_OMNIVOICE_CODEC");
}`,
      )
      .replace("ov_audio audio = { nullptr, 0 };", "ov_audio audio = {};");
  }

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
    source.slice(0, afterInclude) +
    audioSpeechBlock() +
    source.slice(afterInclude);

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
    `#ifdef ELIZA_FUSE_OMNIVOICE\n` +
    `    // Fused omnivoice TTS — same process as the text/DFlash routes above.\n` +
    `    ctx_http.post("/v1/audio/speech",     ex_wrapper(eliza_omnivoice::audio_speech_handler()));\n` +
    `    ctx_http.post("/audio/speech",        ex_wrapper(eliza_omnivoice::audio_speech_handler()));\n` +
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
    `\n#ifdef ELIZA_FUSE_OMNIVOICE\n` +
    `    // Strip omnivoice-fused-only flags before common_params_parse so the\n` +
    `    // upstream parser doesn't reject them. Values feed the lazily-created\n` +
    `    // OmniVoice context (see the eliza_omnivoice namespace above).\n` +
    `    {\n` +
    `        std::vector<char *> filtered;\n` +
    `        filtered.reserve((size_t)argc);\n` +
    `        for (int i = 0; i < argc; ++i) {\n` +
    `            const std::string a = argv[i];\n` +
    `            if ((a == "--omnivoice-model" || a == "--omnivoice-codec") && i + 1 < argc) {\n` +
    `                if (a == "--omnivoice-model") eliza_omnivoice::g_model_path = argv[++i];\n` +
    `                else                          eliza_omnivoice::g_codec_path = argv[++i];\n` +
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
    const patched = patchServerSource(original, serverPath);
    if (patched !== original) {
      if (!dryRun) fs.writeFileSync(serverPath, patched, "utf8");
      console.log(
        `[dflash-build] ${dryRun ? "(dry-run) would refresh" : "refreshed"} ` +
          `${path.relative(cacheDir, serverPath)} ` +
          `omnivoice /v1/audio/speech route (sentinel present)`,
      );
      return;
    }
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
        `${path.relative(cacheDir, serverPath)} for ELIZA_FUSE_OMNIVOICE builds`,
    );
    return;
  }
  fs.writeFileSync(serverPath, patched, "utf8");
  console.log(
    `[dflash-build] mounted /v1/audio/speech onto ${path.relative(cacheDir, serverPath)} ` +
      `(active only when built with -DELIZA_FUSE_OMNIVOICE=ON)`,
  );
}

export { SENTINEL as SERVER_OMNIVOICE_ROUTE_SENTINEL };
