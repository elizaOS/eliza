# @elizaos/native-plugin-shared-types

Shared TypeScript type contracts for elizaOS native plugin bridges (Capacitor and Electrobun).

## Purpose / role

This is a **type-only package** — it exports no runtime code, no elizaOS `Plugin` object, and registers no actions, providers, services, or evaluators. Its sole purpose is to provide canonical shared type definitions used by native plugin bridges across elizaOS plugins that target Capacitor (mobile) or Electrobun (desktop) runtimes, as well as web-speech shims needed by plugins like Swabble and TalkMode.

It is consumed via `workspace:*` by sibling plugins in the monorepo; it is not published to npm and is `"private": true`.

## Plugin surface

No runtime plugin surface. No actions, providers, services, evaluators, routes, or events.

## Layout

```
plugins/plugin-native-shared-types/
  package.json        name: @elizaos/native-plugin-shared-types; type: module; private: true
  src/
    index.ts          All exported types (single file)
```

### Exports from `src/index.ts`

| Export | Kind | Description |
|---|---|---|
| `EventCallback<T>` | type alias | Generic event callback for Capacitor/Electrobun plugin bridges |
| `ListenerEntry<TEventName, TEventData>` | interface | Listener entry shape used by Electrobun plugin bridges |
| `SpeechRecognitionInstance` | interface | Minimal Web Speech API `SpeechRecognition` shim (not in all TS targets) |
| `SpeechRecognitionResultEvent` | interface | Result event shape from the Web Speech API |
| `SpeechRecognitionResultList` | interface | Result list shape (indexed, with `isFinal` and `transcript`) |
| `SpeechRecognitionCtor` | type alias | Constructor type for `SpeechRecognitionInstance` |
| `SpeechRecognitionWindow` | interface | Window augmentation declaring optional `SpeechRecognition` and `webkitSpeechRecognition` |

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-shared-types typecheck     # TypeScript typecheck
bun run --cwd plugins/plugin-native-shared-types lint          # mutating Biome check
bun run --cwd plugins/plugin-native-shared-types lint:check    # read-only Biome check
bun run --cwd plugins/plugin-native-shared-types format        # write formatting
bun run --cwd plugins/plugin-native-shared-types format:check  # read-only formatting check
bun run --cwd plugins/plugin-native-shared-types test          # run package tests
```

## Config / env vars

None. This package contains no runtime code.

## How to extend

To add a new shared type contract:

1. Open `plugins/plugin-native-shared-types/src/index.ts`.
2. Export the new interface, type alias, or enum with a JSDoc comment explaining which plugin(s) consume it.
3. Import from `@elizaos/native-plugin-shared-types` in the consuming plugin (it resolves via `workspace:*`).

Do not add runtime logic, class implementations, or any code with side effects to this package.

## Conventions / gotchas

- **Type-only.** Any addition must be a pure TypeScript type, interface, or const enum. No runtime values.
- **Single file.** All exports live in `src/index.ts`. Do not create subdirectories or split the module.
- **`"main": "./src/index.ts"` and `"exports": { ".": "./src/index.ts" }` point directly at source.** There is no build step and no `dist/`. Consumers rely on TypeScript resolving the source directly.
- **`private: true`.** This package is not published; it only exists as a workspace dependency.
- The Web Speech API shims exist because TypeScript's `lib.dom.d.ts` does not expose `SpeechRecognition` in all compiler targets. They are intentionally minimal — cover only what Swabble and TalkMode actually use.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
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

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
