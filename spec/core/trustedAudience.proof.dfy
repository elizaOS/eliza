lemma AudienceCountersBridge(s: AudienceLease)
  ensures alwaysLeaseCountersAreValid(s) <==>
    (s.nextRecord > 0 && s.nextLease > 0 && s.nextRenewal > 0 &&
      (s.boundRecord == 0 || exists record :: record in s.records && record.id == s.boundRecord) &&
      (forall record :: record in s.records ==> record.id > 0 && record.id < s.nextRecord && record.evidence.sequence > 0 && |ProofLib.Filter((other: AudienceRecord) => (other.id == record.id), s.records)| == 1) &&
      (forall lease :: lease in s.leases ==> lease.id > 0 && lease.id < s.nextLease && lease.signal >= 0 && |ProofLib.Filter((other: AudienceTurnLease) => (other.id == lease.id), s.leases)| == 1) &&
      (forall call :: call in s.renewals ==> call.id > 0 && call.id < s.nextRenewal && |ProofLib.Filter((other: AudienceRenewal) => (other.id == call.id), s.renewals)| == 1))
{}

lemma AudienceRecordLookup(s: AudienceLease, id: int)
  ensures recordAt(s, id) == noRecord || (recordAt(s, id) in s.records && recordAt(s, id).id == id)
  ensures (exists x :: x in s.records && x.id == id) ==> recordAt(s, id) in s.records && recordAt(s, id).id == id
{
  var p := (record: AudienceRecord) => (record.id == id);
  var selected := ProofLib.Filter(p, s.records);
  ProofLib.FilterSubset(p, s.records);
  if exists x :: x in s.records && x.id == id {
    var x :| x in s.records && x.id == id;
    ProofLib.FilterMember(p, s.records, x);
  }
  if |selected| > 0 {
    ProofLib.FilterMember(p, s.records, selected[0]);
  }
}

lemma AudienceRecordIdentityFrame(xs: seq<AudienceRecord>, ys: seq<AudienceRecord>)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| ==> xs[i].id == ys[i].id
  ensures forall y :: y in ys ==> (exists x :: x in xs && x.id == y.id) && |ProofLib.Filter((other: AudienceRecord) => (other.id == y.id), ys)| == |ProofLib.Filter((other: AudienceRecord) => (other.id == y.id), xs)|
{
  forall y | y in ys
    ensures (exists x :: x in xs && x.id == y.id) && |ProofLib.Filter((other: AudienceRecord) => (other.id == y.id), ys)| == |ProofLib.Filter((other: AudienceRecord) => (other.id == y.id), xs)|
  {
    var i :| 0 <= i < |ys| && ys[i] == y;
    assert xs[i] in xs;
    ProofLib.FilterLengthPointwise((other: AudienceRecord) => (other.id == y.id), (other: AudienceRecord) => (other.id == y.id), xs, ys);
  }
}

lemma AudienceRecordIdentityAppend(xs: seq<AudienceRecord>, x: AudienceRecord)
  requires forall y :: y in xs ==> y.id < x.id && |ProofLib.Filter((other: AudienceRecord) => (other.id == y.id), xs)| == 1
  ensures forall y :: y in xs + [x] ==> |ProofLib.Filter((other: AudienceRecord) => (other.id == y.id), xs + [x])| == 1
{
  forall y | y in xs + [x]
    ensures |ProofLib.Filter((other: AudienceRecord) => (other.id == y.id), xs + [x])| == 1
  {
    ProofLib.FilterAppend((other: AudienceRecord) => (other.id == y.id), xs, x);
    if y == x {
      ProofLib.FilterNone((other: AudienceRecord) => (other.id == y.id), xs);
    }
  }
}

lemma AudienceTurnLeaseLookup(s: AudienceLease, id: int)
  ensures turnLease(s, id) == noLease || (turnLease(s, id) in s.leases && turnLease(s, id).id == id)
  ensures (exists x :: x in s.leases && x.id == id) ==> turnLease(s, id) in s.leases && turnLease(s, id).id == id
{
  var p := (entry: AudienceTurnLease) => (entry.id == id);
  var selected := ProofLib.Filter(p, s.leases);
  ProofLib.FilterSubset(p, s.leases);
  if exists x :: x in s.leases && x.id == id {
    var x :| x in s.leases && x.id == id;
    ProofLib.FilterMember(p, s.leases, x);
  }
  if |selected| > 0 {
    ProofLib.FilterMember(p, s.leases, selected[0]);
  }
}

lemma AudienceTurnLeaseIdentityFrame(xs: seq<AudienceTurnLease>, ys: seq<AudienceTurnLease>)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| ==> xs[i].id == ys[i].id
  ensures forall y :: y in ys ==> (exists x :: x in xs && x.id == y.id) && |ProofLib.Filter((other: AudienceTurnLease) => (other.id == y.id), ys)| == |ProofLib.Filter((other: AudienceTurnLease) => (other.id == y.id), xs)|
{
  forall y | y in ys
    ensures (exists x :: x in xs && x.id == y.id) && |ProofLib.Filter((other: AudienceTurnLease) => (other.id == y.id), ys)| == |ProofLib.Filter((other: AudienceTurnLease) => (other.id == y.id), xs)|
  {
    var i :| 0 <= i < |ys| && ys[i] == y;
    assert xs[i] in xs;
    ProofLib.FilterLengthPointwise((other: AudienceTurnLease) => (other.id == y.id), (other: AudienceTurnLease) => (other.id == y.id), xs, ys);
  }
}

lemma AudienceTurnLeaseIdentityAppend(xs: seq<AudienceTurnLease>, x: AudienceTurnLease)
  requires forall y :: y in xs ==> y.id < x.id && |ProofLib.Filter((other: AudienceTurnLease) => (other.id == y.id), xs)| == 1
  ensures forall y :: y in xs + [x] ==> |ProofLib.Filter((other: AudienceTurnLease) => (other.id == y.id), xs + [x])| == 1
{
  forall y | y in xs + [x]
    ensures |ProofLib.Filter((other: AudienceTurnLease) => (other.id == y.id), xs + [x])| == 1
  {
    ProofLib.FilterAppend((other: AudienceTurnLease) => (other.id == y.id), xs, x);
    if y == x {
      ProofLib.FilterNone((other: AudienceTurnLease) => (other.id == y.id), xs);
    }
  }
}

lemma AudienceRenewalLookup(s: AudienceLease, id: int)
  ensures renewalAt(s, id) == noRenewal || (renewalAt(s, id) in s.renewals && renewalAt(s, id).id == id)
  ensures (exists x :: x in s.renewals && x.id == id) ==> renewalAt(s, id) in s.renewals && renewalAt(s, id).id == id
{
  var p := (call: AudienceRenewal) => (call.id == id);
  var selected := ProofLib.Filter(p, s.renewals);
  ProofLib.FilterSubset(p, s.renewals);
  if exists x :: x in s.renewals && x.id == id {
    var x :| x in s.renewals && x.id == id;
    ProofLib.FilterMember(p, s.renewals, x);
  }
  if |selected| > 0 {
    ProofLib.FilterMember(p, s.renewals, selected[0]);
  }
}

lemma AudienceRenewalIdentityFrame(xs: seq<AudienceRenewal>, ys: seq<AudienceRenewal>)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| ==> xs[i].id == ys[i].id
  ensures forall y :: y in ys ==> (exists x :: x in xs && x.id == y.id) && |ProofLib.Filter((other: AudienceRenewal) => (other.id == y.id), ys)| == |ProofLib.Filter((other: AudienceRenewal) => (other.id == y.id), xs)|
{
  forall y | y in ys
    ensures (exists x :: x in xs && x.id == y.id) && |ProofLib.Filter((other: AudienceRenewal) => (other.id == y.id), ys)| == |ProofLib.Filter((other: AudienceRenewal) => (other.id == y.id), xs)|
  {
    var i :| 0 <= i < |ys| && ys[i] == y;
    assert xs[i] in xs;
    ProofLib.FilterLengthPointwise((other: AudienceRenewal) => (other.id == y.id), (other: AudienceRenewal) => (other.id == y.id), xs, ys);
  }
}

lemma AudienceRenewalIdentityAppend(xs: seq<AudienceRenewal>, x: AudienceRenewal)
  requires forall y :: y in xs ==> y.id < x.id && |ProofLib.Filter((other: AudienceRenewal) => (other.id == y.id), xs)| == 1
  ensures forall y :: y in xs + [x] ==> |ProofLib.Filter((other: AudienceRenewal) => (other.id == y.id), xs + [x])| == 1
{
  forall y | y in xs + [x]
    ensures |ProofLib.Filter((other: AudienceRenewal) => (other.id == y.id), xs + [x])| == 1
  {
    ProofLib.FilterAppend((other: AudienceRenewal) => (other.id == y.id), xs, x);
    if y == x {
      ProofLib.FilterNone((other: AudienceRenewal) => (other.id == y.id), xs);
    }
  }
}

lemma AudienceRecordLookupExact(s: AudienceLease, record: AudienceRecord)
  requires alwaysLeaseCountersAreValid(s) && record in s.records
  ensures recordAt(s, record.id) == record
{
  AudienceCountersBridge(s);
  AudienceRecordLookup(s, record.id);
  var p := (other: AudienceRecord) => (other.id == record.id);
  ProofLib.FilterMember(p, s.records, record);
  assert |ProofLib.Filter(p, s.records)| == 1;
}

lemma AudienceTurnLeaseLookupExact(s: AudienceLease, lease: AudienceTurnLease)
  requires alwaysLeaseCountersAreValid(s) && lease in s.leases
  ensures turnLease(s, lease.id) == lease
{
  AudienceCountersBridge(s);
  AudienceTurnLeaseLookup(s, lease.id);
  var p := (other: AudienceTurnLease) => (other.id == lease.id);
  ProofLib.FilterMember(p, s.leases, lease);
  assert |ProofLib.Filter(p, s.leases)| == 1;
}

lemma AudienceRenewalLookupExact(s: AudienceLease, call: AudienceRenewal)
  requires alwaysLeaseCountersAreValid(s) && call in s.renewals
  ensures renewalAt(s, call.id) == call
{
  AudienceCountersBridge(s);
  AudienceRenewalLookup(s, call.id);
  var p := (other: AudienceRenewal) => (other.id == call.id);
  ProofLib.FilterMember(p, s.renewals, call);
  assert |ProofLib.Filter(p, s.renewals)| == 1;
}

lemma AudienceRecordEvidenceFrame(s: AudienceLease, after: AudienceLease)
  requires |s.records| == |after.records|
  requires forall i :: 0 <= i < |s.records| ==> after.records[i].id == s.records[i].id && after.records[i].evidence == s.records[i].evidence
  ensures recordAt(s, s.boundRecord).id == recordAt(after, s.boundRecord).id
  ensures recordAt(s, s.boundRecord).evidence == recordAt(after, s.boundRecord).evidence
{
  var p := (record: AudienceRecord) => (record.id == s.boundRecord);
  ProofLib.FilterPointwise(p, p, (x: AudienceRecord, y: AudienceRecord) => x.id == y.id && x.evidence == y.evidence, s.records, after.records);
}

lemma lawSuppressionKeepsReasons_ensures(reasons: seq<string>, reason: string)
  ensures (lawSuppressionKeepsReasons(reasons, reason) == true)
{
  ProofLib.FilterMember((set_x: string) => !((set_x in reasons)), [reason], reason);
}

lemma AudienceMapCounters(s: AudienceLease, after: AudienceLease)
  requires alwaysLeaseCountersAreValid(s)
  requires after.nextRecord == s.nextRecord && after.nextLease == s.nextLease && after.nextRenewal == s.nextRenewal && after.boundRecord == s.boundRecord
  requires |after.records| == |s.records| && |after.leases| == |s.leases| && |after.renewals| == |s.renewals|
  requires forall i :: 0 <= i < |s.records| ==> after.records[i].id == s.records[i].id && after.records[i].evidence.sequence > 0
  requires forall i :: 0 <= i < |s.leases| ==> after.leases[i].id == s.leases[i].id && after.leases[i].signal >= 0
  requires forall i :: 0 <= i < |s.renewals| ==> after.renewals[i].id == s.renewals[i].id
  ensures alwaysLeaseCountersAreValid(after)
{
  AudienceCountersBridge(s);
  AudienceCountersBridge(after);
  AudienceRecordMapFacts(s.records, after.records, s.nextRecord);
  AudienceTurnLeaseMapFacts(s.leases, after.leases, s.nextLease);
  AudienceRenewalMapFacts(s.renewals, after.renewals, s.nextRenewal);
  if s.boundRecord != 0 {
    var i :| 0 <= i < |s.records| && s.records[i].id == s.boundRecord;
    assert after.records[i] in after.records;
  }
}

lemma AudienceMapGraph(s: AudienceLease, after: AudienceLease)
  requires alwaysCapturedObjectsRetained(s)
  requires |after.records| == |s.records| && |after.leases| == |s.leases| && |after.renewals| == |s.renewals|
  requires forall i :: 0 <= i < |s.records| ==> after.records[i].id == s.records[i].id && (after.records[i].installedLease == 0 || after.records[i].installedLease == s.records[i].installedLease)
  requires forall i :: 0 <= i < |s.leases| ==> after.leases[i].id == s.leases[i].id && after.leases[i].recordId == s.leases[i].recordId
  requires forall i :: 0 <= i < |s.renewals| ==> after.renewals[i].recordId == s.renewals[i].recordId && after.renewals[i].leaseId == s.renewals[i].leaseId && after.renewals[i].captured.sequence == s.renewals[i].captured.sequence
  ensures alwaysCapturedObjectsRetained(after)
{
  forall lease | lease in after.leases
    ensures exists record :: record in after.records && record.id == lease.recordId
  {
    var i :| 0 <= i < |after.leases| && after.leases[i] == lease;
    var j :| 0 <= j < |s.records| && s.records[j].id == s.leases[i].recordId;
    assert after.records[j] in after.records;
  }
  forall record | record in after.records && record.installedLease != 0
    ensures exists lease :: lease in after.leases && lease.id == record.installedLease && lease.recordId == record.id
  {
    var i :| 0 <= i < |after.records| && after.records[i] == record;
    var j :| 0 <= j < |s.leases| && s.leases[j].id == s.records[i].installedLease && s.leases[j].recordId == s.records[i].id;
    assert after.leases[j] in after.leases;
  }
  forall call | call in after.renewals
    ensures (exists record :: record in after.records && record.id == call.recordId) && (exists lease :: lease in after.leases && lease.id == call.leaseId && lease.recordId == call.recordId) && call.captured.sequence > 0
  {
    var i :| 0 <= i < |after.renewals| && after.renewals[i] == call;
    var j :| 0 <= j < |s.records| && s.records[j].id == s.renewals[i].recordId;
    var k :| 0 <= k < |s.leases| && s.leases[k].id == s.renewals[i].leaseId && s.leases[k].recordId == s.renewals[i].recordId;
    assert after.records[j] in after.records;
    assert after.leases[k] in after.leases;
  }
}

lemma endTurn_ensures(s: AudienceLease, by_: AudienceCaller, lease: int)
  ensures (inv(s) ==> canEndTurn(s, by_, lease) ==> alwaysAllowedEvidenceIsFresh(endTurn(s, by_, lease)))
  ensures (inv(s) ==> canEndTurn(s, by_, lease) ==> alwaysLeaseCountersAreValid(endTurn(s, by_, lease)))
  ensures (inv(s) ==> canEndTurn(s, by_, lease) ==> alwaysCapturedObjectsRetained(endTurn(s, by_, lease)))
  ensures (inv(s) ==> canEndTurn(s, by_, lease) ==> alwaysDerivedTimeIsCaptured(endTurn(s, by_, lease)))
{
  if inv(s) && canEndTurn(s, by_, lease) {
    var after := endTurn(s, by_, lease);
    AudienceMapCounters(s, after);
    AudienceMapGraph(s, after);
  }
}

lemma markSensitiveUsed_ensures(s: AudienceLease, by_: AudienceCaller)
  ensures (inv(s) ==> canMarkSensitiveUsed(s, by_) ==> alwaysAllowedEvidenceIsFresh(markSensitiveUsed(s, by_)))
  ensures (inv(s) ==> canMarkSensitiveUsed(s, by_) ==> alwaysLeaseCountersAreValid(markSensitiveUsed(s, by_)))
  ensures (inv(s) ==> canMarkSensitiveUsed(s, by_) ==> alwaysCapturedObjectsRetained(markSensitiveUsed(s, by_)))
  ensures (inv(s) ==> canMarkSensitiveUsed(s, by_) ==> alwaysDerivedTimeIsCaptured(markSensitiveUsed(s, by_)))
{
  if inv(s) && canMarkSensitiveUsed(s, by_) {
    var after := markSensitiveUsed(s, by_);
    AudienceMapCounters(s, after);
    AudienceMapGraph(s, after);
    AudienceRecordEvidenceFrame(s, after);
  }
}

lemma observeRenewalAuthority_ensures(s: AudienceLease, by_: AudienceCaller, renewalId: int, authority: AuthorityObservation, sequence: int)
  ensures (inv(s) ==> canObserveRenewalAuthority(s, by_, renewalId, authority, sequence) ==> alwaysAllowedEvidenceIsFresh(observeRenewalAuthority(s, by_, renewalId, authority, sequence)))
  ensures (inv(s) ==> canObserveRenewalAuthority(s, by_, renewalId, authority, sequence) ==> alwaysLeaseCountersAreValid(observeRenewalAuthority(s, by_, renewalId, authority, sequence)))
  ensures (inv(s) ==> canObserveRenewalAuthority(s, by_, renewalId, authority, sequence) ==> alwaysCapturedObjectsRetained(observeRenewalAuthority(s, by_, renewalId, authority, sequence)))
  ensures (inv(s) ==> canObserveRenewalAuthority(s, by_, renewalId, authority, sequence) ==> alwaysDerivedTimeIsCaptured(observeRenewalAuthority(s, by_, renewalId, authority, sequence)))
{
  if inv(s) && canObserveRenewalAuthority(s, by_, renewalId, authority, sequence) {
    var after := observeRenewalAuthority(s, by_, renewalId, authority, sequence);
    AudienceMapCounters(s, after);
    AudienceMapGraph(s, after);
    AudienceObservedTime(s, by_, renewalId, authority, sequence);
  }
}

lemma finishRenewal_ensures(s: AudienceLease, by_: AudienceCaller, renewalId: int, signalAborted: bool)
  ensures (inv(s) ==> canFinishRenewal(s, by_, renewalId) ==> alwaysAllowedEvidenceIsFresh(finishRenewal(s, by_, renewalId, signalAborted)))
  ensures (inv(s) ==> canFinishRenewal(s, by_, renewalId) ==> alwaysLeaseCountersAreValid(finishRenewal(s, by_, renewalId, signalAborted)))
  ensures (inv(s) ==> canFinishRenewal(s, by_, renewalId) ==> alwaysCapturedObjectsRetained(finishRenewal(s, by_, renewalId, signalAborted)))
  ensures (inv(s) ==> canFinishRenewal(s, by_, renewalId) ==> alwaysDerivedTimeIsCaptured(finishRenewal(s, by_, renewalId, signalAborted)))
{
  if inv(s) && canFinishRenewal(s, by_, renewalId) {
    var call := renewalAt(s, renewalId);
    var after := finishRenewal(s, by_, renewalId, signalAborted);
    AudienceRenewalLookup(s, renewalId);
    assert call in s.renewals;
    if renewalResult(s, call, signalAborted).RenewalSucceeded? {
      assert authorityDerived(call.authority) && call.phase.AuthorityReady?;
      assert call.derived.sequence > 0;
    }
    AudienceMapCounters(s, after);
    AudienceMapGraph(s, after);
    forall entry | entry in after.renewals
      ensures if !entry.phase.AwaitingAuthority? && authorityDerived(entry.authority) then entry.derived.sequence > 0 && entry.derived.issuedAt == entry.capturedNow && entry.derived.expiresAt == entry.capturedNow + renewalLifetime else sameEvidence(entry.derived, emptyEvidence)
    {
      var i :| 0 <= i < |after.renewals| && after.renewals[i] == entry;
      if s.renewals[i].id == renewalId {
        AudienceRenewalLookupExact(s, s.renewals[i]);
      }
    }
  }
}

lemma attest_ensures(s: AudienceLease, by_: AudienceCaller, audience: Audience, lifetime: int, sequence: int)
  ensures (inv(s) ==> canAttest(s, by_, audience, lifetime, sequence) ==> alwaysAllowedEvidenceIsFresh(attest(s, by_, audience, lifetime, sequence)))
  ensures (inv(s) ==> canAttest(s, by_, audience, lifetime, sequence) ==> alwaysLeaseCountersAreValid(attest(s, by_, audience, lifetime, sequence)))
  ensures (inv(s) ==> canAttest(s, by_, audience, lifetime, sequence) ==> alwaysCapturedObjectsRetained(attest(s, by_, audience, lifetime, sequence)))
  ensures (inv(s) ==> canAttest(s, by_, audience, lifetime, sequence) ==> alwaysDerivedTimeIsCaptured(attest(s, by_, audience, lifetime, sequence)))
{
  if inv(s) && canAttest(s, by_, audience, lifetime, sequence) {
    var after := attest(s, by_, audience, lifetime, sequence);
    AudienceCountersBridge(s);
    AudienceCountersBridge(after);
    AudienceRecordIdentityAppend(s.records, after.records[|s.records|]);
    forall lease | lease in after.leases
      ensures exists record :: record in after.records && record.id == lease.recordId
    {
      var record :| record in s.records && record.id == lease.recordId;
      assert record in after.records;
    }
    forall call | call in after.renewals
      ensures (exists record :: record in after.records && record.id == call.recordId) && (exists lease :: lease in after.leases && lease.id == call.leaseId && lease.recordId == call.recordId) && call.captured.sequence > 0
    {
      var record :| record in s.records && record.id == call.recordId;
      assert record in after.records;
    }
  }
}

lemma beginRenewal_ensures(s: AudienceLease, by_: AudienceCaller, runtimeId: string, identityMatches: bool, signalAborted: bool)
  ensures (inv(s) ==> canBeginRenewal(s, by_, runtimeId, identityMatches, signalAborted) ==> alwaysAllowedEvidenceIsFresh(beginRenewal(s, by_, runtimeId, identityMatches, signalAborted)))
  ensures (inv(s) ==> canBeginRenewal(s, by_, runtimeId, identityMatches, signalAborted) ==> alwaysLeaseCountersAreValid(beginRenewal(s, by_, runtimeId, identityMatches, signalAborted)))
  ensures (inv(s) ==> canBeginRenewal(s, by_, runtimeId, identityMatches, signalAborted) ==> alwaysCapturedObjectsRetained(beginRenewal(s, by_, runtimeId, identityMatches, signalAborted)))
  ensures (inv(s) ==> canBeginRenewal(s, by_, runtimeId, identityMatches, signalAborted) ==> alwaysDerivedTimeIsCaptured(beginRenewal(s, by_, runtimeId, identityMatches, signalAborted)))
{
  if inv(s) && canBeginRenewal(s, by_, runtimeId, identityMatches, signalAborted) {
    var after := beginRenewal(s, by_, runtimeId, identityMatches, signalAborted);
    var record := currentRecord(s);
    var lease := turnLease(s, record.installedLease);
    AudienceCountersBridge(s);
    AudienceCountersBridge(after);
    AudienceRecordLookup(s, s.boundRecord);
    AudienceTurnLeaseLookup(s, record.installedLease);
    var installed :| installed in s.leases && installed.id == record.installedLease && installed.recordId == record.id;
    AudienceTurnLeaseLookupExact(s, installed);
    AudienceRenewalIdentityAppend(s.renewals, after.renewals[|s.renewals|]);
  }
}

lemma beginTurn_ensures(s: AudienceLease, by_: AudienceCaller, runtimeId: string, signal: int)
  ensures (inv(s) ==> canBeginTurn(s, by_, runtimeId, signal) ==> alwaysAllowedEvidenceIsFresh(beginTurn(s, by_, runtimeId, signal)))
  ensures (inv(s) ==> canBeginTurn(s, by_, runtimeId, signal) ==> alwaysLeaseCountersAreValid(beginTurn(s, by_, runtimeId, signal)))
  ensures (inv(s) ==> canBeginTurn(s, by_, runtimeId, signal) ==> alwaysCapturedObjectsRetained(beginTurn(s, by_, runtimeId, signal)))
  ensures (inv(s) ==> canBeginTurn(s, by_, runtimeId, signal) ==> alwaysDerivedTimeIsCaptured(beginTurn(s, by_, runtimeId, signal)))
{
  if inv(s) && canBeginTurn(s, by_, runtimeId, signal) {
    AudienceBeginTurnCounters(s, by_, runtimeId, signal);
    AudienceBeginTurnGraph(s, by_, runtimeId, signal);
    AudienceRecordEvidenceFrame(s, beginTurn(s, by_, runtimeId, signal));
  }
}

lemma AudienceRecordMapFacts(xs: seq<AudienceRecord>, ys: seq<AudienceRecord>, bound: int)
  requires |xs| == |ys|
  requires forall x :: x in xs ==> x.id > 0 && x.id < bound && |ProofLib.Filter((other: AudienceRecord) => (other.id == x.id), xs)| == 1
  requires forall i :: 0 <= i < |xs| ==> xs[i].id == ys[i].id
  requires forall y :: y in ys ==> y.evidence.sequence > 0
  ensures forall y :: y in ys ==> y.id > 0 && y.id < bound && y.evidence.sequence > 0 && |ProofLib.Filter((other: AudienceRecord) => (other.id == y.id), ys)| == 1
{
  AudienceRecordIdentityFrame(xs, ys);
  forall y | y in ys
    ensures y.id > 0 && y.id < bound && y.evidence.sequence > 0 && |ProofLib.Filter((other: AudienceRecord) => (other.id == y.id), ys)| == 1
  {
    var i :| 0 <= i < |ys| && ys[i] == y;
    assert xs[i] in xs;
    ProofLib.FilterSamePredicate((other: AudienceRecord) => (other.id == y.id), (other: AudienceRecord) => (other.id == xs[i].id), xs);
  }
}

lemma AudienceTurnLeaseMapFacts(xs: seq<AudienceTurnLease>, ys: seq<AudienceTurnLease>, bound: int)
  requires |xs| == |ys|
  requires forall x :: x in xs ==> x.id > 0 && x.id < bound && |ProofLib.Filter((other: AudienceTurnLease) => (other.id == x.id), xs)| == 1
  requires forall i :: 0 <= i < |xs| ==> xs[i].id == ys[i].id
  requires forall y :: y in ys ==> y.signal >= 0
  ensures forall y :: y in ys ==> y.id > 0 && y.id < bound && y.signal >= 0 && |ProofLib.Filter((other: AudienceTurnLease) => (other.id == y.id), ys)| == 1
{
  AudienceTurnLeaseIdentityFrame(xs, ys);
  forall y | y in ys
    ensures y.id > 0 && y.id < bound && y.signal >= 0 && |ProofLib.Filter((other: AudienceTurnLease) => (other.id == y.id), ys)| == 1
  {
    var i :| 0 <= i < |ys| && ys[i] == y;
    assert xs[i] in xs;
    ProofLib.FilterSamePredicate((other: AudienceTurnLease) => (other.id == y.id), (other: AudienceTurnLease) => (other.id == xs[i].id), xs);
  }
}

lemma AudienceRenewalMapFacts(xs: seq<AudienceRenewal>, ys: seq<AudienceRenewal>, bound: int)
  requires |xs| == |ys|
  requires forall x :: x in xs ==> x.id > 0 && x.id < bound && |ProofLib.Filter((other: AudienceRenewal) => (other.id == x.id), xs)| == 1
  requires forall i :: 0 <= i < |xs| ==> xs[i].id == ys[i].id
  requires forall y :: y in ys ==> true
  ensures forall y :: y in ys ==> y.id > 0 && y.id < bound && true && |ProofLib.Filter((other: AudienceRenewal) => (other.id == y.id), ys)| == 1
{
  AudienceRenewalIdentityFrame(xs, ys);
  forall y | y in ys
    ensures y.id > 0 && y.id < bound && true && |ProofLib.Filter((other: AudienceRenewal) => (other.id == y.id), ys)| == 1
  {
    var i :| 0 <= i < |ys| && ys[i] == y;
    assert xs[i] in xs;
    ProofLib.FilterSamePredicate((other: AudienceRenewal) => (other.id == y.id), (other: AudienceRenewal) => (other.id == xs[i].id), xs);
  }
}

lemma AudienceBeginTurnCounters(s: AudienceLease, by_: AudienceCaller, runtimeId: string, signal: int)
  requires alwaysLeaseCountersAreValid(s) && canBeginTurn(s, by_, runtimeId, signal)
  ensures alwaysLeaseCountersAreValid(beginTurn(s, by_, runtimeId, signal))
{
  var after := beginTurn(s, by_, runtimeId, signal);
  var added := after.leases[|s.leases|];
  AudienceCountersBridge(s);
  AudienceCountersBridge(after);
  AudienceRecordLookup(s, s.boundRecord);
  AudienceRecordMapFacts(s.records, after.records, s.nextRecord);
  AudienceTurnLeaseIdentityAppend(s.leases, added);
  if s.boundRecord != 0 {
    var i :| 0 <= i < |s.records| && s.records[i].id == s.boundRecord;
    assert after.records[i] in after.records;
  }
}

lemma AudienceBeginTurnGraph(s: AudienceLease, by_: AudienceCaller, runtimeId: string, signal: int)
  requires alwaysCapturedObjectsRetained(s) && canBeginTurn(s, by_, runtimeId, signal)
  ensures alwaysCapturedObjectsRetained(beginTurn(s, by_, runtimeId, signal))
{
  var after := beginTurn(s, by_, runtimeId, signal);
  var added := after.leases[|s.leases|];
  AudienceRecordLookup(s, s.boundRecord);
  forall lease | lease in after.leases
    ensures exists record :: record in after.records && record.id == lease.recordId
  {
    var j :| 0 <= j < |s.records| && s.records[j].id == lease.recordId;
    assert after.records[j] in after.records;
  }
  forall record | record in after.records && record.installedLease != 0
    ensures exists lease :: lease in after.leases && lease.id == record.installedLease && lease.recordId == record.id
  {
    var i :| 0 <= i < |after.records| && after.records[i] == record;
    if record.id == s.boundRecord {
      assert added in after.leases;
    } else {
      var lease :| lease in s.leases && lease.id == s.records[i].installedLease && lease.recordId == s.records[i].id;
      assert lease in after.leases;
    }
  }
  forall call | call in after.renewals
    ensures (exists record :: record in after.records && record.id == call.recordId) && (exists lease :: lease in after.leases && lease.id == call.leaseId && lease.recordId == call.recordId) && call.captured.sequence > 0
  {
    var j :| 0 <= j < |s.records| && s.records[j].id == call.recordId;
    assert after.records[j] in after.records;
  }
}

lemma AudienceObservedTime(s: AudienceLease, by_: AudienceCaller, renewalId: int, authority: AuthorityObservation, sequence: int)
  requires alwaysDerivedTimeIsCaptured(s) && alwaysLeaseCountersAreValid(s)
  requires canObserveRenewalAuthority(s, by_, renewalId, authority, sequence)
  ensures alwaysDerivedTimeIsCaptured(observeRenewalAuthority(s, by_, renewalId, authority, sequence))
{
  var after := observeRenewalAuthority(s, by_, renewalId, authority, sequence);
  var call := renewalAt(s, renewalId);
  AudienceRenewalLookup(s, renewalId);
  forall entry | entry in after.renewals
    ensures if !entry.phase.AwaitingAuthority? && authorityDerived(entry.authority) then entry.derived.sequence > 0 && entry.derived.issuedAt == entry.capturedNow && entry.derived.expiresAt == entry.capturedNow + renewalLifetime else sameEvidence(entry.derived, emptyEvidence)
  {
    var i :| 0 <= i < |after.renewals| && after.renewals[i] == entry;
    if s.renewals[i].id == renewalId {
      AudienceRenewalLookupExact(s, s.renewals[i]);
    }
  }
}
