# Entitlement justifications (Mac App Store)

Short, App Review-facing rationale for every entitlement in `mas.entitlements`
and `mas-bun.entitlements`. Each entry covers what the entitlement permits,
why the app needs it, and what the OS sandbox still blocks despite the grant.

Reviewers should treat this as a single-page reference; it mirrors the
runtime behavior and is verified empirically by `scripts/mas-smoke.mjs`
against every shipped build.

---

## Parent app (`mas.entitlements`)

### `com.apple.security.app-sandbox`
Enrolls the application in the macOS App Sandbox. This is mandatory for every
Mac App Store submission and is the foundation on which every other entitlement
in this file is gated. With the sandbox enrolled, the OS denies all
disk, network, hardware, and IPC access by default and only re-grants the
specific capabilities listed below.

### `com.apple.security.network.client`
Permits the app to open outbound TCP/UDP connections (HTTPS, WebSockets). The
app makes outbound calls to AI inference providers selected by the user
(OpenAI, Anthropic, the user's optional Eliza Cloud account) and to a local
loopback for renderer/agent IPC. The sandbox still blocks all inbound
connections from other hosts, all raw-socket access, and all non-user-initiated
discovery.

### `com.apple.security.network.server`
Permits the app to bind a local listening socket on loopback so its own
processes (renderer, agent runtime, dev observability endpoints) can
communicate over HTTP/WebSocket on `127.0.0.1`. No external host can reach
these sockets — macOS still firewalls inbound connections from outside the
machine unless the user explicitly approves the system Network prompt.

### `com.apple.security.files.user-selected.read-write`
Permits the app to read and write files the user explicitly selects in a
standard open/save panel or drops onto the app. Users routinely point the
agent at documents, configuration files, and images they want analyzed,
edited, or attached to a chat. Without an explicit user selection in a system
panel, the sandbox still denies access to every file outside the app's
container.

### `com.apple.security.files.downloads.read-write`
Permits the app to read and write inside the user's `~/Downloads` folder
without a per-file picker prompt. The agent generates artifacts (images,
exports, summaries) that the user expects to find in `~/Downloads` like any
other Mac app. The sandbox still blocks every other location in the home
directory.

### `com.apple.security.device.camera`
Permits the app to capture from the user's camera after a system permission
prompt. The agent supports camera-based features such as live image
description, snapshot attachment to chat, and visual context for screen-share
sessions. The OS still gates each session behind an explicit per-app
permission prompt visible in System Settings; the entitlement only declares
intent and does not auto-grant access.

### `com.apple.security.device.microphone`
Permits the app to capture from the user's microphone after a system
permission prompt. The agent supports voice input, dictation, and live
transcription as alternatives to typing. As with the camera entitlement, the
OS still gates each session behind an explicit per-app permission prompt;
the entitlement alone does not record anything.

### `com.apple.security.personal-information.addressbook`
Permits the app to read the user's macOS Contacts via `CNContactStore`
*after* the user grants the Contacts permission in System Settings. The agent
uses this to resolve names mentioned in conversations ("text Mom", "remind me
to call Alex") into the corresponding contact records the user already has on
the device. The data never leaves the device unless the user explicitly sends
it in a message. The OS still requires a Contacts permission grant per app.

### `com.apple.security.personal-information.calendars`
Permits the app to read the user's macOS Calendars via `EventKit` *after* the
user grants the Calendars permission in System Settings. The agent uses this
to answer schedule questions and create events the user dictates. As with
Contacts, the data stays on-device unless the user explicitly sends it, and
the OS still requires a per-app permission grant.

### `com.apple.security.automation.apple-events`
Permits the app to send Apple Events to other apps the user has authorized
(Messages, Notes, Reminders). The agent offers optional, user-triggered
shortcuts that delegate to Apple's first-party apps for tasks the sandbox
cannot do directly. Each target app is gated individually by the system
Automation permission prompt; without that grant, every event is denied.

### `com.apple.developer.push-notifications` and `aps-environment`
Permits the app to receive Apple Push Notifications via APNs. The agent uses
push to deliver background notifications (long-running task completion,
schedule reminders) when the app is not in the foreground. Notifications are
routed exclusively through Apple's push service; the app cannot send pushes
to third-party endpoints.

---

## Bun helper (`mas-bun.entitlements` → `Contents/MacOS/bun`)

The app embeds a Bun JavaScript runtime at `Contents/MacOS/bun` to execute
the agent's JavaScript backend code. Bun uses JavaScriptCore, which requires
the JIT entitlement on macOS.

### `com.apple.security.app-sandbox`
Same as the parent. Required for every Mach-O in a MAS bundle.

### `com.apple.security.inherit`
Required by codesigning rules so this helper runs inside the parent app's
sandbox container with the parent's accessible files, network grants, and
hardware grants. The helper cannot expand its scope beyond what the parent
app was granted.

### `com.apple.security.cs.allow-jit`
Permits this single binary to use the `MAP_JIT` flag when mapping executable
memory. Bun's JavaScriptCore engine compiles JavaScript to native code at
runtime; without this entitlement the JIT pages cannot be allocated and the
runtime falls back to a path that fails on hardened-runtime targets.

**Important scoping notes for review:**

- **Only this one binary gets JIT.** The outer app (`mas.entitlements`) does
  NOT declare `allow-jit`. Every other nested Mach-O is signed with
  `mas-child.entitlements`, which also does not declare `allow-jit`. This is
  empirically verified by `scripts/mas-smoke.mjs` on every store build.
- **Library validation stays ON.** We do not set
  `com.apple.security.cs.disable-library-validation`. The Bun binary can only
  load libraries signed by Apple or by our team, so a JIT-permitted process
  cannot be used to side-load arbitrary code.
- **Unsigned executable memory stays OFF.** We do not set
  `com.apple.security.cs.allow-unsigned-executable-memory`. JIT pages must
  still go through the proper `MAP_JIT` write-protection APIs.
- **The runtime gate blocks out-of-bundle dlopen.** The JavaScript layer
  enforces (`@elizaos/core/sandbox#assertDlopenPathAllowed`) that every native
  module loaded by `process.dlopen` resolves to a path inside the app bundle.
  This blocks even a malicious in-process script from reaching for a system
  library through Node's dynamic loader.

The combination of these four constraints means a JIT-capable Bun process
inside the bundle still cannot load arbitrary libraries, cannot allocate
executable memory outside the JIT API, and cannot escape the App Sandbox
container shared with the parent app.
