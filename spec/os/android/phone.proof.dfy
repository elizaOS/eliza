lemma PhoneAdd(s: CallService, callId: int)
  ensures forall x :: x in addCall(s, callId).issued <==> x in s.issued || x == callId
  ensures forall x :: x in addCall(s, callId).calls <==> x in s.calls || x == callId
  ensures forall x :: x in addCall(s, callId).callbacks <==> x in s.callbacks || x == callId
  ensures forall x :: x in addCall(s, callId).connected <==> x in s.connected || x == callId
  ensures forall x :: x in addCall(s, callId).notifications <==> x in s.notifications || x == callId
  ensures addCall(s, callId).queued == s.queued
{
  var after := addCall(s, callId);
    forall x | x in after.issued ensures x in s.issued || x == callId {
      if x !in s.issued { ProofLib.FilterMember((set_x: int) => !((set_x in s.issued)), [callId], x); }
    }
    assert callId in after.issued by { ProofLib.FilterMember((set_x: int) => !((set_x in s.issued)), [callId], callId); }
    forall x | x in after.calls ensures x in s.calls || x == callId {
      if x !in s.calls { ProofLib.FilterMember((set_x: int) => !((set_x in s.calls)), [callId], x); }
    }
    assert callId in after.calls by { ProofLib.FilterMember((set_x: int) => !((set_x in s.calls)), [callId], callId); }
    forall x | x in after.callbacks ensures x in s.callbacks || x == callId {
      if x !in s.callbacks { ProofLib.FilterMember((set_x: int) => !((set_x in s.callbacks)), [callId], x); }
    }
    assert callId in after.callbacks by { ProofLib.FilterMember((set_x: int) => !((set_x in s.callbacks)), [callId], callId); }
    forall x | x in after.connected ensures x in s.connected || x == callId {
      if x !in s.connected { ProofLib.FilterMember((set_x: int) => !((set_x in s.connected)), [callId], x); }
    }
    assert callId in after.connected by { ProofLib.FilterMember((set_x: int) => !((set_x in s.connected)), [callId], callId); }
    forall x | x in after.notifications ensures x in s.notifications || x == callId {
      if x !in s.notifications { ProofLib.FilterMember((set_x: int) => !((set_x in s.notifications)), [callId], x); }
    }
    assert callId in after.notifications by { ProofLib.FilterMember((set_x: int) => !((set_x in s.notifications)), [callId], callId); }
}

lemma PhoneUpdate(s: CallService, callId: int, isConnected: bool)
  ensures forall x :: x in updateCall(s, callId, isConnected).connected ==> x in s.connected || x == callId
  ensures forall x :: x in updateCall(s, callId, isConnected).queued ==> x in s.queued || x == callId
{
  var after := updateCall(s, callId, isConnected);
    forall x | x in after.queued ensures x in s.queued || x == callId {
      if x !in s.queued { ProofLib.FilterMember((set_x: int) => !((set_x in s.queued)), [callId], x); }
    }
    assert callId in after.queued by { ProofLib.FilterMember((set_x: int) => !((set_x in s.queued)), [callId], callId); }
  if isConnected {
    forall x | x in after.connected ensures x in s.connected || x == callId {
      if x !in s.connected { ProofLib.FilterMember((set_x: int) => !((set_x in s.connected)), [callId], x); }
    }
    assert callId in after.connected by { ProofLib.FilterMember((set_x: int) => !((set_x in s.connected)), [callId], callId); }
  } else {
    forall x | x in after.connected ensures x in s.connected && x != callId {
      ProofLib.FilterMember((set_x: int) => !((set_x in [callId])), s.connected, x);
    }
  }
}

lemma PhoneRemove(s: CallService, callId: int)
  ensures forall x :: x in removeCall(s, callId).calls <==> x in s.calls && x != callId
  ensures forall x :: x in removeCall(s, callId).callbacks <==> x in s.callbacks && x != callId
  ensures forall x :: x in removeCall(s, callId).notifications ==> x in s.notifications && x != callId
{
  var after := removeCall(s, callId);
  forall x ensures x in after.calls <==> x in s.calls && x != callId { ProofLib.FilterMember((set_x: int) => !((set_x in [callId])), s.calls, x); }
  forall x ensures x in after.callbacks <==> x in s.callbacks && x != callId { ProofLib.FilterMember((set_x: int) => !((set_x in [callId])), s.callbacks, x); }
    forall x | x in after.notifications ensures x in s.notifications && x != callId {
      ProofLib.FilterMember((set_x: int) => !((set_x in [callId])), s.notifications, x);
    }
}

lemma PhoneDrain(s: CallService, callId: int)
  ensures forall x :: x in drainCallback(s, callId).queued ==> x in s.queued
  ensures forall x :: x in drainCallback(s, callId).notifications ==> x in s.notifications || (x == callId && callId in s.calls)
{
  var after := drainCallback(s, callId);
    forall x | x in after.queued ensures x in s.queued && x != callId {
      ProofLib.FilterMember((set_x: int) => !((set_x in [callId])), s.queued, x);
    }
  if (callId in s.calls) && (callId in s.callbacks) {
    if callId in s.connected {
      forall x | x in after.notifications ensures x in s.notifications || x == callId {
        if x !in s.notifications { ProofLib.FilterMember((set_x: int) => !((set_x in s.notifications)), [callId], x); }
      }
    } else {
    forall x | x in after.notifications ensures x in s.notifications && x != callId {
      ProofLib.FilterMember((set_x: int) => !((set_x in [callId])), s.notifications, x);
    }
    }
  }
}

lemma addCall_ensures(s: CallService, callId: int)
  ensures (inv(s) ==> canAddCall(s, callId) ==> alwaysCallbacksMatchRegistry(addCall(s, callId)))
  ensures (inv(s) ==> canAddCall(s, callId) ==> alwaysNoticeHasCurrentCall(addCall(s, callId)))
  ensures (inv(s) ==> canAddCall(s, callId) ==> alwaysDestroyedServiceHasNoCalls(addCall(s, callId)))
  ensures (inv(s) ==> canAddCall(s, callId) ==> alwaysRegistryWithinIssued(addCall(s, callId)))
  ensures (inv(s) ==> canAddCall(s, callId) ==> stepRemovedCallStaysRemoved(s, addCall(s, callId)))
{
  if inv(s) && canAddCall(s, callId) {
    PhoneAdd(s, callId);
  }
}

lemma updateCall_ensures(s: CallService, callId: int, isConnected: bool)
  ensures (inv(s) ==> canUpdateCall(s, callId, isConnected) ==> alwaysCallbacksMatchRegistry(updateCall(s, callId, isConnected)))
  ensures (inv(s) ==> canUpdateCall(s, callId, isConnected) ==> alwaysNoticeHasCurrentCall(updateCall(s, callId, isConnected)))
  ensures (inv(s) ==> canUpdateCall(s, callId, isConnected) ==> alwaysDestroyedServiceHasNoCalls(updateCall(s, callId, isConnected)))
  ensures (inv(s) ==> canUpdateCall(s, callId, isConnected) ==> alwaysRegistryWithinIssued(updateCall(s, callId, isConnected)))
  ensures (inv(s) ==> canUpdateCall(s, callId, isConnected) ==> stepRemovedCallStaysRemoved(s, updateCall(s, callId, isConnected)))
{
  if inv(s) && canUpdateCall(s, callId, isConnected) {
    PhoneUpdate(s, callId, isConnected);
  }
}

lemma removeCall_ensures(s: CallService, callId: int)
  ensures (inv(s) ==> canRemoveCall(s, callId) ==> alwaysCallbacksMatchRegistry(removeCall(s, callId)))
  ensures (inv(s) ==> canRemoveCall(s, callId) ==> alwaysNoticeHasCurrentCall(removeCall(s, callId)))
  ensures (inv(s) ==> canRemoveCall(s, callId) ==> alwaysDestroyedServiceHasNoCalls(removeCall(s, callId)))
  ensures (inv(s) ==> canRemoveCall(s, callId) ==> alwaysRegistryWithinIssued(removeCall(s, callId)))
  ensures (inv(s) ==> canRemoveCall(s, callId) ==> stepRemovedCallStaysRemoved(s, removeCall(s, callId)))
{
  if inv(s) && canRemoveCall(s, callId) {
    PhoneRemove(s, callId);
  }
}

lemma drainCallback_ensures(s: CallService, callId: int)
  ensures (inv(s) ==> canDrainCallback(s, callId) ==> alwaysCallbacksMatchRegistry(drainCallback(s, callId)))
  ensures (inv(s) ==> canDrainCallback(s, callId) ==> alwaysNoticeHasCurrentCall(drainCallback(s, callId)))
  ensures (inv(s) ==> canDrainCallback(s, callId) ==> alwaysDestroyedServiceHasNoCalls(drainCallback(s, callId)))
  ensures (inv(s) ==> canDrainCallback(s, callId) ==> alwaysRegistryWithinIssued(drainCallback(s, callId)))
  ensures (inv(s) ==> canDrainCallback(s, callId) ==> stepRemovedCallStaysRemoved(s, drainCallback(s, callId)))
{
  if inv(s) && canDrainCallback(s, callId) {
    PhoneDrain(s, callId);
  }
}
