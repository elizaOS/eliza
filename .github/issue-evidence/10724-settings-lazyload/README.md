# #10724 — lazy-load the settings section graph off the boot path

Epic #10724 DoD: *each shipped optimization has a measured improvement*. This
slice delivers the ranked eager-boot lazy-load win for the settings section
component graph.

## Root cause

The section **body components** were already lazy (`React.lazy`, #11351), but
the module that wraps them — `packages/ui/src/components/settings/settings-sections.ts`
— was still dragged onto the first-paint critical path. Both eager boot barrels
re-exported the registry accessors from it:

- `packages/ui/src/index.ts` (`@elizaos/ui`)
- `packages/ui/src/browser.ts` (`@elizaos/ui/browser`)

```ts
export {
  getAllSettingsSections, getSettingsSection,
  listSettingsSections, registerSettingsSection,
  type SettingsSectionDef,
} from "./components/settings/settings-sections"; // <- heavy module
```

Those four accessors + the type actually live in the **light**
`settings-section-registry.ts` (only `import type` — `LucideIcon`,
`ComponentType`, `ViewKind`, `SettingsSectionGroup` — zero runtime deps). The
re-export forced `settings-sections.ts` to evaluate at boot, which pulled in:

- ~20 eager `lucide-react` icon chunks,
- the eager cloud-connectors upsell components (`cloud/connectors` →
  `CloudSettingsSectionShell` + `CloudConnectorsUpsell`), imported non-lazily,
- the built-in section **registration side effects**.

Verified pre-change: the registration marker string `"Missing settings-section
visuals"` lived inside the **eager** `main-*.js` chunk that `index.html` loads.

## Fix

- Move `getAllSettingsSections` into the light `settings-section-registry.ts`
  (it is an alias of `listSettingsSections`).
- Repoint both barrels' re-exports from `settings-sections` →
  `settings-section-registry`.
- `settings-sections.ts` re-exports `getAllSettingsSections` from the registry
  for its own internal use; it now loads **only** when the already-lazy
  `SettingsView` (`App.tsx` `lazyNamedView(() => import("./components/pages/SettingsView"))`)
  imports it, where the registration side effects still run.

No component, no registry data, and no render logic changed — only the output
**chunk** a module lands in. The change is render-neutral by construction.

## Measured improvement — production build (`packages/app`), brotli

Tool: `node packages/benchmarks/loadperf/bundle-kpi.mjs` (measures the on-disk
`packages/app/dist`). Full JSON: `bundle-kpi-before.json`, `bundle-kpi-after.json`.

| metric (brotli)                              | before   | after    | delta            |
|----------------------------------------------|----------|----------|------------------|
| **initial entry** (first-paint import closure) | 2552.0 KB | 2311.5 KB | **−240.4 KB (−9.4%)** |
| chunks on first paint (initial-entry files)  | 321      | 263      | −58 files        |
| eager chunk count                            | 397      | 360      | −37 chunks       |
| eager first-paint total                      | 2858.9 KB | 2841.1 KB | −17.7 KB (−0.6%) |

- The **initial entry** is exactly what `index.html` loads eagerly to first
  paint — it drops **240.4 KB brotli / 58 fewer network chunks**.
- The registration marker moved from the eager `main-*.js` chunk into the
  **lazy `SettingsView-*.js` chunk (37 KB on disk)** — confirmed absent from
  `index.html` after the change.
- Honest note: the *total* eager set moved only −17.7 KB because the section
  **bodies** were already lazy (#11351) and rollup re-merged a few small eager
  chunks into `main`. The real, boot-critical win is on the initial-entry
  first-paint closure (−240 KB), which is the metric that blocks first paint.

## Render verification

- `packages/ui` unit + component suite for the settings surface: **213 tests
  passing** (21 files), incl. `SettingsView.test.tsx` (renders the view + error
  boundaries) and `register-cloud-settings.test.ts`.
- New regression test `settings-sections.registration.test.ts`: proves that
  loading the heavy module (as the lazy `SettingsView` does) still registers
  every canonical built-in section **and** the registry-contributed
  `cloud-overview` / `cloud-agents` / `my-runtimes` sections. **2/2 passing.**
- `bun run --cwd packages/ui typecheck` — clean.
- `bun run --cwd packages/ui lint` (biome) — clean, 0 fixes.
- Production `packages/app` build — succeeds; `settings-sections` compiles into
  the lazy `SettingsView` chunk.
- `bun run --cwd packages/app audit:app` (mandated visual loop): see
  `audit-app-status.md` for the real outcome in this environment.

## Files changed

- `packages/ui/src/index.ts` — repoint barrel re-export to the light registry.
- `packages/ui/src/browser.ts` — repoint barrel re-export to the light registry.
- `packages/ui/src/components/settings/settings-section-registry.ts` — add
  `getAllSettingsSections`.
- `packages/ui/src/components/settings/settings-sections.ts` — re-export
  `getAllSettingsSections` from the registry; drop the local duplicate; drop the
  now-unused `listSettingsSections` import.
- `packages/ui/src/components/settings/settings-sections.registration.test.ts`
  — new registration-integrity test.
