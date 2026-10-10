# @elizaos/capacitor-secure-store

Device-only Apple Keychain and Android Keystore storage for Eliza app credentials.

Install workspace dependencies with `bun install` at the repository root.

Build from the repository root:

```bash
bun run --cwd plugins/plugin-native-secure-store build
```

Native storage behavior requires testing on the target Apple or Android device.

Android's device suite verifies the real WebView/Capacitor/Keystore round trip,
activity recreation, ciphertext persistence, deletion, and invalid/corrupt input:

```bash
node packages/app/scripts/android-native-plugins.ts --serial emulator-5554 --plugin plugin-native-secure-store
```

Android bridge instances serialize Keystore key creation and AtomicFile operations
within one process. Recovery includes backup-only values; removal checks base,
backup and pending writes. The existing ciphertext format and account binding
remain compatible. Keystore availability does not assert StrongBox protection.
Device tests use synthetic credentials in an isolated UID and cover complete
262,144-byte values, backup recovery, corruption and concurrent cold key creation.
Inspect the terminal instrumentation result, not only the shell exit status.

The Android `nativeonly` package provides host-configured password custody,
credential persistence, exact-origin autofill validation and one-shot sessions.
These are native APIs; they are not registered Capacitor methods. Hosts retain
picker UI, signer trust, permission declarations and release/debug policy, and
must preserve deployed aliases, AAD and filenames when adopting them. Custody
uses Android API 26+; browser structure parsing requires API 28+. Production
password keys must require device authentication. The unauthenticated constructor
mode is only for host-restricted synthetic tests. Autofill metadata key strings
retain their existing browser wire protocol identifiers.


`DeviceCredentialSession` owns native Activity challenge/result fencing and absolute
unlock expiry. Reserve an inclusive request-code range; forward activity results,
`onStop`, and destruction, and call `saveState` from `onSaveInstanceState`. Pass that
Bundle back on creation. Only the request-code watermark is saved, never a grant or
continuation. Missing/corrupt restored counters fail closed. Hosts supply localized
views/prompts and durations. Keep the `locked` listener presentation-only: do not
call `lock()` recursively from it. `authenticated()` rechecks elapsed time even if
Android delays timer delivery. This UI grant does not replace Keystore enforcement.

Run `bun run --cwd plugins/plugin-native-secure-store test:native-session` with a
JDK for deterministic grant tests. The Android DeviceCredentialSession instrumented
tests use real Bundle/Handler lifecycle plumbing and a synthetic challenge port;
they do not establish real device credential or biometric acceptance.

`PasswordAutofillCompletion` filters native vault metadata by the validated request
origin and publishes Android Autofill responses exactly once. Invoke it on the
main thread with a live authentication/browser-trust predicate, product RemoteViews
and a result publisher. It checks admission before and after vault access; the
current session is consumed before publishing, including when the publisher throws.
No secret is returned through Capacitor. Hosts still own picker UI and lifecycle
cancellation. Instrumentation uses synthetic records and field IDs, not a trusted
Chromium integration.

`NativeDeadlineTimer` owns main-thread expiry callbacks with elapsed-time checks,
replacement/cancellation fencing and terminal close. Use `after` for a display
duration or `watch(session::remainingMillis, callback)` for an existing Autofill
request; call `refresh` on resume and close on destruction. `watch` may expire
synchronously. Hosts retain masking/layout and selected display durations. Cancel
on screen replacement or stop as appropriate; callbacks are not persisted.

`PasswordAutofillOffer.create` constructs native Android authentication offers from
verified browser structures. Supply the product browser-trust predicate, explicit
picker Activity, URI scheme and RemoteViews factory; publish its nullable response
once through the OS FillCallback. It invalidates prior requests, binds cancellation,
uses immutable one-shot PendingIntents and revokes partially constructed offers on
failure. Hosts retain localized save rejection and picker UI. Instrumentation covers
real response parcelables with synthetic requests; it does not establish trusted
Chromium or device credential acceptance.

`JsonCredentialSlots` provides native-only JSON slot storage for hosts with the
version/IV-length AES-GCM frame. Hosts supply a no-backup directory, Keystore
alias and per-slot UTF-8 byte limits; renderer access policy remains with the
host. Slot filenames and AAD are the lowercase SHA-256 hex digest of the UTF-8
slot name. Preserve all deployed identities when adopting this helper. It does
not share the single-file `RuntimeCredentialStore` frame. A process-wide lock
covers cold key creation, reads, writes, removal and compare-and-exchange across
instances; writers in separate Android processes need separate coordination.
The device suite checks old-frame compatibility, backup recovery, tampering,
byte limits, concurrent cold writes and competing admissions with synthetic JSON.

`CredentialAccessSession.currentTicket()` binds queued work to the grant that admitted it.
Check `authenticated(ticket)` before use. `lock(ticket)` cancels only that owner; an old
Activity cannot revoke a newer challenge or grant. The host must serialize access to the session.

`PasswordVaultStore.KeyPolicy` selects the vault key's user-authentication window and whether
strong biometrics are accepted besides the device credential. The boolean constructor keeps
the deployed `KeyPolicy.LEGACY` (device credential, 120 s); an alias is never reused under a
different policy. `saveEntry`/`entries` add named entries with up to 20 normalized bindings
(`PasswordFacets`: exact HTTPS origins or `android://<sha256>@<package>`); legacy single-origin
records read as one binding, and `list()` still reports the primary web origin. `entries()`
never includes passwords. `PasswordVaultFrame` is the unchanged ciphertext frame, extracted so
it can be tested on a JVM: `bun run --cwd plugins/plugin-native-secure-store test:native-passwords`.
