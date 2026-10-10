# Android action journal

A host-configured, durable execution journal for device actions an owner has approved.
Each proposal moves `reserved` -> `applying` -> `terminal` exactly once. No entry is
permission to execute twice: a replayed reservation returns the stored entry, a changed
replay is refused, success requires a recorded dispatch (`applying`), and a terminal state
can only be replayed identically. This module performs no device action and grants no
approval; keep owner/agent authorization in the host.

## Host integration

Include this Android library and its `:capacitor-android` dependency. Extend
`ActionJournalPlugin` with a public no-argument constructor, annotate the subclass with the
host's chosen `@CapacitorPlugin` name and return the configured journal from
`createJournal()`. Every bridge in one process (for example a main Activity and an
assistant Activity) must receive the same `ActionJournal` instance for the same storage, so
one monitor serializes every transition. Register the subclass with each host bridge.

`ActionJournal` takes:

- `ActionJournalConfiguration`: the slot namespace and bounds. The namespace is
  migration-sensitive: slots are `<namespace>:<scope>:index` and
  `<namespace>:<scope>:entry:<proposalId>`. A host adopting the module keeps its existing
  namespace. `ActionJournalConfiguration.standard(namespace)` uses 2048 entries,
  64000-character records and 2000-character summaries.
- `ActionJournal.Storage`: an existing durable, encrypted string store. A failed write must
  throw. This library supplies no plaintext fallback.
- `ActionJournal.ResultPolicy`: the host's admission of terminal results (`check`) and the
  redacted copy a passive `list` exposes (`listView`). `ActionJournal.BOUNDED_RESULTS`
  admits only small opaque results.

Host-specific recoveries (for example re-reading a saved receipt instead of repeating an
effect) use `ActionJournal.update`, which runs under the journal lock and refuses any change
to an entry's identity or dispatch attempt. Recovery cannot move an entry back to a
dispatchable phase. It can settle an unknown outcome only through the host result policy. Subclasses add
bridge methods with `work(call, needsId, task)`, which runs on the plugin's serial worker.

## Crash ordering

The index slot commits before the entry slot. A crash between them leaves a listed id
without an entry, which `list` skips and an identical `reserve` completes; it never leaves
an effect that the journal does not list. The journal is bounded: a full index refuses new
proposals while existing replays keep working.

## Verification

`node --test test/native-host/journal.node.mjs` compiles the engine with `javac` against
an org.json jar (`ELIZA_ORG_JSON_JAR`, or the Gradle cache copy) and runs synthetic JVM
checks. A Java or APK build is not device acceptance; a host's own instrumentation must
cover its storage, lifecycle and recovery paths.

The checked-in `test/android-consumer` host uses the existing `JsonCredentialSlots` store
and Android Keystore. Set `CAPACITOR_ANDROID_DIR` and `ANDROID_HOME`, then build the fixture
with Gradle (`:host:assembleDebug :host:assembleDebugAndroidTest :host:assembleRelease`).
Run `example.actionjournal.host.test/androidx.test.runner.AndroidJUnitRunner` on a test
user. It verifies encrypted persistence after Java owners are recreated, replay refusal,
and recovery after an interrupted entry write. It performs no device action and does not
claim a full process-death or product acceptance test.
