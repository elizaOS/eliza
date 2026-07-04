# 12914 Home-Screen Frame Gate Evidence

Issue: #12914
Branch: `fix/12914-home-frame-gate`
Base: `origin/develop` at `f2c2377e06b`

## Setup

The validation worktree was installed with the lightweight no-postinstall path,
then the generated data and workspace links needed by this isolated browser
runner were prepared explicitly:

```bash
bun install --no-save --ignore-scripts --cache-dir "$HOME/.bun-install-cache-deploy"
node packages/scripts/ensure-workspace-symlinks.mjs
node packages/shared/scripts/generate-keywords.mjs --target ts
```

## Validation

```bash
node --check packages/ui/src/components/shell/__e2e__/run-home-screen-e2e.mjs
git diff --check origin/develop..HEAD
bun run --cwd packages/ui test:home-screen-e2e
```

The e2e runner completed successfully and exercised the updated multi-window
rail-swipe gate:

```text
[rail-swipe 1/3] fps=120.0 p95=9.6ms worst=10.2ms dropped=0/303 (0%) long=0
[rail-swipe 2/3] fps=120.0 p95=9.3ms worst=10.4ms dropped=0/304 (0%) long=0
[rail-swipe 3/3] fps=120.0 p95=9.4ms worst=10.3ms dropped=0/302 (0%) long=0
[rail-swipe median] p95=9.4ms dropped=0% attempts=3
rail swipe median stays within the frame budget (p95 9.4ms <= 33.3ms, dropped 0% < 20%)
HOME-SCREEN E2E PASSED
```

## Artifact Review

Reviewed `12914-home-frame-gate-mobile-launcher.png`, copied from the generated
`packages/ui/src/components/shell/__e2e__/output-home/04-mobile-launcher.png`
artifact from the passing run. The mobile launcher rendered as a single-page
grid with the expected app/developer tiles, visible image icons, and no page-dot
collision.
