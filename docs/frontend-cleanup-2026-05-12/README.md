# Frontend cleanup — 2026-05-12

Research-first cleanup pass across all frontend packages.

## Packages in scope

| Package | Path | Files |
|---|---|---|
| eliza-ui | `eliza/packages/ui/src` | 726 |
| eliza-app-shell | `eliza/packages/app/src` + `apps/app/src` | 16 |
| eliza-app-core (UI-touching) | `eliza/packages/app-core/src` | 333 (subset) |
| homepage | `apps/homepage/src` (+ `eliza/packages/homepage` if present) | 49+ |
| cloud-frontend | `eliza/cloud/apps/frontend/src` | 303 |
| cloud-ui | `eliza/cloud/packages/ui/src` | 186 |

## Plan files

- `01-eliza-ui-components-major.md` — pages + composites + ui (171 files)
- `02-eliza-ui-components-features-A.md` — settings + shell + apps + chat (111 files)
- `03-eliza-ui-components-features-B.md` — remaining feature components (~85 files)
- `04-eliza-ui-state-hooks.md` — state + hooks + providers + events (~92 files)
- `05-eliza-ui-api-services-bridge.md` — api + services + bridge (~90 files)
- `06-eliza-ui-misc.md` — onboarding + layouts + platform + utils + lib + voice + terminal + widgets + character + content-packs + desktop-runtime + i18n + themes + types + slots + navigation + stories + App.tsx + root files
- `07-eliza-app-shell.md` — shell bootstrap
- `08-cloud-frontend-dashboard.md` — dashboard/
- `09-cloud-frontend-rest.md` — components + pages + lib + shims + docs + root
- `10-cloud-ui-package.md` — cloud/packages/ui
- `11-homepage.md` — homepage(s)
- `12-app-core-ui-touching.md` — app-core (frontend-touching parts only)
- `13-render-telemetry-plan.md` — design for dev-time render telemetry, e2e integration
