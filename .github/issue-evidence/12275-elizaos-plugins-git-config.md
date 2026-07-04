# #12275 plugins submit git config evidence

## Scope

- Chunk for issue #12275.
- `elizaos plugins submit` no longer treats git config read failures as missing repository metadata.
- A missing `remote.origin.url` still falls through to the existing explicit repository-metadata error.
- The actual CLI command now handles `plugins submit` errors at the command boundary with a concise stderr message and exit `1`.

## Verification

```bash
bun run --cwd packages/elizaos test -- src/commands/plugins.test.ts
```

Result: passed, 1 file / 8 tests.

```bash
bun run --cwd packages/elizaos typecheck
```

Result: passed.

```bash
bun run --cwd packages/elizaos lint:check
```

Result: passed.

```bash
bun run --cwd packages/elizaos build
```

Result: passed.

```bash
bun run audit:error-policy-ratchet
```

Result: passed.

```bash
bun run verify
```

Result: failed in unrelated `@elizaos/ui#lint` diagnostics after 142 successful Turbo tasks. The first reported diagnostics were:

```text
packages/ui/src/cloud/shell/cloud-route-gate.test.tsx:28 lint/complexity/noUselessFragments
packages/ui/src/api/desktop-local-agent-transport.ts:5 assist/source/organizeImports
packages/ui/src/cloud/admin/admin-role.test.ts format
```

The verify run also surfaced additional unrelated UI formatting/hook diagnostics before Turbo stopped.

## Built CLI Transcript

This used the built `packages/elizaos/dist/cli.js` against a real temporary
plugin package while `GIT_CONFIG_GLOBAL` pointed at malformed git config.

```text
$ NO_COLOR=1 GIT_CONFIG_GLOBAL=/var/folders/1g/77s889gx10n7mtl6z1nfrxzm0000gn/T/elizaos-plugin-submit-bad-config-SnJlMe/bad-git-config node /Users/shawwalters/.codex/worktrees/8855/eliza/packages/elizaos/dist/cli.js plugins submit /var/folders/1g/77s889gx10n7mtl6z1nfrxzm0000gn/T/elizaos-plugin-submit-bad-config-SnJlMe --dry-run
Failed to read git remote.origin.url: fatal: bad config line 1 in file /var/folders/1g/77s889gx10n7mtl6z1nfrxzm0000gn/T/elizaos-plugin-submit-bad-config-SnJlMe/bad-git-config
exit=1
```

## Evidence Matrix

- Backend logs: N/A - CLI command boundary only; transcript includes the real git config failure path.
- Frontend screenshots/video: N/A - no UI changes.
- Real-LLM trajectories: N/A - no model, prompt, provider, action, or evaluator behavior changed.
- Domain artifacts: N/A - no database, memory, wallet, scheduled task, generated file, or connector artifact changed.
