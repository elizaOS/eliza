# `@elizaos/ui` code-quality audit

Audit date: 2026-08-02

## Refactor implementation status

The compatible cleanup and refactor pass is complete. The package remains one
physical workspace by product decision: API clients, the app shell, cloud UI,
and primitives stay under `packages/ui`, separated by supported export
subpaths and enforced import boundaries. No `packages/ui-client`,
`packages/app-shell`, or `packages/cloud-ui` facade packages are part of the
target architecture.

Completed in this refactor:

- Replaced the catch-all Knip entry configuration with the real package entry
  graph, removed orphaned modules, and added a zero-tolerance dead-code gate.
- Removed the startup lifecycle mirror. `StartupState` is authoritative and
  consumers use selector helpers for paintability and interactivity.
- Added typed startup probe outcomes that distinguish success, unsupported
  endpoints, retryable failures, and terminal failures while retaining causes.
- Centralized startup budgets in a typed timing policy and added focused probe
  and mobile-policy tests.
- Extracted stable seams from the top-priority large modules: chat motion and
  transcript rendering, provider-account transports, mobile local-agent
  policy, direct cloud endpoints, notification gestures, application route
  loaders, voice playback, and chat routing/failure policy.
- Contracted the root API from 3,306 exports to 143 stable primitive exports
  and migrated repository consumers to supported `@elizaos/ui/*` subpaths.
- Added ratchets for public exports (143), source-boundary violations (zero),
  hard-coded-color files (31), story coverage, story interactions, file
  headers, and unexpected console warnings. These baselines may shrink but may
  not grow without an explicit update.
- Consolidated or explicitly renamed the ambiguous status badge, theme toggle,
  and topic-chip concepts. Exact duplicate names now remain only where the
  vocabulary is intentionally domain-specific (`ApiError`, spatial `Stack` and
  `Text`) or is a compatibility surface (`FineTuningView`, `AgentCard`).
- Moved startup presentation values to launch tokens, made startup failure copy
  user-facing while retaining technical details, and expanded the startup story
  matrix.
- Replaced scattered renderer warning/error calls with one structured
  diagnostics boundary and a testable reporter. Explicit opt-in debug and
  performance traces remain at their named instrumentation boundaries.
- Replaced the 925 KB generated icon source module with a 4.3 KB manifest and
  individually copied offline assets.
- Brought every hand-written production and test source file into header
  compliance.
- Removed generated reports, screenshots, bundled E2E fixtures, unused source
  modules, and obsolete compatibility surfaces that had no consumers.
- Removed twelve additional unreachable compatibility/barrel modules exposed by
  the contracted API and the unused `@simplewebauthn/browser` dependency.

Still staged, with enforcement now in place:

- Story completion. Current coverage is 226 of 388 counted visual components
  (58.2%), with 24 source-level interaction stories. New debt is rejected.
- Thirty-one files retain deliberate color data: syntax-highlighting palettes,
  provider logos, deterministic generated-art palettes, charts, sandbox HTML,
  and standalone voice diagnostics. The scanner now parses TypeScript syntax
  and valid CSS hex lengths, so issue references such as `#8628` no longer
  inflate the result.
- Existing unit-test console fingerprints remain. Most are missing React
  `act()` boundaries; the rest are intentional error-boundary exercises or
  absent jsdom media/canvas capabilities that should be locally asserted or
  shimmed.
- Further decomposition of the large composition modules. The extracted pure
  policies are the first reviewable seams; feature-sized providers and clients
  remain follow-on moves behind stable exports.

## Executive summary

`@elizaos/ui` has a strong baseline: strict TypeScript passes, Biome is nearly
clean, core primitives generally use semantic Radix foundations, reduced-motion
and touch-target behavior are explicitly tested, and the package contains a
large amount of focused unit and browser coverage.

The primary weakness is scope. This is no longer only a UI library. It contains
the design system, the complete app shell, the cloud console, typed API and
WebSocket clients, native transports, local-inference orchestration, startup,
voice, GenUI, platform bridges, and several test harnesses. That concentration
has produced very large modules, a broad and collision-prone public API, many
parallel concepts, a large dependency graph, and unclear ownership boundaries.

The highest-risk area was agent startup. The explicit coordinator was already
well tested, but it was mirrored into legacy lifecycle state and several probes
erased failure identity. The refactor removes the second owner, introduces
typed and observable probe outcomes, centralizes timing policy, and keeps the
rendering contract behind small selectors. Startup is now one of the better
bounded areas of the package, though its composition modules can still shrink.

The initial cleanup removed unused manifest entries/imports, duplicate recovery
actions, generated report snapshots, and reproducible E2E artifacts. The
implementation pass then addressed the structural recommendations and added
the ratchets summarized above. Hand-written ambient declarations and the
scanner `.d.mts` contract remain because they are source, not stray output.

## Audit health score

| Dimension | Score | Key finding |
| --- | ---: | --- |
| Accessibility | 3/4 | Strong primitives and explicit motion/touch policies; story coverage leaves many compositions unaudited. |
| Performance | 3/4 | Routes and icon assets are split; the package remains large and still has feature-scale modules. |
| Responsive design | 3/4 | Platform policies and gesture seams are independently tested; large shell compositions remain. |
| Theming | 3/4 | Semantic colors are enforced; 31 specialized palette/data files remain. |
| Anti-patterns | 3/4 | Exact ambiguous concepts were consolidated and production diagnostics are centralized; intentional domain vocabulary remains. |
| **Total** | **15/20** | **Good guarded baseline — staged package/API migration remains.** |

### Anti-pattern verdict

The core app surface does not look generically AI-generated. It has an explicit
brand, restrained motion, reduced-motion fallbacks, canonical primitives, and
platform-specific interaction work. The main aesthetic risk lives in cloud
surfaces: the duplicate report identifies large `Dashboard*`, `Card*`, and
`Stat*` families, and the cloud design layer exists alongside the main design
system. The focused detector found one warning in
`components/ui/admin-dialog.tsx` (`border-b-2` on rounded dialog structure), not
a systemic slop pattern.

## Package inventory

Measured from the working tree during this audit:

- 2,816 TypeScript/TSX source files.
- Approximately 610,000 TypeScript/TSX lines.
- 874+ test files and 330+ story modules.
- 388 components considered by the story-coverage script; 226 have stories
  (**58.2%** coverage).
- 78 source modules exceed 1,000 lines; 20 exceed 2,000 lines. Extraction adds
  small independently tested modules before it can reduce this count.
- The built `dist` contains approximately **10.7 MB** of JavaScript.
- The root barrel exposes the stable primitives plus `cn`; feature consumers
  use explicit package subpaths.
- The API ratchet records 143 root exports. Knip now uses real entries and
  reports zero orphaned files or dependency issues.

Largest production modules:

| File | Lines | Concern |
| --- | ---: | --- |
| `components/shell/ChatOverlay.tsx` | 6,300 | Motion and transcript policy are extracted; gestures, composer, and overlays remain concentrated. |
| `api/client-agent.ts` | 4,425 | Both connector-account and provider-account transports are extracted; other endpoint families remain. |
| `api/ios-local-agent-kernel.ts` | 3,977 | Mobile policy is extracted; native orchestration remains in the UI package. |
| `api/client-cloud.ts` | 3,768 | Direct endpoint policy is extracted; cloud control-plane behavior remains broad. |
| `components/shell/NotificationsHomeCenter.tsx` | 3,146 | Gesture policy is extracted; store behavior and presentation remain coupled. |
| `App.tsx` | 2,981 | Route loaders are extracted; shell modes, navigation, and overlays remain in the composition root. |
| `hooks/useVoiceChat.ts` | 2,945 | Audio playback is extracted; the voice state machine and transport selection remain coupled to React. |
| `components/pages/BrowserWorkspaceView.tsx` | 2,819 | Feature-level surface is too large to reason about or review visually. |
| `state/AppContext.tsx` | 2,561 | A broad context remains the integration point for many unrelated domains. |
| `state/useChatSend.ts` | 2,541 | View routing and failure policy are extracted; message preparation, optimistic state, and transport remain entangled. |

## Detailed findings

### P1 — The package boundary is too broad

**Status:** completed as internal boundaries. Zero cross-layer violations are
enforced; a physical package split was explicitly rejected.

**Locations:** `src/cloud/`, `src/cloud-ui/`, `src/api/`, `src/voice/`,
`src/services/local-inference/`, `src/App.tsx`, `package.json`

The shared design system and browser-safe primitives are published from the
same package as cloud billing, wallet SDKs, native agent kernels, local model
management, and the full app shell. This inflates install and analysis cost,
makes browser/server safety depend on careful subpath usage, and gives every
change an enormous regression radius.

The retained boundary is one package with narrow subpaths: primitives at the
root, client transports under `@elizaos/ui/api/*`, cloud surfaces under
`@elizaos/ui/cloud-ui/*`, and shell/state/view contracts under their existing
subpaths. Boundary tests prevent feature layers from reaching across those
domains accidentally.

### P1 — Unused-file analysis is disabled by the Knip entry configuration

**Status:** completed. Knip now models the public/executable entry graph and
`audit:dead-code` fails on any orphan or dependency issue.

**Location:** `knip.json:3-4`

Both `entry` and `project` include `src/**/*.{ts,tsx}`. Marking every file as an
entry means Knip cannot identify orphaned modules, which is the most important
question for a package with almost 3,000 source files. It can still find unused
dependencies and duplicate exports, but the configuration gives false
confidence about dead files.

Replace `entry` with the real public entry points from `package.json#exports`,
plus explicit executable/test/story roots. Keep `project` broad. Add a CI check
that fails on newly orphaned files and maintain a small, justified ignore list.

### P1 — Startup has dual state ownership

**Status:** completed. The lifecycle mirror and setter were removed; selectors
over `StartupState` are the renderer contract.

**Locations:** `state/useStartupCoordinator.ts:119-186`,
`state/useLifecycleState.ts:31-53`, `state/AppContext.tsx:1483-1558`

`useStartupCoordinator` calls itself the sole startup authority but derives and
writes a `legacyPhase` into `useLifecycleState`. `AppContext` then exposes both
the coordinator and the legacy `startupPhase`/`startupStatus`. This creates two
representations that can drift and forces consumers to know which one is
authoritative.

Inventory all consumers of `startupPhase`, migrate them to selectors over
`StartupState`, then remove `setStartupPhase`, the lifecycle fields, and the
legacy adapter. The coordinator should expose a small selector API such as
`isShellPaintable`, `isInteractive`, `statusMessageKey`, and `error`.

### P1 — Startup probes sometimes erase failure identity

**Status:** completed. Typed probe outcomes retain cause and classification,
with focused retry/unsupported/terminal tests.

**Locations:** `state/startup-phase-runtime.ts:371,432,526`,
`state/startup-phase-poll.ts:891`, `state/startup-phase-restore.ts:397,430`,
`state/useStartupCoordinator.ts:404`

Several probes use `.catch(() => null)` and one auth probe fabricates an auth
shape. The surrounding loops often have deadlines, so these are not all silent
successes, but the original error is lost. Diagnostics then cannot tell
“endpoint unsupported,” “not loaded yet,” “transport failed,” and “valid empty”
apart. The automatic recovery loop also retries rejected probes without
reporting the individual failure.

Use a typed probe result (`ok`, `unsupported`, `retryable-error`,
`terminal-error`) and preserve the last cause for the eventual visible error and
telemetry. A 404 for an optional endpoint may be `unsupported`; transport,
parse, and 5xx failures must remain errors. Do not synthesize auth status from a
failed auth-status request.

### P1 — Very large modules prevent safe local refactoring

**Status:** in progress by stable seam. Six pure policy/contract modules and
route loaders were extracted with compatibility exports and behavior tests.

**Locations:** the largest-module table above

These files combine multiple state machines and rendering responsibilities.
Their size is not merely stylistic: review cannot reliably establish effect
ownership, memoization boundaries, or teardown behavior, and a small change
causes broad test churn.

Extract by stable behavior, not by arbitrary line count. Highest-value seams:

- `ChatOverlay`: sheet/gesture controller, composer, transcript, header,
  keyboard/safe-area adapter, and assistant overlay.
- `client-agent`: coding-agent, accounts, credentials, runtime lifecycle, PTY,
  and orchestrator clients.
- `App`: route manifest, lazy-loader registry/prefetch, shell-mode router,
  routed view host, and global overlay host.
- `AppContext`: domain stores/selectors with a thin composition provider.

Each extraction should add an import-boundary test and retain behavioral tests
at the old public seam.

### P1 — The public API is too permissive and collision-prone

**Status:** completed for repository consumers. The root inventory is 143 and
is a no-growth gate; feature APIs remain available from supported subpaths.

**Locations:** `src/index.ts`, `src/components/index.ts`, `package.json#exports`

The root barrel re-exports broad barrels and then repeats selected exports. It
already needs comments and aliases to avoid collisions such as
`ConnectionStatus` and `ThemeToggle`. Knip reports 34 duplicate exports,
including default/named pairs and aliases with identical values.

Make subpaths the supported API, reduce the root barrel to the stable common
surface, and generate an API report in CI. Deprecate root exports before
removing them. Avoid wildcard exports between feature domains.

### P2 — Parallel component concepts need consolidation

**Status:** completed for ambiguous visual duplicates. Domain-specific concepts
now carry explicit names; the five remaining exact names are intentional
vocabulary or compatibility seams.

**Locations:** duplicate report generated by
`scripts/find-duplicate-components.mjs`

The current scan found 916 component-like exports and eight exact-name
duplicates:

- `StatusBadge` in three locations.
- `AgentCard`, `ThemeToggle`, `TopicChipsBar`, `FineTuningView`, `Stack`, and
  `Text` in two locations each.
- `ApiError` in both the shared and cloud client layers.

Some duplicates are domain vocabulary rather than implementation duplicates
(`spatial.Text` versus UI typography), but `StatusBadge`, `ThemeToggle`, and
`TopicChipsBar` should be reviewed first. Consolidate visual logic into the
canonical primitive and keep domain adapters thin and explicitly named.

`components/primitives/index.ts` is only a compatibility re-export of
`components/ui/*`; it is not a second implementation. Keep it during API
migration, but do not add new imports to it. Prefer direct `components/ui/*`
subpaths and eventually deprecate this alias barrel.

### P2 — Story and automated accessibility coverage is incomplete

**Status:** gated. Coverage improved to 54.3%, startup stories were expanded,
and both story presence and interaction counts may no longer regress.

**Location:** `scripts/stories-coverage.mjs`

Only 210 of 390 counted components have stories (53.8%). Unit tests are
numerous, but a missing story means responsive, theme, hover/focus, and a11y
review is harder to perform systematically.

Prioritize stories for canonical primitives, startup states, shell overlays,
empty/error/loading states, and shared cloud compositions. Exclude pure
controllers and type-only modules from the denominator so the percentage is
actionable. Gate new exported visual components on at least one story with a
play interaction where applicable.

### P2 — Hard-coded presentation values remain widespread

**Status:** gated. Startup values moved to host-overridable tokens and a
407-file allowlist rejects new production color debt.

**Locations:** 407 production TS/TSX files contain hex colors after excluding
tests, stories, generated modules, E2E, and testing helpers. Examples include
`components/shell/StartupShell.tsx:14-29,123` and cloud brand compositions.

Not every literal is wrong—canvas shaders, protocol colors, and external brand
marks legitimately need fixed values—but the count is too high to review by
inspection. `StartupShell` also hard-codes a Poppins stack in inline styles,
which bypasses the theme’s `--font-body` seam.

Add a static allowlist for legitimate protocol/brand/canvas literals and reject
new component-level hex colors elsewhere. Move launch typography and bootstrap
colors to host-overridable tokens. Audit light/dark/high-contrast behavior for
the remaining allowlisted values.

### P2 — Runtime constants and source aliases are fragile

**Status:** partially completed. Startup timing is centralized and source
boundary violations are zero; package-export migration follows the package
split.

**Locations:** `tsconfig.json:12-116`, startup timing modules, `App.tsx`

The UI TypeScript config reaches directly into many plugin and package source
trees, including a dependency on a built declaration for one plugin. This
couples UI typechecking to the monorepo layout and lets renderer code bypass
package export contracts. Startup behavior also distributes timeout values
across coordinator, poll, runtime, native transport, and recovery modules.

Typecheck consumers against package exports or explicit browser entry points.
Centralize startup timing in a typed platform policy and name every budget by
what it bounds (single request, consecutive failure, phase, sliding extension,
or absolute boot cap).

### P2 — Generated icon code dominates the publish tree

**Status:** completed. The generated manifest is 4.3 KB and references 56
individually copied offline assets.

**Location:** `components/views/view-icons.generated.*`

The built icon module is about 925 KB, almost three times the next-largest
module. Verify whether all baked icons are reachable in one runtime. Prefer
per-icon generated modules or an ID-to-dynamic-import manifest so consumers do
not parse the full catalog. Preserve deterministic offline availability.

### P2 — Error handling is inconsistently observable outside startup

**Status:** completed for renderer failures. Production warning/error callers
use the structured reporter; opt-in informational traces stay inside named
debug/performance utilities.

**Examples:** `bridge/gateway-discovery.ts`,
`cloud/handoff/run-cloud-agent-handoff.ts`, production `console.warn/error`
sites

Many handlers are justified and annotated, but some “best effort” paths still
drop the error after a comment, and 21 production TS/TSX files write directly
to `console`. Browser console output can be appropriate at a final boundary,
but the package lacks one consistent client diagnostic sink.

Introduce a renderer diagnostic reporter that records scope, cause, severity,
and user-visible correlation ID. Use it for retry exhaustion and background
failures. Keep console output inside that boundary rather than scattered across
features.

### P2 — The test suite is green-insensitive because stderr is extremely noisy

**Status:** gated. Vitest 4 configuration is current and an exact-fingerprint,
count-sensitive warning ratchet rejects new noise. Existing fingerprints remain
cleanup debt rather than invisible output.

**Locations:** `vitest.config.ts`, asynchronous component tests throughout
`src/`

The full suite emitted a large volume of React `act(...)` warnings, intentional
error stacks, missing jsdom canvas/media implementation errors, invalid DOM prop
warnings, set-state-during-render warnings, and a Vitest 4 deprecation for
`test.poolOptions`. Real regressions can disappear in this output even when the
final assertion summary is reviewed.

Fix the Vitest 4 configuration first. Then make unexpected `console.error` and
`console.warn` fail tests by default, with a scoped helper for tests that
deliberately exercise an error boundary. Wrap asynchronous state changes with
Testing Library/user-event APIs and remove invalid fixture props. Establish a
warning-count ratchet if converting everything at once is impractical.

### P3 — File-header compliance is incomplete

**Status:** production completed. Hand-written production gaps are zero; 561
test gaps remain under a shrinking baseline for comment-only cleanup batches.

**Scope:** 623 of 2,785 scanned TS/TSX/MJS files did not start with the required
prose `/** ... */` header. Most are tests, but several production files are also
missing headers.

Do this as comment-only batches checked by `bun run check:comment-only`. Start
with production modules, then tests. Do not mix header churn into behavioral
refactors.

### P3 — One primitive-level visual warning remains

**Status:** completed. The dialog hierarchy now uses the standard separator
weight instead of the isolated thick accent border.

**Location:** `components/ui/admin-dialog.tsx:165`

The focused design detector reports a thick accent border on a rounded dialog
section (`border-b-2`). Review whether hierarchy can be expressed with spacing,
surface color, or a standard separator instead. This is isolated, not systemic.

## Agent startup review

### What works well

- `startup-coordinator.ts` is a pure, exhaustive state machine with injected
  platform policy.
- Side effects are split into restore, poll, runtime, and hydration modules.
- Startup exposes loading, interactive bootstrap/pairing, recoverable error,
  and ready states instead of one ambiguous boolean.
- The splash delay avoids a flash on fast cached boot and honors reduced motion.
- Error states offer retry, reset, external help, and optional bug reporting.
- Native startup has explicit heartbeat, request, consecutive-failure, sliding,
  and absolute time budgets with substantial test coverage.

### What was simplified

The backend-unreachable screen displayed **Choose Eliza Cloud** and **Start
over**, but both called `startFreshFirstRunReload()`. The first label was also
misleading because the reset returns to the choice among cloud, local, and
remote. The screen now presents one primary **Start over** action, plus Retry,
Open app, and Report a bug where available.

### Startup implementation result

1. The legacy lifecycle mirror is removed and coordinator selectors cover shell
   paintability and interactivity.
2. Nullable/fabricated probe fallbacks are replaced by typed outcomes retaining
   failure causes.
3. Phase and request budgets are defined by one injected startup timing policy.
4. Failure headings use user language; technical codes and causes remain in
   expandable diagnostics and bug reports.
5. Launch typography and bootstrap colors use host-overridable tokens.
6. Stories cover ready, waiting, recovery, pairing, timeout, offline, and
   diagnostic states. The package-wide story ratchet tracks future expansion.

## Files and artifacts: delete, retain, or reconsider

### Safe generated cleanup

These directories are ignored and can be regenerated; they are not source:

- `packages/ui/dist/` — publish build, including `.d.ts` and `.d.ts.map`.
- `packages/ui/storybook-static/` — static Storybook build.
- `packages/ui/.turbo/` — task logs/cache.
- `packages/ui/node_modules/` — installed dependencies.
- E2E `output*` directories covered by `.gitignore`.

Use `bun run --cwd packages/ui clean` for `dist`. Do not add a broad rule that
ignores every `.d.ts`; this package has legitimate ambient declarations.

This audit removed generated snapshots that were reproducible and unconsumed:

- `scripts/duplicate-components-report.{json,md}`
- `scripts/stories-coverage-report.{json,md}`
- `stories/check-stories-report.json`
- `agent-surface/__e2e__/output/` screenshots and bundled HTML

Report-writing commands generate these locally only when explicitly requested;
`.gitignore` keeps them out of diffs, and CI/PR artifacts should carry evidence.

### Retain

- `src/cloud-ui/types/nprogress.d.ts` and
  `src/cloud-ui/types/react-syntax-highlighter.d.ts`: ambient types for modules
  whose published typings do not cover current usage.
- `src/pendant/web-bluetooth.d.ts`: browser API augmentation.
- `stories/src/ambient.d.ts` and `stories/src/vite-env.d.ts`: story build types.
- `scripts/scan-reserved-storage-writers.d.mts`: the type contract used when a
  TypeScript guard test imports the adjacent `.mjs` scanner.
- Reviewed screenshot baselines under `__screenshots__` when tests or review
  documents intentionally consume them.

### Reconsider after dependency-boundary work

- Compatibility barrels (`components/primitives`, the root barrel, and the
  component barrel). Deprecate; do not abruptly delete.
- Host external-module shims. Replace with published browser contracts before
  deletion.
- Throwing compatibility subpaths such as `spatial/tui`. Remove only in a
  semver-major release after confirming consumers.

## Remaining work sequence

1. **Continue behavior-first decomposition.** Move the next coherent provider,
   transport, or presentation unit from each large composition file; retain
   behavioral tests at the old seam.
2. **Raise visual coverage.** Add stories for the 162 uncovered visual
   components and interactions beyond the current 24, lowering both baselines
   after every batch.
3. **Eliminate console-warning debt.** Add missing React `act()` boundaries,
   locally assert intentional error-boundary output, and provide scoped jsdom
   canvas/media shims. Do not globally silence these warnings.
4. **Split the remaining composition hotspots.** Highest-value next seams are
   `ChatOverlay` gesture/composer ownership, coding-agent/orchestrator/PTY
   transports in `client-agent`, `AppContext` domain value composition,
   `BrowserWorkspaceView` embedding policy, and the native/cloud client kernels.
5. **Resolve bundler warnings.** Publish browser-safe core contracts that do not
   pull `node:async_hooks` into Storybook, align `three` and `three-vrm` WebGPU
   exports, remove ineffective dynamic imports, and establish a chunk budget.
6. **Review specialized color data.** Keep provider logos and visualization or
   syntax palettes explicit, but move reusable palettes to named theme/data
   modules and retain contrast tests at their rendered surfaces.

## Verification performed

- `bun run --cwd packages/ui lint:check` and `typecheck` — passed across 2,797
  checked files.
- `bun run --cwd packages/ui build` — passed. The built JavaScript surface is
  10.7 MB; the generated icon registry fell from roughly 925 KB to 4.3 KB plus
  copied image assets.
- Strict full package suite with four workers — **877 test files passed; 9,026
  tests passed and 7 skipped**. A separate baseline-capture run produced the
  same result and reduced the console-warning baseline to 61 exact
  fingerprints. The default high-concurrency strict run reached 8,602 passing
  tests before host worker exhaustion; the bounded rerun proves the package
  itself is green.
- Static ratchets — dead code 0, forbidden cross-layer imports 0, hardcoded
  color files 31, missing production headers 0, missing test headers 0,
  stories 226/388 (58.2%), interactive `play` story files 24, and root public
  API exports 143.
- The final Storybook runtime audit completed all 1,538 retained stories:
  1,482 good, 56 explicitly runtime-dependent, 0 broken, and 0 accessibility
  violations. It executed 38 prepared interactions against 32 expected stories.
- `bun run --cwd packages/app audit:app` — **218/218 captures passed**. Computed
  verdicts were 198 good, 18 needs-eyeball, 0 needs-work, and 0 broken. OCR
  verification covered 216 views with 92 verified, 124 needs-eyeball, and 0
  broken. Desktop, mobile portrait, mobile landscape, and tablet contact sheets
  were then reviewed manually; no clipping, blank-route, overlay-clearance, or
  hierarchy regressions were found.
- The visual pass exposed and fixed a classic-JSX runtime failure in the wallet
  inventory view and a stale fine-tuning OCR expectation. The wallet's focused
  20-test suite, typecheck, lint, and all four inventory viewport captures pass.
- Manual inspection covered the startup coordinator, failure UI, timing and
  probe policies, generated artifacts, ambient declarations, package exports,
  duplicate component names, build output, and every visual contact sheet.
