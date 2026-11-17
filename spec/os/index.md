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
