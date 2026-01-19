# RLM Provider (Prototype)

This directory contains a **minimal Recursive Language Model (RLM) provider**
for the **Eliza Python core**.

The goal of this provider is to make RLM usable as an **optional reasoning
backend**, while Eliza remains responsible for memory, planning, tools,
and agent autonomy.

This implementation is intentionally lightweight and designed for
early feedback and iteration.

---

## Files

- `rlm_client.py`  
  Thin adapter responsible for initializing and calling the RLM backend.
  Handles safe fallback behavior when RLM is not installed.

- `rlm_provider.py`  
  Provider implementation that maps Eliza runtime parameters to the
  RLM client interface.

- `__init__.py`  
  Convenience exports for provider registration.

---

## RLM Dependency

This provider integrates with an **external Recursive Language Model (RLM)**
implementation inspired by MIT CSAIL research by **Alex Zhang et al.**

Reference implementation (upstream research repo):  
https://github.com/alexzhang13/rlm

Important notes:

- This repository **does not vendor, fork, or modify** the original RLM code.
- RLM is treated as an **optional dependency**.
- If RLM is not installed or importable, the provider safely returns
  stub responses instead of failing.

This keeps the Eliza core decoupled from research-specific dependencies.

---

## Configuration

The RLM provider can be configured via environment variables or
a config dictionary passed at initialization.

### Environment variables

- `ELIZA_RLM_BACKEND`  
  Backend name (default: `gemini`)

- `ELIZA_RLM_ENV`  
  Runtime environment string (default: `local`)

- `ELIZA_RLM_MAX_ITERATIONS`  
  Maximum recursive iterations (default: `4`)

- `ELIZA_RLM_MAX_DEPTH`  
  Maximum recursion depth (default: `1`)

- `ELIZA_RLM_VERBOSE`  
  Enable verbose/debug output (`true` / `false`, default: `false`)

### Programmatic configuration

You may also pass a configuration dictionary when constructing
`RLMClient` or `RLMProvider` to override environment defaults.

---

## Design Notes

- Eliza owns **conversation state, memory, planning, and tools**
- RLM only receives normalized messages and returns a response
- No system prompts are injected automatically
- No global mutable state is introduced
- All inference is guarded to avoid runtime or CI failures

This design keeps the provider **safe, optional, and non-invasive**.

---

## Status & Next Steps

This provider is an **early-stage prototype**.

Included in the initial PR:
- Provider and client skeleton
- Safe stub behavior when RLM is unavailable
- Clear abstraction boundaries

Planned follow-up work:
- Remote HTTP inference mode (if RLM server is exposed)
- Streaming support
- Token accounting and metadata
- Optional system-prompt handling
- Expanded tests once RLM is available in CI

---

## Scope

This provider is intended as an **application-layer integration**
and **not** a reimplementation of the original RLM research framework.

For full research context, benchmarks, and REPL tooling, refer to
the upstream RLM repository linked above.
