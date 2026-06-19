# Visual Regression — cloud-frontend

Baseline screenshots that catch unintended visual changes during redesign work.

## Generate baselines (first run, or after an intentional redesign)

```bash
bun --cwd packages/cloud-frontend run test:e2e -- --update-snapshots visual.spec.ts
```

This writes PNGs into `tests/e2e/visual.spec.ts-snapshots/` (Playwright's default
location, alongside the spec). These PNGs are the source of truth — commit them.

## Run the diff (CI / local verification)

```bash
bun --cwd packages/cloud-frontend run test:e2e -- visual.spec.ts
```

Failures drop diff PNGs into `test-results/` (gitignored).

## When to regenerate

- Intentional redesign / restyle.
- Brand asset swap (logos, fonts).
- Layout-affecting dependency upgrade (Tailwind, etc.).

Never regenerate to "make CI green" without first eyeballing the diff —
that defeats the purpose.

## Routes covered

`/`, `/login`, `/checkout`, `/os`, `/bsc`, `/privacy-policy`, `/terms-of-service`
at desktop (1280×720) and mobile (390×844 — iPhone 14 Pro).

## Dynamic content

Animated elements (`video`, `[data-testid="cloud-video"]`, `.animate-pulse`,
`.animate-spin`, `[data-marquee]`) are masked. Add new selectors to the
`dynamicMask` helper in `visual.spec.ts` if you introduce new animations.

## Auth

Spec sets the `eliza-test-auth=1` cookie so gated routes render. Backend is not
required for snapshots — pages render with stubbed auth state via
`VITE_PLAYWRIGHT_TEST_AUTH=true`, which the existing `playwright.config.ts`
`webServer` block already provides.
