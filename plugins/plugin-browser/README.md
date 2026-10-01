# @elizaos/plugin-browser

Adds browser automation through registered native Chromium profiles, the desktop
workspace, and configured hosted endpoints. Enable `features.browser` in host
configuration. The MV3 companion in `packages/os/browser` controls
the same visible profile through an authenticated native messaging host on Linux
and the supported Chromium Desktop Android build. It supports background tabs and
complete DOM snapshots; selectors expire after effects and require fresh readback.
Android Custom Tabs are addressable by their exact tab IDs while open, including
when backgrounded. Creating a new background tab requires a regular Chromium
window: open Chromium from the launcher once. Without one, the command returns
`UNAVAILABLE` before the effect and does not launch a window or retry elsewhere.
The Android app holds a certificate-verified Custom Tabs service binding while
its agent foreground service runs. Chunk acknowledgements bound Binder traffic
without shortening page context. Deployment still requires a verified extension
and a Chromium build provisioned for its native host; unpacked debug installation
is development evidence, not release provisioning.

`NativeSocketBrowserTarget.execute(command, { signal })` requires the peer's
`cancel` capability. An abort sends a request-ID fence and rejects with an unknown
outcome after dispatch; it never retries on another profile. Older peers reject
cancellable requests before dispatch. Callers still reconcile any uncertain effect.

`NativeTaskActuator` composes the core task journal with this transport. The host
supplies task lookup, reviewed page policy, durable binding revisions, protected
value resolution, outcome verification and redacted evidence storage. It checks
ownership and dispatched-operation identity, binds a main-frame observation,
consumes each target once, and requires a fresh readback before reporting a
verified outcome. It does not interpret bill policy or manufacture a success
from a click receipt. Ordinary fills cannot be used as a protected OTP path.

Native profiles are preferred before hosted browsers. Signed remote device grants
bind browser commands to one exact profile; older agent grants do not grant browser
access. A dispatched command is never replayed against a different session.
Android accessibility is a foreground-only fallback when the native profile is
unavailable before dispatch. Desktop workspace autofill requires prior per-domain
vault authorization and does not silently fill remote device profiles.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-browser build
bun run --cwd plugins/plugin-browser test
```

## Remote controllers

App, CLI and cloud hosts import `@elizaos/plugin-browser/remote-controller` to
compose owner-authorized remote profiles and encrypted runtime storage. That
entrypoint is server-only and is deliberately absent from the default/mobile
barrels. Renderers use only `remote-control/cloud-client` and
`remote-control/cloud-endpoints`; those leaves do not import controller crypto.
The shared wire contracts remain in core. Run `bun run --cwd
plugins/plugin-browser test:remote-control` for authority and real encrypted SQL
storage regressions.


Trusted hosts can use `NativeSocketBrowserTarget.guideTask` after negotiating
`task-guide` and `task-bind`. Supply the exact task context, increasing per-binding
guidance revision and a current main-frame snapshot selector. The extension admits
request IDs once and removes annotations on cancellation/rebind/disconnect.
This does not wire product pause/close or qualify installed browser UI behavior.

`NativeTaskActuator.showGuidance` requires an active task and a target from its
current observation. `quiesce` removes that owner's guide and waits for a removal
receipt, including after task revocation. Hosts using the interactive-task runtime
must await `settle` after control/account changes before acknowledging cleanup.
Failed removal stays tracked for retry; it never repeats a website action.
The actuator requires acknowledged feedback cleanup before and after effects.
It passes the proposal expiry through `execute`'s `taskExpiresAt` option so the
native preview cannot outlive action authority. Missing feedback capability stops
dispatch; a pointer/tap receipt never substitutes for outcome verification.
Scoped effects also require the peer's `task-action-feedback` capability; older
task-binding browsers fail before dispatch rather than skipping the preview.

A trusted value resolver can return `{ kind: "verification-code", text }` for a
protected OTP fill. The task transport requires the `task-protected-fill` peer
capability and introduces the marker through trusted execute options; raw command
markers are stripped. Native policy additionally requires an exact `fill-code`
target and an input with `autocomplete="one-time-code"`. Ordinary text fills,
password fields and Verify/submit clicks remain denied. The value still travels
only on the authenticated native channel and is excluded from DOM snapshots;
host evidence/screenshot pipelines must also preserve secret redaction. This
primitive does not resolve codes, grant account access, or qualify a live provider.

Android hosts set `ELIZA_BROWSER_ANDROID_APPLICATION` to their application ID
when starting the native target. It connects and reconnects only to that app's
`<applicationId>.browser.native` abstract socket. The default remains
`ai.elizaos.app`; malformed or oversized IDs fail before connecting. This selects
the host relay and does not replace its same-UID or Chromium certificate checks.
