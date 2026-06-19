# @elizaos/plugin-phone

Android dialer overlay + iOS Phone Companion (pairing, chat-mirror, remote-session) for Eliza agents.

## Purpose / role

Adds two distinct surfaces to elizaOS. The Android surface provides a full-screen dialer overlay backed by `@elizaos/capacitor-phone` and exposes recent call history to the agent runtime via the `phoneCallLog` provider. The iOS companion surface (Phone Companion) runs inside the main iOS Capacitor bundle, pairs with a desktop Eliza agent via QR code, mirrors agent chat, and relays touch input into a remote VNC/noVNC session on the paired Mac. The plugin is opt-in: register it by importing and passing `appPhonePlugin` to the elizaOS runtime.

## Plugin surface

**Provider**
- `phoneCallLog` — Dynamic, read-only. Fetches the last 50 Android calls via `@elizaos/capacitor-phone`. Available in `contacts` and `messaging` contexts; requires `ADMIN` role. Returns `{ count, items }` where each item has `id`, `number`, `cachedName`, `date`, `durationSeconds`, `type`, `isNew`.

**Actions**
- `VOICE_CALL` — Scaffold stub registered in plugin. Sub-op `dial` routes by `recipientKind`: `owner`, `external`, or `e164`. Draft-first; `confirmed:true` to dispatch through the approval queue. **Not yet migrated** — the handler returns a `scaffold_stub` failure; full Twilio dispatch is pending migration from `plugins/plugin-lifeops/src/actions/voice-call.ts`. The Twilio helpers (`sendTwilioSms`, `sendTwilioVoiceCall`) already live in `src/twilio.ts`.

**Views** (registered in `plugin.ts` under `plugin.views`)
- `phone` (default) — `PhonePluginView`: full-screen dialer + recent-calls overlay, mounted at `/phone`. The address book is the separate Contacts view; a header "Contacts" button links to it via the `eliza:navigate:view` bus.
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
  register-terminal-view.tsx     Registers spatial phone view for terminal/TUI surface
  ui.ts                          Re-exports all UI components under public names
  twilio.ts                      Twilio helpers: sendTwilioSms, sendTwilioVoiceCall,
                                 readTwilioCredentialsFromEnv, billing calc
  actions/
    voice-call.ts                VOICE_CALL action (scaffold stub; see TODO in file)
  providers/
    call-log.ts                  phoneCallLog provider (dynamic, ADMIN-gated)
  components/
    phone-app.ts                 phoneApp OverlayApp definition + registerPhoneApp()
    phone-view-bundle.ts         View bundle entry point
    PhoneAppView.tsx             PhoneAppView (full GUI), PhonePluginView (wrapper),
                                 PhoneTuiView (terminal)
    PhoneAppView.helpers.ts      Helper utilities for PhoneAppView
    PhoneAppView.interact.ts     interact() — TUI capability bridge
    PhoneSpatialView.tsx         Spatial-vocabulary phone surface (GUI/XR/TUI)
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

All companion env vars are Vite build-time (`import.meta.env`). Twilio vars are runtime (`process.env`), read by `src/twilio.ts`.

| Var | Required | Description |
|-----|----------|-------------|
| `VITE_ELIZA_AGENT_URL` | No | Pre-configured agent ingress URL for the companion; shown in Chat view as fallback when not paired via QR |
| `VITE_ELIZA_APNS_ENABLED` | No | Set to `"1"` to enable APNs push registration on iOS (disabled by default) |
| `VITE_ELIZA_LOG_LEVEL` | No | Log level for companion surface logger |
| `TWILIO_ACCOUNT_SID` | Yes (for Twilio) | Twilio account SID used by `readTwilioCredentialsFromEnv` |
| `TWILIO_AUTH_TOKEN` | Yes (for Twilio) | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Yes (for Twilio) | Twilio from-number (E.164) |
| `TWILIO_SMS_COST_PER_SEGMENT_USD` | No | Override per-segment SMS cost for billing calc (default: $0.0075) |
| `ELIZA_MOCK_TWILIO_BASE` | No | Override Twilio base URL for testing (default: `https://api.twilio.com`) |

The `phoneCallLog` provider reads no env vars; it calls `Phone.listRecentCalls` which reads from the native Android `READ_CALL_LOG` permission at runtime.

## How to extend

**Add a provider:** Create `src/providers/<name>.ts` exporting a `Provider` object. Add it to the `providers` array in `src/plugin.ts`.

**Add a companion service:** Create `src/companion/services/<name>.ts` and export from `src/companion/services/index.ts`. Keep the module pure (no React) when it needs to be unit-testable.

**Add a companion view:** Add a React component under `src/companion/components/`. Add the view name to the `ViewName` union in `src/companion/services/navigation.ts`. Add the render branch in `PhoneCompanionApp.tsx`'s `renderView`.

**Add a TUI capability:** Extend the `interact()` function in `src/components/PhoneAppView.interact.ts` with a new `if (capability === "...")` branch.

## Conventions / gotchas

- **Android-only registration.** `src/register.ts` calls `registerPhoneApp()` only when `isElizaOS()` returns true (i.e. the Android host). The companion page registers unconditionally because it serves iOS as well.
- **VOICE_CALL action is a stub.** The action is registered and the runtime can plan with it, but the handler returns a `scaffold_stub` failure until the Twilio dispatch is migrated from `plugins/plugin-lifeops`. Do not add parallel inline wrappers — migrate into the existing `src/actions/voice-call.ts` instead.
- **Contacts live in their own view.** The Phone overlay has no contacts pane — it links to the separate `@elizaos/plugin-contacts` view via `eliza:navigate:view` (`{ viewId: "contacts", viewPath: "/contacts" }`). Do not re-embed a contacts list or add a `@elizaos/capacitor-contacts` dependency here.
- **Cross-view number handoff.** The Phone view consumes a pending number via `consumePendingPhoneNumber()` from `@elizaos/ui/app-navigate-view` on mount, pre-seeding the dialer. Contacts (and any caller) seed it with `navigateToPhoneWithNumber(number)` from the same module — the navigation bus carries no payload to a mounted view, so the number is stashed module-side and consumed once.
- **`ElizaIntentWeb` does not simulate success.** The web fallback for the iOS native bridge explicitly returns `paired: false` and throws on `scheduleAlarm` — intentional, to prevent dev builds from appearing to work without a simulator.
- **Two build outputs.** The `build` script runs `tsup` (main ESM bundle) and then a separate Vite build for `dist/views/bundle.js` (the plugin view bundle loaded by the elizaOS view registry). The types pass uses `tsc --noCheck`.
- **Navigation persistence key.** `eliza.companion.nav.v1` in `@capacitor/preferences` — bump the key suffix if the `ViewName` union changes in a breaking way.
- **Session token is appended as `?token=`.** `SessionClient.connect` appends the token as a query param to the WebSocket URL; the ingress side must read it from there.
