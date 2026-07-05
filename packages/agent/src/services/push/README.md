# Remote push (APNs / FCM)

Server-side delivery of agent notifications to **backgrounded/killed** devices.
When the app is foreground-connected it already receives notifications over the
WebSocket `stream:"notification"` rail and renders them in-app; this stack is the
out-of-process path for when the WebView is not running.

## How it fits together

```
NotificationService ──emit──▶ agent event bus ──▶ NotificationPushService
                                                      │  (subscribes to stream:"notification")
                                                      ▼
                                        PushTokenRegistry.list()  ──▶  ApnsProvider (ios)
                                                                        FcmProvider  (android)
```

A device registers its OS push token through
`POST /api/notifications/push-tokens` (`push-token-routes.ts`). The client leg
that calls it lives in the UI: `push-registration.ts` acquires the token via
`@capacitor/push-notifications` and posts it (see
`packages/ui/src/state/notifications/push-registration.ts`). Until a device
registers, `PushTokenRegistry.list()` is empty and `NotificationPushService`
does nothing — that is the correct "no device to reach" state, not a failure.

`NotificationPushService` only activates a transport when its credentials are
present (`isConfigured()`); with neither configured it starts, keeps the
registry + routes live, logs once at debug, and no-ops per notification.

## Credentials

Set these on the process that runs the agent (local/desktop host or the cloud
container). None are required to boot — configure only the transport(s) you use.

### APNs (iOS) — token-based auth (`.p8` key)

| Env var | Meaning |
| --- | --- |
| `ELIZA_APNS_KEY` | The `.p8` EC private key **contents** (PEM). |
| `ELIZA_APNS_KEY_PATH` | Alternative to `ELIZA_APNS_KEY`: path to the `.p8` file. |
| `ELIZA_APNS_KEY_ID` | The APNs auth key id (the JWT `kid`). **Required.** |
| `ELIZA_APNS_TEAM_ID` | Apple developer team id (the JWT `iss`). **Required.** |
| `ELIZA_APNS_TOPIC` | App bundle id (the `apns-topic` header). **Required.** |
| `ELIZA_APNS_PRODUCTION` | `1` → production host `api.push.apple.com`; anything else → sandbox `api.sandbox.push.apple.com` (development builds). |

The provider is `isConfigured()` only when `KEY_ID`, `TEAM_ID`, `TOPIC`, and a
key (inline or path) are all present. Sandbox vs production must match the app's
`aps-environment` entitlement — a sandbox token cannot be delivered on the
production host and vice-versa.

### FCM (Android) — service account

| Env var | Meaning |
| --- | --- |
| `ELIZA_FCM_SERVICE_ACCOUNT` | The Firebase service-account **JSON** contents. |
| `ELIZA_FCM_SERVICE_ACCOUNT_PATH` | Alternative: path to the service-account JSON file. |

The JSON must contain `client_email`, `private_key`, and `project_id`. The
provider exchanges an RS256 assertion for a bearer token at
`oauth2.googleapis.com` (cached), then POSTs to the FCM v1 `messages:send`
endpoint for the account's project.

The Android build additionally needs `google-services.json` dropped into
`packages/app-core/platforms/android/app/` at build time; without it the
`com.google.gms.google-services` gradle plugin is skipped and the device never
mints an FCM token (see that module's `build.gradle`).

## Verification

- Unit: provider JWT/payload shaping, service dispatch routing, dead-token
  pruning, and the route handlers (`*.test.ts` in this dir + `push-token-routes.test.ts`).
- Integration: `push-registration-flow.test.ts` drives the full loop — a token
  POSTed through the real HTTP route reaches the provider `send()` on an emitted
  notification.
- Live: `push-delivery.real.test.ts` sends against Apple's / Google's real
  servers when creds are set (post-merge lane), asserting a bogus token is
  rejected end to end. Delivery to a real **enrolled device** is pending-hardware.
