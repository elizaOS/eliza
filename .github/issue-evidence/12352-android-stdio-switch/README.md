# #12352 — Android local-agent stdio switch (remove the native loopback listener)

Replaces the Android WebView↔agent loopback HTTP path (`HttpURLConnection` to
`127.0.0.1:31337`) with a port-free NDJSON transport over an abstract-namespace
AF_UNIX socket, driving the shared in-process `dispatchRoute` route kernel.

## Why a UDS and not literal stdin/stdout pipes

The issue scopes this as "process-pipe stdio". Anonymous stdin/stdout pipes are
**not viable on Android** for two structural reasons (both documented in
`ElizaAgentService.java`):

1. The bun agent is launched **detached** (`launch.sh` `setsid` double-fork) so
   it survives the service that spawned it — which severs any parent stdio pipe.
2. The `priv_app` SELinux domain **denies pipe (`fifo_file`) ioctl**, so a Java
   `ProcessBuilder.PIPE` fd kills bun on stdio init.

The sanctioned Android IPC under `priv_app` is an **abstract-namespace AF_UNIX
socket** — the same transport the bionic inference host already uses ("no
filesystem path, avoids SELinux file-label issues"). The bun agent binds it; the
service connects per request. Same NDJSON frame kernel (`createStdioBridge`) the
iOS bridge uses.

## Done-when → evidence

| Done-when | Status |
|---|---|
| Android local mode binds no listener on the agent API port with `ELIZA_API_EXPOSE_PORT` unset | Code: `startEliza({localAgentMode:true})` → `skipListen` when not exposed (agent `eliza.ts`); spawn env drops `PORT`/`ELIZA_API_PORT`/`ELIZA_PORT`/`ELIZA_UI_PORT`/`ELIZA_API_BIND` unless exposed; `launch.sh` no longer defaults `PORT`. Unit-pinned by `eliza-local-agent-port-gate.test.ts`. On-device `/proc/net/tcp` proof: **N/A (see below)**. |
| Android WebView streaming stays incremental via the new stdio native side | `createStdioBridge` streaming frames + `dispatchRoute` `onChunk` live-flush sink; Java `streamOverSocket` translates `stream:response/chunk/complete` → `agentStream*` envelopes (unchanged shape). Covered by `stdio-bridge.test.ts`, `dispatch.test.ts`, `dispatch-route-onchunk.test.ts`. |
| Explicit exposed-port mode still works for dev + harness | `ELIZA_API_EXPOSE_PORT=1` re-exports the port env + re-opens the listener; gate unit-pinned. |
| `AgentPlugin.request` / `requestStream` WebView contracts stable | `AgentPlugin.java` unchanged; `requestLocalAgent`/`requestLocalAgentStream` return the identical response/stream envelopes. |

## Artifacts here

- `unit-tests.txt` — real `vitest run` output for the touched suites (all green).
- `javac-uds-check.txt` — standalone `javac` of the new `ElizaAgentService` UDS
  client (`LocalSocket`/`LocalSocketAddress.Namespace.ABSTRACT`/`Base64`/`org.json`
  + NDJSON framing) against `android.jar` (SDK 36) → compiles clean.

## N/A — on-device capture (honest gap)

`capture:android-emu`, `adb shell cat /proc/net/tcp` (no-31337 proof), and
`adb logcat` stdio-request lines require a full APK rebuild + reinstall
(`build:android`: Capacitor CLI + staged arm64 bun runtime + web bundle), which
is not runnable in this isolated worktree — the Capacitor CLI is not linked in
the shared parent `node_modules`, and `capacitor.settings.gradle` points at
bun-store plugin paths that a `cap sync` must regenerate. Capturing against the
**stale installed build** would prove nothing (PR_EVIDENCE.md). This is flagged
as a required follow-up: run `build:android` on a full checkout, reinstall, then
capture the three device artifacts. The risky new native code (the UDS client)
is javac-verified against the real Android SDK in the meantime.
