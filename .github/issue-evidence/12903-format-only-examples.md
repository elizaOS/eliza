# #12903 format-only example script normalization

Date: 2026-07-04
Base: `origin/develop` at `f5d7680d77`
Branch: `fix/12903-format-only-examples`

## Scope

- `packages/examples/agent-console`
- `packages/examples/aws`
- `packages/examples/gcp`
- `packages/examples/next`
- `packages/examples/react`
- `packages/examples/cloud/edad`
- `packages/examples/cloud/x402-image-gen`

This slice adds missing `format` and read-only `format:check` scripts to
example packages that already had real test/build/typecheck behavior and only
needed formatter command parity for #12903.

No runtime behavior, builds, tests, or deployment commands were changed.

## Validation

Commands run from a fresh sparse worktree based on current `origin/develop`:

```bash
git diff --check
```

Result: passed.

Inline script-contract audit over the edited package manifests:

```text
packages/examples/agent-console/package.json: ok
packages/examples/aws/package.json: ok
packages/examples/gcp/package.json: ok
packages/examples/next/package.json: ok
packages/examples/react/package.json: ok
packages/examples/cloud/edad/package.json: ok
packages/examples/cloud/x402-image-gen/package.json: ok
```

Package-local format checks:

```bash
bun run --cwd packages/examples/agent-console format:check
bun run --cwd packages/examples/aws format:check
bun run --cwd packages/examples/gcp format:check
bun run --cwd packages/examples/next format:check
bun run --cwd packages/examples/react format:check
bun run --cwd packages/examples/cloud/edad format:check
bun run --cwd packages/examples/cloud/x402-image-gen format:check
```

Result: all passed.

Existing lint checks where present:

```bash
bun run --cwd packages/examples/aws lint:check
bun run --cwd packages/examples/gcp lint:check
bun run --cwd packages/examples/next lint:check
bun run --cwd packages/examples/react lint:check
```

Result: all passed.

Smoke/tests:

```bash
bun run --cwd packages/examples/agent-console test
bun run --cwd packages/examples/next test
bun run --cwd packages/examples/react test
bun run --cwd packages/examples/aws test
bun run --cwd packages/examples/gcp test
bun run --cwd packages/examples/cloud/x402-image-gen test
```

Result:

- Agent Console: 1 passing Bun test.
- Next: 2 passing Bun tests.
- React: 3 passing Bun tests.
- AWS: local handler smoke passed health, validation, and 404 checks; live chat skipped because `OPENAI_API_KEY` was not set.
- GCP: command exited successfully and skipped integration because no local worker was running at `http://localhost:8080`.
- x402 image gen: local flow test passed.

Additional test attempted:

```bash
bun run --cwd packages/examples/cloud/edad test
```

Result: blocked in the sparse worktree because `@elizaos/cloud-sdk` could not be
resolved through the sparse dependency graph when the eDad server process
started. The eDad package's test command itself was not changed in this PR.

Scoped audit after this slice:

```text
packages=7 issues=0
```

Full examples audit after this slice:

```text
packages=47 issues=22
```

Remaining failures are `packages/examples/app/*`, `packages/examples/farcaster-miniapp`,
`packages/examples/smartglasses`, and `packages/examples/trader`.
