# @elizaos/ui

Shared React UI library for elizaOS apps: primitives, composites, layouts, the typed HTTP/WS API client, agent-surface view
instrumentation, GenUI, voice, and host capability interfaces.

`@elizaos/ui/view-primitives` provides the shared page frame, button, compact
skeleton, agent-element hook and API error predicate for embedded domain views.
It does not import the application, account or provider client barrels.

Public JavaScript APIs use the package root; UI internals import owner files directly.
Batch voice hosts use `@elizaos/ui/voice/batch-conversation` to load the coordinator
without the React UI root. This public entry owns no credentials, media or provider
lifecycle. Hosts must await its stop promise before reporting media retirement;
an idle state alone does not confirm cleanup. Run `bun run --cwd packages/ui test:batch-voice-package` for
packed external types, runtime and browser-bundle verification.
Hosts that render their own UI can also load these leaf modules without the React
UI root: `@elizaos/ui/text-control-editing` and `@elizaos/ui/voice/` followed by
`draft-transcript-guard`, `microphone-capture`, `pcm-wave`,
`progressive-speech-playback`, `recorded-transcription-controller` or
`segmented-speech-playback`. The same packed-consumer test covers these entries.

`@elizaos/ui/voice/voice-session-client` exposes the realtime PCM client with a
required host-owned fetch transport. It does not load dashboard credentials or
connection settings. The app's existing internal entry retains its default
dashboard transport. The packed-consumer check verifies the public client's
mint, first-frame handshake, interruption and cleanup with injected transports.
`@elizaos/ui/installed-apps-launcher` renders the shared installed-app list,
search, favorites and default-phone shortcut. Pass the controller from
`@elizaos/capacitor-system/launcher`, current query and host callbacks. The host
provides its product name, builtin key prefix, icons and CSS theme tokens; the
component does not choose a native adapter or storage namespace. AOSP
`LauncherSurface` uses the same component for registered views and Android apps.

`@elizaos/ui/mobile-shell` is the resident shell of a branded mobile product:
Home with host notices, a card row and the app grid, All apps over the
installed-app launcher, lazy domain views and one navigation reducer for the
open view, Back stack, drawer and the assistant's pill, composer, sheet or full
detent. A product supplies only a versioned registration (schema
`elizaos.mobile-product`): identity, a `ThemeDefinition` with shell chrome and
declared stylesheet aliases, icons, Home backgrounds, view order and labels,
older view ids and the installed storage names it keeps reading. Validate it
with `defineMobileProductRegistration`. Views use canonical ids (the ids of
the agent's `VIEWS` action); a product's older ids resolve through the
registry, and the launcher join migrates them once in the installed favorites
before its first read. `@elizaos/ui/mobile-shell/core` is the same model
without React components for runtime code such as agent navigation. Neither
entry loads the package root.

`MobileApplication` is the production Android entry inside the app's existing
startup/auth provider. It owns Home, All apps and registered view placement;
`createMobileApplicationCatalog` projects the authoritative AppShellPage registry
without using product order as an allowlist. Hosts pass their current navigation
owner, retained view trees, assistant and system overlays. Canonical shell
storage goes through its existing guarded shell writer; compatibility hosts
provide their own storage port. These ports do not
create another session, action dispatcher or conversation owner. The canonical
app retains its existing ViewRouter; compatibility consumers can keep individual
legacy domain views while migrating their implementations separately.

`@elizaos/ui/api/transport` exposes the browser-safe request helpers and
`SseEventFramer`. It preserves event lines across fragmented network reads;
hosts retain UTF-8 decoding policy, limits, cancellation, validation and receipts.
The Eliza chat client uses it without a pending-event rescan on each chunk.
It also declares `ElizaClientFetch`, the JSON request surface `ElizaClient`
implements, so plugin clients can accept a session-bound fetch without importing
the client class.

The app owns renderer composition and native transport selection. Consumers render
domain DTOs imported from `@elizaos/contracts`; business logic belongs to domain services. Use `bun run --cwd packages/ui storybook` for
component development. Changes reaching the app require its visual audit.

Pass the host's `branding` to `CloudRouterShell` as well as its app provider.
Public sign-in uses `appName`, optional `cloudName` (defaults to the app name
followed by Cloud), and optional `logoUrl` (omitted logos show the app name).
Account deletion uses the same app and Cloud names and the optional host-owned
`supportEmail`. Set it in the app branding; shared defaults provide no mailbox.
When absent, the page explains that support contact details are unavailable.
These presentation values do not change authentication tenants or API endpoints.
Public Terms and Privacy read `/api/public/service` from that deployment. Configure
`CLOUD_PUBLIC_SERVICE_JSON` before deploying these pages; missing or invalid metadata
shows an unavailable state with Retry, never another provider's legal policy.
Document titles, revisions and paragraphs render as plain text.

## Native mobile sign-in

`@elizaos/ui/android-cloud/NativeCloudSignInView` renders the common email,
SMS, Google and MFA surface. Its styles ship in `@elizaos/ui/styles`; a host that
does not load that sheet imports `@elizaos/ui/styles/native-cloud-sign-in.css`.
The module itself imports no stylesheet, so Node can load the package root. Its `NativeCloudSignInController` comes from the
adjacent `native-cloud-sign-in-controller` entry. The app owns that controller's
lifetime: call `start()` after mounting the owner and `dispose()` when retiring
it. A view may unmount without retiring an application-owned attempt.

The controller accepts the shared auth native port and an immutable owner guard.
`runOperation` can join the host's existing session-operation lock; it must reject
busy or retired work instead of skipping an action. `activate` verifies the stored
session and account before completion. A failed activation remains a retry of
that authenticated outcome, without requesting another code. Native storage,
credential replacement and provider retirement remain with their existing owners.
The controller neither stores a token nor treats authentication as entitlement,
resident startup or AI readiness.

Explicit `leave()` waits for native cancellation acknowledgement before releasing
the owner. A failed cancellation keeps the current view available for retry and
blocks retained outcomes and new method dispatch until retirement succeeds.
`dispose()` is forced teardown, not an acknowledged sign-out. Once native sign-in
has authenticated, disposal retires renderer work without cancelling the committed
native attempt, including when account publication itself removes the view.
Native authenticated
events currently lack an attempt identity; hosts must not treat them as proof of
credential retirement or correlation across a destroyed application owner.

The common view accepts product copy, branding, theme tokens and a public
`serviceInfo` loader. Terms and privacy use the strict plain-text contract in
`native-cloud-service-info`. Canonical Android requests use the same controller
and view; the existing request broker routes retained native completions to the
interactive owner and waits for its account verification before closing it.
The full-screen surface has an opaque backdrop and scrolls when enlarged text
exceeds the viewport; `embedded` leaves the surrounding host surface visible.
Run `bun packages/ui/src/android-cloud/__e2e__/run-native-cloud-sign-in-e2e.mjs`
for the controlled native overlay, keyboard, MFA and activation-retry browser fixture.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/ui build  # build
bun run --cwd packages/ui test   # tests
```

`bun run --cwd packages/ui audit:design` reports current component ownership
and possible duplication. It is advisory; lint, typecheck, rendered behavior,
and accessibility checks remain separate.

The browser-safe `TaskChoice` export renders validated
task choices in a chat or panel. The host owns transport, authorization, styling
and localized messages. It suppresses duplicate in-flight clicks and expired
responses; the durable runtime remains authoritative. Hosts that pass
`explainUnavailable` keep options activatable (`aria-disabled`) and announce why
an in-flight or expired choice cannot be used, and hide options once the choice
is no longer pending. `splitSpeechSegments`
shares lossless caption/playback chunks without importing the voice runtime.
`createSpeechWordTimeline` maps explicitly utterance-relative character timing to
UTF-16 caption ranges at a media playback time. Hosts supply exact caption text
and own playback/lifecycle; missing, reset or mismatched timing disables emphasis.

`TaskLifecycle` projects authoritative task status and
reconciles start/pause/resume/cancel requests without optimistically reporting
success. Hosts provide transport, localized failure messages and view updates.
The durable runtime remains authoritative; this projection grants no task authority.

`encodeMonoPcm16Wav` and `encodeMonoPcm16WavChunks` share mono PCM16 WAV encoding for single buffers or
cumulative chunks without importing capture, desktop bridge or provider code.
Hosts own recording lifecycle, sample-rate selection and playback/transcription.
Nonfinite samples encode as silence; finite samples are clipped and rounded.

`BrowserDocumentStore` stores opaque text with IndexedDB transaction receipts.
Its compare-and-swap operation detects stale writes and retains reset tombstones;
`readOrCreate` initializes absent bytes atomically while preserving existing receipts,
including reset tombstones, across concurrent callers and tabs.
`edit` serializes asynchronous, side-effect-free callbacks with Web Locks and never
replays them. Cancellation prevents a late callback from committing. Hosts own
storage namespaces, schema validation, legacy migration and recovery presentation.
This API does not maintain a localStorage mirror. Run
`bun run --cwd packages/ui test:browser-document-store` for real cross-tab,
cancellation and recovery checks in Chromium, Firefox and WebKit.

`startCumulativeMicrophoneCapture` and `observeMicrophonePause` share cumulative sample previews and speech-pause
observation without owning microphone tracks, transcription or message submission.
Hosts supply timing/energy policy and the URL of `voice/microphone-samples.worklet.mjs`
(or a compatible mono worklet). Previews are single-flight and are not replayed;
unsupported capture returns no observer so the host can retain final-recording UX.

`createRuntimeJsonClient` shares JSON request handling and coalesced native
startup for host-selected runtime bridges. Hosts supply URLs, native HTTP
fallback, budgets and messages. Once native availability is established, failures
never fall back or replay requests. Account refresh fences earlier responses;
cancelling their publication does not undo native effects already dispatched.
Requests wait for account refresh. A failed or timed-out refresh blocks requests
until the host explicitly retries refresh; late status replies cannot restart polling.

`formatMinorCurrency` formats safe integer minor units through an exact decimal
string, checking the selected currency exponent. `isIsoCalendarDate` and
`isOrderedIsoDateRange` reject normalized invalid dates and reversed inclusive
ranges. These browser-safe helpers leave locale, labels and domain policy to hosts.
They live in import-free `utils/value-formatting.mjs` (export
`@elizaos/ui/value-formatting.mjs`), so hosts that stage only `.mjs` files can load them.

`ConversationTurnController` owns explicit single-flight creation/send, cached room
identity, interruption and stale-reply fencing without importing the shell. Hosts
supply transport, ownership-error classification, request metadata and synchronous
reply/error/settled observers. Interrupted work never publishes or replays. A new
send waits for an earlier room abort; failed aborts discard that room and report
failure before an explicit retry can create another. `reset` invalidates ownership
and teardown callbacks. A stop receipt does not prove an external action was undone.
`bind` lets a resident client adopt a conversation it already owns; it stops any
in-flight turn first. `reset` and `bind` advance a generation, and `fence()` gives
hosts the same staleness check. Each turn hands the transport a `clientMessageId`,
an `AbortSignal` and `current()`. Declined sends are typed `ConversationTurnRefusal`s
(`busy`, `stop-unconfirmed`, `invalid-identity`), and failures say whether the request
was `dispatched`. The last stopped dispatched turn is kept in `stopped`, and
`findStoppedUserTurn` finds its user row in a later conversation read. The leaf
export `@elizaos/ui/api/conversation-turn-controller` loads it without the package root.

`request(input, {conversation, signal})` awaits that same turn lifecycle. It reserves
the turn before binding or waiting for Stop, so a declined or cancelled caller
cannot rebind or stop a later request. Rejections keep their error identity and,
when mutable, carry `notDispatched`; an `AbortError` alone never proves no send.
`admitConversationStopReceipt` requires `aborted: true` and the expected room and
reason. It confirms cancellation was signaled, not that remote cleanup finished.

Browser speech lifecycle APIs are available from the package root.
`DeviceSpeechController` owns device
utterance cancellation, stale callbacks and page visibility cleanup; dispose it on
unmount. `SegmentedSpeechPlayback` owns sequential synthesized clips, playback
state/captions, live rate changes and object URL/player cleanup. Its optional
`attach` mode composes progressive streams with acknowledged rendering speed,
exact word timing, cancellation and explicit EOF completion; hosts own cache,
volume and sentence policy through `segments`. Inject synthesis
and state observers, call `stop()` on cancellation/teardown, and supply product
copy and consent gestures in the host. These encoded-audio and device-speech paths
do not replace the realtime PCM voice-session player or acquire a microphone.

`RecordedTranscriptionController` owns bounded MediaRecorder utterances, stream
cleanup, preview/final ordering and stale authorization/acquisition/transcription
responses. Supply authorization, shared capture/encoding adapters, a transcription
transport and selected bounds. `finish()` requests a final transcript; `cancel()`
releases resources without publishing late words. It never sends a chat message.
`DraftTranscriptGuard` distinguishes a recording's own preview updates from later
user edits and returns final conflicts for host review; hosts choose append/replace
policy and explicit review/send gestures.

`editTextControl` shares selection replacement, Unicode-code-point backspace,
UTF-16 max-length admission and realm-owned native setter/input-event dispatch
for controlled text fields. `isEditableTextControl` accepts the host's input-type
policy. Keyboard layouts, key mapping, visibility, focus and viewport handling
remain product-owned. These helpers do not submit forms or advance workflows.

`createValidatedJsonStorage` shares guarded JSON reads, writes and removal. Pass a storage resolver so getter failures are also caught. Hosts retain keys, schema validators, fallbacks and presentation of failed writes. Reads reject malformed or invalid data; writes reject unserializable values without replacing the prior record. No automatic retries or recovery side effects occur.

`attachProgressiveSpeech` attaches the Cloud SDK's native speech source (or a
compatible injected source) to an owned HTMLAudioElement. MP3 MediaSource appends
are serialized; the host controls play, rate, volume and presentation through
`onReady` and `onFrame`. `loaded` resolves only after explicit stream completion,
returning a complete Blob and the original timing frames for memory-only replay.
Call `dispose` on Stop, account change, unmount or completed playback cleanup.
Browsers without MP3 MediaSource accumulate that same response, without another
synthesis. Hosts must stop/discard failed sessions and must not invent timestamp
offsets or infer word times from text length.

`bun run --cwd packages/ui test:progressive-speech-e2e` exercises actual Chromium MP3 decoding,
playback before EOF, mid-stream disposal, whole-clip fallback and Blob replay.
The committed fixture is a synthetic four-second 440 Hz tone, generated with
`ffmpeg -f lavfi -i sine=frequency=440:sample_rate=44100:duration=4 -ac 1 -b:a 32k -write_xing 0 -map_metadata -1 synthetic-tone.mp3`.
The test permits autoplay explicitly; it does not qualify autoplay policy,
provider timing/voice quality, mobile WebView or physical speakers.

`BatchVoiceConversation` shares the foreground capture, turn, reply and playback loop through injected ports. Hosts own credentials, microphone access, Cloud transcription, `VOICE_DM` submission and matching playback completion. Stop retires late replies and drains owned capture before replacement. It never edits a text draft, selects a provider or resumes itself after retirement. `createVoiceTurnAggregator` and `createVoiceActivityDetector` also serve the existing shell; native peak-only activity does not invent RMS measurements.

A durable owner-input reply can pause `BatchVoiceConversation` with `awaitingUserInput`. The host keeps its existing Review controls visible; the coordinator opens no microphone and starts no speech while paused. After the host authenticates and completes that same original request, `resume({pause, reply})` admits its exact new assistant reply once. The pause carries request, conversation, user-message, assistant-message and proposal correlations only. It never approves an action, sends a new user message or restores a retired voice session.

### Optional client observations

`@elizaos/ui/api/client-observation` owns optional observation negotiation. Supply the
current authenticated origin/owner/agent/session and connection epoch, a currentness
predicate, and an authenticated status reader. The session learns one API-process nonce,
then compares fresh status before including Calendar day context. A replaced or unreadable
process omits the optional field until a new verified session is created. This format
handshake grants no Calendar access and does not replace the host's visibility checks.
Turn cancellation stops only that caller's wait. Session retirement also cancels the
shared handshake, so another turn cannot inherit a cancelled caller's failure.

Mobile discovery uses `mobileViewIsAvailable` from `mobile-shell/core`: registered
implementations, runtime/view-kind declarations and installed native adapters
determine availability; product ordering is presentation only. The
`styles/mobile-workspaces.css` export compiles scoped domain utilities with the
host's Tailwind integration and semantic theme. It does not import the app reset.

`selectHomeCalendar` in `overview/daily-overview` ranks the full local today, week
and month from a complete current-owner feed and readable included sources. Each
period prefers unended events, then the most recent past event. Coverage must
include the full week and month before any item or empty answer is established;
an incomplete query or retired owner stays unverified. Hosts
retain their existing reads and mutation owners. The compact tray passes its
explicit surface to keep its near-future glance window; product identity never
selects the Calendar policy. Run `test:mobile-workspaces-style` to check scoped
utilities from emitted package files.
