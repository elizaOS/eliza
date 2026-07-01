# #10196 — per-view console-error sweep on-device (deeper than render coverage)

`route-coverage.android.spec.ts` proves every shipping view **paints** and does
not trip the React error boundary. This sweep goes one layer deeper: it walks
the same routes through the same harness on a real device against the host
agent and collects `console.error` / `pageerror` **per view** — catching the
class of defect where a view renders fine but logs a runtime error.

Spec: `packages/app/test/android/console-sweep.android.spec.ts` (runs the full
sweep in CI on a clean single-emulator environment).

## Result — 52/52 shipping views walked, 49 fully clean

Driven on an `android-34` emulator, app onboarded to home against the host
agent (`serve-real-local-agent.ts`, `adb reverse tcp:31337`), every route
navigated via the app's own router (`history.pushState` + `popstate`). All 52
views rendered (body content length 105–14563 chars — i.e. real, distinct view
content, not a stuck splash).

**49 of 52 views: zero console errors, zero exceptions, no error boundary.**

**3 native-data views log one Capacitor framework error each:**

| Route | console.error |
|---|---|
| `/contacts` | `{message: READ_CONTACTS permission is required}` |
| `/messages` | `{message: READ_SMS permission is required}` |
| `/phone`    | `{message: READ_CALL_LOG permission is required}` + `{message: READ_CONTACTS permission is required}` |

## Root cause (not cosmetic)

1. The strings originate in the native Kotlin plugins as
   `call.reject("READ_CONTACTS permission is required")`
   (`plugin-native-contacts` / `-messages` / `-phone`), i.e. the expected
   permission-denied path when the runtime permission isn't granted.
2. Capacitor's bridge logs **every** rejected native call itself —
   `@capacitor/core` `handleError = (err) => win.console.error(err)`. That is
   the source of the raw `{message: …}` object in the WebView console (bundle
   `:329`), **not** product code.
3. The product UI already *handles* the denied state gracefully (the view shows
   the error string + a "No contacts returned by Android" empty state). The
   console.error is therefore redundant noise for an already-handled, expected
   state.
4. The reads that trigger it (`listContacts` / `listMessages` / `getCallLog`)
   are issued **without a permission pre-check** in the `ElizaOsAppsView`
   contacts/messages surfaces. The native plugins expose `checkPermissions()` /
   `requestPermissions()`, and the **web** stub deliberately returns
   `{ contacts: "granted" }` *"so the shared view flow proceeds"* — i.e. the
   shared views were designed to gate the read on a permission check first.
   `ContactsView.tsx` does (`requestPermissions()` before `listContacts`);
   `ElizaOsAppsView`'s `refresh()` does not. That inconsistency is the defect.

## Fix direction (author-intent-aligned, root not surface)

Gate the native read behind `checkPermissions()` (→ `requestPermissions()` once
if not-determined) in the shared `ElizaOsAppsView` contacts/messages refresh
and the phone view; when not granted, render the permission-needed empty state
and **skip the read** so Capacitor never rejects → never logs. On web,
`checkPermissions()` returns `granted`, so the read path is unchanged (still
returns an empty list) and there is zero visual change on web/desktop.

Because this touches shared cross-platform UI (`packages/ui`), the
`bun run --cwd packages/app audit:app` visual-review loop is required before it
lands; that, plus parity across `PhoneView` / `ContactsView` / `MessagesView`,
is the remaining work.

## Reproduction

```
# host agent up on :31337, app installed on the emulator
ANDROID_SERIAL=emulator-5556 ELIZA_ANDROID_BACKEND=host \
  ELIZA_MOBILE_REPO_ROOT=<eliza checkout> \
  bunx playwright test --config playwright.android.config.ts console-sweep
```

(The WebView CDP target can be recreated mid-walk under emulator contention;
the spec navigates serially and the standalone driver re-acquires the page, so
the full 52-view sweep completes. The `len>50` per-view content lengths above
confirm real navigation, not a stuck shell.)
