# Pixel 10a Sense composition

The Alpha and Eliza Pixel 10a product descriptors select one shared listener
implementation. Their main APKs remain nonprivileged. The only privileged app
is their separately signed Sense APK, with exactly CAPTURE_AUDIO_HOTWORD and
START_ACTIVITIES_FROM_BACKGROUND. RECORD_AUDIO and notifications require the
user's consent; no network, background-capture bypass, power exemption or
indicator-exempt role is granted.

`stage-pixel10a-product.ts` accepts `--listener-apk`, a reviewed
`--listener-descriptor` (packageName, apkSha256, certificateSha256), and
`--voice-host` (the caller's admitted voice-host record). Production requires all
three. Staging checks the same-signer package, exact permission set, aligned
stored JNI/DEX and recorded libelizainference / Phonon-2 payload. Development
may carry an unavailable speech bundle; the result records `speechIncluded:false`.

The generated SystemUI overlay binds the exact listener package, host package,
compatibility receiver class and admitted APK signer. The common chip verifies
primary-user identity, sole package ownership, platform audio attribution and
immutable pause-only PendingIntent ownership. Its visibility acknowledgement
cannot enable listening or carry audio/transcripts.

`sense-systemui.mjs` prepares a new overlay outside the source checkout, verifies
all listed preimages and postimages, and exports `senseSystemuiPatch()` for the
full Pixel source validator. Set `--applied-sense-patch` only when verifying a
build copy containing this exact patch. The older microphone-ops bundle remains
available as `senseSystemuiPatch('ops')`. Neither function writes the AOSP source.
The immutable 1,715,781-byte Pixel inventory is unchanged.

The patch is bound to frameworks/base 94b4c163b7dfe5ce3607f7bb8456f9573f7de57d.
Tests apply it to the three exact pinned original files and check all nine outputs.
Java fixtures exercise capture policy and SystemUI lease state, and the listener
compiles against Android 36. SystemUI Kotlin/resources have not been compiled;
these checks do not qualify a full tree, APK, image boot or device. All release
and device qualification flags remain false.
