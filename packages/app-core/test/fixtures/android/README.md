# Android App Bundle fixture

`install-time-permanent-modules.aab` is the multi-module test bundle from
Google's bundletool repository:

<https://github.com/google/bundletool/blob/8c3b87044bd114707bbcec70bcb407494f494a9c/src/test/resources/com/android/tools/build/bundletool/testdata/bundle/install-time-permanent-modules.aab>

It is covered by that repository's Apache-2.0 license. The repository carries
the complete license text at
[`packages/os/linux/LICENSES/Apache-2.0.txt`](../../../../os/linux/LICENSES/Apache-2.0.txt).
The copied fixture is kept byte-identical to upstream:

- Upstream commit: `8c3b87044bd114707bbcec70bcb407494f494a9c`
- Git blob: `85054814c86d7cbef9721bcdfa485bf2c0902bf0`
- SHA-256: `83d7d10b6036da2f94ad34483a5c3d5a32891b08e4fd1a658165c55258bdaff2`
- Modules: `base`, `assets`, `initialInstall`, `java`

The opt-in real-AAB test runs bundletool itself against this fixture, exercises
a known dynamic-feature component as forbidden policy input, and checks copied
bundles with adversarial feature manifests, relocated feature-DEX classes,
feature-DEX markers, or truncated bytes. `RelocateAndroidManifestFixture.java`
uses bundletool's own generated AAPT protobuf classes to turn the fixture's
feature activity into a relocated privileged service while preserving a
bundletool-valid multi-module AAB. The default unit lane stays network- and
JDK-independent; set
`ELIZA_ANDROID_RUN_REAL_AAB_TEST=1`, `ELIZA_ANDROID_BUNDLETOOL_JAR`, and
`JAVA_HOME` to run the real tool boundary.
