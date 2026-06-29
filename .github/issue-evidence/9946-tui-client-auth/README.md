# Evidence — #9946 residual: TUI client authentication

Most of #9946 already landed on develop while this work was in flight:
- `#9982` — killed the fictional "SSH" naming + put `packages/tui` on a PR CI lane.
- `#9986` — whole-app TUI e2e harness driving the real shell via a VirtualTerminal.

This PR closes the **one remaining gap** from the issue's critical-assessment
point 2: *"The TUI client sends zero auth and depends on a loopback trust gate
that breaks under tunneling."*

## Change
`agent-terminal-tui.ts`: `readJson` now attaches `Authorization: Bearer
$ELIZA_API_TOKEN` when that env var is set (via exported `resolveTuiApiToken` /
`buildTuiAuthHeaders` helpers). `ELIZA_API_TOKEN` is the exact key `isAuthorized`
validates — no phantom fallbacks. Omitted when unset, so same-host loopback
sessions are unchanged. This is what lets a tunneled/reverse-proxied terminal
(which injects `X-Forwarded-For`, disabling the loopback-trust gate) actually
authenticate.

## Test — `tui-client-auth.test.ts`: 2 passed
- `resolveTuiApiToken` returns the trimmed token when set, null when empty/unset.
- `buildTuiAuthHeaders` returns `{ Authorization: "Bearer <tok>" }` only when a
  token is configured, `{}` otherwise.
