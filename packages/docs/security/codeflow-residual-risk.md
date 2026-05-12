# CodeFlow Residual Findings

This document enumerates CodeFlow findings that remain after the
2026-04-16 cleanup pass and explains why each is intentionally not
addressed. It is a living document — update it when CodeFlow is re-run
or when a residual item becomes actionable.

## Accepted — scanner false positives after .codeflowignore

The `.codeflowignore` excludes the following file-type/area combinations
from secret, XSS, SQL-injection, and function-constructor scans:

- **Documentation** (`docs/**`, `README.md`, `AGENTS.md`, `CLAUDE.md`,
  `.claude/**/*.md`) — illustrative placeholders in MDX/Markdown are
  compile-time constants, not runtime code. Sanitized in PR 1 to
  angle-bracket sentinels so human reviewers aren't confused either.
- **CI/CD YAML** (`.github/**/*.yml`, `.depot/**/*.yml`) — GitHub
  Actions' `${{ secrets.X }}` and `${{ vars.Y }}` syntax is a reference
  to encrypted secrets, not a hardcoded credential. Scanner confuses it
  with SQL template interpolation.
- **Lockfiles** (`bun.lock`, etc.) — dependency-tracker content; not
  authored code.
- **Generated output** (`apps/**/dist/**`, `packages/**/dist/**`) — not
  in the repo's authored-code surface.
- **Submodule** (`eliza/**`, `plugins/**`) — tracked upstream; not our
  code to fix.
- **Test runners and build scripts** (`apps/app/test/design-review/**`,
  `apps/app/test/electrobun-packaged/**`, `apps/app/test/setup.ts`,
  `.github/trust-scoring.js`) — intentionally use `console.*`,
  `new Function()`, and shell spawns for controlled test/build logic.

## Accepted — code-level intentional patterns

### `apps/homepage/src/components/docs/Diagram.tsx` — `innerHTML` with sanitized SVG
Mermaid renders user-authored (MDX compile-time) Markdown into SVG; the
SVG is sanitized by DOMPurify (added in PR 3) and Mermaid is configured
with `securityLevel: "strict"`. Replacing `innerHTML` with
`dangerouslySetInnerHTML` does not reduce risk — it is the same primitive.
A React-native renderer for Mermaid SVG (e.g. via `react-svg` fetch
pattern) is possible future work.

### `apps/app/test/setup.ts` — `patchedEmit`
Installed as a side-effect into jsdom's window; not imported elsewhere.
CodeFlow's unused-function heuristic cannot see side-effect installs.
Annotated inline (PR 2).

### `escapeRegExp` duplication across 5 files
Each copy is a one-line utility (`str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`).
Consolidation saves minimal code while introducing an import coupling
across otherwise-independent modules. Accepted duplication.

### `handleStorage` duplication across 4 files
Despite the shared name, each is a distinct `storage` event listener
with different business logic. Renaming them to be file-local-obvious
(e.g. `handleAgentStorageEvent`, `handleCloudLoginStorageEvent`) is a
future ergonomic polish.

## Deferred — bigger refactors tracked separately

### `eliza/packages/app-core/src/App.tsx` (886 lines, 49 imports)
Lives in the `eliza` submodule; requires an upstream elizaOS PR.
Decomposition into smaller feature slices is tracked as a separate
upstream contribution.

### `.github/trust-scoring.js` (858 lines, 19 console statements)
Self-contained CommonJS CLI with legitimate console output (designed to
run in CI where stdout is the only log surface). Splitting it into
scorer/reporter/io modules is a separate refactor.

## Dismissed — scanner category errors

### 5 reported "circular dependencies"
Spot-checked; all 5 are phantom:
- `setup.ts ↔ setup.ts` — self-reference (scanner bug).
- `setup.ts ↔ cloud-api.ts` — `cloud-api.ts` does not exist in the
  expected path.
- `App.tsx ↔ ConnectionModal.tsx` — ConnectionModal imports unrelated
  utilities; no import of App.
- `App.tsx ↔ useCloudLogin.ts` — same; no bidirectional import exists.
- `DocsLayout.tsx ↔ DocsSidebar.tsx` — one-directional import;
  DocsLayout imports DocsSidebar but not the reverse.

### 112 "Architecture Violations" (test → utils)
Tests legitimately import from test utilities. Scanner's layer map is
incorrect for a Bun monorepo. If CodeFlow supports a layer-config file,
map `test/**` as a peer to `utils/**`; otherwise accept.

### 139 "High Complexity Files"
Top offenders are `changelog.mdx` (928 lines), `bun.lock` (624), and CI
YAML (`agent-review.yml` at 256). None are authored code. After
`.codeflowignore` lands, this number drops to reflect real-code-only
complexity.
