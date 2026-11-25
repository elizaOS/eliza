# Password vault page

The native vault stores saved passwords in an AES-GCM frame in no-backup
storage under an Android Keystore key. The host selects the custody mode.
Timed custody requires a fresh strong biometric or device-credential unlock
for a short access window. Device-unlocked custody admits the current owner
in the foreground on an unlocked device, even without a secure screen lock.
A consumer's own vault page reaches it through the `ElizaPasswords` bridge
([bridge vocabulary](../bridge.md)) and the validating passwords client.
`VaultUi` follows a timed-custody page in the app's foreground: what it may
hold, when, and on which native evidence, and the decisions the native side
makes when it delivers a revealed or copied password. The vault records,
the unlock window, the reveal dialog and the native protected editor stay
in the Java shell; system Autofill is [autofill custody](./autofill.md).
Sources: `PasswordsPlugin`, `PasswordVaultAccess`, `PasswordClipboard` and
`src/{client,definitions}.ts` of `plugins/plugin-native-passwords`.

## Story: Keep secrets typed only in an unlocked page

> As an owner, I want to see and edit my saved passwords only on a page I
> opened and unlocked myself, with the agent shut out and nothing secret
> left behind when I leave, so that unlocking the vault never leaks a
> password.

### Opening a vault page in timed custody requires the bridge, a secure screen lock and the host's admission

The vault call needs the registered plugin, the app in the foreground on an
unlocked device, and a secure screen lock (Android's `isDeviceSecure`, the
device feature here; without it the page shows the vault as unavailable).
The host's admission rule (for example, that the signed-in account owns the
vault) is asked again by every native call that reaches the vault. Leaving
the page, the app going to the background or the host Activity stopping
closes it, locks the vault and forgets everything the page held.

```quint
import bridge.* from "../bridge"
type VaultView = PageClosed | PageLocked | PageUnlocked | PageDamaged | PageResetReviewed
type EntryForm = NoForm | FormWithoutSecret | FormWithTypedSecret
type VaultUi = { view: VaultView, generation: int, listed: bool, form: EntryForm }
pure val initial: VaultUi = { view: PageClosed, generation: 0, listed: false, form: NoForm }
pure val vaultCall: BridgeCall = { need: WhileUnlocked, needsGrant: false, needsFeature: true }
pure def canOpenVault(s: VaultUi, presence: PluginPresence, facts: HostFacts, admitted: bool): bool =
  s.view == PageClosed and admitCall(presence, vaultCall, facts) == CallAdmitted and admitted
pure def openVault(s: VaultUi, presence: PluginPresence, facts: HostFacts, admitted: bool): VaultUi =
  { view: PageLocked, generation: s.generation + 1, listed: false, form: NoForm }
pure def canLeaveVault(s: VaultUi): bool = s.view != PageClosed
pure def leaveVault(s: VaultUi): VaultUi = { view: PageClosed, generation: s.generation + 1, listed: false, form: NoForm }
pure def agentMayObserve(s: VaultUi): bool = s.view == PageClosed
```

### A native reply counts only for the page generation that asked for it

Every change of the page's access starts a new generation, and so does an
explicit refresh; each native request carries the generation it was sent
in, and its reply is dropped when that is no longer current. A refresh also
withdraws a pending reset review.

```quint
pure def canRefreshVault(s: VaultUi): bool = s.view != PageClosed
pure def refreshVault(s: VaultUi): VaultUi =
  { ...s, generation: s.generation + 1, view: if (s.view == PageResetReviewed) PageDamaged else s.view }
pure def stepGenerationNeverGoesBack(before: VaultUi, after: VaultUi): bool = after.generation >= before.generation
pure def stepAccessChangeStartsNewGeneration(before: VaultUi, after: VaultUi): bool =
  before.view != after.view implies after.generation > before.generation
```

### Only Android's own authentication unlocks a vault in timed custody

`unlocked` is the native unlock result for the current generation. A
cancelled or failed prompt changes nothing. The only other way in is the
fresh authentication of a reviewed reset (below).

```quint
pure def canUnlocked(s: VaultUi, ticket: int): bool = s.view == PageLocked and ticket == s.generation
pure def unlocked(s: VaultUi, ticket: int): VaultUi = { ...s, view: PageUnlocked, generation: s.generation + 1 }
pure def stepOnlyNativeAuthenticationUnlocks(before: VaultUi, via: str, after: VaultUi): bool =
  (before.view != PageUnlocked and after.view == PageUnlocked) implies
    ((via == "unlocked" and before.view == PageLocked) or (via == "resetConfirmed" and before.view == PageResetReviewed))
```

### The page sees vault entries only as metadata, and only while it is unlocked

A listing is ids, labels, usernames, bindings, times and revisions. The
client rebuilds every reply from allowlisted fields, and a reply carrying a
secret-like field is refused whole: nothing of it is shown.

```quint
type ListReply = MetadataOnly | CarriesSecretField
pure def canListed(s: VaultUi, ticket: int, reply: ListReply): bool = s.view == PageUnlocked and ticket == s.generation
pure def listed(s: VaultUi, ticket: int, reply: ListReply): VaultUi = { ...s, listed: reply == MetadataOnly }
pure def alwaysListingOnlyWhileUnlocked(s: VaultUi): bool = s.listed implies s.view == PageUnlocked
pure def sometimesMetadataListed(s: VaultUi): bool = s.listed
```

### Outside the vault page, an app learns only whether any password is saved

A consumer may show, outside its vault page, whether any password is saved
(Grace's Home card says "Kept only on this tablet" or offers to save one),
and nothing more. `anySaved` answers that one yes or no: no label, username,
binding, count or time crosses. The native side answers only when it would
list the entries for the same caller (admitted, and unlocked or in an open
device-unlocked window); otherwise it refuses, as `list` does, and the
consumer shows that it does not know. The client decodes the reply exactly,
so a reply carrying any other field is refused whole.

```quint
type SavedReply = AnySaved | NoneSaved | SavedRefused
type SavedAsk = { readable: bool, entries: int, otherFields: bool }
pure def savedReply(ask: SavedAsk): SavedReply =
  if (not(ask.readable) or ask.otherFields) SavedRefused
  else if (ask.entries > 0) AnySaved
  else NoneSaved
pure def lawSavedReplyIsOneBit(ask: SavedAsk): bool =
  savedReply(ask) == savedReply({ ...ask, entries: if (ask.entries > 0) 1 else 0 }) and
  (not(ask.readable) implies savedReply(ask) == SavedRefused) and
  (ask.otherFields implies savedReply(ask) == SavedRefused)
pure val askValues = Set(
  { readable: true, entries: 0, otherFields: false }, { readable: true, entries: 1, otherFields: false },
  { readable: true, entries: 3, otherFields: false }, { readable: false, entries: 3, otherFields: false },
  { readable: true, entries: 3, otherFields: true })
```

### A typed password lives only in an open form of an unlocked page

The page holds a password only while the owner types it into the entry form
and only until the vault confirms the save; leaving the form, locking or
leaving the page forgets the whole form. When the unlock window ends (or a
native reply says the vault is locked), the typed password is dropped but
the form's name, username and websites are kept hidden until a fresh
unlock, and the owner must type the password again. A host that keeps
passwords out of the bridge uses the native editor instead, and its page
never types one.

```quint
pure def canOpenForm(s: VaultUi): bool = s.view == PageUnlocked
pure def openForm(s: VaultUi): VaultUi = { ...s, form: FormWithoutSecret }
pure def canTypeSecret(s: VaultUi): bool = s.view == PageUnlocked and s.form != NoForm
pure def typeSecret(s: VaultUi): VaultUi = { ...s, form: FormWithTypedSecret }
pure def canSaveConfirmed(s: VaultUi, ticket: int): bool = s.view == PageUnlocked and s.form != NoForm and ticket == s.generation
pure def saveConfirmed(s: VaultUi, ticket: int): VaultUi = { ...s, form: NoForm, listed: false }
pure def canLeaveForm(s: VaultUi): bool = s.form != NoForm
pure def leaveForm(s: VaultUi): VaultUi = { ...s, form: NoForm }
pure def canExpireUnlock(s: VaultUi): bool = s.view == PageUnlocked
pure def expireUnlock(s: VaultUi): VaultUi =
  { view: PageLocked, generation: s.generation + 1, listed: false, form: if (s.form == NoForm) NoForm else FormWithoutSecret }
pure def canLockVault(s: VaultUi): bool = s.view == PageUnlocked or s.view == PageResetReviewed
pure def lockVault(s: VaultUi): VaultUi =
  { view: if (s.view == PageResetReviewed) PageDamaged else PageLocked, generation: s.generation + 1, listed: false, form: NoForm }
pure def alwaysTypedSecretOnlyWhileUnlocked(s: VaultUi): bool = s.form == FormWithTypedSecret implies s.view == PageUnlocked
pure def alwaysFormOnlyOnReadablePage(s: VaultUi): bool = s.form != NoForm implies (s.view == PageUnlocked or s.view == PageLocked)
pure def sometimesTypedSecretInForm(s: VaultUi): bool = s.form == FormWithTypedSecret
pure def sometimesExpiredFormKeptWithoutSecret(s: VaultUi): bool = s.view == PageLocked and s.form == FormWithoutSecret
```

### The agent observes nothing while the page holds vault data

The consumer pauses agent observation of the screen for as long as a vault
page is open, so a listing or a form is never in front of the agent.

```quint
pure def alwaysAgentPausedWhileVaultDataHeld(s: VaultUi): bool = (s.listed or s.form != NoForm) implies not(agentMayObserve(s))
```

## Story: Reset a damaged vault only on purpose

> As an owner using timed custody, if my saved passwords can no longer
> be decrypted (for example, after I removed the screen lock), I want the
> vault deleted only when I confirm it and authenticate again, so that
> nothing erases my passwords by accident.

### A vault whose key is invalidated forgets everything the page held and offers only a reset

Only a call that reaches the records while unlocked can learn this (an
unlock prompt never touches the key). The native side locks the vault, and
the reply is final for the records: they can never be read again, so the
page drops its listing and form and is left only with a reset or leaving.

```quint
pure def canKeyInvalidated(s: VaultUi, ticket: int): bool = s.view == PageUnlocked and ticket == s.generation
pure def keyInvalidated(s: VaultUi, ticket: int): VaultUi = { view: PageDamaged, generation: s.generation + 1, listed: false, form: NoForm }
pure def damaged(view: VaultView): bool = view == PageDamaged or view == PageResetReviewed
pure def stepDamagedVaultLeavesOnlyByResetOrLeaving(before: VaultUi, via: str, after: VaultUi): bool =
  (damaged(before.view) and not(damaged(after.view))) implies
    ((via == "resetConfirmed" and before.view == PageResetReviewed) or after.view == PageClosed)
pure def alwaysDamagedPageHoldsNothing(s: VaultUi): bool = damaged(s.view) implies (not(s.listed) and s.form == NoForm)
```

### Resetting a vault in timed custody requires the owner's review followed by fresh Android authentication in the same visit

For timed custody, reviewing the reset starts a new generation, so an authentication begun
before the review cannot confirm it; a refresh, a lock or leaving withdraws
the review. `resetConfirmed` is Android's authentication for the reviewed
reset followed by the native reset, which deletes only a vault that can
never be decrypted. The empty vault is then unlocked by that
authentication.

```quint
pure def canReviewReset(s: VaultUi): bool = s.view == PageDamaged
pure def reviewReset(s: VaultUi): VaultUi = { ...s, view: PageResetReviewed, generation: s.generation + 1 }
pure def canResetConfirmed(s: VaultUi, ticket: int): bool = s.view == PageResetReviewed and ticket == s.generation
pure def resetConfirmed(s: VaultUi, ticket: int): VaultUi = { view: PageUnlocked, generation: s.generation + 1, listed: false, form: NoForm }
pure def sometimesResetReviewed(s: VaultUi): bool = s.view == PageResetReviewed
```

## Story: Keep revealed and copied passwords with their current owner

> As the owner of the saved passwords, I can reveal or copy a password after
> unlocking. Signing out ends the old owner's access even if a request is
> already waiting on the app's main thread.

### Native secret delivery checks the current owner and original unlock

A reveal or copy carries the generation it was asked in, and the native
side delivers it on the main thread only while the page is still unlocked
in that generation and the host still admits the owner. Signing the owner
out (the host's `lockAndClose`) locks the vault and closes the page and
any reveal, so a delivery already queued is refused: a generation, once
left, never comes back. Retirement captures both the revealed password and
the native confirmation it owns. A delayed close or reveal handle closes
only those captured dialogs, leaving later dialogs with a new owner open.
Stopping or destroying an Activity closes only its own native dialogs;
an old Activity cannot close a replacement Activity's reveal or confirmation.

```quint
pure def mayDeliverVaultSecret(s: VaultUi, ticket: int, admitted: bool): bool =
  s.view == PageUnlocked and ticket == s.generation and admitted
pure def lawRetiredOwnerReceivesNoSecret(s: VaultUi, ticket: int): bool =
  not(mayDeliverVaultSecret(s, ticket, false)) and not(mayDeliverVaultSecret(leaveVault(s), ticket, true))
```

### A copied password is cleared from the clipboard only while it is still the app's own clip

A copy holds a clipboard lease. Ordinary backgrounding keeps it, so the
owner can paste until it ends; signing out retires it at once. A lease that
is due checks the clip Android shows: the app's own tagged clip is cleared,
another app's clip is left alone and the lease ends, and when Android hides
the clip (the app has no input focus) the lease waits for the next resume.

```quint
type ClipLease = NoLease | LeaseHeld | LeaseRetired
type ShownClip = OwnClipShown | OtherClipShown | ClipHidden
type ClipStep = { lease: ClipLease, clears: bool }
pure def onClipCheck(lease: ClipLease, deadlineReached: bool, shown: ShownClip): ClipStep =
  if (lease == NoLease or (lease == LeaseHeld and not(deadlineReached)) or shown == ClipHidden) { lease: lease, clears: false }
  else { lease: NoLease, clears: shown == OwnClipShown }
pure def lawOnlyOwnClipIsCleared(lease: ClipLease, deadlineReached: bool, shown: ShownClip): bool =
  onClipCheck(lease, deadlineReached, shown).clears implies (shown == OwnClipShown and lease != NoLease)
pure def lawHeldLeaseLastsUntilDeadline(shown: ShownClip): bool =
  onClipCheck(LeaseHeld, false, shown) == { lease: LeaseHeld, clears: false }
pure def lawRetiredLeaseClearsAtOnce(deadlineReached: bool): bool =
  onClipCheck(LeaseRetired, deadlineReached, OwnClipShown).clears
pure def lawHiddenClipKeepsTheLease(lease: ClipLease, deadlineReached: bool): bool =
  onClipCheck(lease, deadlineReached, ClipHidden).lease == lease
```

### A row action acts on the revision the owner selected

Remove, reveal and copy can carry the displayed revision. The native vault
checks it at delivery, in the same locked operation that reads or removes
the record. If Android Autofill saved a newer revision or the entry has
disappeared, the action reports a conflict and leaves the stored vault
unchanged. ID-only callers still use a current record.

```quint
type RowSelection = ById | AtRevision({ rev: int })
pure val selectionValues = Set(ById, AtRevision({ rev: 0 }), AtRevision({ rev: 1 }))
type VaultRecordRevision = MissingRecord | CurrentRecord({ rev: int })
pure val storedValues = Set(MissingRecord, CurrentRecord({ rev: 0 }), CurrentRecord({ rev: 1 }))
pure def mayUseSelectedVaultRecord(selection: RowSelection, stored: VaultRecordRevision): bool =
  match stored {
    | MissingRecord => false
    | CurrentRecord(row) => match selection {
        | ById => true
        | AtRevision(expected) => expected.rev == row.rev
      }
  }
pure def lawChangedRevisionRefusesRowAction(expected: int, presentRevision: int): bool =
  (expected != presentRevision) implies not(mayUseSelectedVaultRecord(AtRevision({ rev: expected }), CurrentRecord({ rev: presentRevision })))
pure def lawMissingRecordRefusesRowAction(selection: RowSelection): bool =
  not(mayUseSelectedVaultRecord(selection, MissingRecord))
```

## Story: Approve a password backup in the shared cloud

> As the person using a password vault with my cloud account, I can confirm
> each backup action at the cloud this device signed in to, and keep all
> recovery material in the native vault.

### Shared backup is offered only when its exact native app is ready

The device uses the native contract when the selected cloud advertises
version 3 for the exact registered app, environment and callback. Checking
eligibility does not open a challenge.

```quint
pure def sharedBackupServiceReady(version3Available: bool, exactNativeAppReady: bool): bool =
  version3Available and exactNativeAppReady
pure def lawSharedBackupNeedsItsOwnNativeApp(version3Available: bool): bool =
  not(sharedBackupServiceReady(version3Available, false))
```

### Shared approval requires the registered cloud and the current owner

The device asks for an approval with its registered client and environment
and the acknowledged device credential of the current cloud account. Each
backup action needs a fresh confirmation by the account holder at that
cloud. Native approval sends that device credential with a fresh
device-bound Google challenge and separate backup PKCE proof. The approval
counts only when it names the account and organization
of that credential, and only while the same credential is still the active
one and the request is still open; a renewed or replaced credential, a
closed request, or a locked device ends the attempt.

```quint
type SharedBackupPurpose = SharedBackupRead | SharedBackupSave | SharedBackupDelete | SharedBackupVerify
type SharedBackupBinding = { issuer: str, owner: str, organization: str, ownerGeneration: str, requestId: str, purpose: SharedBackupPurpose }
pure val requestValues = Set(
  { issuer: "production", owner: "owner", organization: "organization", ownerGeneration: "renewed", requestId: "backup", purpose: SharedBackupSave },
  { issuer: "staging", owner: "owner", organization: "organization", ownerGeneration: "renewed", requestId: "backup", purpose: SharedBackupSave },
  { issuer: "production", owner: "owner", organization: "organization", ownerGeneration: "retired", requestId: "backup", purpose: SharedBackupSave },
  { issuer: "production", owner: "other", organization: "organization", ownerGeneration: "renewed", requestId: "backup", purpose: SharedBackupSave },
  { issuer: "production", owner: "owner", organization: "other", ownerGeneration: "renewed", requestId: "backup", purpose: SharedBackupSave },
  { issuer: "production", owner: "owner", organization: "organization", ownerGeneration: "renewed", requestId: "other-request", purpose: SharedBackupSave },
  { issuer: "production", owner: "owner", organization: "organization", ownerGeneration: "renewed", requestId: "backup", purpose: SharedBackupVerify })
pure val activeValues = requestValues
pure val approvedValues = requestValues
pure def sharedBackupApprovalMatches(request: SharedBackupBinding, active: SharedBackupBinding, freshConfirmation: bool, registeredClient: bool, organizationEcho: bool, deviceReady: bool): bool =
  request.issuer != "" and request.owner != "" and request.organization != "" and request.ownerGeneration != "" and request.requestId != "" and
  request == active and freshConfirmation and registeredClient and organizationEcho and deviceReady
pure def lawSharedBackupRefusesAnotherBinding(request: SharedBackupBinding, active: SharedBackupBinding): bool =
  request != active implies not(sharedBackupApprovalMatches(request, active, true, true, true, true))
pure def lawSharedBackupNeedsAnOrganizationEcho(request: SharedBackupBinding): bool =
  not(sharedBackupApprovalMatches(request, request, true, true, false, true))
```

### One native proof authorizes one backup action

The approval binds the purpose and request to a single-use code with a
native PKCE verifier. The code and verifier stay in native custody. A read,
save, or delete may use the approval once while the device and request are
current, and a read whose request closes while it downloads keeps nothing
it received. The verification purpose checks ownership without reading,
saving, or deleting any backup. The cloud stores encrypted backup bytes and
a revision. The recovery key and plaintext stay in the native vault.

```quint
pure def sharedBackupCanSend(approved: SharedBackupBinding, active: SharedBackupBinding, deviceReady: bool, spent: bool): bool =
  sharedBackupApprovalMatches(approved, active, true, true, true, deviceReady) and not(spent) and approved.purpose != SharedBackupVerify
pure def lawSharedBackupVerificationTransfersNothing(approved: SharedBackupBinding): bool =
  approved.purpose == SharedBackupVerify implies not(sharedBackupCanSend(approved, approved, true, false))
pure def lawSharedBackupProofIsSingleUse(approved: SharedBackupBinding, active: SharedBackupBinding): bool =
  not(sharedBackupCanSend(approved, active, true, true))
```

## Story: Open saved passwords on a device without a screen lock

> As the current owner of saved passwords, I want to open Passwords while
> Android and the app are available, even on a device without a PIN.
> Reveal, copy and fill each still require my own action in a trusted
> native surface, and leaving it closes that access.

### Device-unlocked custody requires a foreground window and the current owner, even on a device without a screen lock

A native host can select device-unlocked custody. Android's unlocked user
and device state, the current foreground window and the host's current
owner admission all have to hold. A secure screen-lock setting is optional.
The key remains non-exportable in Android Keystore and the ciphertext stays
in credential-encrypted app storage. On Android 15 and newer, newly made
keys also ask Keystore to enforce device lock. Earlier supported Android
releases enforce it in the native shell. No timer ends a foreground grant.
On leaving, pausing or retiring the owner, the next window gets its own
access generation. Reveal, copy and fill still require a native user action. A device-unlocked
vault reset also needs an explicit native confirmation and refuses readable
records or a preserved legacy vault.

```quint
type DeviceVaultWindow = { foreground: bool, userUnlocked: bool, deviceUnlocked: bool, ownerAdmitted: bool, generation: int }
pure val readyWindow: DeviceVaultWindow = { foreground: true, userUnlocked: true, deviceUnlocked: true, ownerAdmitted: true, generation: 1 }
pure val windowValues = Set(readyWindow, { ...readyWindow, foreground: false }, { ...readyWindow, userUnlocked: false },
  { ...readyWindow, deviceUnlocked: false }, { ...readyWindow, ownerAdmitted: false }, { ...readyWindow, generation: 2 })
pure def deviceVaultOpen(window: DeviceVaultWindow): bool =
  window.foreground and window.userUnlocked and window.deviceUnlocked and window.ownerAdmitted
pure def deviceVaultDeliver(window: DeviceVaultWindow, requestGeneration: int, userAction: bool): bool =
  deviceVaultOpen(window) and requestGeneration == window.generation and userAction
pure def deviceVaultResetAllowed(window: DeviceVaultWindow, requestGeneration: int, confirmed: bool, damaged: bool, legacySelected: bool): bool =
  deviceVaultDeliver(window, requestGeneration, confirmed) and damaged and not(legacySelected)
pure def lawDeviceVaultResetProtectsReadableAndLegacyRecords(window: DeviceVaultWindow, requestGeneration: int, confirmed: bool, damaged: bool, legacySelected: bool): bool =
  deviceVaultResetAllowed(window, requestGeneration, confirmed, damaged, legacySelected) implies (confirmed and damaged and not(legacySelected))
pure def lawDeviceVaultDeliveryNeedsCurrentOpenWindow(window: DeviceVaultWindow, requestGeneration: int, userAction: bool): bool =
  deviceVaultDeliver(window, requestGeneration, userAction) implies
    (deviceVaultOpen(window) and requestGeneration == window.generation and userAction)
```

### An authentication-bound vault migrates only after its original key admits the saved records

The first access to a previously saved vault keeps it behind its original
Keystore authorization. After that authorization, native code may copy the
records into a distinct device-unlocked vault and verify the copy before
selecting it. The original key and ciphertext survive selection. A failed
or cancelled authorization, an unreadable source, or a different target
leaves the original selected. An empty install can open directly.

```quint
type DeviceVaultLegacy = NoLegacyRecords | LegacySelected | DeviceCustodySelected
pure def deviceVaultSelectionPermitted(legacy: DeviceVaultLegacy, originalKeyRead: bool, verifiedCopy: bool): bool =
  legacy == NoLegacyRecords or legacy == DeviceCustodySelected or (originalKeyRead and verifiedCopy)
pure def lawLegacySelectionNeedsOriginalKey(originalKeyRead: bool, verifiedCopy: bool): bool =
  deviceVaultSelectionPermitted(LegacySelected, originalKeyRead, verifiedCopy) iff (originalKeyRead and verifiedCopy)
```
