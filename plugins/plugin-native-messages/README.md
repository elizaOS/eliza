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

`node packages/app/scripts/android-native-sms.ts --sender emulator-5580 --receiver emulator-5582`
leases two isolated stock emulators, sends through the real WebView bridge, checks
the sent-row receipt and received content, then removes its messages and APKs.
Set each emulator's `-phone-number` to `1555521` followed by its console port.
Peer routing must work in the installed emulator; a missing receipt or delivery fails.
Use `--sender emulator-5580 --loopback` explicitly for a separate modem-loopback
proof; add `--multipart` to verify a long Unicode message including its trailing
newline. Reports under `test-results/android-native-sms/` identify the transport;
loopback does not prove peer or carrier delivery. Device E2E runs both single-part
and multipart modem loopback and uploads the reports and provider receipts.

## AOSP telephony profile (reviewed sends)

Product AOSP images use the reviewed core instead of `sendSms(address, body)`.
The host subclasses `ai.eliza.plugins.messages.TelephonyPlugin` under its own
plugin name with a `SmsTelephonyConfiguration`, and registers it only when its
native admission proves the install is its image. Renderers use
`createTelephonyClient` from `@elizaos/contracts/native-telephony`.

- Reads: bounded thread and message pages (SMS and MMS merged, stable
  `thread:`/`sms:`/`mms:` IDs and cursors), active SIMs, roles and default apps.
  Reads are cancelled on background, lock, screen-off and permission change, and
  checked again before the result is published.
- Sends: the host's native dialog shows the exact recipients, SIM, part count
  and text. `SmsSendJournal` records the send before the first SmsManager call.
  The operation ID is the `sms.send.v1` idempotency key; a repeat only reads the
  record. "sent" needs every RESULT_OK sent callback, and "delivered" needs a
  complete provider status after a delivery report. Interrupted or restarted
  sends read "unknown". Nothing is resent automatically, and bodies are never
  stored.
- Host identity: the journal slot, legacy plaintext file, retired-ID namespace,
  callback actions, data scheme and receiver are migration-sensitive. A host
  keeps the values it already shipped.

`android/src/test` holds JVM tests for the journal, cursor and provider mapping.
Real SIMs, carrier delivery reports and role grants need device qualification.
