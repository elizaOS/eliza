# #9142 frame-glitch harness Node resolution evidence

## Defect (topology-dependent)

The Node-run `test:chat-sheet-frame-glitch-e2e` harness statically `import`ed
`esbuild` / `pixelmatch` / `pngjs`. That resolves fine **when** Node's upward
module walk from `packages/ui` reaches the repo-root hoisted `node_modules/.bun`
store — the common case (and why this exact command resolves on a hoisted tree):

```text
node -e "require.resolve('esbuild', { paths: [process.cwd() + '/packages/ui'] })"
# resolves to <root>/node_modules/.bun/esbuild@.../node_modules/esbuild on a hoisted tree
```

It **fails** on a checkout where Bun installed the packages into its store but
left no Node-visible symlink chain reachable from `packages/ui` (no hoisted
`node_modules` at or above the package). In that topology the static ESM import
throws at parse time — before the harness can run or print an actionable error.
The fix makes those imports dynamic, resolving through `packages/ui` first and
falling back to the `.bun` store, so the harness either runs or fails with a
clear "run `bun install` from the repo root" message instead of an opaque parse error.

## Fixed path verified

After adding the harness resolver fallback:

```text
bun run --cwd packages/ui test:chat-sheet-frame-glitch-e2e -- --canary
PASS - 34 frames, peak pair-diff 59278, worst two-pills overlap 0.000
```

The canary run also proved both detectors fire:

```text
canary: flash detector FIRES on the injected bad frame
canary: two-pills detector FIRES on the injected both-visible sample
```

The updated frame burst, diff overlay, transition GIF, and machine-readable
`summary.json` are in this directory.
