# Wave 08 - Final Validation And Signoff Dry Run

Status: dry run only. No source files were changed.

## Purpose

Wave 8 defines the objective signoff contract for the cleanup program. The cleanup is only complete when every approved deletion/refactor from Waves 1-7 has either shipped with validation or has been explicitly deferred with an owner and reason.

This wave also protects against accidental loss of current work. The repository is currently on `develop`, ahead of origin, with many pre-existing modified and untracked files. Cleanup implementation must preserve those changes and avoid broad reset/checkout operations.

## Required Branch Discipline

Before implementation:

```bash
git status --short --branch
git diff --stat
git diff --name-only
git ls-files --others --exclude-standard
git switch -c shaw/repo-cleanup-dry-run-implementation
```

Rules:

- Do not use `git reset --hard`.
- Do not use `git checkout --` against user-modified files.
- Do not delete ignored or untracked files unless the deletion is explicitly approved and recorded.
- Each implementation batch must have a manifest of changed/deleted files.
- Prefer separate commits or PRs by wave so rollback is possible.

## Baseline Reports Required Before Changes

Create these baseline files before destructive cleanup:

```bash
mkdir -p docs/audits/repo-cleanup-2026-05-11/generated

git status --short --branch > docs/audits/repo-cleanup-2026-05-11/generated/baseline-git-status.txt
git diff --stat > docs/audits/repo-cleanup-2026-05-11/generated/baseline-git-diff-stat.txt
git ls-files > docs/audits/repo-cleanup-2026-05-11/generated/baseline-tracked-files.txt
git ls-files --others --exclude-standard > docs/audits/repo-cleanup-2026-05-11/generated/baseline-untracked-files.txt
git ls-files -i --exclude-standard > docs/audits/repo-cleanup-2026-05-11/generated/baseline-ignored-tracked-files.txt
```

Also generate:

```bash
/Users/shawwalters/.bun/bin/bun run knip -- --no-exit-code > docs/audits/repo-cleanup-2026-05-11/generated/baseline-knip.txt
/Users/shawwalters/.bun/bin/bunx madge --circular --extensions ts,tsx --exclude '(dist|build|node_modules|.turbo|coverage|.claude|packages/inference/llama.cpp|packages/app-core/platforms/electrobun/build)' packages plugins test > docs/audits/repo-cleanup-2026-05-11/generated/baseline-madge-source-cycles.txt
node scripts/type-audit.mjs > docs/audits/repo-cleanup-2026-05-11/generated/baseline-type-audit.txt
```

If `scripts/type-audit.mjs` is not the current canonical entrypoint, use `packages/app-core/scripts/type-audit.mjs` and record that mismatch as a tooling fix.

## Global Validation Commands

Use the absolute Bun path unless the developer shell has Bun on `PATH`:

```bash
export BUN=/Users/shawwalters/.bun/bin/bun
export NODE_OPTIONS=--max-old-space-size=8192

$BUN run lint:check
$BUN run typecheck
$BUN run test:ci
$BUN run test:e2e
$BUN run test:launch-qa
$BUN run audit:package-barrels
$BUN run knip -- --no-exit-code
$BUN run knip:strict -- --filter <touched-package>
$BUNx madge --circular --extensions ts,tsx --exclude '(dist|build|node_modules|.turbo|coverage|.claude|packages/inference/llama.cpp|packages/app-core/platforms/electrobun/build)' packages plugins test
```

Expected handling:

- `knip --no-exit-code` is advisory globally until the baseline is burned down.
- `knip:strict --filter <touched-package>` can become blocking per touched package once that package has an accepted baseline.
- Madge source-only cycles should be no worse than baseline and should trend to zero.

## Wave-Specific Validation Gates

### Wave 1 - Generated Artifacts

Pass criteria:

- No source imports point at deleted generated artifacts.
- Ignored generated outputs can be regenerated.
- `.gitignore` and tooling ignores prevent reintroduction.

Commands:

```bash
git check-ignore -v <candidate-path>
git clean -ndX
$BUN run lint:check
$BUN run typecheck
```

### Wave 2 - LifeOps And Health

Pass criteria:

- One `ScheduledTask` contract remains canonical.
- LifeOps runner still routes structurally and does not inspect `promptInstructions`.
- Health plugin does not import LifeOps internals.
- Connectors/channels return typed `DispatchResult`, never boolean.

Commands:

```bash
$BUN run --cwd plugins/app-lifeops verify
$BUN run --cwd plugins/app-lifeops lint:default-packs
rg -n 'promptInstructions' plugins/app-lifeops/src/lifeops/scheduled-task/runner.ts
rg -n 'from .*(app-lifeops|plugins/app-lifeops)' plugins/plugin-health/src
rg -n 'Promise<boolean>|=> boolean|: boolean' plugins/app-lifeops/src/lifeops/connectors plugins/plugin-health/src/connectors
```

### Wave 3 - Backend Routes

Pass criteria:

- Each route family has one owner.
- Compatibility routes either forward to the owner or have explicit support windows.
- Route parity tests cover old and canonical paths before deletion.

Commands:

```bash
$BUN run --cwd packages/agent test
$BUN run --cwd packages/app-core test
$BUN run --cwd cloud/apps/frontend typecheck
$BUN run audit:package-barrels
```

### Wave 4 - Frontend/UI

Pass criteria:

- `AppContext` consumers migrate to narrower state surfaces without behavior loss.
- Profile/API-key/account flows no longer force full reloads.
- Core shell routes show explicit unavailable states instead of silent fallback to chat.
- Desktop and mobile screenshots show no broken layout.

Commands:

```bash
$BUN run --cwd packages/ui typecheck
$BUN run --cwd packages/ui test
$BUN run --cwd packages/app typecheck
$BUN run --cwd packages/app test:e2e
$BUN run --cwd cloud/apps/frontend verify
```

Browser scenarios:

- Startup/runtime gate.
- Chat send/receive.
- Settings and plugin/skills pages.
- Browser workspace.
- Wallet consent.
- Cloud dashboard account profile.
- Cloud API key regeneration without page reload.
- Mobile widths: 390, 820, 1440.

### Wave 5 - Tests

Pass criteria:

- Deleted tests are listed with rationale.
- Converted tests assert behavior, not constants or self-seeded state.
- Slow lane is explicit.
- Mock lint is advisory until the migration finishes, then blocking for new tests.

Commands:

```bash
$BUN run test:ci
$BUN run test:e2e
node scripts/lint-no-vi-mocks.mjs
node scripts/lint-lane-coverage.mjs
```

### Wave 6 - Assets/Docs

Pass criteria:

- Large tracked files have owner decisions.
- Generated docs have a regeneration command.
- Archived markdown has a clear index.
- Deleted markdown is not linked from docs navigation.

Commands:

```bash
git ls-files '*.md' '*.mdx'
rg -n '<deleted-doc-path>|<deleted-heading>|<deleted-anchor>' docs packages/docs plugins packages cloud
$BUN run test:launch-qa:docs
$BUN run test:launch-qa
```

### Wave 7 - Naming/Text

Pass criteria:

- No live source contains high-signal slop terms unless allowlisted.
- Public API renames include compatibility decisions.
- Generated prompt/action docs are regenerated after source text changes.

Commands:

```bash
rg -n -i --glob 'packages/**/src/**' --glob 'plugins/**/src/**' --glob 'cloud/**/src/**' '\b(AI slop|LARP|flavor text|TODO Wave-|Wave-[0-9]|W[0-9]-[A-Z]|FIXME|HACK|XXX)\b'
$BUN run typecheck
$BUN run test:ci
```

## Required Signoff Artifacts

Final implementation should leave these reports:

- `generated/final-git-status.txt`
- `generated/final-deletion-manifest.md`
- `generated/final-rename-manifest.md`
- `generated/final-knip.txt`
- `generated/final-madge-source-cycles.txt`
- `generated/final-type-audit.txt`
- `generated/final-test-results.md`
- `generated/final-browser-verification.md`
- `generated/final-owner-decisions.md`

Each manifest entry should include:

- Path or symbol.
- Wave.
- Action: delete, rename, consolidate, keep, defer.
- Reason.
- Validation command.
- Result.
- Owner decision if needed.

## Rollback Plan

Rollback should be per wave, not whole-repo reset:

```bash
git log --oneline --decorate --max-count=20
git revert <wave-commit-sha>
```

For uncommitted implementation work:

```bash
git status --short
git diff --name-only
```

Then manually revert only files owned by the failed wave. Do not revert unrelated dirty files.

## PR Strategy

Recommended PR order:

1. Tooling baselines and guards.
2. Generated artifact cleanup and ignore fixes.
3. LifeOps/Health contracts.
4. Backend route ownership.
5. Frontend state/UI refactor.
6. Test cleanup.
7. Assets/docs cleanup.
8. Naming/text cleanup.
9. Final signoff and baseline removal.

Each PR must include:

- Scope statement.
- Deletion/rename manifest.
- Tests run.
- Known skips.
- Screenshots for frontend PRs.
- Owner decisions for risky deletions.

## Final Approval Checklist

- All approved Wave 1-7 changes are implemented or explicitly deferred.
- No new large tracked artifacts are introduced.
- No new source-only Madge cycles are introduced.
- No new unresolved imports are introduced.
- No new package barrels are introduced without approval.
- LifeOps AGENTS.md invariants are still true.
- Health plugin remains separate.
- Backend route compatibility decisions are documented.
- UI flows pass browser verification.
- Test runtime is lower or justified.
- Deleted tests are replaced where behavior mattered.
- Docs navigation has no dead links.
- Generated docs/specs are reproducible.
- Final `git status` contains only intended changes.

