# Hosted services

Identity and sessions, native clients and device keys, billing and
entitlements, metered inference, speech and maps, and managed Google. The
cloud hosts no agent. Its specifications are being written.

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
person approves each requested scope. A deployment can use its sign-in OAuth
client for this separate exchange. The exchange requests only the selected read
scopes and identity needed to link the right account. The verified Google subject
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

## Story: Back up my passwords for another device

> As a person using Passwords, I can choose to keep an encrypted backup.
> I can restore it on another device with my recovery key or remove the
> backup when I no longer want it.

### Only a current, separately approved device grant accesses the owner’s backup

Opting in needs an explicit native request and recent interactive approval. The
registered native client binds the approval to its own one-time verifier.
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
type PasswordBackupPurpose = BackupRead | BackupWrite | BackupRemove
pure def canApprovePasswordBackup(active: bool, recent: bool, registered: bool): bool =
  active and recent and registered
pure def lawStaleSignInCannotApprovePasswordBackup(active: bool, registered: bool): bool =
  not(canApprovePasswordBackup(active, false, registered))
pure def canRedeemBackupApproval(approved: PasswordBackupPurpose, requested: PasswordBackupPurpose, exactVerifier: bool, exactState: bool, grantLive: bool, unspent: bool): bool =
  approved == requested and exactVerifier and exactState and grantLive and unspent
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
