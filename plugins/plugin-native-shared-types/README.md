# @elizaos/native-plugin-shared-types

Shared TypeScript type contracts for elizaOS native plugin bridges.

## What this package does

This is a **type-only workspace package**. It provides canonical TypeScript interfaces and type aliases used by elizaOS plugins that bridge between web, Capacitor (mobile), and Electrobun (desktop) runtimes. It contains no runtime code and registers no elizaOS plugin actions, providers, or services.

## Exported types

### Native bridge contracts

- **`EventCallback<T>`** — generic event callback used across Capacitor and Electrobun plugin bridges.
- **`ListenerEntry<TEventName, TEventData>`** — listener entry shape consumed by Electrobun plugin bridges.

### Web Speech API shims

TypeScript's `lib.dom.d.ts` does not expose `SpeechRecognition` in all compiler targets. These minimal interfaces cover the surface used by web implementations of speech-enabled plugins (e.g. Swabble, TalkMode):

- **`SpeechRecognitionInstance`** — minimal interface for a Web Speech API `SpeechRecognition` instance.
- **`SpeechRecognitionResultEvent`** — result event shape.
- **`SpeechRecognitionResultList`** — indexed result list with `isFinal` and `transcript`.
- **`SpeechRecognitionCtor`** — constructor type for `SpeechRecognitionInstance`.
- **`SpeechRecognitionWindow`** — window augmentation type declaring optional `SpeechRecognition` and `webkitSpeechRecognition` properties.

## Usage

This package is consumed as a `workspace:*` dependency by other plugins in the elizaOS monorepo:

```ts
import type { EventCallback, SpeechRecognitionInstance } from "@elizaos/native-plugin-shared-types";
```

## Requirements

No environment variables. No configuration. No build step — the package exports TypeScript source directly.

## Notes

- `"private": true` — not published to npm; used only within the elizaOS monorepo workspace.
- All types are in a single file: `src/index.ts`.
