# Shared Sense listener

Both Pixel 10a products build this separate, image-only APK. `consumer.gradle`
reads the selected product's `sense` data: host package, assist component,
component namespace, label, wake names and preference name. The Eliza Gradle
host includes `:sense` and `:sense-speech`; neither is a dependency of `:app`.
Alpha applies the same consumer with its existing component wrappers.

The implementation owns one AudioRecord and uses the canonical
`plugin-local-inference` VoiceAssets / NativeAsr API for Phonon-2. It has no
network permission, platform recognizer, cloud fallback or second inference
engine. Its separate APK packages the same reviewed libelizainference and
voice bundle through the canonical speech consumer. Prepare the native bundle
with `packages/app/scripts/paradee-voice/build-native.ts`; `ELIZA_SENSE_NATIVE_DIR`
can select an existing hash-recorded output for Eliza's `:sense-speech`.

Explicit Eliza build: `packages/app/platforms/android/gradlew -p
packages/app/platforms/android :sense:assembleRelease`. Both launchers and Sense
must use the same release signer. Signing configuration accepts the existing
all-or-none ELIZAOS_KEYSTORE_* variables; it never discovers credentials.

Microphone consent is local to this APK. Pause/stop invalidate queued recognition,
cancel native ASR, release capture and erase buffers. Calls, other recorders,
non-primary users, first unlock, hidden notifications and loss of SystemUI's
independent visibility lease keep capture off. An unexplained lost lease stays
off until the user resumes. Wake invocation carries no speech content and only
opens the same-signer host while unlocked. Playback suppresses wake detection.

Alpha's compatibility classes retain its existing public component names and
`listener-settings` preference file. The state machine, providers, consent UI and
capture code remain here. Control providers cannot enable/resume listening;
SystemUI can acknowledge visibility and use the authenticated immutable Pause
PendingIntent only.

Run `node --test packages/app/test/android/sense.test.mjs`. JVM and Android-jar
compilation checks do not prove Android execution. The shared SystemUI patch,
real signed APK packaging, image boot, displayed indicators, lock/AOD behavior,
interactive microphone handoff and physical Pixel 10a acceptance remain separate.
