# iMessage

The plugin reads macOS Messages or receives signed Blooio events for its configured channel. It follows `plugins/plugin-imessage/src/{service,chatdb-reader,blooio-transport,config}.ts` on `develop` at `51aad7ee8a82e1b8e6fa1908ed76d0c344c75d55`.

## Story: Store incoming iMessages without sending unsolicited replies

> As a Messages account owner, I want allowed messages retained in the proper conversation and the choice of whether the agent sends replies.

### iMessage direct and group access differ, and passive connectors send no automatic reply

Direct messages can be open, disabled, allowlisted or paired. Group access follows its own policy and never sends a direct pairing message. A signed provider event or a local Messages row from the account owner is not treated as an incoming conversational turn. Reaction and group events use their auxiliary path. An attachment-only message is still a turn.

```quint
type IMessageDm = IMessageOpenDm | IMessageDisabledDm | IMessageAllowlistDm | IMessagePairingDm
type IMessageGroup = IMessageOpenGroup | IMessageDisabledGroup | IMessageAllowlistGroup
type IMessageKind = IMessageText | IMessageReaction | IMessageGroupEvent
type IMessageDisposition = IMessageSkip | IMessageAuxiliary | IMessagePairingReply | IMessageIngestSilent | IMessageIngestAndReply
type IMessageInput = { selfAuthored: bool, groupChat: bool, rowKind: IMessageKind, hasText: bool, attachmentCount: int }
type IMessagePolicy = { directMode: IMessageDm, groupMode: IMessageGroup, directMatched: bool, groupMatched: bool, paired: bool, pairingOffered: bool, automaticReply: bool, passive: bool }
pure def imessageAllowed(inbound: IMessageInput, policy: IMessagePolicy): bool = if (inbound.groupChat) policy.groupMode == IMessageOpenGroup or (policy.groupMode == IMessageAllowlistGroup and policy.groupMatched) else policy.directMode == IMessageOpenDm or (policy.directMode == IMessageAllowlistDm and policy.directMatched) or (policy.directMode == IMessagePairingDm and (policy.directMatched or policy.paired))
pure def imessageCanAutoReply(policy: IMessagePolicy): bool = policy.automaticReply and not(policy.passive)
pure def imessageDisposition(inbound: IMessageInput, policy: IMessagePolicy): IMessageDisposition = if (inbound.selfAuthored) IMessageSkip else if (not(imessageAllowed(inbound, policy))) (if (not(inbound.groupChat) and policy.directMode == IMessagePairingDm and policy.pairingOffered and imessageCanAutoReply(policy)) IMessagePairingReply else IMessageSkip) else if (inbound.rowKind != IMessageText) IMessageAuxiliary else if (not(inbound.hasText) and inbound.attachmentCount <= 0) IMessageSkip else if (imessageCanAutoReply(policy)) IMessageIngestAndReply else IMessageIngestSilent
pure val inboundValues = Set({ selfAuthored: false, groupChat: false, rowKind: IMessageText, hasText: true, attachmentCount: 0 }, { selfAuthored: false, groupChat: true, rowKind: IMessageReaction, hasText: false, attachmentCount: 0 })
pure val policyValues = Set({ directMode: IMessagePairingDm, groupMode: IMessageOpenGroup, directMatched: false, groupMatched: false, paired: false, pairingOffered: true, automaticReply: true, passive: true }, { directMode: IMessageOpenDm, groupMode: IMessageDisabledGroup, directMatched: false, groupMatched: false, paired: false, pairingOffered: false, automaticReply: true, passive: false })
pure def lawIMessagePassiveNeverReplies(inbound: IMessageInput, policy: IMessagePolicy): bool = policy.passive implies (imessageDisposition(inbound, policy) != IMessageIngestAndReply and imessageDisposition(inbound, policy) != IMessagePairingReply)
```

## Story: Resume native Messages polling after a recoverable row failure

> As a Messages account owner, I want polling to continue without losing earlier rows or being blocked permanently by one corrupt row.

### The native cursor commits rows in order, with bounded persistence and attachment retries

The single poller reads at most 50 strictly increasing row IDs per fetch. A gate or permanent failure may skip a row. A transient write failure holds the cursor at the previous settled row until the fifth failure, when the row is skipped. Attachment metadata is tried five times before retrying that row without attachments. A failed database read does not advance the cursor.

```quint
type IMessageNativeResult = IMessageNativeSaved | IMessageNativeSkipped | IMessageNativeRetryWrite | IMessageNativeRetryMedia | IMessageNativePermanentFailure
type IMessageBatchOrder = { priorRow: int, abovePrior: bool }
type IMessageCursor = { committedRow: int, retryRow: int, writeAttempts: int, mediaAttempts: int, tolerateMissingMedia: bool }
pure val initial: IMessageCursor = { committedRow: 0, retryRow: 0, writeAttempts: 0, mediaAttempts: 0, tolerateMissingMedia: false }
pure val rowIdValues = Set(1, 2, 3)
pure def imessageBatchValid(committedRow: int, rowIds: List[int]): bool = rowIds.length() <= 50 and rowIds.foldl({ priorRow: committedRow, abovePrior: true }, (progress, rowId) => { priorRow: rowId, abovePrior: progress.abovePrior and rowId > progress.priorRow }).abovePrior
pure def canObserveIMessageRow(s: IMessageCursor, rowId: int, nativeResult: IMessageNativeResult): bool = rowId > s.committedRow and (s.retryRow == 0 or s.retryRow == rowId) and (nativeResult != IMessageNativeRetryMedia or not(s.tolerateMissingMedia))
pure def observeIMessageRow(s: IMessageCursor, rowId: int, nativeResult: IMessageNativeResult): IMessageCursor = if (nativeResult == IMessageNativeRetryWrite and s.writeAttempts < 4) { ...s, retryRow: rowId, writeAttempts: s.writeAttempts + 1 } else if (nativeResult == IMessageNativeRetryMedia) { ...s, retryRow: rowId, mediaAttempts: s.mediaAttempts + 1, tolerateMissingMedia: s.mediaAttempts >= 4 } else { ...initial, committedRow: rowId }
pure def alwaysIMessageRetryBeyondCursor(s: IMessageCursor): bool = s.retryRow == 0 or s.retryRow > s.committedRow
pure def alwaysIMessageRetriesBounded(s: IMessageCursor): bool = s.writeAttempts >= 0 and s.writeAttempts <= 4 and s.mediaAttempts >= 0 and s.mediaAttempts <= 5 and s.tolerateMissingMedia == (s.mediaAttempts == 5)
pure def stepIMessageCursorDoesNotRewind(before: IMessageCursor, after: IMessageCursor): bool = after.committedRow >= before.committedRow
pure def sometimesIMessageCursorAdvances(s: IMessageCursor): bool = s.committedRow > 0
```

## Story: Ignore already processed Blooio deliveries and preserve signed-channel isolation

> As an iMessage account owner, I want a Blooio delivery to enter only the configured channel and to be acknowledged only after its record is durable.

### Blooio needs the signed raw body, exact configured channel and a dispatchable receipt state

The shell verifies the signature before the body becomes an authenticated observation, and requires a nonempty provider message ID. A current receipt suppresses a repeated delivery for seven days, with up to five minutes of clock skew. A receipt written by a newer schema is treated as already processed and stays untouched. Malformed or expired receipt records must be cleared before dispatch; a storage error has no dispatch authority.

```quint
type IMessageWebhook = { expectedChannel: str, eventChannel: str, providerMessageId: str, verifiedSignature: bool }
type IMessageReceipt = IMessageAbsent | IMessageReceiptReadFailed | IMessageReceiptRecord({ version: int, acceptedAt: int, cleanupValid: bool })
type IMessageReceiptDecision = IMessageDispatchable | IMessagePreserveReceipt | IMessageClearReceipt | IMessageRequireRetry
pure def imessageReceiptDecision(receipt: IMessageReceipt, nowMs: int): IMessageReceiptDecision = match receipt {
  | IMessageAbsent => IMessageDispatchable
  | IMessageReceiptReadFailed => IMessageRequireRetry
  | IMessageReceiptRecord(record) => if (record.version > 1) IMessagePreserveReceipt else if (record.version != 1 or record.acceptedAt <= 0 or record.acceptedAt > nowMs + 300000 or not(record.cleanupValid) or nowMs - record.acceptedAt >= 604800000) IMessageClearReceipt else IMessagePreserveReceipt
}
pure def imessageCanDispatchWebhook(webhook: IMessageWebhook, receipt: IMessageReceipt, nowMs: int): bool = webhook.verifiedSignature and webhook.expectedChannel != "" and webhook.eventChannel == webhook.expectedChannel and webhook.providerMessageId != "" and imessageReceiptDecision(receipt, nowMs) == IMessageDispatchable
pure val webhookValues = Set({ expectedChannel: "configured", eventChannel: "configured", providerMessageId: "msg", verifiedSignature: true }, { expectedChannel: "configured", eventChannel: "foreign", providerMessageId: "msg", verifiedSignature: true }, { expectedChannel: "configured", eventChannel: "configured", providerMessageId: "msg", verifiedSignature: false })
pure val receiptValues = Set(IMessageAbsent, IMessageReceiptReadFailed, IMessageReceiptRecord({ version: 1, acceptedAt: 1, cleanupValid: true }), IMessageReceiptRecord({ version: 2, acceptedAt: 0, cleanupValid: false }))
pure def lawIMessageWebhookNeverCrossesChannels(webhook: IMessageWebhook, receipt: IMessageReceipt, nowMs: int): bool = webhook.eventChannel != webhook.expectedChannel implies not(imessageCanDispatchWebhook(webhook, receipt, nowMs))
pure def lawNewIMessageReceiptIsPreserved(receiptVersion: int, nowMs: int): bool = receiptVersion > 1 implies imessageReceiptDecision(IMessageReceiptRecord({ version: receiptVersion, acceptedAt: 0, cleanupValid: false }), nowMs) == IMessagePreserveReceipt
```
