# Android App Bundle fixture

`install-time-permanent-modules.aab` is the multi-module test bundle from
Google's bundletool repository:

<https://github.com/google/bundletool/blob/master/src/test/resources/com/android/tools/build/bundletool/testdata/bundle/install-time-permanent-modules.aab>

It is covered by that repository's Apache-2.0 license. The copied fixture is
kept byte-identical to upstream:

- Git blob: `85054814c86d7cbef9721bcdfa485bf2c0902bf0`
- SHA-256: `83d7d10b6036da2f94ad34483a5c3d5a32891b08e4fd1a658165c55258bdaff2`
- Modules: `base`, `assets`, `initialInstall`, `java`

The opt-in real-AAB test runs bundletool itself against this fixture, exercises
a known dynamic-feature component as forbidden policy input, and checks copied
bundles with a feature-DEX marker or truncated bytes. The default unit lane
stays network- and JDK-independent; set
`ELIZA_ANDROID_RUN_REAL_AAB_TEST=1`, `ELIZA_ANDROID_BUNDLETOOL_JAR`, and
`JAVA_HOME` to run the real tool boundary.
