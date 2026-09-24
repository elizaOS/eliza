# @elizaos/capacitor-secure-store

Native credential storage using Android Keystore and Apple Keychain.

Android verification exercises WebView/Capacitor/Keystore round trips, activity
recreation, ciphertext persistence, deletion, and invalid/corrupt input:

```bash
node packages/app/scripts/android-native-plugins.mjs --serial emulator-5554 --plugin plugin-native-secure-store
```
