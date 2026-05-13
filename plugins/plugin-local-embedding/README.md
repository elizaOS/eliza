# Local Embedding Compatibility Shim

`@elizaos/plugin-local-embedding` is deprecated. It now exports the same
provider object as `@elizaos/plugin-local-inference` so older configs keep
loading without creating a second local provider choice.

Use `@elizaos/plugin-local-inference` for new work. Local model downloads and
custom model selection are handled through the Eliza-1 local inference model
hub; custom models must be explicitly searched for and downloaded there.

The shim preserves these legacy exports:

- `default`
- `localEmbeddingPlugin`
- `localAiPlugin`

All three point to the unified `eliza-local-inference` provider.
