lemma HookIdentitiesBridge(s: HookService)
  ensures alwaysRegistrationIds(s) <==> (s.nextId > 0 && (forall row :: row in s.registrations ==> (0 < row.id < s.nextId && |ProofLib.Filter((other: HookRegistration) => other.id == row.id, s.registrations)| == 1)))
{}

lemma HookIdentitiesPreserved(s: HookService, t: HookService)
  requires alwaysRegistrationIds(s)
  requires |s.registrations| == |t.registrations|
  requires s.nextId <= t.nextId
  requires forall i :: 0 <= i < |s.registrations| ==> s.registrations[i].id == t.registrations[i].id
  ensures alwaysRegistrationIds(t)
{
  HookIdentitiesBridge(s);
  HookIdentitiesBridge(t);
  forall row | row in t.registrations
    ensures 0 < row.id < t.nextId && |ProofLib.Filter((other: HookRegistration) => other.id == row.id, t.registrations)| == 1
  {
    var i :| 0 <= i < |t.registrations| && t.registrations[i] == row;
    assert s.registrations[i] in s.registrations;
    ProofLib.FilterLengthPointwise((other: HookRegistration) => other.id == row.id, (other: HookRegistration) => other.id == row.id, s.registrations, t.registrations);
  }
}

lemma HookIdentityAdded(s: HookService, t: HookService, row: HookRegistration)
  requires alwaysRegistrationIds(s)
  requires row.id == s.nextId && t.nextId == s.nextId + 1
  requires t.registrations == s.registrations + [row]
  ensures alwaysRegistrationIds(t)
{
  HookIdentitiesBridge(s);
  HookIdentitiesBridge(t);
  forall entry | entry in t.registrations
    ensures 0 < entry.id < t.nextId && |ProofLib.Filter((other: HookRegistration) => other.id == entry.id, t.registrations)| == 1
  {
    var p := (other: HookRegistration) => other.id == entry.id;
    ProofLib.FilterAppend(p,s.registrations,row);
    if entry == row {
      ProofLib.FilterNone(p,s.registrations);
    } else {
      assert entry in s.registrations;
    }
  }
}

lemma HookCallsBridge(s: HookService)
  ensures alwaysDispatchBounds(s) <==> (forall row :: row in s.calls ==> (validCall(row) && |ProofLib.Filter((other: EventHookCall) => other.id == row.id,s.calls)| == 1))
{}

lemma HookCallKeepsSnapshot(first: EventHookCall, second: EventHookCall)
  requires first.id == second.id && first.payloadRef == second.payloadRef && first.snapshot == second.snapshot
  ensures first.id == second.id && first.payloadRef == second.payloadRef && second.snapshot == first.snapshot
{}

lemma HookCallSnapshotPrefix(s: HookService, via: string, t: HookService)
  requires via == "beginHandler" || via == "finishHandler" || via == "dispatch"
  requires |s.calls| <= |t.calls|
  requires forall i :: 0 <= i < |s.calls| ==>
    (s.calls[i].id == t.calls[i].id && s.calls[i].payloadRef == t.calls[i].payloadRef && s.calls[i].snapshot == t.calls[i].snapshot)
  ensures stepSnapshotsImmutable(s,via,t)
{
  forall row | row in s.calls
    ensures exists other :: other in t.calls && other.id == row.id && other.payloadRef == row.payloadRef && other.snapshot == row.snapshot
  {
    var i :| 0 <= i < |s.calls| && s.calls[i] == row;
    assert t.calls[i] in t.calls;
    HookCallKeepsSnapshot(row,t.calls[i]);
  }
}

lemma HookCallBoundsMapped(s: HookService, t: HookService)
  requires alwaysDispatchBounds(s)
  requires |s.calls| == |t.calls|
  requires forall i :: 0 <= i < |s.calls| ==> s.calls[i].id == t.calls[i].id && validCall(t.calls[i])
  ensures alwaysDispatchBounds(t)
{
  HookCallsBridge(s);
  HookCallsBridge(t);
  forall row | row in t.calls
    ensures validCall(row) && |ProofLib.Filter((other: EventHookCall) => other.id == row.id,t.calls)| == 1
  {
    var i :| 0 <= i < |t.calls| && t.calls[i] == row;
    assert s.calls[i] in s.calls;
    ProofLib.FilterLengthPointwise((other: EventHookCall) => other.id == row.id, (other: EventHookCall) => other.id == row.id, s.calls,t.calls);
  }
}

lemma HookCallAdded(s: HookService, t: HookService, row: EventHookCall)
  requires alwaysDispatchBounds(s)
  requires validCall(row)
  requires forall entry :: entry in s.calls ==> entry.id != row.id
  requires t.calls == s.calls + [row]
  ensures alwaysDispatchBounds(t)
{
  HookCallsBridge(s);
  HookCallsBridge(t);
  forall entry | entry in t.calls
    ensures validCall(entry) && |ProofLib.Filter((other: EventHookCall) => other.id == entry.id,t.calls)| == 1
  {
    var p := (other: EventHookCall) => other.id == entry.id;
    ProofLib.FilterAppend(p,s.calls,row);
    if entry == row {
      ProofLib.FilterNone(p,s.calls);
    } else {
      assert entry in s.calls;
    }
  }
}

lemma observeRegistrationAlias_ensures(s: HookService, hookId: int, handler: int, metadata: HookMetadata, registeredAt: int)
  ensures (inv(s) ==> canObserveRegistrationAlias(s, hookId, handler, metadata, registeredAt) ==> alwaysRegistrationIds(observeRegistrationAlias(s, hookId, handler, metadata, registeredAt)))
  ensures (inv(s) ==> canObserveRegistrationAlias(s, hookId, handler, metadata, registeredAt) ==> alwaysDispatchBounds(observeRegistrationAlias(s, hookId, handler, metadata, registeredAt)))
  ensures (inv(s) ==> canObserveRegistrationAlias(s, hookId, handler, metadata, registeredAt) ==> stepCountersNeverReset(s, observeRegistrationAlias(s, hookId, handler, metadata, registeredAt)))
  ensures (inv(s) ==> canObserveRegistrationAlias(s, hookId, handler, metadata, registeredAt) ==> stepSnapshotsImmutable(s, "observeRegistrationAlias", observeRegistrationAlias(s, hookId, handler, metadata, registeredAt)))
{
  if inv(s) && canObserveRegistrationAlias(s, hookId, handler, metadata, registeredAt) {
    var t := observeRegistrationAlias(s, hookId, handler, metadata, registeredAt);
    forall i | 0 <= i < |s.registrations|
      ensures t.registrations[i].id == s.registrations[i].id
    {}
    HookIdentitiesPreserved(s,t);
    assert t.calls == s.calls;
  }
}

lemma stopService_ensures(s: HookService)
  ensures (inv(s) ==> alwaysRegistrationIds(stopService(s)))
  ensures (inv(s) ==> alwaysDispatchBounds(stopService(s)))
  ensures (inv(s) ==> stepCountersNeverReset(s, stopService(s)))
  ensures (inv(s) ==> stepSnapshotsImmutable(s, "stopService", stopService(s)))
{
  if inv(s) {
    var t := stopService(s);
    forall i | 0 <= i < |s.registrations|
      ensures t.registrations[i].id == s.registrations[i].id
    {}
    HookIdentitiesPreserved(s,t);
    assert t.calls == s.calls;
  }
}

lemma unregister_ensures(s: HookService, hookId: int)
  ensures (inv(s) ==> canUnregister(s, hookId) ==> alwaysRegistrationIds(unregister(s, hookId)))
  ensures (inv(s) ==> canUnregister(s, hookId) ==> alwaysDispatchBounds(unregister(s, hookId)))
  ensures (inv(s) ==> canUnregister(s, hookId) ==> stepCountersNeverReset(s, unregister(s, hookId)))
  ensures (inv(s) ==> canUnregister(s, hookId) ==> stepSnapshotsImmutable(s, "unregister", unregister(s, hookId)))
{
  if inv(s) && canUnregister(s, hookId) {
    var t := unregister(s, hookId);
    forall i | 0 <= i < |s.registrations|
      ensures t.registrations[i].id == s.registrations[i].id
    {}
    HookIdentitiesPreserved(s,t);
    assert t.calls == s.calls;
  }
}

lemma setActive_ensures(s: HookService, hookId: int, active: bool)
  ensures (inv(s) ==> alwaysRegistrationIds(setActive(s, hookId, active)))
  ensures (inv(s) ==> alwaysDispatchBounds(setActive(s, hookId, active)))
  ensures (inv(s) ==> stepCountersNeverReset(s, setActive(s, hookId, active)))
  ensures (inv(s) ==> stepSnapshotsImmutable(s, "setActive", setActive(s, hookId, active)))
{
  if inv(s) {
    var t := setActive(s, hookId, active);
    forall i | 0 <= i < |s.registrations|
      ensures t.registrations[i].id == s.registrations[i].id
    {}
    HookIdentitiesPreserved(s,t);
    assert t.calls == s.calls;
  }
}

lemma setPriority_ensures(s: HookService, hookId: int, priority: int, finite: bool)
  ensures (inv(s) ==> alwaysRegistrationIds(setPriority(s, hookId, priority, finite)))
  ensures (inv(s) ==> alwaysDispatchBounds(setPriority(s, hookId, priority, finite)))
  ensures (inv(s) ==> stepCountersNeverReset(s, setPriority(s, hookId, priority, finite)))
  ensures (inv(s) ==> stepSnapshotsImmutable(s, "setPriority", setPriority(s, hookId, priority, finite)))
{
  if inv(s) {
    var t := setPriority(s, hookId, priority, finite);
    forall i | 0 <= i < |s.registrations|
      ensures t.registrations[i].id == s.registrations[i].id
    {}
    HookIdentitiesPreserved(s,t);
    assert t.calls == s.calls;
  }
}

lemma register_ensures(s: HookService, handler: int, metadata: HookMetadata, names: seq<string>, requirements: HookRequirement, registeredAt: int, finite: bool)
  ensures (inv(s) ==> canRegister(s, handler, metadata, names, requirements, registeredAt, finite) ==> alwaysRegistrationIds(register(s, handler, metadata, names, requirements, registeredAt, finite)))
  ensures (inv(s) ==> canRegister(s, handler, metadata, names, requirements, registeredAt, finite) ==> alwaysDispatchBounds(register(s, handler, metadata, names, requirements, registeredAt, finite)))
  ensures (inv(s) ==> canRegister(s, handler, metadata, names, requirements, registeredAt, finite) ==> stepCountersNeverReset(s, register(s, handler, metadata, names, requirements, registeredAt, finite)))
  ensures (inv(s) ==> canRegister(s, handler, metadata, names, requirements, registeredAt, finite) ==> stepSnapshotsImmutable(s, "register", register(s, handler, metadata, names, requirements, registeredAt, finite)))
{
  if inv(s) && canRegister(s, handler, metadata, names, requirements, registeredAt, finite) {
    var t := register(s, handler, metadata, names, requirements, registeredAt, finite);
    var row := t.registrations[|s.registrations|];
    assert t.registrations == s.registrations + [row];
    HookIdentityAdded(s,t,row);
    assert t.calls == s.calls;
  }
}

lemma beginHandler_ensures(s: HookService, callId: int)
  ensures (inv(s) ==> canBeginHandler(s, callId) ==> alwaysRegistrationIds(beginHandler(s, callId)))
  ensures (inv(s) ==> canBeginHandler(s, callId) ==> alwaysDispatchBounds(beginHandler(s, callId)))
  ensures (inv(s) ==> canBeginHandler(s, callId) ==> stepCountersNeverReset(s, beginHandler(s, callId)))
  ensures (inv(s) ==> canBeginHandler(s, callId) ==> stepSnapshotsImmutable(s, "beginHandler", beginHandler(s, callId)))
{
  if inv(s) && canBeginHandler(s, callId) {
    var t := beginHandler(s, callId);
    HookCallsBridge(s);
    forall i | 0 <= i < |s.calls|
      ensures t.calls[i].id == s.calls[i].id && validCall(t.calls[i])
      ensures t.calls[i].payloadRef == s.calls[i].payloadRef && t.calls[i].snapshot == s.calls[i].snapshot
    {
      var oldRow := s.calls[i];
      assert oldRow in s.calls;
      if oldRow.id == callId {
        ProofLib.FilterCountOneIffUnique((other: EventHookCall) => other.id == callId,s.calls,(other: EventHookCall) => other.id,i);
        var matchedIndex :| 0 <= matchedIndex < |s.calls| && s.calls[matchedIndex].id == callId &&
          !s.calls[matchedIndex].done && s.calls[matchedIndex].runningHandler == 0 && s.calls[matchedIndex].nextIndex < |s.calls[matchedIndex].snapshot|;
        assert matchedIndex == i;
      }
    }
    HookCallBoundsMapped(s,t);
    HookCallSnapshotPrefix(s,"beginHandler",t);
  }
}

lemma finishHandler_ensures(s: HookService, callId: int, errorRef: int)
  ensures (inv(s) ==> canFinishHandler(s, callId, errorRef) ==> alwaysRegistrationIds(finishHandler(s, callId, errorRef)))
  ensures (inv(s) ==> canFinishHandler(s, callId, errorRef) ==> alwaysDispatchBounds(finishHandler(s, callId, errorRef)))
  ensures (inv(s) ==> canFinishHandler(s, callId, errorRef) ==> stepCountersNeverReset(s, finishHandler(s, callId, errorRef)))
  ensures (inv(s) ==> canFinishHandler(s, callId, errorRef) ==> stepSnapshotsImmutable(s, "finishHandler", finishHandler(s, callId, errorRef)))
{
  if inv(s) && canFinishHandler(s, callId, errorRef) {
    var t := finishHandler(s, callId, errorRef);
    HookCallsBridge(s);
    forall i | 0 <= i < |s.calls|
      ensures t.calls[i].id == s.calls[i].id && validCall(t.calls[i])
      ensures t.calls[i].payloadRef == s.calls[i].payloadRef && t.calls[i].snapshot == s.calls[i].snapshot
    {
      var oldRow := s.calls[i];
      assert oldRow in s.calls;
      if oldRow.id == callId {
        ProofLib.FilterCountOneIffUnique((other: EventHookCall) => other.id == callId,s.calls,(other: EventHookCall) => other.id,i);
        var matchedIndex :| 0 <= matchedIndex < |s.calls| && s.calls[matchedIndex].id == callId &&
          s.calls[matchedIndex].runningHandler > 0;
        assert matchedIndex == i;
      }
    }
    HookCallBoundsMapped(s,t);
    HookCallSnapshotPrefix(s,"finishHandler",t);
  }
}

lemma dispatch_ensures(s: HookService, callId: int, owner: int, payloadRef: int, eventName: string, foundBins: seq<string>, platform: string, environment: seq<string>, pathPresent: bool, path: string)
  ensures (inv(s) ==> canDispatch(s, callId, owner, payloadRef, eventName) ==> alwaysRegistrationIds(dispatch(s, callId, owner, payloadRef, eventName, foundBins, platform, environment, pathPresent, path)))
  ensures (inv(s) ==> canDispatch(s, callId, owner, payloadRef, eventName) ==> alwaysDispatchBounds(dispatch(s, callId, owner, payloadRef, eventName, foundBins, platform, environment, pathPresent, path)))
  ensures (inv(s) ==> canDispatch(s, callId, owner, payloadRef, eventName) ==> stepCountersNeverReset(s, dispatch(s, callId, owner, payloadRef, eventName, foundBins, platform, environment, pathPresent, path)))
  ensures (inv(s) ==> canDispatch(s, callId, owner, payloadRef, eventName) ==> stepSnapshotsImmutable(s, "dispatch", dispatch(s, callId, owner, payloadRef, eventName, foundBins, platform, environment, pathPresent, path)))
{
  if inv(s) && canDispatch(s, callId, owner, payloadRef, eventName) {
    var t := dispatch(s, callId, owner, payloadRef, eventName, foundBins, platform, environment, pathPresent, path);
    var row := t.calls[|s.calls|];
    assert t.calls == s.calls + [row];
    HookCallAdded(s,t,row);
    HookCallSnapshotPrefix(s,"dispatch",t);
  }
}

lemma observeEventArray_ensures(s: HookService, reference: int, names: seq<string>)
  ensures (inv(s) ==> canObserveEventArray(s, reference, names) ==> alwaysRegistrationIds(observeEventArray(s, reference, names)))
  ensures (inv(s) ==> canObserveEventArray(s, reference, names) ==> alwaysDispatchBounds(observeEventArray(s, reference, names)))
  ensures (inv(s) ==> canObserveEventArray(s, reference, names) ==> stepCountersNeverReset(s, observeEventArray(s, reference, names)))
  ensures (inv(s) ==> canObserveEventArray(s, reference, names) ==> stepSnapshotsImmutable(s, "observeEventArray", observeEventArray(s, reference, names)))
{
  if inv(s) && canObserveEventArray(s, reference, names) {
    assert observeEventArray(s, reference, names).calls == s.calls;
  }
}

lemma observeRequirements_ensures(s: HookService, reference: int, requirements: HookRequirement)
  ensures (inv(s) ==> canObserveRequirements(s, reference, requirements) ==> alwaysRegistrationIds(observeRequirements(s, reference, requirements)))
  ensures (inv(s) ==> canObserveRequirements(s, reference, requirements) ==> alwaysDispatchBounds(observeRequirements(s, reference, requirements)))
  ensures (inv(s) ==> canObserveRequirements(s, reference, requirements) ==> stepCountersNeverReset(s, observeRequirements(s, reference, requirements)))
  ensures (inv(s) ==> canObserveRequirements(s, reference, requirements) ==> stepSnapshotsImmutable(s, "observeRequirements", observeRequirements(s, reference, requirements)))
{
  if inv(s) && canObserveRequirements(s, reference, requirements) {
    assert observeRequirements(s, reference, requirements).calls == s.calls;
  }
}

lemma installInterceptors_ensures(s: HookService, owner: int)
  ensures (inv(s) ==> canInstallInterceptors(s, owner) ==> alwaysRegistrationIds(installInterceptors(s, owner)))
  ensures (inv(s) ==> canInstallInterceptors(s, owner) ==> alwaysDispatchBounds(installInterceptors(s, owner)))
  ensures (inv(s) ==> canInstallInterceptors(s, owner) ==> stepCountersNeverReset(s, installInterceptors(s, owner)))
  ensures (inv(s) ==> canInstallInterceptors(s, owner) ==> stepSnapshotsImmutable(s, "installInterceptors", installInterceptors(s, owner)))
{
  if inv(s) && canInstallInterceptors(s, owner) {
    assert installInterceptors(s, owner).calls == s.calls;
  }
}

lemma setConfig_ensures(s: HookService, configIdentity: int, config: seq<ConfigField>)
  ensures (inv(s) ==> canSetConfig(s, configIdentity, config) ==> alwaysRegistrationIds(setConfig(s, configIdentity, config)))
  ensures (inv(s) ==> canSetConfig(s, configIdentity, config) ==> alwaysDispatchBounds(setConfig(s, configIdentity, config)))
  ensures (inv(s) ==> canSetConfig(s, configIdentity, config) ==> stepCountersNeverReset(s, setConfig(s, configIdentity, config)))
  ensures (inv(s) ==> canSetConfig(s, configIdentity, config) ==> stepSnapshotsImmutable(s, "setConfig", setConfig(s, configIdentity, config)))
{
  if inv(s) && canSetConfig(s, configIdentity, config) {
    assert setConfig(s, configIdentity, config).calls == s.calls;
  }
}

lemma updateConfigReference_ensures(s: HookService, configIdentity: int, config: seq<ConfigField>)
  ensures (inv(s) ==> canUpdateConfigReference(s, configIdentity, config) ==> alwaysRegistrationIds(updateConfigReference(s, configIdentity, config)))
  ensures (inv(s) ==> canUpdateConfigReference(s, configIdentity, config) ==> alwaysDispatchBounds(updateConfigReference(s, configIdentity, config)))
  ensures (inv(s) ==> canUpdateConfigReference(s, configIdentity, config) ==> stepCountersNeverReset(s, updateConfigReference(s, configIdentity, config)))
  ensures (inv(s) ==> canUpdateConfigReference(s, configIdentity, config) ==> stepSnapshotsImmutable(s, "updateConfigReference", updateConfigReference(s, configIdentity, config)))
{
  if inv(s) && canUpdateConfigReference(s, configIdentity, config) {
    assert updateConfigReference(s, configIdentity, config).calls == s.calls;
  }
}

lemma checkRequirements_ensures(s: HookService, requirements: HookRequirement, foundBins: seq<string>, platform: string, environment: seq<string>, pathPresent: bool, path: string, config: seq<ConfigField>, hasConfig: bool)
  ensures (inv(s) ==> alwaysRegistrationIds(checkRequirements(s, requirements, foundBins, platform, environment, pathPresent, path, config, hasConfig)))
  ensures (inv(s) ==> alwaysDispatchBounds(checkRequirements(s, requirements, foundBins, platform, environment, pathPresent, path, config, hasConfig)))
  ensures (inv(s) ==> stepCountersNeverReset(s, checkRequirements(s, requirements, foundBins, platform, environment, pathPresent, path, config, hasConfig)))
  ensures (inv(s) ==> stepSnapshotsImmutable(s, "checkRequirements", checkRequirements(s, requirements, foundBins, platform, environment, pathPresent, path, config, hasConfig)))
{
  if inv(s) {
    assert checkRequirements(s, requirements, foundBins, platform, environment, pathPresent, path, config, hasConfig).calls == s.calls;
  }
}

lemma checkEligibility_ensures(s: HookService, hookId: int, foundBins: seq<string>, platform: string, environment: seq<string>, pathPresent: bool, path: string)
  ensures (inv(s) ==> alwaysRegistrationIds(checkEligibility(s, hookId, foundBins, platform, environment, pathPresent, path)))
  ensures (inv(s) ==> alwaysDispatchBounds(checkEligibility(s, hookId, foundBins, platform, environment, pathPresent, path)))
  ensures (inv(s) ==> stepCountersNeverReset(s, checkEligibility(s, hookId, foundBins, platform, environment, pathPresent, path)))
  ensures (inv(s) ==> stepSnapshotsImmutable(s, "checkEligibility", checkEligibility(s, hookId, foundBins, platform, environment, pathPresent, path)))
{
  if inv(s) {
    assert checkEligibility(s, hookId, foundBins, platform, environment, pathPresent, path).calls == s.calls;
  }
}
