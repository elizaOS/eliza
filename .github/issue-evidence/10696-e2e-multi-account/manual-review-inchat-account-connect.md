# Manual review — in-chat AccountConnectBlock

Story: `Chat/MessageContent` → `AccountConnect` (renders the block a CONNECT_ACCOUNT
turn produces). Captured via Storybook + Playwright at desktop (1280×800) and
mobile (390×844), dark theme.

- **inchat-account-connect-desktop.png** / **-mobile.png**

## Verdict: good

- Heading "Add another account" + subheading render; two provider rows
  (Claude Subscription, OpenAI Codex) each with the live linked-account count and
  an "Add account" button that opens the existing `AddAccountDialog` inline.
- Brand-correct: orange accent buttons, no blue anywhere, neutral rows.
- Legible on both viewports; block is entry-point-only (no duplicate accounts UI).
- Bug caught + fixed by this capture: the count read `{{count}} connected`
  (the app `t()` does not interpolate `{{…}}` inside a `defaultValue`) — now
  renders the actual number (`0 connected` here; `N connected` with linked accounts).

Counts show `0 connected` because Storybook runs without a backend (`useAccounts`
returns none); against a live agent the rows show the real per-provider counts.
