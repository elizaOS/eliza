# Issue #14386 — Settings Reset Controls

Date: 2026-07-05

## Verified

- Removed the Settings `advanced-reset-open` and `advanced-reset-confirm` agent-surface controls.
- Removed the visible Settings danger-zone reset row and confirmation dialog from `AdvancedSection`.
- Renamed the visible Settings section from `Backup & Reset` to `Backups` and updated locale descriptions so the normal Settings path no longer advertises a reset/wipe action.

## Checks

```bash
bun run --cwd packages/ui test -- src/components/settings/AdvancedSection.test.tsx
```

Result: 1 file passed, 7 tests passed.

```bash
bunx @biomejs/biome check packages/ui/src/components/settings/AdvancedSection.tsx packages/ui/src/components/settings/AdvancedSection.test.tsx packages/ui/src/components/settings/AdvancedSection.stories.tsx packages/ui/src/components/settings/settings-sections.ts packages/ui/src/components/settings/settings-section-meta.ts packages/ui/src/i18n/locales/en.json packages/ui/src/i18n/locales/es.json packages/ui/src/i18n/locales/vi.json packages/ui/src/i18n/locales/ko.json packages/ui/src/i18n/locales/tl.json packages/ui/src/i18n/locales/pt.json packages/ui/src/i18n/locales/zh-CN.json packages/ui/src/i18n/locales/ja.json
```

Result: checked 13 files, no errors.

```bash
git diff --check
```

Result: no whitespace errors.

```bash
rg -n "advanced-reset|settings\\.resetEverything|settings\\.resetAgent|settings\\.resetConfirm|settings\\.dangerZone|Backup & Reset|wipe everything|start over" packages/ui/src/components/settings packages/ui/src/components/pages/SettingsView.tsx packages/ui/src/components/settings/AdvancedSection.stories.tsx
```

Result: only the negative assertions in `AdvancedSection.test.tsx` match.

## App Audit

Attempted:

```bash
ELIZA_NODE_PATH=/Users/shawwalters/.nvm/versions/node/v24.15.0/bin/node ELIZA_UI_SMOKE_PORT=2254 ELIZA_UI_SMOKE_API_PORT=32354 bun run --cwd packages/app audit:app
```

Result: blocked before screenshots during app renderer build. The local install/worktree layout mixed main-checkout built artifacts with this worktree source aliases and failed with:

```text
packages/shared/dist/config/boot-config-store.js: "syncBrandEnvToEliza" is not exported by "../core/src/index.browser.ts"
```

Earlier attempts also exposed missing non-hoisted install links in the temporary worktree (`@tanstack/react-query`, `get-east-asian-width`) after disk cleanup. No app screenshots were produced in this environment.

