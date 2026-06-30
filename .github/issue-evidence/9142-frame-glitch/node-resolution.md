# #9142 frame-glitch harness Node resolution evidence

## Defect reproduced

Plain Node cannot resolve the harness analysis dependencies from this checkout's
workspace links even though Bun has them installed in `.bun`:

```text
node -e "require.resolve('esbuild', { paths: [process.cwd() + '/packages/ui'] })"
Error: Cannot find module 'esbuild'
```

This is the portability failure reported for the Node-run
`test:chat-sheet-frame-glitch-e2e` harness.

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
