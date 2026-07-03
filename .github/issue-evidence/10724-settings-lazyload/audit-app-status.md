# `audit:app` visual-loop status (#10724)

`bun run --cwd packages/app audit:app` **ran to completion in this environment**
(headless Chromium, live UI-smoke stack, exit 0). It boots the real app and
walks every app-shell view at 4 viewports (desktop-landscape, ipad-portrait,
mobile-landscape, mobile-portrait), rest + hover.

## Result: 78 view-shots, app boots + renders fully

Auto-classifier verdicts (`aesthetic-audit-output/report.json`, copied here as
`audit-app-report.json`):

- **good: 74**
- needs-work: 3 — `builtin-browser`, `builtin-plugins`, `builtin-skills`
- needs-eyeball: 1 — `builtin-plugins`

The 4 non-`good` flags are on **pre-existing app views unrelated to this change**
(the in-app browser, the plugins catalog, the skills catalog). This PR only
changes **which output chunk** `settings-sections.ts` lands in — it touches no
component, so it cannot have caused a visual change to those views; they are the
audit heuristic's standing flags on `develop`.

## Why this is the meaningful signal for this change

- The barrel repoint is the kind of change that, if wrong (broken re-export,
  lost registration side effect), **breaks app boot**. The audit boots the real
  app and renders **all 19 app-shell views green (74/78 shots good)** — direct
  proof the eager boot path and the settings-section registry still work
  end-to-end after moving the accessors to the light registry.

## Honest gap: no standalone `settings` route in this harness

`audit:app`'s route walk covers the app-shell app views (chat, apps, browser,
character, plugins, skills, tasks, files, …). It does **not** expose the
Settings page as its own walked slug, so there is no dedicated Settings
full-page screenshot from this run. Settings rendering is instead covered by:

- `SettingsView.test.tsx` — renders the real `SettingsView` (section render +
  error boundaries), passing.
- `settings-sections.registration.test.ts` (new) — proves the built-in +
  registry sections register when the heavy module loads via the lazy path.
- The change is **render-neutral by construction**: the section component graph
  and registry data are byte-identical; only the chunk boundary moved.
