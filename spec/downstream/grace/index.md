# Grace's Eliza dependency contracts

Grace source `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` binds Eliza
`7743504b7c936a764b3938a44cad918808b621df`. The lockfile, Git submodule
pointer and clean vendored checkout agree. The source inventory records
exact declarations, their pinned target paths, native build selections, and
formal model identities. It includes source references from tests and
optional configurations without counting those as release activation.
[Grace source inventory](./baseline.json).

[Assisted bill journey](./assistedBillJourney.md) brings together task
owner, source selection, payment guidance, and receipt delivery.

| Grace entry | Imported behavior | Owning specification |
| --- | --- | --- |
| `LocalRuntimeService.java`, `runtime-action-policy.json`, `runtime-plugin-policy.json` | Resident agent boot, SQL/PGlite memory, assistant behavior, required scheduler, development versus signed-in model routing, USER caller and four allowed chat actions | [Chat host](../chatHost.md), [mobile](../mobile.md), [core turn](../../core/journey.md) |
| `build-task-runtime.ts`, `task-runtime-gateway.ts`, `task-routes.ts` | Compiled interactive-task runtime, native actuator, durable owned epochs and events, resolver and task choices | [Interactive-task kernel](../../core/interactiveTask.md), [owner fence](./taskOwner.md), [task choices](./taskChoices.md), [task event reader](../../core/taskEventReader.md), [task request and view codecs](./taskHttp.md) |
| `configured-bill-helper.ts`, `bill-helper-host.ts`, `bill-client.ts` | Reviewed extraction profile, complete document parsing, account-bound source offers, checked website facts, manual payment pointer, prior outcome and recovery | [Bill extraction and selection](./billSource.md), [bill review](./billReview.md), [verification field](./billVerification.md), [bill panel](./billClient.md), [bill response admission](./billWire.md), [latest bill outcome](./billOutcomeClient.md) |
| `bill-email-extract.ts` | Generic extraction admission, quoted evidence, and optional field validation | [Bill email evidence](./billEmailEvidence.md) |
| `website-guide-helper.ts`, `native-page.ts`, `embedded-browser-client.ts` | Page facts, fresh binding and readback, one-use answer, safe refusal when the host cannot act, pause and uncertainty | [Website guidance](./websiteGuide.md), [payment-step history](./paymentGuidance.md), [mobile bridge](../mobileBridge.md) |
| `task-storage-native.ts`, `task-storage-encryption.ts`, Eliza `interactive-task-store.ts` | SQLCipher handle verification, native key broker, journal sealing, and unreadable task recovery | [Task storage custody](./taskStorage.md), [legacy task migration](./taskMigration.md), [task journal recovery](./taskRecordRecovery.md), [host refusals](./hostRefusals.md) |
| `runtime-client.ts`, `task-lifecycle.ts`, `stage-task-events.ts` | Shared conversation transport, stop receipt and newest task response, projection of pinned task events, widgets and UI | [Conversation controller](../conversation.md), [core turn controllers](../../core/turnControllers.md), [task choices](./taskChoices.md), [task event reader](../../core/taskEventReader.md), [task lifecycle client](./taskLifecycleClient.md), [renderer value utilities](./rendererUtilities.md), [mobile runtime](../mobileRuntime.md) |
| `native-cloud-auth.ts`, `cloud-runtime-routes.ts`, `document-runtime.ts`, `account-access.ts` | Credential enrollment and ownership, grant projections, inference, document routes, mail fields and coverage of optional Clef policy | [Cloud enrollment](../cloudEnrollment.md), [Cloud host](../cloudHost.md), [Cloud entitlements](../cloudEntitlement.md), [resident inference](../residentCloud.md) |
| `apps/app/native/android/host.json`, `apps/updater/android/build.gradle`, `stream-speech.ts` | Java/Kotlin overlays, platform bridge permissions, camera, browser, contacts, calendar, photos, Wi-Fi, native-only secure store, streaming speech, health and OTA trust | [Mobile specifications](../mobile.md) |

Grace builds selected helpers from the personal-assistant source directly
while its runtime plugin policy denies the full plugin. The configured
biller helper is available only where reviewed helper configuration is
installed. The production guide takes the generic website path. The browser and UI
source used to compile task delivery comes from pinned generated projections
and `#eliza/*` source aliases. `@elizaos/core/protocol` is configured as a
Grace-owned protocol shim in its TypeScript config. The scan found no tracked
direct imports of that alias on the product side. Android passwords are
packaged with the release enable switch off. OpenAI and Anthropic are
key-gated, and research capture is a configuration-gated host path.

The pinned Eliza source carries 16 core TLA+ modules and 31 case
configurations. Grace adds TLA+ suites under `apps/app/formal/` for the task
kernel, guide and bill payment, account custody, voice, money and Cloud,
and update recovery. The pinned vendor has no tracked Quint file. The
inventory records these model identities, and the new Quint commonly draws
on `TaskOwnerFence`, `TaskActuatorDispatch`, `GuideConsent`,
`GuideStopFence`, `BillAttempt`, and `MoneyEffect`. Existing Grace tests
include owner-fence model replay, browser Stop, prior payment, task storage,
and reviewed PDF extraction. Those tests are source evidence for the model;
the replacement's executable shell conformance belongs to implementation.
Two explicit TODOs at the source pin remain compatibility decisions:
looking up another task's review in the configured helper and recognizing
a Spanish payment control as requiring a money question before guidance.
The generic release guide's prior-payment behavior has a separate
specification and source test coverage.

The current models make the decoder, browser, document, key broker, and
database evidence boundaries explicit. They prove decisions made from those
results. They do not implement PDF or URL parsing, envelope cryptography,
SQLCipher, native calls, or provider payment. The package surface still needs
acceptance against these exact caller imports when those implementations
exist.
