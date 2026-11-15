# Hands-free voice session

A hands-free voice session joins [capture](./capture.md),
[the endpoint](./endpoint.md) and [playback](./playback.md) into a
conversation, and [the session client](./sessionClient.md) shows it. Some
of what the assistant does needs the person's approval. Speech can be
misheard, overheard or played back from a recording, so an approval is
never taken from what the microphone hears: the session asks the person to
confirm on the screen. A [wake](./wake.md) likewise only starts a fresh
exchange.

## Story: Approve an action during a voice conversation

> As a person talking to the assistant, I want anything that needs my
> approval confirmed on the screen, so that nothing said aloud, by me or
> anyone near me, can approve it.

### Approvals are never given by voice

While an approval is pending the session keeps listening, but nothing it
hears, including a spoken "yes", approves or declines it. Only the
person's confirmation on the screen approves it, and only their decline
on the screen withdraws it.

```quint
type Utterance = SaysApprove | SaysDecline | SaysOther
type ApprovalChannel = NoApproval | ScreenApproval
type VoiceApprovalSession = { listening: bool, approvalPending: bool, approved: bool, approvedBy: ApprovalChannel,
  heard: int, declined: int }
pure val initial: VoiceApprovalSession = { listening: true, approvalPending: false, approved: false,
  approvedBy: NoApproval, heard: 0, declined: 0 }
pure def canRequestApproval(v: VoiceApprovalSession): bool = not(v.approvalPending) and not(v.approved)
pure def requestApproval(v: VoiceApprovalSession): VoiceApprovalSession = { ...v, approvalPending: true }
pure def canHearUtterance(v: VoiceApprovalSession, utterance: Utterance): bool = v.listening
pure def hearUtterance(v: VoiceApprovalSession, utterance: Utterance): VoiceApprovalSession =
  { ...v, heard: v.heard + 1 }
pure def canConfirmOnScreen(v: VoiceApprovalSession): bool = v.approvalPending
pure def confirmOnScreen(v: VoiceApprovalSession): VoiceApprovalSession =
  { ...v, approvalPending: false, approved: true, approvedBy: ScreenApproval }
pure def canDeclineOnScreen(v: VoiceApprovalSession): bool = v.approvalPending
pure def declineOnScreen(v: VoiceApprovalSession): VoiceApprovalSession =
  { ...v, approvalPending: false, declined: v.declined + 1 }
pure def canSetListening(v: VoiceApprovalSession, listeningOn: bool): bool = v.listening != listeningOn
pure def setListening(v: VoiceApprovalSession, listeningOn: bool): VoiceApprovalSession = { ...v, listening: listeningOn }
pure def alwaysApprovalComesFromScreen(v: VoiceApprovalSession): bool =
  (v.approved implies v.approvedBy == ScreenApproval) and (v.approvedBy == ScreenApproval implies v.approved)
pure def stepSpeechNeverDecidesApproval(before: VoiceApprovalSession, via: str, after: VoiceApprovalSession): bool =
  via == "hearUtterance" implies
    after.approvalPending == before.approvalPending and after.approved == before.approved and
    after.approvedBy == before.approvedBy and after.declined == before.declined
pure def sometimesApprovedAfterSpokenYes(v: VoiceApprovalSession): bool = v.approved and v.heard > 0
pure def sometimesPendingWhileHearing(v: VoiceApprovalSession): bool = v.approvalPending and v.heard > 0
```
