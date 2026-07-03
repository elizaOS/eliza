# Remote onboarding option — on-device capture (Pixel 6a, PR #11761)

Proves the Remote first-run runtime option (shipped in #11761) renders on a real
device: the third chip "Connect to a remote agent" and its inline URL + access-
token connect form. This is exactly what was requested — "'Remote' for the third
option, and it has connection stuff in the widget."

## Build
- `ai.elizaos.app` rebuilt from `develop` at the #11761 merge (126166cecc),
  installed via `adb install -r`, `lastUpdateTime` 2026-07-02 19:50.
- Local model inference native lib omitted for this capture (same as the prior
  onboarding evidence — the fused lib / omnivoice FFI header aren't in the
  worktree); the onboarding UI is a pure web render, unaffected.

## How the chooser was surfaced
On a fresh install the mobile shell writes a client-side `eliza:first-run-complete=1`
flag and boots straight to home (auto-local), even though the local agent's
`GET /api/first-run/status` returns `{"complete":false}`. Cleared that localStorage
flag over CDP (`adb forward` → the app's `webview_devtools_remote` socket →
`localStorage.removeItem('eliza:first-run-complete')` + reload); the conductor then
re-derives first-run-incomplete from the backend and seeds the runtime chooser.
(Worth noting as its own UX point: the client flag can hide onboarding while the
backend still considers it incomplete.)

## Screenshots
| File | Shows |
|---|---|
| `01-remote-chooser.png` | "First, where should your agent run?" with THREE chips: **Eliza Cloud (managed)**, **On this device**, **Connect to a remote agent**. |
| `02-remote-connect-form.png` | After tapping the Remote chip: the inline form — **Remote agent URL** field, **Access token (optional)** field, **Connect** button ("Remote agent · Pending"). |

## What the form does (from the merged code)
The `Connect` submit runs `normalizeRemoteAgentUrl(url)` then dispatches the
hardened `CONNECT_EVENT` (`{gatewayUrl, token, completeFirstRun:true,
skipConfirm:true}`); the shell handler connects to the remote agent, adopts it as
the active runtime via `adoptRemoteAgentFirstRun`, and finishes onboarding. The
values are never written to the secret store. An invalid URL surfaces an inline
error and keeps the form editable. Covered by 70 passing ui tests (#11761).
