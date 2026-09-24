# Native secure store

`@elizaos/capacitor-secure-store` exposes `get`, `set`, `remove`, and `status`
for the fixed account names in `src/definitions.ts`. Web use reports unavailable;
it never substitutes browser storage for native credential storage.

Android encrypts complete values with an Android Keystore AES-GCM key and binds
each ciphertext to its logical account name. Ciphertexts live in the app's
no-backup directory. Non-empty values may contain up to 262,144 UTF-8 bytes;
larger values are rejected without replacing the existing value. Native errors
return sanitized structured results rather than exception text.

Android bridge instances in the same process serialize key creation and file
operations. This is not a cross-process locking contract. AtomicFile recovery
includes legacy backup-only values, and removal checks base, backup, and pending
write artifacts. The wire format and existing Keystore alias remain compatible.
Keystore availability does not assert hardware-backed or StrongBox protection.

## Verification

Run `bun run test`, `bun run typecheck`, and `bun run lint:check` in this package.
The Android host includes the native test target:

```bash
JAVA_HOME=/usr/lib/jvm/java-21-openjdk ANDROID_HOME="$HOME/Android/Sdk" \
  ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1 \
  ../../packages/app-core/platforms/android/gradlew \
  -p ../../packages/app-core/platforms/android \
  :elizaos-capacitor-secure-store:assembleDebugAndroidTest -PelizaAospBuild=true
adb install -r android/build/outputs/apk/androidTest/debug/elizaos-capacitor-secure-store-debug-androidTest.apk
adb shell am instrument -w ai.eliza.plugins.securestore.test/androidx.test.runner.AndroidJUnitRunner
```

Choose the intended device with `adb -s` when multiple devices are attached.
The isolated test UID uses synthetic values, real Android Keystore, real files,
and real Capacitor bridge instances. Tests cover full-size Unicode persistence,
activity recreation, backup recovery/removal, randomized ciphertext, account
binding, malformed input, and concurrent cold key creation. Inspect the runner's
`OK` result; the shell exit code alone does not prove instrumentation passed.
These tests do not establish physical-device hardware protection or cross-process
access. The debug inference opt-out is a test build setting, not a release image.
