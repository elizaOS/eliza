# AI Model settings — where the WHYs live

**Rationale is maintained in source comments**, not in this file (so it stays next to the code people edit).

| Topic | Read first |
|-------|------------|
| Provider switch, retries, Radix `Select` lock, `ApiKeyConfig` visibility, `loadPlugins` races | `src/components/settings/ProviderSwitcher.tsx` (file header) |
| Onboarding → avoid app-core barrel / Vite HMR | `src/components/onboarding/FeaturesStep.tsx` (top `WHY` comment) |
| Per-provider env form | `src/components/settings/ApiKeyConfig.tsx` (file header) |
| Settings vs onboarding catalog merge | `src/components/settings/build-unified-ai-providers.ts` (file header) |
| Embedding env next to AI Model | `src/components/settings/EmbeddingGenerationSettings.tsx` (file header) |
| OpenAI base URL when switching provider | `packages/agent/src/api/provider-switch-config.ts` (comments near `OPENAI_BASE_URL`) |

**Layout / spacing only** (not behavior): [`settings-ui-design.md`](./settings-ui-design.md)

---

## Changelog

Ship user-visible behavior changes under [`CHANGELOG.md`](../CHANGELOG.md) `[Unreleased]` so release notes stay accurate.
