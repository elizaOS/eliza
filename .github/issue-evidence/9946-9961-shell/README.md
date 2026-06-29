# #9946 modality owner + #9961 simplified login (live render)

## #9946 — single shell-level modality owner
`detectDomModality()` now consults a shell-declared `window.__elizaShellModality`
(XR headset still wins), so every leaf reads one authoritative source instead of
re-guessing per-leaf. `ShellModalityProvider` (mounted once in
`packages/app/src/main.tsx`) sets it for the GUI shell.

`app-home-shell-providers.png` — the live app with `ShellModalityProvider` +
`ShellRoleProvider` mounted. Playwright evaluated `window.__elizaShellModality`
=== **"gui"** and reported **0 page errors** — the shell owns the modality
contract authoritatively and the existing registered-view-parity / plugin-framing
tests still pass (the shell signal defaults to current behavior when unset).
4 `detectDomModality`/`setShellModality` unit tests.

## #9961 — simplified login (fresh flow)
`cli-login-fresh-flow.png` — navigating `/auth/cli-login` with no session lands
on the simplified surface with **0 "Close Window" buttons** (the dead-button fix,
verified live). The land-in-web-UI redirect (`navigate('/dashboard')` on success)
is already on develop via the fleet's #9971.
