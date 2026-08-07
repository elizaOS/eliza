# @elizaos/capacitor-contacts

Capacitor plugin that exposes Android's `ContactsContract` to an Eliza agent's JavaScript/TypeScript runtime, with an explicit web fallback.

## Purpose / role

This is a [Capacitor](https://capacitorjs.com/) plugin (not an elizaOS `Plugin` object). It does not register elizaOS actions, providers, or evaluators directly. Instead it exposes a typed JS bridge (`Contacts`) that elizaOS actions in other packages can call to read, create, and import contacts on Android. On web/node the bridge returns empty results or throws for write operations.

The plugin is opt-in: it must be registered with Capacitor in the host Android app and imported explicitly by any elizaOS action that needs it.

## Plugin surface

This is a Capacitor bridge plugin, not an elizaOS plugin. It exposes one global object:

| Export | Description |
|--------|-------------|
| `Contacts` | Registered Capacitor plugin instance (`ElizaContacts` bridge) |
| `ContactsPlugin` | TypeScript interface for the three bridge methods |
| `ContactSummary` | Type for a returned contact record |
| `ListContactsOptions` | Options for `listContacts` |
| `CreateContactOptions` | Options for `createContact` |
| `ImportVCardOptions` | Options for `importVCard` |
| `ImportedContactSummary` | Extended `ContactSummary` with `sourceName` |

### Bridge methods

| Method | Platform | Notes |
|--------|----------|-------|
| `listContacts(options?)` | Android | Requires `READ_CONTACTS`. Optional `query` (case-insensitive search across name/phone/email) and `limit` (1–500, default 100). Returns `{ contacts: ContactSummary[] }`. |
| `createContact(options)` | Android | Requires `WRITE_CONTACTS`. `displayName` required; accepts `phoneNumber`/`phoneNumbers` and `emailAddress`/`emailAddresses`. Returns `{ id: string }`. |
| `importVCard(options)` | Android | Requires `WRITE_CONTACTS`. Parses RFC 6350 vCard text (handles line folding, `FN`/`N`/`TEL`/`EMAIL` fields, `\`-escapes). Returns `{ imported: ImportedContactSummary[] }`. |

Web fallback (`ContactsWeb`): `listContacts` returns `{ contacts: [] }`, `createContact`/`importVCard` throw.

## Layout

```
plugins/plugin-native-contacts/
  src/
    index.ts          — registerPlugin("ElizaContacts") + re-exports everything from definitions
    definitions.ts    — all TypeScript interfaces (ContactSummary, ContactsPlugin, …)
    web.ts            — ContactsWeb (web fallback: listContacts=[], writes throw)
  android/
    src/main/
      AndroidManifest.xml                         — READ_CONTACTS + WRITE_CONTACTS permissions
      java/ai/eliza/plugins/contacts/
        ContactsPlugin.kt                         — full Kotlin implementation: listContacts, createContact, importVCard, vCard parser
    build.gradle
  rollup.config.mjs   — bundles dist/esm → dist/plugin.js (IIFE) + dist/plugin.cjs.js
  tsconfig.json
  package.json
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-contacts clean           # remove build output
bun run --cwd plugins/plugin-native-contacts build           # build package artifacts
bun run --cwd plugins/plugin-native-contacts typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-contacts lint            # mutating Biome check
bun run --cwd plugins/plugin-native-contacts lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-contacts format          # write formatting
bun run --cwd plugins/plugin-native-contacts format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-contacts test            # run package tests
bun run --cwd plugins/plugin-native-contacts prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-contacts build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
```

## Config / env vars

None. This plugin requires no env vars. Android runtime permissions (`READ_CONTACTS`, `WRITE_CONTACTS`) are declared in the plugin's `AndroidManifest.xml` and merged by the host app's build system. The host app must grant them at runtime before calling bridge methods.

## How to extend

### Add a new bridge method

1. Add the method signature to `src/definitions.ts` in `ContactsPlugin`.
2. Implement the web fallback in `src/web.ts` (`ContactsWeb`).
3. Implement the real method in `android/src/main/java/ai/eliza/plugins/contacts/ContactsPlugin.kt` — annotate with `@PluginMethod`, check permissions with `hasPermission(Manifest.permission.*)`, resolve or reject the `PluginCall`.
4. Run `bun run --cwd plugins/plugin-native-contacts build` to regenerate `dist/`.
5. Rebuild the host Android app so the new method is available in the webview bridge.

### Add a new type

Add the interface/type to `src/definitions.ts` and re-export via `src/index.ts` (already covered by `export * from "./definitions"`).

## Conventions / gotchas

- **Capacitor, not elizaOS Plugin.** Import `Contacts` from this package and call its methods; do not try to load it via `elizaOS`'s plugin loader.
- **Instrumented test (issue #9967).** The `ContactsContract` query lives in `ContactsReader` and is covered by an on-device **write→read round-trip** (`android/src/androidTest/.../ContactsReaderInstrumentedTest.kt`, `GrantPermissionRule`): insert a contact → read it back → assert name+phone → clean up. Run via `./gradlew :elizaos-capacitor-contacts:connectedDebugAndroidTest` from `packages/app-core/platforms/android`. `listContacts` and `createContact`'s summary both delegate to the reader (JS shape unchanged).
- **Android only for writes.** `createContact` and `importVCard` are hard-fails on web. Design any elizaOS action that calls them to check the platform first.
- **Permissions are feature-gated, not app-required.** The plugin declares the `contacts` alias (`READ_CONTACTS`/`WRITE_CONTACTS`) in `@CapacitorPlugin(permissions=…)`, so the Capacitor base `Plugin` auto-provides `checkPermissions()` / `requestPermissions()` (`{ contacts: PermissionState }`; web returns `granted`). The Contacts view calls `requestPermissions()` on first open (idempotent — already-granted never re-prompts) and shows a grant-in-settings message if denied. Nothing requests contacts at app launch. The bridge methods still reject if not granted (defensive); do NOT add a launch-time or app-wide contacts gate.
- **limit guard.** `listContacts` enforces `1 ≤ limit ≤ 500`; requests outside that range are rejected.
- **vCard parser is internal.** `parseVCards` in `ContactsPlugin.kt` handles RFC 6350 line folding and the `FN`/`N`/`TEL`/`EMAIL` properties. It intentionally ignores other vCard fields. Photo data is not imported.
- **Build output.** The published package ships `dist/esm/` (ESM, consumed by bundlers) and `dist/plugin.cjs.js` (CJS). The `bun`/`development` export condition points directly to `src/index.ts` for zero-build dev.
- **Peer dep.** `@capacitor/core ^8.3.1` must be present in the consuming app.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
