# macOS Siri and Shortcuts

Eliza does not currently have a native macOS Swift/AppKit target that can ship
`AppIntent` and `AppShortcutsProvider` code. The Swift target under
`packages/app/ios/App` is iOS-only; the macOS app is the Electrobun desktop
shell configured in `packages/app-core/platforms/electrobun/electrobun.config.ts`.

Apple's App Intents path requires app code that conforms to `AppIntent`, and
preconfigured App Shortcuts are declared with `AppShortcutsProvider`. Without a
macOS native target, the repo-consistent macOS path is:

1. macOS Shortcut or Siri phrase collects text.
2. `packages/app/scripts/macos-shortcuts/eliza-assistant-handoff.sh` opens
   `elizaos://assistant?text=...&source=macos-shortcuts&action=ask`.
3. Electrobun receives the registered URL scheme through `open-url` and sends
   `shareTargetReceived` to the renderer.
4. `packages/app/src/main.tsx` routes the URL to `#chat?...`.
5. `ChatView` consumes the assistant launch payload and calls `sendChatText`.
6. The app runtime handles the request. LifeOps requests are parsed by the
   normal LifeOps actions and persisted as `ScheduledTask` records.

No reminder, check-in, watcher, or follow-up state is created by the helper or
by macOS Shortcuts.

## Install

Run:

```sh
packages/app/scripts/macos-shortcuts/install-eliza-shortcuts.sh
```

The installer copies the handoff helper to:

```text
~/Library/Application Support/elizaOS/Shortcuts/eliza-assistant-handoff.sh
```

Then create the Shortcut in the macOS Shortcuts app:

1. Create a new Shortcut named `Ask Eliza`.
2. Add `Ask for Input` with Text input.
3. Add `Run Shell Script`.
4. Set `Pass Input` to `stdin`.
5. Use this shell body:

```sh
"$HOME/Library/Application Support/elizaOS/Shortcuts/eliza-assistant-handoff.sh"
```

For a LifeOps-biased Shortcut, use:

```sh
ELIZA_SHORTCUT_ACTION=lifeops.create "$HOME/Library/Application Support/elizaOS/Shortcuts/eliza-assistant-handoff.sh"
```

Siri can run the user-created Shortcut by its name, for example "Ask Eliza".
The Siri phrase remains a per-device macOS Shortcuts setting.

## Verify

Dry-run URL construction:

```sh
printf 'remind me to stand up in 20 minutes' | "$HOME/Library/Application Support/elizaOS/Shortcuts/eliza-assistant-handoff.sh" --dry-run
```

Live app handoff, with the Electrobun app installed or running:

```sh
printf 'remind me to stand up in 20 minutes' | "$HOME/Library/Application Support/elizaOS/Shortcuts/eliza-assistant-handoff.sh"
```

Shortcut execution after manual creation:

```sh
printf 'remind me to stand up in 20 minutes' | shortcuts run "Ask Eliza" --input-path -
```

Expected result: Eliza opens or focuses, the chat receives the text with
`assistantLaunchSource: "macos-shortcuts"`, and any LifeOps reminder/check-in
request is created by the runtime as a `ScheduledTask`.

## Native App Shortcuts Follow-Up

If a real macOS native target is added later, move this integration to
App Intents by adding:

- an `AppIntent` that accepts the spoken text and foregrounds/continues into
  the app runtime;
- an `AppShortcutsProvider` with phrases such as `Ask Eliza`;
- a bridge from the intent into the same renderer/runtime handoff, not a native
  LifeOps store.

Primary Apple docs:

- [App intents](https://developer.apple.com/documentation/AppIntents/app-intents)
- [App Shortcuts](https://developer.apple.com/documentation/appintents/app-shortcuts)
- [AppShortcutsProvider.appShortcuts](https://developer.apple.com/documentation/appintents/appshortcutsprovider/appshortcuts)
