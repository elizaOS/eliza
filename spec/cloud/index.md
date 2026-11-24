# Eliza cloud

The cloud is the hosted service side of Eliza. It owns identity and
sessions, registered native clients and their device keys, plans, billing
and entitlements, and the paid services a device calls: metered inference,
batch and realtime speech, maps and managed Google. Agents run on the
owner's device; the cloud hosts no agent, app or sandbox and never runs a
turn. The device half of sign-in, credential custody and voice belongs to
os, and the agent calls the cloud only through [the client](./client.md).
An operator runs a deployment from the command line; there is no HTTP admin
route.

Spec values are milliseconds since the epoch and integer micro-USD
(1 USD = 1,000,000); character counts are UTF-16 code units. Wire encodings
differ only where a spec says so.

| Area | Specifications |
| --- | --- |
| Shared | [Vocabulary and refusals](./shared/types.md), [metering holds](./shared/metering.md), [provider change dispatched once](./shared/dispatchOnce.md), [rate limiter](./shared/rateLimit.md) |
| Deployment and operation | [Deployment profile](./deployment.md), [operator commands](./operator.md), [hosted return pages](./returnPages.md), [cloud client](./client.md) |
| Identity | [Accounts](./identity/accounts.md), [request authentication](./identity/requestAuth.md), [sessions](./identity/sessions.md), [code challenges](./identity/codeChallenges.md), [Google sign-in](./identity/federatedSignIn.md), [second factor](./identity/secondFactor.md), [sign-in methods](./identity/signInMethods.md), [account deletion](./identity/deletion.md) |
| Native clients | [Registered native clients](./nativeClients/registry.md), [device keys](./nativeClients/deviceKeys.md) |
| Billing | [Plan catalog](./billing/plans.md), [entitlements](./billing/entitlements.md), [funds](./billing/funds.md), [plan allowance](./billing/allowance.md), [subscriptions](./billing/subscriptions.md), [subscription checkout](./billing/checkout.md), [subscription commands](./billing/subscriptionCommands.md), [payment provider events](./billing/providerEvents.md), [grant codes](./billing/grantCodes.md) |
| Inference | [Chat models and prices](./services/models.md), [chat completions](./services/inference.md) |
| Speech | [Batch speech](./services/speech.md), [realtime speech session](./services/speechSession.md), [speech relay protocol](./services/speechRelay.md) |
| Maps | [Hosted maps](./services/maps.md) |
| Managed Google | [Connection](./services/google/connection.md), [Gmail reads](./services/google/mailRead.md), [reviewed Gmail changes](./services/google/mailOperations.md), [Calendar](./services/google/calendar.md) |

## Story: Use inference on my subscription or funded pilot account

> As a subscriber or funded pilot, I can send a request to the deployment's model.
> My account shows the subscription the billing provider currently recognizes.

Both hosts answer it with the server's chat route, as `services/inference`
and `services/models` specify it (`packages/cloud-worker/src/services/chat.vibe`,
`packages/cloud-worker/src/services/models.vibe`), metered through `shared/metering`.

### A request needs an active account and sufficient funding for its quote

The deployment uses the [shared hold](./shared/metering.md) to reserve the
quote before contacting a provider. A paid period supplies its remaining
[allowance](./billing/allowance.md) first. Other readable plans use the
account's [funded credits](./billing/funds.md). An `Idempotency-Key` UUID
or the request ID identifies the chat within its organization. A repeated key
returns `409 already_dispatched` without sending or charging another call. The chat
request is bounded to 256 KiB and a listed model and prompt are priced before
the hold is reserved. Model prices and reported token counts follow the
[model catalog](./services/models.md).

```quint
pure def mayDispatchFundedRequest(authenticated: bool, freshHold: bool, dispatchCommitted: bool): bool =
  authenticated and freshHold and dispatchCommitted
pure def lawPaidAccessRequiresIdentity(freshHold: bool, dispatched: bool): bool =
  not(mayDispatchFundedRequest(false, freshHold, dispatched))
pure def lawDuplicateCannotSpendAgain(authenticated: bool, dispatched: bool): bool =
  not(mayDispatchFundedRequest(authenticated, false, dispatched))
```

### A streamed answer sends complete OpenAI frames and settles the same hold

The caller can see each complete data frame while the provider is still
working. Frames remain whole across upstream chunks, including split UTF-8
characters. The cloud bounds frame and response size. A finished answer ends
with one `[DONE]`, preceded by one reported usage chunk if the caller asked
for it. A definite provider rejection before the stream starts is an HTTP
refusal. A truncated or unreadable stream sends one error frame and then
`[DONE]`.
The original hold settles once at the billed cost when usable counts were
reported, including after a stream failure. It settles at the quote when no
usable report arrived. A caller disconnect releases the provider connection
and charges the greater of quoted and reported input tokens, plus the
output tokens estimated from delivered text. Between dispatch and the
provider's response headers, a disconnect charges only quoted input.

The [chat completion rules](./services/inference.md) define the framing,
chunking and charge decisions. The [shared metering rules](./shared/metering.md)
define the lifecycle of the original hold.

```quint
import inference as Chat from "./services/inference"
import metering as Holds from "./shared/metering"
import models as Models from "./services/models"
pure def lawInferenceStreamFraming(deltas: List[int], ending: Chat::StreamEnding, usageAsked: bool, usageReported: bool): bool =
  Chat::lawEveryUnbrokenStreamEndsInOneDone(deltas, ending, usageAsked, usageReported)
  and Chat::lawOnlyAFinishedStreamCompletes(deltas, ending, usageAsked, usageReported)
  and Chat::lawUsageIsSentOnceAndOnlyAsReported(deltas, ending, usageAsked, usageReported)
  and Chat::lawOnlyAFailedStreamSendsAnError(deltas, ending, usageAsked, usageReported)
pure def lawInferenceStreamChunking(first: List[int], second: List[int]): bool = Chat::lawChunkBoundariesDoNotChangeEvents(first, second)
pure def lawInferenceStreamReportDeterminesTheCharge(u: Models::ProviderUsage, quoted: Models::TokenCounts): bool =
  Chat::lawAProviderReportDeterminesTheCharge(u, quoted)
pure def lawInferenceStreamHangUpChargesDeliveredText(reportedInput: int, deliveredChars: int, quoted: Models::TokenCounts): bool =
  Chat::lawAHangUpPaysForWhatItGot(reportedInput, deliveredChars, quoted)
pure def lawInferenceStreamClosesTheOriginalHold(lane: Holds::FundingLane, quote: int, allowanceAvailable: int, creditAvailable: int,
  dispatched: bool, end: Chat::CompletionEnd, quoted: Models::TokenCounts, creditFree: int): bool =
  Chat::lawAMissingReportChargesTheQuote(dispatched, end, quoted)
  and Chat::lawEveryCallClosesItsHoldOnce(lane, quote, allowanceAvailable, creditAvailable, dispatched, end, quoted, creditFree)
```

## Story: Sign in to the Cloud

> As a person using a product’s Cloud, I can sign in with Google or a code
> sent to my email address or phone. I can end my session from the sign-in
> device. I can approve my Android app to use inference without giving it my
> browser session or giving the page a device key.

### Sign-in requires proof from the chosen provider

Google signs in the subject reached by redeeming the browser-bound OAuth code.
Email and SMS prove the destination and the browser that requested the code. SMS is available only for the deployment’s allowed calling codes and remaining send budget. The
deployment resolves the proof to a single account, preferring a known subject
and then the account that owns the proven email address. Accounts and sessions
belong to the deployment that issued them.

```quint
type CloudSignInProvider = CloudGoogle | CloudEmail | CloudSms
pure def canIssueCloudSession(requested: CloudSignInProvider, verified: CloudSignInProvider, deploymentMatches: bool, providerVerified: bool): bool =
  requested == verified and deploymentMatches and providerVerified
```

### A browser session ends when it expires or the person signs out

A signed-in person is identified by the account of their active session for
this deployment. The browser can rotate its 15-minute access token using its
30-day refresh family. Signing out retires that family.

```quint
pure def cloudSessionAllows(sessionEndsAt: int, nowAt: int, sessionPresent: bool): bool =
  sessionPresent and nowAt < sessionEndsAt
```

### A registered device grant authorizes device services

The person approves a short-lived grant for the registered Android client
and its verified return address while signed in. A browser that names the
account shown for approval receives a grant only while signed in to that
account. Only the device proving possession of the grant’s verifier can redeem it, once. The device
acknowledges receipt before it can use the key. Signing out stops activation
of an unfinished grant. An active key continues to authorize inference and
consented speech until its deadline or its own revocation. Before that deadline the
key can obtain its successor without the browser for six months after the
sign-in ([device keys](./nativeClients/deviceKeys.md)).

```quint
pure def mayIssueAccountBoundDeviceGrant(shownAccount: str, signedInAccount: str): bool =
  shownAccount != "" and shownAccount == signedInAccount

pure def canExchangeCloudDeviceGrant(grantEndsAt: int, nowAt: int, grantUnspent: bool, verifierMatches: bool, browserSessionActive: bool): bool =
  nowAt < grantEndsAt and grantUnspent and verifierMatches and browserSessionActive

pure def cloudDeviceAllows(deviceEndsAt: int, nowAt: int, acknowledged: bool, inferenceRequested: bool, consentedSpeechRequested: bool): bool =
  cloudSessionAllows(deviceEndsAt, nowAt, acknowledged) and (inferenceRequested or consentedSpeechRequested)
```

## Story: Connect Google mail and calendar

> As a signed-in person, I can choose to connect Google mail, my primary
> calendar or both. I can read my Gmail folders and Calendar events I
> approved, and disconnect the access I granted.

### Google sign-in and read access require separate permission

Mailbox and calendar access requires a separate consent prompt where the
person approves each requested capability. A deployment can use its sign-in OAuth
client for this separate exchange. The exchange requests only the selected scopes and identity needed to link the right account. The verified Google subject
must match a Google sign-in account. For email or SMS sign-in the verified
Google email must match the email chosen for the connection.

```quint
type CloudGoogleReadScope = GoogleReadMail | GoogleReadCalendar
pure def canConnectCloudGoogle(explicitConsent: bool, providerApproved: bool, identityMatches: bool, selected: Set[CloudGoogleReadScope]): bool =
  explicitConsent and providerApproved and identityMatches and selected.size() > 0
```

### An approved connection grants the owner only the selected reads

A read requires an active browser session for the account that consented.
The service keeps the refresh credential encrypted for that deployment,
account and approved scopes. Disconnecting removes the local credential and any
pending consent authorizations. Browser and native inference credentials
have separate permissions. The owner can search Inbox, Sent, Drafts or Trash.
Counts show the provider’s unread Inbox messages and total draft messages across
the mailbox, including messages beyond the displayed page. A Gmail message read returns named attachment
descriptors without attachment bytes. Fetching a supported part requires the
same owner and explicit mail grant, with its message, history and part
identifiers. A changed history or missing part cannot return content.
A browser that has opened a photo or PDF can hand that original to its owner’s
registered device. The selection expires after five minutes. Redemption requires
an active device credential under the same account and organization, the same
current mail grant, revision, part and content digest. The handoff contains no
mail bytes or provider credentials. A later handoff can only return that same
original until it expires.

```quint
pure def currentAttachmentTransfer(issuedAt: int, now: int): bool = issuedAt >= 0 and now >= issuedAt and now - issuedAt < 300000

pure def canReadCloudGoogle(ownerSessionActive: bool, connectionPresent: bool, grantOwnerMatches: bool, selected: Set[CloudGoogleReadScope], requested: CloudGoogleReadScope): bool =
  ownerSessionActive and connectionPresent and grantOwnerMatches and selected.contains(requested)
```

### Managed mail dispatch requires separate consent and explicit approval

The owner may separately grant permission to send email. A browser request
dispatches one reviewed plain-text draft to one exact address through the
current Gmail connection. A reply is threaded only after Cloud re-reads the
selected message and matches the reviewed recipient and subject. Cloud builds
the thread headers from that verified message. The device inference key cannot dispatch a draft.
Cloud reserves the operation ID before calling Gmail and records provider
acceptance by message ID. An unknown outcome cannot cause the operation to be
dispatched again.

```quint
pure def canSendCloudGoogle(ownerSessionActive: bool, grantMatches: bool, sendConsent: bool, confirmedDraft: bool, reserved: bool): bool =
  ownerSessionActive and grantMatches and sendConsent and confirmedDraft and not(reserved)
```

### Trash and calendar changes require their own permissions

Moving a message to Trash and undoing that change requires Gmail modify
permission. Google requires Gmail modify scope for Trash. Undo names the successful Trash receipt and checks the current
provider revision. Cloud offers no permanent deletion here.

Creating, changing or removing an appointment requires Calendar event
permission for calendars their account owns. Changes target the primary
calendar and appointments without guests. A new series can repeat weekly or
monthly. Timed series retain the reviewed local time in the named time zone.
Cloud verifies the recurrence and time zone on the saved series before
returning its receipt. A series change must name the
current parent of the occurrence and the reviewed parent version. Updates and removals name the
reviewed event version, and Google must accept that version. Cloud reports
success only after provider evidence matches the selected event.

```quint
pure def canChangeCloudGoogle(ownerSessionActive: bool, grantMatches: bool, allowed: bool, reviewedTarget: bool, versionMatches: bool): bool =
  ownerSessionActive and grantMatches and allowed and reviewedTarget and versionMatches
```

### A device reminder follows the reviewed event occurrence

A person chooses one hour before or one day before for a confirmed timed
occurrence on their owned calendar. Cloud derives the alarm time from the exact
provider revision and accepts a future alarm beyond the current month. A
registered device may read only reminder schedules for its own account. If the
schedule spans multiple pages, every page must belong to one unchanged owner
snapshot before the device cancels alarms missing from that schedule. Reading an
occurrence to open its details requires a fresh
match of the grant, occurrence and provider revision. An edited, deleted or
disconnected occurrence does not authorize an old alarm. The saved schedule
receipt does not indicate that Android has delivered a notification.

```quint
pure def canReadCloudCalendarReminder(activeDevice: bool, ownerMatches: bool, grantCurrent: bool, occurrenceCurrent: bool, revisionCurrent: bool): bool =
  activeDevice and ownerMatches and grantCurrent and occurrenceCurrent and revisionCurrent
```

## Story: Use a cloud speech session

> As a signed-in person with a subscription or funded pilot account, I can
> explicitly allow a bounded microphone and speech playback session. The
> app can stop the session and never receives the voice provider's keys.

Both hosts answer it with the server's speech session and relay routes, as
`services/speechSession` and `services/speechRelay` specify them
(`packages/cloud-worker/src/services/speech-session.vibe`, `packages/cloud-worker/src/services/speech-relay.vibe`); a
Worker runs the relay on a socket pair (`deployment`, "Story: Serve the
deployment from a Worker").

### Consent and an allowance are required before speech is sent

The Cloud binds consent to the signed-in account and its current credential,
and consumes the consent once to admit a bounded speech window. Signing out or
revoking that device credential prevents an unopened window from starting. Provider connections open only after the
relay consumes the window credential. A session reaches its deadline,
closes on request, and cannot open again.

```quint
pure def canMintCloudSpeech(ownerMatches: bool, consentUnused: bool, consentLive: bool, accountEntitled: bool, windowAvailable: bool): bool =
  ownerMatches and consentUnused and consentLive and accountEntitled and windowAvailable

pure def canOpenCloudSpeech(credentialMatches: bool, windowOpen: bool, alreadyOpened: bool, revoked: bool): bool =
  credentialMatches and windowOpen and not(alreadyOpened) and not(revoked)
```

### A speech window bounds the audio and text sent to providers

The service reserves funds at the deployment's reviewed provider rate before
admitting the window. A window allows at most sixty seconds of 16 kHz mono
PCM16, 4,096 text characters and eight MiB of generated audio. The relay
records the PCM and text attempted with the providers. The metering owner
settles a confirmed outcome as measured and an uncertain one at its quote.

```quint
pure def cloudSpeechUsageFits(pcmBytes: int, textCharacters: int, outputBytes: int): bool =
  pcmBytes >= 0 and pcmBytes <= 1920000 and textCharacters >= 0 and textCharacters <= 4096 and outputBytes >= 0 and outputBytes <= 8388608
```

## Story: Transcribe a recording

> As a person sending a recording, I want a failure to prepare it to leave
> my funding untouched, so that I pay only after a provider call may have
> started.

### A recording is prepared before reserving funding or dispatching its provider call

The service parses the upload and prepares the provider's multipart body
before entering the funded-call path. A preparation failure returns a typed
unavailable answer without reserving funding or contacting a provider. A
prepared call still needs the current authenticated account, a fresh hold
and a committed dispatch. The 120-second provider execution budget starts
after preparation; upload parsing and local preparation precede it.

Discovered during boundary review: building the multipart body after marking
the hold dispatched would treat a local preparation failure as an unknown
provider outcome and charge its quote.

```quint
pure def mayReservePreparedSpeech(recordingPrepared: bool, authenticated: bool): bool =
  recordingPrepared and authenticated
pure def mayDispatchPreparedSpeech(recordingPrepared: bool, authenticated: bool, freshHold: bool, dispatchCommitted: bool): bool =
  recordingPrepared and mayDispatchFundedRequest(authenticated, freshHold, dispatchCommitted)
pure def lawUnpreparedRecordingReservesAndDispatchesNothing(authenticated: bool, freshHold: bool, dispatchCommitted: bool): bool =
  not(mayReservePreparedSpeech(false, authenticated)) and not(mayDispatchPreparedSpeech(false, authenticated, freshHold, dispatchCommitted))
pure def lawPreparedSpeechStillRequiresFunding(authenticated: bool, freshHold: bool, dispatchCommitted: bool): bool =
  mayDispatchPreparedSpeech(true, authenticated, freshHold, dispatchCommitted) == mayDispatchFundedRequest(authenticated, freshHold, dispatchCommitted)
```

## Story: Back up my passwords for another device

> As a person using Passwords, I can choose to keep an encrypted backup.
> I can restore it on another device with my recovery key or remove the
> backup when I no longer want it.

### Only a current, separately approved device grant accesses the owner’s backup

Opting in needs an explicit native request and recent interactive approval.
In the standalone deployment, the first-party browser shows the purpose and
signed-in account before the owner approves. Approval returns a single-use code through the exact
registered app link. The active native enrollment for the same owner
exchanges that code using the original purpose, state and one-time verifier.
Owner verification returns the verified owner scope without opening any
cloud copy. Other purposes return a single-operation proof bound to the
active enrollment and browser session.
The backup grant belongs to the current deployment, registered product and
account. The cloud refuses a grant after expiry or revocation, or if the
account or registration is no longer eligible. An inference credential
never authorizes backup access. The native client encrypts the snapshot
before sending it and holds the recovery key. The owner must have that key
to restore. The cloud receives only the encrypted snapshot.
Readiness tells a registered client which approval contract the deployment
serves: once backup storage is ready, browser approval answers `204` with
`X-Password-Backup-Version: 2` and native Google approval answers `204` with
version `3`. Either approval names the owner and organization it covers, and a
client that binds its vault to the organization checks both against its
signed-in account.

```quint
type BackupAccess = BackupDeviceGrant | BackupInferenceCredential
pure def canAccessPasswordBackup(access: BackupAccess, active: bool, scopeMatches: bool): bool =
  access == BackupDeviceGrant and active and scopeMatches
pure def lawInferenceCannotAccessPasswordBackup(active: bool, scopeMatches: bool): bool =
  not(canAccessPasswordBackup(BackupInferenceCredential, active, scopeMatches))
pure def lawOtherAccountsCannotAccessPasswordBackup(access: BackupAccess, active: bool): bool =
  not(canAccessPasswordBackup(access, active, false))
type PasswordBackupPurpose = BackupRead | BackupWrite | BackupRemove | BackupVerify
pure def canApprovePasswordBackup(active: bool, recent: bool, registered: bool): bool =
  active and recent and registered
pure def lawStaleSignInCannotApprovePasswordBackup(active: bool, registered: bool): bool =
  not(canApprovePasswordBackup(active, false, registered))
pure def mayExchangeBackupCode(approved: PasswordBackupPurpose, requested: PasswordBackupPurpose, exactVerifier: bool, exactState: bool, currentBrowser: bool, enrolledDevice: bool, sameOwner: bool, unspent: bool): bool =
  approved == requested and exactVerifier and exactState and currentBrowser and enrolledDevice and sameOwner and unspent
pure def lawDifferentOwnerCannotExchangeBackupCode(approved: PasswordBackupPurpose, requested: PasswordBackupPurpose, exactVerifier: bool, exactState: bool, currentBrowser: bool, enrolledDevice: bool, unspent: bool): bool =
  not(mayExchangeBackupCode(approved, requested, exactVerifier, exactState, currentBrowser, enrolledDevice, false, unspent))
pure def canRedeemBackupApproval(approved: PasswordBackupPurpose, requested: PasswordBackupPurpose, exactVerifier: bool, exactState: bool, grantLive: bool, unspent: bool): bool =
  approved == requested and requested != BackupVerify and exactVerifier and exactState and grantLive and unspent
pure def lawBackupApprovalCannotBeReplayed(approved: PasswordBackupPurpose, requested: PasswordBackupPurpose, exactVerifier: bool, exactState: bool, grantLive: bool): bool =
  not(canRedeemBackupApproval(approved, requested, exactVerifier, exactState, grantLive, false))
```

### Shared native approval authorizes only the enrolled owner’s requested backup operation

Shared Cloud requires consent in the native flow and a fresh Google proof for
the subject already linked to the current owner. That link is read after
Google's signing keys are fetched, and again when the granted operation is
used, so a subject unlinked in between is refused and nothing is granted or
changed. The active device enrollment
must name that account and organization and match the exact registered app,
environment and callback. The unspent proof must match the requested purpose,
state and PKCE verifier. A refusal grants nothing. Owner verification returns
the owner scope without a transferable grant. Read, save and remove each
authorize one operation under the existing one-use backup grant rule. Native
backup approval creates no sign-in session and changes no device credential.
An account with an additional factor requires that factor before native
backup approval can be granted. This native proof cannot satisfy it.
The registered approval method is enforced on the server. A native
registration uses the backup `/native/challenge` and `/native/approve`
endpoints and cannot open or exchange a browser backup approval. The
native readiness response and approval routes use the exact callback from
the app's registration, which can be on the product's own host. They
require its configured Android OAuth presenters. Browser approval still
uses the standalone deployment's client and callback.

```quint
type NativePasswordBackupChecks = { activeEnrollment: bool, exactRegistration: bool, linkedOwnerAndOrganization: bool, nativeConsent: bool, additionalFactorClear: bool, exactPurpose: bool, exactState: bool, exactVerifier: bool, unspent: bool }
type NativePasswordBackupProvenance = NoNativeBackupProof | FreshNativeBackupProof(NativePasswordBackupChecks)
type NativePasswordBackupAction = NativeBackupRefused | NativeBackupVerifyOwner | NativeBackupGrantRead | NativeBackupGrantWrite | NativeBackupGrantRemove

pure def nativePasswordBackupApproval(provenance: NativePasswordBackupProvenance, purpose: PasswordBackupPurpose): NativePasswordBackupAction =
  match provenance {
    | NoNativeBackupProof => NativeBackupRefused
    | FreshNativeBackupProof(proof) =>
      if (proof.activeEnrollment and proof.exactRegistration and proof.linkedOwnerAndOrganization and proof.nativeConsent and proof.additionalFactorClear and proof.exactPurpose and proof.exactState and proof.exactVerifier and proof.unspent)
        match purpose {
          | BackupVerify => NativeBackupVerifyOwner
          | BackupRead => NativeBackupGrantRead
          | BackupWrite => NativeBackupGrantWrite
          | BackupRemove => NativeBackupGrantRemove
        }
      else NativeBackupRefused
  }

pure def lawNativeBackupRequiresCurrentProof(provenance: NativePasswordBackupProvenance, purpose: PasswordBackupPurpose): bool =
  (nativePasswordBackupApproval(provenance, purpose) != NativeBackupRefused) iff
    match provenance {
      | NoNativeBackupProof => false
      | FreshNativeBackupProof(proof) =>
        proof.activeEnrollment and proof.exactRegistration and proof.linkedOwnerAndOrganization and proof.nativeConsent and proof.additionalFactorClear and proof.exactPurpose and proof.exactState and proof.exactVerifier and proof.unspent
    }

pure def lawNativeBackupOnlyGrantsItsPurpose(provenance: NativePasswordBackupProvenance, purpose: PasswordBackupPurpose): bool = {
  val granted = nativePasswordBackupApproval(provenance, purpose)
  match granted {
    | NativeBackupRefused => true
    | NativeBackupVerifyOwner => purpose == BackupVerify and not(canRedeemBackupApproval(purpose, purpose, true, true, true, true))
    | NativeBackupGrantRead => purpose == BackupRead
    | NativeBackupGrantWrite => purpose == BackupWrite
    | NativeBackupGrantRemove => purpose == BackupRemove
  }
}

pure val nativeBackupProofSample: NativePasswordBackupChecks = { activeEnrollment: true, exactRegistration: true, linkedOwnerAndOrganization: true, nativeConsent: true, additionalFactorClear: true, exactPurpose: true, exactState: true, exactVerifier: true, unspent: true }
pure val provenanceValues: Set[NativePasswordBackupProvenance] =
  Set(NoNativeBackupProof).union(Set(FreshNativeBackupProof(nativeBackupProofSample)))
    .union(Set(FreshNativeBackupProof({ ...nativeBackupProofSample, activeEnrollment: false })))
    .union(Set(FreshNativeBackupProof({ ...nativeBackupProofSample, exactRegistration: false })))
    .union(Set(FreshNativeBackupProof({ ...nativeBackupProofSample, linkedOwnerAndOrganization: false })))
    .union(Set(FreshNativeBackupProof({ ...nativeBackupProofSample, nativeConsent: false })))
    .union(Set(FreshNativeBackupProof({ ...nativeBackupProofSample, additionalFactorClear: false })))
    .union(Set(FreshNativeBackupProof({ ...nativeBackupProofSample, exactPurpose: false })))
    .union(Set(FreshNativeBackupProof({ ...nativeBackupProofSample, exactState: false })))
    .union(Set(FreshNativeBackupProof({ ...nativeBackupProofSample, exactVerifier: false })))
    .union(Set(FreshNativeBackupProof({ ...nativeBackupProofSample, unspent: false })))
```

### Google sign-in for backup returns to the protected approval page

A browser Google flow started for password backup records that purpose in its
protected flow cookie. On success or denial it returns to the first-party
backup approval page with a resume marker. A denial also carries a fixed
error marker. Ordinary and legacy flows still return to the account page.
Signing in only establishes a browser session. The owner still explicitly
approves the backup on the protected page.

```quint
type BrowserGooglePurpose = GoogleAccount | GooglePasswordBackup
type BrowserGoogleReturn = GoogleAccountPage | GoogleBackupApprovalPage
pure def browserGoogleReturn(purpose: BrowserGooglePurpose): BrowserGoogleReturn =
  if (purpose == GooglePasswordBackup) GoogleBackupApprovalPage else GoogleAccountPage
pure def lawOnlyBackupGoogleReturnsToApproval(purpose: BrowserGooglePurpose): bool =
  (browserGoogleReturn(purpose) == GoogleBackupApprovalPage) iff (purpose == GooglePasswordBackup)
```

### Every backup change matches the current revision

The service stores at most one complete snapshot per product and account.
A write carries the expected revision and one through 2,097,152 encrypted
bytes. Only an empty slot that has never been used accepts an initial write
without a revision. Deletion removes the live snapshot while advancing its
revision. A new backup after deletion must match that revision. A retry with
an earlier revision has no effect, including an initial write sent before
deletion.

```quint
type PasswordBackupSlot = { revision: int, bytes: int }
type PasswordBackupChange = BackupSave({ bytes: int }) | BackupDelete
pure val slotValues = Set({ revision: 0, bytes: 0 }, { revision: 1, bytes: 9 }, { revision: 2, bytes: 0 })
pure val changeValues = Set(BackupDelete, BackupSave({ bytes: 0 }), BackupSave({ bytes: 1 }), BackupSave({ bytes: 2097152 }), BackupSave({ bytes: 2097153 }))
pure def changePasswordBackup(slot: PasswordBackupSlot, authorized: bool, expected: int, change: PasswordBackupChange): PasswordBackupSlot = {
  val valid = match change {
    | BackupSave(snapshot) => snapshot.bytes > 0 and snapshot.bytes <= 2097152
    | BackupDelete => slot.bytes > 0
  }
  if (authorized and expected == slot.revision and expected >= 0 and expected < 2147483647 and valid)
    { revision: slot.revision + 1, bytes: match change { | BackupSave(snapshot) => snapshot.bytes | BackupDelete => 0 } }
  else slot
}
pure def lawStaleBackupWriteKeepsSnapshot(slot: PasswordBackupSlot, authorized: bool, expected: int, change: PasswordBackupChange): bool =
  expected != slot.revision implies changePasswordBackup(slot, authorized, expected, change) == slot
pure def lawUnauthorizedBackupWriteKeepsSnapshot(slot: PasswordBackupSlot, expected: int, change: PasswordBackupChange): bool =
  changePasswordBackup(slot, false, expected, change) == slot
pure def lawDeletedPasswordBackupRejectsInitialRetry(slot: PasswordBackupSlot, bytes: int): bool = {
  val deleted = changePasswordBackup(slot, true, slot.revision, BackupDelete)
  (slot.revision >= 0 and slot.revision < 2147483647 and slot.bytes > 0) implies
    (deleted.bytes == 0 and changePasswordBackup(deleted, true, 0, BackupSave({ bytes: bytes })) == deleted)
}
```

## Story: Ask for a bounded decision about a browser page

> As a signed-in user, I can ask which visible link best fits my current
> goal, so that the app can point me to it or say it found no match.

`POST /api/v1/decisions` accepts an active Cloud session or a native device
credential. A browser may name its expected account in `X-Eliza-Account`;
a mismatch is refused before any provider work. The caller sends a goal and
at most sixteen labeled candidates. Their IDs are unique and `none` is
reserved. A provider answer may select one of those IDs or report no match.
The app owns any follow-up action and its approval rules.

Cloud accepts only the typed decision fields. For browser guidance, the
app sends selected display labels and a goal, with no form contents or raw
URLs. Cloud removes common credential and address patterns from outbound
text and keeps no request or response text in its records. The request
body is bounded. The client allows thirty seconds for a call, including
a twenty-five-second Worker AI wait and time for transport.

The deployment's Workers AI binding enables Clef decisions with
`@cf/cloudflare/clef-flash`. An unavailable binding or invalid
answer yields a typed unavailable result. Each dispatch counts against
thirty calls per minute per account and two thousand per day per
organization. An unavailable limiter blocks dispatch.


### A parsed decision request stays within its text and candidate bounds

The exact JSON schema rejects extra fields, whitespace-only required text,
invalid candidate ID syntax and repeated IDs. The shell measures UTF-16
code units. The values below are that parsed request's counts; zero for an
optional text means it was absent. A choice has one through sixteen
candidates, with no ID reserved for the provider's no-match answer. Mode
and turn requests use their own text and recent-turn limits.

```quint
import types.* from "./shared/types"
import sessions as DecisionSessions from "./identity/sessions"
import rateLimit as DecisionLimits from "./shared/rateLimit"
type DecisionCandidate = { id: str, idUnits: CharCount, labelUnits: CharCount }
type DecisionRequest = DecisionChoice({ goalUnits: CharCount, pageUnits: CharCount, candidates: List[DecisionCandidate] })
  | DecisionMode({ actionUnits: CharCount, contextUnits: CharCount })
  | DecisionTurn({ transcriptUnits: CharCount, recentTurnUnits: List[CharCount] })
pure def decisionTextFits(units: CharCount, maximum: CharCount): bool = units > 0 and units <= maximum
pure def decisionOptionalTextFits(units: CharCount, maximum: CharCount): bool = units == 0 or decisionTextFits(units, maximum)
pure def decisionCandidatesFit(candidates: List[DecisionCandidate]): bool =
  candidates.length() >= 1 and candidates.length() <= 16 and candidates.every(c =>
    c.id != "" and c.id != "none" and decisionTextFits(c.idUnits, 64) and decisionTextFits(c.labelUnits, 300) and
    candidates.select(other => other.id == c.id).length() == 1)
pure def decisionRequestFits(decisionRequest: DecisionRequest): bool = match decisionRequest {
  | DecisionChoice(r) => decisionTextFits(r.goalUnits, 2000) and decisionOptionalTextFits(r.pageUnits, 16000) and decisionCandidatesFit(r.candidates)
  | DecisionMode(r) => decisionTextFits(r.actionUnits, 1000) and decisionOptionalTextFits(r.contextUnits, 4000)
  | DecisionTurn(r) => decisionTextFits(r.transcriptUnits, 2000) and r.recentTurnUnits.length() <= 6 and r.recentTurnUnits.every(units => decisionTextFits(units, 2000))
}
pure val candidatesValues = Set(List(), List({ id: "hours", idUnits: 5, labelUnits: 13 }),
  List({ id: "none", idUnits: 4, labelUnits: 8 }),
  List({ id: "hours", idUnits: 5, labelUnits: 13 }, { id: "hours", idUnits: 5, labelUnits: 13 }))
pure val decisionRequestValues = Set(
  DecisionChoice({ goalUnits: 18, pageUnits: 0, candidates: List({ id: "hours", idUnits: 5, labelUnits: 13 }) }),
  DecisionChoice({ goalUnits: 2001, pageUnits: 0, candidates: List() }),
  DecisionMode({ actionUnits: 1000, contextUnits: 4000 }),
  DecisionTurn({ transcriptUnits: 10, recentTurnUnits: List(10, 20) }))
pure def lawRepeatedDecisionCandidatesAreRefused(candidates: List[DecisionCandidate]): bool =
  candidates.some(c => candidates.select(other => other.id == c.id).length() > 1) implies not(decisionCandidatesFit(candidates))
pure def lawReservedDecisionCandidateIsRefused(candidates: List[DecisionCandidate]): bool =
  candidates.some(c => c.id == "none") implies not(decisionCandidatesFit(candidates))
```

### A dispatch uses the current account and its available quota slots

The current shared credential admission supplies the account; a supplied
decisionExpected account must equal it. A missing provider binding makes no quota
attempt. With a binding, the transaction admits only an active account and
counts it against the account's thirty-per-minute limit. The organization's
daily limit is two thousand. An organization with at least five dollars of
credits added by the operator, or with an active paid subscription of its
own, has four thousand. A grant does not qualify. After the daily limit, a
subscribed organization continues within its plan's standard requests a
minute (`billing/plans`), counted by one minute counter that all its
credentials share. Each dispatch increments the account counter and either
the daily counter or that minute counter, or nothing. An unreadable funding
policy applies the two-thousand limit. A cancelled or lapsed subscription
returns the organization to its limit without resetting what it used.
An unavailable store refuses the dispatch. These observed SQL rows expire
from their first admission, rather than at a calendar-aligned boundary;
expiry opens a new row with one hit. A refusal or admission names the
counter that decided it in `X-Clef-Rate-Limit-Scope` (`organization-day` or
`subscription-minute`). Included decisions debit no credits. No earlier
result is authority for another request.

```quint
type DecisionExpectedAccount = AnyCurrentDecisionAccount | ExpectedDecisionAccount({ id: str })
type DecisionCounter = { hits: int, expiresAt: Millis }
type DecisionCounts = { account: DecisionCounter, organization: DecisionCounter, continuation: DecisionCounter }
type DecisionCounterRead = DecisionStoreUnavailable | DecisionCountersRead({ counts: DecisionCounts })
type DecisionFunding = BaseDecisionFunding | FundedDecisionFunding | SubscribedDecisionFunding({ rpm: int })
type DecisionScope = OrganizationDayScope | SubscriptionMinuteScope
type DecisionDispatch = DecisionNotDispatched | DecisionDispatched({ counts: DecisionCounts, scope: DecisionScope })
pure val decisionAccountLimit = DecisionLimits::perMinute("clef:account", 30)
pure val decisionOrganizationLimit = DecisionLimits::perWindow("clef:organization", 2000, millisPerDay)
pure val decisionFundedOrganizationLimit = DecisionLimits::perWindow("clef:organization", 4000, millisPerDay)
pure val decisionFundedCredits: Micros = 5 * microsPerUsd
pure def decisionFundingOf(subscribedRpm: int, addedCredits: Micros): DecisionFunding =
  if (subscribedRpm > 0) SubscribedDecisionFunding({ rpm: subscribedRpm })
  else if (addedCredits >= decisionFundedCredits) FundedDecisionFunding
  else BaseDecisionFunding
pure def decisionDailyLimit(decisionFunding: DecisionFunding): DecisionLimits::RateLimit =
  if (decisionFunding == BaseDecisionFunding) decisionOrganizationLimit else decisionFundedOrganizationLimit
pure def decisionContinuationLimit(rpm: int): DecisionLimits::RateLimit = DecisionLimits::perMinute("clef:continuation", rpm)
pure def decisionAccountMatches(accountId: str, decisionExpected: DecisionExpectedAccount): bool = match decisionExpected {
  | AnyCurrentDecisionAccount => true
  | ExpectedDecisionAccount(wanted) => wanted.id == accountId
}
pure def decisionHeldHits(counter: DecisionCounter, decisionNow: Millis): int = if (decisionNow >= counter.expiresAt) 0 else counter.hits
pure def decisionCounterFits(counter: DecisionCounter, rule: DecisionLimits::RateLimit, decisionNow: Millis): bool =
  counter.hits >= 0 and counter.expiresAt >= 0 and decisionNow >= 0 and DecisionLimits::admits(decisionHeldHits(counter, decisionNow), rule)
pure def decisionCounted(counter: DecisionCounter, rule: DecisionLimits::RateLimit, decisionNow: Millis): DecisionCounter =
  { hits: decisionHeldHits(counter, decisionNow) + 1, expiresAt: if (decisionNow >= counter.expiresAt) decisionNow + rule.windowMs else counter.expiresAt }
pure def decisionContinuation(counts: DecisionCounts, decisionFunding: DecisionFunding, decisionNow: Millis): DecisionDispatch = match decisionFunding {
  | SubscribedDecisionFunding(s) =>
      if (decisionCounterFits(counts.continuation, decisionContinuationLimit(s.rpm), decisionNow))
        DecisionDispatched({ counts: { ...counts, account: decisionCounted(counts.account, decisionAccountLimit, decisionNow), continuation: decisionCounted(counts.continuation, decisionContinuationLimit(s.rpm), decisionNow) }, scope: SubscriptionMinuteScope })
      else DecisionNotDispatched
  | _ => DecisionNotDispatched
}
pure def decisionWithinCounts(counts: DecisionCounts, decisionFunding: DecisionFunding, decisionNow: Millis): DecisionDispatch =
  if (not(decisionCounterFits(counts.account, decisionAccountLimit, decisionNow))) DecisionNotDispatched
  else if (decisionCounterFits(counts.organization, decisionDailyLimit(decisionFunding), decisionNow))
    DecisionDispatched({ counts: { ...counts, account: decisionCounted(counts.account, decisionAccountLimit, decisionNow), organization: decisionCounted(counts.organization, decisionDailyLimit(decisionFunding), decisionNow) }, scope: OrganizationDayScope })
  else decisionContinuation(counts, decisionFunding, decisionNow)
pure def decisionQuotaAdmission(decisionCounters: DecisionCounterRead, decisionFunding: DecisionFunding, decisionNow: Millis): DecisionDispatch = match decisionCounters {
  | DecisionStoreUnavailable => DecisionNotDispatched
  | DecisionCountersRead(read) => decisionWithinCounts(read.counts, decisionFunding, decisionNow)
}
pure def decisionDispatch(decisionView: DecisionSessions::CredentialView, accountId: str, decisionExpected: DecisionExpectedAccount,
  decisionRequest: DecisionRequest, decisionCounters: DecisionCounterRead, decisionFunding: DecisionFunding, decisionNow: Millis, bindingPresent: bool): DecisionDispatch =
  if (bindingPresent and accountId != "" and decisionAccountMatches(accountId, decisionExpected) and decisionRequestFits(decisionRequest) and
      DecisionSessions::admitRequest(decisionView, DecisionSessions::ServiceAccess, decisionNow) == DecisionSessions::CredentialAccepted)
    decisionQuotaAdmission(decisionCounters, decisionFunding, decisionNow)
  else DecisionNotDispatched
pure val decisionIdleCounter: DecisionCounter = { hits: 0, expiresAt: 0 }
pure val decisionCountersValues = Set(DecisionStoreUnavailable,
  DecisionCountersRead({ counts: { account: decisionIdleCounter, organization: decisionIdleCounter, continuation: decisionIdleCounter } }),
  DecisionCountersRead({ counts: { account: { hits: 30, expiresAt: 60000 }, organization: { hits: 0, expiresAt: 86400000 }, continuation: decisionIdleCounter } }),
  DecisionCountersRead({ counts: { account: { hits: 2, expiresAt: 60000 }, organization: { hits: 2000, expiresAt: 86400000 }, continuation: decisionIdleCounter } }),
  DecisionCountersRead({ counts: { account: { hits: 2, expiresAt: 60000 }, organization: { hits: 4000, expiresAt: 86400000 }, continuation: { hits: 60, expiresAt: 60000 } } }))
pure val decisionFundingValues = Set(BaseDecisionFunding, FundedDecisionFunding, SubscribedDecisionFunding({ rpm: 60 }))
pure val subscribedRpmValues = Set(0, 60, 120)
pure val addedCreditsValues = Set(0, 4999999, 5000000)
pure val decisionNowValues = Set(0, 1, 59999, 60000, 86400000)
pure val decisionViewValues = DecisionSessions::viewValues
pure val decisionExpectedValues = Set(AnyCurrentDecisionAccount, ExpectedDecisionAccount({ id: "owner" }), ExpectedDecisionAccount({ id: "other" }))

pure def lawDifferentExpectedAccountCannotDispatch(decisionView: DecisionSessions::CredentialView, accountId: str, expectedId: str,
  decisionRequest: DecisionRequest, decisionCounters: DecisionCounterRead, decisionFunding: DecisionFunding, decisionNow: Millis, bindingPresent: bool): bool =
  expectedId != accountId implies decisionDispatch(decisionView, accountId, ExpectedDecisionAccount({ id: expectedId }), decisionRequest, decisionCounters, decisionFunding, decisionNow, bindingPresent) == DecisionNotDispatched
pure def lawInactiveDecisionCredentialCannotDispatch(decisionView: DecisionSessions::CredentialView, accountId: str, decisionExpected: DecisionExpectedAccount,
  decisionRequest: DecisionRequest, decisionCounters: DecisionCounterRead, decisionFunding: DecisionFunding, decisionNow: Millis, bindingPresent: bool): bool =
  DecisionSessions::admitRequest(decisionView, DecisionSessions::ServiceAccess, decisionNow) != DecisionSessions::CredentialAccepted implies
    decisionDispatch(decisionView, accountId, decisionExpected, decisionRequest, decisionCounters, decisionFunding, decisionNow, bindingPresent) == DecisionNotDispatched

pure def lawUnavailableDecisionStoreCannotDispatch(decisionFunding: DecisionFunding, decisionNow: Millis): bool =
  decisionQuotaAdmission(DecisionStoreUnavailable, decisionFunding, decisionNow) == DecisionNotDispatched
pure def lawDecisionAdmissionCountsWithinTheLimits(decisionCounters: DecisionCounterRead, decisionFunding: DecisionFunding, decisionNow: Millis): bool = {
  val decisionOutcome = decisionQuotaAdmission(decisionCounters, decisionFunding, decisionNow)
  match decisionOutcome {
    | DecisionDispatched(admitted) => admitted.counts.account.hits > 0 and admitted.counts.account.hits <= 30
        and (admitted.scope == OrganizationDayScope implies (admitted.counts.organization.hits > 0 and admitted.counts.organization.hits <= 4000
          and (decisionFunding == BaseDecisionFunding implies admitted.counts.organization.hits <= 2000)))
    | DecisionNotDispatched => true
  }
}
pure def lawOnlyASubscriptionContinuesPastTheDailyLimit(decisionCounters: DecisionCounterRead, decisionFunding: DecisionFunding, decisionNow: Millis): bool = {
  val decisionOutcome = decisionQuotaAdmission(decisionCounters, decisionFunding, decisionNow)
  match decisionOutcome {
    | DecisionDispatched(admitted) => admitted.scope == SubscriptionMinuteScope implies (decisionFunding != BaseDecisionFunding and decisionFunding != FundedDecisionFunding)
    | DecisionNotDispatched => true
  }
}
pure def lawAGrantOrSmallFundingKeepsTheBaseLimit(addedCredits: Micros): bool =
  addedCredits < decisionFundedCredits implies decisionDailyLimit(decisionFundingOf(0, addedCredits)) == decisionOrganizationLimit
```

### A choice answer names an offered candidate or no match and authorizes no browser action

A successful choice comes from the fixed Clef model and has exactly one
probability key for every offered candidate plus `none`. The JSON schema
checks each probability and confidence is finite and between zero and one;
it makes no promise about their sum or the quality of the selection. An
unknown candidate, wrong model or incomplete key set becomes unavailable.
The result carries a choice value only. The browser owns checking that its
page is still current and approving any action.

```quint
type DecisionProviderModel = DecisionClefShortName | DecisionClefFullName | DecisionOtherModel
type DecisionChoiceValue = DecisionNoMatch | DecisionCandidateId({ id: str })
type DecisionChoiceOutcome = DecisionChoiceUnavailable | DecisionChoiceAvailable({ choice: DecisionChoiceValue })
pure def decisionProbabilityKeysFit(candidates: List[DecisionCandidate], probabilityIds: List[str]): bool =
  probabilityIds.length() == candidates.length() + 1 and probabilityIds.includes("none") and
  candidates.every(c => probabilityIds.includes(c.id)) and
  probabilityIds.every(id => probabilityIds.select(other => other == id).length() == 1 and (id == "none" or candidates.some(c => c.id == id)))
pure def decisionChoiceOffered(candidates: List[DecisionCandidate], choice: DecisionChoiceValue): bool = match choice {
  | DecisionNoMatch => true
  | DecisionCandidateId(selected) => candidates.some(c => c.id == selected.id)
}
pure def decisionChoiceOutcome(candidates: List[DecisionCandidate], providerModel: DecisionProviderModel, choice: DecisionChoiceValue, probabilityIds: List[str]): DecisionChoiceOutcome =
  if (decisionCandidatesFit(candidates) and providerModel != DecisionOtherModel and decisionProbabilityKeysFit(candidates, probabilityIds) and decisionChoiceOffered(candidates, choice))
    DecisionChoiceAvailable({ choice: choice })
  else DecisionChoiceUnavailable
pure val providerModelValues = Set(DecisionClefShortName, DecisionClefFullName, DecisionOtherModel)
pure val choiceValues = Set(DecisionNoMatch, DecisionCandidateId({ id: "hours" }), DecisionCandidateId({ id: "older-snapshot" }))
pure val probabilityIdsValues = Set(List(), List("hours", "none"), List("none", "none"), List("hours", "older-snapshot", "none"))
pure def lawDecisionChoiceNeverIntroducesAnUnofferedCandidate(candidates: List[DecisionCandidate], providerModel: DecisionProviderModel, choice: DecisionChoiceValue, probabilityIds: List[str]): bool = {
  val decisionOutcome = decisionChoiceOutcome(candidates, providerModel, choice, probabilityIds)
  match decisionOutcome {
    | DecisionChoiceAvailable(result) => decisionChoiceOffered(candidates, result.choice)
    | DecisionChoiceUnavailable => true
  }
}
```
