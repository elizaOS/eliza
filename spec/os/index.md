# Android device

The agent service, device sign-in and credential custody, native bridges,
device audio, browser, and the image, APK and update build library. Its
specifications are being written.

## Story: Keep revealed and copied passwords with their current owner

> As the owner of the saved passwords, I can reveal or copy a password after
> unlocking. Signing out ends the old owner's access even if a request is
> already waiting on the tablet's main thread.

### Native secret delivery checks the current owner and original unlock

The final reveal or copy needs a foreground host that still admits the
owner and the same native unlock that requested the operation. Explicit
owner retirement closes the reveal and ends the retiring clipboard lease.
Ordinary backgrounding still lets the owner paste during the normal lease.
When Android exposes clipboard ownership, the app attempts to clear only
its own tagged clip. If ownership is currently hidden, cleanup waits for
input focus.

```quint
pure def mayDeliverQueuedVaultSecret(foreground: bool, currentOwner: bool, sameUnlock: bool): bool =
  foreground and currentOwner and sameUnlock
pure def lawRetiredOwnerCannotReceiveQueuedVaultSecret(foreground: bool, sameUnlock: bool): bool =
  not(mayDeliverQueuedVaultSecret(foreground, false, sameUnlock))
pure def mayClearPasswordClipboard(deadlineReached: bool, retired: bool, observedOwnClip: bool): bool =
  (deadlineReached or retired) and observedOwnClip
pure def lawForeignClipboardIsPreserved(deadlineReached: bool, retired: bool): bool =
  not(mayClearPasswordClipboard(deadlineReached, retired, false))
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
