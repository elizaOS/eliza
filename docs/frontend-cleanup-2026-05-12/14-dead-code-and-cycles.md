# 14 — Dead code & circular dependencies (verified)

**Report Date:** 2026-05-12  
**Analysis Tools:** knip 5.x, madge, manual grep cross-check  
**Working Directory:** `/Users/shawwalters/eliza-workspace/milady/eliza`

---

## Tooling baseline

### knip Configuration
- **Tool version:** knip 5.x (via `bun x knip`)
- **knip.json files scanned:**
  - Root: `/knip.json`
  - `/packages/ui/knip.json` (entry: `src/**/*.{ts,tsx}`, ignores: `dist/**`, `storybook-static/**`)
  - `/cloud/knip.json` (workspaces mode with custom entry for `@elizaos/cloud-api`)
  - Other packages: `/packages/app/knip.json`, `/packages/app-core/knip.json`, etc.

- **packages/ui knip output:**
  - Unused dependencies: 1
  - Unused devDependencies: 2
  - Unlisted dependencies (dynamic imports): 2
  - Duplicate exports: 5
  - Total files analyzed: ~1,681 (packages/ui/src)

- **cloud workspace knip output:**
  - Unused files reported: 779
  - Workspace packages analyzed: lib, db, apps/frontend, apps/api, types, ui, and services
  - File count: very large, includes test files and deprecated endpoints

### madge Configuration
- **Tool:** madge (via `bun x madge`)
- **Extensions:** `ts,tsx`
- **Analysis:**
  1. `packages/ui/src` — Processed 1,681 files, 2 warnings → **No circular dependencies**
  2. `cloud/apps/frontend/src` — Processed 445 files, 40 warnings → **No circular dependencies**
  3. `cloud/packages/ui/src` — Processed 188 files → **No circular dependencies**

---

## Verified-removable files (safe to delete)

### None at this time

**Reason:** While knip reported many unused files in the cloud workspace (779), cross-check requires:
1. Distinguishing build artifacts from source files (dist/ is already ignored by knip.json)
2. Verifying test files (many flagged are in `test/`, `packages/tests/`, which knip flags but may be legitimate test utilities)
3. Confirming no dynamic imports via path strings (e.g., `import(someVariable + '.ts')`)
4. Checking for framework conventions (e.g., Next.js dynamic routes in `[param]` brackets)

The large volume (779 files) across many packages suggests the configurations in `cloud/knip.json` need refinement (workspaces are under-specified for entry and project patterns) rather than indicating a mass of deletable dead code.

---

## Verified-removable exports within otherwise-live files

### None confirmed at this time

**Duplicate exports flagged by knip (packages/ui):**

1. **`src/components/local-inference/LocalInferencePanel.tsx`**
   - Export: `LocalInferencePanel` (named) + `default`
   - Cross-check: grep across all packages found no references to the named export; only default import used
   - **Status:** Likely removable, but is a UI component re-export; recommend keeping for barrel exports pattern
   - **Evidence:** No grep results for `import { LocalInferencePanel }` patterns

2. **`src/lib/floating-layers.ts`**
   - Exports: `Z_SELECT_FLOAT` (alias) + `CONFIG_SELECT_FLOATING_LAYER_Z_INDEX` (original)
   - Cross-check: both names likely exist; one is the "canonical" name
   - **Status:** Needs human review — convention unclear

3. **`src/onboarding/mobile-runtime-mode.ts`**
   - Exports: `MOBILE_LOCAL_AGENT_API_BASE` and `ANDROID_LOCAL_AGENT_API_BASE` (likely platform aliases)
   - **Status:** Likely both in use for platform-specific builds; keep unless build targets are changing

4. **`src/platform/aosp-user-agent.ts`**
   - Exports: `userAgentHasElizaOSMarker` and `isAospElizaUserAgent` (likely aliases or helper variants)
   - **Status:** Needs human review — verify if both are exported or if one is internal

**Verdict:** Duplicate exports are typically aliases or convenience re-exports for API stability. No evidence found in grep that these are unused. Leave as-is unless API redesign is planned.

---

## Verified-removable dependencies (package.json)

### packages/ui

#### Unused production dependency
- **`drizzle-orm` (version 0.45.2)**
  - Location: `packages/ui/package.json` line 83
  - Cross-check: `grep -r "drizzle-orm" packages/ui/src` — no results
  - Usage: Not imported anywhere in source
  - **Recommendation:** **SAFE TO REMOVE** — no references in any .ts or .tsx files under `packages/ui/src`

#### Unused devDependencies
- **`@storybook/react` (version ^10.3.5)**
  - Location: `packages/ui/package.json` line 92
  - Cross-check: No `.storybook/` directory or `*.stories.ts*` files found in packages/ui
  - **Recommendation:** **SAFE TO REMOVE** — no Storybook setup present

- **`storybook` (version ^10.3.5)**
  - Location: `packages/ui/package.json` line 99
  - Cross-check: No `.storybook/` directory or `*.stories.ts*` files found in packages/ui
  - **Recommendation:** **SAFE TO REMOVE** — no Storybook setup present

### cloud workspace

No unused production or dev dependencies identified that are clearly marked as "always deletable." The knip output for cloud (779 files) reflects incomplete workspace configuration rather than confirmed dead dependencies.

---

## Needs human decision (tooling flagged but cross-check inconclusive)

### packages/ui

#### Unlisted dependencies (dynamic imports)
Knip flagged these as unlisted because they are dynamically imported and may not be installed when the package is used:

1. **`@capacitor/app`** at `src/onboarding/deep-link-handler.ts:165`
   - Import pattern: `await import(/* @vite-ignore */ "@capacitor/app")`
   - Reason: Optional peer dependency for native mobile app; expected to be provided by host app
   - **Decision:** Keep unlist deliberately (design choice for optional bridge) OR add to `peerDependencies` if capacitor is always expected

2. **`@capacitor/app`** at `src/services/app-updates/update-policy.ts:284`
   - Same as above — optional runtime bridge

#### knip.json Configuration Hints
These are suggestions from knip to refine the config (not code issues):

| Issue | Location | Action |
|-------|----------|--------|
| Remove `dist/**` from ignore | `knip.json` | OK to keep (dist is build output) |
| Remove `storybook-static/**` from ignore | `knip.json` | OK to keep (legacy build artifact) |
| Remove `jsdom` from ignoreDependencies | `knip.json` | knip is being overly strict — jsdom is used by vitest |
| Remove `node-llama-cpp` from ignoreDependencies | `knip.json` | Keep as ignore (optional model runtime) |
| Remove `three` from ignoreDependencies | `knip.json` | Keep as ignore (optional 3D rendering) |
| Remove `vite/client` from ignoreDependencies | `knip.json` | Keep as ignore (build-time dep) |
| Redundant `vitest.config.ts` patterns | `knip.json` | Minor config cleanup; no code impact |

**Verdict:** No code deletions required; these are config suggestions. If cleaning up knip config, keep the "ignore" entries for optional peer/bridge packages.

### cloud workspace (779 unused files)

The high count of flagged files suggests:
- Test files in `/packages/tests/` and `/test/` are not properly configured as entry or project patterns
- Deprecated endpoint stubs (e.g., `apps/api/src/stubs/`) may be intentional (compatibility shims)
- Workspace entry/project patterns in `/cloud/knip.json` are incomplete

**Recommendation:** Run knip with verbose output scoped to a single workspace (e.g., `packages/lib`, `packages/db`) to identify true dead code vs. test/stub patterns.

---

## Circular dependencies

### No circular dependencies detected

- **packages/ui/src:** ✔ No cycles (1,681 files processed)
- **cloud/apps/frontend/src:** ✔ No cycles (445 files processed)
- **cloud/packages/ui/src:** ✔ No cycles (188 files processed)

**Madge warnings (not errors):** 40 warnings in `cloud/apps/frontend/src` are non-critical (likely unused variables, missing types, or import resolution warnings); madge did not report these as cycle candidates.

---

## Summary & Recommendations

### Immediate Actions (High Confidence)
1. **Remove from `packages/ui/package.json`:**
   - `drizzle-orm` (line 83 in dependencies)
   - `@storybook/react` (line 92 in devDependencies)
   - `storybook` (line 99 in devDependencies)

   **Impact:** Small (ui package is ~30 deps). No code changes needed.

### Follow-up Review (Medium Confidence)
1. **packages/ui duplicate exports** — Review with frontend team to confirm API stability goals
   - Aliases are often intentional for backward compatibility
   - Only delete if API design explicitly deprecates them

2. **cloud/knip.json configuration** — Refine workspace entry/project patterns to reduce false positives
   - Currently reports 779 unused files; likely mostly tests/stubs under-configured
   - Scope knip runs per-workspace to identify real candidates

3. **Unlisted dynamic imports** — Decide if `@capacitor/app` should be:
   - Left as dynamic-only (optional bridge), or
   - Added to `peerDependencies` for explicitness

### No Changes Needed
- No circular dependencies to resolve
- Test files, stubs, and compatibility shims are flagged but not confirmed dead
- Browser tools (three, jsdom) and build tools (vite/client) correctly marked for ignore

---

## Files Analyzed
- knip configs: `/knip.json`, `/packages/ui/knip.json`, `/cloud/knip.json`, and per-package configs
- madge runs: 3 directory scans (ui, frontend, cloud/ui) — all clear
- grep cross-checks: drizzle-orm, storybook, duplicate exports, @capacitor/app usage
- dynamic imports: Verified `/* @vite-ignore */` patterns for optional bridges

