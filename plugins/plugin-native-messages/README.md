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

`bun packages/app/scripts/android-native-sms.ts --sender emulator-5580 --receiver emulator-5582`
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
native admission proves the install is its image. `ImageCapability` is that
admission for hosts staged with `packages/os/scripts/android/image-capability.mjs`:
a release, non-test-mocks launcher build installed from a system partition,
the host's product-overlay provisioning boolean (presigned hosts) and the
image feature `<package>.aosp_image`. Every fact is required; the launcher
flavor or HOME role alone never admits. Renderers use
`createTelephonyClient` from `@elizaos/contracts/native-telephony`.
A Messages surface keeps provider content only while it is in the foreground
with `createSmsSession` from `@elizaos/contracts/native-telephony-session`
(late answers from an earlier visit are dropped, a failed read is never shown
as empty, and the SMS role holder marks an opened conversation read through the
newest shown message); its receipt labels never claim more than a result proves.

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

- Reviewed MMS (`mms.send.v1`, `@elizaos/contracts/mms-send`): one message to
  every recipient (a group conversation) with optional text and up to five
  JPEG/PNG/GIF attachments. The binding covers the text and each attachment's
  type, name, SHA-256 and size; the native side recomputes them from the bytes
  before review, and the dialog shows recipients, SIM, attachment previews and
  text. MMS records share the journal and its operation-ID space; nothing but
  hashes is stored. It needs the SMS role (Android stores nothing a default SMS
  app sends), the host's `MmsFileProvider` named through
  `SmsTelephonyConfiguration.withMmsFiles(authority)`, and an MMS-enabled
  carrier; a PDU over the carrier's size limit is refused before review.
  "sent" is the carrier's send confirmation (M-Send.conf Ok); MMS delivery is
  never claimed. `status().mmsSend` reports whether the path is available.

## Host-native reviewed send (`ReviewedSmsSend`)

A host's own native components (a review screen for a drafted reply, a
call-screen quick reply) send one `sms.send.v1` operation with
`ReviewedSmsSend.send(context, host, operationId, recipients, body,
subscriptionId, callback)`. It reviews nothing itself: the caller is the
review and calls it only after the owner's decision. It uses the same journal
rules as the telephony profile. The send is recorded before the first
SmsManager call and bound to the exact recipients, text and SIM. A repeated
operation ID only reads its record, so a second Send press, a retried worker or
a redelivered intent never sends twice. Sent receipts are package-private
one-shot PendingIntents held in process (`SmsSendRequest`). "sent" needs every
part's RESULT_OK receipt, and a receipt missing after
`RECEIPT_TIMEOUT_MS`, or lost with the process, reads "unknown" and is never
retried. Delivery is not requested. While the host is the default SMS app it
stores each recipient's outbox row before the platform call and the receipts
settle it; hosts never write sent-box rows themselves. `ReviewedSmsSend.Host`
names the host's encrypted journal slot and retired-ID namespace; keep them once
shipped, and do not share the slot with a `SmsTelephonyConfiguration`. No AOSP
admission or manifest receiver is needed.

`android/src/test` holds JVM tests for the journal (SMS and MMS records), cursor,
provider mapping, the host-native reviewed send (`ReviewedSmsSendCoreTest`,
with a fake radio), the voicemail store against a fake provider, the WAV
header and resampling of `VoicemailPcm`, and the visual-voicemail client
(`vvm/`: SMS parsing, the IMAP client against an in-process server, the
reconcile against a fake provider, and the controller with a fake radio).
Real SIMs, carrier delivery reports, role grants, placed calls, carrier
voicemail and the MediaCodec decode need device qualification.

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

Recent calls are optional. A host that declares the `callLog` permission alias
(and `READ_CALL_LOG` in its own manifest; this library does not declare it)
gets `listRecentCalls({limit})`: at most 50 newest rows, read only while the
phone is unlocked and the host is in front, under the same cancel-and-fence
rules as SMS reads. Numbers are reduced to the dial shape (`CallLogRows`);
withheld or undialable entries become `""`, and voicemail transcriptions,
accounts and locations are not read. `status().permissions.callLog` is present
only for such hosts, and access is asked for only through
`requestAccess({access: "callLog"})`. Without the alias the read answers
unavailable, never an empty list.

Phone information. `phoneInfo()` answers `{access, lines}` for a Settings
page (`PhoneInfoReader`): at most 4 active SIM lines ordered by slot, each
with its names, own number, country, network generation, roaming, signal
level, eSIM flag, ICCID and the slot's IMEI. It asks for nothing and never
fails because one field is refused: `access.phoneState` false means the SIM
list was not read (`lines` is empty, which is not "no SIM"),
`access.phoneNumbers` false means every `number` is null, and
`access.deviceIdentifiers` false means every `iccid` and `imei` is null.
Android grants identifiers only to privileged apps, carrier-privileged apps
and device or profile owners; this library never requests or logs them.

Calls. `dial` is a handoff: the person places the call on the dial screen.
`placeCall({number})` asks Telecom for the call itself, only while the host
holds the dialer role and `CALL_PHONE` and is unlocked in front. It answers
`placed` (Telecom accepted the request; nothing is known about the call),
`busy` (a call is already ringing or in progress), `unavailable` or `failed`.
An emergency number, or one Android cannot classify, is never placed from
here: the dial screen opens with it and the answer is `emergency-handoff`.
A host that ships `plugin-native-phone` may override `originate` with its
`TelecomDial.originate`.

Voicemail. While the host is the default dialer, `VoicemailStore` reads
Android's voicemail provider (`VoicemailContract`) under the same fence:
`voicemailStatus()`, `listVoicemail({limit})` (at most 50, newest first),
`fetchVoicemailAudio({id})`, `voicemailAudio({id})` (the stored bytes, at
most 8 MiB), `voicemailPcm({id})`, `markVoicemailHeard({id})`,
`deleteVoicemail({id})` and `observeVoicemail({enabled})` with content-free
`voicemailChanged` notices. The carrier state comes from the sources' status
rows for the default calling account; with no source it is `unsupported` and
the list is empty with that state, never an error or a bare empty list.
Caller names come from the call log and only for hosts with call-log access.
`VoicemailPcm` decodes stored audio (usually AMR or 3GPP) with MediaExtractor
and MediaCodec to a 16 kHz mono PCM16 WAV for on-device transcription; audio
over five minutes is refused. The provider holds only what a visual-voicemail
source on the phone stored; the client below is such a source for hosts that
declare it. `markVoicemailHeard` marks the row dirty, and `deleteVoicemail` of
one of the host's own rows marks it deleted and dirty instead of removing it
(Android does that only for changes made by another app); both then broadcast
`SYNC_VOICEMAIL` to the host itself so its client pushes the change.

## Carrier visual voicemail (default dialer)

`ai.eliza.plugins.messages.vvm` is an OMTP visual-voicemail client: Android
binds the default dialer's `VisualVoicemailService`, the client activates the
service with the carrier by SMS, keeps the IMAP account the carrier's STATUS
answer issues, and reconciles the carrier mailbox with the host's own rows in
`VoicemailContract` (rows, audio, and a status row per SIM), where the
voicemail methods above read them unchanged.

A host declares two thin subclasses that both return the same
`VvmConfiguration`:

```java
public final class HostVoicemailService extends VisualVoicemailClientService {
  @Override protected VvmConfiguration configuration() { return HostVoicemail.CONFIG; }
}
public final class HostVoicemailReceiver extends VisualVoicemailReceiver {
  @Override protected VvmConfiguration configuration() { return HostVoicemail.CONFIG; }
}
// HostVoicemail.CONFIG = new VvmConfiguration(HostVoicemailReceiver.class);
```

```xml
<uses-permission android:name="android.permission.READ_PHONE_STATE" />
<uses-permission android:name="android.permission.SEND_SMS" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.CHANGE_NETWORK_STATE" />
<uses-permission android:name="com.android.voicemail.permission.ADD_VOICEMAIL" />

<service android:name=".HostVoicemailService" android:exported="true"
    android:permission="android.permission.BIND_VISUAL_VOICEMAIL_SERVICE">
  <intent-filter>
    <action android:name="android.telephony.VisualVoicemailService" />
  </intent-filter>
</service>
<receiver android:name=".HostVoicemailReceiver" android:exported="false">
  <intent-filter>
    <action android:name="android.intent.action.FETCH_VOICEMAIL" />
    <data android:scheme="content" android:host="com.android.voicemail"
        android:mimeType="vnd.android.cursor.item/voicemail" />
  </intent-filter>
  <intent-filter>
    <action android:name="android.provider.action.SYNC_VOICEMAIL" />
  </intent-filter>
</receiver>
```

This library's manifest declares none of these, so hosts without the client
gain nothing. READ_PHONE_STATE reads the carrier configuration; SEND_SMS is
what `sendVisualVoicemailSms` requires (RECEIVE_SMS is not needed: filtered
messages arrive through the service); CHANGE_NETWORK_STATE requests the
carrier's cellular network. Reading and writing every source's voicemail comes
with the dialer role; ADD_VOICEMAIL covers the host's own rows. The receiver
is not exported because the only sender is the host itself
(`VoicemailStore.fetch` and the sync request above address the row's source
package); export it behind `com.android.voicemail.permission.READ_VOICEMAIL`
only if other apps should be able to ask.

- Supported carriers: `vvm_type_string` of `vvm_type_omtp` or `vvm_type_cvvm`
  with a destination number, not in legacy mode. Any other configuration
  (including `vvm_type_vvm3`) clears the SMS filter and writes a status row
  with `CONFIGURATION_STATE_DISABLED`, which `voicemailStatus()` reports as
  `unsupported`. Requests are OMTP 1.1 (`Activate`, `STATUS`) unless the host
  opts into 1.2 or 1.3 with its registered client type
  (`withProtocol(OmtpSms.V1_3, "…")`); CVVM carriers get `Activate:dt=6`.
- On service: the filter is set to the carrier's client prefix (any sender,
  any port, as the platform's default) and, without a stored account,
  `Activate` is sent. A STATUS answer of `st=R` or `st=N` with `rc=0` and a
  complete account stores it and syncs; any other answer is mapped to the
  status row (`OmtpSms.channels`) and, except a carrier system error (`rc=1`),
  drops the account and its rows. A SYNC notice (NM, MBU, GU) starts a sync.
- Sync (`VvmSync`): owner deletions are flagged `\Deleted` and expunged, then
  removed locally; dirty heard rows are flagged `\Seen`; rows whose message is
  gone are removed and messages heard elsewhere marked read; new messages with
  an `audio/*` part become rows (number, date, duration, read state,
  `source_data` = IMAP UID). Audio is downloaded when `vvm_prefetch_bool` is
  set (20 per sync, newest first) or when `FETCH_VOICEMAIL` names a row, at
  most 8 MiB decoded. A changed UIDVALIDITY drops and re-reads the rows.
  A passing failure is retried after 15 s, 60 s and 240 s, then given up; a
  refused login asks once for a fresh STATUS and is not retried.
- Network: with `vvm_cellular_data_required_bool`, or whenever
  `vvm_ssl_enabled_bool` is off, the session runs only over a cellular network
  requested for that subscription, so a plaintext LOGIN never crosses Wi-Fi.
  With TLS the system trust store and the server's host name are verified;
  there is no STARTTLS, no fallback and no trust override.
- The IMAP account is kept by a `VvmSecrets`; the default seals each SIM's
  account with a Keystore AES-GCM key in `noBackupFilesDir`. It is removed on
  SIM removal, on a not-ready STATUS, when the service is stopped and, checked
  at every entry, when the host is no longer the default dialer; the last two
  also remove every row and status this source wrote.
- Work runs on one in-process worker thread, not a scheduled job. Service
  tasks are held until their first attempt ends; receiver work and retries
  last only as long as the process, and whatever is lost is redone by the next
  SYNC notice, return of service or request.
- Not supported: greetings, PIN change, carrier transcripts, `Deactivate`,
  IMAP AUTH mechanisms other than LOGIN, STARTTLS, `vvm_type_vvm3`, legacy mode.
- Trust: the public API does not reveal an SMS's sender, and the filter
  accepts any sender by default, so a text shaped like the carrier's STATUS
  can point the client at another server. That server could put false rows in
  the voicemail list; it receives only the credentials it sent.
- Verified only against fakes (JVM tests). Not exercised here: delivery of
  filtered SMS, real carrier configuration, data SMS, the cellular network
  request and binding, real carrier IMAP servers and their TLS, the voicemail
  provider's permission and dirty/deleted behaviour under the dialer role, and
  the Keystore account store.

`MmsPdu` encodes M-Send.req, M-NotifyResp.ind and M-Acknowledge.ind. Outgoing
user MMS (group messages and attachments) is not offered yet. Carrier MMSC
behaviour, APN settings and real role grants need device qualification.
