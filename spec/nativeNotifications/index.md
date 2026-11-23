# Native notifications

The [Android notification mirror](../os/android/notificationMirror.md), [notice routing](../os/android/noticeRoutes.md), and [notice projection](../os/android/notificationProjection.md) govern the listener, local history and host notices. The native library exposes status, policy updates, bounded reads, and explicit local row actions.

## Story: View and act on permitted notifications while the screen is current

> As the owner, I want the mirror to show only eligible apps and let me open or dismiss the notification I selected without exposing private text.

### The mirror withholds rows when collection or the current owner's display is unavailable

Complete reads return an explicit limit refusal above the supported bound. Previews arise only from the current opted-in local row policy. Native action intents are supplied and validated by Android.

```quint
type NativeNoticeFence = { optedIn: bool, listenerGranted: bool, listenerConnected: bool, paused: bool, unlocked: bool, foreground: bool }
type MirrorListResult = MirrorWithheld | MirrorOverLimit | MirrorRows
pure def mirrorListOutcome(fence: NativeNoticeFence, selectedRows: int): MirrorListResult =
  if (not(fence.optedIn and fence.listenerGranted and fence.listenerConnected and not(fence.paused) and
      fence.unlocked and fence.foreground) or selectedRows < 0) MirrorWithheld
  else if (selectedRows > 100) MirrorOverLimit else MirrorRows
type NoticeRowAccess = { liveHandle: bool, sameUser: bool, signerMatches: bool, ownPostingUid: bool, secretNotice: bool }
pure def mayExposeNoticePreview(access: NoticeRowAccess, previewsEnabled: bool): bool =
  access.liveHandle and access.sameUser and access.signerMatches and access.ownPostingUid and
  not(access.secretNotice) and previewsEnabled
pure def lawSecretNoticeHasNoPreview(access: NoticeRowAccess, previewsEnabled: bool): bool =
  access.secretNotice implies not(mayExposeNoticePreview(access, previewsEnabled))
pure def lawNoticeMirrorNeverReturnsPartial(fence: NativeNoticeFence, selectedRows: int): bool =
  selectedRows > 100 implies mirrorListOutcome(fence, selectedRows) != MirrorRows
pure val accessValues = Set(
  { liveHandle: true, sameUser: true, signerMatches: true, ownPostingUid: true, secretNotice: false },
  { liveHandle: true, sameUser: true, signerMatches: true, ownPostingUid: true, secretNotice: true },
  { liveHandle: false, sameUser: true, signerMatches: false, ownPostingUid: true, secretNotice: false })
pure val fenceValues = Set(
  { optedIn: true, listenerGranted: true, listenerConnected: true, paused: false, unlocked: true, foreground: true },
  { optedIn: true, listenerGranted: true, listenerConnected: true, paused: true, unlocked: true, foreground: true },
  { optedIn: true, listenerGranted: true, listenerConnected: true, paused: false, unlocked: false, foreground: false })
pure val selectedRowsValues = Set(-1, 0, 100, 101)
```
