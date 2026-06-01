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
| View | `contacts` (tui) | Terminal surface — `ContactsTuiView` component, path `/contacts/tui`. |

No actions, services, evaluators, events, or routes are registered.

## Layout

```
src/
  index.ts                      Public package entry — re-exports plugin, app, register, ui
  plugin.ts                     appContactsPlugin definition (providers + views)
  register.ts                   Side-effect: calls registerContactsApp() when isElizaOS()
  ui.ts                         Re-exports ContactsAppView, contactsApp, registerContactsApp
  providers/
    contacts.ts                 androidContacts provider implementation
    contacts.test.ts            Vitest unit tests for the provider
  components/
    contacts-app.ts             OverlayApp descriptor + registerContactsApp()
    ContactsAppView.tsx         Full-screen overlay UI (list / detail / new modes)
                                Also exports ContactsTuiView and interact() for TUI capabilities
    ContactsTuiView.test.ts     TUI view tests
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
- **Provider roleGate.** `roleGate: { minRole: "ADMIN" }` means the `androidContacts` provider only fires in admin-role sessions. Do not change this without reviewing the address-book privacy model.
- **TUI interact() function.** `ContactsAppView.tsx` also exports `interact(capability, params)` which handles `terminal-list-contacts`, `terminal-create-contact`, and `terminal-import-vcard` capability strings — used by the TUI view's programmatic interface.
- **Views bundle.** The overlay UI is built separately via `vite.config.views.ts` into `dist/views/bundle.js`. `bundlePath` in the view descriptors points there. The tsup build (`build:js`) and the vite build (`build:views`) are independent steps.
- **Peer deps.** React 19 and react-dom 19 are peer dependencies. The host app must provide them.
- See the root `AGENTS.md` for repo-wide architecture rules, logging conventions, and git workflow.
