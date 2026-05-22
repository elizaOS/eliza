# Eliza Model Remote

`eliza.local-model` is the ElizaLaunch Model Remote. It surfaces Eliza-1 catalog, Hugging Face metadata, local inference status, downloads, activation, routing, and direct generation capability status through Eliza Orbit.

## Eliza-1 Source

Phase 8 is Eliza-1 first. The canonical model repository is `elizaos/eliza-1`; runtime bundles live under `bundles/<tier>/`. The Remote represents the HF-visible bundle tiers:

- `0_6b`
- `0_8b`
- `1_7b`
- `2b`
- `4b`
- `9b`
- `27b`
- `27b-256k`

The local app catalog currently marks the active Eliza-1 line as `0_8b`, `2b`, `4b`, `9b`, `27b`, and `27b-256k`. The HF-visible `0_6b` and `1_7b` tiers remain represented as visible remote tiers until the local catalog activates them.

The default published runtime artifact is `Q4_K_M`. `Q6_K` and `Q8_0` are tracked as higher-precision variants when the repo or local catalog reports them.

## Voice Components

Voice components are represented as catalog-adjacent metadata under `voice/<sub>/`:

- `voice/omnivoice`
- `voice/emotion`
- `voice/turn`
- `voice/asr`
- `voice/kokoro`
- `voice/diarizer`
- `voice/wakeword`
- `voice/speaker-encoder`
- `voice/vad`
- `voice/embedding`
- `voice/turn-detector`
- `voice/voice-emotion`

Presence in the catalog does not mean installed or active. Runtime API status wins for installed, active, and download state.

## Local Inference API

The Remote prefers the existing elizaOS local inference routes:

- `GET /api/local-inference/hub`
- `GET /api/local-inference/hardware`
- `GET /api/local-inference/catalog`
- `GET /api/local-inference/installed`
- `GET /api/local-inference/device`
- `GET /api/local-inference/providers`
- `GET /api/local-inference/assignments`
- `POST /api/local-inference/assignments`
- `GET /api/local-inference/routing`
- `POST /api/local-inference/routing/preferred`
- `POST /api/local-inference/routing/policy`
- `POST /api/local-inference/downloads`
- `DELETE /api/local-inference/downloads/:modelId`
- `GET /api/local-inference/downloads/stream`
- `GET /api/local-inference/active`
- `POST /api/local-inference/active`
- `DELETE /api/local-inference/active`
- `POST /api/local-inference/installed/:id/verify`
- `DELETE /api/local-inference/installed/:id`
- `GET /api/local-inference/hf-search`

The current route file does not expose direct local generation or direct embedding HTTP routes, so `model.generate` returns `MODEL_GENERATION_UNAVAILABLE` and `model.embedding` returns `MODEL_EMBEDDING_UNAVAILABLE` unless a future route is added.

## Methods

- `model.status`
- `model.hub`
- `model.catalog`
- `model.catalog.eliza1`
- `model.eliza1.tiers`
- `model.eliza1.voice`
- `model.hf.metadata`
- `model.providers`
- `model.hardware`
- `model.installed`
- `model.download.start`
- `model.download.cancel`
- `model.downloads`
- `model.active`
- `model.activate`
- `model.unload`
- `model.assignments`
- `model.assignment.set`
- `model.routing`
- `model.routing.set`
- `model.routing.useLocal`
- `model.routing.useCloud`
- `model.generate`
- `model.embedding`
- `model.capabilities`

## Commands

```sh
bun run --cwd elizalaunch/remotes/local-model typecheck
bun run --cwd elizalaunch/remotes/local-model build
bun run --cwd elizalaunch/remotes/local-model smoke
bun run --cwd elizalaunch/remotes/local-model smoke:phase8
```

Live Hugging Face metadata check:

```sh
ELIZA_PHASE8_HF_NETWORK=1 bun run --cwd elizalaunch/remotes/local-model smoke:phase8
```

Live runtime API check:

```sh
ELIZA_PHASE8_LIVE_API=1 bun run --cwd elizalaunch/remotes/local-model smoke:phase8
```

## Env Vars

- `ELIZA_MODEL_HF_REPO`, default `elizaos/eliza-1`
- `HF_TOKEN`
- `ELIZA_MODEL_HF_DISABLE_NETWORK=1`
- `ELIZA_RUNTIME_API_BASE`
- `ELIZA_DESKTOP_API_BASE`
- `ELIZA_RUNTIME_API_TOKEN`
- `ELIZA_API_TOKEN`
- `ELIZA_PHASE8_HF_NETWORK=1`
- `ELIZA_PHASE8_LIVE_API=1`

## Packaging Boundary

The upstream Electrobun module system still names its package manifest `plugin.json` and config fields `build.remote plugin` / `remote pluginOnly`. Those names are kept only at the packaging boundary.

## Limitations

- Smoke tests do not download real model files.
- Missing local inference routes return structured errors.
- Download progress events depend on host event forwarding; polling through `model.downloads`, `model.active`, and `model.hub` is sufficient for Phase 8.
- This Remote does not replace the existing elizaOS local inference plugin.
