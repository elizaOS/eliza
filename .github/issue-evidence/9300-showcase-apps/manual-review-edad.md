# Aesthetic + UX review — EDAD (`packages/examples/cloud/edad`)

**Verdict: `good`** · reviewed live (desktop 1280×900 + mobile 390×844) on
`bun run packages/examples/cloud/edad/server.ts`, agent (Claude) screenshot +
critique. Human sign-off: _pending_ (see contact sheet).

Screenshots: [`edad-desktop.png`](edad-desktop.png) ·
[`edad-desktop-journey.png`](edad-desktop-journey.png) ·
[`edad-mobile.png`](edad-mobile.png)

## Final HTML output

A single dark chat surface: a centred, max-width column with a header
(avatar + "eDad — the dad you never had"), a status row (status dot +
"sign in with eliza cloud"), the conversation, and a composer (textarea +
"send"). The "final HTML output" is `public/index.html` + `public/style.css`.

## Brand / color

- **No blue.** Adversarial computed-style scan (`color` / `backgroundColor` /
  all four `border*Color` over every element) found **0** blue-dominant elements.
- **Accent = warm gold/amber** — the "eDad" wordmark, the "send" button fill, and
  the sign-in button border. Resting→hover stays within the warm family. EDAD is a
  standalone creator app with its own identity (a dad-themed dark+gold palette),
  not the Eliza Cloud dashboard, so the orange-platform-accent rule applies as
  "warm accent, no blue" — which it satisfies.
- The status dot is a semantic indicator (green = READY, red = ERROR), not a
  brand accent — correct use.

## UX / flow (no dead ends)

- **Landing** renders cleanly; the "eDad isn't registered with eliza cloud yet"
  banner is the expected local state (no `ELIZA_APP_ID` set for the review run).
- **Login-gated send journey** (the key flow): typing a message + "send" while
  signed-out renders the user's bubble, flips the status to ERROR, and replies
  **in character** — "dad needs you to sign in with eliza cloud. click the button
  up top, kiddo." — with the sign-in CTA right there. No crash, no dead end, no
  silent failure; the user is told exactly what to do. This is the auth gate the
  showcase e2e asserts at the API layer, surfaced as graceful UI.
- **Responsive:** mobile (390×844) wraps message bubbles, keeps header + status +
  composer on screen, no overflow or layout break.

## Console / network

- `0` console warnings or errors on load and through the send journey.

## Findings

- None blocking. (Full provider-keyed chat — a real Eliza Cloud completion —
  requires `ELIZA_APP_ID` + a signed-in user; that path is covered by the
  showcase e2e loop and the `DEPLOY_AND_VALIDATE.md` live runbook.)
