---
title: Themes & Avatars
sidebarTitle: Themes & Avatars
description: Customize the Eliza dashboard with the supported light and dark themes, plus the built-in VRM companion avatars.
---

Eliza currently supports two production themes: `light` and `dark`.

These themes drive the dashboard and app shell through shared semantic CSS tokens. Avatars are a separate customization layer that controls the companion character, not the global color system.

## Theme Contract

Eliza applies the active theme to the document root by setting:

- `data-theme="light"` or `data-theme="dark"`
- the `.dark` class when the theme is dark
- the `color-scheme` style so browser-native controls match the active mode

The runtime stores the preference in local storage under `eliza:ui-theme` and still reads the legacy `eliza:ui-theme` key during migration.

The live theme type is effectively:

```ts
type UiTheme = "light" | "dark";
```

Any unsupported or stale value is normalized back to `dark`.

## How Theme Switching Works

1. The user chooses `light` or `dark` in the UI.
2. The app normalizes the value through `normalizeUiTheme()`.
3. `applyUiTheme()` updates the root `data-theme`, `.dark` class, and `color-scheme`.
4. `saveUiTheme()` persists the normalized value for the next launch.

The core implementation lives in:

- `eliza/packages/app-core/src/state/persistence.ts`
- `eliza/packages/app-core/src/styles/base.css`
- `eliza/packages/app-core/src/styles/styles.css`

## CSS Architecture

Eliza uses a semantic token system instead of per-theme component overrides.

- `eliza/packages/app-core/src/styles/base.css` defines the token values for the default light theme and the `[data-theme="dark"], .dark` overrides.
- `eliza/packages/app-core/src/styles/styles.css` maps those CSS custom properties into the utility layer so shared components can stay theme-aware without hardcoding colors.
- `@elizaos/app-core` components consume semantic surface, border, text, accent, and state tokens rather than inventing local palettes.

This is the contract new UI work should follow. If a surface needs a stronger brand treatment, it should extend the shared token system rather than introducing a third theme family.

## Available Themes

### `light`

The light theme uses white and pale-neutral surfaces, darker charcoal text, and a saturated yellow accent. It is intended for high-legibility desktop and tablet use, and it keeps elevated surfaces visually distinct without introducing a separate design language.

### `dark`

The dark theme is the default. It uses darker shells, brighter foreground text, and the same yellow accent family so the app core, overlays, and shared controls remain visually coherent without slipping into amber or champagne-gold drift.

## Semantic Tokens

The token categories shared across both themes include:

- surfaces: `--bg`, `--bg-elevated`, `--surface`, `--card`
- text: `--text`, `--text-strong`, `--muted`, `--muted-strong`
- borders and inputs: `--border`, `--border-strong`, `--input`, `--ring`
- accent and actions: `--accent`, `--accent-hover`, `--primary`
- status: `--ok`, `--warn`, `--danger`, `--destructive`

New components should use these semantic tokens or their utility mappings. Component-local hex values should be reserved for media or one-off artwork, not reusable UI controls.

## Avatars

Eliza also includes built-in VRM companion avatars. Avatar selection is independent from the light/dark theme choice:

- the theme controls the dashboard and shell styling
- the avatar controls the companion character shown in supported chat and companion views

Avatar-specific settings, emotes, and rendering behavior are part of the companion system and should not be treated as theme variants.

## Guidance For Contributors

- Treat `light` and `dark` as the only supported UI themes unless product requirements change.
- Do not add surface-level theme names in docs, config examples, or tests unless the runtime supports them.
- Prefer semantic tokens over local color decisions.
- If you need a branded or onboarding-specific look, scope it as a surface extension on top of the shared token contract.
