# #10690 App Platform Review Evidence

Date: 2026-07-01
Branch: `fix/10690-app-platform-review-docs`
Base under test: `15d2a7c58fa2aae244a455834d628795647438a5`

## Change Verified

This PR completes a local, reviewable #10690 slice:

- adds `packages/cloud/APP_PLATFORM_REVIEW.md`, covering app lifecycle,
  backend hosting, custom domains, analytics, SEO, advertising/growth,
  content generation, agent skill contract, access policy, and cross-issue
  coordination;
- records a concrete managed-frontend hosting decision: Worker/R2 static host
  with active app manifest, app/domain routing, SEO injection, page analytics,
  cache policy, and rollback;
- adds `packages/skills/skills/eliza-cloud/references/app-platform-lifecycle.md`;
- updates `packages/skills/skills/eliza-cloud/SKILL.md` so bundled agents use
  the unified app lifecycle and do not claim managed frontend hosting exists
  before it lands.

## Manual Review

Opened and reviewed:

- `packages/cloud/APP_PLATFORM_REVIEW.md`
- `packages/skills/skills/eliza-cloud/SKILL.md`
- `packages/skills/skills/eliza-cloud/references/app-platform-lifecycle.md`

The review doc maps concrete route/schema/service owner files and links the
new sibling issues:

- #10687 advertising/growth marketplace
- #10688 content generation + files/assets CRUD
- #10689 Atlas video/provider registry
- #10691 non-CI app/domain money-path e2e
- #10692 any-device GitHub/device-code connect

Screenshots/video: N/A for this slice. It is docs/skill guidance with no UI or
runtime route changes. The reviewable artifacts are the Markdown files above.

Live cloud e2e: N/A for this slice. It does not alter a Cloud route, DB schema,
money path, or frontend view. The issue remains open for the implementation and
live-evidence slices.

## Commands

```bash
bun install --frozen-lockfile --ignore-scripts
# installed dependencies successfully

bun run --cwd packages/skills lint:check
# Checked 6 files in 15ms. No fixes applied.

node packages/shared/scripts/generate-keywords.mjs --target ts
# generated the ignored core/shared i18n keyword data needed by the skill tests

bun run --cwd packages/skills test
# 60 pass, 0 fail

git diff --check
# pass

bun run verify
# fails in audit:type-safety-ratchet before typecheck/lint:
# scanned 9901 tracked production source files
# as unknown as: 108 current > 77 baseline
# top offenders are packages/feed, packages/agent, packages/app-core,
# packages/cloud, and plugins/plugin-capacitor-bridge
```

The repo-wide verify failure is unrelated to this docs/skill slice and matches
the current unsafe-cast ratchet failure observed on other branches.
