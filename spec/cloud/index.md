# Hosted services

Identity and sessions, native clients and device keys, billing and
entitlements, metered inference, speech and maps, and managed Google. The
cloud hosts no agent. Its specifications are being written.

## Story: Use inference on my subscription or funded pilot account

> As a subscriber or funded pilot, I can send a request to the deployment's model.
> My account shows the subscription the billing provider currently recognizes.

### A request needs an active account and sufficient funding for its quote

The deployment uses the [shared hold](./shared/metering.md) to reserve the
quote before contacting a provider. A paid period supplies its remaining
[allowance](./billing/allowance.md) first. Other readable plans use the
account's [funded credits](./billing/funds.md). A repeated hold key reuses
the existing outcome. Model prices and reported token counts follow the
[model catalog](./services/models.md).

```quint
pure def mayDispatchFundedRequest(authenticated: bool, freshHold: bool, dispatchCommitted: bool): bool =
  authenticated and freshHold and dispatchCommitted
pure def lawPaidAccessRequiresIdentity(freshHold: bool, dispatched: bool): bool =
  not(mayDispatchFundedRequest(false, freshHold, dispatched))
pure def lawDuplicateCannotSpendAgain(authenticated: bool, dispatched: bool): bool =
  not(mayDispatchFundedRequest(authenticated, false, dispatched))
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
and its verified return address while signed in. Only the device proving possession of the grant’s verifier can redeem it, once. The device
acknowledges receipt before it can use the key. Signing out stops activation
of an unfinished grant. An active key continues to authorize inference and
consented speech until its deadline or its own revocation.

```quint
pure def canExchangeCloudDeviceGrant(grantEndsAt: int, nowAt: int, grantUnspent: bool, verifierMatches: bool, browserSessionActive: bool): bool =
  nowAt < grantEndsAt and grantUnspent and verifierMatches and browserSessionActive

pure def cloudDeviceAllows(deviceEndsAt: int, nowAt: int, acknowledged: bool, inferenceRequested: bool, consentedSpeechRequested: bool): bool =
  cloudSessionAllows(deviceEndsAt, nowAt, acknowledged) and (inferenceRequested or consentedSpeechRequested)
```

## Story: Connect Google mail and calendar

> As a signed-in person, I can choose to connect Google mail, my primary
> calendar or both. I can read the Gmail inbox and Calendar events I
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
have separate permissions.

```quint
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

## Story: Use a cloud speech session

> As a signed-in person with a subscription or funded pilot account, I can
> explicitly allow a bounded microphone and speech playback session. The
> app can stop the session and never receives the voice provider's keys.

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

## Story: Back up my passwords for another device

> As a person using Passwords, I can choose to keep an encrypted backup.
> I can restore it on another device with my recovery key or remove the
> backup when I no longer want it.

### Only a current, separately approved device grant accesses the owner’s backup

Opting in needs an explicit native request and recent interactive approval.
The first-party browser shows the purpose and signed-in account before the
owner approves. Approval returns a single-use code through the exact
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
body and provider wait are bounded.

The deployment's Workers AI binding enables Clef decisions with
`@cf/cloudflare/clef-flash`. An unavailable binding or invalid
answer yields a typed unavailable result. Each dispatch counts against
thirty calls per minute per account and two thousand per day per
organization. An unavailable limiter blocks dispatch.
