lemma sendResend_ensures(r: SignInResend)
  ensures (inv(r) ==> canSendResend(r) ==> alwaysRetirementRequiresReceipts(sendResend(r)))
  ensures (inv(r) ==> canSendResend(r) ==> alwaysOpenRequestsAreKnown(sendResend(r)))
  ensures (inv(r) ==> canSendResend(r) ==> alwaysScopedResendReceipt(sendResend(r)))
  ensures (inv(r) ==> canSendResend(r) ==> alwaysVerificationUsesDisplayedOwner(sendResend(r)))
  ensures (inv(r) ==> canSendResend(r) ==> alwaysNoLateAdmission(sendResend(r)))
{
  if inv(r) && canSendResend(r) {
    assert sendResend(r).known == r.known + ProofLib.Filter((set_x: int) => !((set_x in r.known)), [resendRequest]);
    forall x ensures x in ProofLib.Filter((set_x: int) => !((set_x in r.known)), [resendRequest]) <==> x == resendRequest && x !in r.known {
      ProofLib.FilterMember((set_x: int) => !((set_x in r.known)), [resendRequest], x);
    }
  }
}

lemma cancelReply_ensures(r: SignInResend, scope: int, acknowledged: bool)
  ensures (inv(r) ==> canCancelReply(r, scope, acknowledged) ==> alwaysRetirementRequiresReceipts(cancelReply(r, scope, acknowledged)))
  ensures (inv(r) ==> canCancelReply(r, scope, acknowledged) ==> alwaysOpenRequestsAreKnown(cancelReply(r, scope, acknowledged)))
  ensures (inv(r) ==> canCancelReply(r, scope, acknowledged) ==> alwaysScopedResendReceipt(cancelReply(r, scope, acknowledged)))
  ensures (inv(r) ==> canCancelReply(r, scope, acknowledged) ==> alwaysVerificationUsesDisplayedOwner(cancelReply(r, scope, acknowledged)))
  ensures (inv(r) ==> canCancelReply(r, scope, acknowledged) ==> alwaysNoLateAdmission(cancelReply(r, scope, acknowledged)))
{
  if inv(r) && canCancelReply(r, scope, acknowledged) {
    var after := cancelReply(r, scope, acknowledged);
    assert after.pending == ProofLib.Filter((set_x: int) => !((set_x in [scope])), r.pending);
    assert after.known == if acknowledged then ProofLib.Filter((set_x: int) => !((set_x in [scope])), r.known) else r.known;
    forall x ensures x in ProofLib.Filter((set_x: int) => !((set_x in [scope])), r.pending) <==> x in r.pending && x != scope {
      ProofLib.FilterMember((set_x: int) => !((set_x in [scope])), r.pending, x);
    }
    forall x ensures x in ProofLib.Filter((set_x: int) => !((set_x in [scope])), r.known) <==> x in r.known && x != scope {
      ProofLib.FilterMember((set_x: int) => !((set_x in [scope])), r.known, x);
    }
    var kept := ProofLib.Filter((set_x: int) => !((set_x in [scope])), r.known);
    var left := ProofLib.Filter((set_x: int) => !((set_x in [scope])), r.pending);
    forall x | x in left ensures x in kept && x in r.known {
      assert x in r.pending;
    }
    assert after.pending == left;
    if acknowledged {
      assert after.known == kept;
    } else {
      assert after.known == r.known;
    }
    if |after.known| == 0 {
      if |after.pending| > 0 { assert after.pending[0] in after.known; }
      assert |after.pending| == 0;
      assert scope in r.known;
      assert acknowledged;
      assert after.live == auth__native__android__signInCancel_scopeCancel(r.live, scope);
      if r.live == originalRequest || r.live == resendRequest {
        assert r.live in r.known;
        if r.live != scope {
          assert r.live in kept;
          assert false;
        }
      }
    }
    forall k | k in after.known ensures k in r.known {
      if acknowledged { assert k in kept; }
    }
  }
}

