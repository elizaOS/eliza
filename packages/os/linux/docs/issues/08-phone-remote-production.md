# mobile/cloud: production phone remote for a local elizaOS agent

Repository: `elizaOS/eliza`

Suggested labels: `mobile`, `cloud`, `desktop`, `security`, `release-blocker`

## Work

Implement production pairing and end-to-end authenticated command delivery
between the Eliza phone/web UI and a specific local desktop agent. The Cloud
relay routes encrypted envelopes; it never receives a reusable local broker
credential and never connects to the root service.

Integrate the OS-side remote envelope and activity contracts under
`linux/control` in `elizaOS/os`.

## Acceptance criteria

- Pairing requires local owner presence and produces per-device revocable keys.
- Commands bind device, desktop, owner session, nonce, sequence, issued time,
  expiry, and payload digest.
- Replay, revoked device, wrong desktop, stale/offline-expired command, forged
  relay message, account logout, owner switch, and screen-lock policy fail.
- Local UI always shows remote-control activity and provides an independent
  pause/kill control.
- Catastrophic local confirmation cannot be completed remotely.
- Concurrent local and phone requests have deterministic ordering and cancel
  semantics.
- Phone loss/revocation and offline desktop recovery are tested on real iOS or
  Android hardware and a real Linux desktop.
