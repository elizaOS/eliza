lemma VoiceTokenValidity(token: core__voice_VoiceToken)
  ensures tokenValid(token) == core__voice_inv(token)
{}

lemma VoiceRegistryKnownTokens(r: VoiceRegistry)
  requires inv(r)
  ensures forall tokenId :: tokenId in r.ids ==> tokenId in r.tokens
{
  forall tokenId | tokenId in r.ids ensures tokenId in r.tokens {
    if !(tokenId in r.tokens) {
      assert tokenAt(r, tokenId) == emptyEntry;
      assert tokenAt(r, tokenId).token.phase.Unconstructed?;
    }
  }
}

lemma VoiceRegistryTokenUpdated(r: VoiceRegistry, tokenId: int, token: core__voice_VoiceToken)
  requires inv(r) && tokenId in r.ids
  requires core__voice_inv(token) && !token.phase.Unconstructed?
  ensures inv(VoiceRegistry(r.serial, r.ids, updatedToken(r, tokenId, token), r.bindings, r.calls, r.returnedTokens, r.returnedBulk, r.returnedAbort))
  ensures tokenAt(VoiceRegistry(r.serial, r.ids, updatedToken(r, tokenId, token), r.bindings, r.calls, r.returnedTokens, r.returnedBulk, r.returnedAbort), tokenId).token == token
  ensures forall id :: id in r.ids ==> tokenAt(VoiceRegistry(r.serial, r.ids, updatedToken(r, tokenId, token), r.bindings, r.calls, r.returnedTokens, r.returnedBulk, r.returnedAbort), id).room == tokenAt(r, id).room
  ensures forall id :: id in r.ids && id != tokenId ==> tokenAt(VoiceRegistry(r.serial, r.ids, updatedToken(r, tokenId, token), r.bindings, r.calls, r.returnedTokens, r.returnedBulk, r.returnedAbort), id) == tokenAt(r, id)
{
  var after := VoiceRegistry(r.serial, r.ids, updatedToken(r, tokenId, token), r.bindings, r.calls, r.returnedTokens, r.returnedBulk, r.returnedAbort);
  VoiceRegistryKnownTokens(r);
  VoiceTokenValidity(token);
  forall id | id in r.ids
    ensures tokenAt(after, id).room == tokenAt(r, id).room
    ensures id != tokenId ==> tokenAt(after, id) == tokenAt(r, id)
    ensures tokenValid(tokenAt(after, id).token) && !tokenAt(after, id).token.phase.Unconstructed?
  {
    if id == tokenId { assert tokenAt(after, id).token == token; }
    else { assert tokenAt(after, id) == tokenAt(r, id); }
  }
}

lemma unlinkToken_ensures(r: VoiceRegistry, tokenId: int)
  ensures (inv(r) ==> canUnlinkToken(r, tokenId) ==> alwaysReturnedTokensExist(unlinkToken(r, tokenId)))
  ensures (inv(r) ==> canUnlinkToken(r, tokenId) ==> alwaysCapturedTokensExist(unlinkToken(r, tokenId)))
  ensures (inv(r) ==> canUnlinkToken(r, tokenId) ==> alwaysTokensOwned(unlinkToken(r, tokenId)))
  ensures (inv(r) ==> canUnlinkToken(r, tokenId) ==> alwaysBindingOwnership(unlinkToken(r, tokenId)))
  ensures (inv(r) ==> canUnlinkToken(r, tokenId) ==> alwaysCallStages(unlinkToken(r, tokenId)))
  ensures (inv(r) ==> canUnlinkToken(r, tokenId) ==> alwaysAllocatedTokensConstructed(unlinkToken(r, tokenId)))
  ensures (inv(r) ==> canUnlinkToken(r, tokenId) ==> alwaysCallKindsAndReason(unlinkToken(r, tokenId)))
  ensures (inv(r) ==> canUnlinkToken(r, tokenId) ==> alwaysCreatedTokenKeepsRoom(unlinkToken(r, tokenId)))
  ensures (inv(r) ==> canUnlinkToken(r, tokenId) ==> stepClearRetainsTokens(r, "unlinkToken", unlinkToken(r, tokenId)))
{
  if inv(r) && canUnlinkToken(r, tokenId) {
    var token := tokenAt(r, tokenId).token;
    VoiceTokenValidity(token);
    core__voice_unlink_ensures(token);
    var changed := core__voice_unlink(token);
    VoiceRegistryTokenUpdated(r, tokenId, changed);
  }
}

lemma snapshotToken_ensures(r: VoiceRegistry, tokenId: int)
  ensures (inv(r) ==> canSnapshotToken(r, tokenId) ==> alwaysReturnedTokensExist(snapshotToken(r, tokenId)))
  ensures (inv(r) ==> canSnapshotToken(r, tokenId) ==> alwaysCapturedTokensExist(snapshotToken(r, tokenId)))
  ensures (inv(r) ==> canSnapshotToken(r, tokenId) ==> alwaysTokensOwned(snapshotToken(r, tokenId)))
  ensures (inv(r) ==> canSnapshotToken(r, tokenId) ==> alwaysBindingOwnership(snapshotToken(r, tokenId)))
  ensures (inv(r) ==> canSnapshotToken(r, tokenId) ==> alwaysCallStages(snapshotToken(r, tokenId)))
  ensures (inv(r) ==> canSnapshotToken(r, tokenId) ==> alwaysAllocatedTokensConstructed(snapshotToken(r, tokenId)))
  ensures (inv(r) ==> canSnapshotToken(r, tokenId) ==> alwaysCallKindsAndReason(snapshotToken(r, tokenId)))
  ensures (inv(r) ==> canSnapshotToken(r, tokenId) ==> alwaysCreatedTokenKeepsRoom(snapshotToken(r, tokenId)))
  ensures (inv(r) ==> canSnapshotToken(r, tokenId) ==> stepClearRetainsTokens(r, "snapshotToken", snapshotToken(r, tokenId)))
{
  if inv(r) && canSnapshotToken(r, tokenId) {
    var token := tokenAt(r, tokenId).token;
    VoiceTokenValidity(token);
    core__voice_snapshotListeners_ensures(token);
    var changed := core__voice_snapshotListeners(token);
    VoiceRegistryTokenUpdated(r, tokenId, changed);
  }
}

lemma deliverTokenCallback_ensures(r: VoiceRegistry, tokenId: int)
  ensures (inv(r) ==> canDeliverTokenCallback(r, tokenId) ==> alwaysReturnedTokensExist(deliverTokenCallback(r, tokenId)))
  ensures (inv(r) ==> canDeliverTokenCallback(r, tokenId) ==> alwaysCapturedTokensExist(deliverTokenCallback(r, tokenId)))
  ensures (inv(r) ==> canDeliverTokenCallback(r, tokenId) ==> alwaysTokensOwned(deliverTokenCallback(r, tokenId)))
  ensures (inv(r) ==> canDeliverTokenCallback(r, tokenId) ==> alwaysBindingOwnership(deliverTokenCallback(r, tokenId)))
  ensures (inv(r) ==> canDeliverTokenCallback(r, tokenId) ==> alwaysCallStages(deliverTokenCallback(r, tokenId)))
  ensures (inv(r) ==> canDeliverTokenCallback(r, tokenId) ==> alwaysAllocatedTokensConstructed(deliverTokenCallback(r, tokenId)))
  ensures (inv(r) ==> canDeliverTokenCallback(r, tokenId) ==> alwaysCallKindsAndReason(deliverTokenCallback(r, tokenId)))
  ensures (inv(r) ==> canDeliverTokenCallback(r, tokenId) ==> alwaysCreatedTokenKeepsRoom(deliverTokenCallback(r, tokenId)))
  ensures (inv(r) ==> canDeliverTokenCallback(r, tokenId) ==> stepClearRetainsTokens(r, "deliverTokenCallback", deliverTokenCallback(r, tokenId)))
{
  if inv(r) && canDeliverTokenCallback(r, tokenId) {
    var token := tokenAt(r, tokenId).token;
    VoiceTokenValidity(token);
    core__voice_deliverNext_ensures(token);
    var changed := core__voice_deliverNext(token);
    VoiceRegistryTokenUpdated(r, tokenId, changed);
  }
}

lemma finishUserCallback_ensures(r: VoiceRegistry, tokenId: int, successful: bool)
  ensures (inv(r) ==> canFinishUserCallback(r, tokenId, successful) ==> alwaysReturnedTokensExist(finishUserCallback(r, tokenId, successful)))
  ensures (inv(r) ==> canFinishUserCallback(r, tokenId, successful) ==> alwaysCapturedTokensExist(finishUserCallback(r, tokenId, successful)))
  ensures (inv(r) ==> canFinishUserCallback(r, tokenId, successful) ==> alwaysTokensOwned(finishUserCallback(r, tokenId, successful)))
  ensures (inv(r) ==> canFinishUserCallback(r, tokenId, successful) ==> alwaysBindingOwnership(finishUserCallback(r, tokenId, successful)))
  ensures (inv(r) ==> canFinishUserCallback(r, tokenId, successful) ==> alwaysCallStages(finishUserCallback(r, tokenId, successful)))
  ensures (inv(r) ==> canFinishUserCallback(r, tokenId, successful) ==> alwaysAllocatedTokensConstructed(finishUserCallback(r, tokenId, successful)))
  ensures (inv(r) ==> canFinishUserCallback(r, tokenId, successful) ==> alwaysCallKindsAndReason(finishUserCallback(r, tokenId, successful)))
  ensures (inv(r) ==> canFinishUserCallback(r, tokenId, successful) ==> alwaysCreatedTokenKeepsRoom(finishUserCallback(r, tokenId, successful)))
  ensures (inv(r) ==> canFinishUserCallback(r, tokenId, successful) ==> stepClearRetainsTokens(r, "finishUserCallback", finishUserCallback(r, tokenId, successful)))
{
  if inv(r) && canFinishUserCallback(r, tokenId, successful) {
    var token := tokenAt(r, tokenId).token;
    VoiceTokenValidity(token);
    core__voice_finishCallback_ensures(token, successful);
    var changed := core__voice_finishCallback(token, successful);
    VoiceRegistryTokenUpdated(r, tokenId, changed);
  }
}

lemma clearTokenListeners_ensures(r: VoiceRegistry, tokenId: int)
  ensures (inv(r) ==> canClearTokenListeners(r, tokenId) ==> alwaysReturnedTokensExist(clearTokenListeners(r, tokenId)))
  ensures (inv(r) ==> canClearTokenListeners(r, tokenId) ==> alwaysCapturedTokensExist(clearTokenListeners(r, tokenId)))
  ensures (inv(r) ==> canClearTokenListeners(r, tokenId) ==> alwaysTokensOwned(clearTokenListeners(r, tokenId)))
  ensures (inv(r) ==> canClearTokenListeners(r, tokenId) ==> alwaysBindingOwnership(clearTokenListeners(r, tokenId)))
  ensures (inv(r) ==> canClearTokenListeners(r, tokenId) ==> alwaysCallStages(clearTokenListeners(r, tokenId)))
  ensures (inv(r) ==> canClearTokenListeners(r, tokenId) ==> alwaysAllocatedTokensConstructed(clearTokenListeners(r, tokenId)))
  ensures (inv(r) ==> canClearTokenListeners(r, tokenId) ==> alwaysCallKindsAndReason(clearTokenListeners(r, tokenId)))
  ensures (inv(r) ==> canClearTokenListeners(r, tokenId) ==> alwaysCreatedTokenKeepsRoom(clearTokenListeners(r, tokenId)))
  ensures (inv(r) ==> canClearTokenListeners(r, tokenId) ==> stepClearRetainsTokens(r, "clearTokenListeners", clearTokenListeners(r, tokenId)))
{
  if inv(r) && canClearTokenListeners(r, tokenId) {
    var token := tokenAt(r, tokenId).token;
    VoiceTokenValidity(token);
    core__voice_clearListeners_ensures(token);
    var changed := core__voice_clearListeners(token);
    VoiceRegistryTokenUpdated(r, tokenId, changed);
  }
}

lemma abortTokenSignal_ensures(r: VoiceRegistry, tokenId: int)
  ensures (inv(r) ==> canAbortTokenSignal(r, tokenId) ==> alwaysReturnedTokensExist(abortTokenSignal(r, tokenId)))
  ensures (inv(r) ==> canAbortTokenSignal(r, tokenId) ==> alwaysCapturedTokensExist(abortTokenSignal(r, tokenId)))
  ensures (inv(r) ==> canAbortTokenSignal(r, tokenId) ==> alwaysTokensOwned(abortTokenSignal(r, tokenId)))
  ensures (inv(r) ==> canAbortTokenSignal(r, tokenId) ==> alwaysBindingOwnership(abortTokenSignal(r, tokenId)))
  ensures (inv(r) ==> canAbortTokenSignal(r, tokenId) ==> alwaysCallStages(abortTokenSignal(r, tokenId)))
  ensures (inv(r) ==> canAbortTokenSignal(r, tokenId) ==> alwaysAllocatedTokensConstructed(abortTokenSignal(r, tokenId)))
  ensures (inv(r) ==> canAbortTokenSignal(r, tokenId) ==> alwaysCallKindsAndReason(abortTokenSignal(r, tokenId)))
  ensures (inv(r) ==> canAbortTokenSignal(r, tokenId) ==> alwaysCreatedTokenKeepsRoom(abortTokenSignal(r, tokenId)))
  ensures (inv(r) ==> canAbortTokenSignal(r, tokenId) ==> stepClearRetainsTokens(r, "abortTokenSignal", abortTokenSignal(r, tokenId)))
{
  if inv(r) && canAbortTokenSignal(r, tokenId) {
    var token := tokenAt(r, tokenId).token;
    VoiceTokenValidity(token);
    core__voice_abortSignal_ensures(token);
    var changed := core__voice_abortSignal(token);
    VoiceRegistryTokenUpdated(r, tokenId, changed);
  }
}

lemma subscribeUser_ensures(r: VoiceRegistry, tokenId: int, listenerId: int)
  ensures (inv(r) ==> canSubscribeUser(r, tokenId, listenerId) ==> alwaysReturnedTokensExist(subscribeUser(r, tokenId, listenerId)))
  ensures (inv(r) ==> canSubscribeUser(r, tokenId, listenerId) ==> alwaysCapturedTokensExist(subscribeUser(r, tokenId, listenerId)))
  ensures (inv(r) ==> canSubscribeUser(r, tokenId, listenerId) ==> alwaysTokensOwned(subscribeUser(r, tokenId, listenerId)))
  ensures (inv(r) ==> canSubscribeUser(r, tokenId, listenerId) ==> alwaysBindingOwnership(subscribeUser(r, tokenId, listenerId)))
  ensures (inv(r) ==> canSubscribeUser(r, tokenId, listenerId) ==> alwaysCallStages(subscribeUser(r, tokenId, listenerId)))
  ensures (inv(r) ==> canSubscribeUser(r, tokenId, listenerId) ==> alwaysAllocatedTokensConstructed(subscribeUser(r, tokenId, listenerId)))
  ensures (inv(r) ==> canSubscribeUser(r, tokenId, listenerId) ==> alwaysCallKindsAndReason(subscribeUser(r, tokenId, listenerId)))
  ensures (inv(r) ==> canSubscribeUser(r, tokenId, listenerId) ==> alwaysCreatedTokenKeepsRoom(subscribeUser(r, tokenId, listenerId)))
  ensures (inv(r) ==> canSubscribeUser(r, tokenId, listenerId) ==> stepClearRetainsTokens(r, "subscribeUser", subscribeUser(r, tokenId, listenerId)))
{
  if inv(r) && canSubscribeUser(r, tokenId, listenerId) {
    var token := tokenAt(r, tokenId).token;
    VoiceTokenValidity(token);
    core__voice_subscribe_ensures(token, listenerId);
    var changed := core__voice_subscribe(token, listenerId);
    VoiceRegistryTokenUpdated(r, tokenId, changed);
  }
}

lemma disposeUser_ensures(r: VoiceRegistry, tokenId: int, handleId: int)
  ensures (inv(r) ==> canDisposeUser(r, tokenId, handleId) ==> alwaysReturnedTokensExist(disposeUser(r, tokenId, handleId)))
  ensures (inv(r) ==> canDisposeUser(r, tokenId, handleId) ==> alwaysCapturedTokensExist(disposeUser(r, tokenId, handleId)))
  ensures (inv(r) ==> canDisposeUser(r, tokenId, handleId) ==> alwaysTokensOwned(disposeUser(r, tokenId, handleId)))
  ensures (inv(r) ==> canDisposeUser(r, tokenId, handleId) ==> alwaysBindingOwnership(disposeUser(r, tokenId, handleId)))
  ensures (inv(r) ==> canDisposeUser(r, tokenId, handleId) ==> alwaysCallStages(disposeUser(r, tokenId, handleId)))
  ensures (inv(r) ==> canDisposeUser(r, tokenId, handleId) ==> alwaysAllocatedTokensConstructed(disposeUser(r, tokenId, handleId)))
  ensures (inv(r) ==> canDisposeUser(r, tokenId, handleId) ==> alwaysCallKindsAndReason(disposeUser(r, tokenId, handleId)))
  ensures (inv(r) ==> canDisposeUser(r, tokenId, handleId) ==> alwaysCreatedTokenKeepsRoom(disposeUser(r, tokenId, handleId)))
  ensures (inv(r) ==> canDisposeUser(r, tokenId, handleId) ==> stepClearRetainsTokens(r, "disposeUser", disposeUser(r, tokenId, handleId)))
{
  if inv(r) && canDisposeUser(r, tokenId, handleId) {
    var token := tokenAt(r, tokenId).token;
    VoiceTokenValidity(token);
    core__voice_disposeListener_ensures(token, handleId);
    var changed := core__voice_disposeListener(token, handleId);
    VoiceRegistryTokenUpdated(r, tokenId, changed);
  }
}

lemma externalTokenAbort_ensures(r: VoiceRegistry, tokenId: int)
  ensures (inv(r) ==> canExternalTokenAbort(r, tokenId) ==> alwaysReturnedTokensExist(externalTokenAbort(r, tokenId)))
  ensures (inv(r) ==> canExternalTokenAbort(r, tokenId) ==> alwaysCapturedTokensExist(externalTokenAbort(r, tokenId)))
  ensures (inv(r) ==> canExternalTokenAbort(r, tokenId) ==> alwaysTokensOwned(externalTokenAbort(r, tokenId)))
  ensures (inv(r) ==> canExternalTokenAbort(r, tokenId) ==> alwaysBindingOwnership(externalTokenAbort(r, tokenId)))
  ensures (inv(r) ==> canExternalTokenAbort(r, tokenId) ==> alwaysCallStages(externalTokenAbort(r, tokenId)))
  ensures (inv(r) ==> canExternalTokenAbort(r, tokenId) ==> alwaysAllocatedTokensConstructed(externalTokenAbort(r, tokenId)))
  ensures (inv(r) ==> canExternalTokenAbort(r, tokenId) ==> alwaysCallKindsAndReason(externalTokenAbort(r, tokenId)))
  ensures (inv(r) ==> canExternalTokenAbort(r, tokenId) ==> alwaysCreatedTokenKeepsRoom(externalTokenAbort(r, tokenId)))
  ensures (inv(r) ==> canExternalTokenAbort(r, tokenId) ==> stepClearRetainsTokens(r, "externalTokenAbort", externalTokenAbort(r, tokenId)))
{
  if inv(r) && canExternalTokenAbort(r, tokenId) {
    var token := tokenAt(r, tokenId).token;
    VoiceTokenValidity(token);
    core__voice_externalAbort_ensures(token);
    var changed := core__voice_externalAbort(token);
    VoiceRegistryTokenUpdated(r, tokenId, changed);
  }
}

lemma VoiceRegistryBindingFacts(r: VoiceRegistry)
  ensures alwaysBindingOwnership(r) == (forall binding :: binding in r.bindings ==> binding.tokenId in r.ids && tokenAt(r, binding.tokenId).room == binding.room && |ProofLib.Filter((other: VoiceBinding) => other.room == binding.room, r.bindings)| == 1)
{}

lemma VoiceRegistryActiveKnown(r: VoiceRegistry, room: string)
  requires inv(r)
  ensures activeId(r, room) == 0 || activeId(r, room) in r.ids
  ensures activeId(r, room) == 0 || tokenAt(r, activeId(r, room)).room == room
{
  VoiceRegistryBindingFacts(r);
  assert activeId(r, room) == (if |ProofLib.Filter((binding: VoiceBinding) => binding.room == room, r.bindings)| > 0 then ProofLib.Filter((binding: VoiceBinding) => binding.room == room, r.bindings)[0].tokenId else 0);
  var selected := ProofLib.Filter((binding: VoiceBinding) => binding.room == room, r.bindings);
  if |selected| > 0 {
    ProofLib.FilterMember((binding: VoiceBinding) => binding.room == room, r.bindings, selected[0]);
  }
}

lemma VoiceRegistryFilteredBindings(r: VoiceRegistry, tokenId: int)
  requires inv(r)
  ensures inv(r.(bindings := ProofLib.Filter((binding: VoiceBinding) => binding.tokenId != tokenId, r.bindings)))
{
  var after := r.(bindings := ProofLib.Filter((binding: VoiceBinding) => binding.tokenId != tokenId, r.bindings));
  VoiceRegistryBindingFacts(r); VoiceRegistryBindingFacts(after);
  forall binding | binding in after.bindings
    ensures binding.tokenId in after.ids && tokenAt(after, binding.tokenId).room == binding.room
    ensures |ProofLib.Filter((other: VoiceBinding) => other.room == binding.room, after.bindings)| == 1
  {
    ProofLib.FilterMember((binding: VoiceBinding) => binding.tokenId != tokenId, r.bindings, binding);
    ProofLib.FilterOfFilterShorter((binding: VoiceBinding) => binding.tokenId != tokenId, (other: VoiceBinding) => other.room == binding.room, r.bindings);
    ProofLib.FilterMember((other: VoiceBinding) => other.room == binding.room, after.bindings, binding);
  }
}

lemma beginArm_ensures(r: VoiceRegistry, options: VoiceArmOptions, parentToken: int, parentCall: int)
  ensures (inv(r) ==> canBeginArm(r, options, parentToken, parentCall) ==> alwaysReturnedTokensExist(beginArm(r, options, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginArm(r, options, parentToken, parentCall) ==> alwaysCapturedTokensExist(beginArm(r, options, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginArm(r, options, parentToken, parentCall) ==> alwaysTokensOwned(beginArm(r, options, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginArm(r, options, parentToken, parentCall) ==> alwaysBindingOwnership(beginArm(r, options, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginArm(r, options, parentToken, parentCall) ==> alwaysCallStages(beginArm(r, options, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginArm(r, options, parentToken, parentCall) ==> alwaysAllocatedTokensConstructed(beginArm(r, options, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginArm(r, options, parentToken, parentCall) ==> alwaysCallKindsAndReason(beginArm(r, options, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginArm(r, options, parentToken, parentCall) ==> alwaysCreatedTokenKeepsRoom(beginArm(r, options, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginArm(r, options, parentToken, parentCall) ==> stepClearRetainsTokens(r, "beginArm", beginArm(r, options, parentToken, parentCall)))
{
  if inv(r) && canBeginArm(r, options, parentToken, parentCall) {
    VoiceRegistryActiveKnown(r, options.room);
  }
}

lemma beginRoomAbort_ensures(r: VoiceRegistry, room: string, reason: core__voice_CancelReason, parentToken: int, parentCall: int)
  ensures (inv(r) ==> canBeginRoomAbort(r, room, reason, parentToken, parentCall) ==> alwaysReturnedTokensExist(beginRoomAbort(r, room, reason, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginRoomAbort(r, room, reason, parentToken, parentCall) ==> alwaysCapturedTokensExist(beginRoomAbort(r, room, reason, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginRoomAbort(r, room, reason, parentToken, parentCall) ==> alwaysTokensOwned(beginRoomAbort(r, room, reason, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginRoomAbort(r, room, reason, parentToken, parentCall) ==> alwaysBindingOwnership(beginRoomAbort(r, room, reason, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginRoomAbort(r, room, reason, parentToken, parentCall) ==> alwaysCallStages(beginRoomAbort(r, room, reason, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginRoomAbort(r, room, reason, parentToken, parentCall) ==> alwaysAllocatedTokensConstructed(beginRoomAbort(r, room, reason, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginRoomAbort(r, room, reason, parentToken, parentCall) ==> alwaysCallKindsAndReason(beginRoomAbort(r, room, reason, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginRoomAbort(r, room, reason, parentToken, parentCall) ==> alwaysCreatedTokenKeepsRoom(beginRoomAbort(r, room, reason, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginRoomAbort(r, room, reason, parentToken, parentCall) ==> stepClearRetainsTokens(r, "beginRoomAbort", beginRoomAbort(r, room, reason, parentToken, parentCall)))
{
  if inv(r) && canBeginRoomAbort(r, room, reason, parentToken, parentCall) {
    VoiceRegistryActiveKnown(r, room);
  }
}

lemma beginAbortAll_ensures(r: VoiceRegistry, reason: core__voice_CancelReason, parentToken: int, parentCall: int)
  ensures (inv(r) ==> canBeginAbortAll(r, reason, parentToken, parentCall) ==> alwaysReturnedTokensExist(beginAbortAll(r, reason, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginAbortAll(r, reason, parentToken, parentCall) ==> alwaysCapturedTokensExist(beginAbortAll(r, reason, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginAbortAll(r, reason, parentToken, parentCall) ==> alwaysTokensOwned(beginAbortAll(r, reason, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginAbortAll(r, reason, parentToken, parentCall) ==> alwaysBindingOwnership(beginAbortAll(r, reason, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginAbortAll(r, reason, parentToken, parentCall) ==> alwaysCallStages(beginAbortAll(r, reason, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginAbortAll(r, reason, parentToken, parentCall) ==> alwaysAllocatedTokensConstructed(beginAbortAll(r, reason, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginAbortAll(r, reason, parentToken, parentCall) ==> alwaysCallKindsAndReason(beginAbortAll(r, reason, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginAbortAll(r, reason, parentToken, parentCall) ==> alwaysCreatedTokenKeepsRoom(beginAbortAll(r, reason, parentToken, parentCall)))
  ensures (inv(r) ==> canBeginAbortAll(r, reason, parentToken, parentCall) ==> stepClearRetainsTokens(r, "beginAbortAll", beginAbortAll(r, reason, parentToken, parentCall)))
{
  if inv(r) && canBeginAbortAll(r, reason, parentToken, parentCall) {
    VoiceRegistryBindingFacts(r);
  }
}

lemma runCleanupCallback_ensures(r: VoiceRegistry, tokenId: int)
  ensures (inv(r) ==> canRunCleanupCallback(r, tokenId) ==> alwaysReturnedTokensExist(runCleanupCallback(r, tokenId)))
  ensures (inv(r) ==> canRunCleanupCallback(r, tokenId) ==> alwaysCapturedTokensExist(runCleanupCallback(r, tokenId)))
  ensures (inv(r) ==> canRunCleanupCallback(r, tokenId) ==> alwaysTokensOwned(runCleanupCallback(r, tokenId)))
  ensures (inv(r) ==> canRunCleanupCallback(r, tokenId) ==> alwaysBindingOwnership(runCleanupCallback(r, tokenId)))
  ensures (inv(r) ==> canRunCleanupCallback(r, tokenId) ==> alwaysCallStages(runCleanupCallback(r, tokenId)))
  ensures (inv(r) ==> canRunCleanupCallback(r, tokenId) ==> alwaysAllocatedTokensConstructed(runCleanupCallback(r, tokenId)))
  ensures (inv(r) ==> canRunCleanupCallback(r, tokenId) ==> alwaysCallKindsAndReason(runCleanupCallback(r, tokenId)))
  ensures (inv(r) ==> canRunCleanupCallback(r, tokenId) ==> alwaysCreatedTokenKeepsRoom(runCleanupCallback(r, tokenId)))
  ensures (inv(r) ==> canRunCleanupCallback(r, tokenId) ==> stepClearRetainsTokens(r, "runCleanupCallback", runCleanupCallback(r, tokenId)))
{
  if inv(r) && canRunCleanupCallback(r, tokenId) {
    var token := tokenAt(r, tokenId).token;
    VoiceTokenValidity(token);
    core__voice_finishCallback_ensures(token, true);
    var changed := core__voice_finishCallback(token, true);
    VoiceRegistryTokenUpdated(r, tokenId, changed);
    var replaced := r.(tokens := updatedToken(r, tokenId, changed));
    VoiceRegistryFilteredBindings(replaced, tokenId);
    assert runCleanupCallback(r, tokenId).bindings == ProofLib.Filter((binding: VoiceBinding) => binding.tokenId != tokenId, r.bindings);
  }
}

lemma VoiceRegistryAllocated(r: VoiceRegistry, room: string, token: core__voice_VoiceToken)
  requires inv(r)
  requires core__voice_inv(token) && !token.phase.Unconstructed?
  ensures inv(r.(serial := r.serial + 1, ids := r.ids + [r.serial + 1], tokens := r.tokens[r.serial + 1 := VoiceEntry(room, token)]))
{
  var id := r.serial + 1;
  var after := r.(serial := id, ids := r.ids + [id], tokens := r.tokens[id := VoiceEntry(room, token)]);
  VoiceRegistryKnownTokens(r); VoiceTokenValidity(token);
  assert !(id in r.ids);
  forall existing | existing in r.ids
    ensures tokenAt(after, existing) == tokenAt(r, existing)
  {}
  forall existing | existing in after.ids
    ensures existing > 0 && existing <= after.serial && tokenValid(tokenAt(after, existing).token) && !tokenAt(after, existing).token.phase.Unconstructed?
  {
    if existing == id { assert tokenAt(after, id).token == token; }
  }
}

lemma VoiceRegistryRebound(r: VoiceRegistry, room: string, tokenId: int)
  requires inv(r) && tokenId in r.ids && tokenAt(r, tokenId).room == room
  ensures inv(r.(bindings := updatedBindings(r, room, tokenId)))
{
  var after := r.(bindings := updatedBindings(r, room, tokenId));
  VoiceRegistryBindingFacts(r); VoiceRegistryBindingFacts(after);
  if exists entry :: entry in r.bindings && entry.room == room {
    assert |after.bindings| == |r.bindings|;
    forall i | 0 <= i < |after.bindings|
      ensures after.bindings[i].room == r.bindings[i].room
      ensures after.bindings[i] == (if r.bindings[i].room == room then r.bindings[i].(tokenId := tokenId) else r.bindings[i])
    {}
    forall binding | binding in after.bindings
      ensures binding.tokenId in after.ids && tokenAt(after, binding.tokenId).room == binding.room
      ensures |ProofLib.Filter((other: VoiceBinding) => other.room == binding.room, after.bindings)| == 1
    {
      var i :| 0 <= i < |after.bindings| && after.bindings[i] == binding;
      assert r.bindings[i] in r.bindings;
      ProofLib.FilterLengthPointwise((other: VoiceBinding) => other.room == binding.room, (other: VoiceBinding) => other.room == binding.room, r.bindings, after.bindings);
    }
  } else {
    forall binding | binding in after.bindings
      ensures binding.tokenId in after.ids && tokenAt(after, binding.tokenId).room == binding.room
      ensures |ProofLib.Filter((other: VoiceBinding) => other.room == binding.room, after.bindings)| == 1
    {
      ProofLib.FilterAppend((other: VoiceBinding) => other.room == binding.room, r.bindings, VoiceBinding(room, tokenId));
      if binding.room == room { ProofLib.FilterNone((other: VoiceBinding) => other.room == binding.room, r.bindings); }
      else { assert binding in r.bindings; }
    }
  }
}

lemma VoiceRegistryFrameFacts(r: VoiceRegistry)
  ensures (alwaysCapturedTokensExist(r) && alwaysCallStages(r) && alwaysCallKindsAndReason(r) && alwaysCreatedTokenKeepsRoom(r)) == (forall frame :: frame in r.calls ==> validRegistryFrame(r, frame))
{}

lemma VoiceRegistryReframe(r: VoiceRegistry, frame: RegistryCall)
  requires inv(r) && |r.calls| > 0 && validRegistryFrame(r, frame)
  ensures inv(r.(calls := updatedTop(r, frame)))
{
  VoiceRegistryFrameFacts(r);
  var after := r.(calls := updatedTop(r, frame));
  VoiceRegistryFrameFacts(after);
  assert after.calls == r.calls[..|r.calls|-1] + [frame];
  forall item | item in after.calls ensures validRegistryFrame(after, item) {
    if item != frame { assert item in r.calls; }
  }
}

lemma advanceRegistryCall_ensures(r: VoiceRegistry)
  ensures (inv(r) ==> canAdvanceRegistryCall(r) ==> alwaysReturnedTokensExist(advanceRegistryCall(r)))
  ensures (inv(r) ==> canAdvanceRegistryCall(r) ==> alwaysCapturedTokensExist(advanceRegistryCall(r)))
  ensures (inv(r) ==> canAdvanceRegistryCall(r) ==> alwaysTokensOwned(advanceRegistryCall(r)))
  ensures (inv(r) ==> canAdvanceRegistryCall(r) ==> alwaysBindingOwnership(advanceRegistryCall(r)))
  ensures (inv(r) ==> canAdvanceRegistryCall(r) ==> alwaysCallStages(advanceRegistryCall(r)))
  ensures (inv(r) ==> canAdvanceRegistryCall(r) ==> alwaysAllocatedTokensConstructed(advanceRegistryCall(r)))
  ensures (inv(r) ==> canAdvanceRegistryCall(r) ==> alwaysCallKindsAndReason(advanceRegistryCall(r)))
  ensures (inv(r) ==> canAdvanceRegistryCall(r) ==> alwaysCreatedTokenKeepsRoom(advanceRegistryCall(r)))
  ensures (inv(r) ==> canAdvanceRegistryCall(r) ==> stepClearRetainsTokens(r, "advanceRegistryCall", advanceRegistryCall(r)))
{
  if inv(r) && canAdvanceRegistryCall(r) {
    VoiceRegistryKnownTokens(r); VoiceRegistryFrameFacts(r);
    var frame := currentCall(r);
    assert frame in r.calls;
    assert validRegistryFrame(r, frame);
    var previous := tokenAt(r, frame.previous).token;
    if frame.phase.NeedPrevious? {
      var shouldAbort := frame.previous != 0 && previous.reason.Active?;
      var base := r;
      if shouldAbort {
        VoiceTokenValidity(previous);
        core__voice_abort_ensures(previous, frame.reason);
        var changed := core__voice_abort(previous, frame.reason);
        VoiceRegistryTokenUpdated(r, frame.previous, changed);
        base := r.(tokens := updatedToken(r, frame.previous, changed));
      }
      var replacement := frame.(phase := (if shouldAbort then RegistryCallPhase.WaitPrevious else if frame.kind.ArmOperation? then RegistryCallPhase.CreateToken else RegistryCallPhase.ReturnCall), affected := (if shouldAbort && frame.kind.AbortOneOperation? then [frame.room] else frame.affected));
      VoiceRegistryReframe(base, replacement);
    } else if frame.phase.WaitPrevious? {
      VoiceRegistryReframe(r, frame.(phase := (if frame.kind.ArmOperation? then RegistryCallPhase.CreateToken else RegistryCallPhase.ReturnCall)));
    } else if frame.phase.CreateToken? {
      var options := core__voice_VoiceOptions(frame.runId, frame.hasSlot, frame.slot, frame.linked, frame.alreadyAborted);
      core__voice_initialHolds_ensures();
      core__voice_createToken_ensures(core__voice_initial, options);
      var token := core__voice_createToken(core__voice_initial, options);
      VoiceRegistryAllocated(r, frame.room, token);
      var base := r.(serial := r.serial + 1, ids := r.ids + [r.serial + 1], tokens := r.tokens[r.serial + 1 := VoiceEntry(frame.room, token)]);
      var replacement := frame.(created := r.serial + 1, phase := RegistryCallPhase.PublishToken);
      VoiceRegistryReframe(base, replacement);
      assert advanceRegistryCall(r).ids == r.ids + ProofLib.Filter((set_x: int) => !(set_x in r.ids), [r.serial + 1]);
      ProofLib.FilterCons((set_x: int) => !(set_x in r.ids), [r.serial + 1]);
      ProofLib.FilterNil((set_x: int) => !(set_x in r.ids), []);
    } else if frame.phase.PublishToken? {
      VoiceRegistryRebound(r, frame.room, frame.created);
      VoiceRegistryReframe(r.(bindings := updatedBindings(r, frame.room, frame.created)), frame.(phase := RegistryCallPhase.AttachCallback));
    } else if frame.phase.AttachCallback? {
      var token := tokenAt(r, frame.created).token;
      VoiceTokenValidity(token);
      core__voice_subscribeCleanup_ensures(token);
      VoiceRegistryTokenUpdated(r, frame.created, core__voice_subscribeCleanup(token));
      VoiceRegistryReframe(r.(tokens := updatedToken(r, frame.created, core__voice_subscribeCleanup(token))), frame.(phase := RegistryCallPhase.ReturnCall));
    } else if frame.phase.VisitSnapshot? && |frame.pending| > 0 {
      var binding := frame.pending[0];
      var token := tokenAt(r, binding.tokenId).token;
      var shouldAbort := token.reason.Active?;
      var base := r;
      if shouldAbort {
        VoiceTokenValidity(token);
        core__voice_abort_ensures(token, frame.reason);
        VoiceRegistryTokenUpdated(r, binding.tokenId, core__voice_abort(token, frame.reason));
        base := r.(tokens := updatedToken(r, binding.tokenId, core__voice_abort(token, frame.reason)));
      }
      var replacement := frame.(pending := frame.pending[1..], previous := (if shouldAbort then binding.tokenId else 0), room := binding.room, phase := (if shouldAbort then RegistryCallPhase.WaitSnapshot else RegistryCallPhase.VisitSnapshot));
      VoiceRegistryReframe(base, replacement);
    } else if frame.phase.WaitSnapshot? {
      VoiceRegistryReframe(r, frame.(previous := 0, affected := frame.affected + [frame.room], phase := RegistryCallPhase.VisitSnapshot));
    } else if frame.phase.VisitSnapshot? {
      VoiceRegistryReframe(r, frame.(phase := RegistryCallPhase.ReturnCall));
    } else {
      var after := advanceRegistryCall(r);
      VoiceRegistryFrameFacts(after);
      assert after.calls == r.calls[..|r.calls|-1];
      forall item | item in after.calls ensures validRegistryFrame(after, item) { assert item in r.calls; }
    }
  }
}
