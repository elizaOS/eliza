# #12903 non-app example tail script normalization

Date: 2026-07-04
Base: `origin/develop` at `46e128efb8`
Branch: `fix/12903-nonapp-example-tail`

## Scope

- `packages/examples/farcaster-miniapp`
- `packages/examples/smartglasses`
- `packages/examples/trader`

This slice adds missing `lint:check`, `format`, and read-only `format:check`
scripts to the remaining non-app example packages in the #12903 examples audit.

Smartglasses keeps its existing read-only `lint` command because
`verify:software` already uses that script as part of a verification chain.

## Validation

Commands run from a fresh sparse worktree based on current `origin/develop`:

```bash
git diff --check
```

Result: passed.

Inline script-contract audit over the edited package manifests:

```text
packages/examples/farcaster-miniapp/package.json: ok
packages/examples/smartglasses/package.json: ok
packages/examples/trader/package.json: ok
```

Package-local checks:

```bash
bun run --cwd packages/examples/farcaster-miniapp lint:check
bun run --cwd packages/examples/farcaster-miniapp format:check
bun run --cwd packages/examples/smartglasses lint:check
bun run --cwd packages/examples/smartglasses format:check
bun run --cwd packages/examples/trader lint:check
bun run --cwd packages/examples/trader format:check
```

Result: all passed.

Smoke tests:

```bash
bun run --cwd packages/examples/farcaster-miniapp test
bun run --cwd packages/examples/trader test
```

Result:

- Farcaster Miniapp: 2 passing Bun tests.
- Trader: 2 passing Bun tests.

Additional test attempted:

```bash
bun run --cwd packages/examples/smartglasses test
```

Result: blocked in the sparse worktree because `@elizaos/plugin-facewear` and
`@elizaos/plugin-facewear/protocol/smartglasses` did not resolve through the
sparse dependency graph, even after adding the plugin source and running
`packages/scripts/ensure-workspace-symlinks.mjs`. The Smartglasses test command
itself was not changed in this PR.

Full examples audit after this slice:

```text
packages=47 issues=13
```

Remaining failures are all under `packages/examples/app/*`.
