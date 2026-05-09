# Proposal: shrink `disable-local-eliza-workspace.mjs` to a minimal bun-overrides patch

Status: **proposed, needs CI validation before landing**
Owner: whoever picks this up
Related review: the install-flow cleanup series (D1–D9, E1–E6, F1–F4)

## Background

`scripts/disable-local-eliza-workspace.mjs` is ~1,287 lines. It runs only
when `ELIZA_SKIP_LOCAL_UPSTREAMS=1` + (GITHUB_ACTIONS=true or
`ELIZA_DISABLE_LOCAL_UPSTREAMS=force`) — i.e. CI jobs that install
without the `eliza/` submodule checked out.

What it does today:

1. Move / hide the `eliza/` directory on disk.
2. Strip `eliza/packages/*`, `eliza/plugins/*`, and
   `eliza/plugins/plugin-*/typescript` from the root `workspaces` array
   in `package.json`.
3. Rewrite every `package.json` in the workspace graph that declares
   `"@elizaos/*": "workspace:*"` to a registry version — the same
   version the root `overrides` block (and
   `eliza/packages/app-core/deploy/cloud-agent-template`) already pin.
4. Inject `file:` overrides for unpublished eliza packages that still need
   pinned paths (`CI_OVERRIDE_SPECIFIERS` — shared/UI and similar).
5. Delete lockfiles so Bun regenerates clean.

Steps 1, 2, 4, 5 together are ~150 lines. **Step 3 is the bulk** — it
walks tens of `package.json` files and rewrites specifiers per-section
(`dependencies`, `devDependencies`, `peerDependencies`,
`optionalDependencies`), with drift-detection and test hooks.

## Claim

Bun's root-level `overrides` field force-redirects dependency
resolution regardless of the specifier each dependent declares. If
that holds, step 3 is redundant:

- `"@elizaos/core": "workspace:*"` declared by a plugin becomes moot
  as long as the root override says
  `"@elizaos/core": "2.0.0-alpha.<x>"`.
- Bun resolves the override first, skipping workspace:*.

**If the claim is true:** delete everything in step 3 and the
supporting machinery (~900 lines).

**If the claim is false:** there is a bun-behaviour gap that must be
filed upstream before we can move.

## Design

Target state of `disable-local-eliza-workspace.mjs`: roughly 200 lines
doing the following:

1. Read root `package.json`.
2. Remove `eliza/*` workspace globs.
3. Merge CI override specifiers (the `@elizaos/shared` /
   `@elizaos/ui` / `@elizaos/plugin-browser` file-overrides
   already in `CI_OVERRIDE_SPECIFIERS`) into `overrides`.
4. Write `package.json` back.
5. Move `eliza/` out of the way (keep existing logic).
6. Delete `bun.lock` so Bun regenerates with the new constraints.

Everything removed:

- `ensureWorkspacePackageVersionPins` / `rewritePackageSpecifier` /
  every helper that reads each workspace `package.json` and rewrites
  its deps.
- `DEPENDENCY_FIELDS` iteration loops.
- The test fixtures that exercise the per-package rewrite matrix
  (`scripts/disable-local-eliza-workspace.test.ts` — many suites).

Machines not affected: CI workflow yaml, `setup-upstreams.mjs`.

## Validation plan (REQUIRED before landing)

1. **Local repro of CI.** On a clean checkout with
   `ELIZA_SKIP_LOCAL_UPSTREAMS=1`, simulate the `eliza/`-absent state:
   `ELIZA_SKIP_LOCAL_UPSTREAMS=1 GITHUB_ACTIONS=true bun install`.
   Today this runs `disable-local-eliza-workspace.mjs` and installs
   cleanly.

2. **Proposed-state repro.** Write an experimental variant of the
   script (e.g. `scripts/_disable-local-eliza-workspace-lite.mjs`)
   that does only steps 1, 2, 3, 4, 6 from the Design section above.
   Point CI override specifiers at registry versions, not
   `workspace:*`.

3. **Diff bun.lock.** Compare `bun.lock` produced by the current
   script vs the lite variant:
   - Resolution targets for every `@elizaos/*` must match exactly.
   - No duplicate entries for `@elizaos/core` in the top-level
     `packages` section (this was the root cause of the original
     full rewrite — see comment block at the head of the current
     script).

4. **Run the release-gate workflows locally.**
   `scripts/release-check.ts` exercises `bun pm pack --dry-run` across
   every publishable package. If the lockfile is broken it fails with
   `error: Duplicate package path ... failed to parse lockfile:
   InvalidPackageKey`. That must pass in the proposed state.

5. **Run the matrix in GitHub Actions.** Open a PR with the lite
   script as a toggle (`ELIZA_LITE_DISABLE=1` selects lite, default
   selects current). Run every workflow that sets
   `ELIZA_SKIP_LOCAL_UPSTREAMS=1`:
   - `nightly.yml`
   - `test.yml`
   - `agent-release.yml`
   - Mobile platform workflows
   - Release workflow path contract jobs

   All must pass with `ELIZA_LITE_DISABLE=1` before the lite variant
   becomes the default.

6. **Flip the default + keep the old path as an opt-out for one
   release cycle**, then delete the old path.

## Risk ladder

- **Low risk** to the change itself — deletion-only once validated.
- **Medium risk** to discovery — Bun's overrides behaviour may have
  subtle gaps for workspace:* or peerDependencies that only surface
  in specific packages (e.g. `@elizaos/plugin-sql` in an environment
  that also bundles `@elizaos/shared` workspace:*).
- **High cost** of skipping validation — every release workflow
  depends on this script. A regression breaks publish.

## Non-goals

- Replacing `setup-upstreams.mjs` (covered by the E2 todo; separate
  effort).
- Rewriting `fix-workspace-deps.mjs` (covered by D9; already landed
  the snapshot/restore pattern).
- Changing plugin submodule branches (D8; already landed).

## If validation fails

If bun's overrides don't actually suppress `workspace:*` on dependent
packages (claim untrue), the next-best simplification is:

- Keep the per-package rewrite but **in-memory only** (write → bun
  install → restore), same pattern as the D9 fix for
  `workspace-prepare.mjs`. That saves the on-disk churn but keeps the
  code.

- File an issue with upstream Bun describing the desired override
  semantics. Link it here.

Either outcome is progress over the current state.
