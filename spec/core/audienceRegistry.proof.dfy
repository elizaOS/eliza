lemma AudienceRegistryBridge(s: AudienceRegistry)
  ensures alwaysRegistryIdentitiesAreUnique(s) <==>
    (s.nextBinding > 0 && s.nextCarrier > 0 && (forall signal :: signal in s.abortedSignals ==> signal > 0) &&
     (forall r :: r in s.records ==> (r.id > 0 && r.id < s.nextBinding && |ProofLib.Filter((other: AudienceBindingRecord) => other.id == r.id,s.records)| == 1)) &&
     (forall c :: c in s.carriers ==> (c.id > 0 && c.id < s.nextCarrier && |ProofLib.Filter((other: SuppressionCarrier) => other.id == c.id,s.carriers)| == 1)) &&
     (forall m :: m in s.messages ==> (m.id > 0 && |ProofLib.Filter((other: AudienceMessage) => other.id == m.id,s.messages)| == 1 &&
       (m.binding == 0 || exists r :: r in s.records && r.id == m.binding) &&
       (m.carrier == 0 || exists c :: c in s.carriers && c.id == m.carrier))))
{}

lemma AudienceSelectedMessage(s: AudienceRegistry, id: int)
  ensures messageAt(s, id) == emptyMessage || (messageAt(s, id) in s.messages && messageAt(s, id).id == id)
{
  var filtered := ProofLib.Filter((message: AudienceMessage) => (message.id == id), s.messages);
  if |filtered| > 0 {
    ProofLib.FilterMember((message: AudienceMessage) => (message.id == id), s.messages, filtered[0]);
  }
}

lemma AudienceEvidenceForBinding(s: AudienceRegistry, id: int)
  requires inv(s)
  ensures core__trustedAudience_inv(bindingEvidence(s, id))
  ensures (exists r :: r in s.records && r.id == id) ==> (bindingEvidence(s, id).now == s.now &&
    (forall entry :: entry in bindingEvidence(s, id).records ==> entry.evidence.sequence > 0 && entry.evidence.sequence <= s.attestationSequence) &&
    (forall call :: call in bindingEvidence(s, id).renewals ==> call.derived.sequence == 0 || call.derived.sequence <= s.attestationSequence))
  ensures forall r :: r in s.records && r.id == id ==> bindingEvidence(s, id) == r.evidence
{
  AudienceRegistryBridge(s);
  var filtered := ProofLib.Filter((record: AudienceBindingRecord) => (record.id == id), s.records);
  if |filtered| > 0 {
    ProofLib.FilterMember((record: AudienceBindingRecord) => (record.id == id), s.records, filtered[0]);
    assert core__trustedAudience_inv(filtered[0].evidence);
  } else {
    core__trustedAudience_initialHolds_ensures();
  }
  forall r | r in s.records && r.id == id
    ensures bindingEvidence(s, id) == r.evidence
  {
    ProofLib.FilterMember((record: AudienceBindingRecord) => (record.id == id), s.records, r);
    ProofLib.FilterSamePredicate((other: AudienceBindingRecord) => (other.id == r.id), (record: AudienceBindingRecord) => (record.id == id), s.records);
    assert |filtered| == 1;
  }
}

lemma AudienceAppendMessage(s: AudienceRegistry, t: AudienceRegistry, m: AudienceMessage)
  requires inv(s) && t.records == s.records && t.nextBinding == s.nextBinding
  requires t.carriers == s.carriers && t.nextCarrier == s.nextCarrier && t.abortedSignals == s.abortedSignals
  requires m.id > 0 && t.messages == s.messages + [m]
  requires !(exists before :: before in s.messages && before.id == m.id)
  requires m.binding == 0 || exists r :: r in s.records && r.id == m.binding
  requires m.carrier == 0 || exists c :: c in s.carriers && c.id == m.carrier
  ensures alwaysRegistryIdentitiesAreUnique(t)
{
  AudienceRegistryBridge(s);
  AudienceRegistryBridge(t);
  forall row | row in t.messages
    ensures row.id > 0 && |ProofLib.Filter((other: AudienceMessage) => other.id == row.id,t.messages)| == 1
    ensures (row.binding == 0 || exists r :: r in t.records && r.id == row.binding) && (row.carrier == 0 || exists c :: c in t.carriers && c.id == row.carrier)
  {
    if row == m {
      ProofLib.FilterOne((other: AudienceMessage) => other.id == row.id,t.messages,|s.messages|);
    } else {
      assert row in s.messages && row.id != m.id;
      ProofLib.FilterAppend((other: AudienceMessage) => other.id == row.id,s.messages,m);
    }
  }
}

lemma AudienceRecordsIdentityReframe(s: AudienceRegistry, t: AudienceRegistry)
  requires alwaysRegistryIdentitiesAreUnique(s) && t.messages == s.messages && t.nextBinding == s.nextBinding
  requires t.carriers == s.carriers && t.nextCarrier == s.nextCarrier && t.abortedSignals == s.abortedSignals
  requires |s.records| == |t.records|
  requires forall i :: 0 <= i < |s.records| ==> s.records[i].id == t.records[i].id
  ensures alwaysRegistryIdentitiesAreUnique(t)
{
  AudienceRegistryBridge(s);
  AudienceRegistryBridge(t);
  forall r | r in t.records
    ensures r.id > 0 && r.id < t.nextBinding && |ProofLib.Filter((other: AudienceBindingRecord) => other.id == r.id,t.records)| == 1
  {
    var i :| 0 <= i < |t.records| && t.records[i] == r;
    var before := s.records[i];
    assert before in s.records && before.id == r.id;
    ProofLib.FilterLengthPointwise((other: AudienceBindingRecord) => other.id == before.id,(other: AudienceBindingRecord) => other.id == r.id,s.records,t.records);
  }
  forall m | m in t.messages && m.binding != 0
    ensures exists r :: r in t.records && r.id == m.binding
  {
    var r :| r in s.records && r.id == m.binding;
    var i :| 0 <= i < |s.records| && s.records[i] == r;
    assert t.records[i] in t.records && t.records[i].id == r.id;
  }
}

lemma AudienceRecordsReframe(s: AudienceRegistry, t: AudienceRegistry)
  requires inv(s) && t.messages == s.messages && t.nextBinding == s.nextBinding && t.attestationSequence >= 0
  requires t.carriers == s.carriers && t.nextCarrier == s.nextCarrier && t.abortedSignals == s.abortedSignals
  requires |s.records| == |t.records|
  requires forall i :: 0 <= i < |s.records| ==> s.records[i].id == t.records[i].id
  requires forall i :: 0 <= i < |t.records| ==> (core__trustedAudience_inv(t.records[i].evidence) && t.records[i].evidence.now == t.now &&
    (forall entry :: entry in t.records[i].evidence.records ==> entry.evidence.sequence > 0 && entry.evidence.sequence <= t.attestationSequence) &&
    (forall call :: call in t.records[i].evidence.renewals ==> call.derived.sequence == 0 || call.derived.sequence <= t.attestationSequence))
  ensures inv(t)
{
  AudienceRecordsIdentityReframe(s, t);
  forall r | r in t.records
    ensures core__trustedAudience_inv(r.evidence) && r.evidence.now == t.now &&
      (forall entry :: entry in r.evidence.records ==> entry.evidence.sequence > 0 && entry.evidence.sequence <= t.attestationSequence) &&
      (forall call :: call in r.evidence.renewals ==> call.derived.sequence == 0 || call.derived.sequence <= t.attestationSequence)
  {
    var i :| 0 <= i < |t.records| && t.records[i] == r;
  }
}

lemma AudienceReplace(s: AudienceRegistry, t: AudienceRegistry, binding: int, e: core__trustedAudience_AudienceLease)
  requires inv(s) && t.attestationSequence >= s.attestationSequence
  requires t == replaceEvidence(e,binding,s).(attestationSequence := t.attestationSequence)
  requires (exists r :: r in s.records && r.id == binding) ==> (core__trustedAudience_inv(e) && e.now == s.now &&
    (forall entry :: entry in e.records ==> entry.evidence.sequence > 0 && entry.evidence.sequence <= t.attestationSequence) &&
    (forall call :: call in e.renewals ==> call.derived.sequence == 0 || call.derived.sequence <= t.attestationSequence))
  ensures inv(t) && stepGlobalSequenceNeverDecreases(s,"",t)
{
  AudienceRegistryBridge(s);
  forall i | 0 <= i < |s.records|
    ensures s.records[i].id == t.records[i].id
    ensures core__trustedAudience_inv(t.records[i].evidence) && t.records[i].evidence.now == t.now &&
      (forall entry :: entry in t.records[i].evidence.records ==> entry.evidence.sequence > 0 && entry.evidence.sequence <= t.attestationSequence) &&
      (forall call :: call in t.records[i].evidence.renewals ==> call.derived.sequence == 0 || call.derived.sequence <= t.attestationSequence)
  {
    assert s.records[i] in s.records;
  }
  AudienceRecordsReframe(s,t);
}

lemma createMessage_ensures(s: AudienceRegistry, messageId: int)
  ensures (inv(s) ==> canCreateMessage(s, messageId) ==> alwaysRegistryIdentitiesAreUnique(createMessage(s, messageId)))
  ensures (inv(s) ==> canCreateMessage(s, messageId) ==> alwaysGlobalAttestationSequenceDominates(createMessage(s, messageId)))
  ensures (inv(s) ==> canCreateMessage(s, messageId) ==> alwaysEveryBindingRetainsLeaseRules(createMessage(s, messageId)))
  ensures (inv(s) ==> canCreateMessage(s, messageId) ==> stepGlobalSequenceNeverDecreases(s, "createMessage", createMessage(s, messageId)))

{
  if inv(s) && canCreateMessage(s, messageId) {
    AudienceAppendMessage(s, createMessage(s, messageId), AudienceMessage(messageId, 0, 0));
  }
}

lemma serializeMessage_ensures(s: AudienceRegistry, messageId: int, copyId: int)
  ensures (inv(s) ==> canSerializeMessage(s, messageId, copyId) ==> alwaysRegistryIdentitiesAreUnique(serializeMessage(s, messageId, copyId)))
  ensures (inv(s) ==> canSerializeMessage(s, messageId, copyId) ==> alwaysGlobalAttestationSequenceDominates(serializeMessage(s, messageId, copyId)))
  ensures (inv(s) ==> canSerializeMessage(s, messageId, copyId) ==> alwaysEveryBindingRetainsLeaseRules(serializeMessage(s, messageId, copyId)))
  ensures (inv(s) ==> canSerializeMessage(s, messageId, copyId) ==> stepGlobalSequenceNeverDecreases(s, "serializeMessage", serializeMessage(s, messageId, copyId)))

{
  if inv(s) && canSerializeMessage(s, messageId, copyId) {
    AudienceAppendMessage(s, serializeMessage(s, messageId, copyId), AudienceMessage(copyId, 0, 0));
  }
}

lemma spreadMessage_ensures(s: AudienceRegistry, messageId: int, copyId: int)
  ensures (inv(s) ==> canSpreadMessage(s, messageId, copyId) ==> alwaysRegistryIdentitiesAreUnique(spreadMessage(s, messageId, copyId)))
  ensures (inv(s) ==> canSpreadMessage(s, messageId, copyId) ==> alwaysGlobalAttestationSequenceDominates(spreadMessage(s, messageId, copyId)))
  ensures (inv(s) ==> canSpreadMessage(s, messageId, copyId) ==> alwaysEveryBindingRetainsLeaseRules(spreadMessage(s, messageId, copyId)))
  ensures (inv(s) ==> canSpreadMessage(s, messageId, copyId) ==> stepGlobalSequenceNeverDecreases(s, "spreadMessage", spreadMessage(s, messageId, copyId)))

{
  if inv(s) && canSpreadMessage(s, messageId, copyId) {
    AudienceSelectedMessage(s, messageId);
    AudienceRegistryBridge(s);
    AudienceAppendMessage(s, spreadMessage(s, messageId, copyId), messageAt(s, messageId).(id := copyId));
  }
}

lemma cancel_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, signal: int)
  ensures (inv(s) ==> canCancel(s, by_, signal) ==> alwaysRegistryIdentitiesAreUnique(cancel(s, by_, signal)))
  ensures (inv(s) ==> canCancel(s, by_, signal) ==> alwaysGlobalAttestationSequenceDominates(cancel(s, by_, signal)))
  ensures (inv(s) ==> canCancel(s, by_, signal) ==> alwaysEveryBindingRetainsLeaseRules(cancel(s, by_, signal)))
  ensures (inv(s) ==> canCancel(s, by_, signal) ==> stepGlobalSequenceNeverDecreases(s, "cancel", cancel(s, by_, signal)))

{
  if inv(s) && canCancel(s, by_, signal) {
    AudienceRegistryBridge(s);
    AudienceRegistryBridge(cancel(s, by_, signal));
    forall observed | observed in cancel(s, by_, signal).abortedSignals
      ensures observed > 0
    {
      ProofLib.FilterMember((set_x: int) => !((set_x in s.abortedSignals)), [signal], observed);
    }
  }
}

lemma setTime_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, time: int)
  ensures (inv(s) ==> canSetTime(s, by_, time) ==> alwaysRegistryIdentitiesAreUnique(setTime(s, by_, time)))
  ensures (inv(s) ==> canSetTime(s, by_, time) ==> alwaysGlobalAttestationSequenceDominates(setTime(s, by_, time)))
  ensures (inv(s) ==> canSetTime(s, by_, time) ==> alwaysEveryBindingRetainsLeaseRules(setTime(s, by_, time)))
  ensures (inv(s) ==> canSetTime(s, by_, time) ==> stepGlobalSequenceNeverDecreases(s, "setTime", setTime(s, by_, time)))

{
  if inv(s) && canSetTime(s, by_, time) {
    var t := setTime(s, by_, time);
    forall i | 0 <= i < |s.records|
      ensures s.records[i].id == t.records[i].id
      ensures core__trustedAudience_inv(t.records[i].evidence) && t.records[i].evidence.now == t.now &&
        (forall entry :: entry in t.records[i].evidence.records ==> entry.evidence.sequence > 0 && entry.evidence.sequence <= t.attestationSequence) &&
        (forall call :: call in t.records[i].evidence.renewals ==> call.derived.sequence == 0 || call.derived.sequence <= t.attestationSequence)
    {
      assert s.records[i] in s.records;
      core__trustedAudience_setTime_ensures(s.records[i].evidence, by_, time);
    }
    AudienceRecordsReframe(s, t);
  }
}

lemma beginTurn_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, messageId: int, runtimeId: string, signal: int)
  ensures (inv(s) ==> canBeginTurn(s, by_, messageId, runtimeId, signal) ==> alwaysRegistryIdentitiesAreUnique(beginTurn(s, by_, messageId, runtimeId, signal)))
  ensures (inv(s) ==> canBeginTurn(s, by_, messageId, runtimeId, signal) ==> alwaysGlobalAttestationSequenceDominates(beginTurn(s, by_, messageId, runtimeId, signal)))
  ensures (inv(s) ==> canBeginTurn(s, by_, messageId, runtimeId, signal) ==> alwaysEveryBindingRetainsLeaseRules(beginTurn(s, by_, messageId, runtimeId, signal)))
  ensures (inv(s) ==> canBeginTurn(s, by_, messageId, runtimeId, signal) ==> stepGlobalSequenceNeverDecreases(s, "beginTurn", beginTurn(s, by_, messageId, runtimeId, signal)))

{
  if inv(s) && canBeginTurn(s, by_, messageId, runtimeId, signal) {
    var binding := messageBinding(s, messageId);
    var before := bindingEvidence(s, binding);
    var t := beginTurn(s, by_, messageId, runtimeId, signal);
    AudienceEvidenceForBinding(s, binding);
    core__trustedAudience_beginTurn_ensures(before, by_, runtimeId, signal);
    var e := core__trustedAudience_beginTurn(before, by_, runtimeId, signal);
    if exists r :: r in s.records && r.id == binding {
      forall entry | entry in e.records
        ensures entry.evidence.sequence > 0 && entry.evidence.sequence <= t.attestationSequence
      {
        var i :| 0 <= i < |e.records| && e.records[i] == entry;
        assert before.records[i] in before.records;
      }
    }
    AudienceReplace(s, t, binding, e);
  }
}

lemma endTurn_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, bindingId: int, lease: int)
  ensures (inv(s) ==> canEndTurn(s, by_, bindingId, lease) ==> alwaysRegistryIdentitiesAreUnique(endTurn(s, by_, bindingId, lease)))
  ensures (inv(s) ==> canEndTurn(s, by_, bindingId, lease) ==> alwaysGlobalAttestationSequenceDominates(endTurn(s, by_, bindingId, lease)))
  ensures (inv(s) ==> canEndTurn(s, by_, bindingId, lease) ==> alwaysEveryBindingRetainsLeaseRules(endTurn(s, by_, bindingId, lease)))
  ensures (inv(s) ==> canEndTurn(s, by_, bindingId, lease) ==> stepGlobalSequenceNeverDecreases(s, "endTurn", endTurn(s, by_, bindingId, lease)))

{
  if inv(s) && canEndTurn(s, by_, bindingId, lease) {
    var binding := bindingId;
    var before := bindingEvidence(s, binding);
    var t := endTurn(s, by_, bindingId, lease);
    AudienceEvidenceForBinding(s, binding);
    core__trustedAudience_endTurn_ensures(before, by_, lease);
    var e := core__trustedAudience_endTurn(before, by_, lease);
    if exists r :: r in s.records && r.id == binding {
      forall entry | entry in e.records
        ensures entry.evidence.sequence > 0 && entry.evidence.sequence <= t.attestationSequence
      {
        var i :| 0 <= i < |e.records| && e.records[i] == entry;
        assert before.records[i] in before.records;
      }
    }
    AudienceReplace(s, t, binding, e);
  }
}

lemma beginRenewal_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, messageId: int, runtimeId: string, identityMatches: bool)
  ensures (inv(s) ==> canBeginRenewal(s, by_, messageId, runtimeId, identityMatches) ==> alwaysRegistryIdentitiesAreUnique(beginRenewal(s, by_, messageId, runtimeId, identityMatches)))
  ensures (inv(s) ==> canBeginRenewal(s, by_, messageId, runtimeId, identityMatches) ==> alwaysGlobalAttestationSequenceDominates(beginRenewal(s, by_, messageId, runtimeId, identityMatches)))
  ensures (inv(s) ==> canBeginRenewal(s, by_, messageId, runtimeId, identityMatches) ==> alwaysEveryBindingRetainsLeaseRules(beginRenewal(s, by_, messageId, runtimeId, identityMatches)))
  ensures (inv(s) ==> canBeginRenewal(s, by_, messageId, runtimeId, identityMatches) ==> stepGlobalSequenceNeverDecreases(s, "beginRenewal", beginRenewal(s, by_, messageId, runtimeId, identityMatches)))

{
  if inv(s) && canBeginRenewal(s, by_, messageId, runtimeId, identityMatches) {
    var binding := messageBinding(s, messageId);
    var before := bindingEvidence(s, binding);
    var t := beginRenewal(s, by_, messageId, runtimeId, identityMatches);
    AudienceEvidenceForBinding(s, binding);
    core__trustedAudience_beginRenewal_ensures(before, by_, runtimeId, identityMatches, signalIsAborted(s, core__trustedAudience_turnLease(before, core__trustedAudience_currentRecord(before).installedLease).signal));
    var e := core__trustedAudience_beginRenewal(before, by_, runtimeId, identityMatches, signalIsAborted(s, core__trustedAudience_turnLease(before, core__trustedAudience_currentRecord(before).installedLease).signal));
    AudienceReplace(s, t, binding, e);
  }
}

lemma observeRenewalAuthority_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, bindingId: int, renewalId: int, authority: core__trustedAudience_AuthorityObservation)
  ensures (inv(s) ==> canObserveRenewalAuthority(s, by_, bindingId, renewalId, authority) ==> alwaysRegistryIdentitiesAreUnique(observeRenewalAuthority(s, by_, bindingId, renewalId, authority)))
  ensures (inv(s) ==> canObserveRenewalAuthority(s, by_, bindingId, renewalId, authority) ==> alwaysGlobalAttestationSequenceDominates(observeRenewalAuthority(s, by_, bindingId, renewalId, authority)))
  ensures (inv(s) ==> canObserveRenewalAuthority(s, by_, bindingId, renewalId, authority) ==> alwaysEveryBindingRetainsLeaseRules(observeRenewalAuthority(s, by_, bindingId, renewalId, authority)))
  ensures (inv(s) ==> canObserveRenewalAuthority(s, by_, bindingId, renewalId, authority) ==> stepGlobalSequenceNeverDecreases(s, "observeRenewalAuthority", observeRenewalAuthority(s, by_, bindingId, renewalId, authority)))

{
  if inv(s) && canObserveRenewalAuthority(s, by_, bindingId, renewalId, authority) {
    var binding := bindingId;
    var before := bindingEvidence(s, binding);
    var t := observeRenewalAuthority(s, by_, bindingId, renewalId, authority);
    AudienceEvidenceForBinding(s, binding);
    core__trustedAudience_observeRenewalAuthority_ensures(before, by_, renewalId, authority, (if core__trustedAudience_authorityDerived(authority) then s.attestationSequence + 1 else 0));
    var e := core__trustedAudience_observeRenewalAuthority(before, by_, renewalId, authority, (if core__trustedAudience_authorityDerived(authority) then s.attestationSequence + 1 else 0));
    if exists r :: r in s.records && r.id == binding {
      forall call | call in e.renewals
        ensures call.derived.sequence == 0 || call.derived.sequence <= t.attestationSequence
      {
        var i :| 0 <= i < |e.renewals| && e.renewals[i] == call;
        assert before.renewals[i] in before.renewals;
      }
    }
    AudienceReplace(s, t, binding, e);
  }
}

lemma finishRenewal_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, bindingId: int, renewalId: int)
  ensures (inv(s) ==> canFinishRenewal(s, by_, bindingId, renewalId) ==> alwaysRegistryIdentitiesAreUnique(finishRenewal(s, by_, bindingId, renewalId)))
  ensures (inv(s) ==> canFinishRenewal(s, by_, bindingId, renewalId) ==> alwaysGlobalAttestationSequenceDominates(finishRenewal(s, by_, bindingId, renewalId)))
  ensures (inv(s) ==> canFinishRenewal(s, by_, bindingId, renewalId) ==> alwaysEveryBindingRetainsLeaseRules(finishRenewal(s, by_, bindingId, renewalId)))
  ensures (inv(s) ==> canFinishRenewal(s, by_, bindingId, renewalId) ==> stepGlobalSequenceNeverDecreases(s, "finishRenewal", finishRenewal(s, by_, bindingId, renewalId)))

{
  if inv(s) && canFinishRenewal(s, by_, bindingId, renewalId) {
    var binding := bindingId;
    var before := bindingEvidence(s, binding);
    var t := finishRenewal(s, by_, bindingId, renewalId);
    AudienceEvidenceForBinding(s, binding);
    core__trustedAudience_finishRenewal_ensures(before, by_, renewalId, signalIsAborted(s, core__trustedAudience_turnLease(before, core__trustedAudience_renewalAt(before, renewalId).leaseId).signal));
    var e := core__trustedAudience_finishRenewal(before, by_, renewalId, signalIsAborted(s, core__trustedAudience_turnLease(before, core__trustedAudience_renewalAt(before, renewalId).leaseId).signal));
    var captured := core__trustedAudience_renewalAt(before, renewalId);
    var selected := ProofLib.Filter((call: core__trustedAudience_AudienceRenewal) => (call.id == renewalId), before.renewals);
    if |selected| > 0 {
      ProofLib.FilterMember((call: core__trustedAudience_AudienceRenewal) => (call.id == renewalId), before.renewals, selected[0]);
    }
    if exists r :: r in s.records && r.id == binding {
      forall entry | entry in e.records
        ensures entry.evidence.sequence > 0 && entry.evidence.sequence <= t.attestationSequence
      {
        var i :| 0 <= i < |e.records| && e.records[i] == entry;
        assert before.records[i] in before.records;
      }
    }
    AudienceReplace(s, t, binding, e);
  }
}

lemma checkDisclosure_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, messageId: int, runtimeId: string, internalActorTrusted: bool, currentAudience: core__trustedAudience_Audience, lookupSucceeded: bool)
  ensures (inv(s) ==> alwaysRegistryIdentitiesAreUnique(checkDisclosure(s, by_, messageId, runtimeId, internalActorTrusted, currentAudience, lookupSucceeded)))
  ensures (inv(s) ==> alwaysGlobalAttestationSequenceDominates(checkDisclosure(s, by_, messageId, runtimeId, internalActorTrusted, currentAudience, lookupSucceeded)))
  ensures (inv(s) ==> alwaysEveryBindingRetainsLeaseRules(checkDisclosure(s, by_, messageId, runtimeId, internalActorTrusted, currentAudience, lookupSucceeded)))
  ensures (inv(s) ==> stepGlobalSequenceNeverDecreases(s, "checkDisclosure", checkDisclosure(s, by_, messageId, runtimeId, internalActorTrusted, currentAudience, lookupSucceeded)))

{
  if inv(s) {
    var binding := messageBinding(s, messageId);
    var before := bindingEvidence(s, binding);
    var t := checkDisclosure(s, by_, messageId, runtimeId, internalActorTrusted, currentAudience, lookupSucceeded);
    AudienceEvidenceForBinding(s, binding);
    core__trustedAudience_checkDisclosure_ensures(before, by_, runtimeId, internalActorTrusted, currentAudience, lookupSucceeded);
    var e := core__trustedAudience_checkDisclosure(before, by_, runtimeId, internalActorTrusted, currentAudience, lookupSucceeded);
    AudienceReplace(s, t, binding, e);
  }
}

lemma markSensitiveUsed_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, messageId: int)
  ensures (inv(s) ==> canMarkSensitiveUsed(s, by_, messageId) ==> alwaysRegistryIdentitiesAreUnique(markSensitiveUsed(s, by_, messageId)))
  ensures (inv(s) ==> canMarkSensitiveUsed(s, by_, messageId) ==> alwaysGlobalAttestationSequenceDominates(markSensitiveUsed(s, by_, messageId)))
  ensures (inv(s) ==> canMarkSensitiveUsed(s, by_, messageId) ==> alwaysEveryBindingRetainsLeaseRules(markSensitiveUsed(s, by_, messageId)))
  ensures (inv(s) ==> canMarkSensitiveUsed(s, by_, messageId) ==> stepGlobalSequenceNeverDecreases(s, "markSensitiveUsed", markSensitiveUsed(s, by_, messageId)))

{
  if inv(s) && canMarkSensitiveUsed(s, by_, messageId) {
    var binding := messageBinding(s, messageId);
    var before := bindingEvidence(s, binding);
    var t := markSensitiveUsed(s, by_, messageId);
    AudienceEvidenceForBinding(s, binding);
    core__trustedAudience_markSensitiveUsed_ensures(before, by_);
    var e := core__trustedAudience_markSensitiveUsed(before, by_);
    if exists r :: r in s.records && r.id == binding {
      forall entry | entry in e.records
        ensures entry.evidence.sequence > 0 && entry.evidence.sequence <= t.attestationSequence
      {
        var i :| 0 <= i < |e.records| && e.records[i] == entry;
        assert before.records[i] in before.records;
      }
    }
    AudienceReplace(s, t, binding, e);
  }
}

lemma AudienceAttestIdentity(s: AudienceRegistry,t: AudienceRegistry,msg: int, bound: int)
  requires inv(s) && t.nextBinding >= s.nextBinding && t.attestationSequence > 0
  requires t.carriers == s.carriers && t.nextCarrier == s.nextCarrier && t.abortedSignals == s.abortedSignals
  requires |s.messages| == |t.messages|
  requires forall i :: 0 <= i < |s.messages| ==> (t.messages[i].id == s.messages[i].id && t.messages[i].carrier == s.messages[i].carrier &&
    t.messages[i].binding == (if s.messages[i].id == msg then bound else s.messages[i].binding))
  requires exists r :: r in t.records && r.id == bound
  requires forall r :: r in s.records ==> exists updated :: updated in t.records && updated.id == r.id
  requires forall r :: r in t.records ==> (r.id > 0 && r.id < t.nextBinding && |ProofLib.Filter((other: AudienceBindingRecord) => other.id == r.id,t.records)| == 1)
  ensures alwaysRegistryIdentitiesAreUnique(t)
{
  AudienceRegistryBridge(s);
  AudienceRegistryBridge(t);
  forall m | m in t.messages
    ensures m.id > 0 && |ProofLib.Filter((other: AudienceMessage) => other.id == m.id,t.messages)| == 1 &&
      (m.binding == 0 || exists r :: r in t.records && r.id == m.binding) && (m.carrier == 0 || exists c :: c in t.carriers && c.id == m.carrier)
  {
    var i :| 0 <= i < |t.messages| && t.messages[i] == m;
    var prior := s.messages[i];
    assert prior in s.messages && prior.id == m.id;
    ProofLib.FilterLengthPointwise((other: AudienceMessage) => other.id == prior.id,(other: AudienceMessage) => other.id == m.id,s.messages,t.messages);
    if m.id != msg && m.binding != 0 {
      var saved :| saved in s.records && saved.id == m.binding;
    }
  }
}

lemma AudienceAttestRecords(s: AudienceRegistry,t: AudienceRegistry,bound: int, e: core__trustedAudience_AudienceLease)
  requires inv(s) && core__trustedAudience_inv(e) &&
    (forall entry :: entry in e.records ==> entry.evidence.sequence > 0 && entry.evidence.sequence <= t.attestationSequence) &&
    (forall call :: call in e.renewals ==> call.derived.sequence == 0 || call.derived.sequence <= t.attestationSequence)
  requires t.attestationSequence > s.attestationSequence && e.now == t.now && t.now == s.now
  requires (bound == s.nextBinding && t.nextBinding == s.nextBinding + 1 && t.records == s.records + [AudienceBindingRecord(bound,e)]) ||
    (t.nextBinding == s.nextBinding && |t.records| == |s.records| && (exists prior :: prior in s.records && prior.id == bound) &&
     (forall i :: 0 <= i < |s.records| ==> t.records[i] == (if s.records[i].id == bound then s.records[i].(evidence := e) else s.records[i])))
  ensures alwaysEveryBindingRetainsLeaseRules(t) && alwaysGlobalAttestationSequenceDominates(t)
  ensures exists r :: r in t.records && r.id == bound
  ensures forall r :: r in s.records ==> exists updated :: updated in t.records && updated.id == r.id
  ensures forall r :: r in t.records ==> (r.id > 0 && r.id < t.nextBinding && |ProofLib.Filter((other: AudienceBindingRecord) => other.id == r.id,t.records)| == 1)
{
  AudienceRegistryBridge(s);
  if |t.records| > |s.records| {
    var appended := t.records[|s.records|];
    assert appended in t.records && appended.id == bound;
    forall r | r in t.records
      ensures r.id > 0 && r.id < t.nextBinding && |ProofLib.Filter((other: AudienceBindingRecord) => other.id == r.id,t.records)| == 1
      ensures core__trustedAudience_inv(r.evidence) && r.evidence.now == t.now &&
        (forall entry :: entry in r.evidence.records ==> entry.evidence.sequence > 0 && entry.evidence.sequence <= t.attestationSequence) &&
        (forall call :: call in r.evidence.renewals ==> call.derived.sequence == 0 || call.derived.sequence <= t.attestationSequence)
    {
      if r == appended { ProofLib.FilterOne((other: AudienceBindingRecord) => other.id == r.id,t.records,|s.records|); }
      else {
        assert r in s.records && r.id != appended.id;
        ProofLib.FilterAppend((other: AudienceBindingRecord) => other.id == r.id,s.records,appended);
      }
    }
  } else {
    forall r | r in t.records
      ensures r.id > 0 && r.id < t.nextBinding && |ProofLib.Filter((other: AudienceBindingRecord) => other.id == r.id,t.records)| == 1
      ensures core__trustedAudience_inv(r.evidence) && r.evidence.now == t.now &&
        (forall entry :: entry in r.evidence.records ==> entry.evidence.sequence > 0 && entry.evidence.sequence <= t.attestationSequence) &&
        (forall call :: call in r.evidence.renewals ==> call.derived.sequence == 0 || call.derived.sequence <= t.attestationSequence)
    {
      var i :| 0 <= i < |t.records| && t.records[i] == r;
      var prior := s.records[i];
      assert prior in s.records && prior.id == r.id;
      forall j | 0 <= j < |s.records|
        ensures s.records[j].id == t.records[j].id {}
      ProofLib.FilterLengthPointwise((other: AudienceBindingRecord) => other.id == prior.id,(other: AudienceBindingRecord) => other.id == r.id,s.records,t.records);
    }
  }
  forall oldRecord | oldRecord in s.records
    ensures exists updated :: updated in t.records && updated.id == oldRecord.id
  {
    var i :| 0 <= i < |s.records| && s.records[i] == oldRecord;
    assert t.records[i] in t.records && t.records[i].id == oldRecord.id;
  }
  if |t.records| == |s.records| {
    var prior :| prior in s.records && prior.id == bound;
    var r :| r in t.records && r.id == prior.id;
  }
}


lemma AudienceBindingZero(s: AudienceRegistry)
  requires inv(s)
  ensures bindingEvidence(s, 0) == core__trustedAudience_initial
{
  AudienceRegistryBridge(s);
  ProofLib.FilterNone((record: AudienceBindingRecord) => (record.id == 0), s.records);
}

lemma attest_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, messageId: int, audience: core__trustedAudience_Audience, lifetime: int)
  ensures (inv(s) ==> canAttest(s, by_, messageId, audience, lifetime) ==> alwaysRegistryIdentitiesAreUnique(attest(s, by_, messageId, audience, lifetime)))
  ensures (inv(s) ==> canAttest(s, by_, messageId, audience, lifetime) ==> alwaysGlobalAttestationSequenceDominates(attest(s, by_, messageId, audience, lifetime)))
  ensures (inv(s) ==> canAttest(s, by_, messageId, audience, lifetime) ==> alwaysEveryBindingRetainsLeaseRules(attest(s, by_, messageId, audience, lifetime)))
  ensures (inv(s) ==> canAttest(s, by_, messageId, audience, lifetime) ==> stepGlobalSequenceNeverDecreases(s, "attest", attest(s, by_, messageId, audience, lifetime)))

{
  if inv(s) && canAttest(s, by_, messageId, audience, lifetime) {
    var t := attest(s, by_, messageId, audience, lifetime);
    var binding := messageBinding(s, messageId);
    var wanted := if binding == 0 then s.nextBinding else binding;
    var before := bindingEvidence(s, binding);
    AudienceRegistryBridge(s);
    AudienceSelectedMessage(s, messageId);
    AudienceEvidenceForBinding(s, binding);
    if binding == 0 { AudienceBindingZero(s); }
    var timed := before.(now := s.now);
    if binding != 0 {
      var r :| r in s.records && r.id == binding;
      assert before == r.evidence && before.now == s.now;
    }
    assert core__trustedAudience_inv(timed);
    core__trustedAudience_attest_ensures(timed, by_, audience, lifetime, t.attestationSequence);
    var e := core__trustedAudience_attest(timed, by_, audience, lifetime, t.attestationSequence);
    AudienceAttestRecords(s, t, wanted, e);
    AudienceAttestIdentity(s, t, messageId, wanted);
  }
}

lemma recordSuppression_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, messageId: int, reason: string)
  ensures (inv(s) ==> canRecordSuppression(s, by_, messageId, reason) ==> alwaysRegistryIdentitiesAreUnique(recordSuppression(s, by_, messageId, reason)))
  ensures (inv(s) ==> canRecordSuppression(s, by_, messageId, reason) ==> alwaysGlobalAttestationSequenceDominates(recordSuppression(s, by_, messageId, reason)))
  ensures (inv(s) ==> canRecordSuppression(s, by_, messageId, reason) ==> alwaysEveryBindingRetainsLeaseRules(recordSuppression(s, by_, messageId, reason)))
  ensures (inv(s) ==> canRecordSuppression(s, by_, messageId, reason) ==> stepGlobalSequenceNeverDecreases(s, "recordSuppression", recordSuppression(s, by_, messageId, reason)))

{
  if inv(s) && canRecordSuppression(s, by_, messageId, reason) {
    var t := recordSuppression(s, by_, messageId, reason);
    var prior := messageAt(s, messageId).carrier;
    var id := if prior == 0 then s.nextCarrier else prior;
    AudienceRegistryBridge(s);
    AudienceRegistryBridge(t);
    AudienceSelectedMessage(s, messageId);
    if prior == 0 {
      forall c | c in t.carriers
        ensures c.id > 0 && c.id < t.nextCarrier && |ProofLib.Filter((other: SuppressionCarrier) => other.id == c.id,t.carriers)| == 1
      {
        var appended := t.carriers[|s.carriers|];
        if c == appended {
          ProofLib.FilterOne((other: SuppressionCarrier) => other.id == c.id,t.carriers,|s.carriers|);
        } else {
          ProofLib.FilterAppend((other: SuppressionCarrier) => other.id == c.id,s.carriers,appended);
        }
      }
    } else {
      forall c | c in t.carriers
        ensures c.id > 0 && c.id < t.nextCarrier && |ProofLib.Filter((other: SuppressionCarrier) => other.id == c.id,t.carriers)| == 1
      {
        var i :| 0 <= i < |t.carriers| && t.carriers[i] == c;
        var before := s.carriers[i];
        ProofLib.FilterLengthPointwise((other: SuppressionCarrier) => other.id == before.id,(other: SuppressionCarrier) => other.id == c.id,s.carriers,t.carriers);
      }
    }
    forall m | m in t.messages
      ensures m.id > 0 && |ProofLib.Filter((other: AudienceMessage) => other.id == m.id,t.messages)| == 1 &&
        (m.binding == 0 || exists r :: r in t.records && r.id == m.binding) && (m.carrier == 0 || exists c :: c in t.carriers && c.id == m.carrier)
    {
      var i :| 0 <= i < |t.messages| && t.messages[i] == m;
      var before := s.messages[i];
      ProofLib.FilterLengthPointwise((other: AudienceMessage) => other.id == before.id,(other: AudienceMessage) => other.id == m.id,s.messages,t.messages);
      if m.id == messageId {
        if prior == 0 {
          assert t.carriers[|s.carriers|] in t.carriers;
        } else {
          var j :| 0 <= j < |s.carriers| && s.carriers[j].id == prior;
          assert t.carriers[j] in t.carriers;
        }
      } else if m.carrier != 0 {
        var j :| 0 <= j < |s.carriers| && s.carriers[j].id == m.carrier;
        assert t.carriers[j] in t.carriers;
      }
    }
  }
}
