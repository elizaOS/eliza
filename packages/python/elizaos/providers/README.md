```markdown
RLM Provider (prototype)

This directory contains a minimal RLM provider and client adapter for the Eliza Python core.

Files:
- providers/rlm_client.py - adapter that initializes and calls the AgentRLM RLM() object.
- providers/rlm_provider.py - thin provider that maps Eliza params to the client.
- providers/__init__.py - convenience exports.

Configuration (environment variables / config):
- ELIZA_RLM_BACKEND: backend name (default "gemini")
- ELIZA_RLM_ENV: environment string (default "local")
- ELIZA_RLM_MAX_ITERATIONS, ELIZA_RLM_MAX_DEPTH, ELIZA_RLM_VERBOSE: control RLM initialization.
- You can also pass config dict when constructing RLMClient or RLMProvider.

Notes:
- The first PR should include these files with RLM calls guarded; if AgentRLM is not installed, the client returns a harmless stub response.
- Follow-up work:
  - Implement remote HTTP mode (if AgentRLM exposes a server).
  - Implement streaming and token accounting.
  - Add tests exercising real AgentRLM when available and CI helpers to set PYTHONPATH.
```