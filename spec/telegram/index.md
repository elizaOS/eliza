# Telegram

Telegram supplies bot updates and account-backed message history. The rules follow `plugins/plugin-telegram/{README.md,src/poller-lock.ts,src/dm-policy.ts,src/messageManager.ts,src/sender-auth.ts}` on `develop` at `51aad7ee8a82e1b8e6fa1908ed76d0c344c75d55`. Message-slot editing, owner pairing, world ownership, and personal history bounds are specified in [delivery](delivery.md).

## Story: Run one Telegram long-poller for each bot credential

> As a Telegram bot owner, I want the full and standalone modes to share one claim so a second client cannot interrupt the active poller.

### Only the current poller can mark its claim healthy, terminated or released

The claim is scoped to one credential handle, with its token held only by the shell. A disconnected or quiet poller retains ownership. An explicit terminal observation allows a new instance to claim the credential. A completion or release from the previous instance cannot affect the new one.

```quint
type TelegramMode = TelegramFull | TelegramStandalone
type TelegramCaller = TelegramHost | TelegramExternal
type TelegramPollerPhase = TelegramUnclaimed | TelegramStarting | TelegramConnected | TelegramTerminated
type TelegramClaim = { instanceId: str, ownerId: str, accountId: str, mode: TelegramMode, generation: int }
type TelegramPoller = { claim: TelegramClaim, phase: TelegramPollerPhase, lastUpdate: int }
pure val emptyTelegramClaim: TelegramClaim = { instanceId: "", ownerId: "", accountId: "", mode: TelegramFull, generation: 0 }
pure val initial: TelegramPoller = { claim: emptyTelegramClaim, phase: TelegramUnclaimed, lastUpdate: 0 }
pure val sampleTelegramClaim: TelegramClaim = { instanceId: "poller-1", ownerId: "owner", accountId: "bot", mode: TelegramFull, generation: 1 }
pure val claimValues = Set(sampleTelegramClaim, { ...sampleTelegramClaim, instanceId: "poller-2", generation: 2, mode: TelegramStandalone })
pure val updatedAtValues = Set(0, 1, 2, 6)
pure def validTelegramClaim(claim: TelegramClaim): bool = claim.instanceId != "" and claim.ownerId != "" and claim.accountId != "" and claim.generation > 0
pure def canClaimTelegramPoller(s: TelegramPoller, by: TelegramCaller, claim: TelegramClaim): bool = by == TelegramHost and validTelegramClaim(claim) and claim.generation > s.claim.generation and (s.phase == TelegramUnclaimed or s.phase == TelegramTerminated)
pure def claimTelegramPoller(s: TelegramPoller, by: TelegramCaller, claim: TelegramClaim): TelegramPoller = { claim: claim, phase: TelegramStarting, lastUpdate: 0 }
pure def canConnectTelegramPoller(s: TelegramPoller, by: TelegramCaller, claim: TelegramClaim, updatedAt: int): bool = by == TelegramHost and s.phase == TelegramStarting and s.claim == claim and updatedAt >= 0
pure def connectTelegramPoller(s: TelegramPoller, by: TelegramCaller, claim: TelegramClaim, updatedAt: int): TelegramPoller = { ...s, phase: TelegramConnected, lastUpdate: updatedAt }
pure def canObserveTelegramUpdate(s: TelegramPoller, by: TelegramCaller, claim: TelegramClaim, updatedAt: int): bool = by == TelegramHost and s.phase == TelegramConnected and s.claim == claim and updatedAt >= s.lastUpdate
pure def observeTelegramUpdate(s: TelegramPoller, by: TelegramCaller, claim: TelegramClaim, updatedAt: int): TelegramPoller = { ...s, lastUpdate: updatedAt }
pure def canTerminateTelegramPoller(s: TelegramPoller, by: TelegramCaller, claim: TelegramClaim): bool = by == TelegramHost and (s.phase == TelegramStarting or s.phase == TelegramConnected) and s.claim == claim
pure def terminateTelegramPoller(s: TelegramPoller, by: TelegramCaller, claim: TelegramClaim): TelegramPoller = { ...s, phase: TelegramTerminated }
pure def canReleaseTelegramPoller(s: TelegramPoller, by: TelegramCaller, claim: TelegramClaim): bool = by == TelegramHost and s.phase != TelegramUnclaimed and s.claim == claim
pure def releaseTelegramPoller(s: TelegramPoller, by: TelegramCaller, claim: TelegramClaim): TelegramPoller = { claim: { ...emptyTelegramClaim, generation: s.claim.generation }, phase: TelegramUnclaimed, lastUpdate: 0 }
pure def alwaysTelegramActiveClaimIsValid(s: TelegramPoller): bool = s.phase != TelegramUnclaimed implies validTelegramClaim(s.claim)
pure def stepTelegramClaimGenerationNeverFalls(before: TelegramPoller, after: TelegramPoller): bool = after.claim.generation >= before.claim.generation
pure def sometimesTelegramReplacesTerminated(s: TelegramPoller): bool = s.phase == TelegramStarting and s.claim.generation == 2 and s.claim.instanceId == "poller-2"
pure val eval_witness_sometimesTelegramReplacesTerminated = (("claimTelegramPoller", TelegramHost, sampleTelegramClaim), ("terminateTelegramPoller", TelegramHost, sampleTelegramClaim), ("claimTelegramPoller", TelegramHost, { ...sampleTelegramClaim, instanceId: "poller-2", generation: 2, mode: TelegramStandalone }))
```

## Story: Read a Telegram chat and reply under its account and topic rules

> As a Telegram owner, I want messages stored only from permitted chats, and commands and replies sent only under the account's policy.

### The effective Telegram allowlist can deny all chats, and DMs default to pairing when no list is set

A nonempty per-account allowlist takes precedence in full service mode. A configured global list, including the empty list, is authoritative for all chat scopes. A malformed configuration denies all. Without any list, non-DMs are admitted and DMs defer to their configured policy. Pairing requests are offered only by that policy and are distinct from an admitted turn.

```quint
type TelegramChatScope = TelegramDirect | TelegramGroup | TelegramTopic | TelegramChannel
type TelegramDmPolicy = TelegramOpen | TelegramPairing | TelegramAllowlist | TelegramDisabled
type TelegramChatList = TelegramNoList | TelegramInvalidList | TelegramConfigured({ chats: Set[str] })
type TelegramAdmission = TelegramAdmitted | TelegramNeedsPairing | TelegramDenied
type TelegramChatPolicy = { accountList: Set[str], globalList: TelegramChatList, dmPolicy: TelegramDmPolicy, pairedSender: bool }
pure def telegramChatAdmission(scope: TelegramChatScope, chatId: str, policy: TelegramChatPolicy): TelegramAdmission = {
  val globalChats = policy.globalList
  if (chatId == "") TelegramDenied else if (policy.accountList.size() > 0) (if (policy.accountList.contains(chatId)) TelegramAdmitted else TelegramDenied) else match globalChats {
  | TelegramInvalidList => TelegramDenied
  | TelegramConfigured(config) => if (config.chats.contains(chatId)) TelegramAdmitted else TelegramDenied
  | TelegramNoList => if (scope != TelegramDirect or policy.dmPolicy == TelegramOpen or (policy.dmPolicy == TelegramPairing and policy.pairedSender)) TelegramAdmitted else if (policy.dmPolicy == TelegramPairing) TelegramNeedsPairing else TelegramDenied
  }
}
pure def lawTelegramEmptyListDenies(scope: TelegramChatScope, chatId: str): bool = telegramChatAdmission(scope, chatId, { accountList: Set(), globalList: TelegramConfigured({ chats: Set() }), dmPolicy: TelegramOpen, pairedSender: true }) == TelegramDenied
```

### An admitted command keeps its sender and a reply stays in its account, chat and topic

The trusted adapter compares the same canonical entity resolved for the incoming message with the role used for slash-command authorization. Commands requiring the owner or an administrator compare that role before being sent to the core dispatcher. Ordinary admitted events store silently when auto-reply is off or the connector is passive. The reply address copies the source account, chat, forum topic and message identity.

```quint
type TelegramCommand = TelegramOrdinary | TelegramPublicCommand | TelegramOwnerCommand | TelegramAdminCommand
type TelegramRole = { isOwner: bool, isAdmin: bool }
type TelegramReplyMode = TelegramIgnore | TelegramStore | TelegramReply
type TelegramInbound = { eventAccount: str, eventChat: str, topicId: str, eventMessageId: str, senderEntity: str, chatScope: TelegramChatScope, command: TelegramCommand }
type TelegramAddress = { accountId: str, chatId: str, threadId: str, replyTo: str }
pure def telegramCommandAllowed(command: TelegramCommand, role: TelegramRole): bool = match command {
  | TelegramOrdinary => true
  | TelegramPublicCommand => true
  | TelegramOwnerCommand => role.isOwner
  | TelegramAdminCommand => role.isAdmin
}
pure def telegramMessageDisposition(inbound: TelegramInbound, policy: TelegramChatPolicy, role: TelegramRole, autoReply: bool, passive: bool): TelegramReplyMode = if (inbound.eventAccount == "" or inbound.eventMessageId == "" or inbound.senderEntity == "" or (inbound.chatScope == TelegramTopic and inbound.topicId == "") or telegramChatAdmission(inbound.chatScope, inbound.eventChat, policy) != TelegramAdmitted or not(telegramCommandAllowed(inbound.command, role))) TelegramIgnore else if (inbound.command != TelegramOrdinary or (autoReply and not(passive))) TelegramReply else TelegramStore
pure def telegramReplyAddress(inbound: TelegramInbound): TelegramAddress = { accountId: inbound.eventAccount, chatId: inbound.eventChat, threadId: if (inbound.chatScope == TelegramTopic) inbound.topicId else "", replyTo: inbound.eventMessageId }
pure val inboundValues = Set({ eventAccount: "bot", eventChat: "123", topicId: "", eventMessageId: "message", senderEntity: "sender", chatScope: TelegramDirect, command: TelegramOrdinary }, { eventAccount: "bot", eventChat: "-456", topicId: "7", eventMessageId: "message", senderEntity: "admin", chatScope: TelegramTopic, command: TelegramAdminCommand })
pure val policyValues = Set({ accountList: Set(), globalList: TelegramNoList, dmPolicy: TelegramOpen, pairedSender: false }, { accountList: Set(), globalList: TelegramConfigured({ chats: Set("123") }), dmPolicy: TelegramPairing, pairedSender: false }, { accountList: Set("-456"), globalList: TelegramInvalidList, dmPolicy: TelegramDisabled, pairedSender: false })
pure val roleValues = Set({ isOwner: false, isAdmin: false }, { isOwner: true, isAdmin: true })
pure def lawTelegramPassiveOrdinaryDoesNotReply(inbound: TelegramInbound, policy: TelegramChatPolicy, role: TelegramRole): bool = inbound.command == TelegramOrdinary implies telegramMessageDisposition(inbound, policy, role, true, true) != TelegramReply
pure def lawTelegramReplyKeepsAccountAndChat(inbound: TelegramInbound): bool = telegramReplyAddress(inbound).accountId == inbound.eventAccount and telegramReplyAddress(inbound).chatId == inbound.eventChat
```
