# Issue #13475 Android agent exit diagnostics

## Change

- The generated Android `launch.sh` now keeps a detached wrapper around the real Bun child, records `agent-child-started` and `agent-child-exited` events in `files/agent/agent-restart-diagnostics.jsonl`, and exits with the child status.
- `ElizaAgentService` now passes the diagnostics path explicitly, marks launcher PID availability, records whether the local-agent abstract socket was listening when the launcher returned, and restarts immediately when a clean detached launcher exit happens before the agent socket is reachable.
- The startup probe now watches those child-exit records and restarts immediately when the real detached child exits before readiness, instead of waiting for the full startup timeout.

## Verification

- `bun test packages/app-core/scripts/stage-android-agent.test.mjs` passed locally.
- `git diff --check` passed for the touched files.

## Not run

- `./gradlew :app:testDebugUnitTest` could not run on this host because Gradle requires JVM 17+ and only Java 11 is installed (`/usr/libexec/java_home -V` lists `11.0.21`).
- Physical Moto G Play Android 14 boot verification was not run in this workspace because no connected target device is available here.
