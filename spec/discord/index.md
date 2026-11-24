# Discord

Discord connects account-scoped bot and managed transports to text channels, threads, direct messages, voice and server management. The rules follow `plugins/plugin-discord/{allowlist,dm-access,staleness,message-coalesce,service}.ts` on `develop` at `51aad7ee8a82e1b8e6fa1908ed76d0c344c75d55`.

## Story: Route Discord messages and commands through the account that received them

> As a Discord server owner, I want account policies to apply equally to messages and interactions, and replies to remain in the correct channel or thread.

### Account DM and guild rules decide admission before an agent turn

A disabled policy denies access. Direct allowlists and pairing use the configured account; administrators are accepted in pairing mode. For a guild allowlist, the guild must match and a configured channel list must also match. Channels can override their guild's mention requirement. A bot-created auto-thread bypasses that requirement. Slash commands still need their separately resolved command role.

```quint
type DiscordDmMode = DiscordDmOpen | DiscordDmDisabled | DiscordDmAllowlist | DiscordDmPairing
type DiscordGroupMode = DiscordGroupOpen | DiscordGroupDisabled | DiscordGroupAllowlist
type DiscordScope = DiscordDirect | DiscordGuild | DiscordThread
type DiscordKind = DiscordMessage | DiscordSlashCommand
type DiscordAddressing = DiscordDefaultMention | DiscordRequireMention | DiscordDoNotRequireMention
type DiscordPolicy = { dmMode: DiscordDmMode, groupMode: DiscordGroupMode, guildAllowed: bool, channelListConfigured: bool, channelAllowed: bool, actorAllowed: bool, admin: bool, paired: bool, channelAddressing: DiscordAddressing, guildAddressing: DiscordAddressing, botAutoThread: bool }
type DiscordInbound = { accountId: str, epoch: int, channelId: str, messageId: str, senderId: str, scope: DiscordScope, inboundKind: DiscordKind, mentioned: bool, commandAllowed: bool }
pure def discordDirectAllowed(policy: DiscordPolicy): bool = {
  val mode = policy.dmMode
  match mode {
  | DiscordDmOpen => true
  | DiscordDmDisabled => false
  | DiscordDmAllowlist => policy.actorAllowed
  | DiscordDmPairing => policy.actorAllowed or policy.admin or policy.paired
  }
}
pure def discordGuildAllowed(policy: DiscordPolicy): bool = {
  val mode = policy.groupMode
  match mode {
  | DiscordGroupOpen => true
  | DiscordGroupDisabled => false
  | DiscordGroupAllowlist => policy.guildAllowed and (not(policy.channelListConfigured) or policy.channelAllowed)
  }
}
pure def discordNeedsMention(scope: DiscordScope, policy: DiscordPolicy): bool = scope != DiscordDirect and not(scope == DiscordThread and policy.botAutoThread) and (if (policy.channelAddressing != DiscordDefaultMention) policy.channelAddressing != DiscordDoNotRequireMention else policy.guildAddressing != DiscordDoNotRequireMention)
pure def discordInboundAllowed(inbound: DiscordInbound, policy: DiscordPolicy): bool = (if (inbound.scope == DiscordDirect) discordDirectAllowed(policy) else discordGuildAllowed(policy)) and (if (inbound.inboundKind == DiscordSlashCommand) inbound.commandAllowed else (not(discordNeedsMention(inbound.scope, policy)) or inbound.mentioned))
pure def lawDiscordDisabledDmBlocksCommand(inbound: DiscordInbound, policy: DiscordPolicy): bool = inbound.scope == DiscordDirect and policy.dmMode == DiscordDmDisabled implies not(discordInboundAllowed(inbound, policy))
```

### Every accepted Discord event keeps the captured account and channel

The transport validates message identity, and the shell scopes each session to the bot account and credential epoch. An accepted message or interaction is delivered at most once per session. Disconnect retires the epoch and clears all processing authority. The provider identity is kept on the deliveryEffect turn.

```quint
type DiscordCaller = DiscordGateway | DiscordExternal
type DiscordSession = { accountId: str, epoch: int, connected: bool, seen: Set[str], accepted: int }
type DiscordEffect = AdmitDiscordTurn({ accepted: DiscordInbound })
type DiscordStep = { state: DiscordSession, out: List[DiscordEffect] }
pure val initial: DiscordSession = { accountId: "", epoch: 0, connected: false, seen: Set(), accepted: 0 }
pure val accountIdValues = Set("discord-1", "discord-2", "")
pure val sampleDiscordInbound: DiscordInbound = { accountId: "discord-1", epoch: 1, channelId: "channel", messageId: "event-1", senderId: "sender", scope: DiscordThread, inboundKind: DiscordMessage, mentioned: false, commandAllowed: false }
pure val inboundValues = Set(sampleDiscordInbound, { ...sampleDiscordInbound, mentioned: true }, { ...sampleDiscordInbound, epoch: 2 }, { ...sampleDiscordInbound, accountId: "discord-2" }, { ...sampleDiscordInbound, scope: DiscordDirect, inboundKind: DiscordSlashCommand, commandAllowed: true })
pure val sampleDiscordPolicy: DiscordPolicy = { dmMode: DiscordDmPairing, groupMode: DiscordGroupAllowlist, guildAllowed: true, channelListConfigured: true, channelAllowed: true, actorAllowed: false, admin: false, paired: false, channelAddressing: DiscordDefaultMention, guildAddressing: DiscordRequireMention, botAutoThread: true }
pure val policyValues = Set(sampleDiscordPolicy, { ...sampleDiscordPolicy, channelAllowed: false }, { ...sampleDiscordPolicy, paired: true }, { ...sampleDiscordPolicy, dmMode: DiscordDmDisabled })
pure def canConnectDiscord(s: DiscordSession, by: DiscordCaller, accountId: str): bool = by == DiscordGateway and not(s.connected) and accountId != ""
pure def connectDiscord(s: DiscordSession, by: DiscordCaller, accountId: str): DiscordSession = { accountId: accountId, epoch: s.epoch + 1, connected: true, seen: Set(), accepted: 0 }
pure def canDisconnectDiscord(s: DiscordSession, by: DiscordCaller): bool = by == DiscordGateway and s.connected
pure def disconnectDiscord(s: DiscordSession, by: DiscordCaller): DiscordSession = { ...s, connected: false, seen: Set(), accepted: 0 }
pure def canAdmitDiscord(s: DiscordSession, by: DiscordCaller, inbound: DiscordInbound, policy: DiscordPolicy): bool = by == DiscordGateway and s.connected and inbound.accountId == s.accountId and inbound.epoch == s.epoch and inbound.channelId != "" and inbound.senderId != "" and inbound.messageId != "" and not(s.seen.contains(inbound.messageId)) and discordInboundAllowed(inbound, policy)
pure def admitDiscord(s: DiscordSession, by: DiscordCaller, inbound: DiscordInbound, policy: DiscordPolicy): DiscordStep = { state: { ...s, seen: s.seen.union(Set(inbound.messageId)), accepted: s.accepted + 1 }, out: List(AdmitDiscordTurn({ accepted: inbound })) }
pure def discordEffectMatches(s: DiscordSession, deliveryEffect: DiscordEffect): bool = match deliveryEffect { | AdmitDiscordTurn(delivery) => delivery.accepted.accountId == s.accountId and delivery.accepted.epoch == s.epoch and not(s.seen.contains(delivery.accepted.messageId)) }
pure def stepDiscordNeverMovesTurn(before: DiscordSession, after: DiscordSession, out: List[DiscordEffect]): bool = out.every(deliveryEffect => before.connected and discordEffectMatches(before, deliveryEffect))
pure def alwaysDiscordConnectedHasAccount(s: DiscordSession): bool = s.connected implies s.accountId != "" and s.epoch > 0
pure def sometimesDiscordIngested(s: DiscordSession): bool = s.accepted > 0
pure val eval_witness_sometimesDiscordIngested = (("connectDiscord", DiscordGateway, "discord-1"), ("admitDiscord", DiscordGateway, sampleDiscordInbound, sampleDiscordPolicy))
```

## Story: Keep Discord replies useful as the conversation moves on

> As a Discord participant, I want chat batching to preserve message order and media, and stale responses to follow the channel policy.

### A stale response is tagged, suppressed, or left alone by its policy

The shell supplies monotonically observed channel sequence counts. The number of messages since the response started is clamped to zero when a count is unavailable or behind. A reply past the threshold is suppressed in skip mode and tagged in tag mode. Ignore mode never marks a response stale.

```quint
type DiscordStaleness = DiscordTagStale | DiscordSkipStale | DiscordIgnoreStale
type DiscordReplyDecision = DiscordSendFresh | DiscordSendTagged | DiscordSuppressReply
pure def discordMessagesSince(startedAt: int, currentSequence: int): int = if (currentSequence > startedAt) currentSequence - startedAt else 0
pure def discordStalenessDecision(behavior: DiscordStaleness, enabledGuard: bool, threshold: int, startedAt: int, currentSequence: int): DiscordReplyDecision = if (not(enabledGuard) or behavior == DiscordIgnoreStale or discordMessagesSince(startedAt, currentSequence) <= threshold) DiscordSendFresh else if (behavior == DiscordSkipStale) DiscordSuppressReply else DiscordSendTagged
pure def lawDiscordIgnoresStaleness(threshold: int, startedAt: int, currentSequence: int): bool = discordStalenessDecision(DiscordIgnoreStale, true, threshold, startedAt, currentSequence) == DiscordSendFresh
```

### Each Discord reply part is stored once even when its send is repeated

Discord's client sends a message create again after a server error or a timeout, and Discord may already have stored the first one. Every create the connector sends, each channel or thread chunk and each direct message, carries its own fresh nonce of one to 25 characters and asks Discord to enforce it. Discord answers a create whose enforced nonce it already stored with that message instead of storing a copy, so a repeated create leaves one message.

```quint
type DiscordCreate = { nonce: str, nonceLength: int, enforceNonce: bool }
pure def discordCreateGuarded(post: DiscordCreate): bool = post.enforceNonce and post.nonce != "" and post.nonceLength > 0 and post.nonceLength <= 25
pure def discordKeptNonces(kept: List[str], post: DiscordCreate): List[str] = if (post.enforceNonce and kept.includes(post.nonce)) kept else kept.append(post.nonce)
pure val postValues = Set({ nonce: "n1", nonceLength: 24, enforceNonce: true }, { nonce: "n1", nonceLength: 24, enforceNonce: false }, { nonce: "", nonceLength: 0, enforceNonce: true }, { nonce: "n2", nonceLength: 26, enforceNonce: true })
pure val keptValues = Set(List(), List("n1"), List("n2"))
pure def lawDiscordRepeatedGuardedCreateIsKeptOnce(kept: List[str], post: DiscordCreate): bool = discordCreateGuarded(post) implies discordKeptNonces(discordKeptNonces(kept, post), post) == discordKeptNonces(kept, post)
```

### A coalesced Discord batch keeps the ordered message and attachment identifiers

The batch starts with its ordered ingress candidates from one channel. Each admitted original contributes its attachments in provider order. The renderer retains the chosen anchor for delivery addressing.

```quint
type DiscordBatchItem = { originalId: str, originalChannel: str, attachments: List[str] }
pure def validDiscordBatch(items: List[DiscordBatchItem], channelId: str, maxBatch: int): bool = items.length() > 0 and items.length() <= maxBatch and items.every(batchEntry => batchEntry.originalId != "" and batchEntry.originalChannel == channelId)
pure def discordBatchIds(items: List[DiscordBatchItem]): List[str] = items.listMap(batchEntry => batchEntry.originalId)
pure def discordBatchAttachments(items: List[DiscordBatchItem]): List[str] = items.foldl(List(), (attachments, batchEntry) => batchEntry.attachments.foldl(attachments, (added, mediaId) => added.append(mediaId)))
pure val itemsValues = Set(List(), List({ originalId: "msg", originalChannel: "room", attachments: List("file") }))
pure def lawDiscordBatchKeepsMessageCount(items: List[DiscordBatchItem]): bool = discordBatchIds(items).length() == items.length()
```

## Story: Manage only the Discord server I authorized

> As a Discord server administrator, I want server changes to use the exact guild and current management grant.

### A structural server operation matches the account, guild, requester, and granted operation

The authenticated adapter supplies management authority for the exact guild and user. It verifies the live provider permissions before dispatch. A capability bound to a channel operation cannot authorize changing roles, moderation or invites.

```quint
type DiscordManagementKind = DiscordManageChannels | DiscordManageRoles | DiscordManageInvites | DiscordManageMembers | DiscordApplyTemplate
type DiscordManagement = { forAccount: str, forGuild: str, requestedBy: str, operation: DiscordManagementKind }
pure def mayManageDiscord(proposal: DiscordManagement, grant: DiscordManagement, providerAllows: bool): bool = proposal == grant and proposal.forAccount != "" and proposal.forGuild != "" and proposal.requestedBy != "" and providerAllows
pure val proposalValues = Set({ forAccount: "bot", forGuild: "guild", requestedBy: "member", operation: DiscordManageChannels }, { forAccount: "bot", forGuild: "", requestedBy: "member", operation: DiscordManageRoles })
pure val grantValues = proposalValues
pure def lawDiscordManagementCannotCrossGuild(proposal: DiscordManagement, grant: DiscordManagement, providerAllows: bool): bool = proposal.forGuild != grant.forGuild implies not(mayManageDiscord(proposal, grant, providerAllows))
```
