# Slack

Slack accepts events for an authenticated installation and routes messages to the same workspace, account, channel and thread. This specification follows `plugins/plugin-slack/src/{policy,service,inbound-files}.ts` on `develop` at `51aad7ee8a82e1b8e6fa1908ed76d0c344c75d55`.

## Story: Answer one Slack message through its proper installation and thread

> As a Slack member, I want a message or mention to reach the agent once under the workspace's rules.

### Slack events need the installed team and compatible enterprise identity

A missing team or mismatched team is denied. A supplied enterprise must match the installation if it has one. A direct message or App Home event needs enabled DMs and permission under the installed DM policy. A group DM needs independent group admission. Channel policy decides channel and user admission and whether the event needs a mention. Bot and system events cannot stand in for a human message unless the applicable bot policy permits messages from other bots.

```quint
type SlackConversation = SlackPublic | SlackPrivate | SlackDirect | SlackHome | SlackGroupDirect | SlackUnknownConversation
type SlackEventKind = SlackMessage | SlackMention | SlackReaction | SlackSystemNotice
type SlackDmMode = SlackDmOpen | SlackDmPairing | SlackDmAllowlist | SlackDmDisabled
type SlackInstallation = { accountId: str, teamId: str, enterpriseId: str, botUserId: str, epoch: int }
type SlackInbound = { eventAccount: str, eventEpoch: int, eventTeam: str, eventEnterprise: str, channelId: str, messageTs: str, threadTs: str, senderId: str, conversation: SlackConversation, eventKind: SlackEventKind, mentionsBot: bool, fromBot: bool }
type SlackAdmission = { allowBots: bool, dmMode: SlackDmMode, dmEnabled: bool, dmAllowlisted: bool, dmPaired: bool, groupDmEnabled: bool, groupDmAllowed: bool, channelAllowed: bool, channelUserAllowed: bool, requireMention: bool }
pure def slackIsChannel(conversation: SlackConversation): bool = conversation == SlackPublic or conversation == SlackPrivate
pure def slackWorkspaceMatches(installation: SlackInstallation, inbound: SlackInbound): bool = installation.accountId != "" and inbound.eventAccount == installation.accountId and inbound.eventEpoch == installation.epoch and inbound.eventTeam != "" and inbound.eventTeam == installation.teamId and (inbound.eventEnterprise == "" or installation.enterpriseId == "" or inbound.eventEnterprise == installation.enterpriseId)
pure def slackConversationAllowed(inbound: SlackInbound, policy: SlackAdmission): bool = {
  val scope = inbound.conversation
  match scope {
  | SlackDirect => policy.dmEnabled and policy.dmMode != SlackDmDisabled and (policy.dmMode == SlackDmOpen or policy.dmAllowlisted or (policy.dmMode == SlackDmPairing and policy.dmPaired))
  | SlackHome => policy.dmEnabled and policy.dmMode != SlackDmDisabled and (policy.dmMode == SlackDmOpen or policy.dmAllowlisted or (policy.dmMode == SlackDmPairing and policy.dmPaired))
  | SlackGroupDirect => policy.dmEnabled and policy.groupDmEnabled and policy.groupDmAllowed
  | SlackPublic => policy.channelAllowed and policy.channelUserAllowed and (inbound.eventKind != SlackMessage or not(policy.requireMention) or inbound.mentionsBot)
  | SlackPrivate => policy.channelAllowed and policy.channelUserAllowed and (inbound.eventKind != SlackMessage or not(policy.requireMention) or inbound.mentionsBot)
  | SlackUnknownConversation => false
  }
}
pure def slackShouldIngest(installation: SlackInstallation, inbound: SlackInbound, policy: SlackAdmission): bool = slackWorkspaceMatches(installation, inbound) and inbound.channelId != "" and inbound.messageTs != "" and inbound.senderId != "" and inbound.senderId != installation.botUserId and inbound.eventKind != SlackSystemNotice and (not(inbound.fromBot) or policy.allowBots) and slackConversationAllowed(inbound, policy) and (inbound.eventKind != SlackMessage or not(slackIsChannel(inbound.conversation) and inbound.mentionsBot))
pure def lawSlackWorkspaceMismatchesAreDenied(installation: SlackInstallation, inbound: SlackInbound, policy: SlackAdmission): bool = inbound.eventTeam != installation.teamId implies not(slackShouldIngest(installation, inbound, policy))
```

### A public or private mention takes the app-mention lane and replies to the captured thread

A channel message also delivered as an app mention enters only through the mention lane. The durable claim uses the verified installation and channel timestamp. A channel's top-level message sets a thread anchor at its own timestamp. A direct message without a thread stays top-level. Connector callbacks cannot move the write to a different account or channel.

```quint
type SlackCaller = SlackSocket | SlackUntrusted
type SlackMessageKey = { keyChannel: str, keyTimestamp: str }
type SlackSession = { installation: SlackInstallation, claims: List[SlackMessageKey] }
type SlackDestination = { targetAccount: str, targetChannel: str, targetThread: str }
type SlackDispatch = { inbound: SlackInbound, replyTarget: SlackDestination }
type SlackEffect = DeliverSlackEvent(SlackDispatch)
type SlackStep = { state: SlackSession, out: List[SlackEffect] }
pure val slackSampleInstallation: SlackInstallation = { accountId: "slack-1", teamId: "T1", enterpriseId: "E1", botUserId: "U0", epoch: 1 }
pure val initial: SlackSession = { installation: { ...slackSampleInstallation, accountId: "", teamId: "", botUserId: "", epoch: 0 }, claims: List() }
pure val installationValues = Set(slackSampleInstallation, { ...slackSampleInstallation, epoch: 2 })
pure val sampleSlackInbound: SlackInbound = { eventAccount: "slack-1", eventEpoch: 1, eventTeam: "T1", eventEnterprise: "E1", channelId: "C1", messageTs: "1.001", threadTs: "", senderId: "U1", conversation: SlackPublic, eventKind: SlackMention, mentionsBot: true, fromBot: false }
pure val sampleSlackPolicy: SlackAdmission = { allowBots: false, dmMode: SlackDmPairing, dmEnabled: true, dmAllowlisted: false, dmPaired: false, groupDmEnabled: false, groupDmAllowed: false, channelAllowed: true, channelUserAllowed: true, requireMention: true }
pure val inboundValues = Set(sampleSlackInbound, { ...sampleSlackInbound, eventKind: SlackMessage }, { ...sampleSlackInbound, eventEnterprise: "other" }, { ...sampleSlackInbound, senderId: "U0" })
pure val policyValues = Set(sampleSlackPolicy, { ...sampleSlackPolicy, channelAllowed: false })
pure def slackReplyTarget(inbound: SlackInbound): SlackDestination = { targetAccount: inbound.eventAccount, targetChannel: inbound.channelId, targetThread: if (inbound.threadTs != "") inbound.threadTs else if (slackIsChannel(inbound.conversation)) inbound.messageTs else "" }
pure def slackMessageKey(inbound: SlackInbound): SlackMessageKey = { keyChannel: inbound.channelId, keyTimestamp: inbound.messageTs }
pure def canBindSlack(s: SlackSession, by: SlackCaller, installation: SlackInstallation): bool = by == SlackSocket and installation.accountId != "" and installation.teamId != "" and installation.botUserId != "" and installation.epoch > s.installation.epoch
pure def bindSlack(s: SlackSession, by: SlackCaller, installation: SlackInstallation): SlackSession = { installation: installation, claims: List() }
pure def canClaimSlack(s: SlackSession, by: SlackCaller, inbound: SlackInbound, policy: SlackAdmission): bool = by == SlackSocket and (inbound.eventKind == SlackMessage or inbound.eventKind == SlackMention) and slackShouldIngest(s.installation, inbound, policy) and not(s.claims.includes(slackMessageKey(inbound)))
pure def claimSlack(s: SlackSession, by: SlackCaller, inbound: SlackInbound, policy: SlackAdmission): SlackStep = { state: { ...s, claims: s.claims.append(slackMessageKey(inbound)) }, out: List(DeliverSlackEvent({ inbound: inbound, replyTarget: slackReplyTarget(inbound) })) }
pure def slackEffectHasInstallation(s: SlackSession, deliveryEffect: SlackEffect): bool = match deliveryEffect { | DeliverSlackEvent(d) => slackWorkspaceMatches(s.installation, d.inbound) and d.replyTarget == slackReplyTarget(d.inbound) }
pure def stepSlackKeepsWorkspaceAndTarget(before: SlackSession, after: SlackSession, out: List[SlackEffect]): bool = out.every(deliveryEffect => slackEffectHasInstallation(before, deliveryEffect))
pure def sometimesSlackMentionClaims(s: SlackSession): bool = s.claims.length() > 0
pure val eval_witness_sometimesSlackMentionClaims = (("bindSlack", SlackSocket, slackSampleInstallation), ("claimSlack", SlackSocket, sampleSlackInbound, sampleSlackPolicy))
```

### The agent reads the &, < and > a Slack member typed

Slack sends a typed `&`, `<` and `>` in message text as `&amp;`, `&lt;` and `&gt;`. The text of an admitted message or mention reaches the agent with each of those three entities turned back into the character the member typed, and nothing else changed. The text is read once from left to right, so a decoded character never starts another entity: a member who typed `&lt;` (sent as `&amp;lt;`) is read as `&lt;`. Bot mentions are found in the text as Slack sent it.

```quint
pure def slackEntityText(name: str): str = if (name == "amp") "&" else if (name == "lt") "<" else if (name == "gt") ">" else ""
pure val nameValues = Set("amp", "lt", "gt", "quot", "amp;lt", "")
pure def lawSlackDecodesOnlyItsThreeEntities(name: str): bool = (slackEntityText(name) != "") iff (name == "amp" or name == "lt" or name == "gt")
```

## Story: Know how much of a Slack send reached the provider

> As an owner, I want a send with text or attachments to show the actual outcome when a part is refused or uncertain.

### Complete, partial and unconfirmed Slack sends follow distinct part receipts

The transport emits one outcome per requested text chunk or file. A provider timestamp or file ID is evidence for its accepted part. A send is complete only when every requested part has acceptance evidence. If at least one accepted part exists and another part is missing, refused or uncertain, the result is partial. An uncertain part without any accepted part remains indeterminate. A text failure prevents the adapter from starting subsequent attachment uploads for that request.

```quint
type SlackPartReceipt = SlackPartAccepted({ receiptId: str }) | SlackPartRefused | SlackPartUnknown
type SlackSendOutcome = SlackSendComplete | SlackSendPartial | SlackSendIndeterminate | SlackSendRefused
type SlackParts = { requestedParts: int, observedParts: List[SlackPartReceipt] }
pure def slackPartAccepted(part: SlackPartReceipt): bool = match part { | SlackPartAccepted(r) => r.receiptId != "" | _ => false }
pure def slackSendOutcome(parts: SlackParts): SlackSendOutcome = if (parts.requestedParts > 0 and parts.observedParts.length() == parts.requestedParts and parts.observedParts.every(part => slackPartAccepted(part))) SlackSendComplete else if (parts.observedParts.some(part => slackPartAccepted(part))) SlackSendPartial else if (parts.observedParts.includes(SlackPartUnknown)) SlackSendIndeterminate else SlackSendRefused
pure val partsValues = Set({ requestedParts: 1, observedParts: List(SlackPartAccepted({ receiptId: "provider-ts" })) }, { requestedParts: 2, observedParts: List(SlackPartUnknown, SlackPartRefused) }, { requestedParts: 0, observedParts: List() })
pure def lawSlackCompleteRequiresEvidence(parts: SlackParts): bool = slackSendOutcome(parts) == SlackSendComplete implies (parts.requestedParts > 0 and parts.observedParts.length() == parts.requestedParts and parts.observedParts.every(part => slackPartAccepted(part)))
```
