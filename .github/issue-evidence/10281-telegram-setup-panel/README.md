# Evidence — #10281 Settings → Connectors drops the Telegram setup panel

## The bug

In **Settings → Connectors**, expanding **Telegram** → **Bot Token** mode rendered
the env-config form **OR** the dedicated setup panel (either/or), so the live
`TelegramBotSetupPanel` (token validation + bot-identity confirmation +
disconnect) was silently dropped. The canonical `/connectors` page rendered
**both** together. Root cause: the two surfaces (`ConnectorsSection.tsx` and
`plugin-view-connectors.tsx`) each inlined the same three-way placement branch
independently and drifted.

## The fix

Extracted `components/connectors/ConnectorBodyLayout.tsx` — the single source of
truth for where the setup panel sits relative to the config form
(`showPluginConfig ? form + panel : panel ? panel : fallback`). Both surfaces
now route through it, so the panel can never be dropped from one and not the
other again.

## Before / after — real rendered DOM (jsdom, real `<ConnectorsSection/>`)

Both files are the actual `data-connector="telegram"` subtree rendered by the
real component in Bot Token mode, captured by mounting `<ConnectorsSection/>`,
clicking `connector-mode-telegram-bot`, and dumping the DOM.

| | env-config form (`Save settings`) | `TelegramBotSetupPanel` |
|---|---|---|
| **`telegram-bot-mode-BEFORE.html`** (buggy develop) | present | **absent — dropped** |
| **`telegram-bot-mode-AFTER.html`** (this PR) | present | **present — co-rendered** |

The HTML comment at the top of each file records the assertion result
(`form present: … | setup panel present: …`).

## Tests

- `ConnectorBodyLayout.test.tsx` — the 3-way placement rule (co-render when both
  exist; form-only; panel-only; fallback).
- `ConnectorsSection.test.tsx` — renders the **real** `<ConnectorsSection/>`,
  selects Bot Token mode, asserts the form **and** `TelegramBotSetupPanel`
  co-render. **Proven to fail on the unfixed code** (panel absent) and pass with
  the fix.
- `ConnectorsSection.routing.test.ts` — asserts telegram bot mode satisfies BOTH
  gates (`showForm` && `hasConnectorSetupPanel`), and discord bot mode satisfies
  only the form gate (form-only is correct).

## Per PR_EVIDENCE.md

- **Before/after full-page screenshots** — substituted with real rendered-DOM
  before/after (above). This is a logic-placement fix: the components and their
  styling are unchanged; the only difference is whether the already-registered
  `TelegramBotSetupPanel` is mounted in the Bot Token branch. A full
  `audit:app` build was not run (the dev disk is at 99%; a full app build is
  infeasible here and would add no signal for a no-styling logic fix).
- **Real-LLM trajectory / backend logs / audio** — N/A: UI-presentation fix; no
  agent/model/server/voice path touched.
