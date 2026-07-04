# @elizaos/macosreminders

macOS Apple Reminders native bridge policy helpers for elizaOS host runtimes.

## Purpose / role

This package owns reusable native Apple Reminders bridge policy. It is not an
elizaOS runtime `Plugin` object and does not register actions, providers,
services, routes, or views. Higher-level packages such as
`@elizaos/plugin-personal-assistant` import its helpers when they need to resolve the
macOS EventKit dylib used to create, update, or delete Apple Reminders.

LifeOps may own the personal-assistant reminder workflow, DTO projection,
approval policy, and scheduled-task integration. It should not own reusable
native bridge policy.

## Plugin surface

| Export | Description |
|---|---|
| `appleRemindersMacosBridgeCandidates` | Shared macOS EventKit dylib candidate policy. |
| `APPLE_REMINDERS_MACOS_BRIDGE_DYLIB_BASENAME` | Expected macOS EventKit dylib basename. |
| `AppleRemindersMacosBridgeCandidate` | Candidate record type. |

## Layout

```
plugins/plugin-native-reminders/
  src/
    index.ts                 Public exports.
    macos-bridge-policy.ts   Shared macOS EventKit dylib candidate policy.
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-reminders clean           # remove build output
bun run --cwd plugins/plugin-native-reminders build           # build package artifacts
bun run --cwd plugins/plugin-native-reminders typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-reminders lint            # mutating Biome check
bun run --cwd plugins/plugin-native-reminders lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-reminders format          # write formatting
bun run --cwd plugins/plugin-native-reminders format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-reminders test            # run package tests
bun run --cwd plugins/plugin-native-reminders prepublishOnly  # publish-time build hook
```

## Config / env vars

The candidate policy accepts the caller-resolved env path. Current LifeOps
callers pass `ELIZA_NATIVE_PERMISSIONS_DYLIB` explicitly so this package stays
pure and testable.

## Conventions / gotchas

- Keep reusable native bridge policy here, not in LifeOps.
- Do not add LifeOps DTOs, scheduled-task behavior, or owner-assistant prompt
  text to this package.
- The current macOS dylib is shared with the desktop permissions/EventKit
  bridge. If the dylib is renamed or split, update the basename here and keep
  host packages importing it.
- See the root `AGENTS.md` for repo-wide architecture rules.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
