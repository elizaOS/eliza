# Eliza os

The os package builds a branded Android device image, the Android host a
consumer ships, the native bridges that host uses, and the device's voice.
A consumer owns its product: the os package names none. A product is a
descriptor the consumer supplies over one pinned device profile, and every
artifact staged for it is bound to that descriptor.

| Area | Specifications |
| --- | --- |
| Image | [Product composition](./image/product.md), [source lock](./image/sourceLock.md), [launcher staging](./image/launcher.md), [release signing](./image/signing.md), [image capabilities](./image/capabilities.md) |
| Android host build | [Consumer host](./build/consumerHost.md), [consumer build](./build/consumerBuild.md), [manifest admission](./build/manifestAdmission.md), [source integrity](./build/sourceIntegrity.md) |
| Updates | [OS update channel](./update/channel.md), [system updater](./update/updater.md), [updater staging](./update/staging.md), [app update admission](./update/appAdmission.md), [app installation](./update/install.md), [WebView health](./update/uiHealth.md), [runtime health](./update/runtimeHealth.md), [automatic app update schedule](./update/appUpdateSchedule.md) |
| Android bridges | [Bridge composition](./android/bridge.md), [resident host](./android/residentHost.md), [system](./android/system.md), [launcher client](./android/launcher.md), [launcher inventory](./android/launcherInventory.md), [Wi-Fi](./android/wifi.md), [contacts](./android/contacts.md), [calendar provider](./android/calendarProvider.md), [calendar deletion](./android/calendarDeletion.md), [deferred deletion](./android/deferredDeletion.md), [camera](./android/camera.md), [document scan](./android/documentScan.md), [notification mirror](./android/notificationMirror.md), [notification projection](./android/notificationProjection.md), [mail background delivery](./android/mailBackgroundDelivery.md), [hosted result notices](./android/hostedResultNotices.md), [reminders](./android/reminders.md), [messages](./android/messages.md), [phone](./android/phone.md), [passwords](./android/passwords.md), [password autofill](./android/passwordAutofill.md), [location](./android/location.md), [network policy](./android/networkPolicy.md), [on-device vision](./android/vision.md) |
| Android files | [File mutation](./android/files/mutation.md), [read handoff](./android/files/readHandoff.md), [document grants](./android/files/documentGrants.md), [storage watch](./android/files/storageWatch.md) |
| Android media | [Media catalog](./android/media/catalog.md), [media review](./android/media/review.md), [albums](./android/media/albums.md), [trash](./android/media/trash.md), [photo copy](./android/media/photoCopy.md), [photo replace](./android/media/photoReplace.md), [permission epochs](./android/media/permissionEpochs.md), [video copy](./android/media/videoCopy.md), [video playback](./android/media/videoPlayback.md), [isolated PDF](./android/media/isolatedPdf.md), [PDF preview](./android/media/pdfPreview.md) |
| Browser | [External links](./browser/externalLinks.md), [browser storage](./browser/storage.md), [isolated reading](./browser/isolatedReading.md), [Chromium binding](./browser/chromiumBinding.md), [protection](./browser/protection.md), [command receiver](./browser/commandReceiver.md), [document custody](./browser/documentCustody.md), [session restore](./browser/sessionRestore.md), [reading source](./browser/readingSource.md), [surface lifecycle](./browser/surface/lifecycle.md), [page requests](./browser/surface/pageRequests.md), [bridge activity](./browser/surface/bridgeActivity.md) |
| Voice | [Wake](./voice/wake.md), [listener foreground](./voice/listenerForeground.md), [capture](./voice/capture.md), [playback](./voice/playback.md), [voice session](./voice/session.md), [endpointing](./voice/endpoint.md), [heard receipts](./voice/heardReceipts.md), [speech requests](./voice/speechRequest.md), [speech streams](./voice/speechStream.md), [local speech](./voice/localSpeech.md), [live session](./voice/liveSession.md), [cloud speech](./voice/cloudSpeech.md), [cloud speech lease](./voice/cloudSpeechLease.md), [cloud speech successor](./voice/cloudSpeechSuccessor.md), [voice session client](./voice/sessionClient.md), [voice timing](./voice/timing.md), [native capture](./voice/nativeCapture.md), [microphone slot](./voice/microphoneSlot.md), [microphone handoff](./voice/microphoneHandoff.md), [microphone samples](./voice/microphoneSamples.md), [recorded transcription](./voice/recordedTranscription.md), [segment playback](./voice/segmentPlayback.md) |

## Story: Build a branded image from a consumer-owned descriptor

> As a consumer, I want to build my branded Android image from the os
> package by handing it a descriptor of my product, so that the os package
> serves any product without knowing mine, and nothing unreviewed or
> half-configured reaches a production image.

### A product is a consumer descriptor over one pinned device profile

The descriptor names the consumer's vendor directory, product name,
launcher package, wake listener package, whether the system updater is
included, and the device and source profiles it builds on. The os package
supplies the device and source profiles; the consumer supplies every
product field.

```quint
type ProductDescriptor = {
  vendorDirectory: str, productName: str, launcherPackage: str, listenerPackage: str,
  systemUpdater: bool, deviceProfile: str, sourceProfile: str
}
pure def onPinnedProfile(d: ProductDescriptor, profiles: Set[str]): bool = profiles.contains(d.deviceProfile) and d.sourceProfile != ""
pure val exampleDescriptor: ProductDescriptor = {
  vendorDirectory: "vendor/acme", productName: "acme_phone", launcherPackage: "com.acme.home",
  listenerPackage: "com.acme.listener", systemUpdater: false, deviceProfile: "phone", sourceProfile: "phone-source"
}
pure val dValues = Set(exampleDescriptor, { ...exampleDescriptor, deviceProfile: "other" },
  { ...exampleDescriptor, productName: "UNSET" }, { ...exampleDescriptor, launcherPackage: "" },
  { ...exampleDescriptor, sourceProfile: "" })
pure val profilesValues = Set(Set("phone"), Set("phone", "virtual"), Set())
pure def lawUnadmittedProfileIsRefused(d: ProductDescriptor, profiles: Set[str]): bool =
  (not(profiles.contains(d.deviceProfile)) or d.sourceProfile == "") implies not(onPinnedProfile(d, profiles))
```

### Production staging refuses an unset or placeholder identity field

An empty value or the literal placeholder `UNSET` in any identity field of
the descriptor refuses production staging. A development build may stage
a descriptor with placeholders; a production one never does.

```quint
pure def placeholder(value: str): bool = value == "" or value == "UNSET"
pure def identityComplete(d: ProductDescriptor): bool =
  not(placeholder(d.vendorDirectory)) and not(placeholder(d.productName)) and not(placeholder(d.launcherPackage)) and
  not(placeholder(d.listenerPackage)) and not(placeholder(d.deviceProfile)) and not(placeholder(d.sourceProfile))
pure def productionStagingAdmitted(d: ProductDescriptor, profiles: Set[str]): bool = identityComplete(d) and onPinnedProfile(d, profiles)
pure def lawProductionRefusesPlaceholders(d: ProductDescriptor, profiles: Set[str]): bool =
  productionStagingAdmitted(d, profiles) implies not(placeholder(d.productName)) and not(placeholder(d.launcherPackage)) and
    not(placeholder(d.vendorDirectory)) and not(placeholder(d.listenerPackage))
```

### Every staged artifact is bound to the descriptor digest

Each artifact staged for a product records the digest of the descriptor
it was staged from. A staging set mixing artifacts of two descriptors, or
holding one with no descriptor digest, is refused.

```quint
type StagedArtifact = { path: str, descriptorDigest: str }
pure def stagedForDescriptor(digest: str, artifacts: List[StagedArtifact]): bool =
  digest != "" and artifacts.select(a => a.descriptorDigest != digest).length() == 0
pure val artifactsValues = Set(List(), List({ path: "launcher", descriptorDigest: "d1" }),
  List({ path: "launcher", descriptorDigest: "d1" }, { path: "listener", descriptorDigest: "d2" }),
  List({ path: "updater", descriptorDigest: "" }))
pure val digestValues = Set("", "d1", "d2")
pure def lawStagedArtifactsShareTheDescriptor(digest: str, artifacts: List[StagedArtifact]): bool =
  stagedForDescriptor(digest, artifacts) implies
    artifacts.foldl(true, (ok, a) => ok and a.descriptorDigest == digest and a.descriptorDigest != "")
```
