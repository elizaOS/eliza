# #11515 — attached-console launches SIGTRAP at full-Bun engine-host load

## Root cause (decision: this is a debug-session incompatibility, not an app bug)

`devicectl device process launch --console` runs the target under a **debug
session** (ptrace + Mach exception ports). On the full-Bun (no-JIT)
`ElizaBunEngine` host, that debug session turns a benign guard-page / breakpoint
probe into a fatal `EXC_BREAKPOINT` the moment the engine host loads — the app
dies with **signal 5 (SIGTRAP)**, ~immediately, before engine start. The same
build launched **unattended** (icon tap, or `devicectl … launch` without
`--console`) boots healthily: engine up in ~900 ms, agent `ready` in ~2 s.

Grounding: the SIGTRAP was first captured under PR #11431 and documented in
`.github/issue-evidence/ios-agent-boot-automation/d1-boot-trace/README.md`
("Attached-console launches of THIS build die with **signal 5 (SIGTRAP)** the
moment the full-Bun engine host loads … use the boot-trace pull, not
`--console`, for engine-start observability"). Console mode is also unsuitable
for a second reason: it ties the app lifetime to the console process, so
detaching SIGTERMs (signal 15) the app.

**Decision:** engine-start observability on physical devices uses the
**boot-trace file pull** (`--no-console --pull-boot-trace`), never attached
console. This is now enforced in tooling + docs; the underlying `--console`
crash is inherent to running a no-JIT engine under a debugger and is out of
scope to "fix" (there is no user path that attaches a debugger — icon-tap
launches are unattended).

## What this change ships

`packages/app/scripts/ios-device-logs.mjs` + `ios-device-lib.mjs`:

- **`classifyConsoleExit()`** (pure, in `ios-device-lib.mjs`) recognizes the
  #11515 SIGTRAP from the console child's exit signal (`SIGTRAP`) **or** the
  captured log signature (`CONSOLE_SIGTRAP_SIGNATURE`: `EXC_BREAKPOINT` /
  `SIGTRAP` / `signal 5` / `Trace/BPT trap`). devicectl relays the target crash
  as a nonzero exit **code** (signal `null`), which the previous ad-hoc check
  misreported as a generic "phone locked / not paired" failure. The classifier
  checks the SIGTRAP signature FIRST, so it is now reported correctly and
  **non-fatally** (the boot-trace pull still runs).
- The `" 5"` branch is word-boundary anchored so it never matches our own
  bounded-detach `signal 15`.
- The pre-capture warning and the header docs now name the #11515 SIGTRAP and
  point at `--no-console --pull-boot-trace`. When a SIGTRAP is detected and the
  caller did not also request the boot-trace pull, the tool prints the exact
  re-run command instead of leaving a truncated log.

## Verification (this host)

- `ios-device-lib.test.mjs`: **40 tests pass** (7 new `classifyConsoleExit`
  cases — SIGTRAP via signal, via `signal 5 (SIGTRAP)` log, via `EXC_BREAKPOINT`
  note, `signal 15` NOT confused for SIGTRAP, devicectl-exit-1-after-detach
  non-fatal, genuine locked/unpaired early-exit stays fatal, clean exit ok),
  run in the `packages/app` vitest suite (root `test:client` lane).
- `node --check` clean on both edited scripts.

## Still needs a device (unchanged)

Re-observing the live SIGTRAP requires the physical iPhone 16 Pro Max and
`devicectl … --console`; that capture already exists on PR #11431's branch. This
change makes the tooling *recognize and route around* that failure so no future
operator re-hits the misreport — which is the actionable half of #11515. The
canonical engine-observability path is the boot-trace pull.
