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

lemma RequestReplacement(s: RequestRegistry, t: RequestRegistry, target: IssuerOwner, changed: IssuerOwner)
  requires inv(s) && target in s.owners
  requires changed.id == target.id && changed.runtimeId == target.runtimeId && changed.messageObject == target.messageObject
  requires t == replaceOwner(changed, s) || (t.runtimes == s.runtimes && t.messages == s.messages && t.states == s.states && t.views == s.views && t.owners == replaceOwner(changed, s).owners && t.nextIssuer == s.nextIssuer)
  requires core__requestIssuer_inv(changed.issuer) && core__requestCompletions_inv(changed.completions)
  requires forall peer :: peer in s.owners && peer.id != target.id ==>
    (!(exists a,b :: a in changed.completions.attempts && b in peer.completions.attempts && a.id == b.id) &&
     !(exists a,b :: a in changed.completions.results && b in peer.completions.results && a.id == b.id) &&
     !(exists a,b :: a in changed.completions.denials && b in peer.completions.denials && a.id == b.id))
  ensures inv(t)
  ensures stepActivePairIdentityNeverChanges(s, "", t)
{
  RequestIssuerBridge(s);
  RequestIssuerBridge(t);
  RequestDataBridge(s);
  RequestDataBridge(t);
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
    ProofLib.FilterLengthPointwise((other: IssuerOwner) => other.runtimeId == b.runtimeId && other.messageObject == b.messageObject, (other: IssuerOwner) => other.runtimeId == a.runtimeId && other.messageObject == a.messageObject, s.owners, t.owners);
  }
  forall a | a in s.owners
    ensures exists b :: b in t.owners && b.id == a.id && b.runtimeId == a.runtimeId && b.messageObject == a.messageObject
  {
    var i :| 0 <= i < |s.owners| && s.owners[i] == a;
    assert t.owners[i] in t.owners;
  }
  forall v | v in t.views && v.issuerId != 0
    ensures ownerAt(t,v.issuerId).id == v.issuerId && ownerAt(t,v.issuerId).messageObject == v.messageObject
  {
    ProofLib.FilterPointwise((a: IssuerOwner) => a.id == v.issuerId, (a: IssuerOwner) => a.id == v.issuerId,
      (a: IssuerOwner, b: IssuerOwner) => a.id == b.id && a.messageObject == b.messageObject, s.owners, t.owners);
  }
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

lemma observeSources_ensures(s: RequestRegistry, by_: RegistryCaller, issuerId: int, currentSourceHash: string, currentOriginalHash: string)
  ensures (inv(s) ==> canObserveSources(s, by_, issuerId, currentSourceHash, currentOriginalHash) ==> alwaysDenialOwnershipIsUnique(observeSources(s, by_, issuerId, currentSourceHash, currentOriginalHash)))
  ensures (inv(s) ==> canObserveSources(s, by_, issuerId, currentSourceHash, currentOriginalHash) ==> alwaysSourceObjectIdentitiesAreUnique(observeSources(s, by_, issuerId, currentSourceHash, currentOriginalHash)))
  ensures (inv(s) ==> canObserveSources(s, by_, issuerId, currentSourceHash, currentOriginalHash) ==> alwaysActivePairsAreUnique(observeSources(s, by_, issuerId, currentSourceHash, currentOriginalHash)))
  ensures (inv(s) ==> canObserveSources(s, by_, issuerId, currentSourceHash, currentOriginalHash) ==> alwaysAttemptOwnershipIsUnique(observeSources(s, by_, issuerId, currentSourceHash, currentOriginalHash)))
  ensures (inv(s) ==> canObserveSources(s, by_, issuerId, currentSourceHash, currentOriginalHash) ==> alwaysResultOwnershipIsUnique(observeSources(s, by_, issuerId, currentSourceHash, currentOriginalHash)))
  ensures (inv(s) ==> canObserveSources(s, by_, issuerId, currentSourceHash, currentOriginalHash) ==> alwaysOwnersRetainProtocolSafety(observeSources(s, by_, issuerId, currentSourceHash, currentOriginalHash)))
  ensures (inv(s) ==> canObserveSources(s, by_, issuerId, currentSourceHash, currentOriginalHash) ==> alwaysViewsHaveOneDataOwner(observeSources(s, by_, issuerId, currentSourceHash, currentOriginalHash)))
  ensures (inv(s) ==> canObserveSources(s, by_, issuerId, currentSourceHash, currentOriginalHash) ==> stepActivePairIdentityNeverChanges(s, "observeSources", observeSources(s, by_, issuerId, currentSourceHash, currentOriginalHash)))
{
  if inv(s) && canObserveSources(s, by_, issuerId, currentSourceHash, currentOriginalHash) {
    RequestOwnerLookup(s,issuerId);
    var a := ownerAt(s,issuerId);
    assert a in s.owners;
    core__requestIssuer_observeCurrent_ensures(a.issuer,a.issuer.live,a.issuer.currentRequestHash,currentSourceHash);
    var t := observeSources(s, by_, issuerId, currentSourceHash, currentOriginalHash);
    var i :| 0 <= i < |s.owners| && s.owners[i] == a;
    var changed := t.owners[i];
    RequestCompletionPeers(s,a,changed.completions,"","","");
    RequestReplacement(s,t,a,changed);
  }
}

lemma beginAttempt_ensures(s: RequestRegistry, by_: RegistryCaller, issuerId: int, stateObject: int, messageObject: int, attemptId: string)
  ensures (inv(s) ==> canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) ==> alwaysDenialOwnershipIsUnique(beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId)))
  ensures (inv(s) ==> canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) ==> alwaysSourceObjectIdentitiesAreUnique(beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId)))
  ensures (inv(s) ==> canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) ==> alwaysActivePairsAreUnique(beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId)))
  ensures (inv(s) ==> canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) ==> alwaysAttemptOwnershipIsUnique(beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId)))
  ensures (inv(s) ==> canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) ==> alwaysResultOwnershipIsUnique(beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId)))
  ensures (inv(s) ==> canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) ==> alwaysOwnersRetainProtocolSafety(beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId)))
  ensures (inv(s) ==> canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) ==> alwaysViewsHaveOneDataOwner(beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId)))
  ensures (inv(s) ==> canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) ==> stepActivePairIdentityNeverChanges(s, "beginAttempt", beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId)))
{
  if inv(s) && canBeginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId) {
    RequestOwnerLookup(s,issuerId);
    var a := ownerAt(s,issuerId);
    assert a in s.owners;
    core__requestCompletions_beginAttempt_ensures(refreshedOwner(a,s).completions,attemptId);
    RequestAttemptLookup(s,attemptId);
    var t := beginAttempt(s, by_, issuerId, stateObject, messageObject, attemptId);
    var i :| 0 <= i < |s.owners| && s.owners[i] == a;
    var changed := t.owners[i];
    RequestCompletionPeers(s,a,changed.completions,attemptId,"","");
    RequestReplacement(s,t,a,changed);
  }
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
  if inv(s) && canProjectResult(s, by_, issuerId, sourceId, targetId) {
    RequestResultLookup(s,sourceId);
    var a := resultOwner(s,sourceId);
    assert a in s.owners;
    core__requestCompletions_projectResult_ensures(a.completions,sourceId,targetId,fingerprint,projectionHash,true,sourceFingerprint);
    RequestResultLookup(s,targetId);
    var t := projectResult(s, by_, issuerId, sourceId, targetId, fingerprint, projectionHash, sourceFingerprint);
    var i :| 0 <= i < |s.owners| && s.owners[i] == a;
    var changed := t.owners[i];
    RequestCompletionPeers(s,a,changed.completions,"",targetId,"");
    RequestReplacement(s,t,a,changed);
  }
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
    assert a in s.owners;
    core__requestCompletions_copyCompletion_ensures(a.completions,sourceId,targetId,sourceFingerprint,targetFingerprint);
    var t := copyCompletion(s, sourceId, targetId, sourceFingerprint, targetFingerprint);
    var i :| 0 <= i < |s.owners| && s.owners[i] == a;
    var changed := t.owners[i];
    RequestCompletionPeers(s,a,changed.completions,"","","");
    RequestReplacement(s,t,a,changed);
  }
}

lemma inspectCompletion_ensures(s: RequestRegistry, issuerId: int, resultId: string, fingerprint: string, registrationCurrent: bool)
  ensures (inv(s) ==> canInspectCompletion(s, issuerId, resultId) ==> alwaysDenialOwnershipIsUnique(inspectCompletion(s, issuerId, resultId, fingerprint, registrationCurrent)))
  ensures (inv(s) ==> canInspectCompletion(s, issuerId, resultId) ==> alwaysSourceObjectIdentitiesAreUnique(inspectCompletion(s, issuerId, resultId, fingerprint, registrationCurrent)))
  ensures (inv(s) ==> canInspectCompletion(s, issuerId, resultId) ==> alwaysActivePairsAreUnique(inspectCompletion(s, issuerId, resultId, fingerprint, registrationCurrent)))
  ensures (inv(s) ==> canInspectCompletion(s, issuerId, resultId) ==> alwaysAttemptOwnershipIsUnique(inspectCompletion(s, issuerId, resultId, fingerprint, registrationCurrent)))
  ensures (inv(s) ==> canInspectCompletion(s, issuerId, resultId) ==> alwaysResultOwnershipIsUnique(inspectCompletion(s, issuerId, resultId, fingerprint, registrationCurrent)))
  ensures (inv(s) ==> canInspectCompletion(s, issuerId, resultId) ==> alwaysOwnersRetainProtocolSafety(inspectCompletion(s, issuerId, resultId, fingerprint, registrationCurrent)))
  ensures (inv(s) ==> canInspectCompletion(s, issuerId, resultId) ==> alwaysViewsHaveOneDataOwner(inspectCompletion(s, issuerId, resultId, fingerprint, registrationCurrent)))
  ensures (inv(s) ==> canInspectCompletion(s, issuerId, resultId) ==> stepActivePairIdentityNeverChanges(s, "inspectCompletion", inspectCompletion(s, issuerId, resultId, fingerprint, registrationCurrent)))
{
  if inv(s) && canInspectCompletion(s, issuerId, resultId) {
    RequestResultLookup(s,resultId);
    var a := resultOwner(s,resultId);
    assert a in s.owners;
    core__requestCompletions_inspectCompletion_ensures(refreshedOwner(a,s).completions,resultId,true,fingerprint,registrationCurrent);
    var t := inspectCompletion(s, issuerId, resultId, fingerprint, registrationCurrent);
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
  if inv(s) && canTransferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted) {
    RequestDenialLookup(s,sourceDenial);
    var a := denialOwner(s,sourceDenial);
    assert a in s.owners;
    core__requestCompletions_transferDenial_ensures(refreshedOwner(a,s).completions,sourceDenial,targetResult,expectedAttempt,targetNotStarted,sourceNotStarted);
    RequestDenialLookup(s,targetResult);
    var t := transferDenial(s, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted);
    var i :| 0 <= i < |s.owners| && s.owners[i] == a;
    var changed := t.owners[i];
    RequestCompletionPeers(s,a,changed.completions,"","",targetResult);
    RequestReplacement(s,t,a,changed);
  }
}
