# Android device

The os package is everything Android-native that Eliza ships to a device:
the agent service that runs the owner's agent, the device half of sign-in
and credential custody, the native bridges, the wake listener, the system
and app updaters, the first-run provisioner and the image overlays. It also
holds the library that builds the device image and the Android host APK, and
the browser with its owned Chromium build and the app-update trust slice. A
consumer owns its product: the os package names none, and takes the
consumer's descriptor over one pinned device profile.

A consumer owns its own interface (its mobile shell, view primitives and
screen focus handling). It owns its own Android test harness beyond the
single-device lease, instrumentation result, isolated test user and fixture
observation and reboot of `image/device`, such as hosted fixtures for a CI
emulator display and WebView provisioning. It owns its own desktop builds,
with their library staging and symbol checks. The os package specifies none
of them.

| Area | Specifications |
| --- | --- |
| Agent service | [Agent channel](./agentService/channel.md), [agent health verdicts](./agentService/health.md) |
| Sign-in | [Device credential](./signIn/credential.md), [sign-in readiness](./signIn/readiness.md) |
| Android bridges | [Bridge vocabulary](./android/bridge.md), [system surfaces](./android/system.md), [home launcher](./android/home.md), [links and alerts](./android/deepLinks.md), [secure store](./android/secureStore.md), [device calendar](./android/calendar.md), [deletion window](./android/deletionWindow.md), [deferred deletion](./android/deferredDeletion.md), [contacts](./android/contacts.md), [keyset paging](./android/paging.md), [camera](./android/camera.md), [phone](./android/phone.md), [visual voicemail](./android/voicemail.md), [notification mirror](./android/notificationMirror.md) |
| Files | [Storage and trash custody](./android/files/storage.md), [storage watch](./android/files/storageWatch.md), [read-only handoff](./android/files/handoff.md), [document grants](./android/files/documentGrants.md) |
| Media | [Tokens and row writes](./android/media/rows.md), [photos catalog](./android/media/catalog.md), [media review](./android/media/review.md), [owned trash](./android/media/trash.md), [albums](./android/media/albums.md), [edit copies](./android/media/editCopy.md), [photo replacement](./android/media/photoReplace.md), [video playback](./android/media/videoPlayback.md), [isolated PDF](./android/media/isolatedPdf.md) |
| Passwords | [Vault page](./android/passwords/vault.md), [autofill](./android/passwords/autofill.md) |
| Browser | [Address](./browser/address.md), [surface lifecycle](./browser/surface/lifecycle.md), [surface profiles](./browser/surface/profiles.md), [tab storage](./browser/tabHost/storage.md), [page reading](./browser/tabHost/reading.md), [page commands](./browser/pageCommands.md), [owned Chromium](./browser/chromium.md), [protection](./browser/protection.md) |
| Image | [Source lock](./image/sourceLock.md), [APK admission](./image/apk.md), [image provisioning](./image/provisioning.md), [device qualification](./image/qualification.md) |
| Android host build | [Source integrity](./build/sourceIntegrity.md), [runtime payload](./build/runtimePayload.md) |
| Updates | [System updater](./update/updater.md) |
| App updates | [Trust and publication authorization](./appUpdate/admission.md), [installation journal](./appUpdate/install.md), [update health](./appUpdate/health.md) |
| Voice | [Listening indicator lease](./voice/indicatorLease.md), [invocation](./voice/invocation.md), [microphone](./voice/microphone.md), [speech output](./voice/speechOutput.md) |
