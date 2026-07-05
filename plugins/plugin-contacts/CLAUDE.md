# @elizaos/plugin-contacts

Android address-book overlay app for elizaOS: provides a full-screen UI surface for browsing, searching, creating, and importing contacts, plus a read-only dynamic provider that injects address-book context into the agent planner.

## Purpose / role

This plugin adds Android address-book capability to an Eliza agent. It ships two surfaces:

1. A **dynamic provider** (`androidContacts`) that reads up to 50 contacts from the device and injects them as planning context — scoped to `contacts` and `messaging` conversation contexts, gated to `ADMIN` role sessions, cached per-turn.
2. A **full-screen overlay app** (`ContactsAppView`) registered via `@elizaos/ui`'s overlay-app registry, rendered in three view modes: default UI, XR, and TUI (terminal).

The plugin is Android-only (`elizaos.app.androidOnly: true`). The `src/register.ts` side-effect module skips registration on non-elizaOS runtimes. The `/plugin` export is the entry point for the elizaOS runtime adapter.

## Plugin surface

Registered in `appContactsPlugin` (`src/plugin.ts`):

| Kind | Name | Description |
|------|------|-------------|
| Provider | `androidContacts` | Read-only: fetches up to 50 contacts (id, displayName, phones, emails, starred) from `@elizaos/capacitor-contacts` and emits JSON context. Dynamic; contexts: `contacts`, `messaging`; roleGate: ADMIN; cacheScope: turn. |
| View | `contacts` (default) | Full-screen overlay app — `ContactsAppView` component, path `/contacts`. |
| View | `contacts` (xr) | Same component, `viewType: "xr"`. |
| View | `contacts` (tui) | Terminal surface — `ContactsTuiView` component export, path `/contacts/tui`. Rendered by `ContactsSpatialView` via `register-terminal-view.tsx`. |

No actions, services, evaluators, events, or routes are registered.

## Layout

```
src/
  index.ts                          Public package entry — re-exports plugin, app, register, ui
  plugin.ts                         appContactsPlugin definition (providers + views)
  register.ts                       Side-effect: calls registerContactsApp() when isElizaOS()
  register-terminal-view.tsx        Registers contacts view for terminal rendering via ContactsSpatialView
  ui.ts                             Re-exports ContactsAppView, contactsApp, registerContactsApp
  providers/
    contacts.ts                     androidContacts provider implementation
    contacts.test.ts                Vitest unit tests for the provider
  components/
    contacts-app.ts                 OverlayApp descriptor + registerContactsApp()
    contacts-app.test.ts            Tests for OverlayApp descriptor
    contacts-view-bundle.ts         View bundle registration helpers
    contacts-contract.test.ts       Contract tests for the overlay-app view surface
    ContactsAppView.tsx             Full-screen overlay UI (list / detail / new modes)
    ContactsAppView.helpers.ts      Helper utilities for ContactsAppView
    ContactsAppView.interact.ts     Exports interact(capability, params) for TUI programmatic interface
    ContactsAppView.test.ts         Tests for ContactsAppView
    ContactsSpatialView.tsx         Spatial/XR/TUI-compatible view (renders in GUI, XR, and terminal)
    ContactsSpatialView.test.tsx    Tests for ContactsSpatialView
    ContactsTuiView.test.ts         TUI view tests
```

The `./plugin` export (declared in `package.json` exports map) resolves to `dist/plugin.js` / `dist/plugin.d.ts` and is the entry the runtime adapter imports directly.

## Commands

Only scripts that exist in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-contacts typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-contacts lint         # biome check src/
bun run --cwd plugins/plugin-contacts test         # vitest run
bun run --cwd plugins/plugin-contacts build        # build:js + build:views + build:types
bun run --cwd plugins/plugin-contacts build:js     # tsup (shared config)
bun run --cwd plugins/plugin-contacts build:views  # vite build for overlay bundle
bun run --cwd plugins/plugin-contacts build:types  # tsc declaration emit
bun run --cwd plugins/plugin-contacts clean        # rm -rf dist
```

## Config / env vars

This plugin reads no environment variables and has no settings keys. All address-book access goes through `@elizaos/capacitor-contacts` Contacts native API, which requires the Android `READ_CONTACTS` / `WRITE_CONTACTS` permissions to be granted at the OS level.

The provider limit is a hardcoded constant `CONTACTS_PROVIDER_LIMIT = 50` in `src/providers/contacts.ts`.

## How to extend

**Add a provider:** create `src/providers/<name>.ts` exporting a `Provider` object, then add it to the `providers` array in `src/plugin.ts`.

**Add a view:** define a new `ViewDeclaration` descriptor object in `src/plugin.ts` `views` array with a unique `id` + `viewType`. Add the corresponding React component to `src/components/ContactsAppView.tsx` or a new file, then re-export it from `src/ui.ts` and `src/index.ts`.

**Add an action:** the current design intentionally uses no actions (reads are providers; writes happen in the UI layer via the native Contacts API directly). If you add an action, import it in `src/plugin.ts` and add it to the `actions` array.

## Conventions / gotchas

- **Android-only.** `isElizaOS()` guard in `src/register.ts` prevents the overlay app from registering on web/iOS/desktop. The provider will still be instantiated anywhere the plugin is loaded, but `Contacts.listContacts` will throw on non-Android runtimes — the provider catches the error and returns `contactsAvailable: false`.
- **No update or delete.** The `@elizaos/capacitor-contacts` native plugin does not expose contact mutation beyond create and import. The detail panel is read-only; the "Edit" path was intentionally omitted.
- **In-app Call/Text linking.** The detail view phone rows do not use a `tel:` OS handoff. Each number renders "Call" and "Text" controls that dispatch `eliza:navigate:view` with `{ viewId, viewPath, payload }` for the in-app Phone and Messages views, pre-seeding the target through the generic navigation payload handoff. Email keeps its `mailto:` anchor (there is no in-app email view). Do not reintroduce `tel:`.
- **Provider roleGate.** `roleGate: { minRole: "ADMIN" }` means the `androidContacts` provider only fires in admin-role sessions. Do not change this without reviewing the address-book privacy model.
- **TUI interact() function.** `src/components/ContactsAppView.interact.ts` exports `interact(capability, params)` which handles `terminal-list-contacts`, `terminal-create-contact`, and `terminal-import-vcard` capability strings — used by the TUI view's programmatic interface.
- **Spatial/TUI view.** `ContactsSpatialView.tsx` is authored with the spatial-UI vocabulary and renders in GUI, XR, and terminal (via `register-terminal-view.tsx` + `registerSpatialTerminalView`). It is purely presentational (snapshot + action callback) with no Capacitor runtime imports, so it is safe to run in a Node agent process.
- **Views bundle.** The overlay UI is built separately via `vite.config.views.ts` into `dist/views/bundle.js`. `bundlePath` in the view descriptors points there. The tsup build (`build:js`) and the vite build (`build:views`) are independent steps.
- **Peer deps.** React 19 and react-dom 19 are peer dependencies. The host app must provide them.
- See the root `AGENTS.md` for repo-wide architecture rules, logging conventions, and git workflow.

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

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — platform connector:**
- A real (or sandbox-account) round-trip on the platform: inbound message → agent → outbound reply, captured as logs **and** a screenshot/recording of the actual conversation.
- The raw inbound event/webhook payload and the outbound API request/response, with IDs mapped correctly (`stringToUuid` / `createUniqueUuid`).
- Attachments, threads/replies, edits, multi-account, and rate-limit/error paths — not just a single text ping.
- The agent trajectory for the turn the connector drove.
<!-- END: evidence-and-e2e-mandate -->
