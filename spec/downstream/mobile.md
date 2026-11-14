# Mobile platform contracts used by AlphaPhone and Grace

This area follows the two vendored Eliza pins. Grace consumes
`7743504b7c936a764b3938a44cad918808b621df` and AlphaPhone consumes
`c518127a025ab173874af9c7d304f26b25213b0d`. The consumer source was examined
at Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` and AlphaPhone
`8d44dfe52b0a6e2f3462b5da85dd3f8037518f43`. Local tracked vendor trees
matched their pins. Alpha stages selected native modules through its own source manifest.
The examined consumer pin lists no patches in
`android/upstream-native-sources.json`.

| Consumer use | Contract owner |
| --- | --- |
| Grace local paired runtime and credential broker. | [Runtime authority](./mobileRuntime.md), [paired startup](./mobileStartup.md), and [credential broker](./mobileBroker.md) |
| Alpha resident host and authenticated agent endpoint. | [Resident adoption and shutdown](./mobileResident.md), [credential stop lease](./mobileCredential.md), [notification projection](./mobileNotification.md), and [watchdog](./mobileWatchdog.md) |
| Alpha local and paired speech requests. Grace streaming speech transport. | [Speech binding](./mobileSpeech.md), [voice capture](./mobileCapture.md), [playback receipts](./mobilePlayback.md), [Grace speech stream](./mobileSpeechStream.md), and [on-device speech](./mobileLocalSpeech.md) |
| Device actions reviewed on a foreground screen. | [Device action claim and receipt](./mobileDeviceExecution.md), [foreground device reviews](./mobileDeviceReview.md), and [Photos and library receipts](./mobileDevicePhotos.md) |
| Grace updater and the upstream trust AAR. | [OTA admission](./mobileOta.md) and [installation journal](./mobileInstall.md) |
| Android packaging, explicit bridge registration, feature and permission admission. | [Consumer build and artifact custody](./mobileBuild.md), [Native bridge composition](./mobileBridge.md), [browser handoff](./mobileBrowser.md), [Chromium binding](./mobileChromium.md), [file observer custody](./mobileStorageWatch.md), [calendar edits](./mobileCalendar.md), [photo read permission](./mobilePhotos.md), [message review](./mobileTelephony.md), and [camera receipt](./mobileDeviceCamera.md) |

Paths in the individual models are relative to the named consumer or its
vendored Eliza root. Android processes, native permission grants, trust
verification, and cryptographic evidence come from VibeLang Effect ports.
The models describe the authority these ports must establish and the
state transitions their results may cause.
