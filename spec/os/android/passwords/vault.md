# Password vault page

The device keeps saved passwords in one native vault: an AES-GCM frame in
no-backup storage under an Android Keystore key that needs a fresh strong
biometric or device-credential unlock, valid for a short window. A
consumer's own vault page reaches it through the `ElizaPasswords` bridge
([bridge vocabulary](../bridge.md)) and the validating passwords client.
This machine follows one vault page in the app's foreground: what it may
hold, when, and on which native evidence. The vault records, the unlock
window, reveal, copy and the native protected editor stay in the Java
shell; system Autofill is [autofill custody](./autofill.md). Sources:
`PasswordsPlugin`, `PasswordVaultAccess` and `src/{client,definitions}.ts`
of `plugins/plugin-native-passwords`.

## Story: Keep secrets typed only in an unlocked page

> As an owner, I want to see and edit my saved passwords only on a page I
> opened and unlocked myself, with the agent shut out and nothing secret
> left behind when I leave, so that unlocking the vault never leaks a
> password.

### A vault page opens only when the bridge, a secure screen lock and the host's admission all allow it

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
```

### Only Android's own authentication unlocks the page

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
pure def canLockVault(s: VaultUi): bool = s.view == PageUnlocked
pure def lockVault(s: VaultUi): VaultUi = { view: PageLocked, generation: s.generation + 1, listed: false, form: NoForm }
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

> As an owner whose saved passwords can no longer be decrypted (for
> example, after I removed the screen lock), I want the vault deleted only
> when I confirm it and authenticate again, so that nothing erases my
> passwords by accident.

### A vault whose key is invalidated forgets everything the page held and offers only a reset

A key-invalidated reply, to an unlock or to a vault call, is final for the
records: they can never be read again, so the page drops its listing and
form and is left only with a reset or leaving.

```quint
pure def canKeyInvalidated(s: VaultUi, ticket: int): bool = (s.view == PageLocked or s.view == PageUnlocked) and ticket == s.generation
pure def keyInvalidated(s: VaultUi, ticket: int): VaultUi = { view: PageDamaged, generation: s.generation + 1, listed: false, form: NoForm }
pure def damaged(view: VaultView): bool = view == PageDamaged or view == PageResetReviewed
pure def stepDamagedVaultLeavesOnlyByResetOrLeaving(before: VaultUi, via: str, after: VaultUi): bool =
  (damaged(before.view) and not(damaged(after.view))) implies
    ((via == "resetConfirmed" and before.view == PageResetReviewed) or after.view == PageClosed)
pure def alwaysDamagedPageHoldsNothing(s: VaultUi): bool = damaged(s.view) implies (not(s.listed) and s.form == NoForm)
```

### Reset needs the owner's review and a fresh Android authentication after it, in the same visit

Reviewing the reset starts a new generation, so an authentication begun
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
