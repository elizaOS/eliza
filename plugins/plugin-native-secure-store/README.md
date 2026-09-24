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
node packages/app/scripts/android-native-plugins.mjs --serial emulator-5554 --plugin plugin-native-secure-store
```
