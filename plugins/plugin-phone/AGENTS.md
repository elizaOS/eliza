# @elizaos/plugin-phone

Android dialer overlay + iOS Phone Companion (pairing, chat-mirror, remote-session) for Eliza agents.

## Purpose / role

Adds two distinct surfaces to elizaOS. The Android surface provides a full-screen dialer overlay backed by `@elizaos/capacitor-phone` and exposes recent call history to the agent runtime via the `phoneCallLog` provider. The iOS companion surface (Phone Companion) runs inside the main iOS Capacitor bundle, pairs with a desktop Eliza agent via QR code, mirrors agent chat, and relays touch input into a remote VNC/noVNC session on the paired Mac. The plugin is opt-in: register it by importing and passing `appPhonePlugin` to the elizaOS runtime.

## Plugin surface

**Provider**
- `phoneCallLog` — Dynamic, read-only. Fetches the last 50 Android calls via `@elizaos/capacitor-phone`. Available in `contacts` and `messaging` contexts; requires `ADMIN` role. Returns `{ count, items }` where each item has `id`, `number`, `cachedName`, `date`, `durationSeconds`, `type`, `isNew`.

**Actions** — none registered. Outbound call placement is internal to `PhoneAppView` (calls `Phone.placeCall`); it routes through the canonical `VOICE_CALL` surface when a provider is wired externally.

**Views** (registered in `plugin.ts` under `plugin.views`)
- `phone` (default) — `PhonePluginView`: full-screen dialer/recent-calls/contacts overlay, mounted at `/phone`.
- `phone` (xr) — same component, `viewType: "xr"`.
- `phone` (tui) — `PhoneTuiView`: terminal-mode dialer + transcript UI, mounted at `/phone/tui`.

**App nav tab** (registered under `plugin.app.navTabs`)
- `phone-companion` — Mounts `PhoneCompanionApp` at `/phone-companion`; declared for hosts that do not side-effect-import `register-companion-page.ts`.

## Layout

```
src/
  index.ts                       Package barrel — public exports
  plugin.ts                      Plugin object (appPhonePlugin / default)
  register.ts                    Side-effect entry: registers phone overlay on Android,
                                 companion page always
  register-companion-page.ts     Registers PhoneCompanionApp with @elizaos/ui app-shell-registry
  ui.ts                          Re-exports all UI components under public names
  providers/
    call-log.ts                  phoneCallLog provider (dynamic, ADMIN-gated)
  components/
    phone-app.ts                 phoneApp OverlayApp definition + registerPhoneApp()
    PhoneAppView.tsx             PhoneAppView (full GUI), PhonePluginView (wrapper),
                                 PhoneTuiView (terminal), interact() (TUI capability bridge)
    PhoneTuiView.test.ts         Unit tests for TUI view
  companion/
    index.ts                     Companion barrel
    components/
      PhoneCompanionApp.tsx      Root companion component (3-view: Chat/Pairing/RemoteSession)
      Chat.tsx                   Chat-mirror view
      Pairing.tsx                QR scan + pairing handshake view
      RemoteSession.tsx          VNC touch-relay view
      index.ts                   Component barrel
    services/
      eliza-intent.ts            Capacitor plugin facade (ElizaIntent) + web fallback
      env.ts                     Vite env accessors: agentUrl(), apnsEnabled(), isDev()
      intent-bridge.ts           forwardIntent() — thin wrapper around ElizaIntent.receiveIntent
      logger.ts                  Scoped logger instance
      navigation.ts              useNavigation() hook — 3-screen push/pop stack, persisted
                                 via @capacitor/preferences, haptics on transition
      push.ts                    APNs registration (registerPush), session.start intent handling
      session-client.ts          SessionClient (WebSocket to VNC ingress), touchToInput(),
                                 decodePairingPayload()
      index.ts                   Services barrel
```

## Commands

```bash
bun run --cwd plugins/plugin-phone typecheck   # tsgo type-check (no emit)
bun run --cwd plugins/plugin-phone lint        # biome check src/
bun run --cwd plugins/plugin-phone test        # vitest run
bun run --cwd plugins/plugin-phone build       # tsup + vite views + tsc types
bun run --cwd plugins/plugin-phone clean       # rm -rf dist
```

## Config / env vars

All companion env vars are Vite build-time (`import.meta.env`). None are read at runtime by the elizaOS plugin object itself.

| Var | Required | Description |
|-----|----------|-------------|
| `VITE_ELIZA_AGENT_URL` | No | Pre-configured agent ingress URL for the companion; shown in Chat view as fallback when not paired via QR |
| `VITE_ELIZA_APNS_ENABLED` | No | Set to `"1"` to enable APNs push registration on iOS (disabled by default) |
| `VITE_ELIZA_LOG_LEVEL` | No | Log level for companion surface logger |

The `phoneCallLog` provider reads no env vars; it calls `Phone.listRecentCalls` which reads from the native Android `READ_CALL_LOG` permission at runtime.

## How to extend

**Add a provider:** Create `src/providers/<name>.ts` exporting a `Provider` object. Add it to the `providers` array in `src/plugin.ts`.

**Add a companion service:** Create `src/companion/services/<name>.ts` and export from `src/companion/services/index.ts`. Keep the module pure (no React) when it needs to be unit-testable.

**Add a companion view:** Add a React component under `src/companion/components/`. Add the view name to the `ViewName` union in `src/companion/services/navigation.ts`. Add the render branch in `PhoneCompanionApp.tsx`'s `renderView`.

**Add a TUI capability:** Extend the `interact()` function in `src/components/PhoneAppView.tsx` with a new `if (capability === "...")` branch.

## Conventions / gotchas

- **Android-only registration.** `src/register.ts` calls `registerPhoneApp()` only when `isElizaOS()` returns true (i.e. the Android host). The companion page registers unconditionally because it serves iOS as well.
- **Contacts are a soft dep.** `loadContactsModule()` dynamically imports `@elizaos/capacitor-contacts` at runtime and silently returns `null` if unavailable; the contacts tab is hidden in that case. Do not add a static import.
- **No actions.** `Phone.placeCall` is called directly from UI components, not from an elizaOS action. The `VOICE_CALL` action surface is the planned external call route; do not add inline action wrappers.
- **`ElizaIntentWeb` does not simulate success.** The web fallback for the iOS native bridge explicitly returns `paired: false` and throws on `scheduleAlarm` — intentional, to prevent dev builds from appearing to work without a simulator.
- **Two build outputs.** The `build` script runs `tsup` (main ESM bundle) and then a separate Vite build for `dist/views/bundle.js` (the plugin view bundle loaded by the elizaOS view registry). The types pass uses `tsc --noCheck`.
- **Navigation persistence key.** `eliza.companion.nav.v1` in `@capacitor/preferences` — bump the key suffix if the `ViewName` union changes in a breaking way.
- **Session token is appended as `?token=`.** `SessionClient.connect` appends the token as a query param to the WebSocket URL; the ingress side must read it from there.
