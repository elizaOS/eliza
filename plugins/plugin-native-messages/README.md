# @elizaos/plugin-native-messages

Android SMS overlay plugin for elizaOS — provides an SMS inbox and compose surface
backed by the native `@elizaos/plugin-native-messages/bridge` bridge.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-messages build  # build
bun run --cwd plugins/plugin-native-messages test   # tests
```

The package-owned root TypeScript configuration covers its React view and
native bridge. Production output uses `tsconfig.build.json`.

Native view and app-shell declarations share an ADMIN-gated capability catalog. Agents use named complete-or-error reads; mutations and generic renderer/DOM operations require human interaction. A bridge result at its non-paginated boundary is an explicit incomplete-read error. Device-status failures remain errors rather than fabricated empty state.

Reads preserve complete SMS bodies and have no implicit result cap; only an
explicit positive safe-integer limit bounds results. Outbound requests own their
receivers, deadline and teardown settlement. A timeout means unknown send status
and must not trigger an automatic resend. Only the default SMS app persists sent
rows; other apps leave platform-owned persistence alone.

## Android modem verification

`node packages/app/scripts/android-native-sms.mjs --sender emulator-5580 --receiver emulator-5582`
leases two isolated stock emulators, sends through the real WebView bridge, checks
the sent-row receipt and received content, then removes its messages and APKs.
Set each emulator's `-phone-number` to `1555521` followed by its console port.
Peer routing must work in the installed emulator; a missing receipt or delivery fails.
Use `--sender emulator-5580 --loopback` explicitly for a separate modem-loopback
proof; add `--multipart` to verify a long Unicode message including its trailing
newline. Reports under `test-results/android-native-sms/` identify the transport;
loopback does not prove peer or carrier delivery. Device E2E runs both single-part
and multipart modem loopback and uploads the reports and provider receipts.
