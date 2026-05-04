# Changelog

## 0.1.0

Initial NVIDIA NIM cloud provider for elizaOS.

### Added

- Chat and object generation through NVIDIA's OpenAI-compatible `/chat/completions` API.
- Text embeddings through NVIDIA's `/embeddings` API.
- Browser base URL support so API keys can stay server-side behind a proxy.
- Separate embedding base URL support for model-specific NVIDIA routing changes.
- NVCF request/status header logging for troubleshooting with NVIDIA support.
- Provider-local text request timeout and output-token defaults.

### Changed

- Default chat models now favor reliable XML/control output:
  - `TEXT_SMALL`: `meta/llama-3.1-8b-instruct`
  - `TEXT_LARGE`: `meta/llama-3.1-405b-instruct`
- Default embedding model is `nvidia/nv-embedqa-e5-v5` with `input_type=passage` and 1024 dimensions.

### Fixed

- Omit empty stop sequences because NVIDIA rejects `stop: []`.
- Normalize embedding model organization casing where NVIDIA routes are case-sensitive.
- Fall back from AI SDK embedding calls to raw HTTP for models that require NVIDIA-specific fields.

### Why

NVIDIA Build models vary by account entitlement and runtime behavior. Some models listed by `/v1/models` return `404`, some time out, and reasoning-oriented models can consume visible output budget before returning XML. The defaults and request handling are intentionally conservative so elizaOS can reliably parse control responses and keep memory embeddings online.
