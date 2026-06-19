# Visual Regression — os-usb-installer

Baseline screenshots that catch unintended visual changes during redesign work.

## Status

Playwright is wired through `playwright.config.ts` and `package.json`.
`test:e2e` builds the Vite bundle, serves it with `vite preview`, and uses
mocked `/api/*` routes so the UI can be tested without a live raw-disk backend.

Before the first local run on a fresh machine, install the Chromium runtime:

```bash
cd packages/os/usb-installer
bunx playwright install chromium
```

Normal e2e smoke:

```bash
bun run --cwd packages/os/usb-installer test:e2e
```

### Generate Baselines

```bash
ELIZAOS_USB_VISUAL_SNAPSHOTS=1 bun run --cwd packages/os/usb-installer test:e2e -- --update-snapshots
```

PNG baselines land in `tests/visual.spec.ts-snapshots/`. Snapshot comparison is
opt-in through `ELIZAOS_USB_VISUAL_SNAPSHOTS=1`; normal `test:e2e` verifies the
page renders and the mocked installer data appears without requiring Linux-only
PNG baselines in every CI lane.

## Routes covered

`/` at desktop (1280×720) and mobile (390×844 — iPhone 14 Pro). The installer
is a single-page Electrobun shell so there is only one route to snapshot.

`tests/wizard.spec.ts` covers the guarded wizard flow: drive selection, image
selection, specs, target-device confirmation, write execution via server
`planId`, SSE completion, and complete state.

## Dynamic content

Animated elements are masked (`video`, `[data-testid="cloud-video"]`,
`.animate-pulse`, `.animate-spin`, `[data-marquee]`).
