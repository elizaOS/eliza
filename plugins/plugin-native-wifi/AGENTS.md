# @elizaos/plugin-native-wifi

Android-only overlay app that lets an Eliza agent scan, inspect, and connect to nearby Wi-Fi networks.

Build, test, and setup: [README.md](README.md).

Android 10+ connection success means an Internet network suggestion was accepted,
not that association completed. Do not create a second local-only peer request or
retain network callbacks. Connection security comes from Android security type
or a matching scan result; unavailable security rejects rather than reporting open.
