# Changelog

All notable changes to **`@elizaos/app-core`** are documented here. This package powers Milady / elizaOS shells (settings, onboarding, API client, shared components).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) where version bumps apply.

## [Unreleased]

### Added

- **Documentation:** [`docs/settings-ui-design.md`](./docs/settings-ui-design.md) — canonical **WHYs** for Settings layout, Eliza Cloud model tier UX, footer behavior, and divider spacing. **Reason:** prevent design churn (padding / labels / defaults oscillating without shared rationale).
- **Documentation:** [`docs/ai-model-settings-and-provider-switch-whys.md`](./docs/ai-model-settings-and-provider-switch-whys.md) now **indexes** the same topics; prose WHYs moved to **file headers** (`ProviderSwitcher.tsx`, `FeaturesStep.tsx`, `ApiKeyConfig.tsx`, `build-unified-ai-providers.ts`, `EmbeddingGenerationSettings.tsx`, agent `provider-switch-config.ts`).

### Changed

- **Settings visual rhythm:** Normalized `border-t border-border/40` follow-up spacing to **`pt-6`** and aligned related **`mt-*`** / **`space-y-*`** values across settings panels (`ApiKeyConfig`, `SubscriptionStatus`, `PermissionsSection`, `FeatureTogglesSection`, `LocalInferencePanel`, `ReleaseCenterView`) so scrolling Settings does not mix `pt-4` / `pt-5` / `pt-6` arbitrarily. **Why:** one vertical language is easier to tune and less “random” to users.
- **Settings scroll / footer:** `WorkspaceLayout` now **renders** `footer` (was previously dropped). Settings uses symmetric footer padding. **Why:** widget strips and credits must align with content width; dead props hid real layout bugs.
- **Eliza Cloud model UI:** Tier selects use sentinel **“Default (…)”** rows; `cloud-model-schema` owns default ids; `ProviderSwitcher` normalizes load/save. **Why:** remove empty “Select…” state and match response-handler / planner pattern.
- **Capabilities copy:** Removed duplicate “Capabilities” headings (`mobileMeta`, redundant panel description, Permissions subsection title → plugin-focused label). **Why:** one concept per visible title.

### Fixed

- **Provider switch reliability (`ProviderSwitcher`):** `switchProvider` now retries on **`ApiError`** with `kind` **`network`** / **`timeout`** or HTTP **502 / 503 / 504** (bounded attempts + backoff). **WHY:** runtime restart and gateway warmup are transient; a single 503 should not force the user to re-select the same provider.
- **Provider `Select` stability:** `lastClampedProviderSelectValueRef` + `providerSelectLocked` keep a Radix-valid `value` when `providerChoiceIds` briefly drops the active id during `loadPlugins`. **WHY:** invalid `value` breaks Radix and snaps UX to the wrong row.
- **Selection vs catalog lag:** Orphan-selection `useEffect` skips while locked and avoids clearing ids still recognized by **`getOnboardingProviderOption`**. **WHY:** plugin list refresh is slower than the static onboarding catalog — do not treat “missing row” as “user has no provider.”
- **Vite HMR circular import:** `FeaturesStep` imports **`Button` / `cn` from `@elizaos/ui`** instead of **`@elizaos/app-core`**. **WHY:** the app-core package entry re-exports the full **`components` barrel**; onboarding → barrel → `ProviderSwitcher` → … recreated a cycle and forced full reload on every `ProviderSwitcher` edit.
- **Stacked bottom padding** on Settings scroll surface (duplicate `pb` on inner stack + `main`). **Why:** single owner avoids unexplained whitespace at end of scroll.
- **Settings nav vs page order:** Reordered `sectionsContent` so **Features** (`feature-toggles`) appears before **Permissions**, matching `SETTINGS_SECTIONS` and scroll-linked highlighting. **Why:** mismatched DOM order made the active nav item disagree with what was on screen.
- **Settings nav label for Auto-training:** Added missing i18n keys `settings.sections.autoTraining.label` / `.desc` (sidebar uses `t(section.label)` without inline defaults). **Why:** absent keys produced an empty or raw-key nav label.
