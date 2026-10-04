# @elizaos/capacitor-secure-store

Device-only Apple Keychain and Android Keystore storage for Eliza app credentials.

Install workspace dependencies with `bun install` at the repository root.

Build from the repository root:

```bash
bun run --cwd plugins/plugin-native-secure-store build
```

Native storage behavior requires testing on the target Apple or Android device.

Android's device suite verifies the real WebView/Capacitor/Keystore round trip,
activity recreation, ciphertext persistence, deletion, and invalid/corrupt input:

```bash
node packages/app/scripts/android-native-plugins.ts --serial emulator-5554 --plugin plugin-native-secure-store
```

Android bridge instances serialize Keystore key creation and AtomicFile operations
within one process. Recovery includes backup-only values; removal checks base,
backup and pending writes. The existing ciphertext format and account binding
remain compatible. Keystore availability does not assert StrongBox protection.
Device tests use synthetic credentials in an isolated UID and cover complete
262,144-byte values, backup recovery, corruption and concurrent cold key creation.
Inspect the terminal instrumentation result, not only the shell exit status.

The Android `nativeonly` package provides host-configured password custody,
credential persistence, exact-origin autofill validation and one-shot sessions.
These are native APIs; they are not registered Capacitor methods. Hosts retain
picker UI, signer trust, permission declarations and release/debug policy, and
must preserve deployed aliases, AAD and filenames when adopting them. Custody
uses Android API 26+; browser structure parsing requires API 28+. Production
password keys must require device authentication. The unauthenticated constructor
mode is only for host-restricted synthetic tests. Autofill metadata key strings
retain their existing browser wire protocol identifiers.
