# `@elizaos/app-core`

Shared React state, onboarding, API client, and shell helpers for Eliza desktop/web shells.

## Where to read first

| Topic | Why start here |
|-------|----------------|
| **Wizard step order vs connection subflow** | [`src/onboarding/README.md`](src/onboarding/README.md) — explains **`flow.ts`** vs **`connection-flow.ts`** so you do not mix “next step id” with “which connection panel.” |
| **Connection screens** | [`src/components/onboarding/connection/README.md`](src/components/onboarding/connection/README.md) — file map, OAuth tradeoffs, Eliza OAuth auto-advance hook. |
| **Product name in translations** | [`src/config/branding.ts`](src/config/branding.ts) — **`DEFAULT_APP_DISPLAY_NAME`**, **`appNameInterpolationVars`** for `{{appName}}` in locale JSON. **Why:** white-label shells override `BrandingContext`; copy must not hardcode “Eliza.” |
| **End-user narrative** | Repo root [`docs/guides/onboarding-ui-flow.md`](../../docs/guides/onboarding-ui-flow.md) |
| **Settings layout & spacing (WHYs)** | [`docs/settings-ui-design.md`](docs/settings-ui-design.md) — scroll/padding stack, `border-t` + `pt-6` convention, Eliza Cloud tier sentinels, footer, Capabilities vs Permissions headings. **Why:** keep visual and copy decisions intentional across contributors. |
| **AI Model provider switch (WHYs)** | **Source:** `src/components/settings/ProviderSwitcher.tsx`, `FeaturesStep.tsx`, `ApiKeyConfig.tsx`. **Index:** [`docs/ai-model-settings-and-provider-switch-whys.md`](docs/ai-model-settings-and-provider-switch-whys.md). |

## Desktop-only behavior

Native menus and IPC are not in this package; the Electrobun app forwards certain actions to the renderer (e.g. **Reset Eliza…**) so **`handleReset`** stays the single source of truth. See [`docs/apps/desktop.md`](../../docs/apps/desktop.md).
