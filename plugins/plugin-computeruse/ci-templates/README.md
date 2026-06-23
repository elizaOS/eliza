# CI templates — computeruse

Workflow files that need `workflow` OAuth scope to commit, parked here so they're
version-controlled and one `git mv` away from active. The bot that authored them
cannot write under `.github/workflows/`.

## `cua-parity-real.yml` — the last step for "tested on Linux + macOS"

The trycua/cua parity verbs (#9170) are implemented and **machine-checked on all
four platforms in the default lane** (`src/parity/parity-matrix.ts` +
`__tests__/cua-parity-coverage.test.ts` run on Windows/Linux/macOS/AOSP-Node).
The **real-driver actuation** lane (`__tests__/cua-parity-input.real.test.ts` —
real mouse/keyboard/window/clipboard against a live desktop) is currently only
exercised on Windows. The test gate is already OS-agnostic
(`win32 || darwin || (linux && DISPLAY)`); the only missing piece is a CI lane
that provides a display on Linux (Xvfb) and runs it on macOS.

`cua-parity-real.yml` is that lane (3-OS matrix, `workflow_dispatch`). To enable:

```bash
git mv plugins/plugin-computeruse/ci-templates/cua-parity-real.yml \
       .github/workflows/cua-parity-real.yml
git commit -m "ci(computeruse): enable 3-OS cua-parity real-driver lane (#9170)"
```

Then trigger it from the Actions tab (or add `push`/`pull_request` triggers if you
want it on every change). The recipe bakes in the empirically-verified build
prerequisites (run the i18n codegen, then build `@elizaos/core` to `dist` before
vitest — `bun` does not auto-run `prebuild`, and the source export condition trips
an `@opentelemetry` ESM error). Once green, the verb-by-verb actuation that is
Windows-verified today extends to Linux and macOS automatically.
