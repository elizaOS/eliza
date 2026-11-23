# Native messages

[Android messages](../os/android/messages.md) owns reviewed send, provider receipts, MMS role requirements, deletion and notice actions. This package exposes the local app's bridge and truthful status for an exact native conversation.

## Story: Read my inbox and see the evidence for the message I reviewed

> As the owner, I want the send status to reflect all provider parts, and any uncertain result to remain visible until reconciliation.

### Sending requires a current review and its provider-specific authority

A read and a send require separate capabilities. A send approval is bound to the exact destination, text and attachments before the bridge dispatches it. The shell decodes provider results and keeps draft content and native send tokens local.

```quint
type MessageKind = NativeSms | NativeMms
type MessageAuthority = { canRead: bool, canSend: bool, ownsSmsRole: bool, confirmedExactContent: bool }
pure def maySendNativeMessage(authority: MessageAuthority, kind: MessageKind): bool =
  authority.canSend and authority.confirmedExactContent and (kind != NativeMms or authority.ownsSmsRole)
pure def lawMmsNeedsSmsRole(authority: MessageAuthority): bool =
  maySendNativeMessage(authority, NativeMms) implies authority.ownsSmsRole
type MessageParts = { expectedParts: int, appliedParts: int, rejectedParts: int, providerAccepted: bool }
type NativeSendStatus = MessageNotSent | MessageSending | MessageSent | MessagePartiallySent | MessageUnknown
pure def nativeSendStatus(parts: MessageParts): NativeSendStatus =
  if (parts.expectedParts <= 0 or parts.appliedParts < 0 or parts.rejectedParts < 0 or
      parts.appliedParts + parts.rejectedParts > parts.expectedParts) MessageUnknown else
  if (parts.appliedParts == parts.expectedParts) MessageSent else
  if (parts.rejectedParts == parts.expectedParts) MessageNotSent else
  if (parts.appliedParts + parts.rejectedParts == parts.expectedParts) MessagePartiallySent else
  if (parts.providerAccepted) MessageSending else MessageUnknown
pure def lawSentNeedsAllParts(parts: MessageParts): bool =
  nativeSendStatus(parts) == MessageSent implies parts.expectedParts > 0 and parts.appliedParts == parts.expectedParts
pure val authorityValues = Set(
  { canRead: true, canSend: true, ownsSmsRole: true, confirmedExactContent: true },
  { canRead: true, canSend: true, ownsSmsRole: false, confirmedExactContent: true },
  { canRead: true, canSend: true, ownsSmsRole: true, confirmedExactContent: false })
pure val partsValues = Set(
  { expectedParts: 2, appliedParts: 2, rejectedParts: 0, providerAccepted: true },
  { expectedParts: 2, appliedParts: 1, rejectedParts: 1, providerAccepted: true },
  { expectedParts: 2, appliedParts: 0, rejectedParts: 0, providerAccepted: false },
  { expectedParts: 2, appliedParts: 3, rejectedParts: 0, providerAccepted: true })
```
