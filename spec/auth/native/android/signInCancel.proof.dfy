lemma cleanupReply_ensures(c: SignInCancel, req: int, acknowledged: bool)
  ensures (inv(c) ==> canCleanupReply(c, req, acknowledged) ==> alwaysDispatchOwnsRequest(cleanupReply(c, req, acknowledged)))
  ensures (inv(c) ==> canCleanupReply(c, req, acknowledged) ==> alwaysCancellationKeepsItsFence(cleanupReply(c, req, acknowledged)))
  ensures (inv(c) ==> canCleanupReply(c, req, acknowledged) ==> alwaysNoCleanupRemembersNothing(cleanupReply(c, req, acknowledged)))
  ensures (inv(c) ==> canCleanupReply(c, req, acknowledged) ==> alwaysPendingCancelShowsNoNativeScreen(cleanupReply(c, req, acknowledged)))
  ensures (inv(c) ==> canCleanupReply(c, req, acknowledged) ==> alwaysScopedReceiptPreservesForeignAttempt(cleanupReply(c, req, acknowledged)))
{
  if inv(c) && canCleanupReply(c, req, acknowledged) {
    assert !(0 in c.detached);
    var after := cleanupReply(c, req, acknowledged);
    assert after.detached == c.detached && after.issued == c.issued;
  }
}

lemma dispose_ensures(c: SignInCancel)
  ensures (inv(c) ==> canDispose(c) ==> alwaysDispatchOwnsRequest(dispose(c)))
  ensures (inv(c) ==> canDispose(c) ==> alwaysCancellationKeepsItsFence(dispose(c)))
  ensures (inv(c) ==> canDispose(c) ==> alwaysNoCleanupRemembersNothing(dispose(c)))
  ensures (inv(c) ==> canDispose(c) ==> alwaysPendingCancelShowsNoNativeScreen(dispose(c)))
  ensures (inv(c) ==> canDispose(c) ==> alwaysScopedReceiptPreservesForeignAttempt(dispose(c)))
{
  if inv(c) && canDispose(c) {
    assert !(0 in c.detached);
    forall v | v in dispose(c).detached ensures v in c.detached || v == c.request {
      ProofLib.FilterMember((set_x: int) => !((set_x in c.detached)), [c.request], v);
    }
  }
}

lemma detachedReply_ensures(c: SignInCancel, req: int, acknowledged: bool)
  ensures (inv(c) ==> canDetachedReply(c, req, acknowledged) ==> alwaysDispatchOwnsRequest(detachedReply(c, req, acknowledged)))
  ensures (inv(c) ==> canDetachedReply(c, req, acknowledged) ==> alwaysCancellationKeepsItsFence(detachedReply(c, req, acknowledged)))
  ensures (inv(c) ==> canDetachedReply(c, req, acknowledged) ==> alwaysNoCleanupRemembersNothing(detachedReply(c, req, acknowledged)))
  ensures (inv(c) ==> canDetachedReply(c, req, acknowledged) ==> alwaysPendingCancelShowsNoNativeScreen(detachedReply(c, req, acknowledged)))
  ensures (inv(c) ==> canDetachedReply(c, req, acknowledged) ==> alwaysScopedReceiptPreservesForeignAttempt(detachedReply(c, req, acknowledged)))
{
  forall v | v in detachedReply(c, req, acknowledged).detached ensures v in c.detached {
    ProofLib.FilterMember((set_x: int) => !((set_x in [req])), c.detached, v);
  }
}
