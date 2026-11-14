lemma ServiceObjectIdentityFilters(x: ServiceInstances)
  ensures alwaysClassAndObjectIdentities(x) ==
    ((forall c :: c in x.classes ==> c.id > 0 && c.generation >= 0 && c.pending >= 0 && |ProofLib.Filter((other: ServiceClassEntry) => (other.id == c.id), x.classes)| == 1) &&
     (forall o :: o in x.objects ==> o.id > 0 && |ProofLib.Filter((other: ServiceObject) => (other.id == o.id), x.objects)| == 1))
{}

lemma ServiceObjectLookup(s: ServiceInstances, instanceId: int)
  requires alwaysClassAndObjectIdentities(s)
  ensures forall o :: o in s.objects && o.id == instanceId ==> o == serviceObject(s, instanceId)
{
  ServiceObjectIdentityFilters(s);
  ServiceObjectLookupProjection(s, instanceId);
  var candidates := ProofLib.Filter((o: ServiceObject) => (o.id == instanceId), s.objects);
  forall o | o in s.objects && o.id == instanceId ensures o == serviceObject(s, instanceId)
  {
    ProofLib.FilterMember((o: ServiceObject) => (o.id == instanceId), s.objects, o);
    ProofLib.FilterSamePredicate((o: ServiceObject) => (o.id == instanceId), (other: ServiceObject) => (other.id == o.id), s.objects);
    assert |candidates| == 1 && candidates[0] == o;
  }
}

lemma ServiceObjectLookupProjection(s: ServiceInstances, instanceId: int)
  ensures serviceObject(s, instanceId) ==
    (var candidates := ProofLib.Filter((o: ServiceObject) => (o.id == instanceId), s.objects); if |candidates| > 0 then candidates[0] else noObject)
{}

lemma ServiceObjectProjection(s: ServiceInstances, after: ServiceInstances)
  requires alwaysClassAndObjectIdentities(s)
  requires after.classes == s.classes
  requires |s.objects| == |after.objects|
  requires forall i :: 0 <= i < |s.objects| ==> after.objects[i].id == s.objects[i].id
  ensures alwaysClassAndObjectIdentities(after)
  ensures forall o :: o in s.objects ==> exists a :: a in after.objects && a.id == o.id
{
  ServiceObjectIdentityFilters(s); ServiceObjectIdentityFilters(after);
  forall o | o in after.objects ensures o.id > 0 && |ProofLib.Filter((other: ServiceObject) => (other.id == o.id), after.objects)| == 1
  {
    var i :| 0 <= i < |after.objects| && after.objects[i] == o;
    assert s.objects[i] in s.objects;
    ProofLib.FilterLengthPointwise((other: ServiceObject) => (other.id == o.id), (other: ServiceObject) => (other.id == o.id), s.objects, after.objects);
  }
  forall o | o in s.objects ensures exists a :: a in after.objects && a.id == o.id
  {
    var i :| 0 <= i < |s.objects| && s.objects[i] == o;
    assert after.objects[i] in after.objects;
  }
}

lemma ServiceStopReferencePreserved(s: ServiceInstances, after: ServiceInstances)
  requires |s.objects| == |after.objects|
  requires forall i :: 0 <= i < |s.objects| && !s.objects[i].stopPhase.StopNotRequested? ==>
    after.objects[i].id == s.objects[i].id && after.objects[i].stopCalls == 1 &&
    (s.objects[i].stopPhase.StopWaiting? || after.objects[i].stopPhase == s.objects[i].stopPhase)
  ensures stepStopIdentityRetained(s, after)
{
  forall o | o in s.objects && !o.stopPhase.StopNotRequested?
    ensures (exists laterObject :: laterObject in after.objects && laterObject.id == o.id && laterObject.stopCalls == 1 && (o.stopPhase.StopWaiting? || laterObject.stopPhase == o.stopPhase))
  {
    var i :| 0 <= i < |s.objects| && s.objects[i] == o;
    assert after.objects[i] in after.objects;
  }
}

lemma ServiceObjectObservationsStable(s: ServiceInstances, after: ServiceInstances)
  requires inv(s)
  requires after.classes == s.classes && after.attempts == s.attempts && after.calls == s.calls && after.aggregates == s.aggregates
  requires forall o :: o in s.objects ==> exists a :: a in after.objects && a.id == o.id
  ensures alwaysClassOwnsKnownObjects(after) && alwaysCapturedAttemptsExist(after)
{
  forall a | a in after.attempts && a.instance != 0 ensures serviceObject(after, a.instance).id == a.instance
  {
    var present := serviceObject(s, a.instance);
    ServiceObjectPresence(s, a.instance);
    var survivor :| survivor in after.objects && survivor.id == a.instance;
    ServiceObjectExistence(after, survivor);
  }
}

lemma ServiceObjectPresence(s: ServiceInstances, instanceId: int)
  requires serviceObject(s, instanceId).id != 0
  ensures serviceObject(s, instanceId) in s.objects
{
  ServiceObjectLookupProjection(s, instanceId);
  var candidates := ProofLib.Filter((o: ServiceObject) => (o.id == instanceId), s.objects);
  assert |candidates| > 0;
  ProofLib.FilterMember((o: ServiceObject) => (o.id == instanceId), s.objects, candidates[0]);
}

lemma ServiceObjectExistence(s: ServiceInstances, survivor: ServiceObject)
  requires survivor in s.objects
  ensures serviceObject(s, survivor.id).id == survivor.id
{
  ServiceObjectLookupProjection(s, survivor.id);
  var candidates := ProofLib.Filter((o: ServiceObject) => (o.id == survivor.id), s.objects);
  ProofLib.FilterMember((o: ServiceObject) => (o.id == survivor.id), s.objects, survivor);
  ProofLib.FilterMember((o: ServiceObject) => (o.id == survivor.id), s.objects, candidates[0]);
}

lemma requestObjectStop_ensures(s: ServiceInstances, instanceId: int)
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> alwaysTypeEntriesUnique(requestObjectStop(s, instanceId)))
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> alwaysAggregateAndLoadIdsUnique(requestObjectStop(s, instanceId)))
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> alwaysAcquisitionIdsUnique(requestObjectStop(s, instanceId)))
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> alwaysInitWaitingHasNoAggregate(requestObjectStop(s, instanceId)))
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> alwaysTypeReferencesRetained(requestObjectStop(s, instanceId)))
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> alwaysClassAndObjectIdentities(requestObjectStop(s, instanceId)))
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> alwaysObjectStopOnce(requestObjectStop(s, instanceId)))
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> alwaysClassOwnsKnownObjects(requestObjectStop(s, instanceId)))
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> alwaysStoppedHasNoPublication(requestObjectStop(s, instanceId)))
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> alwaysPublicationIdentitiesValid(requestObjectStop(s, instanceId)))
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> alwaysPendingAttemptsOwned(requestObjectStop(s, instanceId)))
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> alwaysCapturedAttemptsExist(requestObjectStop(s, instanceId)))
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> alwaysDeclarationsMatch(requestObjectStop(s, instanceId)))
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> alwaysAttemptGeneration(requestObjectStop(s, instanceId)))
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> alwaysFailedTypeHasNoPublication(requestObjectStop(s, instanceId)))
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> stepStopIdentityRetained(s, requestObjectStop(s, instanceId)))
  ensures (inv(s) ==> canRequestObjectStop(s, instanceId) ==> stepSupersededAggregateKeepsSuccessor(s, "requestObjectStop", requestObjectStop(s, instanceId)))
{
  if inv(s) && canRequestObjectStop(s, instanceId) {
    var after := requestObjectStop(s, instanceId);
    ServiceObjectProjection(s, after);
    ServiceObjectObservationsStable(s, after);
    forall a | a in after.objects
      ensures a.stopCalls >= 0 && a.stopCalls <= 1 && (!a.stopPhase.StopNotRequested? <==> a.stopCalls == 1)
    {
      var i :| 0 <= i < |after.objects| && after.objects[i] == a;
      var prior := s.objects[i];
      assert prior in s.objects;
      if prior.id == instanceId { ServiceObjectLookup(s, instanceId); }
    }
    forall i | 0 <= i < |s.objects| && !s.objects[i].stopPhase.StopNotRequested?
      ensures after.objects[i].id == s.objects[i].id && after.objects[i].stopCalls == 1 &&
        (s.objects[i].stopPhase.StopWaiting? || after.objects[i].stopPhase == s.objects[i].stopPhase)
    {
      var prior := s.objects[i];
      assert prior in s.objects;
      if prior.id == instanceId { ServiceObjectLookup(s, instanceId); }
    }
    ServiceStopReferencePreserved(s, after);
  }
}

lemma invokeObjectStop_ensures(s: ServiceInstances, instanceId: int)
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysTypeEntriesUnique(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysAggregateAndLoadIdsUnique(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysAcquisitionIdsUnique(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysInitWaitingHasNoAggregate(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysTypeReferencesRetained(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysClassAndObjectIdentities(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysObjectStopOnce(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysClassOwnsKnownObjects(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysStoppedHasNoPublication(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysPublicationIdentitiesValid(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysPendingAttemptsOwned(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysCapturedAttemptsExist(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysDeclarationsMatch(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysAttemptGeneration(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> alwaysFailedTypeHasNoPublication(invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> stepStopIdentityRetained(s, invokeObjectStop(s, instanceId)))
  ensures (inv(s) ==> canInvokeObjectStop(s, instanceId) ==> stepSupersededAggregateKeepsSuccessor(s, "invokeObjectStop", invokeObjectStop(s, instanceId)))
{
  if inv(s) && canInvokeObjectStop(s, instanceId) {
    var after := invokeObjectStop(s, instanceId);
    ServiceObjectProjection(s, after);
    ServiceObjectObservationsStable(s, after);
    forall a | a in after.objects
      ensures a.stopCalls >= 0 && a.stopCalls <= 1 && (!a.stopPhase.StopNotRequested? <==> a.stopCalls == 1)
    {
      var i :| 0 <= i < |after.objects| && after.objects[i] == a;
      var prior := s.objects[i];
      assert prior in s.objects;
      assert a.stopCalls == prior.stopCalls && a.stopPhase == prior.stopPhase;
    }
    forall i | 0 <= i < |s.objects| && !s.objects[i].stopPhase.StopNotRequested?
      ensures after.objects[i].id == s.objects[i].id && after.objects[i].stopCalls == 1 &&
        (s.objects[i].stopPhase.StopWaiting? || after.objects[i].stopPhase == s.objects[i].stopPhase)
    {
      var prior := s.objects[i];
      assert prior in s.objects;
      assert after.objects[i].stopPhase == prior.stopPhase && after.objects[i].stopCalls == prior.stopCalls;
    }
    ServiceStopReferencePreserved(s, after);
  }
}

lemma settleObjectStop_ensures(s: ServiceInstances, instanceId: int, ok: bool, errorId: string)
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysTypeEntriesUnique(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysAggregateAndLoadIdsUnique(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysAcquisitionIdsUnique(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysInitWaitingHasNoAggregate(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysTypeReferencesRetained(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysClassAndObjectIdentities(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysObjectStopOnce(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysClassOwnsKnownObjects(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysStoppedHasNoPublication(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysPublicationIdentitiesValid(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysPendingAttemptsOwned(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysCapturedAttemptsExist(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysDeclarationsMatch(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysAttemptGeneration(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> alwaysFailedTypeHasNoPublication(settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> stepStopIdentityRetained(s, settleObjectStop(s, instanceId, ok, errorId)))
  ensures (inv(s) ==> canSettleObjectStop(s, instanceId, ok, errorId) ==> stepSupersededAggregateKeepsSuccessor(s, "settleObjectStop", settleObjectStop(s, instanceId, ok, errorId)))
{
  if inv(s) && canSettleObjectStop(s, instanceId, ok, errorId) {
    var after := settleObjectStop(s, instanceId, ok, errorId);
    ServiceObjectProjection(s, after);
    ServiceObjectObservationsStable(s, after);
    forall a | a in after.objects
      ensures a.stopCalls >= 0 && a.stopCalls <= 1 && (!a.stopPhase.StopNotRequested? <==> a.stopCalls == 1)
    {
      var i :| 0 <= i < |after.objects| && after.objects[i] == a;
      var prior := s.objects[i];
      assert prior in s.objects;
      if prior.id == instanceId { ServiceObjectLookup(s, instanceId); }
    }
    forall i | 0 <= i < |s.objects| && !s.objects[i].stopPhase.StopNotRequested?
      ensures after.objects[i].id == s.objects[i].id && after.objects[i].stopCalls == 1 &&
        (s.objects[i].stopPhase.StopWaiting? || after.objects[i].stopPhase == s.objects[i].stopPhase)
    {
      var prior := s.objects[i];
      assert prior in s.objects;
      if prior.id == instanceId { ServiceObjectLookup(s, instanceId); }
    }
    ServiceStopReferencePreserved(s, after);
  }
}

lemma ServiceAttemptFilters(s: ServiceInstances)
  ensures alwaysAttemptGeneration(s) ==
    (s.nextAttempt > 0 && forall a :: a in s.attempts ==>
      (a.id > 0 && a.id < s.nextAttempt && a.generation > 0 && a.generation <= serviceClass(s, a.classId).generation &&
        |ProofLib.Filter((other: ServiceAttempt) => (other.id == a.id), s.attempts)| == 1))
{}

lemma ServiceAttemptProjection(s: ServiceInstances, attemptId: int)
  ensures serviceAttempt(s, attemptId) ==
    (var matches := ProofLib.Filter((a: ServiceAttempt) => (a.id == attemptId), s.attempts); if |matches| > 0 then matches[0] else noAttempt)
{}

lemma ServiceClassProjection(s: ServiceInstances, classId: int)
  ensures serviceClass(s, classId) ==
    (var matches := ProofLib.Filter((c: ServiceClassEntry) => (c.id == classId), s.classes); if |matches| > 0 then matches[0] else noClass)
{}

lemma ServiceStartSettlementStructure(s: ServiceInstances, after: ServiceInstances, changedAttempt: int)
  requires inv(s)
  requires s.objects == after.objects && s.nextAttempt == after.nextAttempt
  requires s.published == after.published && s.declarations == after.declarations
  requires s.calls == after.calls && s.aggregates == after.aggregates
  requires |s.classes| == |after.classes| && |s.attempts| == |after.attempts|
  requires forall i :: 0 <= i < |s.classes| ==>
    (s.classes[i].id == after.classes[i].id && s.classes[i].generation == after.classes[i].generation &&
      s.classes[i].registered == after.classes[i].registered && s.classes[i].serviceType == after.classes[i].serviceType &&
      s.classes[i].live == after.classes[i].live && after.classes[i].pending >= 0)
  requires forall i :: 0 <= i < |s.attempts| ==>
    (s.attempts[i].id == after.attempts[i].id && s.attempts[i].classId == after.attempts[i].classId &&
      s.attempts[i].generation == after.attempts[i].generation && s.attempts[i].instance == after.attempts[i].instance)
  requires forall i :: 0 <= i < |s.attempts| && s.attempts[i].id != changedAttempt ==> s.attempts[i].phase == after.attempts[i].phase
  ensures alwaysClassAndObjectIdentities(after) && alwaysPublicationIdentitiesValid(after)
  ensures alwaysDeclarationsMatch(after) && alwaysCapturedAttemptsExist(after) && alwaysAttemptGeneration(after)
{
  ServiceObjectIdentityFilters(s);
  ServiceObjectIdentityFilters(after);
  ServiceAttemptFilters(s);
  ServiceAttemptFilters(after);
  forall c | c in after.classes
    ensures c.id > 0 && c.generation >= 0 && c.pending >= 0 && |ProofLib.Filter((other: ServiceClassEntry) => (other.id == c.id), after.classes)| == 1
  {
    var i :| 0 <= i < |after.classes| && after.classes[i] == c;
    assert s.classes[i] in s.classes;
    ProofLib.FilterLengthPointwise((other: ServiceClassEntry) => (other.id == c.id), (other: ServiceClassEntry) => (other.id == c.id), s.classes, after.classes);
  }
  forall c | c in after.classes
    ensures (c.registered <==> (exists d :: d in after.declarations && d.classId == c.id))
  {
    var i :| 0 <= i < |after.classes| && after.classes[i] == c;
    assert s.classes[i] in s.classes;
  }
  forall d | d in after.declarations
    ensures serviceClass(after, d.classId).registered && serviceClass(after, d.classId).serviceType == d.serviceType
  {
    ServiceStartClassFields(s, after, d.classId);
  }
  forall p | p in after.published
    ensures forall id :: id in p.instances ==> (exists c :: c in after.classes && c.serviceType == p.serviceType && c.live == id)
  {
    forall id | id in p.instances ensures (exists c :: c in after.classes && c.serviceType == p.serviceType && c.live == id)
    {
      var i :| 0 <= i < |s.classes| && s.classes[i].serviceType == p.serviceType && s.classes[i].live == id;
      assert after.classes[i] in after.classes;
    }
  }
  forall a | a in after.attempts
    ensures a.id > 0 && a.id < after.nextAttempt && a.generation > 0 && a.generation <= serviceClass(after, a.classId).generation &&
      |ProofLib.Filter((other: ServiceAttempt) => (other.id == a.id), after.attempts)| == 1 &&
      (a.instance == 0 || serviceObject(after, a.instance).id == a.instance)
  {
    var i :| 0 <= i < |after.attempts| && after.attempts[i] == a;
    assert s.attempts[i] in s.attempts;
    ProofLib.FilterLengthPointwise((other: ServiceAttempt) => (other.id == a.id), (other: ServiceAttempt) => (other.id == a.id), s.attempts, after.attempts);
    ServiceStartClassFields(s, after, a.classId);
  }
  forall c | c in after.calls
    ensures (forall id :: id in c.attempts ==> id > 0 && serviceAttempt(after, id).id == id)
  {
    forall id | id in c.attempts ensures id > 0 && serviceAttempt(after, id).id == id
    {
      ServiceStartAttemptFields(s, after, id, changedAttempt);
    }
  }
  forall a | a in after.aggregates
    ensures (forall m :: m in a.members && m.attemptId != 0 ==> serviceAttempt(after, m.attemptId).id == m.attemptId)
  {
    forall m | m in a.members && m.attemptId != 0 ensures serviceAttempt(after, m.attemptId).id == m.attemptId
    {
      ServiceStartAttemptFields(s, after, m.attemptId, changedAttempt);
    }
  }
}

lemma ServiceStartClassFields(s: ServiceInstances, after: ServiceInstances, classId: int)
  requires |s.classes| == |after.classes|
  requires forall i :: 0 <= i < |s.classes| ==>
    (s.classes[i].id == after.classes[i].id && s.classes[i].generation == after.classes[i].generation &&
      s.classes[i].registered == after.classes[i].registered && s.classes[i].serviceType == after.classes[i].serviceType)
  ensures serviceClass(s, classId).generation == serviceClass(after, classId).generation
  ensures serviceClass(s, classId).registered == serviceClass(after, classId).registered
  ensures serviceClass(s, classId).serviceType == serviceClass(after, classId).serviceType
{
  ServiceClassProjection(s, classId);
  ServiceClassProjection(after, classId);
  ProofLib.FilterPointwise(
    (c: ServiceClassEntry) => (c.id == classId),
    (c: ServiceClassEntry) => (c.id == classId),
    (p: ServiceClassEntry, q: ServiceClassEntry) => p.generation == q.generation && p.registered == q.registered && p.serviceType == q.serviceType,
    s.classes, after.classes);
}

lemma ServiceStartAttemptFields(s: ServiceInstances, after: ServiceInstances, attemptId: int, changedAttempt: int)
  requires |s.attempts| == |after.attempts|
  requires forall i :: 0 <= i < |s.attempts| ==>
    (s.attempts[i].id == after.attempts[i].id && s.attempts[i].classId == after.attempts[i].classId &&
      s.attempts[i].generation == after.attempts[i].generation)
  requires forall i :: 0 <= i < |s.attempts| && s.attempts[i].id != changedAttempt ==> s.attempts[i].phase == after.attempts[i].phase
  ensures serviceAttempt(s, attemptId).id == serviceAttempt(after, attemptId).id
  ensures serviceAttempt(s, attemptId).classId == serviceAttempt(after, attemptId).classId
  ensures serviceAttempt(s, attemptId).generation == serviceAttempt(after, attemptId).generation
  ensures attemptId != changedAttempt ==> serviceAttempt(s, attemptId).phase == serviceAttempt(after, attemptId).phase
{
  ServiceAttemptProjection(s, attemptId);
  ServiceAttemptProjection(after, attemptId);
  ProofLib.FilterPointwise(
    (a: ServiceAttempt) => (a.id == attemptId),
    (a: ServiceAttempt) => (a.id == attemptId),
    (p: ServiceAttempt, q: ServiceAttempt) => p.id == q.id && p.classId == q.classId && p.generation == q.generation &&
      (p.id != changedAttempt ==> p.phase == q.phase),
    s.attempts, after.attempts);
  var selected := ProofLib.Filter((a: ServiceAttempt) => (a.id == attemptId), s.attempts);
  if |selected| > 0 {
    ProofLib.FilterMember((a: ServiceAttempt) => (a.id == attemptId), s.attempts, selected[0]);
  }
}

lemma ServicePendingSettlement(s: ServiceInstances, after: ServiceInstances, attemptId: int)
  requires alwaysPendingAttemptsOwned(s)
  requires |s.classes| == |after.classes| && |s.attempts| == |after.attempts|
  requires forall i :: 0 <= i < |s.attempts| ==>
    (s.attempts[i].id == after.attempts[i].id && s.attempts[i].classId == after.attempts[i].classId &&
      s.attempts[i].generation == after.attempts[i].generation &&
      (s.attempts[i].id != attemptId ==> s.attempts[i].phase == after.attempts[i].phase))
  requires forall i :: 0 <= i < |s.classes| ==>
    (s.classes[i].id == after.classes[i].id && s.classes[i].generation == after.classes[i].generation &&
      after.classes[i].pending == (if s.classes[i].pending == attemptId && s.classes[i].id == serviceAttempt(s, attemptId).classId then 0 else s.classes[i].pending))
  ensures alwaysPendingAttemptsOwned(after)
{
  forall c | c in after.classes && c.pending != 0
    ensures (serviceAttempt(after, c.pending).classId == c.id &&
      serviceAttempt(after, c.pending).generation == c.generation &&
      (serviceAttempt(after, c.pending).phase.StartInvoking? || serviceAttempt(after, c.pending).phase.StartObserver? || serviceAttempt(after, c.pending).phase.StartLateStop?))
  {
    var i :| 0 <= i < |after.classes| && after.classes[i] == c;
    var prior := s.classes[i];
    assert prior in s.classes && prior.pending == c.pending;
    assert serviceAttempt(s, prior.pending).classId == prior.id;
    assert c.pending != attemptId;
    ServiceStartAttemptFields(s, after, c.pending, attemptId);
  }
}

lemma failStart_ensures(s: ServiceInstances, attemptId: int, errorId: string)
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysTypeEntriesUnique(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysAggregateAndLoadIdsUnique(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysAcquisitionIdsUnique(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysInitWaitingHasNoAggregate(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysTypeReferencesRetained(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysClassAndObjectIdentities(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysObjectStopOnce(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysClassOwnsKnownObjects(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysStoppedHasNoPublication(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysPublicationIdentitiesValid(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysPendingAttemptsOwned(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysCapturedAttemptsExist(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysDeclarationsMatch(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysAttemptGeneration(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> alwaysFailedTypeHasNoPublication(failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> stepStopIdentityRetained(s, failStart(s, attemptId, errorId)))
  ensures (inv(s) ==> canFailStart(s, attemptId, errorId) ==> stepSupersededAggregateKeepsSuccessor(s, "failStart", failStart(s, attemptId, errorId)))
{
  if inv(s) && canFailStart(s, attemptId, errorId) {
    var after := failStart(s, attemptId, errorId);
    ServiceStartSettlementStructure(s, after, attemptId);
    ServicePendingSettlement(s, after, attemptId);
  }
}

lemma finishObserver_ensures(s: ServiceInstances, attemptId: int, ok: bool)
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysTypeEntriesUnique(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysAggregateAndLoadIdsUnique(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysAcquisitionIdsUnique(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysInitWaitingHasNoAggregate(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysTypeReferencesRetained(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysClassAndObjectIdentities(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysObjectStopOnce(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysClassOwnsKnownObjects(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysStoppedHasNoPublication(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysPublicationIdentitiesValid(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysPendingAttemptsOwned(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysCapturedAttemptsExist(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysDeclarationsMatch(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysAttemptGeneration(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> alwaysFailedTypeHasNoPublication(finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> stepStopIdentityRetained(s, finishObserver(s, attemptId, ok)))
  ensures (inv(s) ==> canFinishObserver(s, attemptId, ok) ==> stepSupersededAggregateKeepsSuccessor(s, "finishObserver", finishObserver(s, attemptId, ok)))
{
  if inv(s) && canFinishObserver(s, attemptId, ok) {
    var after := finishObserver(s, attemptId, ok);
    ServiceStartSettlementStructure(s, after, attemptId);
    ServicePendingSettlement(s, after, attemptId);
  }
}

lemma finishLateStart_ensures(s: ServiceInstances, attemptId: int)
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysTypeEntriesUnique(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysAggregateAndLoadIdsUnique(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysAcquisitionIdsUnique(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysInitWaitingHasNoAggregate(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysTypeReferencesRetained(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysClassAndObjectIdentities(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysObjectStopOnce(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysClassOwnsKnownObjects(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysStoppedHasNoPublication(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysPublicationIdentitiesValid(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysPendingAttemptsOwned(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysCapturedAttemptsExist(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysDeclarationsMatch(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysAttemptGeneration(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> alwaysFailedTypeHasNoPublication(finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> stepStopIdentityRetained(s, finishLateStart(s, attemptId)))
  ensures (inv(s) ==> canFinishLateStart(s, attemptId) ==> stepSupersededAggregateKeepsSuccessor(s, "finishLateStart", finishLateStart(s, attemptId)))
{
  if inv(s) && canFinishLateStart(s, attemptId) {
    var after := finishLateStart(s, attemptId);
    ServiceStartSettlementStructure(s, after, attemptId);
    ServicePendingSettlement(s, after, attemptId);
  }
}

lemma finishNextObserver_ensures(s: ServiceInstances, ok: bool)
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysTypeEntriesUnique(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysAggregateAndLoadIdsUnique(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysAcquisitionIdsUnique(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysInitWaitingHasNoAggregate(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysTypeReferencesRetained(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysClassAndObjectIdentities(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysObjectStopOnce(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysClassOwnsKnownObjects(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysStoppedHasNoPublication(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysPublicationIdentitiesValid(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysPendingAttemptsOwned(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysCapturedAttemptsExist(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysDeclarationsMatch(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysAttemptGeneration(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> alwaysFailedTypeHasNoPublication(finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> stepStopIdentityRetained(s, finishNextObserver(s, ok)))
  ensures (inv(s) ==> canFinishNextObserver(s, ok) ==> stepSupersededAggregateKeepsSuccessor(s, "finishNextObserver", finishNextObserver(s, ok)))
{
  if inv(s) && canFinishNextObserver(s, ok) {
    finishObserver_ensures(s, nextObservableAttempt(s), ok);
  }
}

lemma finishNextLateStart_ensures(s: ServiceInstances)
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysTypeEntriesUnique(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysAggregateAndLoadIdsUnique(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysAcquisitionIdsUnique(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysInitWaitingHasNoAggregate(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysTypeReferencesRetained(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysClassAndObjectIdentities(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysObjectStopOnce(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysClassOwnsKnownObjects(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysStoppedHasNoPublication(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysPublicationIdentitiesValid(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysPendingAttemptsOwned(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysCapturedAttemptsExist(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysDeclarationsMatch(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysAttemptGeneration(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> alwaysFailedTypeHasNoPublication(finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> stepStopIdentityRetained(s, finishNextLateStart(s)))
  ensures (inv(s) ==> canFinishNextLateStart(s) ==> stepSupersededAggregateKeepsSuccessor(s, "finishNextLateStart", finishNextLateStart(s)))
{
  if inv(s) && canFinishNextLateStart(s) {
    finishLateStart_ensures(s, nextRetiredAttempt(s));
  }
}

lemma ServicePromiseIdentityFilters(s: ServiceInstances)
  ensures alwaysAggregateAndLoadIdsUnique(s) ==
    (s.nextLoad > 0 &&
      (forall p :: p in s.loadPromises ==> (p.id > 0 && p.id < s.nextLoad && |ProofLib.Filter((other: LoadPromise) => (other.id == p.id), s.loadPromises)| == 1)) &&
      (forall a :: a in s.aggregates ==> (a.id > 0 && |ProofLib.Filter((other: TypeAggregate) => (other.id == a.id), s.aggregates)| == 1)))
  ensures alwaysAcquisitionIdsUnique(s) ==
    (forall c :: c in s.calls ==> (c.id > 0 && |ProofLib.Filter((other: Acquire) => (other.id == c.id), s.calls)| == 1))
  ensures alwaysTypeEntriesUnique(s) ==
    (forall e :: e in s.typeEntries ==> |ProofLib.Filter((other: TypeEntry) => (other.serviceType == e.serviceType), s.typeEntries)| == 1)
{}

lemma ServiceMapLoadIdentities(s: ServiceInstances, after: ServiceInstances)
  requires alwaysAggregateAndLoadIdsUnique(s)
  requires after.nextLoad == s.nextLoad && after.aggregates == s.aggregates
  requires |s.loadPromises| == |after.loadPromises|
  requires forall i :: 0 <= i < |s.loadPromises| ==> s.loadPromises[i].id == after.loadPromises[i].id
  ensures alwaysAggregateAndLoadIdsUnique(after)
{
  ServicePromiseIdentityFilters(s);
  ServicePromiseIdentityFilters(after);
  forall p | p in after.loadPromises
    ensures (p.id > 0 && p.id < after.nextLoad && |ProofLib.Filter((other: LoadPromise) => (other.id == p.id), after.loadPromises)| == 1)
  {
    var i :| 0 <= i < |after.loadPromises| && after.loadPromises[i] == p;
    assert s.loadPromises[i] in s.loadPromises;
    ProofLib.FilterLengthPointwise((other: LoadPromise) => (other.id == p.id), (other: LoadPromise) => (other.id == p.id), s.loadPromises, after.loadPromises);
  }
}

lemma ServiceMapAggregateIdentities(s: ServiceInstances, after: ServiceInstances)
  requires alwaysAggregateAndLoadIdsUnique(s)
  requires after.nextLoad == s.nextLoad && after.loadPromises == s.loadPromises
  requires |s.aggregates| == |after.aggregates|
  requires forall i :: 0 <= i < |s.aggregates| ==> s.aggregates[i].id == after.aggregates[i].id
  ensures alwaysAggregateAndLoadIdsUnique(after)
{
  ServicePromiseIdentityFilters(s);
  ServicePromiseIdentityFilters(after);
  forall a | a in after.aggregates
    ensures a.id > 0 && |ProofLib.Filter((other: TypeAggregate) => (other.id == a.id), after.aggregates)| == 1
  {
    var i :| 0 <= i < |after.aggregates| && after.aggregates[i] == a;
    assert s.aggregates[i] in s.aggregates;
    ProofLib.FilterLengthPointwise((other: TypeAggregate) => (other.id == a.id), (other: TypeAggregate) => (other.id == a.id), s.aggregates, after.aggregates);
  }
}

lemma ServiceMapAcquireIdentities(s: ServiceInstances, after: ServiceInstances)
  requires alwaysAcquisitionIdsUnique(s)
  requires |s.calls| == |after.calls|
  requires forall i :: 0 <= i < |s.calls| ==> s.calls[i].id == after.calls[i].id
  ensures alwaysAcquisitionIdsUnique(after)
{
  ServicePromiseIdentityFilters(s);
  ServicePromiseIdentityFilters(after);
  forall c | c in after.calls
    ensures c.id > 0 && |ProofLib.Filter((other: Acquire) => (other.id == c.id), after.calls)| == 1
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == c;
    assert s.calls[i] in s.calls;
    ProofLib.FilterLengthPointwise((other: Acquire) => (other.id == c.id), (other: Acquire) => (other.id == c.id), s.calls, after.calls);
  }
}

lemma ServiceMapTypeIdentities(s: ServiceInstances, after: ServiceInstances)
  requires alwaysTypeEntriesUnique(s)
  requires |s.typeEntries| == |after.typeEntries|
  requires forall i :: 0 <= i < |s.typeEntries| ==> s.typeEntries[i].serviceType == after.typeEntries[i].serviceType
  ensures alwaysTypeEntriesUnique(after)
{
  ServicePromiseIdentityFilters(s);
  ServicePromiseIdentityFilters(after);
  forall e | e in after.typeEntries
    ensures |ProofLib.Filter((other: TypeEntry) => (other.serviceType == e.serviceType), after.typeEntries)| == 1
  {
    var i :| 0 <= i < |after.typeEntries| && after.typeEntries[i] == e;
    assert s.typeEntries[i] in s.typeEntries;
    ProofLib.FilterLengthPointwise((other: TypeEntry) => (other.serviceType == e.serviceType), (other: TypeEntry) => (other.serviceType == e.serviceType), s.typeEntries, after.typeEntries);
  }
}

lemma ServiceClearUpdatesOnlyTypeMetadata(s: ServiceInstances, callId: int)
  ensures clearTypeAggregate(s, callId).(typeEntries := s.typeEntries) == s
  ensures |clearTypeAggregate(s, callId).typeEntries| == |s.typeEntries|
  ensures forall i :: 0 <= i < |s.typeEntries| ==>
    clearTypeAggregate(s, callId).typeEntries[i] ==
      (if s.typeEntries[i].latestAggregate == callId then s.typeEntries[i].(latestAggregate := 0) else s.typeEntries[i])
{}

lemma ServiceClearPreservesFailedStatus(s: ServiceInstances, callId: int)
  requires alwaysFailedTypeHasNoPublication(s)
  ensures alwaysFailedTypeHasNoPublication(clearTypeAggregate(s, callId))
{
  var after := clearTypeAggregate(s, callId);
  ServiceClearUpdatesOnlyTypeMetadata(s, callId);
  forall e | e in after.typeEntries && e.status.TypeFailed?
    ensures firstLive(after, e.serviceType) == 0
  {
    var i :| 0 <= i < |after.typeEntries| && after.typeEntries[i] == e;
    var origin := s.typeEntries[i];
    assert origin in s.typeEntries && origin.status == e.status && origin.serviceType == e.serviceType;
  }
}

lemma clearTypeAggregate_ensures(s: ServiceInstances, callId: int)
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysTypeEntriesUnique(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysAggregateAndLoadIdsUnique(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysAcquisitionIdsUnique(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysInitWaitingHasNoAggregate(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysTypeReferencesRetained(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysClassAndObjectIdentities(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysObjectStopOnce(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysClassOwnsKnownObjects(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysStoppedHasNoPublication(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysPublicationIdentitiesValid(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysPendingAttemptsOwned(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysCapturedAttemptsExist(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysDeclarationsMatch(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysAttemptGeneration(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> alwaysFailedTypeHasNoPublication(clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> stepStopIdentityRetained(s, clearTypeAggregate(s, callId)))
  ensures (inv(s) ==> canClearTypeAggregate(s, callId) ==> stepSupersededAggregateKeepsSuccessor(s, "clearTypeAggregate", clearTypeAggregate(s, callId)))
{
  if inv(s) && canClearTypeAggregate(s, callId) {
    var after := clearTypeAggregate(s, callId);
    ServiceClearUpdatesOnlyTypeMetadata(s, callId);
    ServiceMapTypeIdentities(s, after);
    ServiceClearAggregateOwnership(s, after, callId);
    ServiceStopReferencePreserved(s, after);
    ServiceClearPreservesFailedStatus(s, callId);
  }
}

lemma settleTypeAggregate_ensures(s: ServiceInstances, callId: int)
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysTypeEntriesUnique(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysAggregateAndLoadIdsUnique(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysAcquisitionIdsUnique(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysInitWaitingHasNoAggregate(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysTypeReferencesRetained(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysClassAndObjectIdentities(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysObjectStopOnce(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysClassOwnsKnownObjects(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysStoppedHasNoPublication(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysPublicationIdentitiesValid(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysPendingAttemptsOwned(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysCapturedAttemptsExist(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysDeclarationsMatch(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysAttemptGeneration(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> alwaysFailedTypeHasNoPublication(settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> stepStopIdentityRetained(s, settleTypeAggregate(s, callId)))
  ensures (inv(s) ==> canSettleTypeAggregate(s, callId) ==> stepSupersededAggregateKeepsSuccessor(s, "settleTypeAggregate", settleTypeAggregate(s, callId)))
{
  if inv(s) && canSettleTypeAggregate(s, callId) {
    var after := settleTypeAggregate(s, callId);
    ServiceMapAggregateIdentities(s, after);
    forall e | e in s.typeEntries && e.latestAggregate != 0
      ensures (exists a :: a in after.aggregates && a.id == e.latestAggregate && a.serviceType == e.serviceType)
    {
      var i :| 0 <= i < |s.aggregates| && s.aggregates[i].id == e.latestAggregate && s.aggregates[i].serviceType == e.serviceType;
      assert after.aggregates[i] in after.aggregates;
    }
  }
}

lemma settleAcquire_ensures(s: ServiceInstances, callId: int)
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> alwaysTypeEntriesUnique(settleAcquire(s, callId)))
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> alwaysAggregateAndLoadIdsUnique(settleAcquire(s, callId)))
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> alwaysAcquisitionIdsUnique(settleAcquire(s, callId)))
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> alwaysInitWaitingHasNoAggregate(settleAcquire(s, callId)))
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> alwaysTypeReferencesRetained(settleAcquire(s, callId)))
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> alwaysClassAndObjectIdentities(settleAcquire(s, callId)))
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> alwaysObjectStopOnce(settleAcquire(s, callId)))
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> alwaysClassOwnsKnownObjects(settleAcquire(s, callId)))
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> alwaysStoppedHasNoPublication(settleAcquire(s, callId)))
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> alwaysPublicationIdentitiesValid(settleAcquire(s, callId)))
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> alwaysPendingAttemptsOwned(settleAcquire(s, callId)))
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> alwaysCapturedAttemptsExist(settleAcquire(s, callId)))
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> alwaysDeclarationsMatch(settleAcquire(s, callId)))
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> alwaysAttemptGeneration(settleAcquire(s, callId)))
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> alwaysFailedTypeHasNoPublication(settleAcquire(s, callId)))
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> stepStopIdentityRetained(s, settleAcquire(s, callId)))
  ensures (inv(s) ==> canSettleAcquire(s, callId) ==> stepSupersededAggregateKeepsSuccessor(s, "settleAcquire", settleAcquire(s, callId)))
{
  if inv(s) && canSettleAcquire(s, callId) {
    var after := settleAcquire(s, callId);
    var serviceType := acquireCall(s, callId).serviceType;
    var entry := serviceTypeEntry(s, serviceType);
    var result := firstLive(s, serviceType);
    var classesRemain := exists d :: d in s.declarations && d.serviceType == serviceType;
    var disposition := if result != 0 then TypeStatus.TypeRegistered else if classesRemain then TypeStatus.TypeFailed else TypeStatus.TypeUnknown;
    var updated := entry.(serviceType := serviceType, status := disposition,
      promiseId := if result == 0 && entry.handlerId != 0 then 0 else entry.promiseId, handlerId := 0);
    var callView := after.(typeEntries := s.typeEntries);
    assert after == putType(updated, callView);
    ServiceMapAcquireIdentities(s, after);
    ServiceMapLoadIdentities(s, after);
    ServiceTypeEntryLookup(s, serviceType);
    ServiceTypeEntryPut(callView, updated);
    ServiceSettledTypeReferences(s, after, entry, updated, serviceType);
  }
}

lemma ServiceTypeEntryProjection(s: ServiceInstances, serviceType: string)
  ensures serviceTypeEntry(s, serviceType) ==
    (var matches := ProofLib.Filter((e: TypeEntry) => e.serviceType == serviceType, s.typeEntries);
      if |matches| > 0 then matches[0] else noTypeEntry)
{}

lemma ServiceTypeEntryLookup(s: ServiceInstances, serviceType: string)
  requires alwaysTypeEntriesUnique(s)
  ensures forall e :: e in s.typeEntries && e.serviceType == serviceType ==> serviceTypeEntry(s, serviceType) == e
  ensures (serviceTypeEntry(s, serviceType) in s.typeEntries && serviceTypeEntry(s, serviceType).serviceType == serviceType) ||
    (serviceTypeEntry(s, serviceType) == noTypeEntry && (forall e :: e in s.typeEntries ==> e.serviceType != serviceType))
{
  ServicePromiseIdentityFilters(s);
  ServiceTypeEntryProjection(s, serviceType);
  var byType := (e: TypeEntry) => e.serviceType == serviceType;
  var matches := ProofLib.Filter(byType, s.typeEntries);
  if |matches| == 0 {
    forall e | e in s.typeEntries ensures e.serviceType != serviceType {
      ProofLib.FilterMember(byType, s.typeEntries, e);
    }
  } else {
    var chosen := matches[0];
    ProofLib.FilterMember(byType, s.typeEntries, chosen);
    assert chosen in s.typeEntries && chosen.serviceType == serviceType;
    ProofLib.FilterSamePredicate(byType, (e: TypeEntry) => e.serviceType == chosen.serviceType, s.typeEntries);
    assert |matches| == 1;
    forall e | e in s.typeEntries && e.serviceType == serviceType ensures e == chosen {
      ProofLib.FilterMember(byType, s.typeEntries, e);
    }
  }
}

lemma ServiceTypeEntryPut(s: ServiceInstances, entry: TypeEntry)
  requires alwaysTypeEntriesUnique(s)
  ensures alwaysTypeEntriesUnique(putType(entry, s))
  ensures forall e :: e in putType(entry, s).typeEntries ==>
    e == entry || (e in s.typeEntries && e.serviceType != entry.serviceType)
{
  var after := putType(entry, s);
  if exists e :: e in s.typeEntries && e.serviceType == entry.serviceType {
    ServiceMapTypeIdentities(s, after);
    forall e | e in after.typeEntries
      ensures e == entry || (e in s.typeEntries && e.serviceType != entry.serviceType)
    {
      var i :| 0 <= i < |after.typeEntries| && after.typeEntries[i] == e;
      var origin := s.typeEntries[i];
      assert origin in s.typeEntries;
      assert e == (if origin.serviceType == entry.serviceType then entry else origin);
    }
  } else {
    assert after.typeEntries == s.typeEntries + [entry];
    ServicePromiseIdentityFilters(s);
    ServicePromiseIdentityFilters(after);
    forall e | e in after.typeEntries
      ensures |ProofLib.Filter((p: TypeEntry) => p.serviceType == e.serviceType, after.typeEntries)| == 1
      ensures e == entry || (e in s.typeEntries && e.serviceType != entry.serviceType)
    {
      var byType := (p: TypeEntry) => p.serviceType == e.serviceType;
      ProofLib.FilterAppend(byType, s.typeEntries, entry);
      if e == entry {
        ProofLib.FilterNone(byType, s.typeEntries);
      } else {
        assert e in s.typeEntries && e.serviceType != entry.serviceType;
      }
    }
  }
}

lemma ServiceSameLoadType(s: ServiceInstances, first: LoadPromise, second: LoadPromise)
  requires alwaysAggregateAndLoadIdsUnique(s)
  requires first in s.loadPromises && second in s.loadPromises && first.id == second.id
  ensures first == second
{
  ServicePromiseIdentityFilters(s);
  var byId := (p: LoadPromise) => p.id == first.id;
  var matches := ProofLib.Filter(byId, s.loadPromises);
  ProofLib.FilterMember(byId, s.loadPromises, first);
  ProofLib.FilterMember(byId, s.loadPromises, second);
  assert |matches| == 1 && matches[0] == first == second;
}

lemma ServiceStopWorkProjection(before: ServiceInstances, after: ServiceInstances)
  requires inv(before)
  requires after.(objects := before.objects) == before
  requires |before.objects| == |after.objects|
  requires forall i :: 0 <= i < |before.objects| ==>
    (after.objects[i].id == before.objects[i].id &&
      (after.objects[i] == before.objects[i] ||
       (before.objects[i].stopPhase.StopNotRequested? && after.objects[i] == before.objects[i].(stopPhase := StopPhase.StopWaiting, stopCalls := 1))))
  ensures alwaysClassAndObjectIdentities(after)
  ensures alwaysObjectStopOnce(after)
  ensures stepStopIdentityRetained(before, after)
  ensures alwaysCapturedAttemptsExist(after) && alwaysClassOwnsKnownObjects(after)
{
  ServiceObjectProjection(before, after);
  ServiceStopReferencePreserved(before, after);
  if alwaysObjectStopOnce(before) {
    forall o | o in after.objects
      ensures 0 <= o.stopCalls <= 1 && (!o.stopPhase.StopNotRequested? <==> o.stopCalls == 1)
    {
      var i :| 0 <= i < |after.objects| && after.objects[i] == o;
      assert before.objects[i] in before.objects;
    }
  }
  ServiceObjectObservationsStable(before, after);
}

lemma ServiceStopWorkComposes(before: ServiceInstances, middle: ServiceInstances, after: ServiceInstances)
  requires middle.(objects := before.objects) == before && after.(objects := middle.objects) == middle
  requires |before.objects| == |middle.objects| == |after.objects|
  requires forall i :: 0 <= i < |before.objects| ==>
    (middle.objects[i].id == before.objects[i].id &&
      (middle.objects[i] == before.objects[i] ||
       (before.objects[i].stopPhase.StopNotRequested? && middle.objects[i] == before.objects[i].(stopPhase := StopPhase.StopWaiting, stopCalls := 1))))
  requires forall i :: 0 <= i < |middle.objects| ==>
    (after.objects[i].id == middle.objects[i].id &&
      (after.objects[i] == middle.objects[i] ||
       (middle.objects[i].stopPhase.StopNotRequested? && after.objects[i] == middle.objects[i].(stopPhase := StopPhase.StopWaiting, stopCalls := 1))))
  ensures after.(objects := before.objects) == before
  ensures |before.objects| == |after.objects|
  ensures forall i :: 0 <= i < |before.objects| ==>
    (after.objects[i].id == before.objects[i].id &&
      (after.objects[i] == before.objects[i] ||
       (before.objects[i].stopPhase.StopNotRequested? && after.objects[i] == before.objects[i].(stopPhase := StopPhase.StopWaiting, stopCalls := 1))))
{
  forall i | 0 <= i < |before.objects|
    ensures after.objects[i].id == before.objects[i].id &&
      (after.objects[i] == before.objects[i] ||
       (before.objects[i].stopPhase.StopNotRequested? && after.objects[i] == before.objects[i].(stopPhase := StopPhase.StopWaiting, stopCalls := 1)))
  {
    if middle.objects[i] != before.objects[i] {
      assert middle.objects[i].stopPhase.StopWaiting? && after.objects[i] == middle.objects[i];
    }
  }
}

lemma ServiceStopObjectFold(items: seq<int>, s: ServiceInstances)
  ensures (var after := Std.Collections.Seq.FoldLeft((acc: ServiceInstances, id: int) => stopObjectOnce(id, acc), s, items);
    after.(objects := s.objects) == s && |after.objects| == |s.objects| &&
    (forall i :: 0 <= i < |s.objects| ==>
      (after.objects[i].id == s.objects[i].id &&
       (after.objects[i] == s.objects[i] ||
          (s.objects[i].stopPhase.StopNotRequested? && after.objects[i] == s.objects[i].(stopPhase := StopPhase.StopWaiting, stopCalls := 1))))))
  decreases |items|
{
  if |items| > 0 {
    var prefix := items[..|items|-1];
    var last := items[|items|-1];
    var stop := (acc: ServiceInstances, id: int) => stopObjectOnce(id, acc);
    assert items == prefix + [last];
    ServiceStopObjectFold(prefix, s);
    ProofLib.FoldLeftAppend(stop, s, prefix, last);
    var middle := Std.Collections.Seq.FoldLeft(stop, s, prefix);
    ServiceStopWorkComposes(s, middle, stopObjectOnce(last, middle));
  }
}

lemma ServiceStopPublicationFold(items: seq<ServicePublication>, s: ServiceInstances)
  ensures (var after := Std.Collections.Seq.FoldLeft((acc: ServiceInstances, p: ServicePublication) => stopPublishedType(p, acc), s, items);
    after.(objects := s.objects) == s && |after.objects| == |s.objects| &&
    (forall i :: 0 <= i < |s.objects| ==>
      (after.objects[i].id == s.objects[i].id &&
       (after.objects[i] == s.objects[i] ||
          (s.objects[i].stopPhase.StopNotRequested? && after.objects[i] == s.objects[i].(stopPhase := StopPhase.StopWaiting, stopCalls := 1))))))
  decreases |items|
{
  if |items| > 0 {
    var prefix := items[..|items|-1];
    var last := items[|items|-1];
    var stop := (acc: ServiceInstances, p: ServicePublication) => stopPublishedType(p, acc);
    assert items == prefix + [last];
    ServiceStopPublicationFold(prefix, s);
    ProofLib.FoldLeftAppend(stop, s, prefix, last);
    var middle := Std.Collections.Seq.FoldLeft(stop, s, prefix);
    ServiceStopObjectFold(last.instances, middle);
    ServiceStopWorkComposes(s, middle, stopPublishedType(last, middle));
  }
}

lemma stopRuntime_ensures(s: ServiceInstances)
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysTypeEntriesUnique(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysAggregateAndLoadIdsUnique(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysAcquisitionIdsUnique(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysInitWaitingHasNoAggregate(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysTypeReferencesRetained(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysClassAndObjectIdentities(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysObjectStopOnce(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysClassOwnsKnownObjects(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysStoppedHasNoPublication(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysPublicationIdentitiesValid(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysPendingAttemptsOwned(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysCapturedAttemptsExist(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysDeclarationsMatch(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysAttemptGeneration(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> alwaysFailedTypeHasNoPublication(stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> stepStopIdentityRetained(s, stopRuntime(s)))
  ensures (inv(s) ==> canStopRuntime(s) ==> stepSupersededAggregateKeepsSuccessor(s, "stopRuntime", stopRuntime(s)))
{
  if inv(s) && canStopRuntime(s) {
    ServiceStopPublicationFold(s.published, s);
    var stop := (acc: ServiceInstances, p: ServicePublication) => stopPublishedType(p, acc);
    var stopped := Std.Collections.Seq.FoldLeft(stop, s, s.published);
    ServiceStopWorkProjection(s, stopped);
    var after := stopRuntime(s);
    assert after.objects == stopped.objects && after.attempts == s.attempts;
    assert after.calls == s.calls && after.aggregates == s.aggregates && after.declarations == s.declarations;
    ServiceMapTypeIdentities(s, after);
    ServiceMapLoadIdentities(s, after);
    ServiceClassMapIncarnations(stopped, after);
  }
}

lemma ServiceClassMapIncarnations(before: ServiceInstances, after: ServiceInstances)
  requires alwaysClassAndObjectIdentities(before)
  requires |before.classes| == |after.classes| && before.objects == after.objects
  requires before.declarations == after.declarations && before.attempts == after.attempts && before.nextAttempt == after.nextAttempt
  requires forall i :: 0 <= i < |before.classes| ==>
    (before.classes[i].id == after.classes[i].id && before.classes[i].serviceType == after.classes[i].serviceType &&
      before.classes[i].generation == after.classes[i].generation && before.classes[i].registered == after.classes[i].registered && after.classes[i].pending >= 0)
  ensures alwaysClassAndObjectIdentities(after)
  ensures alwaysDeclarationsMatch(before) ==> alwaysDeclarationsMatch(after)
  ensures alwaysAttemptGeneration(before) ==> alwaysAttemptGeneration(after)
{
  ServiceObjectIdentityFilters(before);
  ServiceObjectIdentityFilters(after);
  forall cls | cls in after.classes
    ensures cls.id > 0 && cls.generation >= 0 && cls.pending >= 0 && |ProofLib.Filter((other: ServiceClassEntry) => other.id == cls.id, after.classes)| == 1
    ensures alwaysDeclarationsMatch(before) ==> (cls.registered <==> (exists d :: d in after.declarations && d.classId == cls.id))
  {
    var i :| 0 <= i < |after.classes| && after.classes[i] == cls;
    assert before.classes[i] in before.classes;
    var byId := (other: ServiceClassEntry) => other.id == cls.id;
    ProofLib.FilterLengthPointwise(byId, byId, before.classes, after.classes);
  }
  if alwaysDeclarationsMatch(before) {
    forall d | d in after.declarations
      ensures serviceClass(after, d.classId).registered && serviceClass(after, d.classId).serviceType == d.serviceType
    {
      var origin := serviceClass(before, d.classId);
      ServiceMappedClassLookup(before, after, d.classId);
    }
  }
  if alwaysAttemptGeneration(before) {
    forall a | a in after.attempts ensures a.generation <= serviceClass(after, a.classId).generation {
      ServiceMappedClassLookup(before, after, a.classId);
    }
  }
}

lemma ServiceMappedClassLookup(before: ServiceInstances, after: ServiceInstances, classId: int)
  requires |before.classes| == |after.classes|
  requires forall i :: 0 <= i < |before.classes| ==>
    (before.classes[i].id == after.classes[i].id && before.classes[i].serviceType == after.classes[i].serviceType &&
      before.classes[i].generation == after.classes[i].generation && before.classes[i].registered == after.classes[i].registered)
  ensures serviceClass(before, classId).serviceType == serviceClass(after, classId).serviceType
  ensures serviceClass(before, classId).generation == serviceClass(after, classId).generation
  ensures serviceClass(before, classId).registered == serviceClass(after, classId).registered
{
  ServiceClassProjection(before, classId);
  ServiceClassProjection(after, classId);
  var byId := (cls: ServiceClassEntry) => cls.id == classId;
  ProofLib.FilterPointwise(byId, byId, (a: ServiceClassEntry, b: ServiceClassEntry) =>
    a.serviceType == b.serviceType && a.generation == b.generation && a.registered == b.registered, before.classes, after.classes);
}

lemma ServiceClassFind(s: ServiceInstances, classId: int)
  requires alwaysClassAndObjectIdentities(s)
  ensures forall c :: c in s.classes && c.id == classId ==> serviceClass(s, classId) == c
{
  ServiceObjectIdentityFilters(s);
  ServiceClassProjection(s, classId);
  var byId := (c: ServiceClassEntry) => c.id == classId;
  var matches := ProofLib.Filter(byId, s.classes);
  forall c | c in s.classes && c.id == classId ensures serviceClass(s, classId) == c {
    ProofLib.FilterMember(byId, s.classes, c);
    ProofLib.FilterSamePredicate(byId, (other: ServiceClassEntry) => other.id == c.id, s.classes);
    assert |matches| == 1 && matches[0] == c;
  }
}

lemma ServiceAttemptFound(s: ServiceInstances, wanted: ServiceAttempt)
  requires alwaysAttemptGeneration(s) && wanted in s.attempts
  ensures serviceAttempt(s, wanted.id) == wanted
{
  ServiceAttemptProjection(s, wanted.id);
  ServiceAttemptFilters(s);
  var byId := (a: ServiceAttempt) => a.id == wanted.id;
  var matches := ProofLib.Filter(byId, s.attempts);
  ProofLib.FilterMember(byId, s.attempts, wanted);
  assert |matches| == 1 && matches[0] == wanted;
}

lemma ServiceAttemptPostClass(s: ServiceInstances, after: ServiceInstances, classId: int, query: int)
  requires after == beginClassAttempt(classId, s)
  ensures serviceClass(after, query) ==
    (if query == classId && (exists c :: c in s.classes && c.id == query) then
      serviceClass(s, query).(generation := serviceClass(s, query).generation + 1, pending := s.nextAttempt)
    else serviceClass(s, query))
{
  ServiceClassProjection(s, query);
  ServiceClassProjection(after, query);
  var byId := (c: ServiceClassEntry) => c.id == query;
  var same := (origin: ServiceClassEntry, current: ServiceClassEntry) =>
    current == (if origin.id == classId then origin.(generation := origin.generation + 1, pending := s.nextAttempt) else origin);
  var before := ProofLib.Filter(byId, s.classes);
  var updated := ProofLib.Filter(byId, after.classes);
  ProofLib.FilterPointwise(byId, byId, same, s.classes, after.classes);
  if |before| > 0 {
    ProofLib.FilterMember(byId, s.classes, before[0]);
    assert before[0].id == query && same(before[0], updated[0]);
  } else {
    forall c | c in s.classes ensures c.id != query {
      ProofLib.FilterMember(byId, s.classes, c);
    }
  }
}

lemma ServiceAttemptAppend(s: ServiceInstances, classId: int)
  requires inv(s)
  requires serviceClass(s, classId).id == classId && classId > 0
  ensures inv(beginClassAttempt(classId, s))
  ensures stepStopIdentityRetained(s, beginClassAttempt(classId, s))
{
  var after := beginClassAttempt(classId, s);
  var added := ServiceAttempt(s.nextAttempt, classId, serviceClass(s, classId).generation + 1, AttemptPhase.StartInvoking, 0, "");
  assert after.attempts == s.attempts + [added];
  assert after.objects == s.objects && after.calls == s.calls && after.aggregates == s.aggregates && after.declarations == s.declarations;
  ServiceObjectIdentityFilters(s);
  ServiceObjectIdentityFilters(after);
  forall c | c in after.classes
    ensures c.id > 0 && c.generation >= 0 && c.pending >= 0 && |ProofLib.Filter((other: ServiceClassEntry) => other.id == c.id, after.classes)| == 1
    ensures c.registered <==> (exists d :: d in after.declarations && d.classId == c.id)
    ensures c.live == 0 || (exists o :: o in after.objects && o.id == c.live)
  {
    var i :| 0 <= i < |after.classes| && after.classes[i] == c;
    var origin := s.classes[i];
    assert origin in s.classes;
    var byId := (other: ServiceClassEntry) => other.id == c.id;
    ProofLib.FilterLengthPointwise(byId, byId, s.classes, after.classes);
  }
  ServiceAttemptFilters(s);
  ServiceAttemptFilters(after);
  forall a | a in after.attempts
    ensures a.id > 0 && a.id < after.nextAttempt && a.generation > 0 && a.generation <= serviceClass(after, a.classId).generation &&
      |ProofLib.Filter((other: ServiceAttempt) => other.id == a.id, after.attempts)| == 1
  {
    ServiceAttemptPostClass(s, after, classId, a.classId);
    var byId := (other: ServiceAttempt) => other.id == a.id;
    ProofLib.FilterAppend(byId, s.attempts, added);
    if a == added {
      ServiceClassProjection(s, classId);
      var candidates := ProofLib.Filter((c: ServiceClassEntry) => c.id == classId, s.classes);
      assert |candidates| > 0;
      ProofLib.FilterMember((c: ServiceClassEntry) => c.id == classId, s.classes, candidates[0]);
      assert serviceClass(s, classId).generation >= 0;
      assert added.generation == serviceClass(after, classId).generation;
      ProofLib.FilterNone(byId, s.attempts);
    } else {
      assert a in s.attempts && a.id != added.id;
    }
  }
  forall c | c in after.classes && c.pending > 0
    ensures serviceAttempt(after, c.pending).classId == c.id &&
      serviceAttempt(after, c.pending).generation == c.generation &&
      (serviceAttempt(after, c.pending).phase.StartInvoking? || serviceAttempt(after, c.pending).phase.StartObserver? || serviceAttempt(after, c.pending).phase.StartLateStop?)
  {
    var i :| 0 <= i < |after.classes| && after.classes[i] == c;
    var origin := s.classes[i];
    assert origin in s.classes;
    if c.id == classId {
      ServiceClassFind(s, classId);
      assert serviceClass(s, classId) == origin && c.pending == added.id;
      ServiceAttemptFound(after, added);
    } else {
      assert c == origin;
      ServiceRetainPriorAttempt(s, after, c.pending);
    }
  }
  forall d | d in after.declarations
    ensures serviceClass(after, d.classId).registered && serviceClass(after, d.classId).serviceType == d.serviceType
  {
    ServiceAttemptPostClass(s, after, classId, d.classId);
  }
  forall p | p in after.published
    ensures forall id :: id in p.instances ==> exists c :: c in after.classes && c.serviceType == p.serviceType && c.live == id
  {
    forall id | id in p.instances
      ensures exists c :: c in after.classes && c.serviceType == p.serviceType && c.live == id
    {
      var i :| 0 <= i < |s.classes| && s.classes[i].serviceType == p.serviceType && s.classes[i].live == id;
      assert after.classes[i] in after.classes;
    }
  }
  forall c | c in after.calls
    ensures forall id :: id in c.attempts ==> id > 0 && serviceAttempt(after, id).id == id
  {
    forall id | id in c.attempts ensures id > 0 && serviceAttempt(after, id).id == id {
      ServiceRetainPriorAttempt(s, after, id);
    }
  }
  forall a | a in after.aggregates
    ensures forall m :: m in a.members && m.attemptId != 0 ==> serviceAttempt(after, m.attemptId).id == m.attemptId
  {
    forall m | m in a.members && m.attemptId != 0 ensures serviceAttempt(after, m.attemptId).id == m.attemptId {
      ServiceRetainPriorAttempt(s, after, m.attemptId);
    }
  }
}

lemma ServiceRetainPriorAttempt(s: ServiceInstances, after: ServiceInstances, attemptId: int)
  requires serviceAttempt(s, attemptId).id != 0
  requires |after.attempts| == |s.attempts| + 1 && s.attempts == after.attempts[..|s.attempts|]
  ensures serviceAttempt(after, attemptId) == serviceAttempt(s, attemptId)
{
  ServiceAttemptProjection(s, attemptId);
  ServiceAttemptProjection(after, attemptId);
  var byId := (a: ServiceAttempt) => a.id == attemptId;
  var previousMatches := ProofLib.Filter(byId, s.attempts);
  assert |previousMatches| > 0 && after.attempts == s.attempts + [after.attempts[|s.attempts|]];
  ProofLib.FilterAppend(byId, s.attempts, after.attempts[|s.attempts|]);
}

lemma ServiceEnsureClassesFold(items: seq<ServiceDeclaration>, serviceType: string, hasFallback: bool, start: ServiceInstances)
  requires inv(start)
  requires forall d :: d in items ==> d in start.declarations
  ensures (var arrived := Std.Collections.Seq.FoldLeft(
      (acc: ServiceInstances, d: ServiceDeclaration) =>
        if d.serviceType == serviceType && serviceClass(acc, d.classId).live == 0 && serviceClass(acc, d.classId).pending == 0 &&
          !(serviceClass(acc, d.classId).failed && hasFallback)
        then beginClassAttempt(d.classId, acc) else acc, start, items);
    inv(arrived) &&
    arrived.(classes := start.classes, attempts := start.attempts, nextAttempt := start.nextAttempt) == start)
  decreases |items|
{
  if |items| > 0 {
    var prefix := items[..|items|-1];
    var last := items[|items|-1];
    var visit := (acc: ServiceInstances, d: ServiceDeclaration) =>
      if d.serviceType == serviceType && serviceClass(acc, d.classId).live == 0 && serviceClass(acc, d.classId).pending == 0 &&
        !(serviceClass(acc, d.classId).failed && hasFallback)
      then beginClassAttempt(d.classId, acc) else acc;
    assert items == prefix + [last];
    assert last in start.declarations;
    forall d | d in prefix ensures d in start.declarations {
      assert d in items;
    }
    ServiceEnsureClassesFold(prefix, serviceType, hasFallback, start);
    ProofLib.FoldLeftAppend(visit, start, prefix, last);
    var middle := Std.Collections.Seq.FoldLeft(visit, start, prefix);
    if last.serviceType == serviceType && serviceClass(middle, last.classId).live == 0 &&
      serviceClass(middle, last.classId).pending == 0 && !(serviceClass(middle, last.classId).failed && hasFallback) {
      assert last in middle.declarations;
      ServiceDeclarationLookup(middle, last);
      ServiceAttemptAppend(middle, last.classId);
    }
  }
}

lemma ServiceDeclarationLookup(s: ServiceInstances, d: ServiceDeclaration)
  requires alwaysDeclarationsMatch(s) && alwaysClassAndObjectIdentities(s) && d in s.declarations
  ensures d.classId > 0 && serviceClass(s, d.classId).id == d.classId
{
  assert serviceClass(s, d.classId).registered;
  ServiceClassProjection(s, d.classId);
  var byId := (c: ServiceClassEntry) => c.id == d.classId;
  var classes := ProofLib.Filter(byId, s.classes);
  assert |classes| > 0;
  ProofLib.FilterMember(byId, s.classes, classes[0]);
}

lemma ServiceEnsureClassesValid(serviceType: string, s: ServiceInstances)
  requires inv(s)
  ensures inv(ensureClasses(serviceType, s))
  ensures ensureClasses(serviceType, s).(classes := s.classes, attempts := s.attempts, nextAttempt := s.nextAttempt) == s
{
  var hadFallback := |classInstances(s, serviceType)| != 0;
  ServiceEnsureClassesFold(s.declarations, serviceType, hadFallback, s);
}

lemma ServiceCallAppend(s: ServiceInstances, after: ServiceInstances, call: Acquire)
  requires alwaysAcquisitionIdsUnique(s)
  requires call.id > 0 && (forall c :: c in s.calls ==> c.id != call.id)
  requires after.calls == s.calls + [call]
  ensures alwaysAcquisitionIdsUnique(after)
{
  ServicePromiseIdentityFilters(s);
  ServicePromiseIdentityFilters(after);
  forall c | c in after.calls
    ensures c.id > 0 && |ProofLib.Filter((other: Acquire) => other.id == c.id, after.calls)| == 1
  {
    var byCall := (other: Acquire) => other.id == c.id;
    ProofLib.FilterAppend(byCall, s.calls, call);
    if c == call {
      ProofLib.FilterNone(byCall, s.calls);
    } else {
      assert c in s.calls && !byCall(call);
    }
  }
}

lemma ServiceAggregateAppend(s: ServiceInstances, after: ServiceInstances, aggregate: TypeAggregate)
  requires alwaysAggregateAndLoadIdsUnique(s)
  requires aggregate.id > 0 && (forall a :: a in s.aggregates ==> a.id != aggregate.id)
  requires after.aggregates == s.aggregates + [aggregate]
  requires after.nextLoad == s.nextLoad && after.loadPromises == s.loadPromises
  ensures alwaysAggregateAndLoadIdsUnique(after)
{
  ServicePromiseIdentityFilters(s);
  ServicePromiseIdentityFilters(after);
  forall a | a in after.aggregates
    ensures a.id > 0 && |ProofLib.Filter((other: TypeAggregate) => other.id == a.id, after.aggregates)| == 1
  {
    var byCall := (other: TypeAggregate) => other.id == a.id;
    ProofLib.FilterAppend(byCall, s.aggregates, aggregate);
    if a == aggregate {
      ProofLib.FilterNone(byCall, s.aggregates);
    } else {
      assert a in s.aggregates && !byCall(aggregate);
    }
  }
}

lemma ServicePublishAggregateProjection(s: ServiceInstances, callId: int, serviceType: string)
  requires inv(s) && callId > 0
  requires forall c :: c in s.calls ==> c.id != callId
  requires forall a :: a in s.aggregates ==> a.id != callId
  ensures inv(publishTypeAggregate(callId, serviceType, s))
  ensures publishTypeAggregate(callId, serviceType, s).(aggregates := s.aggregates, typeEntries := s.typeEntries) == s
{
  var after := publishTypeAggregate(callId, serviceType, s);
  var members := after.aggregates[|s.aggregates|].members;
  var aggregate := TypeAggregate(callId, serviceType, members, false, 0);
  var current := serviceTypeEntry(s, serviceType);
  var tracking := current.(serviceType := serviceType, latestAggregate := callId);
  assert after.aggregates == s.aggregates + [aggregate];
  assert after == putType(tracking, s.(aggregates := after.aggregates));
  ServiceTypeEntryLookup(s, serviceType);
  ServiceTypeEntryPut(s.(aggregates := after.aggregates), tracking);
  ServiceAggregateAppend(s, after, aggregate);
  forall e | e in after.typeEntries
    ensures (e.promiseId == 0 || (exists p :: p in after.loadPromises && p.id == e.promiseId && p.serviceType == e.serviceType))
    ensures (e.handlerId == 0 || (e.handlerId == e.promiseId && (exists p :: p in after.loadPromises && p.id == e.handlerId && p.phase.LoadPending?)))
    ensures (e.latestAggregate == 0 || (exists a :: a in after.aggregates && a.id == e.latestAggregate && a.serviceType == e.serviceType))
  {
    if e == tracking {
      assert aggregate in after.aggregates;
      if current !in s.typeEntries {
        assert current == noTypeEntry;
      }
    } else {
      assert e in s.typeEntries;
      if e.latestAggregate != 0 {
        var original :| original in s.aggregates && original.id == e.latestAggregate && original.serviceType == e.serviceType;
        assert original in after.aggregates;
      }
    }
  }
  var byType := (d: ServiceDeclaration) => d.serviceType == serviceType;
  var declarations := ProofLib.Filter(byType, s.declarations);
  forall m | m in aggregate.members && m.attemptId != 0 ensures serviceAttempt(after, m.attemptId).id == m.attemptId
  {
    var i :| 0 <= i < |members| && members[i] == m;
    assert |members| == |declarations|;
    var declaration := declarations[i];
    ProofLib.FilterMember(byType, s.declarations, declaration);
    var c := serviceClass(s, declaration.classId);
    ServiceDeclarationLookup(s, declaration);
    assert |ProofLib.Filter((entry: ServiceClassEntry) => entry.id == declaration.classId, s.classes)| > 0;
    ServiceClassProjection(s, declaration.classId);
    ProofLib.FilterMember((entry: ServiceClassEntry) => entry.id == declaration.classId, s.classes, c);
    assert c in s.classes;
    assert m == capturedAggregateMember(c, if |classInstances(s, serviceType)| > 0 then classInstances(s, serviceType)[0] else 0);
    assert c.pending == m.attemptId;
    ServiceClassPendingExists(s, c);
  }
}

lemma ServiceClassPendingExists(s: ServiceInstances, c: ServiceClassEntry)
  requires alwaysClassAndObjectIdentities(s) && alwaysPendingAttemptsOwned(s) && c in s.classes && c.pending != 0
  ensures serviceAttempt(s, c.pending).id == c.pending
{
  assert c.id > 0;
  var byId := (a: ServiceAttempt) => a.id == c.pending;
  ServiceAttemptProjection(s, c.pending);
  var found := ProofLib.Filter(byId, s.attempts);
  assert serviceAttempt(s, c.pending).classId == c.id;
  assert |found| > 0;
  ProofLib.FilterMember(byId, s.attempts, found[0]);
}

lemma ServiceStartStatusProjection(s: ServiceInstances, serviceType: string)
  requires inv(s) && firstLive(s, serviceType) == 0
  ensures inv(setTypeStatus(serviceType, TypeStatus.TypeRegistering, s))
{
  var updated := setTypeStatus(serviceType, TypeStatus.TypeRegistering, s);
  var origin := serviceTypeEntry(s, serviceType);
  var replacement := origin.(serviceType := serviceType, status := TypeStatus.TypeRegistering);
  assert updated == putType(replacement, s);
  ServiceTypeEntryLookup(s, serviceType);
  ServiceTypeEntryPut(s, replacement);
  forall e | e in updated.typeEntries
    ensures (e.promiseId == 0 || (exists p :: p in updated.loadPromises && p.id == e.promiseId && p.serviceType == e.serviceType))
    ensures (e.handlerId == 0 || (e.handlerId == e.promiseId && (exists p :: p in updated.loadPromises && p.id == e.handlerId && p.phase.LoadPending?)))
    ensures (e.latestAggregate == 0 || (exists a :: a in updated.aggregates && a.id == e.latestAggregate && a.serviceType == e.serviceType))
    ensures e.status.TypeFailed? ==> firstLive(updated, e.serviceType) == 0
  {
    if e == replacement {
      if origin !in s.typeEntries { assert origin == noTypeEntry; }
    } else {
      assert e in s.typeEntries;
    }
  }
}

lemma ServiceCapturedCallAttempts(s: ServiceInstances, serviceType: string, attempts: seq<int>)
  requires alwaysDeclarationsMatch(s) && alwaysPendingAttemptsOwned(s) && alwaysClassAndObjectIdentities(s)
  requires var retained := ProofLib.Filter((d: ServiceDeclaration) => d.serviceType == serviceType && serviceClass(s, d.classId).pending > 0, s.declarations);
    attempts == seq(|retained|, i requires 0 <= i < |retained| => serviceClass(s, retained[i].classId).pending)
  ensures forall id :: id in attempts ==> id > 0 && serviceAttempt(s, id).id == id
{
  var current := (d: ServiceDeclaration) => d.serviceType == serviceType && serviceClass(s, d.classId).pending > 0;
  var declarations := ProofLib.Filter(current, s.declarations);
  forall id | id in attempts ensures id > 0 && serviceAttempt(s, id).id == id {
    var i :| 0 <= i < |attempts| && attempts[i] == id;
    var declaration := declarations[i];
    ProofLib.FilterMember(current, s.declarations, declaration);
    var selected := serviceClass(s, declaration.classId);
    ServiceDeclarationLookup(s, declaration);
    ServiceClassProjection(s, declaration.classId);
    ProofLib.FilterMember((entry: ServiceClassEntry) => entry.id == declaration.classId, s.classes, selected);
    assert selected in s.classes && selected.pending == id;
    ServiceClassPendingExists(s, selected);
  }
}

lemma ServiceAppendAcquisition(s: ServiceInstances, call: Acquire)
  requires inv(s)
  requires call.id > 0 && (forall c :: c in s.calls ==> c.id != call.id)
  requires call.status.AcquireWaitingInit? ==> (forall a :: a in s.aggregates ==> a.id != call.id)
  requires forall id :: id in call.attempts ==> id > 0 && serviceAttempt(s, id).id == id
  ensures inv(s.(calls := s.calls + [call]))
{
  var after := s.(calls := s.calls + [call]);
  ServiceCallAppend(s, after, call);
  forall c | c in after.calls && c.status.AcquireWaitingInit?
    ensures !(exists a :: a in after.aggregates && a.id == c.id)
  {
    if c != call { assert c in s.calls; }
  }
  forall c | c in after.calls
    ensures forall id :: id in c.attempts ==> id > 0 && serviceAttempt(after, id).id == id
  {
    if c != call { assert c in s.calls; }
  }
}

lemma ServicePrepareAcquisition(s: ServiceInstances, callId: int, serviceType: string, noStarts: bool)
  requires inv(s) && canAcquireServices(s, callId, serviceType)
  ensures var started := if noStarts then s else ensureClasses(serviceType, s);
    var status := if started.nextAttempt != s.nextAttempt && firstLive(s, serviceType) == 0
      then setTypeStatus(serviceType, TypeStatus.TypeRegistering, started) else started;
    var published := if noStarts then status else publishTypeAggregate(callId, serviceType, status);
    inv(published) && published.calls == s.calls && published.objects == s.objects &&
      (noStarts ==> published.aggregates == s.aggregates)
{
  if noStarts { return; }
  var ensured := if noStarts then s else ensureClasses(serviceType, s);
  ServiceEnsureClassesValid(serviceType, s);
  var starting := if ensured.nextAttempt != s.nextAttempt && firstLive(s, serviceType) == 0
    then setTypeStatus(serviceType, TypeStatus.TypeRegistering, ensured) else ensured;
  if ensured.nextAttempt != s.nextAttempt && firstLive(s, serviceType) == 0 {
    assert firstLive(ensured, serviceType) == firstLive(s, serviceType) == 0;
    ServiceStartStatusProjection(ensured, serviceType);
  }
  assert starting.calls == s.calls && starting.aggregates == s.aggregates;
  ServicePublishAggregateProjection(starting, callId, serviceType);
}

lemma ServiceAdmitAcquisition(s: ServiceInstances, callId: int, serviceType: string)
  requires inv(s) && canAcquireServices(s, callId, serviceType)
  ensures inv(admittedAcquire(callId, serviceType, s))
  ensures stepStopIdentityRetained(s, admittedAcquire(callId, serviceType, s))
{
  var absent := s.stopped || s.initialization.InitializationFailed? ||
    (s.initialization.InitializationReady? && !(exists c :: c in s.classes && c.registered && c.serviceType == serviceType));
  var waiting := !absent && s.initialization.InitializationPending? && firstLive(s, serviceType) == 0;
  var early := !absent && s.initialization.InitializationPending? && firstLive(s, serviceType) != 0;
  var noStarts := absent || waiting || early;
  var ensured := if noStarts then s else ensureClasses(serviceType, s);
  var starting := if ensured.nextAttempt != s.nextAttempt && firstLive(s, serviceType) == 0
    then setTypeStatus(serviceType, TypeStatus.TypeRegistering, ensured) else ensured;
  var published := if noStarts then starting else publishTypeAggregate(callId, serviceType, starting);
  ServicePrepareAcquisition(s, callId, serviceType, noStarts);
  var after := admittedAcquire(callId, serviceType, s);
  var call := after.calls[|published.calls|];
  assert after == published.(calls := published.calls + [call]) && call.id == callId;
  if call.status.AcquireWaitingInit? {
    assert waiting && noStarts && published.aggregates == s.aggregates;
  }
  if !noStarts {
    ServiceCapturedCallAttempts(published, serviceType, call.attempts);
  } else {
    assert call.attempts == [];
  }
  ServiceAppendAcquisition(published, call);
  ServiceStopReferencePreserved(s, after);
}

lemma ServiceResumeAcquisition(s: ServiceInstances, callId: int)
  requires inv(s) && canResumeAcquire(s, callId)
  ensures inv(resumeAcquire(s, callId))
  ensures stepStopIdentityRetained(s, resumeAcquire(s, callId))
{
  var keep := (c: Acquire) => c.id != callId;
  var current := acquireCall(s, callId);
  var remaining := s.(calls := ProofLib.Filter(keep, s.calls));
  var byId := (c: Acquire) => c.id == callId;
  var matches := ProofLib.Filter(byId, s.calls);
  assert |matches| > 0 && matches[0] == current;
  ProofLib.FilterMember(byId, s.calls, current);
  assert current.id == callId && callId > 0;
  assert forall a :: a in s.aggregates ==> a.id != callId;
  ServicePromiseIdentityFilters(s);
  ServicePromiseIdentityFilters(remaining);
  forall c | c in remaining.calls
    ensures c in s.calls && c.id != callId && c.id > 0
    ensures |ProofLib.Filter((other: Acquire) => other.id == c.id, remaining.calls)| == 1
  {
    ProofLib.FilterMember(keep, s.calls, c);
    var byOther := (other: Acquire) => other.id == c.id;
    ProofLib.FilterOfFilterLength(keep, byOther, byOther, s.calls);
    ProofLib.FilterMember(byOther, remaining.calls, c);
  }
  assert inv(remaining) && canAcquireServices(remaining, callId, current.serviceType);
  assert resumeAcquire(s, callId) == admittedAcquire(callId, current.serviceType, remaining);
  ServiceAdmitAcquisition(remaining, callId, current.serviceType);
}

lemma acquireServices_ensures(s: ServiceInstances, callId: int, serviceType: string)
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> alwaysTypeEntriesUnique(acquireServices(s, callId, serviceType)))
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> alwaysAggregateAndLoadIdsUnique(acquireServices(s, callId, serviceType)))
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> alwaysAcquisitionIdsUnique(acquireServices(s, callId, serviceType)))
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> alwaysInitWaitingHasNoAggregate(acquireServices(s, callId, serviceType)))
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> alwaysTypeReferencesRetained(acquireServices(s, callId, serviceType)))
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> alwaysClassAndObjectIdentities(acquireServices(s, callId, serviceType)))
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> alwaysObjectStopOnce(acquireServices(s, callId, serviceType)))
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> alwaysClassOwnsKnownObjects(acquireServices(s, callId, serviceType)))
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> alwaysStoppedHasNoPublication(acquireServices(s, callId, serviceType)))
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> alwaysPublicationIdentitiesValid(acquireServices(s, callId, serviceType)))
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> alwaysPendingAttemptsOwned(acquireServices(s, callId, serviceType)))
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> alwaysCapturedAttemptsExist(acquireServices(s, callId, serviceType)))
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> alwaysDeclarationsMatch(acquireServices(s, callId, serviceType)))
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> alwaysAttemptGeneration(acquireServices(s, callId, serviceType)))
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> alwaysFailedTypeHasNoPublication(acquireServices(s, callId, serviceType)))
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> stepStopIdentityRetained(s, acquireServices(s, callId, serviceType)))
  ensures (inv(s) ==> canAcquireServices(s, callId, serviceType) ==> stepSupersededAggregateKeepsSuccessor(s, "acquireServices", acquireServices(s, callId, serviceType)))
{
  if inv(s) && canAcquireServices(s, callId, serviceType) {
    ServiceAdmitAcquisition(s, callId, serviceType);
  }
}

lemma resumeAcquire_ensures(s: ServiceInstances, callId: int)
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> alwaysTypeEntriesUnique(resumeAcquire(s, callId)))
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> alwaysAggregateAndLoadIdsUnique(resumeAcquire(s, callId)))
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> alwaysAcquisitionIdsUnique(resumeAcquire(s, callId)))
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> alwaysInitWaitingHasNoAggregate(resumeAcquire(s, callId)))
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> alwaysTypeReferencesRetained(resumeAcquire(s, callId)))
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> alwaysClassAndObjectIdentities(resumeAcquire(s, callId)))
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> alwaysObjectStopOnce(resumeAcquire(s, callId)))
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> alwaysClassOwnsKnownObjects(resumeAcquire(s, callId)))
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> alwaysStoppedHasNoPublication(resumeAcquire(s, callId)))
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> alwaysPublicationIdentitiesValid(resumeAcquire(s, callId)))
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> alwaysPendingAttemptsOwned(resumeAcquire(s, callId)))
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> alwaysCapturedAttemptsExist(resumeAcquire(s, callId)))
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> alwaysDeclarationsMatch(resumeAcquire(s, callId)))
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> alwaysAttemptGeneration(resumeAcquire(s, callId)))
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> alwaysFailedTypeHasNoPublication(resumeAcquire(s, callId)))
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> stepStopIdentityRetained(s, resumeAcquire(s, callId)))
  ensures (inv(s) ==> canResumeAcquire(s, callId) ==> stepSupersededAggregateKeepsSuccessor(s, "resumeAcquire", resumeAcquire(s, callId)))
{
  if inv(s) && canResumeAcquire(s, callId) {
    ServiceResumeAcquisition(s, callId);
  }
}

lemma ServiceClassRegisteredIdentity(s: ServiceInstances, after: ServiceInstances, classId: int, serviceType: string)
  requires alwaysClassAndObjectIdentities(s) && classId > 0
  requires after.objects == s.objects
  requires after.classes == (if serviceClass(s, classId).id == 0
    then (s.classes + [ServiceClassEntry(classId, serviceType, true, 0, 0, 0, false)])
    else (seq(|s.classes|, i requires 0 <= i < |s.classes| =>
      if s.classes[i].id == classId then s.classes[i].(registered := true) else s.classes[i])))
  ensures alwaysClassAndObjectIdentities(after)
{
  ServiceObjectIdentityFilters(s);
  ServiceObjectIdentityFilters(after);
  if serviceClass(s, classId).id == 0 {
    ServiceClassFind(s, classId);
    var added := ServiceClassEntry(classId, serviceType, true, 0, 0, 0, false);
    forall c | c in after.classes
      ensures c.id > 0 && c.generation >= 0 && c.pending >= 0 &&
        |ProofLib.Filter((other: ServiceClassEntry) => other.id == c.id, after.classes)| == 1
    {
      var exactClass := (other: ServiceClassEntry) => other.id == c.id;
      ProofLib.FilterAppend(exactClass, s.classes, added);
      if c == added {
        assert forall entry :: entry in s.classes ==> entry.id != classId;
        ProofLib.FilterNone(exactClass, s.classes);
      } else {
        assert c in s.classes && c.id != classId;
      }
    }
  } else {
    forall c | c in after.classes
      ensures c.id > 0 && c.generation >= 0 && c.pending >= 0 &&
        |ProofLib.Filter((other: ServiceClassEntry) => other.id == c.id, after.classes)| == 1
    {
      var i :| 0 <= i < |after.classes| && after.classes[i] == c;
      assert s.classes[i] in s.classes;
      var same := (entry: ServiceClassEntry) => entry.id == c.id;
      ProofLib.FilterLengthPointwise(same, same, s.classes, after.classes);
    }
  }
}

lemma ServiceRegisterLoadIdentity(s: ServiceInstances, serviceType: string)
  requires alwaysAggregateAndLoadIdsUnique(s)
  ensures alwaysAggregateAndLoadIdsUnique(registerType(serviceType, s))
{
  var after := registerType(serviceType, s);
  if serviceTypeEntry(s, serviceType).promiseId == 0 {
    var created := LoadPromise(s.nextLoad, serviceType, LoadPhase.LoadPending, 0);
    assert after.loadPromises == s.loadPromises + [created];
    assert after.nextLoad == s.nextLoad + 1 && after.aggregates == s.aggregates;
    ServicePromiseIdentityFilters(s);
    ServicePromiseIdentityFilters(after);
    forall p | p in after.loadPromises
      ensures p.id > 0 && p.id < after.nextLoad && |ProofLib.Filter((other: LoadPromise) => other.id == p.id, after.loadPromises)| == 1
    {
      var byId := (other: LoadPromise) => other.id == p.id;
      ProofLib.FilterAppend(byId, s.loadPromises, created);
      if p == created {
        ProofLib.FilterNone(byId, s.loadPromises);
      } else {
        assert p in s.loadPromises && p.id < s.nextLoad == created.id;
      }
    }
  }
}

lemma ServiceRegisterTypeReferences(s: ServiceInstances, serviceType: string)
  requires alwaysTypeEntriesUnique(s) && alwaysTypeReferencesRetained(s) && alwaysAggregateAndLoadIdsUnique(s)
  ensures alwaysTypeEntriesUnique(registerType(serviceType, s))
  ensures alwaysTypeReferencesRetained(registerType(serviceType, s))
{
  var prior := serviceTypeEntry(s, serviceType);
  var needsPromise := prior.promiseId == 0;
  var entry := TypeEntry(serviceType, TypeStatus.TypePending,
    if needsPromise then s.nextLoad else prior.promiseId, if needsPromise then s.nextLoad else prior.handlerId, prior.latestAggregate);
  var created := LoadPromise(s.nextLoad, serviceType, LoadPhase.LoadPending, 0);
  var interim := if needsPromise then s.(loadPromises := s.loadPromises + [created], nextLoad := s.nextLoad + 1) else s;
  var after := registerType(serviceType, s);
  assert after == putType(entry, interim);
  ServiceTypeEntryLookup(s, serviceType);
  ServiceTypeEntryPut(interim, entry);
  forall e | e in after.typeEntries
    ensures (e.promiseId == 0 || (exists p :: p in after.loadPromises && p.id == e.promiseId && p.serviceType == e.serviceType))
    ensures (e.handlerId == 0 || (e.handlerId == e.promiseId && (exists p :: p in after.loadPromises && p.id == e.handlerId && p.phase.LoadPending?)))
    ensures (e.latestAggregate == 0 || (exists a :: a in after.aggregates && a.id == e.latestAggregate && a.serviceType == e.serviceType))
  {
    if e != entry {
      assert e in s.typeEntries;
    } else {
      if needsPromise { assert created in after.loadPromises && created.id == entry.handlerId == entry.promiseId; }
      if prior !in s.typeEntries { assert prior == noTypeEntry && prior.latestAggregate == 0; }
    }
  }
}

lemma ServiceDeclarationAppended(s: ServiceInstances, after: ServiceInstances, classId: int, serviceType: string)
  requires alwaysDeclarationsMatch(s) && alwaysClassAndObjectIdentities(s) && alwaysClassAndObjectIdentities(after)
  requires canRegisterClass(s, classId, serviceType) && after == registerClass(s, classId, serviceType)
  ensures alwaysDeclarationsMatch(after)
{
  var prior := serviceClass(s, classId);
  var entry := if prior.id == 0 then ServiceClassEntry(classId, serviceType, true, 0, 0, 0, false)
    else prior.(registered := true);
  ServiceClassProjection(s, classId);
  ServiceClassFind(s, classId);
  assert entry in after.classes by {
    if prior.id == 0 {
      assert after.classes == s.classes + [entry];
    } else {
      var matching := ProofLib.Filter((c: ServiceClassEntry) => c.id == classId, s.classes);
      assert |matching| > 0 && matching[0] == prior;
      ProofLib.FilterMember((c: ServiceClassEntry) => c.id == classId, s.classes, prior);
      var i :| 0 <= i < |s.classes| && s.classes[i] == prior;
      assert after.classes[i] == entry;
    }
  }
  ServiceClassFind(after, classId);
  assert serviceClass(after, classId) == entry && entry.registered && entry.serviceType == serviceType;
  var added := ServiceDeclaration(classId, serviceType);
  assert after.declarations == s.declarations + [added];
  forall d | d in after.declarations
    ensures serviceClass(after, d.classId).registered && serviceClass(after, d.classId).serviceType == d.serviceType
  {
    if d.classId == classId {
      if d != added {
        assert d in s.declarations && prior.registered && prior.serviceType == d.serviceType;
      }
    } else {
      assert d in s.declarations;
      var existing := serviceClass(s, d.classId);
      ServiceDeclarationLookup(s, d);
      ServiceClassProjection(s, d.classId);
      ProofLib.FilterMember((c: ServiceClassEntry) => c.id == d.classId, s.classes, existing);
      var i :| 0 <= i < |s.classes| && s.classes[i] == existing;
      assert after.classes[i] == existing && existing in after.classes;
      ServiceClassFind(after, d.classId);
    }
  }
  forall c | c in after.classes
    ensures c.registered <==> (exists d :: d in after.declarations && d.classId == c.id)
  {
    if c.id == classId {
      assert c == serviceClass(after, classId) && added in after.declarations;
    } else {
      var i :| 0 <= i < |after.classes| && after.classes[i] == c;
      assert i < |s.classes| && s.classes[i] == c && c in s.classes;
    }
  }
}

lemma registerClass_ensures(s: ServiceInstances, classId: int, serviceType: string)
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysTypeEntriesUnique(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysAggregateAndLoadIdsUnique(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysAcquisitionIdsUnique(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysInitWaitingHasNoAggregate(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysTypeReferencesRetained(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysClassAndObjectIdentities(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysObjectStopOnce(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysClassOwnsKnownObjects(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysStoppedHasNoPublication(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysPublicationIdentitiesValid(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysPendingAttemptsOwned(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysCapturedAttemptsExist(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysDeclarationsMatch(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysAttemptGeneration(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> alwaysFailedTypeHasNoPublication(registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> stepStopIdentityRetained(s, registerClass(s, classId, serviceType)))
  ensures (inv(s) ==> canRegisterClass(s, classId, serviceType) ==> stepSupersededAggregateKeepsSuccessor(s, "registerClass", registerClass(s, classId, serviceType)))
{
  if inv(s) && canRegisterClass(s, classId, serviceType) {
    var after := registerClass(s, classId, serviceType);
    ServiceClassRegisteredIdentity(s, after, classId, serviceType);
    ServiceDeclarationAppended(s, after, classId, serviceType);
    var contextual := s.(classes := after.classes, declarations := after.declarations);
    assert after == registerType(serviceType, contextual);
    ServiceRegisterLoadIdentity(contextual, serviceType);
    ServiceRegisterTypeReferences(contextual, serviceType);
  }
}

lemma ServiceObjectCreated(s: ServiceInstances, after: ServiceInstances, instanceId: int)
  requires alwaysClassAndObjectIdentities(s) && instanceId > 0
  requires after.objects == (if serviceObject(s, instanceId).id == 0 then
    s.objects + [ServiceObject(instanceId, StopPhase.StopNotRequested, 0, false, "")] else s.objects)
  ensures forall o :: o in after.objects ==> (o.id > 0 && |ProofLib.Filter((other: ServiceObject) => other.id == o.id, after.objects)| == 1)
{
  ServiceObjectIdentityFilters(s);
  if serviceObject(s, instanceId).id == 0 {
    ServiceObjectLookup(s, instanceId);
    var added := ServiceObject(instanceId, StopPhase.StopNotRequested, 0, false, "");
    forall o | o in after.objects
      ensures o.id > 0 && |ProofLib.Filter((other: ServiceObject) => other.id == o.id, after.objects)| == 1
    {
      var byId := (other: ServiceObject) => other.id == o.id;
      ProofLib.FilterAppend(byId, s.objects, added);
      if o == added {
        assert forall existing :: existing in s.objects ==> existing.id != instanceId;
        ProofLib.FilterNone(byId, s.objects);
      } else {
        assert o in s.objects && o.id != instanceId;
      }
    }
  }
}

lemma ServiceTypeReferenceMetadata(s: ServiceInstances, after: ServiceInstances, serviceType: string, status: TypeStatus)
  requires alwaysTypeEntriesUnique(s) && alwaysTypeReferencesRetained(s)
  requires |s.aggregates| == |after.aggregates| && s.aggregates == after.aggregates && s.loadPromises == after.loadPromises
  requires after.typeEntries ==
    putType(serviceTypeEntry(s, serviceType).(serviceType := serviceType, status := status), s).typeEntries
  ensures alwaysTypeReferencesRetained(after)
  ensures alwaysTypeEntriesUnique(after)
{
  ServiceTypeEntryLookup(s, serviceType);
  var origin := serviceTypeEntry(s, serviceType);
  var replacement := origin.(serviceType := serviceType, status := status);
  ServiceTypeEntryPut(s, replacement);
  forall e | e in after.typeEntries
    ensures (e.promiseId == 0 || (exists p :: p in after.loadPromises && p.id == e.promiseId && p.serviceType == e.serviceType))
    ensures (e.handlerId == 0 || (e.handlerId == e.promiseId && (exists p :: p in after.loadPromises && p.id == e.handlerId && p.phase.LoadPending?)))
    ensures (e.latestAggregate == 0 || (exists a :: a in after.aggregates && a.id == e.latestAggregate && a.serviceType == e.serviceType))
  {
    if e == replacement {
      if origin !in s.typeEntries { assert origin == noTypeEntry; }
    } else {
      assert e in s.typeEntries;
    }
  }
}

lemma ServiceReturnedClassObjects(s: ServiceInstances, after: ServiceInstances, attemptId: int, instanceId: int)
  requires alwaysClassOwnsKnownObjects(s) && canReturnInstance(s, attemptId, instanceId)
  requires after == returnInstance(s, attemptId, instanceId)
  ensures alwaysClassOwnsKnownObjects(after)
{
  forall c | c in after.classes && c.live != 0
    ensures exists o :: o in after.objects && o.id == c.live
  {
    var i :| 0 <= i < |after.classes| && after.classes[i] == c;
    var prior := s.classes[i];
    assert prior in s.classes && (c.live == prior.live || c.live == instanceId);
    if c.live == instanceId && serviceObject(s, instanceId).id == 0 {
      assert after.objects[|s.objects|].id == instanceId;
      assert after.objects[|s.objects|] in after.objects;
    } else {
      if c.live == instanceId { ServiceObjectPresence(s, instanceId); }
      var j :| 0 <= j < |s.objects| && s.objects[j].id == c.live;
      assert after.objects[j].id == c.live && after.objects[j] in after.objects;
    }
  }
}

lemma ServiceReturnedPublication(s: ServiceInstances, after: ServiceInstances, attemptId: int, instanceId: int)
  requires alwaysPublicationIdentitiesValid(s) && alwaysDeclarationsMatch(s) && alwaysClassAndObjectIdentities(s)
  requires alwaysClassOwnsKnownObjects(s)
  requires canReturnInstance(s, attemptId, instanceId)
  requires after == returnInstance(s, attemptId, instanceId)
  ensures alwaysPublicationIdentitiesValid(after)
{
  var owner := serviceClass(s, serviceAttempt(s, attemptId).classId);
  var late := s.stopped || !owner.registered;
  if late {
    assert after.published == s.published && after.classes == s.classes;
  } else {
    var classId := serviceAttempt(s, attemptId).classId;
    ServiceClassProjection(s, classId);
    var matched := ProofLib.Filter((c: ServiceClassEntry) => c.id == classId, s.classes);
    assert |matched| > 0 && owner == matched[0];
    ProofLib.FilterMember((c: ServiceClassEntry) => c.id == classId, s.classes, owner);
    assert owner in s.classes;
    var declaration :| declaration in s.declarations && declaration.classId == owner.id;
    assert declaration.serviceType == owner.serviceType && owner.serviceType != "";
    var instances := classInstances(after, owner.serviceType);
    var entry := ServicePublication(owner.serviceType, instances);
    var byType := (d: ServiceDeclaration) => d.serviceType == owner.serviceType && serviceClass(after, d.classId).live != 0;
    var contributing := ProofLib.Filter(byType, after.declarations);
    assert |instances| == |contributing|;
    forall instance | instance in instances
      ensures instance > 0 && (exists c :: c in after.classes && c.serviceType == owner.serviceType && c.live == instance)
    {
      var i :| 0 <= i < |instances| && instances[i] == instance;
      var d := contributing[i];
      ProofLib.FilterMember(byType, after.declarations, d);
      var c := serviceClass(after, d.classId);
      assert instance == c.live;
      ServiceStartClassFields(s, after, d.classId);
      ServiceClassProjection(after, d.classId);
      var selected := ProofLib.Filter((cls: ServiceClassEntry) => cls.id == d.classId, after.classes);
      assert |selected| > 0 && selected[0] == c;
      ProofLib.FilterMember((cls: ServiceClassEntry) => cls.id == d.classId, after.classes, c);
      var j :| 0 <= j < |after.classes| && after.classes[j] == c;
      assert s.classes[j] in s.classes;
      assert c.live == instanceId || c.live == s.classes[j].live;
      if c.live != instanceId {
        var priorObject :| priorObject in s.objects && priorObject.id == s.classes[j].live;
        assert priorObject.id > 0;
      }
    }
    assert after.published == replacePublication(owner.serviceType, instances, after.(published := s.published)).published;
    forall p | p in after.published
      ensures p.serviceType != "" && 0 < |p.instances| &&
        |ProofLib.Filter((other: ServicePublication) => other.serviceType == p.serviceType, after.published)| == 1
      ensures forall id :: id in p.instances ==> id > 0 && (exists c :: c in after.classes && c.serviceType == p.serviceType && c.live == id)
    {
      if p == entry {
        var typ := (other: ServicePublication) => other.serviceType == owner.serviceType;
        if exists current :: current in s.published && typ(current) {
          var priorPublication :| priorPublication in s.published && typ(priorPublication);
          assert |ProofLib.Filter(typ, s.published)| == 1;
          ProofLib.FilterLengthPointwise(typ, typ, s.published, after.published);
        } else {
          ProofLib.FilterNone(typ, s.published);
          ProofLib.FilterAppend(typ, s.published, entry);
        }
      } else {
        assert p in s.published && p.serviceType != owner.serviceType;
        forall id | id in p.instances
          ensures id > 0 && (exists c :: c in after.classes && c.serviceType == p.serviceType && c.live == id)
        {
          var i :| 0 <= i < |s.classes| && s.classes[i].serviceType == p.serviceType && s.classes[i].live == id;
          assert s.classes[i] in s.classes;
          ServiceClassFind(s, classId);
          assert s.classes[i].id != classId && after.classes[i] == s.classes[i];
          assert after.classes[i] in after.classes;
        }
        var typ := (other: ServicePublication) => other.serviceType == p.serviceType;
        if |instances| == 0 {
          var retained := (other: ServicePublication) => other.serviceType != owner.serviceType;
          ProofLib.FilterOfFilterLength(retained, typ, typ, s.published);
        } else if exists current :: current in s.published && current.serviceType == owner.serviceType {
          ProofLib.FilterLengthPointwise(typ, typ, s.published, after.published);
        } else {
          ProofLib.FilterAppend(typ, s.published, entry);
        }
      }
    }
  }
}

lemma returnInstance_ensures(s: ServiceInstances, attemptId: int, instanceId: int)
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysTypeEntriesUnique(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysAggregateAndLoadIdsUnique(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysAcquisitionIdsUnique(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysInitWaitingHasNoAggregate(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysTypeReferencesRetained(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysClassAndObjectIdentities(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysObjectStopOnce(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysClassOwnsKnownObjects(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysStoppedHasNoPublication(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysPublicationIdentitiesValid(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysPendingAttemptsOwned(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysCapturedAttemptsExist(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysDeclarationsMatch(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysAttemptGeneration(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> alwaysFailedTypeHasNoPublication(returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> stepStopIdentityRetained(s, returnInstance(s, attemptId, instanceId)))
  ensures (inv(s) ==> canReturnInstance(s, attemptId, instanceId) ==> stepSupersededAggregateKeepsSuccessor(s, "returnInstance", returnInstance(s, attemptId, instanceId)))
{
  if inv(s) && canReturnInstance(s, attemptId, instanceId) {
    var after := returnInstance(s, attemptId, instanceId);
    var attempt := serviceAttempt(s, attemptId);
    var owner := serviceClass(s, attempt.classId);
    var late := s.stopped || !owner.registered;
    ServiceReturnedClassObjects(s, after, attemptId, instanceId);
    ServiceReturnedPublication(s, after, attemptId, instanceId);
    var registrationView := if late then after.(objects := if serviceObject(s, instanceId).id == 0 then s.objects + [ServiceObject(instanceId, StopPhase.StopNotRequested, 0, false, "")] else s.objects) else after;
    ServiceObjectCreated(s, registrationView, instanceId);
    ServiceObjectIdentityFilters(s);
    ServiceObjectIdentityFilters(after);
    forall c | c in after.classes
      ensures c.id > 0 && c.generation >= 0 && c.pending >= 0 && |ProofLib.Filter((other: ServiceClassEntry) => other.id == c.id, after.classes)| == 1
    {
      var i :| 0 <= i < |after.classes| && after.classes[i] == c;
      assert s.classes[i] in s.classes;
      var byId := (other: ServiceClassEntry) => other.id == c.id;
      ProofLib.FilterLengthPointwise(byId, byId, s.classes, after.classes);
    }
    if late {
      forall o | o in after.objects ensures o.id > 0 && |ProofLib.Filter((other: ServiceObject) => other.id == o.id, after.objects)| == 1 {
        var i :| 0 <= i < |after.objects| && after.objects[i] == o;
        assert registrationView.objects[i] in registrationView.objects;
        var byId := (other: ServiceObject) => other.id == o.id;
        ProofLib.FilterLengthPointwise(byId, byId, registrationView.objects, after.objects);
      }
    } else {
      ServiceTypeReferenceMetadata(s, after, owner.serviceType, TypeStatus.TypeRegistered);
    }
  }
}

lemma resolveNextStart_ensures(s: ServiceInstances, ok: bool, instanceId: int, errorId: string)
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysTypeEntriesUnique(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysAggregateAndLoadIdsUnique(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysAcquisitionIdsUnique(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysInitWaitingHasNoAggregate(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysTypeReferencesRetained(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysClassAndObjectIdentities(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysObjectStopOnce(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysClassOwnsKnownObjects(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysStoppedHasNoPublication(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysPublicationIdentitiesValid(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysPendingAttemptsOwned(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysCapturedAttemptsExist(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysDeclarationsMatch(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysAttemptGeneration(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> alwaysFailedTypeHasNoPublication(resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> stepStopIdentityRetained(s, resolveNextStart(s, ok, instanceId, errorId)))
  ensures (inv(s) ==> canResolveNextStart(s, ok, instanceId, errorId) ==> stepSupersededAggregateKeepsSuccessor(s, "resolveNextStart", resolveNextStart(s, ok, instanceId, errorId)))
{
  if inv(s) && canResolveNextStart(s, ok, instanceId, errorId) {
    if ok {
      returnInstance_ensures(s, nextInvokingAttempt(s), instanceId);
    } else {
      failStart_ensures(s, nextInvokingAttempt(s), errorId);
    }
  }
}

lemma ServiceSettledTypeReferences(s: ServiceInstances, after: ServiceInstances, entry: TypeEntry, updated: TypeEntry, serviceType: string)
  requires alwaysTypeEntriesUnique(s) && alwaysTypeReferencesRetained(s) && alwaysAggregateAndLoadIdsUnique(s)
  requires entry == serviceTypeEntry(s, serviceType) && updated.serviceType == serviceType && updated.handlerId == 0
  requires updated.promiseId == 0 || updated.promiseId == entry.promiseId
  requires updated.latestAggregate == entry.latestAggregate && after.aggregates == s.aggregates
  requires |after.loadPromises| == |s.loadPromises|
  requires forall i :: 0 <= i < |s.loadPromises| ==>
    (after.loadPromises[i].id == s.loadPromises[i].id && after.loadPromises[i].serviceType == s.loadPromises[i].serviceType &&
     (s.loadPromises[i].id != entry.handlerId ==> after.loadPromises[i] == s.loadPromises[i]))
  requires forall e :: e in after.typeEntries ==> e == updated || (e in s.typeEntries && e.serviceType != serviceType)
  ensures alwaysTypeReferencesRetained(after)
{
  ServiceTypeEntryLookup(s, serviceType);
  forall e | e in after.typeEntries
    ensures (e.promiseId == 0 || (exists p :: p in after.loadPromises && p.id == e.promiseId && p.serviceType == e.serviceType))
    ensures (e.handlerId == 0 || (e.handlerId == e.promiseId && (exists p :: p in after.loadPromises && p.id == e.handlerId && p.phase.LoadPending?)))
    ensures (e.latestAggregate == 0 || (exists a :: a in after.aggregates && a.id == e.latestAggregate && a.serviceType == e.serviceType))
  {
    var origin := if e == updated then entry else e;
    if e == updated && entry == noTypeEntry {
      assert origin == noTypeEntry && e == updated;
      assert e.promiseId == 0 && e.handlerId == 0 && e.latestAggregate == 0;
    } else {
      assert origin in s.typeEntries;
      assert origin.serviceType == e.serviceType;
      if e.promiseId != 0 {
        assert origin.promiseId == e.promiseId;
        var i :| 0 <= i < |s.loadPromises| && s.loadPromises[i].id == origin.promiseId && s.loadPromises[i].serviceType == origin.serviceType;
        assert after.loadPromises[i] in after.loadPromises;
        assert after.loadPromises[i].id == e.promiseId && after.loadPromises[i].serviceType == e.serviceType;
      }
      if e.handlerId != 0 {
        assert e != updated && e == origin && e.serviceType != serviceType;
        var p :| p in s.loadPromises && p.id == e.promiseId && p.serviceType == e.serviceType;
        var i :| 0 <= i < |s.loadPromises| && s.loadPromises[i].id == e.handlerId && s.loadPromises[i].phase.LoadPending?;
        var original := s.loadPromises[i];
        assert original in s.loadPromises && original.id == p.id;
        ServiceSameLoadType(s, p, original);
        if entry.handlerId == original.id {
          assert entry in s.typeEntries;
          var other :| other in s.loadPromises && other.id == entry.promiseId && other.serviceType == entry.serviceType;
          ServiceSameLoadType(s, original, other);
          assert false;
        }
        assert after.loadPromises[i] == original && original in after.loadPromises;
      }
      assert e.latestAggregate == origin.latestAggregate;
    }
  }
}


lemma ServiceClearAggregateOwnership(s: ServiceInstances, after: ServiceInstances, callId: int)
  requires alwaysTypeReferencesRetained(s) && canClearTypeAggregate(s, callId) && after == clearTypeAggregate(s, callId)
  ensures alwaysTypeReferencesRetained(after)
  ensures stepSupersededAggregateKeepsSuccessor(s, "clearTypeAggregate", after)
{
  ServiceClearUpdatesOnlyTypeMetadata(s, callId);
  forall e | e in s.typeEntries
    ensures (exists a :: (a in after.typeEntries && a.serviceType == e.serviceType &&
      (a.latestAggregate == e.latestAggregate || (a.latestAggregate == 0 && typeAggregate(s, e.latestAggregate).settled))))
  {
    var i :| 0 <= i < |s.typeEntries| && s.typeEntries[i] == e;
    assert after.typeEntries[i] in after.typeEntries;
  }
  forall e | e in after.typeEntries
    ensures (e.promiseId == 0 || (exists p :: p in after.loadPromises && p.id == e.promiseId && p.serviceType == e.serviceType))
    ensures (e.handlerId == 0 || (e.handlerId == e.promiseId && (exists p :: p in after.loadPromises && p.id == e.handlerId && p.phase.LoadPending?)))
    ensures (e.latestAggregate == 0 || (exists a :: a in after.aggregates && a.id == e.latestAggregate && a.serviceType == e.serviceType))
  {
    var i :| 0 <= i < |after.typeEntries| && after.typeEntries[i] == e;
    var origin := s.typeEntries[i];
    assert origin in s.typeEntries;
  }
}


lemma ServiceClassWithdrawalKeepsKnownObjects(before: ServiceInstances, after: ServiceInstances, classId: int)
  requires alwaysClassAndObjectIdentities(before) && alwaysClassOwnsKnownObjects(before)
  requires after.objects == before.objects
  requires after.classes == withdrawClass(classId, before).classes
  ensures alwaysClassAndObjectIdentities(after)
  ensures alwaysClassOwnsKnownObjects(after)
{
  ServiceObjectIdentityFilters(before);
  ServiceObjectIdentityFilters(after);
  forall c | c in after.classes
    ensures c.id > 0 && c.generation >= 0 && c.pending >= 0 && |ProofLib.Filter((other: ServiceClassEntry) => other.id == c.id, after.classes)| == 1
    ensures c.live == 0 || (exists o :: o in after.objects && o.id == c.live)
  {
    var i :| 0 <= i < |after.classes| && after.classes[i] == c;
    var prior := before.classes[i];
    assert prior in before.classes && prior.id == c.id;
    var exact := (other: ServiceClassEntry) => other.id == c.id;
    ProofLib.FilterLengthPointwise(exact, exact, before.classes, after.classes);
    if c.live != 0 { assert c.live == prior.live; }
  }
}

lemma ServiceTypeReconciliationRetainsReferences(s: ServiceInstances, serviceType: string)
  requires alwaysTypeEntriesUnique(s) && alwaysTypeReferencesRetained(s)
  ensures alwaysTypeEntriesUnique(reconcileType(serviceType, s))
  ensures alwaysTypeReferencesRetained(reconcileType(serviceType, s))
{
  var entry := serviceTypeEntry(s, serviceType);
  var published := firstLive(s, serviceType) != 0;
  var declared := exists d :: d in s.declarations && d.serviceType == serviceType;
  var retained := published || declared;
  var updated := entry.(serviceType := serviceType,
    status := if published then TypeStatus.TypeRegistered else if declared then TypeStatus.TypePending else TypeStatus.TypeUnknown,
    promiseId := if retained then entry.promiseId else 0, handlerId := if retained then entry.handlerId else 0);
  var after := reconcileType(serviceType, s);
  assert after == putType(updated, s);
  ServiceTypeEntryLookup(s, serviceType);
  ServiceTypeEntryPut(s, updated);
  forall e | e in after.typeEntries
    ensures (e.promiseId == 0 || (exists p :: p in after.loadPromises && p.id == e.promiseId && p.serviceType == e.serviceType))
    ensures (e.handlerId == 0 || (e.handlerId == e.promiseId && (exists p :: p in after.loadPromises && p.id == e.handlerId && p.phase.LoadPending?)))
    ensures (e.latestAggregate == 0 || (exists a :: a in after.aggregates && a.id == e.latestAggregate && a.serviceType == e.serviceType))
  {
    if e == updated {
      if entry !in s.typeEntries { assert entry == noTypeEntry; }
    } else {
      assert e in s.typeEntries;
    }
  }
}

lemma unregisterClass_ensures(s: ServiceInstances, classId: int)
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> alwaysTypeEntriesUnique(unregisterClass(s, classId)))
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> alwaysAggregateAndLoadIdsUnique(unregisterClass(s, classId)))
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> alwaysAcquisitionIdsUnique(unregisterClass(s, classId)))
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> alwaysInitWaitingHasNoAggregate(unregisterClass(s, classId)))
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> alwaysTypeReferencesRetained(unregisterClass(s, classId)))
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> alwaysClassAndObjectIdentities(unregisterClass(s, classId)))
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> alwaysObjectStopOnce(unregisterClass(s, classId)))
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> alwaysClassOwnsKnownObjects(unregisterClass(s, classId)))
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> alwaysStoppedHasNoPublication(unregisterClass(s, classId)))
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> alwaysPublicationIdentitiesValid(unregisterClass(s, classId)))
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> alwaysPendingAttemptsOwned(unregisterClass(s, classId)))
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> alwaysCapturedAttemptsExist(unregisterClass(s, classId)))
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> alwaysDeclarationsMatch(unregisterClass(s, classId)))
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> alwaysAttemptGeneration(unregisterClass(s, classId)))
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> alwaysFailedTypeHasNoPublication(unregisterClass(s, classId)))
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> stepStopIdentityRetained(s, unregisterClass(s, classId)))
  ensures (inv(s) ==> canUnregisterClass(s, classId) ==> stepSupersededAggregateKeepsSuccessor(s, "unregisterClass", unregisterClass(s, classId)))
{
  if inv(s) && canUnregisterClass(s, classId) {
    var selected := serviceClass(s, classId);
    var stopped := if selected.live != 0 then stopObjectOnce(selected.live, s) else s;
    var withdrawn := removePublishedInstances(selected.serviceType, [selected.live], withdrawClass(classId, stopped));
    var after := unregisterClass(s, classId);
    assert after == reconcileType(selected.serviceType, withdrawn);
    ServiceStopWorkProjection(s, stopped);
    ServiceClassWithdrawalKeepsKnownObjects(stopped, after, classId);
    ServiceTypeReconciliationRetainsReferences(withdrawn, selected.serviceType);
  }
}
