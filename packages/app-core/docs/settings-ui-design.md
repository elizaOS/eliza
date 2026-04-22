# Settings UI — layout, spacing, and Eliza Cloud model UX

This document records **why** the Settings experience looks the way it does. Read it before changing paddings, section titles, or cloud model defaults so we do not oscillate between incompatible patterns.

**See also (behavior):** rationale lives in **file headers** — `src/components/settings/ProviderSwitcher.tsx`, `src/components/onboarding/FeaturesStep.tsx`, `src/components/settings/ApiKeyConfig.tsx`, `src/components/local-inference/LocalInferencePanel.tsx`, and `packages/agent/src/api/provider-switch-config.ts`. Pointers only: [`ai-model-settings-and-provider-switch-whys.md`](./ai-model-settings-and-provider-switch-whys.md), Milady [`docs/runtime/self-hosted-llm-inference-whys.md`](../../../../docs/runtime/self-hosted-llm-inference-whys.md) §8.

**Code anchors**

| Area | Primary files |
|------|----------------|
| Settings shell + scroll/padding | [`src/components/pages/SettingsView.tsx`](../src/components/pages/SettingsView.tsx) |
| Page chrome + footer | [`workspace-layout.tsx`](../../ui/src/layouts/workspace-layout/workspace-layout.tsx) |
| AI provider + cloud tiers | [`src/components/settings/ProviderSwitcher.tsx`](../src/components/settings/ProviderSwitcher.tsx), [`src/components/settings/cloud-model-schema.ts`](../src/components/settings/cloud-model-schema.ts) |
| Section dividers inside panels | [`ApiKeyConfig`](../src/components/settings/ApiKeyConfig.tsx), [`SubscriptionStatus`](../src/components/settings/SubscriptionStatus.tsx), [`PermissionsSection`](../src/components/settings/PermissionsSection.tsx), [`FeatureTogglesSection`](../src/components/settings/FeatureTogglesSection.tsx), [`LocalInferencePanel`](../src/components/local-inference/LocalInferencePanel.tsx) |

---

## 1. Settings scroll column (`SETTINGS_CONTENT_CLASS`)

**What:** The scrollable `main` region uses shared `WorkspaceLayout` horizontal padding (`px-4` → `lg:px-7`). Settings adds a light tint, scroll smoothing, scrollbar gutter, and `scroll-padding-top` for in-page section alignment.

**Why**

- **Single owner for bottom padding:** We intentionally avoid putting large `pb-*` on both the scroll `main` *and* the inner section stack. Stacking two bottom paddings made the end of the list feel like “mystery whitespace” and made it unclear which layer to tune.
- **`scroll-padding-top: 7rem`:** Linked sidebar selection scrolls sections into view; padding prevents headers from sitting under sticky chrome.
- **`scrollbar-gutter: stable`:** Avoids horizontal layout shift when the scrollbar appears.

**Do not**

- Reintroduce `pb-14` / `pb-16` on the inner stack while also growing `SETTINGS_CONTENT_CLASS` bottom padding — pick **one** layer for end-gutter.
- Remove `scroll-padding-top` without re-testing `useLinkedSidebarSelection` scroll alignment.

---

## 2. Section stack rhythm (`SETTINGS_SECTION_STACK_CLASS`)

**What:** `space-y-6 sm:space-y-8` between major `PagePanel` sections.

**Why**

- Matches the density of other long-form app surfaces and keeps cards visually separated without arbitrary one-off margins.
- `ProviderSwitcher` uses **`space-y-6`** so the “AI Model” block does not feel tighter than the sections above/below it.

---

## 3. Horizontal dividers inside a panel (`border-t border-border/40 pt-6`)

**What:** Secondary blocks inside a single settings section (e.g. cloud login vs tier grid, API key footer rows, LifeOps feature header) use the same top border token and **`pt-6`** after the rule.

**Why**

- **`pt-4` vs `pt-6`:** Mixed values made some screens feel “cramped” next to others. **`pt-6`** aligns with the AI Model cloud strips and the local-runtime strip in `SettingsView` (`mt-6 border-t … pt-6`).
- **Same border opacity:** `border-border/40` keeps hierarchy below full section borders.

**Do not**

- Use `pt-4` on new `border-t border-border/40` blocks in Settings without updating this doc — if you truly need tighter density, document the exception *here* and keep it rare (dense tables are a better exception target than section breaks).

---

## 4. Nav order vs scroll order (`SETTINGS_SECTIONS` ↔ `sectionsContent`)

**What:** The sidebar lists `SETTINGS_SECTIONS` in array order. The scroll spy (`useLinkedSidebarSelection` + `handleScroll` on `contentContainerRef`) maps **visible** section ids to `#id` nodes in the DOM. Those ids must appear in the **same vertical order** in `sectionsContent` as in `SETTINGS_SECTIONS`.

**Why**

- If JSX order diverges (e.g. Features before Permissions in nav but Permissions before Features on the page), the wrong row highlights while scrolling and it feels broken.
- **Exception:** Blocks without a section id (e.g. `LocalAiExternalRuntimesStrip` wrapper) sit between real sections for layout reasons; they are not part of scroll-to-section alignment.

**Do not**

- Reorder `sectionsContent` without updating `SETTINGS_SECTIONS` (or vice versa) unless you intentionally change product order everywhere.
- Add a `SETTINGS_SECTIONS` entry without **`settings.sections.<id>.label`** (and usually `.desc`) in locale JSON. The sidebar calls `t(section.label)` with **no** `defaultValue`, so missing keys show up as blank or raw key paths in the nav.

---

## 5. Settings sidebar (`Sidebar`)

**What:** Nav items use `space-y-2`. We removed `mobileMeta` repeating the active section title because the active row already shows the label.

**Why**

- **Duplicate “Capabilities” (and other labels):** `mobileMeta` under “Settings” repeated the same string as the selected nav item and read as a second heading.
- **`space-y-2`:** Slightly more air than `space-y-1.5` so the list matches the main column’s vertical rhythm.

---

## 6. Capabilities vs Permissions copy

**What**

- **Settings → Capabilities:** Wallet / Browser / Computer Use toggles. Section may omit a redundant panel description because the sidebar already carries the blurb.
- **Settings → Permissions → “Plugin toggles”:** Desktop view lists plugin enablement after OS permissions. That heading is **not** the same as Settings → Capabilities.

**Why**

- Two different concepts were both labeled “Capabilities”, which looked like duplicate sections when scrolling.
- Permissions block is about **plugins gated by OS permissions** — the heading reflects that.

**Do not**

- Rename “Plugin toggles” back to “Capabilities” without resolving the duplicate-heading problem again.

---

## 7. Eliza Cloud model tiers (`cloud-model-schema.ts` + `ProviderSwitcher`)

**What**

- Each tier has a sentinel value (`DEFAULT_CLOUD_TIER_SENTINEL`) shown as **`Default (<display name>)`** with the concrete model id in the description.
- Persisted config stores **resolved** OpenRouter-style ids; sentinels are UI + normalization.
- `DEFAULT_ELIZA_CLOUD_TIER_MODEL_IDS` is the single canonical default map (must stay aligned with server defaults).

**Why**

- **“Select…” / empty selects:** `ConfigRenderer` treats unset keys as empty; tier enums had no default row, so the control showed a placeholder. Response handler / planner already used sentinel defaults — tiers now follow the same pattern.
- **Removing the default id from the enum list:** Avoids two menu rows for the same id (sentinel row + catalog row).
- **Required fields:** Tier + override fields are `required` in schema so optional selects do not show a “None” row that reads like “off” vs “default”.
- **Coercion on cloud:** When switching to Eliza Cloud, invalid ids (e.g. from a local provider) are reset to the tier sentinel so enums always match.

**Do not**

- Store sentinels in `models` in the database without resolving — save path must map to real ids.
- Add tier `default` in JSON Schema *instead of* sentinels without revisiting empty-value and enum-match behavior in `ConfigRenderer`.

---

## 8. `PageLayout` / `WorkspaceLayout` footer

**What:** `footer` renders **below** the sidebar + `main` row, with `border-t`, light `bg-bg/40`, and horizontal padding aligned to `contentPadding`.

**Why**

- **Previously ignored:** `SettingsView` (and wallet, automations, character) passed `footer` but it never rendered — widget slots were effectively dead for layout.
- **Visual consistency:** Same horizontal inset as scroll content so the strip does not “float” wider than the page.

**Do not**

- Move footer inside scrollable `main` without an explicit product decision — sticky footers vs scrolling footers change how much bottom padding the section stack needs.

---

## Roadmap (intentional follow-ups)

These are **not** bugs; they are larger consistency passes. Do them deliberately, not drive-by.

1. **Card vs `PagePanel`:** `VoiceConfigView` / `TrainingSettings` use `Card` primitives while most settings use `PagePanel.CollapsibleSection`. Unify only if we adopt one visual language for all long settings forms.
2. **Locale coverage:** `permissionssection.pluginTogglesHeading` and cloud default labels may need non-English entries in `src/i18n/locales/*.json` (today `t()` `defaultValue` covers gaps).
3. **Dense forms:** `EmbeddingGenerationSettings` intentionally uses smaller `space-y-*`; do not force `space-y-6` inside without redesigning density.
4. **Biome “unsafe” cleanups:** `FeatureTogglesSection` (`noUselessSwitchCase`) and `SubscriptionStatus` (`noUselessFragments`) — optional; not user-visible.

---

## Changelog

Project-level package history for `@elizaos/app-core` lives in [`CHANGELOG.md`](../CHANGELOG.md) (Keep a Changelog format). Add user-visible Settings / layout changes there when you ship behavior or copy updates.
