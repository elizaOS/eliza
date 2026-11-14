lemma RequestSourceBridge(s: RequestRegistry)
  ensures alwaysSourceObjectIdentitiesAreUnique(s) <==>
    ((forall r :: r in s.runtimes ==> (r.id > 0 && |ProofLib.Filter((other: RuntimeObject) => other.id == r.id, s.runtimes)| == 1)) &&
     (forall m :: m in s.messages ==> (m.objectId > 0 && |ProofLib.Filter((other: RequestMessage) => other.objectId == m.objectId, s.messages)| == 1)) &&
     (forall f :: f in s.states ==> (f.objectId > 0 && f.dataId > 0 && |ProofLib.Filter((other: RequestState) => other.objectId == f.objectId, s.states)| == 1)))
{}

lemma RequestDataBridge(s: RequestRegistry)
  ensures alwaysViewsHaveOneDataOwner(s) <==>
    (forall v :: v in s.views ==> ((exists f :: f in s.states && f.dataId == v.dataId) &&
      |ProofLib.Filter((other: ExtractionView) => other.dataId == v.dataId, s.views)| == 1 &&
      (v.issuerId == 0 || (ownerAt(s, v.issuerId).id == v.issuerId && ownerAt(s, v.issuerId).messageObject == v.messageObject))))
{}

lemma RequestIssuerBridge(s: RequestRegistry)
  ensures alwaysActivePairsAreUnique(s) <==> (s.nextIssuer > 0 &&
    (forall a :: a in s.owners ==> (a.id > 0 && a.id < s.nextIssuer &&
      |ProofLib.Filter((other: IssuerOwner) => other.id == a.id, s.owners)| == 1 &&
      |ProofLib.Filter((other: IssuerOwner) => other.runtimeId == a.runtimeId && other.messageObject == a.messageObject, s.owners)| == 1)))
{}

lemma RequestExactOwnerById(s: RequestRegistry, a: IssuerOwner, b: IssuerOwner)
  requires alwaysActivePairsAreUnique(s) && a in s.owners && b in s.owners && a.id == b.id
  ensures a == b
{
  RequestIssuerBridge(s);
  var selected := ProofLib.Filter((other: IssuerOwner) => other.id == a.id,s.owners);
  ProofLib.FilterMember((other: IssuerOwner) => other.id == a.id,s.owners,a);
  ProofLib.FilterMember((other: IssuerOwner) => other.id == a.id,s.owners,b);
  assert |selected| == 1;
}

lemma RequestOwnerSlots(s: RequestRegistry, t: RequestRegistry, target: IssuerOwner, changed: IssuerOwner)
  requires alwaysActivePairsAreUnique(s) && target in s.owners
  requires changed.id == target.id && changed.runtimeId == target.runtimeId && changed.messageObject == target.messageObject
  requires t.owners == replaceOwner(changed,s).owners
  ensures |t.owners| == |s.owners|
  ensures forall i :: 0 <= i < |s.owners| ==> (t.owners[i].id == s.owners[i].id && t.owners[i].runtimeId == s.owners[i].runtimeId && t.owners[i].messageObject == s.owners[i].messageObject)
  ensures forall i :: 0 <= i < |s.owners| ==> t.owners[i] == changed || t.owners[i] == s.owners[i]
  ensures forall row :: row in t.owners ==> row == changed || row in s.owners
{
  forall i | 0 <= i < |s.owners|
    ensures t.owners[i].id == s.owners[i].id &&
      t.owners[i].runtimeId == s.owners[i].runtimeId && t.owners[i].messageObject == s.owners[i].messageObject
    ensures t.owners[i] == changed || t.owners[i] == s.owners[i]
  {
    var prior := s.owners[i];
    var listed := t.owners[i];
    if prior.id == changed.id {
      RequestExactOwnerById(s,prior,target);
      assert listed == changed;
    } else {
      assert listed == prior;
    }
  }
  forall row | row in t.owners ensures row == changed || row in s.owners
  {
    var i :| 0 <= i < |t.owners| && t.owners[i] == row;
    assert s.owners[i] in s.owners;
  }
}

lemma RequestOwnerViewIdentity(s: RequestRegistry, t: RequestRegistry, target: IssuerOwner, changed: IssuerOwner)
  requires inv(s) && target in s.owners
  requires changed.id == target.id && changed.runtimeId == target.runtimeId && changed.messageObject == target.messageObject
  requires t.runtimes == s.runtimes && t.messages == s.messages && t.states == s.states && t.views == s.views
  requires t.owners == replaceOwner(changed, s).owners && t.nextIssuer == s.nextIssuer
  ensures alwaysActivePairsAreUnique(t) && alwaysViewsHaveOneDataOwner(t)
  ensures stepActivePairIdentityNeverChanges(s, "", t)
{
  RequestIssuerBridge(s);
  RequestIssuerBridge(t);
  RequestDataBridge(s);
  RequestDataBridge(t);
  assert |t.owners| == |s.owners|;
  RequestOwnerSlots(s,t,target,changed);
  forall a | a in t.owners
    ensures a.id > 0 && a.id < t.nextIssuer &&
      |ProofLib.Filter((other: IssuerOwner) => other.id == a.id, t.owners)| == 1 &&
      |ProofLib.Filter((other: IssuerOwner) => other.runtimeId == a.runtimeId && other.messageObject == a.messageObject, t.owners)| == 1 &&
      (a == changed || a in s.owners)
  {
    var i :| 0 <= i < |t.owners| && t.owners[i] == a;
    var b := s.owners[i];
    assert b in s.owners;
    ProofLib.FilterLengthPointwise((other: IssuerOwner) => other.id == b.id, (other: IssuerOwner) => other.id == a.id, s.owners, t.owners);
    assert a.runtimeId == b.runtimeId && a.messageObject == b.messageObject;
    ProofLib.FilterLengthPointwise((other: IssuerOwner) => other.runtimeId == b.runtimeId && other.messageObject == b.messageObject, (other: IssuerOwner) => other.runtimeId == a.runtimeId && other.messageObject == a.messageObject, s.owners, t.owners);
  }
  forall a | a in s.owners
    ensures exists b :: b in t.owners && b.id == a.id && b.runtimeId == a.runtimeId && b.messageObject == a.messageObject
  {
    var i :| 0 <= i < |s.owners| && s.owners[i] == a;
    assert t.owners[i] in t.owners && t.owners[i].id == a.id &&
      t.owners[i].runtimeId == a.runtimeId && t.owners[i].messageObject == a.messageObject;
  }
  forall v | v in t.views && v.issuerId != 0
    ensures ownerAt(t,v.issuerId).id == v.issuerId && ownerAt(t,v.issuerId).messageObject == v.messageObject
  {
    ProofLib.FilterPointwise((a: IssuerOwner) => a.id == v.issuerId, (a: IssuerOwner) => a.id == v.issuerId,
      (a: IssuerOwner, b: IssuerOwner) => a.id == b.id && a.messageObject == b.messageObject, s.owners, t.owners);
  }
}

lemma RequestOwnerIndexDisjoint(s: RequestRegistry, t: RequestRegistry, target: IssuerOwner, changed: IssuerOwner)
  requires inv(s) && target in s.owners
  requires changed.id == target.id && changed.runtimeId == target.runtimeId && changed.messageObject == target.messageObject
  requires t.runtimes == s.runtimes && t.messages == s.messages && t.states == s.states && t.views == s.views
  requires t.owners == replaceOwner(changed, s).owners && t.nextIssuer == s.nextIssuer
  requires core__requestIssuer_inv(changed.issuer) && core__requestCompletions_inv(changed.completions)
  requires forall peer :: peer in s.owners && peer.id != target.id ==>
    (!(exists a,b :: a in changed.completions.attempts && b in peer.completions.attempts && a.id == b.id) &&
     !(exists a,b :: a in changed.completions.results && b in peer.completions.results && a.id == b.id) &&
     !(exists a,b :: a in changed.completions.denials && b in peer.completions.denials && a.id == b.id))
  ensures alwaysAttemptOwnershipIsUnique(t) && alwaysResultOwnershipIsUnique(t) && alwaysDenialOwnershipIsUnique(t)
  ensures alwaysOwnersRetainProtocolSafety(t)
{
  RequestOwnerSlots(s,t,target,changed);
  forall a,b | a in t.owners && b in t.owners && a.id != b.id
    ensures !(exists x,y :: x in a.completions.attempts && y in b.completions.attempts && x.id == y.id) &&
      !(exists x,y :: x in a.completions.results && y in b.completions.results && x.id == y.id) &&
      !(exists x,y :: x in a.completions.denials && y in b.completions.denials && x.id == y.id)
  {
    if a != changed && b != changed {
      assert a in s.owners && b in s.owners;
    }
  }
}

lemma RequestReplacement(s: RequestRegistry, t: RequestRegistry, target: IssuerOwner, changed: IssuerOwner)
  requires inv(s) && target in s.owners
  requires changed.id == target.id && changed.runtimeId == target.runtimeId && changed.messageObject == target.messageObject
  requires t.runtimes == s.runtimes && t.messages == s.messages && t.states == s.states && t.views == s.views
  requires t.owners == replaceOwner(changed, s).owners && t.nextIssuer == s.nextIssuer
  requires core__requestIssuer_inv(changed.issuer) && core__requestCompletions_inv(changed.completions)
  requires forall peer :: peer in s.owners && peer.id != target.id ==>
    (!(exists a,b :: a in changed.completions.attempts && b in peer.completions.attempts && a.id == b.id) &&
     !(exists a,b :: a in changed.completions.results && b in peer.completions.results && a.id == b.id) &&
     !(exists a,b :: a in changed.completions.denials && b in peer.completions.denials && a.id == b.id))
  ensures inv(t) && stepActivePairIdentityNeverChanges(s,"",t)
{
  RequestOwnerViewIdentity(s,t,target,changed);
  RequestOwnerIndexDisjoint(s,t,target,changed);
}

lemma RequestOwnerLookup(s: RequestRegistry, id: int)
  ensures ownerAt(s,id) == emptyOwner || (ownerAt(s,id) in s.owners && ownerAt(s,id).id == id)
{
  var rs := ProofLib.Filter((owner: IssuerOwner) => owner.id == id, s.owners);
  if |rs| > 0 { ProofLib.FilterMember((owner: IssuerOwner) => owner.id == id,s.owners,rs[0]); }
}

lemma RequestRuntimeAppend(s: RequestRegistry, t: RequestRegistry, value: RuntimeObject)
  requires inv(s) && value.id > 0 && !(exists r :: r in s.runtimes && r.id == value.id)
  requires t == s.(runtimes := s.runtimes + [value])
  ensures inv(t)
{
  RequestSourceBridge(s); RequestSourceBridge(t);
  forall r | r in t.runtimes
    ensures r.id > 0 && |ProofLib.Filter((other: RuntimeObject) => other.id == r.id, t.runtimes)| == 1
  {
    if r == value {
      ProofLib.FilterOne((other: RuntimeObject) => other.id == r.id, t.runtimes, |s.runtimes|);
    } else {
      assert r in s.runtimes;
      ProofLib.FilterAppend((other: RuntimeObject) => other.id == r.id, s.runtimes, value);
    }
  }
}

lemma RequestMessageAppend(s: RequestRegistry, t: RequestRegistry, value: RequestMessage)
  requires inv(s) && value.objectId > 0 && !(exists m :: m in s.messages && m.objectId == value.objectId)
  requires t == s.(messages := s.messages + [value])
  ensures inv(t)
{
  RequestSourceBridge(s); RequestSourceBridge(t);
  forall m | m in t.messages
    ensures m.objectId > 0 && |ProofLib.Filter((other: RequestMessage) => other.objectId == m.objectId, t.messages)| == 1
  {
    if m == value {
      ProofLib.FilterOne((other: RequestMessage) => other.objectId == m.objectId, t.messages, |s.messages|);
    } else {
      assert m in s.messages;
      ProofLib.FilterAppend((other: RequestMessage) => other.objectId == m.objectId, s.messages, value);
    }
  }
}

lemma RequestStateAppend(s: RequestRegistry, t: RequestRegistry, value: RequestState)
  requires inv(s) && value.objectId > 0 && value.dataId > 0 && !(exists f :: f in s.states && f.objectId == value.objectId)
  requires t == s.(states := s.states + [value])
  ensures inv(t)
{
  RequestSourceBridge(s); RequestSourceBridge(t);
  forall f | f in t.states
    ensures f.objectId > 0 && f.dataId > 0 && |ProofLib.Filter((other: RequestState) => other.objectId == f.objectId, t.states)| == 1
  {
    if f == value {
      ProofLib.FilterOne((other: RequestState) => other.objectId == f.objectId, t.states, |s.states|);
    } else {
      assert f in s.states;
      ProofLib.FilterAppend((other: RequestState) => other.objectId == f.objectId, s.states, value);
    }
  }
  RequestDataBridge(s); RequestDataBridge(t);
  forall v | v in t.views ensures exists f :: f in t.states && f.dataId == v.dataId {
    var f :| f in s.states && f.dataId == v.dataId;
    assert f in t.states;
  }
}

lemma RequestPairLookup(s: RequestRegistry, runtimeId: int, messageObject: int)
  ensures pairOwner(s,runtimeId,messageObject) == emptyOwner ||
    (pairOwner(s,runtimeId,messageObject) in s.owners && pairOwner(s,runtimeId,messageObject).runtimeId == runtimeId && pairOwner(s,runtimeId,messageObject).messageObject == messageObject)
{
  var rs := ProofLib.Filter((owner: IssuerOwner) => owner.runtimeId == runtimeId && owner.messageObject == messageObject, s.owners);
  if |rs| > 0 { ProofLib.FilterMember((owner: IssuerOwner) => owner.runtimeId == runtimeId && owner.messageObject == messageObject,s.owners,rs[0]); }
}

lemma RequestOwnerAppend(s: RequestRegistry, t: RequestRegistry, value: IssuerOwner)
  requires inv(s) && value.id == s.nextIssuer
  requires !(exists a :: a in s.owners && a.runtimeId == value.runtimeId && a.messageObject == value.messageObject)
  requires core__requestIssuer_inv(value.issuer) && value.completions == core__requestCompletions_initial
  requires t == s.(owners := s.owners + [value], nextIssuer := s.nextIssuer+1, lastIssuer := s.nextIssuer)
  ensures inv(t) && stepActivePairIdentityNeverChanges(s, "", t)
{
  RequestIssuerBridge(s);
  RequestIssuerBridge(t);
  RequestDataBridge(s);
  RequestDataBridge(t);
  forall a | a in t.owners
    ensures a.id > 0 && a.id < t.nextIssuer &&
      |ProofLib.Filter((other: IssuerOwner) => other.id == a.id, t.owners)| == 1 &&
      |ProofLib.Filter((other: IssuerOwner) => other.runtimeId == a.runtimeId && other.messageObject == a.messageObject, t.owners)| == 1 &&
      (a == value || a in s.owners)
  {
    if a == value {
      ProofLib.FilterOne((other: IssuerOwner) => other.id == a.id, t.owners, |s.owners|);
      ProofLib.FilterOne((other: IssuerOwner) => other.runtimeId == a.runtimeId && other.messageObject == a.messageObject, t.owners, |s.owners|);
    } else {
      assert a in s.owners;
      ProofLib.FilterAppend((other: IssuerOwner) => other.id == a.id, s.owners, value);
      ProofLib.FilterAppend((other: IssuerOwner) => other.runtimeId == a.runtimeId && other.messageObject == a.messageObject, s.owners, value);
    }
  }
  forall v | v in s.views && v.issuerId != 0 ensures ownerAt(t,v.issuerId).id == v.issuerId && ownerAt(t,v.issuerId).messageObject == v.messageObject
  {
    var matches := (owner: IssuerOwner) => owner.id == v.issuerId;
    var earlier := ProofLib.Filter(matches, s.owners);
    ProofLib.FilterAppend(matches, s.owners, value);
    assert |earlier| > 0;
  }
}

lemma RequestMessageLookup(s: RequestRegistry, id: int)
  ensures messageAt(s,id) == emptyMessage || (messageAt(s,id) in s.messages && messageAt(s,id).objectId == id)
{
  var rs := ProofLib.Filter((message: RequestMessage) => message.objectId == id, s.messages);
  if |rs| > 0 { ProofLib.FilterMember((message: RequestMessage) => message.objectId == id,s.messages,rs[0]); }
}
lemma RequestStateLookup(s: RequestRegistry, id: int)
  ensures stateAt(s,id) == emptyState || (stateAt(s,id) in s.states && stateAt(s,id).objectId == id)
{
  var rs := ProofLib.Filter((frame: RequestState) => frame.objectId == id, s.states);
  if |rs| > 0 { ProofLib.FilterMember((frame: RequestState) => frame.objectId == id,s.states,rs[0]); }
}
lemma RequestAttemptLookup(s: RequestRegistry, id: string)
  ensures attemptOwner(s,id) == emptyOwner || (attemptOwner(s,id) in s.owners && (exists entry :: entry in attemptOwner(s,id).completions.attempts && entry.id == id))
  ensures attemptOwner(s,id) == emptyOwner ==> !(exists a :: a in s.owners && (exists entry :: entry in a.completions.attempts && entry.id == id))
{
  var rs := ProofLib.Filter((owner: IssuerOwner) => (exists attempt :: attempt in owner.completions.attempts && attempt.id == id), s.owners);
  if |rs| > 0 {
    ProofLib.FilterMember((owner: IssuerOwner) => (exists attempt :: attempt in owner.completions.attempts && attempt.id == id), s.owners,rs[0]);
    if attemptOwner(s,id) == emptyOwner {
      assert |emptyOwner.completions.attempts| == 0;
    }
  } else {
    forall a | a in s.owners ensures !(exists entry :: entry in a.completions.attempts && entry.id == id)
    { ProofLib.FilterMember((owner: IssuerOwner) => (exists attempt :: attempt in owner.completions.attempts && attempt.id == id), s.owners,a); }
  }
}

lemma RequestResultLookup(s: RequestRegistry, id: string)
  ensures resultOwner(s,id) == emptyOwner || (resultOwner(s,id) in s.owners && (exists entry :: entry in resultOwner(s,id).completions.results && entry.id == id))
  ensures resultOwner(s,id) == emptyOwner ==> !(exists a :: a in s.owners && (exists entry :: entry in a.completions.results && entry.id == id))
{
  var rs := ProofLib.Filter((owner: IssuerOwner) => (exists result :: result in owner.completions.results && result.id == id), s.owners);
  if |rs| > 0 {
    ProofLib.FilterMember((owner: IssuerOwner) => (exists result :: result in owner.completions.results && result.id == id), s.owners,rs[0]);
    if resultOwner(s,id) == emptyOwner {
      assert |emptyOwner.completions.results| == 0;
    }
  } else {
    forall a | a in s.owners ensures !(exists entry :: entry in a.completions.results && entry.id == id)
    { ProofLib.FilterMember((owner: IssuerOwner) => (exists result :: result in owner.completions.results && result.id == id), s.owners,a); }
  }
}

lemma RequestDenialLookup(s: RequestRegistry, id: string)
  ensures denialOwner(s,id) == emptyOwner || (denialOwner(s,id) in s.owners && (exists entry :: entry in denialOwner(s,id).completions.denials && entry.id == id))
  ensures denialOwner(s,id) == emptyOwner ==> !(exists a :: a in s.owners && (exists entry :: entry in a.completions.denials && entry.id == id))
{
  var rs := ProofLib.Filter((owner: IssuerOwner) => (exists denial :: denial in owner.completions.denials && denial.id == id), s.owners);
  if |rs| > 0 {
    ProofLib.FilterMember((owner: IssuerOwner) => (exists denial :: denial in owner.completions.denials && denial.id == id), s.owners,rs[0]);
    if denialOwner(s,id) == emptyOwner {
      assert |emptyOwner.completions.denials| == 0;
    }
  } else {
    forall a | a in s.owners ensures !(exists entry :: entry in a.completions.denials && entry.id == id)
    { ProofLib.FilterMember((owner: IssuerOwner) => (exists denial :: denial in owner.completions.denials && denial.id == id), s.owners,a); }
  }
}

lemma RequestResultKeys(
  before: seq<core__requestCompletions_Completion>,
  after: seq<core__requestCompletions_Completion>, extra: string)
  requires |before| <= |after| && |after| <= |before| + 1
  requires forall i :: 0 <= i < |before| ==> after[i].id == before[i].id
  requires |after| > |before| ==> extra != "" && after[|before|].id == extra
  ensures forall r :: r in after ==> ((extra != "" && r.id == extra) || exists prior :: prior in before && prior.id == r.id)
{
  forall r | r in after
    ensures (extra != "" && r.id == extra) || exists prior :: prior in before && prior.id == r.id
  {
    var i :| 0 <= i < |after| && after[i] == r;
    if i < |before| { assert before[i] in before; }
  }
}

lemma RequestDenialKeys(
    before: seq<core__requestCompletions_Denial>,
    after: seq<core__requestCompletions_Denial>, extra: string)
  requires after == before ||
    (extra != "" && (exists d: core__requestCompletions_Denial :: d.id == extra && (after == before + [d] || after == ProofLib.Filter((w: core__requestCompletions_Denial) => w.id != extra,before) + [d])))
  ensures forall d :: d in after ==> ((extra != "" && d.id == extra) || exists prior :: prior in before && prior.id == d.id)
{
  if after != before {
    var d: core__requestCompletions_Denial :| d.id == extra &&
      (after == before + [d] ||
       after == ProofLib.Filter((w: core__requestCompletions_Denial) => w.id != extra,before) + [d]);
    forall r | r in after && r != d
      ensures r in before
    {
      if after == before + [d] { assert r in before; }
      else { ProofLib.FilterMember((w: core__requestCompletions_Denial) => w.id != extra,before,r); }
    }
  }
}

lemma RequestTargetDenialAvailable(s: RequestRegistry,a: IssuerOwner,id: string)
  requires inv(s) && a in s.owners
  requires denialOwner(s,id).id == 0 || denialOwner(s,id).id == a.id
  ensures forall peer :: peer in s.owners && peer.id != a.id ==>
    !(exists d :: d in peer.completions.denials && d.id == id)
{
  RequestIssuerBridge(s);
  RequestDenialLookup(s,id);
  var owner := denialOwner(s,id);
  if owner in s.owners {
    assert owner.id > 0 && owner.id == a.id;
    var d :| d in owner.completions.denials && d.id == id;
    assert forall peer :: peer in s.owners && peer.id != owner.id ==>
      !(exists other :: other in peer.completions.denials && other.id == d.id);
  } else {
    assert owner == emptyOwner;
  }
}

lemma RequestTargetResultAvailable(s: RequestRegistry,a: IssuerOwner,id: string)
  requires inv(s) && a in s.owners
  requires resultOwner(s,id).id == 0 || resultOwner(s,id).id == a.id
  ensures forall peer :: peer in s.owners && peer.id != a.id ==>
    !(exists r :: r in peer.completions.results && r.id == id)
{
  RequestIssuerBridge(s);
  RequestResultLookup(s,id);
  var owner := resultOwner(s,id);
  if owner in s.owners {
    assert owner.id > 0 && owner.id == a.id;
    var r :| r in owner.completions.results && r.id == id;
    assert forall peer :: peer in s.owners && peer.id != owner.id ==>
      !(exists other :: other in peer.completions.results && other.id == r.id);
  } else {
    assert owner == emptyOwner;
  }
}

lemma RequestCompletionResultMap(
  before: core__requestCompletions_RequestCompletions,
  after: core__requestCompletions_RequestCompletions)
  requires core__requestCompletions_inv(before) && after.attempts == before.attempts
  requires |before.results| == |after.results|
  requires forall i :: 0 <= i < |before.results| ==> before.results[i].id == after.results[i].id && before.results[i].attempt == after.results[i].attempt
  ensures core__requestCompletions_inv(after)
{
  forall r | r in after.results
    ensures (exists a :: a in after.attempts && a.id == r.attempt)
    ensures |ProofLib.Filter((other: core__requestCompletions_Completion) => other.id == r.id,after.results)| == 1
  {
    var i :| 0 <= i < |after.results| && after.results[i] == r;
    var prior := before.results[i];
    assert prior in before.results && prior.id == r.id && prior.attempt == r.attempt;
    ProofLib.FilterLengthPointwise((other: core__requestCompletions_Completion) => other.id == prior.id,(other: core__requestCompletions_Completion) => other.id == r.id,before.results,after.results);
  }
}

lemma RequestLeafProjectResult(c: core__requestCompletions_RequestCompletions, sourceId: string, targetId: string, fingerprint: string, projectionHash: string, sourceFingerprint: string)
  requires core__requestCompletions_inv(c) && core__requestCompletions_canProjectResult(c,sourceId,targetId,true)
  ensures var t := core__requestCompletions_projectResult(c,sourceId,targetId,fingerprint,projectionHash,true,sourceFingerprint);
    core__requestCompletions_inv(t) && t.attempts == c.attempts && t.denials == c.denials &&
    (forall r :: r in t.results ==> (r.id == targetId || exists prior :: prior in c.results && prior.id == r.id))
{
  core__requestCompletions_projectResult_ensures(c,sourceId,targetId,fingerprint,projectionHash,true,sourceFingerprint);
  var t := core__requestCompletions_projectResult(c,sourceId,targetId,fingerprint,projectionHash,true,sourceFingerprint);
  RequestResultKeys(c.results,t.results,targetId);
}

lemma RequestLeafTransferDenial(c: core__requestCompletions_RequestCompletions, sourceDenial: string, targetResult: string, expectedAttempt: string, targetNotStarted: bool, sourceNotStarted: bool)
  requires core__requestCompletions_inv(c) && core__requestCompletions_canTransferDenial(c,sourceDenial,targetResult,expectedAttempt,targetNotStarted,sourceNotStarted) && targetResult != ""
  ensures var t := core__requestCompletions_transferDenial(c,sourceDenial,targetResult,expectedAttempt,targetNotStarted,sourceNotStarted);
    core__requestCompletions_inv(t) && t.attempts == c.attempts && t.results == c.results &&
    (forall d :: d in t.denials ==> (d.id == targetResult || exists prior :: prior in c.denials && prior.id == d.id))
{
  core__requestCompletions_transferDenial_ensures(c,sourceDenial,targetResult,expectedAttempt,targetNotStarted,sourceNotStarted);
  var t := core__requestCompletions_transferDenial(c,sourceDenial,targetResult,expectedAttempt,targetNotStarted,sourceNotStarted);
  RequestDenialKeys(c.denials,t.denials,targetResult);
}

lemma RequestLeafBindResult(c: core__requestCompletions_RequestCompletions,resultId: string, attemptId: string, fingerprint: string, projectionHash: string, observation: core__requestCompletions_RegistrationSnapshot, child: core__requestCompletions_ChildSnapshot)
  requires core__requestCompletions_inv(c) && core__requestCompletions_canBindResult(c,resultId,attemptId)
  ensures var t := core__requestCompletions_bindResult(c,resultId,attemptId,fingerprint,projectionHash,observation, child);
    core__requestCompletions_inv(t) && t.attempts == c.attempts && t.denials == c.denials &&
    (forall r :: r in t.results ==> (r.id == resultId || exists prior :: prior in c.results && prior.id == r.id))
{
  core__requestCompletions_bindResult_ensures(c,resultId,attemptId,fingerprint,projectionHash,observation, child);
  var t := core__requestCompletions_bindResult(c,resultId,attemptId,fingerprint,projectionHash,observation, child);
  RequestResultKeys(c.results,t.results,resultId);
}

lemma RequestCompletionPeers(s: RequestRegistry, a: IssuerOwner, replacement: core__requestCompletions_RequestCompletions, attempt: string, result: string, denial: string)
  requires inv(s) && a in s.owners
  requires forall x :: x in replacement.attempts ==> ((attempt != "" && x.id == attempt) || (exists prior :: prior in a.completions.attempts && prior.id == x.id))
  requires forall x :: x in replacement.results ==> ((result != "" && x.id == result) || (exists prior :: prior in a.completions.results && prior.id == x.id))
  requires forall x :: x in replacement.denials ==> ((denial != "" && x.id == denial) || (exists prior :: prior in a.completions.denials && prior.id == x.id))
  requires forall peer :: peer in s.owners && peer.id != a.id ==>
    (!(exists x :: x in peer.completions.attempts && attempt != "" && x.id == attempt) &&
     !(exists x :: x in peer.completions.results && result != "" && x.id == result) &&
     !(exists x :: x in peer.completions.denials && denial != "" && x.id == denial))
  ensures forall peer :: peer in s.owners && peer.id != a.id ==>
    (!(exists x,y :: x in replacement.attempts && y in peer.completions.attempts && x.id == y.id) &&
     !(exists x,y :: x in replacement.results && y in peer.completions.results && x.id == y.id) &&
     !(exists x,y :: x in replacement.denials && y in peer.completions.denials && x.id == y.id))
{
  forall peer | peer in s.owners && peer.id != a.id
    ensures !(exists x,y :: x in replacement.attempts && y in peer.completions.attempts && x.id == y.id) &&
      !(exists x,y :: x in replacement.results && y in peer.completions.results && x.id == y.id) &&
      !(exists x,y :: x in replacement.denials && y in peer.completions.denials && x.id == y.id)
  {
    forall x | x in replacement.attempts
      ensures !(exists y :: y in peer.completions.attempts && x.id == y.id)
    { if attempt == "" || x.id != attempt { var prior :| prior in a.completions.attempts && prior.id == x.id; } }
    forall x | x in replacement.results
      ensures !(exists y :: y in peer.completions.results && x.id == y.id)
    { if result == "" || x.id != result { var prior :| prior in a.completions.results && prior.id == x.id; } }
    forall x | x in replacement.denials
      ensures !(exists y :: y in peer.completions.denials && x.id == y.id)
    { if denial == "" || x.id != denial { var prior :| prior in a.completions.denials && prior.id == x.id; } }
  }
}

lemma registerRuntime_ensures(s: RequestRegistry, by_: RegistryCaller, runtimeId: int, agentId: string, live: bool)
  ensures (inv(s) ==> canRegisterRuntime(s, by_, runtimeId, agentId, live) ==> alwaysDenialOwnershipIsUnique(registerRuntime(s, by_, runtimeId, agentId, live)))
  ensures (inv(s) ==> canRegisterRuntime(s, by_, runtimeId, agentId, live) ==> alwaysSourceObjectIdentitiesAreUnique(registerRuntime(s, by_, runtimeId, agentId, live)))
  ensures (inv(s) ==> canRegisterRuntime(s, by_, runtimeId, agentId, live) ==> alwaysActivePairsAreUnique(registerRuntime(s, by_, runtimeId, agentId, live)))
  ensures (inv(s) ==> canRegisterRuntime(s, by_, runtimeId, agentId, live) ==> alwaysAttemptOwnershipIsUnique(registerRuntime(s, by_, runtimeId, agentId, live)))
  ensures (inv(s) ==> canRegisterRuntime(s, by_, runtimeId, agentId, live) ==> alwaysResultOwnershipIsUnique(registerRuntime(s, by_, runtimeId, agentId, live)))
  ensures (inv(s) ==> canRegisterRuntime(s, by_, runtimeId, agentId, live) ==> alwaysOwnersRetainProtocolSafety(registerRuntime(s, by_, runtimeId, agentId, live)))
  ensures (inv(s) ==> canRegisterRuntime(s, by_, runtimeId, agentId, live) ==> alwaysViewsHaveOneDataOwner(registerRuntime(s, by_, runtimeId, agentId, live)))
  ensures (inv(s) ==> canRegisterRuntime(s, by_, runtimeId, agentId, live) ==> stepActivePairIdentityNeverChanges(s, "registerRuntime", registerRuntime(s, by_, runtimeId, agentId, live)))
{
  if inv(s) && canRegisterRuntime(s, by_, runtimeId, agentId, live) {

    var t := registerRuntime(s, by_, runtimeId, agentId, live);
    RequestRuntimeAppend(s,t,t.runtimes[|s.runtimes|]);
  }
}

lemma createMessage_ensures(s: RequestRegistry, by_: RegistryCaller, messageObject: int, agentId: string, messageId: string, roomId: string, entityId: string, requestHash: string)
  ensures (inv(s) ==> canCreateMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash) ==> alwaysDenialOwnershipIsUnique(createMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash)))
  ensures (inv(s) ==> canCreateMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash) ==> alwaysSourceObjectIdentitiesAreUnique(createMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash)))
  ensures (inv(s) ==> canCreateMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash) ==> alwaysActivePairsAreUnique(createMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash)))
  ensures (inv(s) ==> canCreateMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash) ==> alwaysAttemptOwnershipIsUnique(createMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash)))
  ensures (inv(s) ==> canCreateMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash) ==> alwaysResultOwnershipIsUnique(createMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash)))
  ensures (inv(s) ==> canCreateMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash) ==> alwaysOwnersRetainProtocolSafety(createMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash)))
  ensures (inv(s) ==> canCreateMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash) ==> alwaysViewsHaveOneDataOwner(createMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash)))
  ensures (inv(s) ==> canCreateMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash) ==> stepActivePairIdentityNeverChanges(s, "createMessage", createMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash)))
{
  if inv(s) && canCreateMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash) {

    var t := createMessage(s, by_, messageObject, agentId, messageId, roomId, entityId, requestHash);
    RequestMessageAppend(s,t,t.messages[|s.messages|]);
  }
}

lemma copyMessage_ensures(s: RequestRegistry, messageObject: int, copyId: int)
  ensures (inv(s) ==> canCopyMessage(s, messageObject, copyId) ==> alwaysDenialOwnershipIsUnique(copyMessage(s, messageObject, copyId)))
  ensures (inv(s) ==> canCopyMessage(s, messageObject, copyId) ==> alwaysSourceObjectIdentitiesAreUnique(copyMessage(s, messageObject, copyId)))
  ensures (inv(s) ==> canCopyMessage(s, messageObject, copyId) ==> alwaysActivePairsAreUnique(copyMessage(s, messageObject, copyId)))
  ensures (inv(s) ==> canCopyMessage(s, messageObject, copyId) ==> alwaysAttemptOwnershipIsUnique(copyMessage(s, messageObject, copyId)))
  ensures (inv(s) ==> canCopyMessage(s, messageObject, copyId) ==> alwaysResultOwnershipIsUnique(copyMessage(s, messageObject, copyId)))
  ensures (inv(s) ==> canCopyMessage(s, messageObject, copyId) ==> alwaysOwnersRetainProtocolSafety(copyMessage(s, messageObject, copyId)))
  ensures (inv(s) ==> canCopyMessage(s, messageObject, copyId) ==> alwaysViewsHaveOneDataOwner(copyMessage(s, messageObject, copyId)))
  ensures (inv(s) ==> canCopyMessage(s, messageObject, copyId) ==> stepActivePairIdentityNeverChanges(s, "copyMessage", copyMessage(s, messageObject, copyId)))
{
  if inv(s) && canCopyMessage(s, messageObject, copyId) {
    RequestMessageLookup(s,messageObject);
    var t := copyMessage(s, messageObject, copyId);
    RequestMessageAppend(s,t,t.messages[|s.messages|]);
  }
}

lemma createState_ensures(s: RequestRegistry, stateObject: int, dataId: int, stateHash: string)
  ensures (inv(s) ==> canCreateState(s, stateObject, dataId, stateHash) ==> alwaysDenialOwnershipIsUnique(createState(s, stateObject, dataId, stateHash)))
  ensures (inv(s) ==> canCreateState(s, stateObject, dataId, stateHash) ==> alwaysSourceObjectIdentitiesAreUnique(createState(s, stateObject, dataId, stateHash)))
  ensures (inv(s) ==> canCreateState(s, stateObject, dataId, stateHash) ==> alwaysActivePairsAreUnique(createState(s, stateObject, dataId, stateHash)))
  ensures (inv(s) ==> canCreateState(s, stateObject, dataId, stateHash) ==> alwaysAttemptOwnershipIsUnique(createState(s, stateObject, dataId, stateHash)))
  ensures (inv(s) ==> canCreateState(s, stateObject, dataId, stateHash) ==> alwaysResultOwnershipIsUnique(createState(s, stateObject, dataId, stateHash)))
  ensures (inv(s) ==> canCreateState(s, stateObject, dataId, stateHash) ==> alwaysOwnersRetainProtocolSafety(createState(s, stateObject, dataId, stateHash)))
  ensures (inv(s) ==> canCreateState(s, stateObject, dataId, stateHash) ==> alwaysViewsHaveOneDataOwner(createState(s, stateObject, dataId, stateHash)))
  ensures (inv(s) ==> canCreateState(s, stateObject, dataId, stateHash) ==> stepActivePairIdentityNeverChanges(s, "createState", createState(s, stateObject, dataId, stateHash)))
{
  if inv(s) && canCreateState(s, stateObject, dataId, stateHash) {

    var t := createState(s, stateObject, dataId, stateHash);
    RequestStateAppend(s,t,t.states[|s.states|]);
  }
}

lemma copyState_ensures(s: RequestRegistry, stateObject: int, copyId: int)
  ensures (inv(s) ==> canCopyState(s, stateObject, copyId) ==> alwaysDenialOwnershipIsUnique(copyState(s, stateObject, copyId)))
  ensures (inv(s) ==> canCopyState(s, stateObject, copyId) ==> alwaysSourceObjectIdentitiesAreUnique(copyState(s, stateObject, copyId)))
  ensures (inv(s) ==> canCopyState(s, stateObject, copyId) ==> alwaysActivePairsAreUnique(copyState(s, stateObject, copyId)))
  ensures (inv(s) ==> canCopyState(s, stateObject, copyId) ==> alwaysAttemptOwnershipIsUnique(copyState(s, stateObject, copyId)))
  ensures (inv(s) ==> canCopyState(s, stateObject, copyId) ==> alwaysResultOwnershipIsUnique(copyState(s, stateObject, copyId)))
  ensures (inv(s) ==> canCopyState(s, stateObject, copyId) ==> alwaysOwnersRetainProtocolSafety(copyState(s, stateObject, copyId)))
  ensures (inv(s) ==> canCopyState(s, stateObject, copyId) ==> alwaysViewsHaveOneDataOwner(copyState(s, stateObject, copyId)))
  ensures (inv(s) ==> canCopyState(s, stateObject, copyId) ==> stepActivePairIdentityNeverChanges(s, "copyState", copyState(s, stateObject, copyId)))
{
  if inv(s) && canCopyState(s, stateObject, copyId) {
    RequestStateLookup(s,stateObject);
    var t := copyState(s, stateObject, copyId);
    RequestStateAppend(s,t,t.states[|s.states|]);
  }
}

lemma beginIssuer_ensures(s: RequestRegistry, by_: RegistryCaller, runtimeId: int, messageObject: int)
  ensures (inv(s) ==> canBeginIssuer(s, by_, runtimeId, messageObject) ==> alwaysDenialOwnershipIsUnique(beginIssuer(s, by_, runtimeId, messageObject)))
  ensures (inv(s) ==> canBeginIssuer(s, by_, runtimeId, messageObject) ==> alwaysSourceObjectIdentitiesAreUnique(beginIssuer(s, by_, runtimeId, messageObject)))
  ensures (inv(s) ==> canBeginIssuer(s, by_, runtimeId, messageObject) ==> alwaysActivePairsAreUnique(beginIssuer(s, by_, runtimeId, messageObject)))
  ensures (inv(s) ==> canBeginIssuer(s, by_, runtimeId, messageObject) ==> alwaysAttemptOwnershipIsUnique(beginIssuer(s, by_, runtimeId, messageObject)))
  ensures (inv(s) ==> canBeginIssuer(s, by_, runtimeId, messageObject) ==> alwaysResultOwnershipIsUnique(beginIssuer(s, by_, runtimeId, messageObject)))
  ensures (inv(s) ==> canBeginIssuer(s, by_, runtimeId, messageObject) ==> alwaysOwnersRetainProtocolSafety(beginIssuer(s, by_, runtimeId, messageObject)))
  ensures (inv(s) ==> canBeginIssuer(s, by_, runtimeId, messageObject) ==> alwaysViewsHaveOneDataOwner(beginIssuer(s, by_, runtimeId, messageObject)))
  ensures (inv(s) ==> canBeginIssuer(s, by_, runtimeId, messageObject) ==> stepActivePairIdentityNeverChanges(s, "beginIssuer", beginIssuer(s, by_, runtimeId, messageObject)))
{
  if inv(s) && canBeginIssuer(s, by_, runtimeId, messageObject) {
    RequestPairLookup(s,runtimeId,messageObject);
    var t := beginIssuer(s, by_, runtimeId, messageObject);
    if pairOwner(s,runtimeId,messageObject).id == 0 {
      var matches := (owner: IssuerOwner) => owner.runtimeId == runtimeId && owner.messageObject == messageObject;
      ProofLib.FilterNone(matches,s.owners);
      forall a | a in s.owners ensures !matches(a) { ProofLib.FilterMember(matches,s.owners,a); }
      core__requestIssuer_beginIssuer_ensures(core__requestIssuer_initial,true,true,messageAt(s,messageObject).requestHash);
      RequestOwnerAppend(s,t,t.owners[|s.owners|]);
    }
  }
}

lemma commitRestriction_ensures(s: RequestRegistry, by_: RegistryCaller, issuerId: int, classification: core__requestIssuer_RequestClassification, interpretation: core__requestIssuer_Interpretation, sourceHash: string, observedSourceHash: string)
  ensures (inv(s) ==> canCommitRestriction(s, by_, issuerId, sourceHash, observedSourceHash) ==> alwaysDenialOwnershipIsUnique(commitRestriction(s, by_, issuerId, classification, interpretation, sourceHash, observedSourceHash)))
  ensures (inv(s) ==> canCommitRestriction(s, by_, issuerId, sourceHash, observedSourceHash) ==> alwaysSourceObjectIdentitiesAreUnique(commitRestriction(s, by_, issuerId, classification, interpretation, sourceHash, observedSourceHash)))
  ensures (inv(s) ==> canCommitRestriction(s, by_, issuerId, sourceHash, observedSourceHash) ==> alwaysActivePairsAreUnique(commitRestriction(s, by_, issuerId, classification, interpretation, sourceHash, observedSourceHash)))
  ensures (inv(s) ==> canCommitRestriction(s, by_, issuerId, sourceHash, observedSourceHash) ==> alwaysAttemptOwnershipIsUnique(commitRestriction(s, by_, issuerId, classification, interpretation, sourceHash, observedSourceHash)))
  ensures (inv(s) ==> canCommitRestriction(s, by_, issuerId, sourceHash, observedSourceHash) ==> alwaysResultOwnershipIsUnique(commitRestriction(s, by_, issuerId, classification, interpretation, sourceHash, observedSourceHash)))
  ensures (inv(s) ==> canCommitRestriction(s, by_, issuerId, sourceHash, observedSourceHash) ==> alwaysOwnersRetainProtocolSafety(commitRestriction(s, by_, issuerId, classification, interpretation, sourceHash, observedSourceHash)))
  ensures (inv(s) ==> canCommitRestriction(s, by_, issuerId, sourceHash, observedSourceHash) ==> alwaysViewsHaveOneDataOwner(commitRestriction(s, by_, issuerId, classification, interpretation, sourceHash, observedSourceHash)))
  ensures (inv(s) ==> canCommitRestriction(s, by_, issuerId, sourceHash, observedSourceHash) ==> stepActivePairIdentityNeverChanges(s, "commitRestriction", commitRestriction(s, by_, issuerId, classification, interpretation, sourceHash, observedSourceHash)))
{
  if inv(s) && canCommitRestriction(s, by_, issuerId, sourceHash, observedSourceHash) {
    RequestOwnerLookup(s,issuerId);
    var a := ownerAt(s,issuerId);
    assert a in s.owners;
    core__requestIssuer_commitRestriction_ensures(a.issuer,classification,interpretation,sourceHash,observedSourceHash);
    var t := commitRestriction(s, by_, issuerId, classification, interpretation, sourceHash, observedSourceHash);
    var i :| 0 <= i < |s.owners| && s.owners[i] == a;
    var changed := t.owners[i];
    RequestCompletionPeers(s,a,changed.completions,"","","");
    RequestReplacement(s,t,a,changed);
  }
}

lemma observeSources_ensures(s: RequestRegistry, by_: RegistryCaller, issuerId: int, issuerLive: bool, currentSourceHash: string, currentOriginalHash: string)
  ensures (inv(s) ==> canObserveSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash) ==> alwaysDenialOwnershipIsUnique(observeSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash)))
  ensures (inv(s) ==> canObserveSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash) ==> alwaysSourceObjectIdentitiesAreUnique(observeSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash)))
  ensures (inv(s) ==> canObserveSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash) ==> alwaysActivePairsAreUnique(observeSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash)))
  ensures (inv(s) ==> canObserveSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash) ==> alwaysAttemptOwnershipIsUnique(observeSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash)))
  ensures (inv(s) ==> canObserveSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash) ==> alwaysResultOwnershipIsUnique(observeSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash)))
  ensures (inv(s) ==> canObserveSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash) ==> alwaysOwnersRetainProtocolSafety(observeSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash)))
  ensures (inv(s) ==> canObserveSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash) ==> alwaysViewsHaveOneDataOwner(observeSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash)))
  ensures (inv(s) ==> canObserveSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash) ==> stepActivePairIdentityNeverChanges(s, "observeSources", observeSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash)))
{
  if inv(s) && canObserveSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash) {
    RequestOwnerLookup(s,issuerId);
    var a := ownerAt(s,issuerId);
    assert a in s.owners;
    core__requestIssuer_observeCurrent_ensures(a.issuer,issuerLive,a.issuer.currentRequestHash,currentSourceHash);
    var t := observeSources(s, by_, issuerId, issuerLive, currentSourceHash, currentOriginalHash);
    var i :| 0 <= i < |s.owners| && s.owners[i] == a;
    var changed := t.owners[i];
    RequestCompletionPeers(s,a,changed.completions,"","","");
    RequestReplacement(s,t,a,changed);
  }
}

lemma beginAttempt_ensures(s: RequestRegistry, by_: RegistryCaller, issuerId: int, stateObject: int, messageObject: int, attemptId: string, registration: core__requestCompletions_RegistrationSnapshot)
  ensures (inv(s) ==> canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) ==> alwaysDenialOwnershipIsUnique(beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId, registration)))
  ensures (inv(s) ==> canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) ==> alwaysSourceObjectIdentitiesAreUnique(beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId, registration)))
  ensures (inv(s) ==> canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) ==> alwaysActivePairsAreUnique(beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId, registration)))
  ensures (inv(s) ==> canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) ==> alwaysAttemptOwnershipIsUnique(beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId, registration)))
  ensures (inv(s) ==> canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) ==> alwaysResultOwnershipIsUnique(beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId, registration)))
  ensures (inv(s) ==> canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) ==> alwaysOwnersRetainProtocolSafety(beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId, registration)))
  ensures (inv(s) ==> canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) ==> alwaysViewsHaveOneDataOwner(beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId, registration)))
  ensures (inv(s) ==> canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) ==> stepActivePairIdentityNeverChanges(s, "beginAttempt", beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId, registration)))
{
  if inv(s) && canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) {
    RequestOwnerLookup(s,issuerId);
    var a := ownerAt(s,issuerId);
    assert a in s.owners;
    core__requestCompletions_beginAttempt_ensures(refreshedOwner(a,s).completions,attemptId,registration);
    RequestAttemptLookup(s,attemptId);
    var t := beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId, registration);
    var i :| 0 <= i < |s.owners| && s.owners[i] == a;
    var changed := t.owners[i];
    RequestCompletionPeers(s,a,changed.completions,attemptId,"","");
    RequestReplacement(s,t,a,changed);
  }
}

lemma RequestProjectResultAggregate(s: RequestRegistry, by_: RegistryCaller, issuerId: int, sourceId: string, targetId: string, fingerprint: string, projectionHash: string, sourceFingerprint: string)
  requires inv(s) && canProjectResult(s, by_, issuerId, sourceId, targetId)
  ensures inv(projectResult(s, by_, issuerId, sourceId, targetId, fingerprint, projectionHash, sourceFingerprint)) && stepActivePairIdentityNeverChanges(s, "", projectResult(s, by_, issuerId, sourceId, targetId, fingerprint, projectionHash, sourceFingerprint))
{
  RequestResultLookup(s,sourceId);
  var a := resultOwner(s,sourceId);
  var c := a.completions;
  assert a in s.owners && core__requestCompletions_inv(c);
  RequestTargetResultAvailable(s,a,targetId);
  RequestLeafProjectResult(c,sourceId,targetId,fingerprint,projectionHash,sourceFingerprint);
  var updated := core__requestCompletions_projectResult(c,sourceId,targetId,fingerprint,projectionHash,true,sourceFingerprint);

  RequestCompletionPeers(s,a,updated,"",targetId,"");
  var changed := a.(completions := updated);
  var t := projectResult(s,by_,issuerId,sourceId,targetId,fingerprint,projectionHash,sourceFingerprint);
  RequestReplacement(s,t,a,changed);
}

lemma projectResult_ensures(s: RequestRegistry, by_: RegistryCaller, issuerId: int, sourceId: string, targetId: string, fingerprint: string, projectionHash: string, sourceFingerprint: string)
  ensures (inv(s) ==> canProjectResult(s, by_, issuerId, sourceId, targetId) ==> alwaysDenialOwnershipIsUnique(projectResult(s, by_, issuerId, sourceId, targetId, fingerprint, projectionHash, sourceFingerprint)))
  ensures (inv(s) ==> canProjectResult(s, by_, issuerId, sourceId, targetId) ==> alwaysSourceObjectIdentitiesAreUnique(projectResult(s, by_, issuerId, sourceId, targetId, fingerprint, projectionHash, sourceFingerprint)))
  ensures (inv(s) ==> canProjectResult(s, by_, issuerId, sourceId, targetId) ==> alwaysActivePairsAreUnique(projectResult(s, by_, issuerId, sourceId, targetId, fingerprint, projectionHash, sourceFingerprint)))
  ensures (inv(s) ==> canProjectResult(s, by_, issuerId, sourceId, targetId) ==> alwaysAttemptOwnershipIsUnique(projectResult(s, by_, issuerId, sourceId, targetId, fingerprint, projectionHash, sourceFingerprint)))
  ensures (inv(s) ==> canProjectResult(s, by_, issuerId, sourceId, targetId) ==> alwaysResultOwnershipIsUnique(projectResult(s, by_, issuerId, sourceId, targetId, fingerprint, projectionHash, sourceFingerprint)))
  ensures (inv(s) ==> canProjectResult(s, by_, issuerId, sourceId, targetId) ==> alwaysOwnersRetainProtocolSafety(projectResult(s, by_, issuerId, sourceId, targetId, fingerprint, projectionHash, sourceFingerprint)))
  ensures (inv(s) ==> canProjectResult(s, by_, issuerId, sourceId, targetId) ==> alwaysViewsHaveOneDataOwner(projectResult(s, by_, issuerId, sourceId, targetId, fingerprint, projectionHash, sourceFingerprint)))
  ensures (inv(s) ==> canProjectResult(s, by_, issuerId, sourceId, targetId) ==> stepActivePairIdentityNeverChanges(s, "projectResult", projectResult(s, by_, issuerId, sourceId, targetId, fingerprint, projectionHash, sourceFingerprint)))
{
  if inv(s) && canProjectResult(s, by_, issuerId, sourceId, targetId) { RequestProjectResultAggregate(s, by_, issuerId, sourceId, targetId, fingerprint, projectionHash, sourceFingerprint); }
}

lemma copyCompletion_ensures(s: RequestRegistry, sourceId: string, targetId: string, sourceFingerprint: string, targetFingerprint: string)
  ensures (inv(s) ==> canCopyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint) ==> alwaysDenialOwnershipIsUnique(copyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint)))
  ensures (inv(s) ==> canCopyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint) ==> alwaysSourceObjectIdentitiesAreUnique(copyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint)))
  ensures (inv(s) ==> canCopyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint) ==> alwaysActivePairsAreUnique(copyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint)))
  ensures (inv(s) ==> canCopyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint) ==> alwaysAttemptOwnershipIsUnique(copyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint)))
  ensures (inv(s) ==> canCopyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint) ==> alwaysResultOwnershipIsUnique(copyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint)))
  ensures (inv(s) ==> canCopyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint) ==> alwaysOwnersRetainProtocolSafety(copyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint)))
  ensures (inv(s) ==> canCopyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint) ==> alwaysViewsHaveOneDataOwner(copyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint)))
  ensures (inv(s) ==> canCopyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint) ==> stepActivePairIdentityNeverChanges(s, "copyCompletion", copyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint)))
{
  if inv(s) && canCopyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint) {
    RequestResultLookup(s,sourceId);
    var a := resultOwner(s,sourceId);
    var c := a.completions;
    assert a in s.owners && core__requestCompletions_inv(c);
    core__requestCompletions_copyCompletion_ensures(c,sourceId,targetId,sourceFingerprint,targetFingerprint);
    var updated := core__requestCompletions_copyCompletion(c,sourceId,targetId,sourceFingerprint,targetFingerprint);
    RequestResultKeys(c.results,updated.results,"");
    RequestCompletionPeers(s,a,updated,"","","");
    var changed := a.(completions := updated);
    var t := copyCompletion(s,sourceId,targetId,sourceFingerprint,targetFingerprint);
    RequestReplacement(s,t,a,changed);
  }
}

lemma inspectCompletion_ensures(s: RequestRegistry, issuerId: int, resultId: string, fingerprint: string, observation: core__requestCompletions_RegistrationSnapshot, child: core__requestCompletions_ChildSnapshot)
  ensures (inv(s) ==> canInspectCompletion(s, issuerId, resultId) ==> alwaysDenialOwnershipIsUnique(inspectCompletion(s, issuerId, resultId, fingerprint, observation, child)))
  ensures (inv(s) ==> canInspectCompletion(s, issuerId, resultId) ==> alwaysSourceObjectIdentitiesAreUnique(inspectCompletion(s, issuerId, resultId, fingerprint, observation, child)))
  ensures (inv(s) ==> canInspectCompletion(s, issuerId, resultId) ==> alwaysActivePairsAreUnique(inspectCompletion(s, issuerId, resultId, fingerprint, observation, child)))
  ensures (inv(s) ==> canInspectCompletion(s, issuerId, resultId) ==> alwaysAttemptOwnershipIsUnique(inspectCompletion(s, issuerId, resultId, fingerprint, observation, child)))
  ensures (inv(s) ==> canInspectCompletion(s, issuerId, resultId) ==> alwaysResultOwnershipIsUnique(inspectCompletion(s, issuerId, resultId, fingerprint, observation, child)))
  ensures (inv(s) ==> canInspectCompletion(s, issuerId, resultId) ==> alwaysOwnersRetainProtocolSafety(inspectCompletion(s, issuerId, resultId, fingerprint, observation, child)))
  ensures (inv(s) ==> canInspectCompletion(s, issuerId, resultId) ==> alwaysViewsHaveOneDataOwner(inspectCompletion(s, issuerId, resultId, fingerprint, observation, child)))
  ensures (inv(s) ==> canInspectCompletion(s, issuerId, resultId) ==> stepActivePairIdentityNeverChanges(s, "inspectCompletion", inspectCompletion(s, issuerId, resultId, fingerprint, observation, child)))
{
  if inv(s) && canInspectCompletion(s, issuerId, resultId) {
    RequestResultLookup(s,resultId);
    var a := resultOwner(s,resultId);
    assert a in s.owners;
    core__requestCompletions_inspectCompletion_ensures(refreshedOwner(a,s).completions,resultId,true,fingerprint,observation, child);
    var t := inspectCompletion(s, issuerId, resultId, fingerprint, observation, child);
    var i :| 0 <= i < |s.owners| && s.owners[i] == a;
    var changed := t.owners[i];
    RequestCompletionPeers(s,a,changed.completions,"","","");
    RequestReplacement(s,t,a,changed);
  }
}

lemma wrapDenialError_ensures(s: RequestRegistry, sourceDenial: string, errorId: string)
  ensures (inv(s) ==> canWrapDenialError(s, sourceDenial, errorId) ==> alwaysDenialOwnershipIsUnique(wrapDenialError(s, sourceDenial, errorId)))
  ensures (inv(s) ==> canWrapDenialError(s, sourceDenial, errorId) ==> alwaysSourceObjectIdentitiesAreUnique(wrapDenialError(s, sourceDenial, errorId)))
  ensures (inv(s) ==> canWrapDenialError(s, sourceDenial, errorId) ==> alwaysActivePairsAreUnique(wrapDenialError(s, sourceDenial, errorId)))
  ensures (inv(s) ==> canWrapDenialError(s, sourceDenial, errorId) ==> alwaysAttemptOwnershipIsUnique(wrapDenialError(s, sourceDenial, errorId)))
  ensures (inv(s) ==> canWrapDenialError(s, sourceDenial, errorId) ==> alwaysResultOwnershipIsUnique(wrapDenialError(s, sourceDenial, errorId)))
  ensures (inv(s) ==> canWrapDenialError(s, sourceDenial, errorId) ==> alwaysOwnersRetainProtocolSafety(wrapDenialError(s, sourceDenial, errorId)))
  ensures (inv(s) ==> canWrapDenialError(s, sourceDenial, errorId) ==> alwaysViewsHaveOneDataOwner(wrapDenialError(s, sourceDenial, errorId)))
  ensures (inv(s) ==> canWrapDenialError(s, sourceDenial, errorId) ==> stepActivePairIdentityNeverChanges(s, "wrapDenialError", wrapDenialError(s, sourceDenial, errorId)))
{
  if inv(s) && canWrapDenialError(s, sourceDenial, errorId) {
    RequestDenialLookup(s,sourceDenial);
    var a := denialOwner(s,sourceDenial);
    assert a in s.owners;
    core__requestCompletions_wrapDenialError_ensures(refreshedOwner(a,s).completions,sourceDenial,errorId);
    RequestDenialLookup(s,errorId);
    var t := wrapDenialError(s, sourceDenial, errorId);
    var i :| 0 <= i < |s.owners| && s.owners[i] == a;
    var changed := t.owners[i];
    RequestCompletionPeers(s,a,changed.completions,"","",errorId);
    RequestReplacement(s,t,a,changed);
  }
}

lemma RequestTransferDenialAggregate(s: RequestRegistry, sourceDenial: string, targetResult: string, expectedAttempt: string, targetNotStarted: bool, sourceNotStarted: bool)
  requires inv(s) && canTransferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted)
  ensures inv(transferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted)) && stepActivePairIdentityNeverChanges(s, "", transferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted))
{
  RequestDenialLookup(s,sourceDenial);
  var a := denialOwner(s,sourceDenial);
  assert a in s.owners;
  RequestTargetDenialAvailable(s,a,targetResult);
  var owner := refreshedOwner(a,s);
  var c := owner.completions;
  RequestLeafTransferDenial(c,sourceDenial,targetResult,expectedAttempt,targetNotStarted,sourceNotStarted);
  var updated := core__requestCompletions_transferDenial(c,sourceDenial,targetResult,expectedAttempt,targetNotStarted,sourceNotStarted);

  RequestCompletionPeers(s,a,updated,"","",targetResult);
  var changed := owner.(completions := updated);
  var t := transferDenial(s,sourceDenial,targetResult,expectedAttempt,targetNotStarted,sourceNotStarted);
  RequestReplacement(s,t,a,changed);
}

lemma transferDenial_ensures(s: RequestRegistry, sourceDenial: string, targetResult: string, expectedAttempt: string, targetNotStarted: bool, sourceNotStarted: bool)
  ensures (inv(s) ==> canTransferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted) ==> alwaysDenialOwnershipIsUnique(transferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted)))
  ensures (inv(s) ==> canTransferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted) ==> alwaysSourceObjectIdentitiesAreUnique(transferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted)))
  ensures (inv(s) ==> canTransferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted) ==> alwaysActivePairsAreUnique(transferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted)))
  ensures (inv(s) ==> canTransferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted) ==> alwaysAttemptOwnershipIsUnique(transferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted)))
  ensures (inv(s) ==> canTransferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted) ==> alwaysResultOwnershipIsUnique(transferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted)))
  ensures (inv(s) ==> canTransferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted) ==> alwaysOwnersRetainProtocolSafety(transferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted)))
  ensures (inv(s) ==> canTransferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted) ==> alwaysViewsHaveOneDataOwner(transferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted)))
  ensures (inv(s) ==> canTransferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted) ==> stepActivePairIdentityNeverChanges(s, "transferDenial", transferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted)))
{
  if inv(s) && canTransferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted) { RequestTransferDenialAggregate(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted); }
}

lemma RequestKeepsKeyCounts<T,K>(before: seq<T>, after: seq<T>, key: T -> K, ok: T -> bool)
  requires |before| == |after|
  requires forall i :: 0 <= i < |before| ==> key(before[i]) == key(after[i]) && ok(before[i]) == ok(after[i])
  requires forall v :: v in before ==> ok(v) && |ProofLib.Filter((other: T) => key(other) == key(v),before)| == 1
  ensures forall v :: v in after ==> ok(v) && |ProofLib.Filter((other: T) => key(other) == key(v),after)| == 1
{
  forall v | v in after
    ensures ok(v) && |ProofLib.Filter((w: T) => key(w) == key(v),after)| == 1
  {
    var i :| 0 <= i < |after| && after[i] == v;
    var p := before[i];
    assert p in before && key(p) == key(v) && ok(p) == ok(v);
    ProofLib.FilterLengthPointwise((w: T) => key(w) == key(p),(w: T) => key(w) == key(v),before,after);
  }
}

lemma RequestViewsKeepData(s: RequestRegistry, t: RequestRegistry)
  requires alwaysViewsHaveOneDataOwner(s)
  requires t.views == s.views && t.owners == s.owners &&
    forall i :: 0 <= i < |s.states| ==> i < |t.states| && t.states[i].dataId == s.states[i].dataId
  ensures alwaysViewsHaveOneDataOwner(t)
{
  RequestDataBridge(s);
  RequestDataBridge(t);
  forall v | v in t.views ensures exists f :: f in t.states && f.dataId == v.dataId
  {
    var f :| f in s.states && f.dataId == v.dataId;
    var i :| 0 <= i < |s.states| && s.states[i] == f;
    assert t.states[i] in t.states;
  }
}

lemma RequestViewMutation(s: RequestRegistry, t: RequestRegistry)
  requires alwaysViewsHaveOneDataOwner(s) && t.states == s.states && t.owners == s.owners
  requires |t.views| == |s.views|
  requires forall i :: 0 <= i < |s.views| ==> (t.views[i].dataId == s.views[i].dataId &&
    t.views[i].issuerId == s.views[i].issuerId && t.views[i].messageObject == s.views[i].messageObject)
  ensures alwaysViewsHaveOneDataOwner(t)
{
  RequestDataBridge(s);
  RequestDataBridge(t);
  forall v | v in t.views
    ensures (exists f :: f in t.states && f.dataId == v.dataId) &&
      |ProofLib.Filter((other: ExtractionView) => other.dataId == v.dataId,t.views)| == 1 &&
      (v.issuerId == 0 || (ownerAt(t,v.issuerId).id == v.issuerId && ownerAt(t,v.issuerId).messageObject == v.messageObject))
  {
    var i :| 0 <= i < |t.views| && t.views[i] == v;
    var prior := s.views[i];
    assert prior in s.views && prior.dataId == v.dataId && prior.issuerId == v.issuerId && prior.messageObject == v.messageObject;
    ProofLib.FilterLengthPointwise((other: ExtractionView) => other.dataId == prior.dataId,(other: ExtractionView) => other.dataId == v.dataId,s.views,t.views);
  }
}

lemma RequestViewBinding(s: RequestRegistry,t: RequestRegistry,key: int)
  requires alwaysViewsHaveOneDataOwner(s)
  requires t.states == s.states && t.owners == s.owners
  requires t.views == ProofLib.Filter((view: ExtractionView) => view.dataId != key,s.views) ||
    exists v: ExtractionView :: v.dataId == key && (exists f :: f in t.states && f.dataId == v.dataId) &&
      (v.issuerId == 0 || (ownerAt(t,v.issuerId).id == v.issuerId && ownerAt(t,v.issuerId).messageObject == v.messageObject)) &&
      t.views == ProofLib.Filter((view: ExtractionView) => view.dataId != key,s.views) + [v]
  ensures alwaysViewsHaveOneDataOwner(t)
{
  RequestDataBridge(s);
  RequestDataBridge(t);
  var keep := ProofLib.Filter((view: ExtractionView) => view.dataId != key,s.views);
  forall r | r in keep
    ensures r in s.views && r.dataId != key &&
      |ProofLib.Filter((other: ExtractionView) => other.dataId == r.dataId,keep)| == 1
  {
    ProofLib.FilterMember((view: ExtractionView) => view.dataId != key,s.views,r);
    ProofLib.FilterOfFilterLength((view: ExtractionView) => view.dataId != key,
      (other: ExtractionView) => other.dataId == r.dataId,
      (other: ExtractionView) => other.dataId == r.dataId,s.views);
    var i :| 0 <= i < |keep| && keep[i] == r;
    assert r in ProofLib.Filter((other: ExtractionView) => other.dataId == r.dataId,keep) by {
      ProofLib.FilterMember((other: ExtractionView) => other.dataId == r.dataId,keep,r);
    }
  }
  if t.views != keep {
    var v: ExtractionView :| v.dataId == key && (exists f :: f in t.states && f.dataId == v.dataId) &&
      (v.issuerId == 0 || (ownerAt(t,v.issuerId).id == v.issuerId && ownerAt(t,v.issuerId).messageObject == v.messageObject)) && t.views == keep + [v];
    forall r | r in t.views
      ensures (exists f :: f in t.states && f.dataId == r.dataId) &&
        |ProofLib.Filter((other: ExtractionView) => other.dataId == r.dataId,t.views)| == 1 &&
        (r.issuerId == 0 || (ownerAt(t,r.issuerId).id == r.issuerId && ownerAt(t,r.issuerId).messageObject == r.messageObject))
    {
      if r == v {
        ProofLib.FilterOne((other: ExtractionView) => other.dataId == r.dataId,t.views,|keep|);
      } else {
        assert r in keep;
        ProofLib.FilterAppend((other: ExtractionView) => other.dataId == r.dataId,keep,v);
      }
    }
  }
}

lemma observeRequest_ensures(s: RequestRegistry, by_: RegistryCaller, messageObject: int, requestHash: string)
  ensures (inv(s) ==> canObserveRequest(s, by_, messageObject, requestHash) ==> alwaysDenialOwnershipIsUnique(observeRequest(s, by_, messageObject, requestHash)))
  ensures (inv(s) ==> canObserveRequest(s, by_, messageObject, requestHash) ==> alwaysSourceObjectIdentitiesAreUnique(observeRequest(s, by_, messageObject, requestHash)))
  ensures (inv(s) ==> canObserveRequest(s, by_, messageObject, requestHash) ==> alwaysActivePairsAreUnique(observeRequest(s, by_, messageObject, requestHash)))
  ensures (inv(s) ==> canObserveRequest(s, by_, messageObject, requestHash) ==> alwaysAttemptOwnershipIsUnique(observeRequest(s, by_, messageObject, requestHash)))
  ensures (inv(s) ==> canObserveRequest(s, by_, messageObject, requestHash) ==> alwaysResultOwnershipIsUnique(observeRequest(s, by_, messageObject, requestHash)))
  ensures (inv(s) ==> canObserveRequest(s, by_, messageObject, requestHash) ==> alwaysOwnersRetainProtocolSafety(observeRequest(s, by_, messageObject, requestHash)))
  ensures (inv(s) ==> canObserveRequest(s, by_, messageObject, requestHash) ==> alwaysViewsHaveOneDataOwner(observeRequest(s, by_, messageObject, requestHash)))
  ensures (inv(s) ==> canObserveRequest(s, by_, messageObject, requestHash) ==> stepActivePairIdentityNeverChanges(s, "observeRequest", observeRequest(s, by_, messageObject, requestHash)))
{
  if inv(s) && canObserveRequest(s,by_,messageObject,requestHash) {
    var t := observeRequest(s,by_,messageObject,requestHash);
    RequestSourceBridge(s);
    forall r | r in t.messages
      ensures r.objectId > 0 && |ProofLib.Filter((other: RequestMessage) => other.objectId == r.objectId,t.messages)| == 1
    {
      var i :| 0 <= i < |t.messages| && t.messages[i] == r;
      var prior := s.messages[i];
      assert prior in s.messages && prior.objectId == r.objectId;
      ProofLib.FilterLengthPointwise((other: RequestMessage) => other.objectId == prior.objectId,(other: RequestMessage) => other.objectId == r.objectId,s.messages,t.messages);
    }
    RequestSourceBridge(t);
  }
}

lemma observeRuntime_ensures(s: RequestRegistry, by_: RegistryCaller, runtimeId: int, agentId: string, live: bool)
  ensures (inv(s) ==> canObserveRuntime(s, by_, runtimeId, agentId, live) ==> alwaysDenialOwnershipIsUnique(observeRuntime(s, by_, runtimeId, agentId, live)))
  ensures (inv(s) ==> canObserveRuntime(s, by_, runtimeId, agentId, live) ==> alwaysSourceObjectIdentitiesAreUnique(observeRuntime(s, by_, runtimeId, agentId, live)))
  ensures (inv(s) ==> canObserveRuntime(s, by_, runtimeId, agentId, live) ==> alwaysActivePairsAreUnique(observeRuntime(s, by_, runtimeId, agentId, live)))
  ensures (inv(s) ==> canObserveRuntime(s, by_, runtimeId, agentId, live) ==> alwaysAttemptOwnershipIsUnique(observeRuntime(s, by_, runtimeId, agentId, live)))
  ensures (inv(s) ==> canObserveRuntime(s, by_, runtimeId, agentId, live) ==> alwaysResultOwnershipIsUnique(observeRuntime(s, by_, runtimeId, agentId, live)))
  ensures (inv(s) ==> canObserveRuntime(s, by_, runtimeId, agentId, live) ==> alwaysOwnersRetainProtocolSafety(observeRuntime(s, by_, runtimeId, agentId, live)))
  ensures (inv(s) ==> canObserveRuntime(s, by_, runtimeId, agentId, live) ==> alwaysViewsHaveOneDataOwner(observeRuntime(s, by_, runtimeId, agentId, live)))
  ensures (inv(s) ==> canObserveRuntime(s, by_, runtimeId, agentId, live) ==> stepActivePairIdentityNeverChanges(s, "observeRuntime", observeRuntime(s, by_, runtimeId, agentId, live)))
{
  if inv(s) && canObserveRuntime(s,by_,runtimeId,agentId,live) {
    var t := observeRuntime(s,by_,runtimeId,agentId,live);
    RequestSourceBridge(s);
    forall r | r in t.runtimes
      ensures r.id > 0 && |ProofLib.Filter((other: RuntimeObject) => other.id == r.id,t.runtimes)| == 1
    {
      var i :| 0 <= i < |t.runtimes| && t.runtimes[i] == r;
      var prior := s.runtimes[i];
      assert prior in s.runtimes && prior.id == r.id;
      ProofLib.FilterLengthPointwise((other: RuntimeObject) => other.id == prior.id,(other: RuntimeObject) => other.id == r.id,s.runtimes,t.runtimes);
    }
    RequestSourceBridge(t);
  }
}

lemma mutateState_ensures(s: RequestRegistry, stateObject: int, stateHash: string)
  ensures (inv(s) ==> canMutateState(s, stateObject, stateHash) ==> alwaysDenialOwnershipIsUnique(mutateState(s, stateObject, stateHash)))
  ensures (inv(s) ==> canMutateState(s, stateObject, stateHash) ==> alwaysSourceObjectIdentitiesAreUnique(mutateState(s, stateObject, stateHash)))
  ensures (inv(s) ==> canMutateState(s, stateObject, stateHash) ==> alwaysActivePairsAreUnique(mutateState(s, stateObject, stateHash)))
  ensures (inv(s) ==> canMutateState(s, stateObject, stateHash) ==> alwaysAttemptOwnershipIsUnique(mutateState(s, stateObject, stateHash)))
  ensures (inv(s) ==> canMutateState(s, stateObject, stateHash) ==> alwaysResultOwnershipIsUnique(mutateState(s, stateObject, stateHash)))
  ensures (inv(s) ==> canMutateState(s, stateObject, stateHash) ==> alwaysOwnersRetainProtocolSafety(mutateState(s, stateObject, stateHash)))
  ensures (inv(s) ==> canMutateState(s, stateObject, stateHash) ==> alwaysViewsHaveOneDataOwner(mutateState(s, stateObject, stateHash)))
  ensures (inv(s) ==> canMutateState(s, stateObject, stateHash) ==> stepActivePairIdentityNeverChanges(s, "mutateState", mutateState(s, stateObject, stateHash)))
{
  if inv(s) && canMutateState(s,stateObject,stateHash) {
    var t := mutateState(s,stateObject,stateHash);
    RequestSourceBridge(s);
    forall r | r in t.states
      ensures r.objectId > 0 && r.dataId > 0 && |ProofLib.Filter((other: RequestState) => other.objectId == r.objectId,t.states)| == 1
    {
      var i :| 0 <= i < |t.states| && t.states[i] == r;
      var prior := s.states[i];
      assert prior in s.states && prior.objectId == r.objectId;
      ProofLib.FilterLengthPointwise((other: RequestState) => other.objectId == prior.objectId,(other: RequestState) => other.objectId == r.objectId,s.states,t.states);
    }
    RequestSourceBridge(t);
    RequestViewsKeepData(s,t);
  }
}

lemma mutateView_ensures(s: RequestRegistry, stateObject: int, sourceHash: string, projectionHash: string)
  ensures (inv(s) ==> canMutateView(s, stateObject, sourceHash, projectionHash) ==> alwaysDenialOwnershipIsUnique(mutateView(s, stateObject, sourceHash, projectionHash)))
  ensures (inv(s) ==> canMutateView(s, stateObject, sourceHash, projectionHash) ==> alwaysSourceObjectIdentitiesAreUnique(mutateView(s, stateObject, sourceHash, projectionHash)))
  ensures (inv(s) ==> canMutateView(s, stateObject, sourceHash, projectionHash) ==> alwaysActivePairsAreUnique(mutateView(s, stateObject, sourceHash, projectionHash)))
  ensures (inv(s) ==> canMutateView(s, stateObject, sourceHash, projectionHash) ==> alwaysAttemptOwnershipIsUnique(mutateView(s, stateObject, sourceHash, projectionHash)))
  ensures (inv(s) ==> canMutateView(s, stateObject, sourceHash, projectionHash) ==> alwaysResultOwnershipIsUnique(mutateView(s, stateObject, sourceHash, projectionHash)))
  ensures (inv(s) ==> canMutateView(s, stateObject, sourceHash, projectionHash) ==> alwaysOwnersRetainProtocolSafety(mutateView(s, stateObject, sourceHash, projectionHash)))
  ensures (inv(s) ==> canMutateView(s, stateObject, sourceHash, projectionHash) ==> alwaysViewsHaveOneDataOwner(mutateView(s, stateObject, sourceHash, projectionHash)))
  ensures (inv(s) ==> canMutateView(s, stateObject, sourceHash, projectionHash) ==> stepActivePairIdentityNeverChanges(s, "mutateView", mutateView(s, stateObject, sourceHash, projectionHash)))
{
  if inv(s) && canMutateView(s,stateObject,sourceHash,projectionHash) {
    RequestViewMutation(s,mutateView(s,stateObject,sourceHash,projectionHash));
  }
}

lemma bindView_ensures(s: RequestRegistry, by_: RegistryCaller, stateObject: int, messageObject: int, binding: ViewBindingObservation)
  ensures (inv(s) ==> canBindView(s, by_, stateObject, messageObject) ==> alwaysDenialOwnershipIsUnique(bindView(s, by_, stateObject, messageObject, binding)))
  ensures (inv(s) ==> canBindView(s, by_, stateObject, messageObject) ==> alwaysSourceObjectIdentitiesAreUnique(bindView(s, by_, stateObject, messageObject, binding)))
  ensures (inv(s) ==> canBindView(s, by_, stateObject, messageObject) ==> alwaysActivePairsAreUnique(bindView(s, by_, stateObject, messageObject, binding)))
  ensures (inv(s) ==> canBindView(s, by_, stateObject, messageObject) ==> alwaysAttemptOwnershipIsUnique(bindView(s, by_, stateObject, messageObject, binding)))
  ensures (inv(s) ==> canBindView(s, by_, stateObject, messageObject) ==> alwaysResultOwnershipIsUnique(bindView(s, by_, stateObject, messageObject, binding)))
  ensures (inv(s) ==> canBindView(s, by_, stateObject, messageObject) ==> alwaysOwnersRetainProtocolSafety(bindView(s, by_, stateObject, messageObject, binding)))
  ensures (inv(s) ==> canBindView(s, by_, stateObject, messageObject) ==> alwaysViewsHaveOneDataOwner(bindView(s, by_, stateObject, messageObject, binding)))
  ensures (inv(s) ==> canBindView(s, by_, stateObject, messageObject) ==> stepActivePairIdentityNeverChanges(s, "bindView", bindView(s, by_, stateObject, messageObject, binding)))
{
  if inv(s) && canBindView(s,by_,stateObject,messageObject) {
    var t := bindView(s,by_,stateObject,messageObject, binding);
    RequestStateLookup(s,stateObject);
    var frame := stateAt(s,stateObject);
    assert frame in s.states;
    RequestOwnerLookup(s,binding.issuerId);
    var keep := ProofLib.Filter((view: ExtractionView) => view.dataId != frame.dataId,s.views);
    if t.views != keep {
      assert |t.views| == |keep| + 1;
      var v := t.views[|keep|];
      assert frame in t.states && frame.dataId == v.dataId;
      assert v.issuerId == 0 || (ownerAt(t,v.issuerId).id == v.issuerId && ownerAt(t,v.issuerId).messageObject == v.messageObject);
      assert t.views == keep + [v];
    }
    RequestViewBinding(s,t,frame.dataId);
  }
}

lemma checkOperation_ensures(s: RequestRegistry, stateObject: int, messageObject: int, attemptId: string, operation: core__requestCompletions_Operation, registered: core__requestCompletions_Operation, denialId: string)
  ensures (inv(s) ==> canCheckOperation(s, stateObject, messageObject, attemptId, operation, registered, denialId) ==> alwaysDenialOwnershipIsUnique(checkOperation(s, stateObject, messageObject, attemptId, operation, registered, denialId)))
  ensures (inv(s) ==> canCheckOperation(s, stateObject, messageObject, attemptId, operation, registered, denialId) ==> alwaysSourceObjectIdentitiesAreUnique(checkOperation(s, stateObject, messageObject, attemptId, operation, registered, denialId)))
  ensures (inv(s) ==> canCheckOperation(s, stateObject, messageObject, attemptId, operation, registered, denialId) ==> alwaysActivePairsAreUnique(checkOperation(s, stateObject, messageObject, attemptId, operation, registered, denialId)))
  ensures (inv(s) ==> canCheckOperation(s, stateObject, messageObject, attemptId, operation, registered, denialId) ==> alwaysAttemptOwnershipIsUnique(checkOperation(s, stateObject, messageObject, attemptId, operation, registered, denialId)))
  ensures (inv(s) ==> canCheckOperation(s, stateObject, messageObject, attemptId, operation, registered, denialId) ==> alwaysResultOwnershipIsUnique(checkOperation(s, stateObject, messageObject, attemptId, operation, registered, denialId)))
  ensures (inv(s) ==> canCheckOperation(s, stateObject, messageObject, attemptId, operation, registered, denialId) ==> alwaysOwnersRetainProtocolSafety(checkOperation(s, stateObject, messageObject, attemptId, operation, registered, denialId)))
  ensures (inv(s) ==> canCheckOperation(s, stateObject, messageObject, attemptId, operation, registered, denialId) ==> alwaysViewsHaveOneDataOwner(checkOperation(s, stateObject, messageObject, attemptId, operation, registered, denialId)))
  ensures (inv(s) ==> canCheckOperation(s, stateObject, messageObject, attemptId, operation, registered, denialId) ==> stepActivePairIdentityNeverChanges(s, "checkOperation", checkOperation(s, stateObject, messageObject, attemptId, operation, registered, denialId)))
{
  if inv(s) && canCheckOperation(s,stateObject,messageObject,attemptId,operation,registered,denialId) {
    var a := attemptOwner(s,attemptId);
    var owner := refreshedOwner(a,s);
    var t := checkOperation(s,stateObject,messageObject,attemptId,operation,registered,denialId);
    if owner.id != 0 && owner.messageObject == messageObject && boundViewCurrent(s,stateObject,messageObject) && viewAt(s,stateObject).issuerId == owner.id {
      RequestAttemptLookup(s,attemptId);
      assert a in s.owners;
      core__requestCompletions_observeAuthority_ensures(a.completions,a.issuer.revision,ownerCurrent(a,s) && a.issuer.committed,completionClass(core__requestIssuer_restriction(a.issuer)));
      var c := owner.completions;
      assert core__requestCompletions_inv(c);
      core__requestCompletions_checkOperation_ensures(c,attemptId,operation,registered,denialId);
      var updated := core__requestCompletions_checkOperation(c,attemptId,operation,registered,denialId);
      if denialId != "" { RequestTargetDenialAvailable(s,a,denialId); }
      RequestDenialKeys(c.denials,updated.denials,denialId);
      forall x | x in updated.attempts ensures exists prior :: prior in c.attempts && prior.id == x.id
      {
        var i :| 0 <= i < |updated.attempts| && updated.attempts[i] == x;
        var prior := c.attempts[i];
        assert prior in c.attempts;
        if prior.id == attemptId && x.id != prior.id {
          RequestCompletionAttemptAt(c,prior);
          assert core__requestCompletions_attemptAt(c,attemptId).id == prior.id;
        }
      }
      RequestCompletionPeers(s,a,updated,"","",denialId);
      RequestReplacement(s,t,a,owner.(completions := updated));
    } else {
      assert t == s.(lastAllowed := !core__requestCompletions_mutation(operation));
    }
  }
}

lemma RequestBindExistingAssociation(s: RequestRegistry, t: RequestRegistry, a: IssuerOwner, resultId: string, fingerprint: string)
  requires inv(s) && a in s.owners
  requires t == replaceOwner(a.(completions := flagChangedResult(a.completions,resultId,fingerprint)),s).(lastBound := false)
  ensures inv(t) && stepActivePairIdentityNeverChanges(s,"",t)
{
  var c := a.completions;
  var updated := flagChangedResult(c,resultId,fingerprint);
  RequestCompletionResultMap(c,updated);
  RequestResultKeys(c.results,updated.results,"");
  RequestCompletionPeers(s,a,updated,"","","");
  RequestReplacement(s,t,a,a.(completions := updated));
}

lemma RequestFreshResultAssociation(s: RequestRegistry, t: RequestRegistry, a: IssuerOwner, resultId: string, attemptId: string, fingerprint: string, projectionHash: string, observation: core__requestCompletions_RegistrationSnapshot, child: core__requestCompletions_ChildSnapshot)
  requires inv(s) && a in s.owners
  requires resultOwner(s,resultId).id == 0 || resultOwner(s,resultId).id == a.id
  requires core__requestCompletions_canBindResult(refreshedOwner(a,s).completions,resultId,attemptId)
  requires var owner := refreshedOwner(a,s);
    var updated := core__requestCompletions_bindResult(owner.completions,resultId,attemptId,fingerprint,projectionHash,observation, child);
    t == replaceOwner(owner.(completions := updated),s).(lastBound := t.lastBound)
  ensures inv(t) && stepActivePairIdentityNeverChanges(s,"",t)
{
  RequestTargetResultAvailable(s,a,resultId);
  var owner := refreshedOwner(a,s);
  var c := owner.completions;
  core__requestCompletions_observeAuthority_ensures(a.completions,a.issuer.revision,ownerCurrent(a,s) && a.issuer.committed,completionClass(core__requestIssuer_restriction(a.issuer)));
  assert core__requestCompletions_inv(c);
  RequestLeafBindResult(c,resultId,attemptId,fingerprint,projectionHash,observation, child);
  var updated := core__requestCompletions_bindResult(c,resultId,attemptId,fingerprint,projectionHash,observation, child);
  RequestCompletionPeers(s,a,updated,"",resultId,"");
  RequestReplacement(s,t,a,owner.(completions := updated));
}

lemma RequestBindResultAggregate(s: RequestRegistry, by_: RegistryCaller, resultId: string, attemptId: string, fingerprint: string, projectionHash: string, observation: core__requestCompletions_RegistrationSnapshot, child: core__requestCompletions_ChildSnapshot)
  requires inv(s) && canBindResult(s,by_,resultId,attemptId)
  ensures inv(bindResult(s, by_, resultId, attemptId, fingerprint, projectionHash, observation, child)) && stepActivePairIdentityNeverChanges(s, "", bindResult(s, by_, resultId, attemptId, fingerprint, projectionHash, observation, child))
{
  RequestAttemptLookup(s,attemptId);
  RequestResultLookup(s,resultId);
  var a := attemptOwner(s,attemptId);
  var existingOwner := resultOwner(s,resultId);
  var existing := core__requestCompletions_resultAt(existingOwner.completions,resultId);
  var t := bindResult(s,by_,resultId,attemptId,fingerprint,projectionHash,observation, child);
  assert a in s.owners;
  if existingOwner.id == 0 || (existingOwner.id == a.id && existing.attempt == attemptId) {
    RequestFreshResultAssociation(s,t,a,resultId,attemptId,fingerprint,projectionHash,observation, child);
  } else {
    assert existingOwner in s.owners;
    RequestBindExistingAssociation(s,t,existingOwner,resultId,fingerprint);
  }
}

lemma bindResult_ensures(s: RequestRegistry, by_: RegistryCaller, resultId: string, attemptId: string, fingerprint: string, projectionHash: string, observation: core__requestCompletions_RegistrationSnapshot, child: core__requestCompletions_ChildSnapshot)
  ensures (inv(s) ==> canBindResult(s, by_, resultId, attemptId) ==> alwaysDenialOwnershipIsUnique(bindResult(s, by_, resultId, attemptId, fingerprint, projectionHash, observation, child)))
  ensures (inv(s) ==> canBindResult(s, by_, resultId, attemptId) ==> alwaysSourceObjectIdentitiesAreUnique(bindResult(s, by_, resultId, attemptId, fingerprint, projectionHash, observation, child)))
  ensures (inv(s) ==> canBindResult(s, by_, resultId, attemptId) ==> alwaysActivePairsAreUnique(bindResult(s, by_, resultId, attemptId, fingerprint, projectionHash, observation, child)))
  ensures (inv(s) ==> canBindResult(s, by_, resultId, attemptId) ==> alwaysAttemptOwnershipIsUnique(bindResult(s, by_, resultId, attemptId, fingerprint, projectionHash, observation, child)))
  ensures (inv(s) ==> canBindResult(s, by_, resultId, attemptId) ==> alwaysResultOwnershipIsUnique(bindResult(s, by_, resultId, attemptId, fingerprint, projectionHash, observation, child)))
  ensures (inv(s) ==> canBindResult(s, by_, resultId, attemptId) ==> alwaysOwnersRetainProtocolSafety(bindResult(s, by_, resultId, attemptId, fingerprint, projectionHash, observation, child)))
  ensures (inv(s) ==> canBindResult(s, by_, resultId, attemptId) ==> alwaysViewsHaveOneDataOwner(bindResult(s, by_, resultId, attemptId, fingerprint, projectionHash, observation, child)))
  ensures (inv(s) ==> canBindResult(s, by_, resultId, attemptId) ==> stepActivePairIdentityNeverChanges(s, "bindResult", bindResult(s, by_, resultId, attemptId, fingerprint, projectionHash, observation, child)))
{
  if inv(s) && canBindResult(s,by_,resultId,attemptId) { RequestBindResultAggregate(s, by_, resultId, attemptId, fingerprint, projectionHash, observation, child); }
}

lemma RequestCompletionAttemptAt(c: core__requestCompletions_RequestCompletions, a: core__requestCompletions_Attempt)
  requires core__requestCompletions_inv(c) && a in c.attempts
  ensures core__requestCompletions_attemptAt(c,a.id) == a
{
  var selected := ProofLib.Filter((attempt: core__requestCompletions_Attempt) => attempt.id == a.id,c.attempts);
  ProofLib.FilterMember((attempt: core__requestCompletions_Attempt) => attempt.id == a.id,c.attempts,a);
  assert |selected| == 1;
  assert selected[0] == a;
}
