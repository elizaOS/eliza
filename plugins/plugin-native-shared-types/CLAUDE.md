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

This package has no build, test, or lint scripts. There is nothing to run.

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
