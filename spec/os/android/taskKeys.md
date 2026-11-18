# Task keys

The agent seals its task records under a storage key that os keeps on the
device, one per signed-in account. Each key is 32 random bytes in its own
secure store slot (`./secureStore.md`), wrapped by a Keystore key of its
own, and the slot is named by the account's verified owner identity
(`cloud-owner-v1:` and the SHA-256 of the deployment authority, the user id
and the organization id), so the slot is bound to the verified account
record and no other account can reach it. The account comes from the
device credential (`spec/os/signIn/credential.md`): its `Announce`,
`SignedOutNotice` and the reset of the device. The agent service writes the
current account's key into the launch frame's `storageKey`
(`spec/agent/host/launch.md`), and the agent derives its per-purpose keys
from it. There is no other way out for a key: no database binding, no
broker, no native addon. Key bytes stay in the Java shell; the model sees
the account, a key number, the launch epoch and the outcome. Sources:
`VerifiedTaskCustody`, `TaskDataKeyStore`, `VerifiedAccountCredentialStore`
and `VerifiedOwnerIdentity` of develop.

## Story: Keep each account's tasks under its own key

> As a person who signs in on this device, I want my agent's task records
> sealed under a key kept only for my account and handed to my agent only
> when it starts for me, so that no other account, app view or model can
> read them.

### Each account has at most one task key, and a stored key is never replaced

A key is created only when its slot reads absent. A slot whose wrapping key
is gone, or whose frame cannot be opened, stays unreadable: the release is
refused and nothing creates a new key in its place, because the tasks
sealed under the old key would be lost without a word. A key already known
for the account is read again, never created again: a slot of a known key
that reads absent is unreadable too.

```quint
import credential as C from "../signIn/credential"
import secureStore as S from "./secureStore"
type TaskKey = { account: C::Account, key: int }
type KeyRelease = NoRelease | Released({ account: C::Account, epoch: int, key: int })
type TaskKeyCustody = { verified: C::Account, keys: List[TaskKey], lastKey: int, lastEpoch: int, release: KeyRelease }
type CustodyAnswer = StorageKeyReleased({ epoch: int, key: int }) | StorageKeyUnavailable
type CustodyStep = { state: TaskKeyCustody, out: List[CustodyAnswer] }
pure val initial: TaskKeyCustody = { verified: C::noAccount, keys: List(), lastKey: 0, lastEpoch: 0, release: NoRelease }
pure def keyOf(account: C::Account, s: TaskKeyCustody): int = s.keys.foldl(0, (found, t) => if (t.account == account) t.key else found)
pure def keyReadable(held: int, observed: S::SlotRead): bool =
  if (observed == S::Unreadable) false else if (observed == S::Absent) held == 0 else true
pure def alwaysOneKeyPerAccount(s: TaskKeyCustody): bool =
  s.keys.every(t => t.account.userId != "" and t.key >= 1 and t.key <= s.lastKey and s.keys.select(u => u.account == t.account).length() == 1)
pure def stepAStoredKeyIsNeverReplaced(before: TaskKeyCustody, after: TaskKeyCustody): bool = before.keys.every(t => after.keys.includes(t))
pure def lawAnUnreadableSlotIsNeverInitialized(held: int): bool = not(keyReadable(held, S::Unreadable))
```

### The current account's key is released only as the storage key of a launch newer than every earlier one

The agent service asks for the key while it writes the launch frame of a
new launch epoch, for the account it launches. The release is refused for
an account other than the verified one, and for an epoch that is not newer
than every epoch asked before, so a release that was retired, or a frame
already written, is never answered again. A refusal for an unreadable key
still uses up its epoch. Each answer is the key of the
launch's account and nothing else.

```quint
pure def canRelease(s: TaskKeyCustody, account: C::Account, epoch: int): bool =
  account.userId != "" and account.organizationId != "" and account == s.verified and epoch > s.lastEpoch
pure def release(s: TaskKeyCustody, account: C::Account, epoch: int, observed: S::SlotRead): CustodyStep = {
  val held = keyOf(account, s)
  val key = if (held >= 1) held else s.lastKey + 1
  if (not(keyReadable(held, observed))) { state: { ...s, lastEpoch: epoch, release: NoRelease }, out: List(StorageKeyUnavailable) }
  else { state: { ...s, lastEpoch: epoch, lastKey: if (held >= 1) s.lastKey else key,
      keys: if (held >= 1) s.keys else s.keys.append({ account: account, key: key }),
      release: Released({ account: account, epoch: epoch, key: key }) },
    out: List(StorageKeyReleased({ epoch: epoch, key: key })) }
}
pure val epochValues = Set(1, 2, 3)
pure val weight_release = 4
pure def releasedEpoch(r: KeyRelease): int = match r { | Released(x) => x.epoch | NoRelease => 0 }
pure def alwaysReleaseIsTheVerifiedAccountsKey(s: TaskKeyCustody): bool = { val r = s.release  match r {
  | Released(x) => x.account == s.verified and x.epoch == s.lastEpoch and x.epoch >= 1 and keyOf(x.account, s) == x.key
  | NoRelease => true } }
pure def stepAReleaseNamesANewerLaunch(before: TaskKeyCustody, via: str, after: TaskKeyCustody, out: List[CustodyAnswer]): bool =
  (after.lastEpoch >= before.lastEpoch)
    and ((after.release != NoRelease and after.release != before.release) implies (via == "release" and releasedEpoch(after.release) > before.lastEpoch))
    and (out.length() >= 1 implies via == "release")
pure def sometimesReleased(s: TaskKeyCustody): bool = s.release != NoRelease
pure def sometimesSameKeyForALaterLaunch(s: TaskKeyCustody): bool = releasedEpoch(s.release) >= 2 and s.keys.length() == 1
pure def sometimesEachAccountHasItsOwnKey(s: TaskKeyCustody): bool = s.keys.length() >= 2
pure def sometimesRefusedForAnUnreadableKey(s: TaskKeyCustody): bool = s.lastEpoch >= 1 and s.release == NoRelease and s.keys.length() == 0 and s.verified != C::noAccount
```

### An account change, a sign-out or a reset retires the release

A new account announced by the device credential, a sign-out (the person's
or the cloud's) and a reset of the device retire the current release: the
holder the agent service received is wiped, and the next release needs a
new launch epoch of the verified account. A new key of the same account
keeps the release. The keys stay in their slots, so an account that signs
in again opens its own tasks; the reset of the device removes the slots
with the rest of its no-backup storage.

```quint
pure def canAccountVerified(s: TaskKeyCustody, account: C::Account): bool = account.userId != "" and account.organizationId != ""
pure def accountVerified(s: TaskKeyCustody, account: C::Account): TaskKeyCustody =
  if (account == s.verified) s else { ...s, verified: account, release: NoRelease }
pure def canSignedOut(s: TaskKeyCustody): bool = s.verified != C::noAccount
pure def signedOut(s: TaskKeyCustody): TaskKeyCustody = { ...s, verified: C::noAccount, release: NoRelease }
pure def reset(s: TaskKeyCustody): TaskKeyCustody = { ...s, verified: C::noAccount, release: NoRelease }
pure def stepAnAccountChangeRetiresTheRelease(before: TaskKeyCustody, after: TaskKeyCustody): bool =
  after.verified != before.verified implies after.release == NoRelease
pure def sometimesRetiredAfterAccountChange(s: TaskKeyCustody): bool = s.release == NoRelease and s.keys.length() >= 1 and s.verified != C::noAccount and keyOf(s.verified, s) == 0
pure def sometimesSignedInAgainToOwnKey(s: TaskKeyCustody): bool = s.release != NoRelease and s.keys.length() >= 2 and releasedEpoch(s.release) >= 3
```
