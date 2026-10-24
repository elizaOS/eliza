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

Trusted hosts can call `NativeSocketBrowserTarget.waitForProfile(profileId, { timeoutMs, signal })`
before binding a task after restart. It waits at most 10 seconds by default
(30 seconds maximum), rejects a different registered profile immediately, and
stops on cancellation or transport shutdown. It sends no commands and never
retries dispatched work. Hosts must recheck task/account authority after waiting.

`NativeTaskActuator` requires the browser's one-use exact-value readback for public
fills before consulting host verification. Missing or mismatched proof returns an
unknown outcome and does not replay the fill. This includes older browser peers
that do not supply the proof; update the browser component with the host. Protected
code entry retains its separate policy and verification contract.

For an advisory-enabled peer, trusted hosts can call
`NativeSocketBrowserTarget.setProtectionOwner(opaqueOwnerOrNull)` after profile
registration and every account transition. `onProfileRegistered(listener)` notifies
the host after each registration, including a current connection when subscribed.
The receipt's `isCurrent()` must be checked again after asynchronous account reads;
a disconnect, replacement, unsubscribe or stop invalidates it. Registration itself
is not account authentication. This is not a model browser action.
Disconnect retires the extension's account context; reconnection does not restore
it automatically. The receipt counts updated/unavailable tabs. It grants no task
permission and does not override blacklist rules. Missing capability rejects.

`NativeTaskActuator` composes the core task journal with this transport. The host
supplies task lookup, reviewed page policy, durable binding revisions, protected
value resolution, outcome verification and redacted evidence storage. It checks
ownership and dispatched-operation identity, binds a main-frame observation,
consumes each target once, and requires a fresh readback before reporting a
verified outcome. It does not interpret bill policy or manufacture a success
from a click receipt. Ordinary fills cannot be used as a protected OTP path.

For unknown operations, an optional trusted `reconcile` callback interprets a
fresh snapshot against durable host provenance. The actuator creates a new native
binding with an empty action-target allowlist, checks task identity and revision
at every await boundary, and never caches the readback as an action observation.
Only an explicit later Resume can establish a fresh ordinary binding. A snapshot
is evidence to interpret, not proof that an effect succeeded.

Native profiles are preferred before hosted browsers. Signed remote device grants
bind browser commands to one exact profile; older agent grants do not grant browser
access. A dispatched command is never replayed against a different session.
Android accessibility is a foreground-only fallback when the native profile is
unavailable before dispatch. Desktop workspace autofill requires prior per-domain
vault authorization and does not silently fill remote device profiles.

## Embedded native pages

`NativeSurfaceBrowserTarget` accepts an authenticated surface command channel.
It supplies the existing `NativeTaskActuator` with the current selected page,
task binding, guidance and main-frame snapshot/click/fill/select/scroll/follow operations.
Its compatibility `getProfileId()` returns an `embedded:` connection identity;
it never claims a Chromium extension or profile. Stopping the target aborts its
in-flight channel requests. Every request names that exact connection, so a
replacement during account lookup cannot receive an old command. The owning
host controls the channel lifetime.

The trusted renderer composes `createSurfaceTaskHandler` from
`packages/os/browser/src/surface-task-handler.mjs` with native page selection,
control, inventory and annotation-cleanup ports. It reuses the task binding and
preview checks. A cleanup failure after input remains an uncertain outcome.
No page offer answers, arbitrary scripts, protected fills, child frames or
coordinate input are supported by this adapter. Full general browser control
and product composition require their own implementation and acceptance.

The embedded task target supports `browser.follow` for an observed same-origin
HTTPS anchor. It loads the snapshot's exact destination without running a click
handler. The host must authorize the target and the task capability; the normal
preview, one-use reference, expiry, effect journal and readback checks apply.
It refuses URL credentials, download links and new-window targets. It is not a
form submission or consent grant. Desktop workspace and socket targets do not
support this operation yet. If a follow returns `UNCERTAIN_OUTCOME`, the actuator does not replay it. It
checks one fresh snapshot against the exact observed same-origin HTTPS destination
and then requires host verification. A missing or different destination, effect
violation, changed authority or failed cleanup remains unknown. Other uncertain
effects retain the explicit reconciliation path.

A failed native-socket request also carries a stable `reason` beside its `kind`
(`NATIVE_SOCKET_FAILURE_REASONS`): `reply-timeout`, `request-cancelled`,
`profile-unavailable`, `connection-lost`, the peer's `frame-inventory-incomplete`,
`frame-identity-changed`, `frame-read-incomplete` and `page-loading`, or
`peer-error` for any other peer failure. Match `reason`, not the message text.

Native `select` takes an exact visible option label in `text` (or the workspace
`value` field). Snapshots report option labels, disabled state and selection,
never internal option values. Missing, disabled or duplicate labels are refused.
This operation covers single-choice native selects; multi-select widgets need
separate support. The task actuator uses a host-held value reference and verifies
the result from a new observation, as it does for other effects.

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
Peers with `task-guide-label` also accept `detail`, `tone`, offer `answers`,
`kind: "pause"` and a binding `assistantName`; older peers reject them before
dispatch. `onTaskGuideAnswer` delivers one tap per current offer as
`{tabId, stepId, revision, answerId}`. It never carries the value. Answers to a
replaced offer are dropped. `NativeTaskActuator` passes these fields, returns the
guide revision and adds `pauseGuidance`. Installed browser UI is not qualified here.

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

A proposal can set `expectedSelector` to the one reviewed binding target it is
for. The actuator refuses it before dispatch unless the binding holds that
selector for the action, and the browser (`task-expected-target`) accepts no
other node. For 30 seconds after a task fill or click (or until the next one), the browser
stops any form submit or move to another document that the person's own input
did not start (a link click still opens its link). It also records, without
being able to stop them, a same-document address change (`history.pushState`)
and a fetch, XMLHttpRequest or beacon to the page's own site, such as a code
field that verifies itself with `fetch()`. A snapshot then reports
`effectViolation` (`submit`, `navigation` or `request`); the actuator records
such an action as an unknown outcome, and the bill workflow pauses on any later
snapshot that carries it. A request still in flight when the actuator reads its
after-action snapshot appears only in a later snapshot, and anything the page
does after the 30 seconds is not watched. `showGuidance` accepts
`keepClearRefs` (controls the label must not cover, peer capability
`task-guide-keep-clear`) and returns `placement` and `dismissed`.

A task is bound to its starting origin. When a site hands the person to another
one (`https://www.ssa.gov` to `https://secure.login.gov` and back), the trusted
host checks that exact origin (blocklist, look-alike) and calls
`InteractiveTaskRuntime.extendOrigin(id, revision, origin, checkOrigin)`; it is
never automatic. The `extend-origin` transition adds the origin under a new
epoch, records the grant with the check reference, and from then on records the
origin chain (`originChain`) and each observed origin in the event journal.
`retractOrigin` removes a granted origin (the starting ones stay) and fences
in-flight work like pause. The runtime then calls the actuator's
`scopeChanged`: `NativeTaskActuator` drops page facts and guidance from the old
scope and calls the host's `applyOrigins`, for example the native surface's
`setTaskOrigins`. The next binding of an extended task carries every allowed
origin as `origins` (peer capability `task-origins`); each observation records
the page's own origin, and each command stays scoped to the origin of the page
it reads or acts on.

A consented commit is the one exception, and only for a step the person said
yes to. The host passes a `commitGrant` callback to `NativeTaskActuator`; it
returns a `NativeCommitGrant` only after the host has recorded her explicit yes
to this exact step, control and (for a fill or select) value, and `undefined`
for every other action. A grant names the task, epoch, binding origin, the
observed control (`targetRef`, so one page observation), its reviewed
`selector` (the proposal's `expectedSelector`), the subaction, for a fill or
select the required lowercase SHA-256 `valueHash` of the exact text (a click
carries none), and `expiresAt` at most
`COMMIT_GRANT_MAX_MS` (60 seconds) ahead. The actuator refuses a mismatched
grant before dispatch, and only a peer advertising `task-commit-grant` receives
one. The browser checks every field again, spends the grant once (a spent ID is
refused, also after a bridge restart; a refusal after admission still spends
it), and lets the commit control be pressed. The watch then lets exactly one
commit through: the submit the granted control itself sends to the page's
origin with its page load (POST or GET), or, when no such page load is under
way, the one own-site request the grant expects (a script form or button that
sends with fetch). A
submit with no submitter (`requestSubmit()` or an implicit submission) counts
only when the granted control is the form's default button and overrides
nothing.

The expected request is the grant's optional `requestTarget`
(`{ path, method }` for a path and optional query on the page's origin, or
`{ url, method }` for an absolute https URL; method `GET`, `POST`, `PUT`,
`PATCH` or `DELETE`). Without one it is the granted submit button's form
action and method (a GET form by origin and path), and a control that is not a
submit button, such as a script "Pay" button, has none: its request is then
reported as an `effectViolation`. Declare `requestTarget` for such a control.
A declared target also binds the granted form's page load. The page compares
the request URL exactly; it cannot see a fetch or XHR method, so it checks the
method only for a beacon (always POST) and a page load.

The grant's optional `formHash` binds the form contents: `commitFormHash(entries)`
(exported from `native-socket-target`) over the `[name, value]` pairs the host
showed the person, in the order the form sends them, the submitter's own
name/value included and file inputs left out (SHA-256 of
`"eliza-commit-form-v1\n"` and the JSON pairs, CRLF and CR made LF, NFC). The
page computes the same hash from the submit's actual FormData and again from
its page load's form data (or GET query), and consents only on a match, so a
field a script changed or a hidden input it added after her yes stops the
submit. Under a `formHash` a request is consented only after such a matching
submit. Hosts doing money commits MUST send `formHash`. Without one, the
snapshot's `consentedCommit` carries the hash of the form data sent
(`{ grantId, kind, formHash }`; left out for a form with a password, code or
card field) for the host to compare after the fact, and the actuator treats a
reported hash that differs from a granted one as an unknown outcome. Hidden
inputs count, and snapshots do not expose field values, so the host must know
every value it hashes.

A
snapshot reports the commit as `consentedCommit`. A submit the
page cancels cannot be sent later. A submit from another submitter of the same
form, a submit whose action, method, target or encoding differs from the
granted control's when it was pressed, changed or added form data, a script
`form.submit()` (one into another window, which the page cannot stop, is
reported), a second
submit, another form, a submit to
another origin, any other own-site request, a same-document address change
and any other move to another document are still stopped or recorded as
`effectViolation`, which the actuator treats as an unknown outcome. The actuator treats
a `consentedCommit` for any other grant as an unknown outcome. Without a grant
nothing changes: commit controls stay blocked.

`NativeSocketBrowserTarget.currentPage()` is a trusted host read of the page the
person sees in the connected profile. It sends one `list` command and returns the
single active HTTPS tab as `{ tabId, origin, title }`: the origin without path,
query or fragment, and the complete title from `currentPageTitle()`, with control
characters and whitespace normalized. This preserves the authorized source
context without truncation or heuristic replacement. The title is written by
the website, so hosts pass it to a model as quoted data, never as instructions.
It returns `null` when no single active HTTPS page is known: no active web tab,
more than one browser window (the extension's `list` reply counts windows before
it drops non-web tabs, so a window showing only a new-tab or settings page
counts), an extension that does not report `windowCount`, or a non-HTTPS page.
Which window has focus is not read, so with one window the active tab is taken
as the page she sees. Incognito windows are counted only when the extension is
allowed in incognito; otherwise she may be looking at one that is not counted.
The result is conversation context only. It binds no task and permits no action.

Android hosts set `ELIZA_BROWSER_ANDROID_APPLICATION` to their application ID
when starting the native target. It connects and reconnects only to that app's
`<applicationId>.browser.native` abstract socket. The default remains
`ai.elizaos.app`; malformed or oversized IDs fail before connecting. This selects
the host relay and does not replace its same-UID or Chromium certificate checks.
