# Issue #12857 Evidence: app-core Comment Cleanup

## Scope

- Package: `packages/app-core`
- Change type: prose comment headers only
- Source audit: `sourceFiles: 937`, `missingHeaders: 0`
- Diffstat: 390 files changed, 389 insertions
- Screenshots/video: N/A; this is a comment-only documentation cleanup with no runtime or UI token changes.

## Verification

```bash
bun run install:light
```

Passed.

```bash
bun run check:comment-only
```

Passed:

```text
[assert-comment-only-diff] OK — 390 source file(s) changed; every code token identical to origin/develop. Comments only.
```

```bash
git diff --check
```

Passed.

```bash
bun run --cwd packages/app-core format:check
```

Passed:

```text
Checked 309 files in 106ms. No fixes applied.
```

```bash
bun run verify
```

Attempted. The run reached workspace linting and failed on an unrelated existing `@elizaos/plugin-computeruse#lint` issue. The write-mode lint run touched unrelated packages; those changes were restored before commit.
