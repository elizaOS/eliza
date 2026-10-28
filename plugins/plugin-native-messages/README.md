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

## Default SMS app (SMS role)

A host that can hold the SMS role declares thin subclasses of
`SmsDeliverReceiver` (BROADCAST_SMS), `MmsWapPushReceiver` (BROADCAST_WAP_PUSH,
`application/vnd.wap.mms-message`), `MmsResultReceiver` (not exported),
`RespondViaMessageService` (SEND_RESPOND_VIA_MESSAGE) and `SmsComposeActivity`
(SENDTO `sms`/`smsto`), and `MmsFileProvider` (not exported,
`grantUriPermissions`), named by an `SmsRoleConfiguration`.

- Incoming SMS is stored in the provider before its notice. There is one notice
  per conversation; a newer message replaces it. The lock screen shows only
  "New message"; unlocked, the title is the sender's contact name when the host
  may read contacts, otherwise the number.
- An MMS notification starts one download into a private file. The retrieved
  message (`MmsPdu` parses M-Retrieve.conf) is stored with its addresses and
  parts, then answered with M-NotifyResp.ind. A stored transaction is never
  stored twice; a repeated notification is answered with M-NotifyResp.ind again
  so the carrier stops repeating it. A half-written message is removed.
- Read state is the default SMS app's to keep. `markThreadRead` marks a
  conversation's received SMS and MMS read and seen up to the newest message on
  screen and removes its notice; later messages stay unread. Android accepts
  the write only from the role holder, so elsewhere it changes nothing.
- Quick replies from call screens open the compose review; nothing is sent from
  the service. The compose screen is the review: its Send press uses the same
  journal and operation-ID rules as `TelephonyPlugin.sendSms`.
- Android writes sent texts to the provider for every app except the default
  SMS app. While the host holds the role, each reviewed send stores its
  recipient's message in the outbox just before the SmsManager call, and that
  recipient's sent callbacks move it to sent or failed. A refused write never
  blocks or repeats the send. Delivery is not claimed for these rows: an
  immutable delivery callback carries no status report.

`MmsPdu` encodes M-Send.req, M-NotifyResp.ind and M-Acknowledge.ind. Outgoing
user MMS (group messages and attachments) is not offered yet. Carrier MMSC
behaviour, APN settings and real role grants need device qualification.
