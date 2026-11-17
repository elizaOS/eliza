# Eliza os

The os package builds a branded Android device image, the Android host a
consumer ships, the native bridges that host uses, and the device's voice.
A consumer owns its product: the os package names none, and
[product composition](./image/product.md) takes the consumer's descriptor
over one pinned device profile.

Everything a consumer uses from Eliza on the device is specified here:
the scripts that generate, build and stage a consumer's Android host are
the [consumer host](./build/consumerHost.md),
[consumer build](./build/consumerBuild.md) and
[source integrity](./build/sourceIntegrity.md); the device's local speech
routes and services are [local speech](./voice/localSpeech.md) and the
rest of the voice area. A consumer owns its own interface (its mobile
shell, view primitives and screen focus handling), its Android test
harness (isolated test users, device leases, instrumentation results and
fixture observation and reboot) and any desktop library staging or symbol
checks for its own builds; the os package specifies none of them.

| Area | Specifications |
| --- | --- |
| Image | [Product composition](./image/product.md), [source lock](./image/sourceLock.md), [launcher staging](./image/launcher.md), [release signing](./image/signing.md), [image capabilities](./image/capabilities.md) |
| Android host build | [Consumer host](./build/consumerHost.md), [consumer build](./build/consumerBuild.md), [manifest admission](./build/manifestAdmission.md), [source integrity](./build/sourceIntegrity.md), [bundle inventory](./build/bundleInventory.md) |
| Updates | [OS update channel](./update/channel.md), [system updater](./update/updater.md), [app update admission](./update/appAdmission.md), [app installation](./update/install.md), [installed data readback](./update/installedDataReadback.md), [WebView health](./update/uiHealth.md), [runtime health](./update/runtimeHealth.md), [automatic app update schedule](./update/appUpdateSchedule.md) |
| Android bridges | [Bridge composition](./android/bridge.md), [system](./android/system.md), [launcher](./android/launcher.md), [Wi-Fi](./android/wifi.md), [contacts](./android/contacts.md), [calendar provider](./android/calendarProvider.md), [calendar deletion](./android/calendarDeletion.md), [deferred deletion](./android/deferredDeletion.md), [camera](./android/camera.md), [notification mirror](./android/notificationMirror.md), [notification projection](./android/notificationProjection.md), [mail background delivery](./android/mailBackgroundDelivery.md), [hosted result notices](./android/hostedResultNotices.md), [reminders](./android/reminders.md), [messages](./android/messages.md), [phone](./android/phone.md), [passwords](./android/passwords.md), [password autofill](./android/passwordAutofill.md), [location](./android/location.md), [network policy](./android/networkPolicy.md) |
| Android files | [File mutation](./android/files/mutation.md), [read handoff](./android/files/readHandoff.md), [document grants](./android/files/documentGrants.md), [storage watch](./android/files/storageWatch.md) |
| Android media | [Media catalog](./android/media/catalog.md), [media review](./android/media/review.md), [albums](./android/media/albums.md), [trash](./android/media/trash.md), [photo copy](./android/media/photoCopy.md), [photo replace](./android/media/photoReplace.md), [permission epochs](./android/media/permissionEpochs.md), [video copy](./android/media/videoCopy.md), [video playback](./android/media/videoPlayback.md), [isolated PDF](./android/media/isolatedPdf.md), [PDF preview](./android/media/pdfPreview.md) |
| Browser | [Browser storage](./browser/storage.md), [session restore](./browser/sessionRestore.md), [document custody](./browser/documentCustody.md), [page reading](./browser/reading.md), [Chromium binding](./browser/chromiumBinding.md), [protection](./browser/protection.md), [command receiver](./browser/commandReceiver.md), [surface lifecycle](./browser/surface/lifecycle.md), [page requests](./browser/surface/pageRequests.md) |
| Voice | [Wake](./voice/wake.md), [listener foreground](./voice/listenerForeground.md), [capture](./voice/capture.md), [playback](./voice/playback.md), [endpointing](./voice/endpoint.md), [heard receipts](./voice/heardReceipts.md), [speech requests and streams](./voice/speechStream.md), [local speech](./voice/localSpeech.md), [live session](./voice/liveSession.md), [cloud speech](./voice/cloudSpeech.md), [cloud speech lease](./voice/cloudSpeechLease.md), [cloud speech successor](./voice/cloudSpeechSuccessor.md), [voice session client](./voice/sessionClient.md), [voice timing](./voice/timing.md), [on-device microphone ownership](./voice/microphoneSlot.md), [microphone samples](./voice/microphoneSamples.md), [recorded transcription](./voice/recordedTranscription.md), [segment playback](./voice/segmentPlayback.md) |
