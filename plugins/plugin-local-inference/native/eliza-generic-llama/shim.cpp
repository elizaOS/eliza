// eliza-generic-llama shim (#8808 C3)
//
// A thin C ABI over llama.cpp that exposes generic single-file GGUF text
// generation through simple-typed functions (no by-value structs), so bun:ffi
// can bind it directly. This is the *desktop* explicit-`modelPath` runtime for
// non-Eliza-1 models: it loads the model's OWN tokenizer/vocab (unlike the
// bundle-locked fused libelizainference, which would gibberish-tokenize a
// foreign GGUF). Built + staged by build.mjs alongside libllama.
#include "llama.h"
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

extern "C" {

struct EglHandle {
  llama_model *model;
  llama_context *ctx;
  const llama_vocab *vocab;
};

// One-time backend init (idempotent in llama.cpp).
void egl_init() { llama_backend_init(); }

// Load a single GGUF from an explicit path. Returns an opaque handle or null.
void *egl_load(const char *path, int32_t n_gpu_layers, int32_t n_ctx) {
  llama_model_params mp = llama_model_default_params();
  mp.n_gpu_layers = n_gpu_layers;
  llama_model *model = llama_model_load_from_file(path, mp);
  if (!model) return nullptr;
  llama_context_params cp = llama_context_default_params();
  cp.n_ctx = n_ctx > 0 ? static_cast<uint32_t>(n_ctx) : 4096;
  cp.n_batch = cp.n_ctx;
  llama_context *ctx = llama_init_from_model(model, cp);
  if (!ctx) {
    llama_model_free(model);
    return nullptr;
  }
  return new EglHandle{model, ctx, llama_model_get_vocab(model)};
}

// Generate up to `max_tokens` from `prompt`. temperature<=0 => greedy.
// Writes the completion to `out` (NUL-terminated, capped at out_cap) and the
// prompt/generated token counts to `*n_eval`/`*n_pred`. Returns bytes written
// (excluding NUL), or -1 on error.
int32_t egl_generate(void *handle, const char *prompt, int32_t max_tokens,
                     float temperature, float top_p, char *out, int32_t out_cap,
                     int32_t *n_eval, int32_t *n_pred) {
  EglHandle *h = static_cast<EglHandle *>(handle);
  if (!h || out_cap <= 1) return -1;
  const llama_vocab *vocab = h->vocab;
  const int32_t plen = static_cast<int32_t>(strlen(prompt));
  const int32_t n_prompt =
      -llama_tokenize(vocab, prompt, plen, nullptr, 0, true, true);
  if (n_prompt <= 0) return -1;
  std::vector<llama_token> tokens(n_prompt);
  if (llama_tokenize(vocab, prompt, plen, tokens.data(), n_prompt, true, true) <
      0)
    return -1;

  llama_sampler *smpl =
      llama_sampler_chain_init(llama_sampler_chain_default_params());
  if (temperature <= 0.0f) {
    llama_sampler_chain_add(smpl, llama_sampler_init_greedy());
  } else {
    if (top_p > 0.0f && top_p < 1.0f)
      llama_sampler_chain_add(smpl, llama_sampler_init_top_p(top_p, 1));
    llama_sampler_chain_add(smpl, llama_sampler_init_temp(temperature));
    llama_sampler_chain_add(smpl, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));
  }

  std::string result;
  llama_batch batch =
      llama_batch_get_one(tokens.data(), static_cast<int32_t>(tokens.size()));
  llama_token cur = 0;
  int32_t generated = 0;
  char piece[256];
  for (int32_t i = 0; i < max_tokens; i++) {
    if (llama_decode(h->ctx, batch) != 0) break;
    const llama_token tok = llama_sampler_sample(smpl, h->ctx, -1);
    if (llama_vocab_is_eog(vocab, tok)) break;
    const int np =
        llama_token_to_piece(vocab, tok, piece, sizeof(piece), 0, true);
    if (np > 0) result.append(piece, np);
    generated++;
    cur = tok;
    batch = llama_batch_get_one(&cur, 1);
    if (static_cast<int32_t>(result.size()) >= out_cap - 1) break;
  }
  llama_sampler_free(smpl);

  if (n_eval) *n_eval = n_prompt;
  if (n_pred) *n_pred = generated;
  int32_t n = static_cast<int32_t>(result.size());
  if (n > out_cap - 1) n = out_cap - 1;
  memcpy(out, result.data(), n);
  out[n] = 0;
  return n;
}

void egl_free(void *handle) {
  EglHandle *h = static_cast<EglHandle *>(handle);
  if (!h) return;
  llama_free(h->ctx);
  llama_model_free(h->model);
  delete h;
}
}
