# Issue #11359 — GLSL background fuzz coverage

Date: 2026-07-02

Change type: test-only coverage in `packages/ui/src/App.screen-background-fuzz.test.tsx`.

## Manual review

Opened and reviewed the updated fuzz test. The GLSL pass now:

- Uses the real `background:apply` subscriber instead of the prior no-op mock.
- Applies the `aurora` preset through the same preset-only path used by the app.
- Verifies out-of-range uniforms clamp to `{ u_speed: 3, u_scale: 0.1, u_intensity: 2, u_seed: 1000 }`.
- Asserts exactly one painted background layer across shader, image, GLSL, and opaque modes.
- Keeps `app-background-glsl` present during the GLSL walk via a mocked `THREE.WebGLRenderer`/context.
- Forces a compile failure and confirms the shell falls back to `app-background-shader` with the configured color.

## Commands

Generated the gitignored i18n data required by the UI test runner in this side worktree:

```bash
node packages/shared/scripts/generate-keywords.mjs --target ts
```

After rebasing onto current `origin/develop`, ran the repo-required install:

```bash
bun install
```

Result: passed; artifacts synced to `2026-06-18.1`.

Focused GLSL fuzz test:

```bash
bun run --cwd packages/ui test -- App.screen-background-fuzz.test.tsx
```

Result: 1 file passed, 5 tests passed.

Adjacent background tests:

```bash
bun run --cwd packages/ui test -- App.screen-background-fuzz.test.tsx backgrounds/useBackgroundApplyChannel.test.tsx backgrounds/ProgrammableShaderBackground.test.tsx backgrounds/ProgrammableShaderBackground.rebuild.test.tsx backgrounds/AppBackground.test.tsx
```

Result: 5 files passed, 23 tests passed.

Formatting:

```bash
bunx @biomejs/biome check packages/ui/src/App.screen-background-fuzz.test.tsx
```

Result: passed.

UI package typecheck:

```bash
bun run --cwd packages/ui typecheck
```

Result: passed.

Root verification:

```bash
bun run verify
```

Result: failed at `audit:type-safety-ratchet` before typecheck/lint:

- `as unknown as`: `80 current > 77 baseline`
- ``?? {}`` in core/agent/app-core: `379 current > 377 baseline`

## Evidence rows marked N/A

- Screenshots/video: N/A — no runtime UI, styling, layout, or app behavior changed; this PR only extends a jsdom fuzz test.
- Frontend/backend logs: N/A — no browser or server flow changed.
- Real-LLM trajectories: N/A — no agent/action/provider/prompt/model behavior changed.
- Domain artifacts: N/A — no memory, DB, scheduled task, file, wallet, or generated runtime artifact is produced by this test-only change.
