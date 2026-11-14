# Hosted digest offers, delivery and retained history

AlphaPhone imports `HostedDigestProtocol`, `DigestInbox`,
`RetainedBriefStore` and policy functions through
`apps/app/src/runtime/hosted-digests.ts`. The producer is
`plugins/plugin-workflow/src/client/hosted-digests.ts` and
`services/hosted-digest-policy.ts` at its Eliza pin. Development digest
fixtures use the same source ageing and occurrence window. The server
remains authoritative for sources and results. The client projection
uses published capability versions and its captured connection scope.

## Story: Review a missed digest only while its source and result are current

### Source freshness and newer results determine whether a retry offer is visible

A revoked source is revoked even after its expiry. Other sources expire
at the expiry instant. A scheduled wakeup more than thirty minutes late
is missed. A manual offer for a missed scheduled run requires an active,
enabled Morning loop, a current native source of the exact revision,
and a valid derived mutation ID. A newer result for the same loop or
source, or a newer on-demand run, supersedes it. Absent and mismatched
source state give no offer. This decision consumes the selected loop and
source plus the existence of a superseding row observed in the result set.

```quint
type SourceFreshness = SourceCurrent | SourceExpired | SourceRevoked
type DigestOffer = { missed: bool, loopExists: bool, removed: bool, active: bool, enabled: bool, morning: bool, nativeSource: bool, revisionMatches: bool, sourcePresent: bool, revoked: bool, expiresAt: int, loopSourceCurrent: bool, newerResult: bool, validMutation: bool }
pure def sourceFreshness(revoked: bool, expiresAt: int, now: int): SourceFreshness = if (revoked) SourceRevoked else if (expiresAt <= now) SourceExpired else SourceCurrent
pure def missedOccurrence(scheduledAt: int, now: int): bool = now - scheduledAt > 1800000
pure def offersMissedRun(facts: DigestOffer, now: int): bool = facts.missed and facts.loopExists and not(facts.removed) and facts.active and facts.enabled and facts.morning and facts.nativeSource and facts.revisionMatches and facts.sourcePresent and sourceFreshness(facts.revoked, facts.expiresAt, now) == SourceCurrent and facts.loopSourceCurrent and not(facts.newerResult) and facts.validMutation
pure val factsValues = Set(
  { missed: true, loopExists: true, removed: false, active: true, enabled: true, morning: true, nativeSource: true, revisionMatches: true, sourcePresent: true, revoked: false, expiresAt: 10, loopSourceCurrent: true, newerResult: false, validMutation: true },
  { missed: true, loopExists: true, removed: false, active: true, enabled: true, morning: true, nativeSource: true, revisionMatches: true, sourcePresent: true, revoked: false, expiresAt: 10, loopSourceCurrent: true, newerResult: true, validMutation: true })
pure val nowValues = Set(0, 9, 10, 1800001)
pure def lawNoOfferWithoutCurrentSource(facts: DigestOffer, now: int): bool = offersMissedRun(facts, now) implies (facts.nativeSource and facts.revisionMatches and facts.sourcePresent and not(facts.revoked) and facts.expiresAt > now)
pure def lawLaterResultsSupersedeOffer(facts: DigestOffer, now: int): bool = facts.newerResult implies not(offersMissedRun(facts, now))
```

## Story: Recover one digest result without acknowledging an uncommitted record

### The local index commits before notice delivery and server cursor acknowledgement

A scope serializes its inbox work. The index stores client ID, ordered
result identities, pending notices and pending removal. Bytes for a result
are saved before the index records it. An existing row must match the
incoming value. Once indexed, its notice can be attempted repeatedly.
The server cursor advances only after the local result and index commit.
A lost response leaves the committed result for recovery. On retirement,
in-flight writes can still land, and a later sync reads their durable
state. The source retains the most recent 100 result IDs and journals
cleanup before deleting evicted bytes. This slice models one retained
result within the bound. It models each persistent confirmation separately.

```quint
type DigestDelivery = { scope: str, runId: str, valueKey: str, indexed: bool, noticeDue: bool, acknowledged: bool, retired: bool }
pure val initial: DigestDelivery = { scope: "", runId: "", valueKey: "", indexed: false, noticeDue: false, acknowledged: false, retired: false }
pure def canBindDigestInbox(d: DigestDelivery, scope: str): bool = d.scope == "" and scope != ""
pure def bindDigestInbox(d: DigestDelivery, scope: str): DigestDelivery = { ...d, scope: scope }
pure def canStoreDigestResult(d: DigestDelivery, scope: str, runId: str, valueKey: str): bool = d.scope != "" and d.scope == scope and not(d.retired) and runId != "" and valueKey != "" and (d.runId == "" or (d.runId == runId and d.valueKey == valueKey))
pure def storeDigestResult(d: DigestDelivery, scope: str, runId: str, valueKey: str): DigestDelivery = { ...d, runId: runId, valueKey: valueKey }
pure def canIndexDigestResult(d: DigestDelivery): bool = d.runId != "" and not(d.indexed) and not(d.retired)
pure def indexDigestResult(d: DigestDelivery): DigestDelivery = { ...d, indexed: true, noticeDue: true }
pure def canObserveDigestNotice(d: DigestDelivery): bool = d.noticeDue and not(d.retired)
pure def observeDigestNotice(d: DigestDelivery, delivered: bool): DigestDelivery = { ...d, noticeDue: not(delivered) }
pure def canAcknowledgeDigest(d: DigestDelivery): bool = d.indexed and not(d.retired)
pure def acknowledgeDigest(d: DigestDelivery, confirmed: bool): DigestDelivery = { ...d, acknowledged: d.acknowledged or confirmed }
pure def retireDigestSync(d: DigestDelivery): DigestDelivery = { ...d, retired: true }
pure def canResumeDigestSync(d: DigestDelivery): bool = d.retired
pure def resumeDigestSync(d: DigestDelivery): DigestDelivery = { ...d, retired: false }
pure val scopeValues = Set("", "active-owner", "other-owner")
pure val runIdValues = Set("run-a", "run-b")
pure val valueKeyValues = Set("digest-a", "digest-b")
pure def alwaysAcknowledgementFollowsIndex(d: DigestDelivery): bool = (d.acknowledged or d.noticeDue) implies d.indexed
pure def alwaysIndexRefersToStoredResult(d: DigestDelivery): bool = (d.indexed implies d.runId != "") and (d.runId != "" implies d.scope != "" and d.valueKey != "")
pure def stepEstablishedResultDoesNotChange(before: DigestDelivery, after: DigestDelivery): bool = before.runId != "" implies before.runId == after.runId and before.valueKey == after.valueKey
pure def sometimesIndexedWithoutRemoteAck(d: DigestDelivery): bool = d.indexed and not(d.acknowledged)
pure def sometimesAcknowledgedWithNoticePending(d: DigestDelivery): bool = d.acknowledged and d.noticeDue
```
