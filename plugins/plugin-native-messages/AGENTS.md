# @elizaos/plugin-native-messages

Android SMS overlay plugin for elizaOS — provides an SMS inbox and compose surface backed by the native `@elizaos/plugin-native-messages/bridge` bridge.

Build, test, and setup: [README.md](README.md).

Reads preserve complete SMS bodies and have no implicit result cap; only an
explicit positive safe-integer limit bounds results. Outbound requests own their
receivers, deadline and teardown settlement. A timeout means unknown send status
and must not trigger an automatic resend. Only the default SMS app persists sent
rows; other apps leave platform-owned persistence alone.
