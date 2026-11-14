lemma AudienceRegistryBridge(s: AudienceRegistry)
  ensures alwaysRegistryIdentitiesAreUnique(s) <==>
    (s.nextBinding > 0 &&
     (forall r :: r in s.records ==> (r.id > 0 && r.id < s.nextBinding && |ProofLib.Filter((other: AudienceBindingRecord) => other.id == r.id,s.records)| == 1)) &&
     (forall m :: m in s.messages ==> (m.id > 0 && |ProofLib.Filter((other: AudienceMessage) => other.id == m.id,s.messages)| == 1 && (m.binding == 0 || exists r :: r in s.records && r.id == m.binding))))
{}

lemma AudienceSelectedMessage(s: AudienceRegistry,id: int)
  ensures messageBinding(s,id) == 0 ||
    (exists m :: m in s.messages && m.id == id && m.binding == messageBinding(s,id))
{
  var filtered := ProofLib.Filter((message: AudienceMessage) => message.id == id,s.messages);
  if |filtered| > 0 {
    ProofLib.FilterMember((message: AudienceMessage) => message.id == id,s.messages,filtered[0]);
  }
}

lemma AudienceEvidenceForBinding(s: AudienceRegistry,msg: int,r: AudienceBindingRecord)
  requires alwaysRegistryIdentitiesAreUnique(s) && r in s.records && r.id == messageBinding(s,msg)
  ensures evidenceAt(s,msg) == r.evidence
{
  AudienceRegistryBridge(s);
  var filtered := ProofLib.Filter((record: AudienceBindingRecord) => record.id == messageBinding(s,msg),s.records);
  ProofLib.FilterMember((record: AudienceBindingRecord) => record.id == messageBinding(s,msg),s.records,r);
  assert |filtered| == 1;
  assert filtered[0] == r;
}

lemma AudienceAppendMessage(s: AudienceRegistry,t: AudienceRegistry,m: AudienceMessage)
  requires inv(s) && t.records == s.records && t.nextBinding == s.nextBinding
  requires m.id > 0 && t.messages == s.messages + [m]
  requires !(exists before :: before in s.messages && before.id == m.id)
  requires m.binding == 0 || exists r :: r in s.records && r.id == m.binding
  ensures alwaysRegistryIdentitiesAreUnique(t)
{
  AudienceRegistryBridge(s);
  AudienceRegistryBridge(t);
  forall row | row in t.messages
    ensures row.id > 0 && |ProofLib.Filter((other: AudienceMessage) => other.id == row.id,t.messages)| == 1
    ensures row.binding == 0 || exists r :: r in t.records && r.id == row.binding
  {
    if row == m {
      ProofLib.FilterOne((other: AudienceMessage) => other.id == row.id,t.messages,|s.messages|);
    } else {
      assert row in s.messages && row.id != m.id;
      ProofLib.FilterAppend((other: AudienceMessage) => other.id == row.id,s.messages,m);
    }
  }
}

lemma AudienceRecordsReframe(s: AudienceRegistry,t: AudienceRegistry)
  requires inv(s) && t.messages == s.messages && t.nextBinding == s.nextBinding && t.attestationSequence >= 0
  requires |s.records| == |t.records|
  requires forall i :: 0 <= i < |s.records| ==> s.records[i].id == t.records[i].id
  requires forall i :: 0 <= i < |t.records| ==> (core__trustedAudience_inv(t.records[i].evidence) && t.records[i].evidence.sequence > 0 && t.records[i].evidence.sequence <= t.attestationSequence && t.records[i].evidence.now == t.now)
  ensures inv(t)
{
  AudienceRegistryBridge(s);
  AudienceRegistryBridge(t);
  forall r | r in t.records
    ensures r.id > 0 && r.id < t.nextBinding && |ProofLib.Filter((other: AudienceBindingRecord) => other.id == r.id,t.records)| == 1
    ensures core__trustedAudience_inv(r.evidence) && r.evidence.sequence > 0 && r.evidence.sequence <= t.attestationSequence && r.evidence.now == t.now
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

lemma AudienceReplace(s: AudienceRegistry,t: AudienceRegistry,msg: int,e: core__trustedAudience_AudienceLease)
  requires inv(s) && t.attestationSequence >= s.attestationSequence
  requires t == replaceEvidence(e,msg,s).(attestationSequence := t.attestationSequence)
  requires messageBinding(s,msg) != 0 ==>
    core__trustedAudience_inv(e) && e.sequence > 0 && e.sequence <= t.attestationSequence && e.now == s.now
  ensures inv(t) && stepGlobalSequenceNeverDecreases(s,"",t)
{
  AudienceRegistryBridge(s);
  forall i | 0 <= i < |s.records|
    ensures s.records[i].id == t.records[i].id
    ensures core__trustedAudience_inv(t.records[i].evidence) && t.records[i].evidence.sequence > 0 &&
      t.records[i].evidence.sequence <= t.attestationSequence && t.records[i].evidence.now == t.now
  {
    var r := s.records[i];
    assert r in s.records && r.id > 0;
    if r.id == messageBinding(s,msg) {
      assert messageBinding(s,msg) != 0;
    }
  }
  AudienceRecordsReframe(s,t);
}

lemma AudienceAttestIdentity(s: AudienceRegistry,t: AudienceRegistry,msg: int, bound: int)
  requires inv(s) && t.nextBinding >= s.nextBinding && t.attestationSequence > 0
  requires |s.messages| == |t.messages|
  requires forall i :: 0 <= i < |s.messages| ==> (t.messages[i].id == s.messages[i].id &&
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
      (m.binding == 0 || exists r :: r in t.records && r.id == m.binding)
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
  requires inv(s) && core__trustedAudience_inv(e) && e.sequence == t.attestationSequence
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
      ensures core__trustedAudience_inv(r.evidence) && r.evidence.sequence > 0 && r.evidence.sequence <= t.attestationSequence && r.evidence.now == t.now
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
      ensures core__trustedAudience_inv(r.evidence) && r.evidence.sequence > 0 && r.evidence.sequence <= t.attestationSequence && r.evidence.now == t.now
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

lemma createMessage_ensures(s: AudienceRegistry, messageId: int)
  ensures (inv(s) ==> canCreateMessage(s, messageId) ==> alwaysEveryBindingRetainsLeaseRules(createMessage(s, messageId)))
  ensures (inv(s) ==> canCreateMessage(s, messageId) ==> alwaysRegistryIdentitiesAreUnique(createMessage(s, messageId)))
  ensures (inv(s) ==> canCreateMessage(s, messageId) ==> alwaysGlobalAttestationSequenceDominates(createMessage(s, messageId)))
  ensures (inv(s) ==> canCreateMessage(s, messageId) ==> stepGlobalSequenceNeverDecreases(s, "createMessage", createMessage(s, messageId)))
{
  if inv(s) && canCreateMessage(s, messageId) {
    var t := createMessage(s,messageId);
    AudienceAppendMessage(s,t,AudienceMessage(messageId,0));
  }
}

lemma serializeMessage_ensures(s: AudienceRegistry, messageId: int, copyId: int)
  ensures (inv(s) ==> canSerializeMessage(s, messageId, copyId) ==> alwaysEveryBindingRetainsLeaseRules(serializeMessage(s, messageId, copyId)))
  ensures (inv(s) ==> canSerializeMessage(s, messageId, copyId) ==> alwaysRegistryIdentitiesAreUnique(serializeMessage(s, messageId, copyId)))
  ensures (inv(s) ==> canSerializeMessage(s, messageId, copyId) ==> alwaysGlobalAttestationSequenceDominates(serializeMessage(s, messageId, copyId)))
  ensures (inv(s) ==> canSerializeMessage(s, messageId, copyId) ==> stepGlobalSequenceNeverDecreases(s, "serializeMessage", serializeMessage(s, messageId, copyId)))
{
  if inv(s) && canSerializeMessage(s, messageId, copyId) {
    var t := serializeMessage(s,messageId,copyId);
    AudienceAppendMessage(s,t,AudienceMessage(copyId,0));
  }
}

lemma spreadMessage_ensures(s: AudienceRegistry, messageId: int, copyId: int)
  ensures (inv(s) ==> canSpreadMessage(s, messageId, copyId) ==> alwaysEveryBindingRetainsLeaseRules(spreadMessage(s, messageId, copyId)))
  ensures (inv(s) ==> canSpreadMessage(s, messageId, copyId) ==> alwaysRegistryIdentitiesAreUnique(spreadMessage(s, messageId, copyId)))
  ensures (inv(s) ==> canSpreadMessage(s, messageId, copyId) ==> alwaysGlobalAttestationSequenceDominates(spreadMessage(s, messageId, copyId)))
  ensures (inv(s) ==> canSpreadMessage(s, messageId, copyId) ==> stepGlobalSequenceNeverDecreases(s, "spreadMessage", spreadMessage(s, messageId, copyId)))
{
  if inv(s) && canSpreadMessage(s, messageId, copyId) {
    var t := spreadMessage(s,messageId,copyId);
    AudienceSelectedMessage(s,messageId);
    AudienceRegistryBridge(s);
    AudienceAppendMessage(s,t,AudienceMessage(copyId,messageBinding(s,messageId)));
  }
}

lemma setTime_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, time: int)
  ensures (inv(s) ==> canSetTime(s, by_, time) ==> alwaysEveryBindingRetainsLeaseRules(setTime(s, by_, time)))
  ensures (inv(s) ==> canSetTime(s, by_, time) ==> alwaysRegistryIdentitiesAreUnique(setTime(s, by_, time)))
  ensures (inv(s) ==> canSetTime(s, by_, time) ==> alwaysGlobalAttestationSequenceDominates(setTime(s, by_, time)))
  ensures (inv(s) ==> canSetTime(s, by_, time) ==> stepGlobalSequenceNeverDecreases(s, "setTime", setTime(s, by_, time)))
{
  if inv(s) && canSetTime(s, by_, time) {
    var t := setTime(s,by_,time);
    forall i | 0 <= i < |s.records|
      ensures t.records[i].id == s.records[i].id && core__trustedAudience_inv(t.records[i].evidence) &&
        t.records[i].evidence.sequence > 0 && t.records[i].evidence.sequence <= t.attestationSequence && t.records[i].evidence.now == t.now
    {
      assert s.records[i] in s.records;
    }
    AudienceRecordsReframe(s,t);
  }
}

lemma attest_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, messageId: int, audience: core__trustedAudience_Audience, lifetime: int)
  ensures (inv(s) ==> canAttest(s, by_, messageId, audience, lifetime) ==> alwaysEveryBindingRetainsLeaseRules(attest(s, by_, messageId, audience, lifetime)))
  ensures (inv(s) ==> canAttest(s, by_, messageId, audience, lifetime) ==> alwaysRegistryIdentitiesAreUnique(attest(s, by_, messageId, audience, lifetime)))
  ensures (inv(s) ==> canAttest(s, by_, messageId, audience, lifetime) ==> alwaysGlobalAttestationSequenceDominates(attest(s, by_, messageId, audience, lifetime)))
  ensures (inv(s) ==> canAttest(s, by_, messageId, audience, lifetime) ==> stepGlobalSequenceNeverDecreases(s, "attest", attest(s, by_, messageId, audience, lifetime)))
{
  if inv(s) && canAttest(s,by_,messageId,audience,lifetime) {
    var t := attest(s,by_,messageId,audience,lifetime);
    var binding := messageBinding(s,messageId);
    var wanted := if binding == 0 then s.nextBinding else binding;
    var before := evidenceAt(s,messageId);
    AudienceRegistryBridge(s);
    AudienceSelectedMessage(s,messageId);
    if binding != 0 {
      var r :| r in s.records && r.id == binding;
      AudienceEvidenceForBinding(s,messageId,r);
    } else {
      var selected := ProofLib.Filter((record: AudienceBindingRecord) => record.id == binding,s.records);
      ProofLib.FilterNone((record: AudienceBindingRecord) => record.id == binding,s.records);
      assert |selected| == 0 && before == core__trustedAudience_initial;
    }
    assert before.nextLease > 0;
    var e := core__trustedAudience_attest(before.(now := s.now),by_,audience,lifetime).(sequence := t.attestationSequence);
    AudienceAttestRecords(s,t,wanted,e);
    AudienceAttestIdentity(s,t,messageId,wanted);
  }
}

lemma beginTurn_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, messageId: int, runtimeId: string)
  ensures (inv(s) ==> canBeginTurn(s, by_, messageId, runtimeId) ==> alwaysEveryBindingRetainsLeaseRules(beginTurn(s, by_, messageId, runtimeId)))
  ensures (inv(s) ==> canBeginTurn(s, by_, messageId, runtimeId) ==> alwaysRegistryIdentitiesAreUnique(beginTurn(s, by_, messageId, runtimeId)))
  ensures (inv(s) ==> canBeginTurn(s, by_, messageId, runtimeId) ==> alwaysGlobalAttestationSequenceDominates(beginTurn(s, by_, messageId, runtimeId)))
  ensures (inv(s) ==> canBeginTurn(s, by_, messageId, runtimeId) ==> stepGlobalSequenceNeverDecreases(s, "beginTurn", beginTurn(s, by_, messageId, runtimeId)))
{
  if inv(s) && canBeginTurn(s,by_,messageId,runtimeId) {
    var t := beginTurn(s,by_,messageId,runtimeId);
    var before := evidenceAt(s,messageId);
    var binding := messageBinding(s,messageId);
    if binding != 0 {
      AudienceRegistryBridge(s);
      AudienceSelectedMessage(s,messageId);
      var r :| r in s.records && r.id == binding;
      AudienceEvidenceForBinding(s,messageId,r);
    }
    var after := core__trustedAudience_beginTurn(before,by_,runtimeId);
    var e := after;
    AudienceReplace(s,t,messageId,e);
  }
}

lemma endTurn_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, messageId: int, lease: int)
  ensures (inv(s) ==> canEndTurn(s, by_, messageId, lease) ==> alwaysEveryBindingRetainsLeaseRules(endTurn(s, by_, messageId, lease)))
  ensures (inv(s) ==> canEndTurn(s, by_, messageId, lease) ==> alwaysRegistryIdentitiesAreUnique(endTurn(s, by_, messageId, lease)))
  ensures (inv(s) ==> canEndTurn(s, by_, messageId, lease) ==> alwaysGlobalAttestationSequenceDominates(endTurn(s, by_, messageId, lease)))
  ensures (inv(s) ==> canEndTurn(s, by_, messageId, lease) ==> stepGlobalSequenceNeverDecreases(s, "endTurn", endTurn(s, by_, messageId, lease)))
{
  if inv(s) && canEndTurn(s,by_,messageId,lease) {
    var t := endTurn(s,by_,messageId,lease);
    var before := evidenceAt(s,messageId);
    var binding := messageBinding(s,messageId);
    if binding != 0 {
      AudienceRegistryBridge(s);
      AudienceSelectedMessage(s,messageId);
      var r :| r in s.records && r.id == binding;
      AudienceEvidenceForBinding(s,messageId,r);
    }
    var after := core__trustedAudience_endTurn(before,by_,lease);
    var e := after;
    AudienceReplace(s,t,messageId,e);
  }
}

lemma cancel_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, messageId: int)
  ensures (inv(s) ==> canCancel(s, by_, messageId) ==> alwaysEveryBindingRetainsLeaseRules(cancel(s, by_, messageId)))
  ensures (inv(s) ==> canCancel(s, by_, messageId) ==> alwaysRegistryIdentitiesAreUnique(cancel(s, by_, messageId)))
  ensures (inv(s) ==> canCancel(s, by_, messageId) ==> alwaysGlobalAttestationSequenceDominates(cancel(s, by_, messageId)))
  ensures (inv(s) ==> canCancel(s, by_, messageId) ==> stepGlobalSequenceNeverDecreases(s, "cancel", cancel(s, by_, messageId)))
{
  if inv(s) && canCancel(s,by_,messageId) {
    var t := cancel(s,by_,messageId);
    var before := evidenceAt(s,messageId);
    var binding := messageBinding(s,messageId);
    if binding != 0 {
      AudienceRegistryBridge(s);
      AudienceSelectedMessage(s,messageId);
      var r :| r in s.records && r.id == binding;
      AudienceEvidenceForBinding(s,messageId,r);
    }
    var after := core__trustedAudience_cancel(before,by_);
    var e := after;
    AudienceReplace(s,t,messageId,e);
  }
}

lemma beginRenewal_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, messageId: int, runtimeId: string)
  ensures (inv(s) ==> canBeginRenewal(s, by_, messageId, runtimeId) ==> alwaysEveryBindingRetainsLeaseRules(beginRenewal(s, by_, messageId, runtimeId)))
  ensures (inv(s) ==> canBeginRenewal(s, by_, messageId, runtimeId) ==> alwaysRegistryIdentitiesAreUnique(beginRenewal(s, by_, messageId, runtimeId)))
  ensures (inv(s) ==> canBeginRenewal(s, by_, messageId, runtimeId) ==> alwaysGlobalAttestationSequenceDominates(beginRenewal(s, by_, messageId, runtimeId)))
  ensures (inv(s) ==> canBeginRenewal(s, by_, messageId, runtimeId) ==> stepGlobalSequenceNeverDecreases(s, "beginRenewal", beginRenewal(s, by_, messageId, runtimeId)))
{
  if inv(s) && canBeginRenewal(s,by_,messageId,runtimeId) {
    var t := beginRenewal(s,by_,messageId,runtimeId);
    var before := evidenceAt(s,messageId);
    var binding := messageBinding(s,messageId);
    if binding != 0 {
      AudienceRegistryBridge(s);
      AudienceSelectedMessage(s,messageId);
      var r :| r in s.records && r.id == binding;
      AudienceEvidenceForBinding(s,messageId,r);
    }
    var after := core__trustedAudience_beginRenewal(before,by_,runtimeId);
    var e := after;
    AudienceReplace(s,t,messageId,e);
  }
}

lemma checkDisclosure_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, messageId: int, runtimeId: string, internalActorTrusted: bool, currentAudience: core__trustedAudience_Audience, lookupSucceeded: bool)
  ensures (inv(s) ==> alwaysEveryBindingRetainsLeaseRules(checkDisclosure(s, by_, messageId, runtimeId, internalActorTrusted, currentAudience, lookupSucceeded)))
  ensures (inv(s) ==> alwaysRegistryIdentitiesAreUnique(checkDisclosure(s, by_, messageId, runtimeId, internalActorTrusted, currentAudience, lookupSucceeded)))
  ensures (inv(s) ==> alwaysGlobalAttestationSequenceDominates(checkDisclosure(s, by_, messageId, runtimeId, internalActorTrusted, currentAudience, lookupSucceeded)))
  ensures (inv(s) ==> stepGlobalSequenceNeverDecreases(s, "checkDisclosure", checkDisclosure(s, by_, messageId, runtimeId, internalActorTrusted, currentAudience, lookupSucceeded)))
{
  if inv(s) {
    var t := checkDisclosure(s,by_,messageId,runtimeId,internalActorTrusted,currentAudience,lookupSucceeded);
    var before := evidenceAt(s,messageId);
    var binding := messageBinding(s,messageId);
    if binding != 0 {
      AudienceRegistryBridge(s);
      AudienceSelectedMessage(s,messageId);
      var r :| r in s.records && r.id == binding;
      AudienceEvidenceForBinding(s,messageId,r);
    }
    var after := core__trustedAudience_checkDisclosure(before,by_,runtimeId,internalActorTrusted,currentAudience,lookupSucceeded);
    var e := after;
    AudienceReplace(s,t,messageId,e);
  }
}

lemma markSensitiveUsed_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, messageId: int)
  ensures (inv(s) ==> canMarkSensitiveUsed(s, by_, messageId) ==> alwaysEveryBindingRetainsLeaseRules(markSensitiveUsed(s, by_, messageId)))
  ensures (inv(s) ==> canMarkSensitiveUsed(s, by_, messageId) ==> alwaysRegistryIdentitiesAreUnique(markSensitiveUsed(s, by_, messageId)))
  ensures (inv(s) ==> canMarkSensitiveUsed(s, by_, messageId) ==> alwaysGlobalAttestationSequenceDominates(markSensitiveUsed(s, by_, messageId)))
  ensures (inv(s) ==> canMarkSensitiveUsed(s, by_, messageId) ==> stepGlobalSequenceNeverDecreases(s, "markSensitiveUsed", markSensitiveUsed(s, by_, messageId)))
{
  if inv(s) && canMarkSensitiveUsed(s,by_,messageId) {
    var t := markSensitiveUsed(s,by_,messageId);
    var before := evidenceAt(s,messageId);
    var binding := messageBinding(s,messageId);
    if binding != 0 {
      AudienceRegistryBridge(s);
      AudienceSelectedMessage(s,messageId);
      var r :| r in s.records && r.id == binding;
      AudienceEvidenceForBinding(s,messageId,r);
    }
    var after := core__trustedAudience_markSensitiveUsed(before,by_);
    var e := after;
    AudienceReplace(s,t,messageId,e);
  }
}

lemma recordSuppression_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, messageId: int, reason: string)
  ensures (inv(s) ==> canRecordSuppression(s, by_, messageId, reason) ==> alwaysEveryBindingRetainsLeaseRules(recordSuppression(s, by_, messageId, reason)))
  ensures (inv(s) ==> canRecordSuppression(s, by_, messageId, reason) ==> alwaysRegistryIdentitiesAreUnique(recordSuppression(s, by_, messageId, reason)))
  ensures (inv(s) ==> canRecordSuppression(s, by_, messageId, reason) ==> alwaysGlobalAttestationSequenceDominates(recordSuppression(s, by_, messageId, reason)))
  ensures (inv(s) ==> canRecordSuppression(s, by_, messageId, reason) ==> stepGlobalSequenceNeverDecreases(s, "recordSuppression", recordSuppression(s, by_, messageId, reason)))
{
  if inv(s) && canRecordSuppression(s,by_,messageId,reason) {
    var t := recordSuppression(s,by_,messageId,reason);
    var before := evidenceAt(s,messageId);
    var binding := messageBinding(s,messageId);
    if binding != 0 {
      AudienceRegistryBridge(s);
      AudienceSelectedMessage(s,messageId);
      var r :| r in s.records && r.id == binding;
      AudienceEvidenceForBinding(s,messageId,r);
    }
    var after := core__trustedAudience_recordSuppression(before,by_,reason);
    var e := after;
    AudienceReplace(s,t,messageId,e);
  }
}

lemma finishRenewal_ensures(s: AudienceRegistry, by_: core__trustedAudience_AudienceCaller, messageId: int, audience: core__trustedAudience_Audience, minted: bool, lifetime: int)
  ensures (inv(s) ==> canFinishRenewal(s, by_, messageId, audience, minted, lifetime) ==> alwaysEveryBindingRetainsLeaseRules(finishRenewal(s, by_, messageId, audience, minted, lifetime)))
  ensures (inv(s) ==> canFinishRenewal(s, by_, messageId, audience, minted, lifetime) ==> alwaysRegistryIdentitiesAreUnique(finishRenewal(s, by_, messageId, audience, minted, lifetime)))
  ensures (inv(s) ==> canFinishRenewal(s, by_, messageId, audience, minted, lifetime) ==> alwaysGlobalAttestationSequenceDominates(finishRenewal(s, by_, messageId, audience, minted, lifetime)))
  ensures (inv(s) ==> canFinishRenewal(s, by_, messageId, audience, minted, lifetime) ==> stepGlobalSequenceNeverDecreases(s, "finishRenewal", finishRenewal(s, by_, messageId, audience, minted, lifetime)))
{
  if inv(s) && canFinishRenewal(s,by_,messageId,audience,minted,lifetime) {
    var t := finishRenewal(s,by_,messageId,audience,minted,lifetime);
    var before := evidenceAt(s,messageId);
    var binding := messageBinding(s,messageId);
    if binding != 0 {
      AudienceRegistryBridge(s);
      AudienceSelectedMessage(s,messageId);
      var r :| r in s.records && r.id == binding;
      AudienceEvidenceForBinding(s,messageId,r);
    }
    var after := core__trustedAudience_finishRenewal(before,by_,audience,minted,lifetime);
    var e := if after.sequence != before.sequence then after.(sequence := t.attestationSequence) else after;
    AudienceReplace(s,t,messageId,e);
  }
}
