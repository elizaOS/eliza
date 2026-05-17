# Visual Regression — os-usb-installer

Baseline screenshots that catch unintended visual changes during redesign work.

## Status: Playwright not yet installed

This package currently has only `vitest` configured. The spec at
`tests/visual.spec.ts` is staged but will not run until Playwright is wired up.

### Required setup before first run

1. Add Playwright as a devDependency:
   ```bash
   bun --cwd packages/os-usb-installer add -D @playwright/test
   bunx playwright install chromium
   ```
2. Create `packages/os-usb-installer/playwright.config.ts` modeled on
   `packages/os-homepage/playwright.config.ts`. It needs:
   - `testDir: "./tests"` with a `testMatch` that targets `visual.spec.ts`
     (the existing `vitest` glob covers `*.test.ts`, so file extensions
     should already be separate; double-check `vitest.config.ts` does not
     pick up `*.spec.ts`).
   - A `webServer` block that runs `bun run dev` (or `vite preview` on a
     built bundle) on a free port (e.g. 4466).
   - `use.baseURL` matching that port.
   - Desktop + mobile projects (see other consumers for the pattern).
3. Add a `test:e2e` script to `package.json`:
   ```json
   "test:e2e": "playwright test"
   ```

### Generate baselines (after setup)

```bash
bun --cwd packages/os-usb-installer run test:e2e -- --update-snapshots
```

PNGs land in `tests/visual.spec.ts-snapshots/`. Commit them.

## Routes covered

`/` at desktop (1280×720) and mobile (390×844 — iPhone 14 Pro). The installer
is a single-page Electrobun shell so there is only one route to snapshot.

## Dynamic content

Animated elements are masked (`video`, `[data-testid="cloud-video"]`,
`.animate-pulse`, `.animate-spin`, `[data-marquee]`).
