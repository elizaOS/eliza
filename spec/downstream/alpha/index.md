# AlphaPhone's imported Eliza contracts

The Alpha source is `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43`. Its
`upstream.lock.json`, Git submodule pointer, and local Eliza checkout agree on
`c518127a025ab173874af9c7d304f26b25213b0d`. The inventory reads committed
Alpha source and exact pinned Git blobs. It excludes unrelated edits in the
working copy. The checked existing `.eliza/client-features` projection
claims the same pin, and every listed raw Git blob and published file was
checked against its recorded SHA-256. Two generated re-export maps select
pinned source leaves, and nine pinned files receive reviewed import-only
rewrites. The full [import and model inventory](../alphaBaseline.json)
retains import locations, admitted native modules, projection hashes,
main-entry transitive edges, and the original Quint file identities.
Static reachability includes gated imports. It does not certify their
activation on a physical device.

| Consumer entry and owner | Behavior needed by Alpha |
| --- | --- |
| `scripts/prepare-client-features.ts`, `tsconfig.json`, `vite.config.ts` | [Authenticated source projection and publication](./clientPublication.md) |
| `scripts/qualify-head.ts` | [Required browser reports](../browserQualification.md) and [installed APK campaign evidence](./candidateQualification.md) |
| `apps/app/src/product/alpha-product.ts`, `apps/app/src/prototype/model.js` | [Versioned product registration and admission](./product.md), [shell navigation, overlays and drafts](./navigation.md), [launcher and retained choices](./launcher.md) |
| `apps/app/src/prototype/home-shell.ts`, Eliza `mobile-launcher.ts` | [Launcher inventory, exact Android handoff, and observation](./launcherInventory.md) |
| `apps/app/src/startup-permission-flow.ts`, `apps/app/src/startup-permissions.tsx` | [Shared permission step](./permissionStep.md), [Alpha access setup](./permissions.md) |
| `apps/app/src/prototype/settings-adapter.ts`, `system-shade.ts`, `runtime/always-on-listener.ts`, `AlphaApplication.java` | [Native reset, problem journal, Settings, shade and listener custody](./system.md) |
| `apps/app/src/runtime/view-focus.ts` | [Screen focus ownership, priority, and restoration](./screenFocus.md) |
| `apps/app/src/main.tsx`, `packages/ui/src/state/app-update-gate.ts` | [Renderer update admission and activation readback](./updateGate.md) |
| `apps/app/src/main.tsx` and `apps/app/src/prototype/agent-adapter.ts` | [Client conversation](../conversation.md), [turn ownership and cancellation](../../core/turnControllers.md) |
| `apps/app/src/prototype/assistant-draft-controller.ts`, `apps/app/src/runtime/assistant-draft-store.ts`, `apps/app/src/browser/documents.ts` | [Durable drafts and send recovery](./durableDraft.md), [browser document receipts and recovery](./documentStore.md) |
| `apps/app/src/prototype/canonical-notes-ui.ts`, `notes-controller.ts`, `notes-editor.ts` | [Notes snapshot and draft custody](./notes.md), [Previous Notes Trash and audio recovery](./notesTrash.md), [local search and selected content](./notesRead.md), [native recording custody](../mobileNoteAudioCustody.md) |
| `apps/app/src/prototype/agent-calendar-adapter.ts`, `calendar-approval-adapter.ts` | [Calendar target and availability review](./calendar.md), [availability data and receipt shape](./calendarAvailabilityData.md), [agenda source observation](./calendarAgendaSource.md), [canonical feed and saved reads](./canonicalCalendarRead.md), [linked Calendar control](./canonicalCalendarSync.md), [managed feed and cache purge](./managedCalendarFeed.md), [native managed Calendar read authority](./managedCalendarReadAuthority.md), [provider merge](./calendarAggregateMerge.md), [linked event reconciliation](./linkedCalendarReconcile.md), [draft and versioned mutations](./calendarDraft.md), [scoped writes and renderer handoff](./calendarSeriesWrites.md), [Android provider review](../mobileCalendarScopedDeletion.md), [durable Undo](../mobileDeferredDeletion.md) |
| `apps/app/src/prototype/maps-adapter.ts` | [Maps route and offer custody](./maps.md), [foreground guidance voice](./mapsGuidanceVoice.md), [Cloud Maps connection ownership](./cloudMapsConnection.md), [native navigation handoff](../mobileNavigationHandoff.md) |
| `apps/app/src/runtime/telephony-executor.ts`, Phone, Messages, and Contacts adapters | [Verified image review, SIM selection, and operation receipt](./telephony.md), [native SMS review custody](../mobileTelephony.md) |
| `apps/app/src/prototype/browser-adapter.ts` | [Current document and private profile](./browser.md), [reading capability and reviewed preview](./browserReadingSource.md), [Android isolated reading and speech approval](../mobileBrowserReading.md), [session restore and clear](./browserPersistence.md), [native browser storage](../mobileBrowserStorage.md), [native external link authority](../mobileBrowser.md) |
| `apps/app/src/passwords/password-manager.ts`, `MainActivity.java` | [Vault visit, native unlock, origin review and secret custody](./passwords.md), [installed Android Autofill](../mobilePasswordAutofill.md) |
| `apps/app/src/browser/files.ts`, `AlphaFilesPlugin`, `AlphaMailAttachments` | [Reviewed file operations and retained trash](./files.md), [native file mutations and recovery](../mobileFilesMutationCustody.md), [native file read-only handoff](../mobileFilesReadHandoff.md), [verified document source reopening and read permissions](./sourceReferences.md), [isolated PDF fallback](../mobileIsolatedPdf.md), [selected PDF preview](../mobileSelectedPdfPreview.md), [native file observer custody](../mobileStorageWatch.md), [Android selected-document grants](../mobileSelectedDocumentGrants.md) |
| `apps/app/src/prototype/browser-camera.ts` | [Selected media download and stored ZIP](./photosArchive.md), [Android still-photo copy recovery](../mobilePhotoCopyRecovery.md), [original photo replacement](../mobilePhotoReplace.md) |
| `apps/app/src/prototype/camera-adapter.ts`, `apps/app/src/runtime/media-copy-intent.ts` | [Photos window](./photosWindow.md), [native Photos catalog](../mobilePermittedMediaCatalog.md), [owned albums](../mobileOwnedAlbums.md), [owned Photos trash](../mobileOwnedPhotoTrash.md), [permitted-media mutation review](../mobilePermittedMediaReview.md), [video edit review](./videoEditReview.md), [saved media requests](./mediaCopyIntent.md), [browser video copy](./browserVideoCopy.md), [Android video copy](../mobileVideoCopy.md), [Android video playback](../mobileVideoPlayback.md) |
| `apps/app/src/prototype/local-ocr.ts`, `scan-pdf.ts`, `scan-searchable-review.ts` | [Local OCR worker custody](./localOcr.md), [reviewed searchable PDF](./searchableScanPdf.md) |
| `apps/app/src/prototype/scan-correction-review.ts`, `scan-link-review.ts`, `apps/app/src/browser/scan-draft.ts` | [Selected-page correction](./scanCorrection.md), [reviewed link handoff](./scanLinks.md), [durable scan draft storage](./scanDraftStorage.md) |
| `apps/app/src/prototype/inbox-cloud-adapter.ts`, `apps/app/src/runtime/gmail-background.ts` | [Managed Inbox paging and cache identity](./inbox.md), [saved reads, grant revocation and cache custody](./inboxCache.md), [managed Gmail wire](./managedGmailWire.md), [Gmail notice and Ask custody](./gmailNoticeCustody.md), [native Gmail background delivery](../mobileGmailBackgroundDelivery.md), [draft and provider receipt custody](./inboxDraftCustody.md) |
| `AlphaNotificationListener`, `AlphaNotificationsPlugin` | [Selected-app notification mirroring and actions](../mobileCrossAppNotifications.md) |
| `apps/app/src/runtime/hosted-digest-ui.tsx`, `AlphaHostedResultsPlugin` | [Android Brief inbox reconciliation](../mobileHostedInbox.md), [hosted Brief result notice custody](../mobileHostedResultNotices.md) |
| `apps/app/src/prototype/home-cards.ts`, `home-overview-cards.ts` | [Current-source Home projections](./overview.md) |
| `apps/app/src/prototype/automations-adapter.ts`, `runtime/automations-protocol.ts` | [Automation row, cron and reminder presentations](./automationPresentation.md) |
| `apps/app/src/browser/notifications.ts`, `workflow-notices.ts` | [Exact browser notice action and workflow receipts](./notices.md) |
| `apps/app/src/runtime/client-observation-support.ts`, `alpha-client.ts` | [Authenticated observation negotiation](./observationSupport.md), [remote pairing](../remotePairing.md) |
| `scripts/stage-local-agent-runtime.ts`, `android/consumer-host.json`, `MainActivity.java` | Authenticated agent runtime, work directories, native system/camera/browser/location/secure storage/calendar/reminders/notification/media registration, packaged local speech and hardware eligibility. [Shared mobile contracts](../mobile.md) |
| `scripts/prepared-workflow-worker.ts`, `WorkflowWorkerAssets.java`, `apps/app/src/prototype/workflow-adapter.ts` | [Compiler and worker admission](../workflowWorker.md), [workflow intent review](../workflowIntents.md), [workflow lifecycle](../workflow.md) |
| `scripts/start-local-remote.ts`, `vendor/eliza/packages/agent/src/runtime/plugin-collector.ts` | Native mobile profile versus local development lean-chat profile, SQL, scheduler, browser and vision, assistant and plugin contributions |
| Overview, automation feed, and reminder presentation | [Daily overview](./overview.md), [automation and reminder projection](./automationPresentation.md) |
| Remote agent connection and pairing link | [Exact instance and revocable session admission](../remotePairing.md) |
| `scripts/native-google-product-host.ts`, `apps/app/src/prototype/inbox-cloud-adapter.ts`, `apps/app/src/runtime/google-connection-ui.tsx` | [Managed Google grant and receipt custody](./managedGoogle.md), [Calendar link publication and stale request custody](./googleCalendarLinkPublication.md), [Cloud host ownership](../cloudHost.md), [resident inference](../residentCloud.md), [credential enrollment](../cloudEnrollment.md) |
| `google-agent-access.ts`, `GoogleAgentAccessFile.java`, `AlphaLocalAgentPlugin.java`, `native-google-agent-host.ts` | [Google access settings publication](./googleAccessPublication.md), [native Google access file custody](./nativeGoogleAccessFile.md) |

The development launcher sets `ELIZA_PLUGIN_SET=lean-chat` and
`ELIZA_LEAN_CHAT_WORKFLOWS=1`. Native stages runtime profile `native`.
Native workflow admission depends on a vetted compiler/worker installation.
The collection still applies platform, configuration and credential gates.
Alpha's native view declarations describe its renderer fallbacks for Photos,
Maps, Camera, Notes, Calendar, and Inbox. They do not by themselves grant
an effect or prove an adapter is live. The native image gates Phone,
Messages and Contacts; Wallet is outside the release MVP. The reference
fixtures only appear in explicitly flagged development builds.

The pinned managed Gmail host reports marked partial body text above 32,000
UTF-16 units. The replacement returns an explicit oversize refusal at that
boundary and returns the complete body below it. [Managed Google read policy](./managedGoogle.md).

The state models cover the admission, ownership and receipt rules in
the table. Before declaring replacement parity, confirm the host
refinements against the same pinned consumers:

| Boundary | Remaining concrete evidence |
| --- | --- |
| Storage and authored text | Notes decoder, Android recording extraction and orphan cleanup, multi-row Trash contention, and format/parser parity; browser legacy archive arrays, same-binding peer draft queues, and Android secure slot recovery. |
| Files and captured sources | Archive payload decoders, replacement replay for scan storage and conversion, file-system ordering, native media callbacks, and Android grant behavior on device. |
| Calendar, Inbox and Home | Live Calendar reconciliation, physical Android recurring-series mutation, accessibility and rendered projection. |
| Maps, browser and launcher | Provider route geometry, live-location feeds and relay expiry, device WebView cookie and storage readback, launcher order, focus and lifecycle. |
| Notices and automation | Exact platform signal and notice owner composition, digest/archive data, and provider read projection; verify effects through the linked workflow and mobile owners. |

The [inventory](../alphaBaseline.json) includes these and other reachable
source leaves. A source reference or passing abstract proof does not count
as a platform refinement test.
